import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { validatePortableDarwinRuntime } from './lib/demucs-runtime-portability.mjs'

const runtimeProfilesPath = path.resolve('./scripts/demucs-runtime-profiles.json')
const packageJsonPath = path.resolve('./package.json')

const runtimeProfiles = JSON.parse(fs.readFileSync(runtimeProfilesPath, 'utf8'))
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

const args = process.argv.slice(2)

const getArgValue = (flag, fallback = '') => {
  const directPrefix = `${flag}=`
  const direct = args.find((arg) => arg.startsWith(directPrefix))
  if (direct) return direct.slice(directPrefix.length).trim()
  const index = args.findIndex((arg) => arg === flag)
  if (index >= 0) {
    const next = args[index + 1]
    return typeof next === 'string' ? next.trim() : ''
  }
  return fallback
}

const parseCsv = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const platformDefault = (() => {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
})()

const configuredDemucsRoot = String(process.env.FRKB_DEMUCS_ROOT || '').trim()
const runtimeRootArg = getArgValue('--runtime-root', configuredDemucsRoot || 'vendor/demucs')
const runtimeRoot = path.resolve(runtimeRootArg)
const platformKey = getArgValue('--platform', platformDefault)
const outputRoot = path.resolve(getArgValue('--output-root', 'dist/demucs-runtime-assets'))
const releaseTag = getArgValue('--release-tag', 'demucs-runtime-assets')
const assetVersion = getArgValue('--asset-version', '')
const profilesArg = parseCsv(getArgValue('--profiles', ''))
const packagePrefix = getArgValue('--package-prefix', 'frkb-demucs-runtime')
const appVersion = String(getArgValue('--app-version', packageJson?.version || '')).trim()
const explicitChannel = String(getArgValue('--channel', '')).trim().toLowerCase()

const repoUrl = String(packageJson?.repository?.url || '')
const repoMatch = repoUrl.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/i)
const githubOwner = getArgValue('--github-owner', repoMatch?.[1] || 'coderDjing')
const githubRepo = getArgValue(
  '--github-repo',
  repoMatch?.[2] || 'Track-Studio'
)

const toBaseVersion = (value) =>
  String(value || '')
    .trim()
    .replace(/-.+$/, '')

const inferChannel = () => {
  if (explicitChannel === 'rc' || explicitChannel === 'stable') return explicitChannel
  if (/-/.test(appVersion) || /(^|[-_])(rc|beta|alpha)([-_.]|$)/i.test(releaseTag)) return 'rc'
  return 'stable'
}

const manifestChannel = inferChannel()
const appBaseVersion = toBaseVersion(appVersion)

const platformConfig = runtimeProfiles?.[platformKey]
if (!platformConfig || typeof platformConfig !== 'object') {
  console.error(`[demucs-runtime-package] Unsupported platform: ${platformKey}`)
  process.exit(1)
}

const profileNames =
  profilesArg.length > 0 ? profilesArg : Object.keys(platformConfig.profiles || {})
if (profileNames.length === 0) {
  console.error('[demucs-runtime-package] No profiles selected')
  process.exit(1)
}

const resolvedAssetVersion =
  assetVersion ||
  new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '')

const MAX_RELEASE_ASSET_SIZE = 2_000_000_000

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    windowsHide: true,
    ...options
  })
  if (result.status === 0) return
  throw new Error(`${command} ${commandArgs.join(' ')} -> exit ${result.status ?? -1}`)
}

const toShortText = (value, maxLen = 400) => {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.length <= maxLen ? text : text.slice(0, maxLen)
}

const buildRuntimeEnv = (runtimeDir) => {
  const env = {
    ...process.env
  }
  const pathEntries =
    process.platform === 'win32'
      ? [path.join(runtimeDir, 'Scripts'), path.join(runtimeDir, 'Library', 'bin')]
      : [path.join(runtimeDir, 'bin')]
  env.PATH = [...pathEntries, process.env.PATH || ''].filter(Boolean).join(path.delimiter)
  if (process.platform === 'linux') {
    env.LD_LIBRARY_PATH = [path.join(runtimeDir, 'lib'), process.env.LD_LIBRARY_PATH || '']
      .filter(Boolean)
      .join(path.delimiter)
  } else if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = [path.join(runtimeDir, 'lib'), process.env.DYLD_LIBRARY_PATH || '']
      .filter(Boolean)
      .join(path.delimiter)
  }
  return env
}

const normalizeResolvedPath = (value) => {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    return path.resolve(text)
  } catch {
    return ''
  }
}

const isPathInside = (rootDir, targetPath) => {
  const normalizedRoot = normalizeResolvedPath(rootDir)
  const normalizedTarget = normalizeResolvedPath(targetPath)
  if (!normalizedRoot || !normalizedTarget) return false
  const relativePath = path.relative(normalizedRoot, normalizedTarget)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

const inspectPythonRuntime = (pythonPath, runtimeDir) => {
  const result = spawnSync(
    pythonPath,
    [
      '-c',
      [
        'import json',
        'import os',
        'import sys',
        'payload = {',
        '  "executable": os.path.abspath(sys.executable),',
        '  "prefix": os.path.abspath(sys.prefix),',
        '  "base_prefix": os.path.abspath(getattr(sys, "base_prefix", sys.prefix))',
        '}',
        'print(json.dumps(payload))'
      ].join('\n')
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 12_000,
      env: {
        ...process.env,
        PATH:
          process.platform === 'win32'
            ? [
                path.join(runtimeDir, 'Scripts'),
                path.join(runtimeDir, 'Library', 'bin'),
                process.env.PATH || ''
              ]
                .filter(Boolean)
                .join(path.delimiter)
            : process.env.PATH || ''
      }
    }
  )
  if (result.status !== 0) {
    return {
      ok: false,
      payload: null,
      error: String(result.stderr || result.stdout || `inspect exit ${result.status ?? -1}`).trim()
    }
  }
  const output = String(result.stdout || '')
  const lastLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  if (!lastLine) {
    return {
      ok: false,
      payload: null,
      error: 'inspect output empty'
    }
  }
  try {
    return {
      ok: true,
      payload: JSON.parse(lastLine),
      error: ''
    }
  } catch (error) {
    return {
      ok: false,
      payload: null,
      error: error instanceof Error ? error.message : String(error || '')
    }
  }
}

const validatePortableWindowsRuntime = (runtimeDir) => {
  if (!platformKey.startsWith('win32')) {
    return {
      ok: true,
      error: ''
    }
  }
  try {
    const aliasNames = fs
      .readdirSync(runtimeDir)
      .filter((name) => /^python[\w.-]*\.exe$/i.test(String(name || '').trim()))
    for (const aliasName of aliasNames) {
      const aliasPath = path.join(runtimeDir, aliasName)
      const stat = fs.lstatSync(aliasPath)
      const lowerAliasName = aliasName.toLowerCase()
      if (lowerAliasName === 'python.exe' || lowerAliasName === 'pythonw.exe') {
        if (stat.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(aliasPath)
          return {
            ok: false,
            error: `canonical python symlink present: ${aliasName} -> ${linkTarget}`
          }
        }
        continue
      }
      const fallbackSourcePath = lowerAliasName.startsWith('pythonw')
        ? path.join(runtimeDir, 'pythonw.exe')
        : path.join(runtimeDir, 'python.exe')
      if (!fs.existsSync(fallbackSourcePath)) {
        const linkTarget = fs.readlinkSync(aliasPath)
        return {
          ok: false,
          error: `python alias symlink present: ${aliasName} -> ${linkTarget}`
        }
      }
      fs.rmSync(aliasPath, { force: true })
      fs.copyFileSync(fallbackSourcePath, aliasPath)
    }
  } catch (error) {
    return {
      ok: false,
      error: `inspect runtime aliases failed: ${
        error instanceof Error ? error.message : String(error || 'unknown')
      }`
    }
  }
  const rootPythonPath = path.join(runtimeDir, 'python.exe')
  if (!fs.existsSync(rootPythonPath)) {
    return {
      ok: false,
      error: `portable root python missing: ${rootPythonPath}`
    }
  }
  const pyvenvCfgPath = path.join(runtimeDir, 'pyvenv.cfg')
  if (fs.existsSync(pyvenvCfgPath)) {
    return {
      ok: false,
      error: `venv marker present: ${pyvenvCfgPath}`
    }
  }
  const identity = inspectPythonRuntime(rootPythonPath, runtimeDir)
  if (!identity.ok) {
    return {
      ok: false,
      error: identity.error || `inspect failed: ${rootPythonPath}`
    }
  }
  const relevantPaths = [
    identity.payload?.executable,
    identity.payload?.prefix,
    identity.payload?.base_prefix
  ]
    .map((entry) => normalizeResolvedPath(entry))
    .filter(Boolean)
  if (relevantPaths.length > 0 && relevantPaths.every((entry) => isPathInside(runtimeDir, entry))) {
    return {
      ok: true,
      error: ''
    }
  }
  return {
    ok: false,
    error: `non-portable runtime: ${relevantPaths.join(' | ')}`
  }
}

const computeFileSha256 = async (filePath) => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  return await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

const splitArchiveIfNeeded = async (archivePath) => {
  const archiveStat = fs.statSync(archivePath)
  if (archiveStat.size <= MAX_RELEASE_ASSET_SIZE) {
    return {
      archiveSize: archiveStat.size,
      archiveSha256: await computeFileSha256(archivePath),
      archiveParts: []
    }
  }

  const archiveDir = path.dirname(archivePath)
  const archiveBaseName = path.basename(archivePath)
  const fileHandle = await fs.promises.open(archivePath, 'r')
  const archiveParts = []
  let offset = 0
  let index = 0

  try {
    while (offset < archiveStat.size) {
      const chunkSize = Math.min(MAX_RELEASE_ASSET_SIZE, archiveStat.size - offset)
      const chunkBuffer = Buffer.allocUnsafe(chunkSize)
      await fileHandle.read(chunkBuffer, 0, chunkSize, offset)
      const partName = `${archiveBaseName}.part${String(index + 1).padStart(3, '0')}`
      const partPath = path.join(archiveDir, partName)
      fs.writeFileSync(partPath, chunkBuffer)
      archiveParts.push({
        index: index + 1,
        archiveName: partName,
        archiveSize: chunkSize,
        archiveSha256: await computeFileSha256(partPath)
      })
      offset += chunkSize
      index += 1
    }
  } finally {
    await fileHandle.close()
  }

  const archiveSha256 = await computeFileSha256(archivePath)
  fs.rmSync(archivePath, { force: true })
  return {
    archiveSize: archiveStat.size,
    archiveSha256,
    archiveParts
  }
}

const readRuntimeMeta = (runtimeDir) => {
  const metaPath = path.join(runtimeDir, '.frkb-runtime-meta.json')
  if (!fs.existsSync(metaPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  } catch {
    return {}
  }
}

const normalizeHashText = (value) => String(value || '').trim()

const normalizeHashList = (value) =>
  Array.isArray(value) ? value.map((item) => normalizeHashText(item)).filter(Boolean) : []

const createRuntimeContentHash = (params) => {
  const runtimeMeta =
    params?.runtimeMeta && typeof params.runtimeMeta === 'object' ? params.runtimeMeta : {}
  const probe = runtimeMeta?.probe && typeof runtimeMeta.probe === 'object' ? runtimeMeta.probe : {}
  const payload = {
    schemaVersion: 1,
    platform: normalizeHashText(params?.platform || runtimeMeta?.platform),
    profile: normalizeHashText(params?.profile),
    runtimeKey: normalizeHashText(params?.runtimeKey || runtimeMeta?.runtimeKey),
    pythonRelativePath: normalizeHashText(params?.pythonRelativePath),
    basePipInstallArgs: normalizeHashList(runtimeMeta?.basePipInstallArgs),
    pipInstallArgs: normalizeHashList(runtimeMeta?.pipInstallArgs),
    torchVersion: normalizeHashText(runtimeMeta?.torchVersion || probe?.torch_version),
    beatThisInstalled: !!(runtimeMeta?.beatThisInstalled ?? probe?.beat_this),
    beatThisVersion: normalizeHashText(runtimeMeta?.beatThisVersion || probe?.beat_this_version),
    beatThisCheckpointRelativePath: normalizeHashText(runtimeMeta?.beatThisCheckpointRelativePath),
    beatThisCheckpointSha256: normalizeHashText(runtimeMeta?.beatThisCheckpointSha256),
    soxrInstalled: !!(runtimeMeta?.soxrInstalled ?? probe?.soxr),
    rotaryEmbeddingTorchInstalled: !!(
      runtimeMeta?.rotaryEmbeddingTorchInstalled ?? probe?.rotary_embedding_torch
    ),
    xpuAvailable: !!(runtimeMeta?.xpuAvailable ?? probe?.xpu),
    xpuBackendInstalled: !!(runtimeMeta?.xpuBackendInstalled ?? probe?.xpu_backend_installed),
    xpuDemucsCompatible: !!(runtimeMeta?.xpuDemucsCompatible ?? probe?.xpu_demucs_compatible),
    directmlInstalled: !!(runtimeMeta?.directmlInstalled ?? probe?.directml_installed),
    directmlDemucsCompatible: !!(
      runtimeMeta?.directmlDemucsCompatible ?? probe?.directml_demucs_compatible
    ),
    onnxruntimeInstalled: !!probe?.onnxruntime_installed,
    onnxruntimeDirectmlInstalled: !!probe?.onnxruntime_directml_installed,
    cudaAvailable: !!probe?.cuda,
    mpsAvailable: !!probe?.mps
  }
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

const resolveRuntimePythonRelativePath = (runtimeDir) => {
  const candidates = platformKey.startsWith('win32')
    ? ['python.exe', 'Scripts/python.exe']
    : ['bin/python3', 'bin/python']
  let resolvedPythonRelativePath = ''
  for (const relativePath of candidates) {
    const absolutePath = path.join(runtimeDir, ...relativePath.split('/'))
    if (!fs.existsSync(absolutePath)) continue
    resolvedPythonRelativePath = relativePath
    break
  }
  if (!resolvedPythonRelativePath) {
    throw new Error(`[demucs-runtime-package] Python entry missing in runtime: ${runtimeDir}`)
  }
  const absolutePythonPath = path.join(runtimeDir, ...resolvedPythonRelativePath.split('/'))
  if (platformKey.startsWith('win32')) {
    const portableCheck = validatePortableWindowsRuntime(runtimeDir)
    if (!portableCheck.ok) {
      throw new Error(
        `[demucs-runtime-package] Windows runtime is not portable: ${portableCheck.error}`
      )
    }
  } else if (platformKey.startsWith('darwin')) {
    const portableCheck = validatePortableDarwinRuntime({
      runtimeDir,
      pythonPath: absolutePythonPath,
      env: buildRuntimeEnv(runtimeDir)
    })
    if (!portableCheck.ok) {
      throw new Error(
        `[demucs-runtime-package] Darwin runtime is not portable: ${
          portableCheck.error || toShortText(JSON.stringify(portableCheck.payload || {}))
        }`
      )
    }
  }
  return resolvedPythonRelativePath
}

const createArchive = (params) => {
  const archivePath = params.archivePath
  if (fs.existsSync(archivePath)) {
    fs.rmSync(archivePath, { force: true })
  }
  fs.mkdirSync(path.dirname(archivePath), { recursive: true })
  if (process.platform === 'win32') {
    run('tar.exe', ['-a', '-cf', archivePath, '-C', params.platformRoot, params.runtimeKey])
    return
  }
  if (process.platform === 'darwin') {
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', params.runtimeKey, archivePath], {
      cwd: params.platformRoot
    })
    return
  }
  run('zip', ['-qr', archivePath, params.runtimeKey], {
    cwd: params.platformRoot
  })
}

const assets = []
const platformRoot = path.join(runtimeRoot, platformKey)

for (const profileName of profileNames) {
  const profile = platformConfig.profiles?.[profileName]
  if (!profile) continue
  const runtimeKey = String(profile.targetDir || `runtime-${profileName}`)
  const runtimeDir = path.join(platformRoot, runtimeKey)
  if (!fs.existsSync(runtimeDir)) {
    console.warn(`[demucs-runtime-package] Skip missing runtime: ${runtimeDir}`)
    continue
  }
  const archiveName = `${packagePrefix}-${platformKey}-${profileName}-${resolvedAssetVersion}.zip`
  const archivePath = path.join(outputRoot, archiveName)
  createArchive({
    platformRoot,
    runtimeKey,
    archivePath
  })
  const archiveOutput = await splitArchiveIfNeeded(archivePath)
  const runtimeMeta = readRuntimeMeta(runtimeDir)
  const pythonRelativePath = resolveRuntimePythonRelativePath(runtimeDir)
  const contentHash = createRuntimeContentHash({
    platform: platformKey,
    profile: profileName,
    runtimeKey,
    pythonRelativePath,
    runtimeMeta
  })
  assets.push({
    platform: platformKey,
    profile: profileName,
    runtimeKey,
    version: resolvedAssetVersion,
    archiveName,
    archiveUrl:
      archiveOutput.archiveParts.length > 0
        ? ''
        : `https://github.com/${githubOwner}/${githubRepo}/releases/download/${releaseTag}/${archiveName}`,
    archiveSha256: archiveOutput.archiveSha256,
    archiveSize: archiveOutput.archiveSize,
    archiveParts: archiveOutput.archiveParts.map((item) => ({
      index: item.index,
      archiveName: item.archiveName,
      archiveUrl: `https://github.com/${githubOwner}/${githubRepo}/releases/download/${releaseTag}/${item.archiveName}`,
      archiveSha256: item.archiveSha256,
      archiveSize: item.archiveSize
    })),
    pythonRelativePath,
    generatedAt: new Date().toISOString(),
    torchVersion: String(runtimeMeta?.torchVersion || runtimeMeta?.probe?.torch_version || ''),
    beatThisVersion: String(
      runtimeMeta?.beatThisVersion || runtimeMeta?.probe?.beat_this_version || ''
    ),
    contentHash
  })
  console.log(
    `[demucs-runtime-package] Packed ${profileName} -> ${archiveName} (${Math.round(
      archiveOutput.archiveSize / 1024 / 1024
    )} MB${archiveOutput.archiveParts.length > 0 ? `, split=${archiveOutput.archiveParts.length}` : ''})`
  )
}

if (assets.length === 0) {
  console.error('[demucs-runtime-package] No runtime assets were packaged')
  process.exit(1)
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  releaseTag,
  channel: manifestChannel,
  appVersion,
  appBaseVersion,
  assets
}

fs.mkdirSync(outputRoot, { recursive: true })
fs.writeFileSync(
  path.join(outputRoot, 'demucs-runtime-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8'
)

console.log(
  '[demucs-runtime-package] Manifest written:',
  path.join(outputRoot, 'demucs-runtime-manifest.json')
)
