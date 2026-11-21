import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import {
  fetchWithRuntimeProxy,
  createConsoleDownloadProgressReporter
} from './lib/demucs-runtime-support.mjs'

const args = process.argv.slice(2)

const readFlagValue = (flag) => {
  const index = args.indexOf(flag)
  if (index < 0) return ''
  return String(args[index + 1] || '').trim()
}

const mode = readFlagValue('--mode') || 'dev'
const isReleaseBuild = mode === 'package' || args.includes('--release')

const repoRoot = process.cwd()
const rustPackageDir = path.resolve(repoRoot, 'rust_package')
const cargoManifestPath = path.join(rustPackageDir, 'Cargo.toml')
const dtsTemplatePath = path.join(rustPackageDir, 'index.d.ts.template')

const walkFiles = (dirPath) => {
  if (!fs.existsSync(dirPath)) return []

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      return walkFiles(entryPath)
    }
    return [entryPath]
  })
}

const getNewestMtimeMs = (filePaths) =>
  filePaths.reduce((latest, filePath) => {
    if (!fs.existsSync(filePath)) return latest
    const stats = fs.statSync(filePath)
    return Math.max(latest, stats.mtimeMs)
  }, 0)

const resolveBinaryConfig = () => {
  if (process.platform === 'win32') {
    if (process.arch === 'x64') {
      return {
        artifactFileName: 'rust_package.dll',
        suffix: 'win32-x64-msvc'
      }
    }
    if (process.arch === 'arm64') {
      return {
        artifactFileName: 'rust_package.dll',
        suffix: 'win32-arm64-msvc'
      }
    }
    if (process.arch === 'ia32') {
      return {
        artifactFileName: 'rust_package.dll',
        suffix: 'win32-ia32-msvc'
      }
    }
  }

  if (process.platform === 'darwin') {
    if (process.arch === 'x64') {
      return {
        artifactFileName: 'librust_package.dylib',
        suffix: 'darwin-x64'
      }
    }
    if (process.arch === 'arm64') {
      return {
        artifactFileName: 'librust_package.dylib',
        suffix: 'darwin-arm64'
      }
    }
  }

  return null
}

const WINDOWS_FFMPEG_SHARED_RELEASE_API =
  'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest'

const findDirectoryRecursive = (rootDir, targetName) => {
  const pending = [rootDir]
  while (pending.length > 0) {
    const currentDir = pending.pop()
    if (!currentDir || !fs.existsSync(currentDir)) continue
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === targetName.toLowerCase()) {
          return path.join(currentDir, entry.name)
        }
        pending.push(path.join(currentDir, entry.name))
      }
    }
  }
  return ''
}

const ensureWindowsFfmpegNativeDeps = async (repoRoot) => {
  const nativeFfmpegDir = path.join(repoRoot, 'rust_package/native/ffmpeg/win32-x64')
  const includeDir = path.join(nativeFfmpegDir, 'include')
  const libDir = path.join(nativeFfmpegDir, 'lib')

  const requiredHeaders = ['libavcodec', 'libavformat', 'libavutil', 'libswresample'].map(
    (name) => path.join(includeDir, name)
  )
  const requiredLibs = ['avcodec.lib', 'avformat.lib', 'avutil.lib', 'swresample.lib'].map(
    (name) => path.join(libDir, name)
  )
  const allRequired = [...requiredHeaders, ...requiredLibs]
  if (allRequired.every((filePath) => fs.existsSync(filePath))) return false

  console.log('[frkb-native] FFmpeg native headers/libs missing, downloading shared build...')

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'FRKB-RustPackageNative'
  }
  const token =
    String(process.env.GH_TOKEN || '').trim() || String(process.env.GITHUB_TOKEN || '').trim()
  if (token) {
    headers.Authorization = `Bearer ${token}`
    headers['X-GitHub-Api-Version'] = '2022-11-28'
  }

  const releaseResponse = await fetchWithRuntimeProxy(WINDOWS_FFMPEG_SHARED_RELEASE_API, {
    headers,
    redirect: 'follow'
  })
  if (!releaseResponse.ok) {
    throw new Error(`[frkb-native] FFmpeg release lookup failed: HTTP ${releaseResponse.status}`)
  }
  const release = await releaseResponse.json()
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const preferredAsset =
    assets.find((asset) => /^ffmpeg-N-.*-win64-gpl-shared.*\.zip$/i.test(String(asset?.name || ''))) ||
    assets.find((asset) => /^ffmpeg-.*-win64-gpl-shared.*\.zip$/i.test(String(asset?.name || '')))
  if (!preferredAsset?.browser_download_url || !preferredAsset?.name) {
    throw new Error('[frkb-native] win64-gpl-shared ffmpeg asset not found in latest BtbN release')
  }

  const cacheDir = path.join(repoRoot, 'vendor/.downloads/media-tools/ffmpeg')
  const archivePath = path.join(cacheDir, preferredAsset.name)
  const extractDir = path.join(cacheDir, `extract-shared-${Date.now()}`)

  fs.mkdirSync(cacheDir, { recursive: true })

  if (!fs.existsSync(archivePath)) {
    console.log(`[frkb-native] Downloading ${preferredAsset.name}...`)
    const response = await fetchWithRuntimeProxy(preferredAsset.browser_download_url, {
      redirect: 'follow',
      headers
    })
    if (!response.ok || !response.body) {
      throw new Error(`[frkb-native] FFmpeg download failed: HTTP ${response.status}`)
    }
    const totalBytes = Number(response.headers.get('content-length') || 0)
    const reportProgress = createConsoleDownloadProgressReporter({
      label: `FFmpeg shared ${preferredAsset.name}`,
      totalBytes
    })
    const tempPath = `${archivePath}.tmp-${process.pid}-${Date.now()}`
    const writer = fs.createWriteStream(tempPath)
    let downloadedBytes = 0
    try {
      for await (const chunk of Readable.fromWeb(response.body)) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        downloadedBytes += buffer.byteLength
        if (!writer.write(buffer)) {
          await once(writer, 'drain')
        }
        reportProgress({ downloadedBytes })
      }
      writer.end()
      await once(writer, 'finish')
      reportProgress({ downloadedBytes, done: true })
      fs.renameSync(tempPath, archivePath)
    } catch (error) {
      writer.destroy()
      fs.rmSync(tempPath, { force: true })
      throw error
    }
  } else {
    console.log('[frkb-native] Using cached FFmpeg shared archive')
  }

  console.log('[frkb-native] Extracting FFmpeg shared build...')
  fs.mkdirSync(extractDir, { recursive: true })
  const extractResult = spawnSync(
    'pwsh',
    ['-NoProfile', '-Command', `Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force`],
    { stdio: 'pipe', windowsHide: true }
  )
  if ((extractResult.status ?? 1) !== 0) {
    fs.rmSync(extractDir, { recursive: true, force: true })
    throw new Error(
      `[frkb-native] extraction failed (exit ${extractResult.status ?? -1}): ${String(extractResult.stderr || '').trim()}`
    )
  }

  const binDir = findDirectoryRecursive(extractDir, 'bin')
  if (!binDir) {
    fs.rmSync(extractDir, { recursive: true, force: true })
    throw new Error('[frkb-native] bin directory not found in extracted FFmpeg archive')
  }
  const sharedRoot = path.dirname(binDir)

  fs.mkdirSync(includeDir, { recursive: true })
  for (const dirName of ['libavcodec', 'libavformat', 'libavutil', 'libswresample']) {
    const src = path.join(sharedRoot, 'include', dirName)
    if (!fs.existsSync(src)) {
      fs.rmSync(extractDir, { recursive: true, force: true })
      throw new Error(`[frkb-native] missing include dir: ${dirName}`)
    }
    fs.cpSync(src, path.join(includeDir, dirName), { recursive: true, force: true })
    console.log(`[frkb-native]   copied include/${dirName}`)
  }

  fs.mkdirSync(libDir, { recursive: true })
  for (const libName of ['avcodec.lib', 'avformat.lib', 'avutil.lib', 'swresample.lib']) {
    const src = path.join(sharedRoot, 'lib', libName)
    if (!fs.existsSync(src)) {
      fs.rmSync(extractDir, { recursive: true, force: true })
      throw new Error(`[frkb-native] missing lib: ${libName}`)
    }
    fs.copyFileSync(src, path.join(libDir, libName))
    console.log(`[frkb-native]   copied lib/${libName}`)
  }

  const vendorDllDir = path.join(repoRoot, 'vendor/ffmpeg/win32-x64/dll')
  fs.mkdirSync(vendorDllDir, { recursive: true })
  const binEntries = fs.readdirSync(binDir, { withFileTypes: true })
  for (const entry of binEntries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) {
      fs.copyFileSync(path.join(binDir, entry.name), path.join(vendorDllDir, entry.name))
      console.log(`[frkb-native]   copied dll/${entry.name}`)
    }
  }

  fs.rmSync(extractDir, { recursive: true, force: true })
  console.log('[frkb-native] FFmpeg native deps ready')
  return true
}

// 打包运行时原生模块从 vendor/ffmpeg/win32-x64/dll（即 resources/ffmpeg/win32-x64/dll）
// 加载 FFmpeg DLL。全新检出时该目录可能为空，此时用 rust_package/native 下的预编译 DLL
// 填充，保证 asar 里排除 rust_package/*.dll 之后原生模块仍能找到权威运行时目录。
// 只在目录内没有任何 DLL 时填充，避免混入两代 FFmpeg。
const seedWindowsVendorFfmpegDlls = (repoRoot) => {
  if (process.platform !== 'win32') return
  const vendorDllDir = path.join(repoRoot, 'vendor/ffmpeg/win32-x64/dll')
  const seedDir = path.join(repoRoot, 'rust_package/native/ffmpeg/win32-x64/bin')
  const listDlls = (dir) => {
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.dll'))
      .map((entry) => entry.name)
  }
  if (listDlls(vendorDllDir).length > 0) return
  const seeds = listDlls(seedDir)
  if (seeds.length === 0) return
  fs.mkdirSync(vendorDllDir, { recursive: true })
  for (const name of seeds) {
    fs.copyFileSync(path.join(seedDir, name), path.join(vendorDllDir, name))
    console.log(`[frkb-native] seeded dll/${name}`)
  }
}

const syncWindowsFfmpegDlls = (repoRoot, binaryConfig) => {
  if (process.platform !== 'win32') return
  const vendorDllDir = path.join(repoRoot, 'vendor/ffmpeg/win32-x64/dll')
  if (!fs.existsSync(vendorDllDir)) return
  const rustPackageDir = path.join(repoRoot, 'rust_package')
  const entries = fs.readdirSync(vendorDllDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) {
      const dest = path.join(rustPackageDir, entry.name)
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(vendorDllDir, entry.name), dest)
      }
    }
  }
}

const binaryConfig = resolveBinaryConfig()
if (!binaryConfig) {
  console.warn(
    `[frkb-native] skip rust_package build on unsupported platform ${process.platform}-${process.arch}`
  )
  process.exit(0)
}

const profileDir = isReleaseBuild ? 'release' : 'debug'
const sourceInputs = [
  cargoManifestPath,
  dtsTemplatePath,
  path.join(rustPackageDir, 'build.rs'),
  ...walkFiles(path.join(rustPackageDir, 'src')),
  ...walkFiles(path.join(rustPackageDir, 'native'))
]
const newestSourceMtimeMs = getNewestMtimeMs(sourceInputs)
const targetBinaryPath = path.join(
  rustPackageDir,
  'target',
  profileDir,
  binaryConfig.artifactFileName
)
const builtBinaryPath = path.join(rustPackageDir, `rust_package.${binaryConfig.suffix}.node`)
const preferredBinaryPath = path.join(rustPackageDir, `index.${binaryConfig.suffix}.node`)
const binaryArtifactPaths = [targetBinaryPath, preferredBinaryPath, builtBinaryPath]

const hasFreshFile = (filePath) => {
  if (!fs.existsSync(filePath)) return false
  return fs.statSync(filePath).mtimeMs >= newestSourceMtimeMs
}

const resolveFreshBinarySource = () =>
  binaryArtifactPaths.find((filePath) => hasFreshFile(filePath)) || ''

const isSyncedWithSource = (filePath, sourcePath) => {
  if (!sourcePath || !fs.existsSync(filePath) || !fs.existsSync(sourcePath)) return false
  return fs.statSync(filePath).mtimeMs >= fs.statSync(sourcePath).mtimeMs
}

const syncBinaryOutputs = (sourcePath) => {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`未找到可复用的 Rust 编译产物: ${sourcePath || targetBinaryPath}`)
  }

  for (const outputPath of [builtBinaryPath, preferredBinaryPath]) {
    if (path.resolve(outputPath) === path.resolve(sourcePath)) continue
    if (isSyncedWithSource(outputPath, sourcePath)) continue
    fs.copyFileSync(sourcePath, outputPath)
  }
}

let binarySourcePath = resolveFreshBinarySource()
const needsBuild = !binarySourcePath

if (needsBuild) {
  if (process.platform === 'win32' && process.arch === 'x64') {
    await ensureWindowsFfmpegNativeDeps(repoRoot)
  }

  const cargoArgs = ['build', '--manifest-path', cargoManifestPath]
  if (isReleaseBuild) {
    cargoArgs.push('--release')
  }

  console.log(
    `[frkb-native] building rust_package (${process.platform}-${process.arch}, profile=${profileDir})`
  )

  const buildResult = spawnSync('cargo', cargoArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: false
  })

  if ((buildResult.status ?? 1) !== 0) {
    process.exit(buildResult.status ?? 1)
  }

  binarySourcePath = targetBinaryPath
}

if (
  !isSyncedWithSource(builtBinaryPath, binarySourcePath) ||
  !isSyncedWithSource(preferredBinaryPath, binarySourcePath)
) {
  syncBinaryOutputs(binarySourcePath)
  console.log(`[frkb-native] synced runtime binary from ${path.basename(binarySourcePath)}`)
}

seedWindowsVendorFfmpegDlls(repoRoot)
syncWindowsFfmpegDlls(repoRoot, binaryConfig)
