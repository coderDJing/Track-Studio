import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { ensureMacosFfmpeg, validateMacosMediaTool } from './macos-media-tools.mjs'
import {
  createConsoleDownloadProgressReporter,
  fetchWithRuntimeProxy
} from './demucs-runtime-support.mjs'

const WINDOWS_FFMPEG_RELEASE_API = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest'

const WINDOWS_REQUIREMENTS = {
  exactPaths: ['ffmpeg/win32-x64/ffmpeg.exe', 'ffmpeg/win32-x64/ffprobe.exe'],
  alternativeGroups: []
}

const MAC_DEV_REQUIREMENTS = {
  exactPaths: [],
  alternativeGroups: [
    {
      label: 'ffmpeg + ffprobe',
      candidateSets: [
        ['ffmpeg/darwin/ffmpeg', 'ffmpeg/darwin/ffprobe'],
        ['ffmpeg/darwin-universal/ffmpeg', 'ffmpeg/darwin-universal/ffprobe'],
        ['ffmpeg/darwin-arm64/ffmpeg', 'ffmpeg/darwin-arm64/ffprobe'],
        ['ffmpeg/darwin-x64/ffmpeg', 'ffmpeg/darwin-x64/ffprobe']
      ]
    }
  ]
}

const MAC_PACKAGE_REQUIREMENTS = {
  exactPaths: ['ffmpeg/darwin/ffmpeg', 'ffmpeg/darwin/ffprobe'],
  alternativeGroups: []
}

const getArgValue = (args, flag, fallback = '') => {
  const directPrefix = `${flag}=`
  const direct = args.find((arg) => String(arg || '').startsWith(directPrefix))
  if (direct) return direct.slice(directPrefix.length).trim()
  const index = args.findIndex((arg) => arg === flag)
  if (index >= 0) {
    const next = args[index + 1]
    return typeof next === 'string' ? next.trim() : ''
  }
  return fallback
}

export const resolveCurrentMediaToolsPlatformKey = () => {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return ''
}

export const normalizeMediaToolsPlatformKey = (value, mode) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (!normalized) return ''
  if (normalized === 'darwin' && mode === 'package') return 'darwin-universal'
  return normalized
}

export const parseMediaToolsCliOptions = (args) => {
  const mode = getArgValue(args, '--mode', 'dev').trim().toLowerCase()
  if (mode !== 'dev' && mode !== 'package') {
    throw new Error(`[media-tools] Unsupported mode: ${mode || '<empty>'}`)
  }
  const defaultPlatformKey =
    mode === 'package' && process.platform === 'darwin'
      ? 'darwin-universal'
      : resolveCurrentMediaToolsPlatformKey()
  const platformKey = normalizeMediaToolsPlatformKey(
    getArgValue(args, '--platform-key', defaultPlatformKey),
    mode
  )
  return {
    mode,
    platformKey,
    vendorRoot: path.resolve(getArgValue(args, '--root', 'vendor'))
  }
}

const resolveMediaToolsRequirements = ({ mode, platformKey }) => {
  const requirementMap = {
    'win32-x64': WINDOWS_REQUIREMENTS,
    'darwin-arm64': mode === 'package' ? MAC_PACKAGE_REQUIREMENTS : MAC_DEV_REQUIREMENTS,
    'darwin-x64': mode === 'package' ? MAC_PACKAGE_REQUIREMENTS : MAC_DEV_REQUIREMENTS,
    'darwin-universal': MAC_PACKAGE_REQUIREMENTS
  }
  const requirements = requirementMap[platformKey]
  if (!requirements) {
    throw new Error(`[media-tools] Unsupported platform key: ${platformKey}`)
  }
  return requirements
}

const resolveVendorPath = (vendorRoot, relativePath) =>
  path.join(
    vendorRoot,
    ...String(relativePath || '')
      .split('/')
      .filter(Boolean)
  )

const pathExists = (vendorRoot, relativePath) =>
  fs.existsSync(resolveVendorPath(vendorRoot, relativePath))

const describePathSet = (vendorRoot, relativePaths) =>
  relativePaths.map((relativePath) => resolveVendorPath(vendorRoot, relativePath)).join(', ')

export const validateBundledMediaTools = ({ mode, platformKey, vendorRoot }) => {
  if (!platformKey) {
    return {
      mode,
      platformKey,
      vendorRoot,
      failures: []
    }
  }
  const requirements = resolveMediaToolsRequirements({ mode, platformKey })
  const selectedPaths = [...requirements.exactPaths]
  const failures = [
    ...requirements.exactPaths
      .filter((relativePath) => !pathExists(vendorRoot, relativePath))
      .map((relativePath) => `missing: ${resolveVendorPath(vendorRoot, relativePath)}`),
    ...requirements.alternativeGroups.flatMap((group) => {
      const matchedSet = group.candidateSets.find((relativePaths) =>
        relativePaths.every((relativePath) => pathExists(vendorRoot, relativePath))
      )
      if (matchedSet) {
        selectedPaths.push(...matchedSet)
        return []
      }
      return [
        `${group.label} missing, expected one of: ${group.candidateSets
          .map((relativePaths) => `[${describePathSet(vendorRoot, relativePaths)}]`)
          .join(' | ')}`
      ]
    })
  ]
  if (platformKey.startsWith('darwin') && failures.length === 0) {
    if (process.platform !== 'darwin') {
      failures.push('macOS media tool validation requires macOS (lipo + otool)')
    } else {
      const architectures =
        mode === 'package' || platformKey === 'darwin-universal'
          ? ['arm64', 'x64']
          : [platformKey === 'darwin-arm64' ? 'arm64' : 'x64']
      for (const relativePath of selectedPaths) {
        failures.push(
          ...validateMacosMediaTool(resolveVendorPath(vendorRoot, relativePath), architectures)
        )
      }
    }
  }
  return {
    mode,
    platformKey,
    vendorRoot,
    failures
  }
}

export const logMediaToolsValidationResult = (result) => {
  if (!result.platformKey) {
    console.log('[media-tools] Skip unsupported platform')
    return true
  }
  if (result.failures.length > 0) {
    console.error(
      `[media-tools] Validation failed (${result.mode}) for ${result.platformKey} under ${result.vendorRoot}`
    )
    for (const failure of result.failures) {
      console.error(`[media-tools] ${failure}`)
    }
    return false
  }
  console.log(
    `[media-tools] Validation passed (${result.mode}) for ${result.platformKey} under ${result.vendorRoot}`
  )
  return true
}

const ensureDirectory = async (targetPath) => {
  await fs.promises.mkdir(targetPath, { recursive: true })
}

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    windowsHide: true,
    ...options
  })
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} -> exit ${result.status ?? -1}`)
  }
}

const downloadFileIfMissing = async ({ url, targetPath, label, headers = {} }) => {
  if (fs.existsSync(targetPath)) return false
  await ensureDirectory(path.dirname(targetPath))
  const response = await fetchWithRuntimeProxy(url, {
    redirect: 'follow',
    headers
  })
  if (!response.ok || !response.body) {
    throw new Error(`${label} download failed: HTTP ${response.status}`)
  }
  const totalBytes = Number(response.headers.get('content-length') || 0)
  const reportProgress = createConsoleDownloadProgressReporter({
    label,
    totalBytes
  })
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`
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
    await fs.promises.rename(tempPath, targetPath)
    return true
  } catch (error) {
    writer.destroy()
    await fs.promises.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

const extractZipArchive = async ({ archivePath, targetDir }) => {
  await fs.promises.rm(targetDir, { recursive: true, force: true }).catch(() => {})
  await ensureDirectory(targetDir)
  if (process.platform === 'win32') {
    run('tar', ['-xf', archivePath, '-C', targetDir])
    return
  }
  run('unzip', ['-q', archivePath, '-d', targetDir])
}

const findFileRecursive = (rootDir, targetName) => {
  const pending = [rootDir]
  while (pending.length > 0) {
    const currentDir = pending.pop()
    if (!currentDir || !fs.existsSync(currentDir)) continue
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        pending.push(fullPath)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase() === targetName.toLowerCase()) {
        return fullPath
      }
    }
  }
  return ''
}

const copyFileFromExtractedArchive = async ({ sourcePath, targetPath }) => {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`[media-tools] Extracted file missing: ${sourcePath || '<empty>'}`)
  }
  await ensureDirectory(path.dirname(targetPath))
  await fs.promises.copyFile(sourcePath, targetPath)
}

const createGitHubHeaders = () => {
  const token =
    String(process.env.GH_TOKEN || '').trim() || String(process.env.GITHUB_TOKEN || '').trim()
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'FRKB-MediaTools',
    ...(token
      ? {
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28'
        }
      : {})
  }
}

const fetchWindowsFfmpegAsset = async () => {
  const response = await fetchWithRuntimeProxy(WINDOWS_FFMPEG_RELEASE_API, {
    headers: createGitHubHeaders(),
    redirect: 'follow'
  })
  if (!response.ok) {
    throw new Error(`[media-tools] FFmpeg release lookup failed: HTTP ${response.status}`)
  }
  const release = await response.json()
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const preferredAsset =
    assets.find((asset) => /^ffmpeg-N-.*-win64-gpl\.zip$/i.test(String(asset?.name || ''))) ||
    assets.find((asset) => /^ffmpeg-.*-win64-gpl\.zip$/i.test(String(asset?.name || '')))
  if (!preferredAsset?.browser_download_url || !preferredAsset?.name) {
    throw new Error('[media-tools] win64 gpl ffmpeg asset not found in latest BtbN release')
  }
  return {
    name: String(preferredAsset.name),
    url: String(preferredAsset.browser_download_url)
  }
}

const ensureWindowsFfmpeg = async (vendorRoot) => {
  const targetDir = resolveVendorPath(vendorRoot, 'ffmpeg/win32-x64')
  const targetFfmpeg = path.join(targetDir, 'ffmpeg.exe')
  const targetFfprobe = path.join(targetDir, 'ffprobe.exe')
  if (fs.existsSync(targetFfmpeg) && fs.existsSync(targetFfprobe)) return false

  const asset = await fetchWindowsFfmpegAsset()
  const cacheDir = path.join(vendorRoot, '.downloads', 'media-tools', 'ffmpeg')
  const archivePath = path.join(cacheDir, asset.name)
  const extractDir = path.join(cacheDir, `extract-${Date.now()}`)
  await downloadFileIfMissing({
    url: asset.url,
    targetPath: archivePath,
    label: `ffmpeg ${asset.name}`,
    headers: createGitHubHeaders()
  })
  try {
    await extractZipArchive({
      archivePath,
      targetDir: extractDir
    })
    const sourceFfmpeg = findFileRecursive(extractDir, 'ffmpeg.exe')
    const sourceFfprobe = findFileRecursive(extractDir, 'ffprobe.exe')
    await copyFileFromExtractedArchive({
      sourcePath: sourceFfmpeg,
      targetPath: targetFfmpeg
    })
    await copyFileFromExtractedArchive({
      sourcePath: sourceFfprobe,
      targetPath: targetFfprobe
    })
  } finally {
    await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {})
  }
  return true
}

export const ensureBundledMediaTools = async ({ mode, platformKey, vendorRoot }) => {
  const initialResult = validateBundledMediaTools({
    mode,
    platformKey,
    vendorRoot
  })
  if (!platformKey || initialResult.failures.length === 0) {
    return {
      ...initialResult,
      changed: false
    }
  }

  let changed = false
  if (platformKey === 'win32-x64') {
    changed = (await ensureWindowsFfmpeg(vendorRoot)) || changed
  } else if (platformKey.startsWith('darwin')) {
    changed = await ensureMacosFfmpeg({
      mode,
      platformKey,
      vendorRoot,
      downloadFile: downloadFileIfMissing
    })
  }

  const finalResult = validateBundledMediaTools({
    mode,
    platformKey,
    vendorRoot
  })
  if (finalResult.failures.length > 0) {
    const error = new Error('[media-tools] 媒体工具自动准备后校验仍未通过')
    error.cause = finalResult.failures.join('\n')
    throw error
  }

  return {
    ...finalResult,
    changed
  }
}
