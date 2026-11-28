import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { resolveInstalledDemucsModelPath, resolveInstalledDemucsModelsRootPath } from '../demucs'
import { computeDemucsAssetSha256, fetchDemucsAsset } from './mixtapeStemRuntimeDownload'
import {
  downloadVerifiedArchive,
  extractVerifiedArchive,
  type VerifiedArchiveEntry
} from './mixtapeStemRuntimeDownloadInstall'
import { normalizeText } from './mixtapeStemSeparationShared'
import { buildGithubReleaseDownloadUrl } from '../../shared/productBrand'
import { demucsUltraModelDownloadEvents } from './demucsUltraModelDownloadEvents'

const ULTRA_MODEL_NAME = 'htdemucs_ft'
const ULTRA_MODEL_PROFILE = 'ultra'
const DEFAULT_DEMUCS_MODEL_RELEASE_TAG = 'demucs-model-assets'
const MODEL_MANIFEST_FILE_NAME = 'demucs-model-manifest.json'
const MODEL_VERSION_FILE_NAME = '.frkb-model-download.json'

type ModelManifestFile = {
  path: string
  sha256: string
  size: number
}

type ModelAssetEntry = VerifiedArchiveEntry & {
  model: typeof ULTRA_MODEL_NAME
  profile: typeof ULTRA_MODEL_PROFILE
  version: string
  files: ModelManifestFile[]
}

type ModelAssetManifest = {
  schemaVersion: number
  generatedAt: string
  releaseTag: string
  assets: ModelAssetEntry[]
}

type InstalledModelVersionInfo = {
  model?: string
  profile?: string
  version?: string
  archiveUrl?: string
  archiveSha256?: string
  archiveSize?: number
  installedAt?: string
}

export type DemucsUltraModelDownloadState = {
  status: 'idle' | 'available' | 'downloading' | 'extracting' | 'ready' | 'failed'
  model: typeof ULTRA_MODEL_NAME
  profile: typeof ULTRA_MODEL_PROFILE
  version: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  message: string
  error: string
  updatedAt: number
}

export type DemucsUltraModelDownloadInfo = {
  model: typeof ULTRA_MODEL_NAME
  profile: typeof ULTRA_MODEL_PROFILE
  version: string
  archiveSize: number
  installedSize: number
  downloadable: boolean
  alreadyAvailable: boolean
  reason: string
  manifestUrl: string
  releaseTag: string
  error: string
  state: DemucsUltraModelDownloadState
}

let modelManifestPromise: Promise<ModelAssetManifest | null> | null = null
let modelManifestLastError = ''
let modelDownloadPromise: Promise<boolean> | null = null
let modelDownloadState: DemucsUltraModelDownloadState = {
  status: 'idle',
  model: ULTRA_MODEL_NAME,
  profile: ULTRA_MODEL_PROFILE,
  version: '',
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  archiveSize: 0,
  message: '',
  error: '',
  updatedAt: Date.now()
}

export { demucsUltraModelDownloadEvents }

const buildModelManifestUrl = (releaseTag: string) =>
  buildGithubReleaseDownloadUrl(releaseTag, MODEL_MANIFEST_FILE_NAME)

const resolveModelManifestUrl = () =>
  normalizeText(process.env.FRKB_DEMUCS_MODEL_MANIFEST_URL, 2000) ||
  buildModelManifestUrl(
    normalizeText(process.env.FRKB_DEMUCS_MODEL_RELEASE_TAG, 200) ||
      DEFAULT_DEMUCS_MODEL_RELEASE_TAG
  )

const resolveModelDownloadCacheDir = () =>
  app.isPackaged
    ? path.join(app.getPath('userData'), 'demucs-model-downloads')
    : path.join(resolveInstalledDemucsModelsRootPath(), '.downloads')

const resolveInstalledModelVersionPath = (modelPath: string) =>
  path.join(modelPath, MODEL_VERSION_FILE_NAME)

const fileExists = async (targetPath: string) => {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

const normalizeRelativePath = (value: unknown): string | null => {
  const normalized = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!normalized || normalized.includes('\u0000')) return null
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

const resolveSafeChildPath = (rootPath: string, relativePath: string): string | null => {
  const safeRelativePath = normalizeRelativePath(relativePath)
  if (!safeRelativePath) return null
  const resolvedRoot = path.resolve(rootPath)
  const candidate = path.resolve(resolvedRoot, ...safeRelativePath.split('/'))
  return candidate.startsWith(`${resolvedRoot}${path.sep}`) ? candidate : null
}

const normalizeSha256 = (value: unknown) => {
  const normalized = normalizeText(value, 128).toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : ''
}

const normalizeFileSize = (value: unknown) => {
  const parsed = Math.floor(Number(value))
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

const normalizeArchiveName = (value: unknown) => {
  const normalized = normalizeText(value, 260)
  if (
    !normalized ||
    path.basename(normalized) !== normalized ||
    !/^[a-zA-Z0-9._-]+\.zip$/i.test(normalized)
  ) {
    return ''
  }
  return normalized
}

const normalizeManifestEntry = (value: unknown): ModelAssetEntry | null => {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const model = normalizeText(source.model, 128)
  const profile = normalizeText(source.profile, 64)
  const archiveName = normalizeArchiveName(source.archiveName)
  const archiveUrl = normalizeText(source.archiveUrl, 2000)
  const archiveSha256 = normalizeSha256(source.archiveSha256)
  const archiveSize = normalizeFileSize(source.archiveSize)
  const version = normalizeText(source.version, 120)
  const files = Array.isArray(source.files)
    ? source.files
        .map((item): ModelManifestFile | null => {
          if (!item || typeof item !== 'object') return null
          const file = item as Record<string, unknown>
          const filePath = normalizeRelativePath(file.path)
          const sha256 = normalizeSha256(file.sha256)
          const size = normalizeFileSize(file.size)
          if (!filePath || !sha256 || !size) return null
          return { path: filePath, sha256, size }
        })
        .filter((item): item is ModelManifestFile => !!item)
    : []
  if (
    model !== ULTRA_MODEL_NAME ||
    profile !== ULTRA_MODEL_PROFILE ||
    !version ||
    !archiveName ||
    !archiveUrl ||
    !archiveSha256 ||
    !archiveSize ||
    files.length < 5 ||
    !files.some((file) => file.path === `${ULTRA_MODEL_NAME}.yaml`) ||
    files.some((file) => !resolveSafeChildPath(ULTRA_MODEL_NAME, file.path))
  ) {
    return null
  }
  return {
    model: ULTRA_MODEL_NAME,
    profile: ULTRA_MODEL_PROFILE,
    version,
    archiveName,
    archiveUrl,
    archiveSha256,
    archiveSize,
    files
  }
}

const emitModelDownloadState = () => {
  try {
    demucsUltraModelDownloadEvents.emit('state', { ...modelDownloadState })
  } catch {}
}

const updateModelDownloadState = (patch: Partial<DemucsUltraModelDownloadState>) => {
  modelDownloadState = {
    ...modelDownloadState,
    ...patch,
    updatedAt: Date.now()
  }
  emitModelDownloadState()
  return modelDownloadState
}

export const getDemucsUltraModelDownloadState = (): DemucsUltraModelDownloadState => ({
  ...modelDownloadState
})

const readModelManifest = async (): Promise<ModelAssetManifest | null> => {
  if (modelManifestPromise) return await modelManifestPromise
  modelManifestPromise = (async () => {
    try {
      const response = await fetchDemucsAsset(resolveModelManifestUrl(), {
        headers: { Accept: 'application/json' }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const rawManifest = (await response.json()) as Record<string, unknown>
      const assets = Array.isArray(rawManifest?.assets)
        ? rawManifest.assets
            .map(normalizeManifestEntry)
            .filter((item): item is ModelAssetEntry => !!item)
        : []
      if (!assets.length) throw new Error('manifest ultra model asset missing')
      modelManifestLastError = ''
      return {
        schemaVersion: Math.floor(Number(rawManifest.schemaVersion) || 0),
        generatedAt: normalizeText(rawManifest.generatedAt, 120),
        releaseTag: normalizeText(rawManifest.releaseTag, 200),
        assets
      }
    } catch (error) {
      modelManifestLastError = normalizeText(
        error instanceof Error ? error.message : String(error || ''),
        400
      )
      return null
    }
  })().finally(() => {
    modelManifestPromise = null
  })
  return await modelManifestPromise
}

const readInstalledModelVersionInfo = async (): Promise<InstalledModelVersionInfo | null> => {
  const modelPath = resolveInstalledDemucsModelPath(ULTRA_MODEL_NAME)
  const versionPath = resolveInstalledModelVersionPath(modelPath)
  try {
    const raw = await fs.promises.readFile(versionPath, 'utf8')
    const parsed = JSON.parse(raw) as InstalledModelVersionInfo
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const resolveInstalledModelSize = async (entry?: ModelAssetEntry | null) => {
  const modelPath = resolveInstalledDemucsModelPath(ULTRA_MODEL_NAME)
  const files = entry?.files || []
  let totalSize = 0
  for (const file of files) {
    const filePath = resolveSafeChildPath(modelPath, file.path)
    if (!filePath) return 0
    const stat = await fs.promises.stat(filePath).catch(() => null)
    if (!stat?.isFile() || stat.size !== file.size) return 0
    totalSize += stat.size
  }
  return totalSize
}

const isInstalledModelAvailable = async (entry?: ModelAssetEntry | null) => {
  const modelPath = resolveInstalledDemucsModelPath(ULTRA_MODEL_NAME)
  const yamlPath = path.join(modelPath, `${ULTRA_MODEL_NAME}.yaml`)
  if (!(await fileExists(yamlPath))) return false
  const installed = await readInstalledModelVersionInfo()
  if (
    installed?.model !== ULTRA_MODEL_NAME ||
    installed.profile !== ULTRA_MODEL_PROFILE ||
    !normalizeText(installed.version, 120)
  ) {
    return false
  }
  if (!entry) return true
  if (
    installed.version !== entry.version ||
    normalizeSha256(installed.archiveSha256) !== entry.archiveSha256
  ) {
    return false
  }
  return (await resolveInstalledModelSize(entry)) > 0
}

const validateExtractedModel = async (entry: ModelAssetEntry, extractedPath: string) => {
  for (const file of entry.files) {
    const filePath = resolveSafeChildPath(extractedPath, file.path)
    if (!filePath) throw new Error(`illegal model file path: ${file.path}`)
    const stat = await fs.promises.stat(filePath).catch(() => null)
    if (!stat?.isFile() || stat.size !== file.size) {
      throw new Error(`model file size mismatch: ${file.path}`)
    }
    const sha256 = await computeDemucsAssetSha256(filePath)
    if (sha256 !== file.sha256) {
      throw new Error(`model file hash mismatch: ${file.path}`)
    }
  }
}

const writeInstalledModelVersionInfo = async (entry: ModelAssetEntry, targetPath: string) => {
  const versionPath = resolveInstalledModelVersionPath(targetPath)
  await fs.promises.writeFile(
    versionPath,
    `${JSON.stringify(
      {
        model: entry.model,
        profile: entry.profile,
        version: entry.version,
        archiveUrl: entry.archiveUrl,
        archiveSha256: entry.archiveSha256,
        archiveSize: entry.archiveSize,
        installedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

const removeObsoleteModelDownloadArtifacts = async (keepArchiveName = '') => {
  const cacheRoot = resolveModelDownloadCacheDir()
  const entries = await fs.promises.readdir(cacheRoot, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(cacheRoot, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('extract-')) return
        await fs.promises.rm(entryPath, { recursive: true, force: true }).catch(() => {})
        return
      }
      if (entry.name === keepArchiveName || entry.name.startsWith(`${keepArchiveName}.`)) return
      if (!entry.name.startsWith('frkb-demucs-')) return
      await fs.promises.rm(entryPath, { force: true }).catch(() => {})
    })
  )
}

export const getDemucsUltraModelDownloadInfo = async (): Promise<DemucsUltraModelDownloadInfo> => {
  const manifest = await readModelManifest()
  const entry = manifest?.assets.find((asset) => asset.model === ULTRA_MODEL_NAME) || null
  const alreadyAvailable = await isInstalledModelAvailable(entry)
  const installedSize = entry ? await resolveInstalledModelSize(entry) : 0
  if (!entry) {
    return {
      model: ULTRA_MODEL_NAME,
      profile: ULTRA_MODEL_PROFILE,
      version: '',
      archiveSize: 0,
      installedSize,
      downloadable: false,
      alreadyAvailable,
      reason: alreadyAvailable ? 'already available' : 'manifest unavailable',
      manifestUrl: resolveModelManifestUrl(),
      releaseTag: '',
      error: modelManifestLastError,
      state: getDemucsUltraModelDownloadState()
    }
  }
  return {
    model: entry.model,
    profile: entry.profile,
    version: entry.version,
    archiveSize: entry.archiveSize,
    installedSize,
    downloadable: !alreadyAvailable,
    alreadyAvailable,
    reason: alreadyAvailable ? 'already available' : '',
    manifestUrl: resolveModelManifestUrl(),
    releaseTag: manifest?.releaseTag || '',
    error: '',
    state: getDemucsUltraModelDownloadState()
  }
}

export const downloadDemucsUltraModel = async (): Promise<boolean> => {
  if (modelDownloadPromise) return await modelDownloadPromise
  modelDownloadPromise = (async () => {
    const manifest = await readModelManifest()
    const entry = manifest?.assets.find((asset) => asset.model === ULTRA_MODEL_NAME) || null
    if (!entry) {
      updateModelDownloadState({
        status: 'failed',
        version: '',
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        archiveSize: 0,
        message: '无法获取超高质量模型下载清单',
        error: modelManifestLastError || 'manifest unavailable'
      })
      return false
    }
    if (await isInstalledModelAvailable(entry)) {
      updateModelDownloadState({
        status: 'ready',
        version: entry.version,
        percent: 100,
        downloadedBytes: entry.archiveSize,
        totalBytes: entry.archiveSize,
        archiveSize: entry.archiveSize,
        message: '超高质量模型已就绪',
        error: ''
      })
      return true
    }

    const cacheRoot = resolveModelDownloadCacheDir()
    const archivePath = path.join(cacheRoot, entry.archiveName)
    const temporaryRoot = path.join(cacheRoot, `extract-${Date.now()}`)
    const extractedModelPath = path.join(temporaryRoot, ULTRA_MODEL_NAME)
    const installedModelPath = resolveInstalledDemucsModelPath(ULTRA_MODEL_NAME)
    const backupPath = `${installedModelPath}.backup-${Date.now()}`
    try {
      updateModelDownloadState({
        status: 'downloading',
        version: entry.version,
        percent: 0,
        downloadedBytes: 0,
        totalBytes: entry.archiveSize,
        archiveSize: entry.archiveSize,
        message: '正在下载超高质量模型',
        error: ''
      })
      await downloadVerifiedArchive(
        {
          fetchRuntimeAsset: fetchDemucsAsset,
          computeFileSha256: computeDemucsAssetSha256
        },
        entry,
        archivePath,
        (progress) => {
          updateModelDownloadState({
            status: 'downloading',
            version: entry.version,
            percent: progress.percent,
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes || entry.archiveSize,
            archiveSize: entry.archiveSize,
            message: '正在下载超高质量模型',
            error: ''
          })
        }
      )
      updateModelDownloadState({
        status: 'extracting',
        version: entry.version,
        percent: 94,
        downloadedBytes: entry.archiveSize,
        totalBytes: entry.archiveSize,
        archiveSize: entry.archiveSize,
        message: '正在解压并校验超高质量模型',
        error: ''
      })
      await fs.promises.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {})
      await extractVerifiedArchive(archivePath, temporaryRoot)
      if (!(await fileExists(extractedModelPath))) {
        throw new Error(`model archive root missing: ${ULTRA_MODEL_NAME}`)
      }
      await validateExtractedModel(entry, extractedModelPath)
      await writeInstalledModelVersionInfo(entry, extractedModelPath)
      await fs.promises.mkdir(resolveInstalledDemucsModelsRootPath(), { recursive: true })
      updateModelDownloadState({
        status: 'extracting',
        percent: 98,
        message: '正在启用超高质量模型'
      })
      await fs.promises.rm(backupPath, { recursive: true, force: true }).catch(() => {})
      if (await fileExists(installedModelPath)) {
        await fs.promises.rename(installedModelPath, backupPath)
      }
      try {
        await fs.promises.rename(extractedModelPath, installedModelPath)
      } catch (error) {
        if (!(await fileExists(installedModelPath)) && (await fileExists(backupPath))) {
          await fs.promises.rename(backupPath, installedModelPath).catch(() => {})
        }
        throw error
      }
      await fs.promises.rm(backupPath, { recursive: true, force: true }).catch(() => {})
      await fs.promises.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {})
      await fs.promises.rm(archivePath, { force: true }).catch(() => {})
      await removeObsoleteModelDownloadArtifacts()
      updateModelDownloadState({
        status: 'ready',
        version: entry.version,
        percent: 100,
        downloadedBytes: entry.archiveSize,
        totalBytes: entry.archiveSize,
        archiveSize: entry.archiveSize,
        message: '超高质量模型已就绪',
        error: ''
      })
      return true
    } catch (error) {
      await fs.promises.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {})
      updateModelDownloadState({
        status: 'failed',
        version: entry.version,
        archiveSize: entry.archiveSize,
        message: '超高质量模型下载失败',
        error: normalizeText(error instanceof Error ? error.message : String(error || ''), 500)
      })
      return false
    }
  })().finally(() => {
    modelDownloadPromise = null
  })
  return await modelDownloadPromise
}

export const isDemucsUltraModelDownloadBusy = () => !!modelDownloadPromise

export const isDemucsUltraModelInstalled = async () => await isInstalledModelAvailable()

export const removeDemucsUltraModel = async () => {
  if (modelDownloadPromise) {
    return { removedModel: false, removedDownloadCache: false, busy: true }
  }
  const modelPath = resolveInstalledDemucsModelPath(ULTRA_MODEL_NAME)
  const cachePath = resolveModelDownloadCacheDir()
  await fs.promises.rm(modelPath, { recursive: true, force: true }).catch(() => {})
  await fs.promises.rm(cachePath, { recursive: true, force: true }).catch(() => {})
  const removedModel = !(await fileExists(modelPath))
  const removedDownloadCache = !(await fileExists(cachePath))
  modelManifestPromise = null
  modelManifestLastError = ''
  updateModelDownloadState({
    status: 'idle',
    version: '',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    archiveSize: 0,
    message: '',
    error: ''
  })
  return { removedModel, removedDownloadCache, busy: false }
}
