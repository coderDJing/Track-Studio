import { GITHUB_OWNER, GITHUB_REPO, buildGithubReleaseDownloadUrl } from './productBrand'

/**
 * Rekordbox Desktop runtime 是按需下载的独立组件：
 * - 安装位置固定在 userData/rekordbox-desktop-runtime/<platform>/python。
 * - 资源只来自项目自有 GitHub Release，且只支持 win32-x64 / darwin-arm64 / darwin-x64。
 * - manifest 是唯一的信任入口：archive 与哨兵文件都必须带 sha256。
 */
export const REKORDBOX_RUNTIME_PLATFORM_KEYS = ['win32-x64', 'darwin-arm64', 'darwin-x64'] as const

export type RekordboxRuntimePlatformKey = (typeof REKORDBOX_RUNTIME_PLATFORM_KEYS)[number]

export const REKORDBOX_RUNTIME_RELEASE_TAG = 'rekordbox-runtime-assets'
export const REKORDBOX_RUNTIME_MANIFEST_NAME = 'rekordbox-runtime-manifest.json'
export const REKORDBOX_RUNTIME_INSTALL_DIR_NAME = 'rekordbox-desktop-runtime'
export const REKORDBOX_RUNTIME_DOWNLOAD_DIR_NAME = 'rekordbox-runtime-downloads'
export const REKORDBOX_RUNTIME_MANIFEST_SCHEMA_VERSION = 1

export const DEFAULT_REKORDBOX_RUNTIME_MANIFEST_URL = buildGithubReleaseDownloadUrl(
  REKORDBOX_RUNTIME_RELEASE_TAG,
  REKORDBOX_RUNTIME_MANIFEST_NAME
)

export const REKORDBOX_RUNTIME_MANIFEST_REPOSITORY = `${GITHUB_OWNER}/${GITHUB_REPO}`

const MAX_RELATIVE_PATH_LENGTH = 300
const MAX_VERSION_LENGTH = 120
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const RELEASE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const DRIVE_LETTER_PATTERN = /^[A-Za-z]:/

export type RekordboxRuntimeAssetFile = {
  /** 相对平台目录（<platform>/）的安全路径。 */
  path: string
  sha256: string
  size: number
}

export type RekordboxRuntimeAsset = {
  platform: RekordboxRuntimePlatformKey
  version: string
  archiveName: string
  archiveUrl: string
  archiveSha256: string
  archiveSize: number
  /** 相对平台目录的 Python 入口，例如 python/python.exe。 */
  pythonRelativePath: string
  files: RekordboxRuntimeAssetFile[]
}

export type RekordboxRuntimeManifest = {
  schemaVersion: number
  generatedAt?: string
  releaseTag: string
  assets: RekordboxRuntimeAsset[]
}

export type RekordboxRuntimeManifestParseResult =
  { ok: true; manifest: RekordboxRuntimeManifest } | { ok: false; reason: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const readText = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maxLength ? trimmed : ''
}

export const isRekordboxRuntimePlatformKey = (
  value: unknown
): value is RekordboxRuntimePlatformKey =>
  value === 'win32-x64' || value === 'darwin-arm64' || value === 'darwin-x64'

export const resolveRekordboxRuntimePlatformKey = (
  platform: string,
  arch: string
): RekordboxRuntimePlatformKey | null => {
  if (platform === 'win32') return arch === 'x64' ? 'win32-x64' : null
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'darwin-arm64'
    if (arch === 'x64') return 'darwin-x64'
  }
  return null
}

/**
 * 归档内路径只允许规范化的相对 POSIX 路径：
 * 拒绝绝对路径、盘符、反斜杠、`.`/`..` 段、空段和控制字符。
 */
export const normalizeRekordboxRuntimeRelativePath = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_RELATIVE_PATH_LENGTH) return null
  if (trimmed.includes('\\') || trimmed.includes('\0')) return null
  if (trimmed.startsWith('/') || DRIVE_LETTER_PATTERN.test(trimmed)) return null
  const segments = trimmed.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null
    if (/[\u0000-\u001f]/.test(segment)) return null
  }
  return segments.join('/')
}

export const isSafeRekordboxRuntimeFileName = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed || trimmed !== value || trimmed.length > MAX_RELATIVE_PATH_LENGTH) return false
  if (trimmed.includes('/') || trimmed.includes('\\')) return false
  if (trimmed === '.' || trimmed === '..') return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/.test(trimmed)
}

export const isAllowedRekordboxRuntimeArchiveUrl = (params: {
  archiveUrl: unknown
  archiveName: string
  releaseTag: string
}): boolean => {
  if (typeof params.archiveUrl !== 'string' || !params.archiveUrl.trim()) return false
  if (!RELEASE_TAG_PATTERN.test(params.releaseTag)) return false
  let parsed: URL
  try {
    parsed = new URL(params.archiveUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.hostname !== 'github.com') return false
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false
  const expectedPath = `/${REKORDBOX_RUNTIME_MANIFEST_REPOSITORY}/releases/download/${params.releaseTag}/${params.archiveName}`
  return parsed.pathname === expectedPath
}

const parseAssetFile = (value: unknown): RekordboxRuntimeAssetFile | null => {
  if (!isRecord(value)) return null
  const path = normalizeRekordboxRuntimeRelativePath(value.path)
  const sha256 = readText(value.sha256, 64).toLowerCase()
  if (!path || !SHA256_PATTERN.test(sha256) || !isPositiveInteger(value.size)) return null
  return { path, sha256, size: value.size }
}

const parseAsset = (value: unknown, releaseTag: string): RekordboxRuntimeAsset | null => {
  if (!isRecord(value)) return null
  const platform = value.platform
  if (!isRekordboxRuntimePlatformKey(platform)) return null
  const version = readText(value.version, MAX_VERSION_LENGTH)
  if (!version) return null
  const archiveName = readText(value.archiveName, MAX_RELATIVE_PATH_LENGTH)
  if (!isSafeRekordboxRuntimeFileName(archiveName)) return null
  const archiveUrl = readText(value.archiveUrl, 2000)
  if (
    !isAllowedRekordboxRuntimeArchiveUrl({
      archiveUrl,
      archiveName,
      releaseTag
    })
  ) {
    return null
  }
  const archiveSha256 = readText(value.archiveSha256, 64).toLowerCase()
  if (!SHA256_PATTERN.test(archiveSha256) || !isPositiveInteger(value.archiveSize)) return null
  const pythonRelativePath = normalizeRekordboxRuntimeRelativePath(value.pythonRelativePath)
  if (!pythonRelativePath) return null
  if (!Array.isArray(value.files) || value.files.length === 0) return null
  const files: RekordboxRuntimeAssetFile[] = []
  const seenPaths = new Set<string>()
  for (const rawFile of value.files) {
    const file = parseAssetFile(rawFile)
    if (!file) return null
    if (seenPaths.has(file.path)) return null
    seenPaths.add(file.path)
    files.push(file)
  }
  if (!seenPaths.has(pythonRelativePath)) return null
  return {
    platform,
    version,
    archiveName,
    archiveUrl,
    archiveSha256,
    archiveSize: value.archiveSize,
    pythonRelativePath,
    files
  }
}

export const parseRekordboxRuntimeManifest = (
  value: unknown
): RekordboxRuntimeManifestParseResult => {
  if (!isRecord(value)) return { ok: false, reason: 'manifest-not-object' }
  if (value.schemaVersion !== REKORDBOX_RUNTIME_MANIFEST_SCHEMA_VERSION) {
    return { ok: false, reason: 'manifest-schema-version' }
  }
  const releaseTag = readText(value.releaseTag, 100)
  if (!RELEASE_TAG_PATTERN.test(releaseTag)) return { ok: false, reason: 'manifest-release-tag' }
  if (!Array.isArray(value.assets) || value.assets.length === 0) {
    return { ok: false, reason: 'manifest-assets-missing' }
  }
  const assets: RekordboxRuntimeAsset[] = []
  const seenPlatforms = new Set<RekordboxRuntimePlatformKey>()
  for (const rawAsset of value.assets) {
    const asset = parseAsset(rawAsset, releaseTag)
    if (!asset) return { ok: false, reason: 'manifest-asset-invalid' }
    if (seenPlatforms.has(asset.platform)) return { ok: false, reason: 'manifest-asset-duplicate' }
    seenPlatforms.add(asset.platform)
    assets.push(asset)
  }
  const generatedAt = readText(value.generatedAt, 80)
  return {
    ok: true,
    manifest: {
      schemaVersion: REKORDBOX_RUNTIME_MANIFEST_SCHEMA_VERSION,
      releaseTag,
      ...(generatedAt ? { generatedAt } : {}),
      assets
    }
  }
}

export const selectRekordboxRuntimeAsset = (
  manifest: RekordboxRuntimeManifest,
  platformKey: RekordboxRuntimePlatformKey
): RekordboxRuntimeAsset | null =>
  manifest.assets.find((asset) => asset.platform === platformKey) ?? null
