import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { app } from 'electron'
import {
  ProxyAgent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse
} from 'undici'
import { resolveBundledFfmpegPath } from '../ffmpeg'
import {
  resolveBundledDemucsPlatformRootCandidates,
  resolveBundledDemucsRuntimeCandidates,
  resolveDemucsPlatformDir,
  resolveInstalledDemucsRootPath,
  resolveInstalledDemucsPlatformRootPath
} from '../demucs'
import { getSystemProxy } from '../utils'
import { buildGithubReleaseDownloadUrl } from '../../shared/productBrand'
import {
  STEM_RUNTIME_INSTALL_VALIDATION_TIMEOUT_MS,
  buildStemProcessEnv,
  createStemError,
  normalizeText,
  runProbeProcess
} from './mixtapeStemSeparationShared'
import { probeWindowsGpuAdapters } from './mixtapeStemSeparationProbe'
import { getCachedStemDeviceProbeSnapshot, probeDemucsDevices } from './mixtapeStemSeparationProbe'
import { invalidateStemDeviceProbeCache } from './mixtapeStemSeparationProbe'
import { installRuntimeFromManifestEntry } from './mixtapeStemRuntimeDownloadInstall'
import { hasBpmFixRuntimeSupport } from './bpmFixRuntimeSupport'

const DEFAULT_DEMUCS_RUNTIME_RELEASE_TAG = 'demucs-runtime-assets'
const DEFAULT_DEMUCS_RUNTIME_RC_RELEASE_TAG = 'demucs-runtime-assets-rc'
const FAILED_RUNTIME_RETRY_COOLDOWN_MS = 5 * 60 * 1000

type RuntimeProfileName = 'cuda' | 'xpu' | 'directml' | 'cpu' | 'mps' | 'rocm'

export type RuntimeAssetEntry = {
  platform: string
  profile: RuntimeProfileName
  runtimeKey: string
  version: string
  archiveName: string
  archiveUrl: string
  archiveSha256: string
  archiveSize: number
  archiveParts?: Array<{
    index: number
    archiveName: string
    archiveUrl: string
    archiveSha256: string
    archiveSize: number
  }>
  pythonRelativePath: string
  generatedAt: string
  torchVersion?: string
  beatThisVersion?: string
  bpmFixReady?: boolean
  contentHash?: string
}

type RuntimeAssetManifest = {
  schemaVersion: number
  generatedAt: string
  releaseTag: string
  assets: RuntimeAssetEntry[]
}

type InstalledRuntimeVersionInfo = {
  profile?: string
  runtimeKey?: string
  version?: string
  archiveUrl?: string
  archiveSha256?: string
  contentHash?: string
  installedAt?: string
}

export type MixtapeStemRuntimeDownloadState = {
  status: 'idle' | 'available' | 'downloading' | 'extracting' | 'ready' | 'failed'
  profile: RuntimeProfileName | ''
  runtimeKey: string
  version: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  title: string
  message: string
  error: string
  updatedAt: number
}

export type MixtapeStemRuntimeDownloadInfo = {
  supported: boolean
  downloadable: boolean
  alreadyAvailable: boolean
  profile: RuntimeProfileName | ''
  runtimeKey: string
  version: string
  archiveSize: number
  title: string
  reason: string
  manifestUrl: string
  releaseTag: string
  error: string
  state: MixtapeStemRuntimeDownloadState
}

let runtimeManifestPromise: Promise<RuntimeAssetManifest | null> | null = null
const runtimeEnsurePromiseByProfile = new Map<string, Promise<boolean>>()
let runtimeDownloadProxyDispatcher: ProxyAgent | undefined
let runtimeDownloadProxyInitialized = false
let runtimeManifestLastError = ''
let runtimeDownloadState: MixtapeStemRuntimeDownloadState = {
  status: 'idle',
  profile: '',
  runtimeKey: '',
  version: '',
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  archiveSize: 0,
  title: '',
  message: '',
  error: '',
  updatedAt: Date.now()
}
export const stemRuntimeDownloadEvents = new EventEmitter()

const isPrereleaseVersion = (value: string) => /-/.test(String(value || '').trim())

const buildRuntimeManifestUrl = (releaseTag: string) =>
  buildGithubReleaseDownloadUrl(releaseTag, 'demucs-runtime-manifest.json')

const resolveDefaultRuntimeReleaseTag = () => {
  const configuredReleaseTag = normalizeText(process.env.FRKB_DEMUCS_RUNTIME_RELEASE_TAG, 200)
  if (configuredReleaseTag) return configuredReleaseTag
  try {
    const appVersion = normalizeText(app.getVersion(), 120)
    return isPrereleaseVersion(appVersion)
      ? DEFAULT_DEMUCS_RUNTIME_RC_RELEASE_TAG
      : DEFAULT_DEMUCS_RUNTIME_RELEASE_TAG
  } catch {
    return DEFAULT_DEMUCS_RUNTIME_RELEASE_TAG
  }
}

const resolveRuntimeManifestUrl = () =>
  normalizeText(process.env.FRKB_DEMUCS_RUNTIME_MANIFEST_URL, 2000) ||
  buildRuntimeManifestUrl(resolveDefaultRuntimeReleaseTag())

const resolveRuntimeProfileTitle = (profile: RuntimeProfileName | '') => {
  if (profile === 'cuda') return 'NVIDIA CUDA'
  if (profile === 'xpu') return 'Intel Arc XPU'
  if (profile === 'directml') return 'AMD / DirectML'
  if (profile === 'mps') return 'Apple Metal'
  if (profile === 'rocm') return 'AMD ROCm'
  return 'CPU'
}

const resolveRuntimeProfileByRuntimeKey = (runtimeKey: string): RuntimeProfileName | '' => {
  const normalizedKey = normalizeText(runtimeKey, 120).toLowerCase()
  if (normalizedKey.includes('cuda')) return 'cuda'
  if (normalizedKey.includes('xpu')) return 'xpu'
  if (normalizedKey.includes('directml')) return 'directml'
  if (normalizedKey.includes('mps')) return 'mps'
  if (normalizedKey.includes('rocm')) return 'rocm'
  if (normalizedKey.includes('cpu') || normalizedKey === 'runtime') return 'cpu'
  return ''
}

const resolveRuntimeDownloadCacheDir = () =>
  path.join(app.getPath('userData'), 'demucs-runtime-downloads')

const resolveRuntimeInstalledVersionPath = (runtimeDir: string) =>
  path.join(runtimeDir, '.frkb-runtime-download.json')

const resolveRuntimeMetaPath = (runtimeDir: string) =>
  path.join(runtimeDir, '.frkb-runtime-meta.json')
const DEFAULT_BEAT_THIS_CHECKPOINT_RELATIVE_PATH = 'beat-this-checkpoints/final0.ckpt'

const normalizeRuntimeContentHashText = (value: unknown) => String(value || '').trim()

const normalizeRuntimeContentHashList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((item) => normalizeRuntimeContentHashText(item)).filter(Boolean)
    : []

const createRuntimeContentHash = (params: {
  platform?: unknown
  profile?: unknown
  runtimeKey?: unknown
  pythonRelativePath?: unknown
  runtimeMeta?: Record<string, unknown> | null
}) => {
  const runtimeMeta =
    params.runtimeMeta && typeof params.runtimeMeta === 'object' ? params.runtimeMeta : {}
  const probe =
    runtimeMeta.probe && typeof runtimeMeta.probe === 'object'
      ? (runtimeMeta.probe as Record<string, unknown>)
      : {}
  const payload = {
    schemaVersion: 1,
    platform: normalizeRuntimeContentHashText(params.platform || runtimeMeta.platform),
    profile: normalizeRuntimeContentHashText(params.profile),
    runtimeKey: normalizeRuntimeContentHashText(params.runtimeKey || runtimeMeta.runtimeKey),
    pythonRelativePath: normalizeRuntimeContentHashText(params.pythonRelativePath),
    basePipInstallArgs: normalizeRuntimeContentHashList(runtimeMeta.basePipInstallArgs),
    pipInstallArgs: normalizeRuntimeContentHashList(runtimeMeta.pipInstallArgs),
    torchVersion: normalizeRuntimeContentHashText(runtimeMeta.torchVersion || probe.torch_version),
    beatThisInstalled: !!(runtimeMeta.beatThisInstalled ?? probe.beat_this),
    beatThisVersion: normalizeRuntimeContentHashText(
      runtimeMeta.beatThisVersion || probe.beat_this_version
    ),
    beatThisCheckpointRelativePath: normalizeRuntimeContentHashText(
      runtimeMeta.beatThisCheckpointRelativePath
    ),
    beatThisCheckpointSha256: normalizeRuntimeContentHashText(runtimeMeta.beatThisCheckpointSha256),
    soxrInstalled: !!(runtimeMeta.soxrInstalled ?? probe.soxr),
    rotaryEmbeddingTorchInstalled: !!(
      runtimeMeta.rotaryEmbeddingTorchInstalled ?? probe.rotary_embedding_torch
    ),
    xpuAvailable: !!(runtimeMeta.xpuAvailable ?? probe.xpu),
    xpuBackendInstalled: !!(runtimeMeta.xpuBackendInstalled ?? probe.xpu_backend_installed),
    xpuDemucsCompatible: !!(runtimeMeta.xpuDemucsCompatible ?? probe.xpu_demucs_compatible),
    directmlInstalled: !!(runtimeMeta.directmlInstalled ?? probe.directml_installed),
    directmlDemucsCompatible: !!(
      runtimeMeta.directmlDemucsCompatible ?? probe.directml_demucs_compatible
    ),
    onnxruntimeInstalled: !!probe.onnxruntime_installed,
    onnxruntimeDirectmlInstalled: !!probe.onnxruntime_directml_installed,
    cudaAvailable: !!probe.cuda,
    mpsAvailable: !!probe.mps
  }
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

const ensureRuntimeDownloadProxyInitialized = async () => {
  if (runtimeDownloadProxyInitialized) return
  runtimeDownloadProxyInitialized = true

  const proxyUrl = await getSystemProxy()
  if (proxyUrl) {
    runtimeDownloadProxyDispatcher = new ProxyAgent(proxyUrl)
  }
}

export const fetchDemucsAsset = async (
  url: string,
  init?: UndiciRequestInit
): Promise<UndiciResponse> => {
  await ensureRuntimeDownloadProxyInitialized()
  const requestInit: UndiciRequestInit = { ...init }
  if (runtimeDownloadProxyDispatcher) {
    requestInit.dispatcher = runtimeDownloadProxyDispatcher
  }
  return await undiciFetch(url, requestInit)
}

const fileExists = async (targetPath: string) => {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

export const computeDemucsAssetSha256 = async (filePath: string): Promise<string> => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  return await new Promise<string>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

const emitRuntimeDownloadState = () => {
  try {
    stemRuntimeDownloadEvents.emit('state', {
      ...runtimeDownloadState
    })
  } catch {}
}

const updateRuntimeDownloadState = (
  patch: Partial<MixtapeStemRuntimeDownloadState>
): MixtapeStemRuntimeDownloadState => {
  runtimeDownloadState = {
    ...runtimeDownloadState,
    ...patch,
    updatedAt: Date.now()
  }
  emitRuntimeDownloadState()
  return runtimeDownloadState
}

export const getStemRuntimeDownloadState = (): MixtapeStemRuntimeDownloadState => ({
  ...runtimeDownloadState
})

const resetStemRuntimeDownloadState = () => {
  runtimeEnsurePromiseByProfile.clear()
  runtimeManifestPromise = null
  runtimeManifestLastError = ''
  runtimeDownloadState = {
    status: 'idle',
    profile: '',
    runtimeKey: '',
    version: '',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    archiveSize: 0,
    title: '',
    message: '',
    error: '',
    updatedAt: Date.now()
  }
  invalidateStemDeviceProbeCache()
  emitRuntimeDownloadState()
}

export const clearInstalledStemRuntimes = async (): Promise<{
  removedInstalledRoot: boolean
  removedDownloadCache: boolean
  removedBundledRuntimeDirs: string[]
  failedBundledRuntimeDirs: string[]
}> => {
  const installedRoot = resolveInstalledDemucsRootPath()
  const downloadCacheDir = resolveRuntimeDownloadCacheDir()
  let removedInstalledRoot = false
  let removedDownloadCache = false
  const removedBundledRuntimeDirs: string[] = []
  const failedBundledRuntimeDirs: string[] = []
  await fs.promises.rm(installedRoot, { recursive: true, force: true }).catch(() => {})
  removedInstalledRoot = !(await fileExists(installedRoot))
  await fs.promises.rm(downloadCacheDir, { recursive: true, force: true }).catch(() => {})
  removedDownloadCache = !(await fileExists(downloadCacheDir))
  const bundledRuntimeDirSet = new Set<string>()
  for (const platformRoot of resolveBundledDemucsPlatformRootCandidates()) {
    const dirEntries = await fs.promises
      .readdir(platformRoot, { withFileTypes: true })
      .catch(() => [] as fs.Dirent[])
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue
      if (!/^runtime(?:$|-)/i.test(String(entry.name || '').trim())) continue
      bundledRuntimeDirSet.add(path.join(platformRoot, entry.name))
    }
  }
  for (const runtimeDir of bundledRuntimeDirSet) {
    await fs.promises.rm(runtimeDir, { recursive: true, force: true }).catch(() => {})
    if (await fileExists(runtimeDir)) {
      failedBundledRuntimeDirs.push(runtimeDir)
      continue
    }
    removedBundledRuntimeDirs.push(runtimeDir)
  }
  resetStemRuntimeDownloadState()
  return {
    removedInstalledRoot,
    removedDownloadCache,
    removedBundledRuntimeDirs,
    failedBundledRuntimeDirs
  }
}

const readRuntimeManifest = async (): Promise<RuntimeAssetManifest | null> => {
  if (runtimeManifestPromise) return await runtimeManifestPromise
  runtimeManifestPromise = (async () => {
    const manifestUrl = resolveRuntimeManifestUrl()
    try {
      const response = await fetchDemucsAsset(manifestUrl, {
        headers: {
          Accept: 'application/json'
        }
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const manifest = (await response.json()) as RuntimeAssetManifest
      if (!manifest || !Array.isArray(manifest.assets)) {
        throw new Error('manifest assets missing')
      }
      runtimeManifestLastError = ''
      return manifest
    } catch (error) {
      const errorText = normalizeText(
        error instanceof Error ? error.message : String(error || ''),
        400
      )
      runtimeManifestLastError = errorText
      return null
    }
  })().finally(() => {
    runtimeManifestPromise = null
  })
  return await runtimeManifestPromise
}

const resolvePreferredRuntimeProfiles = async (): Promise<RuntimeProfileName[]> => {
  if (process.platform === 'win32') {
    const adapters = await probeWindowsGpuAdapters()
    if (adapters.hasNvidia) return ['cuda', 'cpu']
    if (adapters.hasIntel) return ['xpu', 'cpu']
    if (adapters.hasAmd) return ['directml', 'cpu']
    return ['cpu']
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? ['mps', 'cpu'] : ['cpu']
  }
  return []
}

const resolveInstalledRuntimeDir = (runtimeKey: string) =>
  path.join(resolveInstalledDemucsPlatformRootPath(), runtimeKey)

const cleanupRuntimeDownloadArtifacts = async (params: {
  entry: RuntimeAssetEntry
  keepArchiveName?: string
}) => {
  const downloadCacheDir = resolveRuntimeDownloadCacheDir()
  if (!(await fileExists(downloadCacheDir))) return
  const archivePrefix = `frkb-demucs-runtime-${params.entry.platform}-${params.entry.profile}-`
  const keepArchiveName = normalizeText(params.keepArchiveName, 260)
  const dirEntries = await fs.promises
    .readdir(downloadCacheDir, { withFileTypes: true })
    .catch(() => [])
  await Promise.all(
    dirEntries.map(async (entry) => {
      const entryName = normalizeText(entry.name, 260)
      if (!entryName) return
      const absolutePath = path.join(downloadCacheDir, entry.name)
      if (entry.isDirectory()) {
        if (!entryName.startsWith(`extract-${params.entry.profile}-`)) return
        await fs.promises.rm(absolutePath, { recursive: true, force: true }).catch(() => {})
        return
      }
      if (!entryName.startsWith(archivePrefix)) return
      if (keepArchiveName && entryName === keepArchiveName) return
      if (
        keepArchiveName &&
        (entryName === `${keepArchiveName}.part-1` ||
          entryName.startsWith(`${keepArchiveName}.part-`))
      ) {
        return
      }
      await fs.promises.rm(absolutePath, { force: true }).catch(() => {})
    })
  )
}

const summarizeRuntimeInstallValidationFailure = (rawError: string) => {
  const errorText = normalizeText(rawError, 3000)
  if (!errorText) return ''
  if (
    process.platform === 'darwin' &&
    errorText.includes('Library not loaded:') &&
    errorText.includes('Python.framework')
  ) {
    const missingLibrary =
      errorText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith('Library not loaded:')) || ''
    return `macOS 运行时不是便携包，仍依赖系统 Python.framework。${missingLibrary || errorText}`
  }
  return errorText
}

const validateInstalledRuntime = async (entry: RuntimeAssetEntry, runtimeDir: string) => {
  const pythonPath = path.join(runtimeDir, entry.pythonRelativePath)
  if (!(await fileExists(pythonPath))) {
    throw createStemError(
      'STEM_RUNTIME_DOWNLOAD_INVALID',
      `运行时包缺少 Python: ${entry.pythonRelativePath}`
    )
  }
  const ffmpegPath = resolveBundledFfmpegPath()
  const env = buildStemProcessEnv(runtimeDir, ffmpegPath)
  const probeScript = [
    'import json',
    'payload = {',
    '  "torch": False,',
    '  "torchaudio": False,',
    '  "demucs": False,',
    '  "cuda": False,',
    '  "error": ""',
    '}',
    'try:',
    '  import torch',
    '  payload["torch"] = True',
    '  payload["cuda"] = bool(getattr(torch, "cuda", None) and torch.cuda.is_available())',
    '  import torchaudio',
    '  payload["torchaudio"] = True',
    '  import demucs',
    '  payload["demucs"] = True',
    '  from librosa.beat import beat_track',
    'except Exception as exc:',
    '  payload["error"] = str(exc)',
    'print(json.dumps(payload))'
  ].join('\n')
  const result = await runProbeProcess({
    command: pythonPath,
    args: ['-c', probeScript],
    env,
    timeoutMs: STEM_RUNTIME_INSTALL_VALIDATION_TIMEOUT_MS,
    maxStdoutLen: 4000,
    maxStderrLen: 4000
  })
  const stdoutText = normalizeText(result.stdout, 3000)
  const stderrText = normalizeText(result.stderr, 3000)
  const lastLine =
    stdoutText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) || ''
  if (result.timedOut) {
    throw createStemError(
      'STEM_RUNTIME_DOWNLOAD_INVALID',
      `运行时安装校验超时: ${entry.runtimeKey} (${STEM_RUNTIME_INSTALL_VALIDATION_TIMEOUT_MS}ms)`
    )
  }
  if (result.status !== 0 || !lastLine) {
    const validationError = summarizeRuntimeInstallValidationFailure(
      result.error || stderrText || stdoutText || `exit=${result.status ?? -1}`
    )
    throw createStemError(
      'STEM_RUNTIME_DOWNLOAD_INVALID',
      `运行时安装校验失败: ${validationError || `exit=${result.status ?? -1}`}`
    )
  }
  let payload: { torch?: boolean; torchaudio?: boolean; demucs?: boolean; error?: string } = {}
  try {
    payload = JSON.parse(lastLine)
  } catch (error) {
    throw createStemError(
      'STEM_RUNTIME_DOWNLOAD_INVALID',
      `运行时安装校验结果不可解析: ${error instanceof Error ? error.message : String(error || '')}`
    )
  }
  if (
    !payload.torch ||
    !payload.torchaudio ||
    !payload.demucs ||
    normalizeText(payload.error, 500)
  ) {
    throw createStemError(
      'STEM_RUNTIME_DOWNLOAD_INVALID',
      `运行时安装校验失败: ${normalizeText(payload.error, 500) || JSON.stringify(payload)}`
    )
  }
}

const readInstalledRuntimeVersionInfo = async (
  runtimeDir: string
): Promise<InstalledRuntimeVersionInfo | null> => {
  const versionPath = resolveRuntimeInstalledVersionPath(runtimeDir)
  if (!(await fileExists(versionPath))) return null
  try {
    const installedRaw = await fs.promises.readFile(versionPath, 'utf8')
    const installed = JSON.parse(installedRaw) as InstalledRuntimeVersionInfo
    return installed && typeof installed === 'object' ? installed : null
  } catch {
    return null
  }
}

const readRuntimeMetaFile = async (runtimeDir: string): Promise<Record<string, unknown> | null> => {
  const runtimeMetaPath = resolveRuntimeMetaPath(runtimeDir)
  if (!(await fileExists(runtimeMetaPath))) return null
  try {
    const raw = await fs.promises.readFile(runtimeMetaPath, 'utf8')
    return raw && typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const normalizeRuntimeRelativePath = (value: unknown) =>
  String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')

const resolveRuntimeBeatThisCheckpointCandidates = (
  runtimeDir: string,
  runtimeMeta: Record<string, unknown> | null
) => {
  const relativeCandidates = [
    normalizeRuntimeRelativePath(runtimeMeta?.beatThisCheckpointRelativePath),
    DEFAULT_BEAT_THIS_CHECKPOINT_RELATIVE_PATH
  ].filter(Boolean)
  return relativeCandidates.map((relativePath) => path.join(runtimeDir, ...relativePath.split('/')))
}

const resolveRuntimeSitePackagesDir = (runtimeDir: string) => {
  if (process.platform === 'win32') return path.join(runtimeDir, 'Lib', 'site-packages')

  const libDir = path.join(runtimeDir, 'lib')
  try {
    for (const entry of fs.readdirSync(libDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^python\d+(?:\.\d+)*$/i.test(entry.name)) continue
      const sitePackagesDir = path.join(libDir, entry.name, 'site-packages')
      if (fs.existsSync(sitePackagesDir)) return sitePackagesDir
    }
  } catch {}
  return ''
}

const hasBundledBeatThisSupport = async (runtimeDir: string) => {
  const runtimeMeta = await readRuntimeMetaFile(runtimeDir)
  const sitePackagesDir = resolveRuntimeSitePackagesDir(runtimeDir)
  const beatThisPackagePath = sitePackagesDir ? path.join(sitePackagesDir, 'beat_this') : ''
  if (!beatThisPackagePath || !(await fileExists(beatThisPackagePath))) return false
  if (runtimeMeta?.beatThisInstalled === false) return false
  const checkpointCandidates = resolveRuntimeBeatThisCheckpointCandidates(runtimeDir, runtimeMeta)
  for (const checkpointPath of checkpointCandidates) {
    if (await fileExists(checkpointPath)) return true
  }
  return false
}

const resolveInstalledRuntimeContentHash = async (
  runtimeDir: string,
  installed: InstalledRuntimeVersionInfo | null,
  entry: RuntimeAssetEntry
) => {
  const installedContentHash = normalizeText(installed?.contentHash, 120).toLowerCase()
  if (installedContentHash) return installedContentHash
  if (!normalizeText(entry.contentHash, 120)) return ''
  const runtimeMeta = await readRuntimeMetaFile(runtimeDir)
  if (!runtimeMeta) return ''
  try {
    return createRuntimeContentHash({
      platform: entry.platform,
      profile: entry.profile,
      runtimeKey: entry.runtimeKey,
      pythonRelativePath: entry.pythonRelativePath,
      runtimeMeta
    })
  } catch {
    return ''
  }
}

const isInstalledRuntimeLegacyCompatible = async (
  runtimeDir: string,
  installed: InstalledRuntimeVersionInfo | null,
  entry: RuntimeAssetEntry
) => {
  const runtimeMeta = await readRuntimeMetaFile(runtimeDir)
  if (!runtimeMeta) return false
  const probe =
    runtimeMeta.probe && typeof runtimeMeta.probe === 'object'
      ? (runtimeMeta.probe as Record<string, unknown>)
      : {}
  const runtimeKeyFromInstalled = normalizeText(installed?.runtimeKey, 120)
  const profileFromInstalled = normalizeText(installed?.profile, 120)
  const torchVersionFromMeta = normalizeText(runtimeMeta.torchVersion || probe.torch_version, 120)
  const expectedTorchVersion = normalizeText(entry.torchVersion, 120)
  if (runtimeKeyFromInstalled && runtimeKeyFromInstalled !== entry.runtimeKey) return false
  if (profileFromInstalled && profileFromInstalled !== entry.profile) return false
  if (
    expectedTorchVersion &&
    torchVersionFromMeta &&
    torchVersionFromMeta !== expectedTorchVersion
  ) {
    return false
  }
  if (entry.profile === 'directml') {
    const directmlInstalled = !!(runtimeMeta.directmlInstalled ?? probe.directml_installed)
    if (!directmlInstalled) return false
  }
  if (entry.profile === 'xpu') {
    const xpuBackendInstalled = !!(runtimeMeta.xpuBackendInstalled ?? probe.xpu_backend_installed)
    if (!xpuBackendInstalled) return false
  }
  return true
}

const doesInstalledRuntimeMatchEntry = async (
  runtimeDir: string,
  installed: InstalledRuntimeVersionInfo | null,
  entry: RuntimeAssetEntry
) => {
  if (!installed) return false
  const installedRuntimeKey = normalizeText(installed.runtimeKey, 120)
  const installedProfile = normalizeText(installed.profile, 120)
  const installedVersion = normalizeText(installed.version, 120)
  const installedArchiveSha256 = normalizeText(installed.archiveSha256, 120).toLowerCase()
  const expectedContentHash = normalizeText(entry.contentHash, 120).toLowerCase()
  if (installedRuntimeKey && installedRuntimeKey !== entry.runtimeKey) return false
  if (installedProfile && installedProfile !== entry.profile) return false
  if (expectedContentHash) {
    const installedContentHash = await resolveInstalledRuntimeContentHash(
      runtimeDir,
      installed,
      entry
    )
    return !!installedContentHash && installedContentHash === expectedContentHash
  }
  const legacyExactMatched =
    installedVersion === entry.version &&
    installedArchiveSha256 ===
      String(entry.archiveSha256 || '')
        .trim()
        .toLowerCase()
  if (legacyExactMatched) return true
  if (await isInstalledRuntimeLegacyCompatible(runtimeDir, installed, entry)) return true
  if (installedVersion !== entry.version) return false
  if (
    installedArchiveSha256 !==
    String(entry.archiveSha256 || '')
      .trim()
      .toLowerCase()
  )
    return false
  return true
}

const isRuntimeAlreadyAvailable = async (entry: RuntimeAssetEntry, requireBpmFix = false) => {
  const candidate = resolveBundledDemucsRuntimeCandidates().find(
    (item) => item.key === entry.runtimeKey
  )
  if (candidate?.pythonPath && fs.existsSync(candidate.pythonPath)) {
    if (!(await hasBundledBeatThisSupport(candidate.runtimeDir))) return false
    if (
      requireBpmFix &&
      !(await hasBpmFixRuntimeSupport(candidate.pythonPath, candidate.runtimeDir))
    )
      return false
    if (candidate.runtimeDir.startsWith(resolveInstalledDemucsPlatformRootPath())) {
      const installed = await readInstalledRuntimeVersionInfo(candidate.runtimeDir)
      if (await doesInstalledRuntimeMatchEntry(candidate.runtimeDir, installed, entry)) return true
    } else {
      return true
    }
  }
  return false
}

const resolveAnyLocalRuntimeAvailability = async (): Promise<{
  alreadyAvailable: boolean
  profile: RuntimeProfileName | ''
  runtimeKey: string
  title: string
}> => {
  const runtimeCandidatesRaw = resolveBundledDemucsRuntimeCandidates().filter(
    (candidate) => !!normalizeText(candidate.key, 120) && fs.existsSync(candidate.pythonPath)
  )
  const runtimeCandidates: typeof runtimeCandidatesRaw = []
  for (const candidate of runtimeCandidatesRaw) {
    if (await hasBundledBeatThisSupport(candidate.runtimeDir)) {
      runtimeCandidates.push(candidate)
    }
  }
  if (runtimeCandidates.length <= 0) {
    return {
      alreadyAvailable: false,
      profile: '',
      runtimeKey: '',
      title: ''
    }
  }

  const cachedProbe = getCachedStemDeviceProbeSnapshot()
  if (
    cachedProbe?.runtimeUsable &&
    normalizeText(cachedProbe.runtimeKey, 120) &&
    fs.existsSync(cachedProbe.pythonPath) &&
    (await hasBundledBeatThisSupport(cachedProbe.runtimeDir))
  ) {
    const profile = resolveRuntimeProfileByRuntimeKey(cachedProbe.runtimeKey)
    return {
      alreadyAvailable: true,
      profile,
      runtimeKey: cachedProbe.runtimeKey,
      title: resolveRuntimeProfileTitle(profile)
    }
  }

  try {
    const runtimeSnapshot = await probeDemucsDevices(resolveBundledFfmpegPath())
    if (
      runtimeSnapshot.runtimeUsable &&
      normalizeText(runtimeSnapshot.runtimeKey, 120) &&
      fs.existsSync(runtimeSnapshot.pythonPath) &&
      (await hasBundledBeatThisSupport(runtimeSnapshot.runtimeDir))
    ) {
      const profile = resolveRuntimeProfileByRuntimeKey(runtimeSnapshot.runtimeKey)
      return {
        alreadyAvailable: true,
        profile,
        runtimeKey: runtimeSnapshot.runtimeKey,
        title: resolveRuntimeProfileTitle(profile)
      }
    }
  } catch {}

  const fallbackCandidate = runtimeCandidates[0]
  const fallbackRuntimeKey = normalizeText(fallbackCandidate?.key, 120)
  const fallbackProfile = resolveRuntimeProfileByRuntimeKey(fallbackRuntimeKey)
  return {
    alreadyAvailable: true,
    profile: fallbackProfile,
    runtimeKey: fallbackRuntimeKey,
    title: resolveRuntimeProfileTitle(fallbackProfile)
  }
}

const ensureRuntimeProfileAvailable = async (
  profile: RuntimeProfileName,
  options?: {
    emitState?: boolean
    requireBpmFix?: boolean
  }
): Promise<boolean> => {
  const platform = resolveDemucsPlatformDir()
  const promiseKey = `${platform}:${profile}`
  const existing = runtimeEnsurePromiseByProfile.get(promiseKey)
  if (existing) return await existing

  const task = (async () => {
    const manifest = await readRuntimeManifest()
    if (!manifest) return false
    const entry =
      manifest.assets.find((item) => item.platform === platform && item.profile === profile) || null
    if (!entry) return false
    if (await isRuntimeAlreadyAvailable(entry, options?.requireBpmFix)) {
      if (options?.emitState) {
        updateRuntimeDownloadState({
          status: 'ready',
          profile: entry.profile,
          runtimeKey: entry.runtimeKey,
          version: entry.version,
          archiveSize: entry.archiveSize,
          totalBytes: entry.archiveSize,
          downloadedBytes: entry.archiveSize,
          percent: 100,
          title: resolveRuntimeProfileTitle(entry.profile),
          message: `${resolveRuntimeProfileTitle(entry.profile)} 加速组件已就绪`,
          error: ''
        })
      }
      return true
    }
    try {
      await installRuntimeFromManifestEntry(
        entry,
        {
          fetchRuntimeAsset: fetchDemucsAsset,
          computeFileSha256: computeDemucsAssetSha256,
          resolveRuntimeDownloadCacheDir,
          resolveRuntimeInstalledVersionPath,
          resolveRuntimeProfileTitle,
          resolveInstalledRuntimeDir,
          fileExists,
          validateInstalledRuntime,
          readRuntimeMetaFile,
          cleanupRuntimeDownloadArtifacts,
          createRuntimeContentHash
        },
        options?.emitState ? updateRuntimeDownloadState : undefined
      )
      return true
    } catch (error) {
      if (options?.emitState) {
        updateRuntimeDownloadState({
          status: 'failed',
          profile: entry.profile,
          runtimeKey: entry.runtimeKey,
          version: entry.version,
          archiveSize: entry.archiveSize,
          title: resolveRuntimeProfileTitle(entry.profile),
          message: `${resolveRuntimeProfileTitle(entry.profile)} 加速组件下载失败`,
          error: normalizeText(error instanceof Error ? error.message : String(error || ''), 500)
        })
      }
      return false
    }
  })().finally(() => {
    runtimeEnsurePromiseByProfile.delete(promiseKey)
  })
  runtimeEnsurePromiseByProfile.set(promiseKey, task)
  return await task
}

export const getPreferredStemRuntimeDownloadInfo = async (
  requireBpmFix = false
): Promise<MixtapeStemRuntimeDownloadInfo> => {
  const preferredProfiles = await resolvePreferredRuntimeProfiles()
  if (preferredProfiles.length === 0) {
    return {
      supported: false,
      downloadable: false,
      alreadyAvailable: false,
      profile: '',
      runtimeKey: '',
      version: '',
      archiveSize: 0,
      title: '',
      reason: 'platform unsupported',
      manifestUrl: resolveRuntimeManifestUrl(),
      releaseTag: '',
      error: '',
      state: getStemRuntimeDownloadState()
    }
  }
  const manifest = await readRuntimeManifest()
  if (!manifest) {
    const localRuntime = await resolveAnyLocalRuntimeAvailability()
    if (requireBpmFix && localRuntime.alreadyAvailable) {
      const candidate = resolveBundledDemucsRuntimeCandidates().find(
        (item) => item.key === localRuntime.runtimeKey
      )
      localRuntime.alreadyAvailable =
        !!candidate && (await hasBpmFixRuntimeSupport(candidate.pythonPath, candidate.runtimeDir))
    }
    const fallbackProfile = localRuntime.profile || preferredProfiles[0] || ''
    return {
      supported: true,
      downloadable: !localRuntime.alreadyAvailable,
      alreadyAvailable: localRuntime.alreadyAvailable,
      profile: fallbackProfile,
      runtimeKey: localRuntime.runtimeKey,
      version: '',
      archiveSize: 0,
      title: localRuntime.title || resolveRuntimeProfileTitle(fallbackProfile),
      reason: localRuntime.alreadyAvailable ? 'already available' : 'manifest unavailable',
      manifestUrl: resolveRuntimeManifestUrl(),
      releaseTag: '',
      error: runtimeManifestLastError,
      state: getStemRuntimeDownloadState()
    }
  }
  const platform = resolveDemucsPlatformDir()
  const entry =
    preferredProfiles
      .map(
        (profile) =>
          manifest.assets.find((item) => item.platform === platform && item.profile === profile) ||
          null
      )
      .find(Boolean) || null
  if (!entry) {
    return {
      supported: true,
      downloadable: false,
      alreadyAvailable: false,
      profile: preferredProfiles[0] || '',
      runtimeKey: '',
      version: '',
      archiveSize: 0,
      title: resolveRuntimeProfileTitle(preferredProfiles[0] || ''),
      reason: 'runtime asset missing',
      manifestUrl: resolveRuntimeManifestUrl(),
      releaseTag: manifest.releaseTag || '',
      error: '',
      state: getStemRuntimeDownloadState()
    }
  }
  const alreadyAvailable = await isRuntimeAlreadyAvailable(entry, requireBpmFix)
  return {
    supported: true,
    downloadable: !alreadyAvailable && (!requireBpmFix || entry.bpmFixReady === true),
    alreadyAvailable,
    profile: entry.profile,
    runtimeKey: entry.runtimeKey,
    version: entry.version,
    archiveSize: entry.archiveSize,
    title: resolveRuntimeProfileTitle(entry.profile),
    reason: alreadyAvailable
      ? 'already available'
      : requireBpmFix && !entry.bpmFixReady
        ? 'bpm fix asset unavailable'
        : '',
    manifestUrl: resolveRuntimeManifestUrl(),
    releaseTag: manifest.releaseTag || '',
    error: '',
    state: getStemRuntimeDownloadState()
  }
}

export const downloadPreferredStemRuntime = async (requireBpmFix = false): Promise<boolean> => {
  const info = await getPreferredStemRuntimeDownloadInfo(requireBpmFix)
  if (info.reason === 'manifest unavailable') {
    updateRuntimeDownloadState({
      status: 'failed',
      profile: info.profile,
      runtimeKey: info.runtimeKey,
      version: info.version,
      archiveSize: info.archiveSize,
      totalBytes: 0,
      downloadedBytes: 0,
      percent: 0,
      title: info.title || resolveRuntimeProfileTitle(info.profile),
      message: '无法获取 Stem 运行时下载清单',
      error: info.error || 'manifest unavailable'
    })
    return false
  }
  if (!info.supported || !info.profile || (!info.alreadyAvailable && !info.downloadable))
    return false
  if (info.alreadyAvailable) {
    updateRuntimeDownloadState({
      status: 'ready',
      profile: info.profile,
      runtimeKey: info.runtimeKey,
      version: info.version,
      archiveSize: info.archiveSize,
      totalBytes: info.archiveSize,
      downloadedBytes: info.archiveSize,
      percent: 100,
      title: info.title,
      message: `${info.title} 加速组件已就绪`,
      error: ''
    })
    return true
  }
  const failedState = getStemRuntimeDownloadState()
  if (
    failedState.status === 'failed' &&
    failedState.profile === info.profile &&
    failedState.runtimeKey === info.runtimeKey &&
    failedState.version === info.version &&
    Date.now() - failedState.updatedAt < FAILED_RUNTIME_RETRY_COOLDOWN_MS
  ) {
    return false
  }
  updateRuntimeDownloadState({
    status: 'available',
    profile: info.profile,
    runtimeKey: info.runtimeKey,
    version: info.version,
    archiveSize: info.archiveSize,
    totalBytes: info.archiveSize,
    downloadedBytes: 0,
    percent: 0,
    title: info.title,
    message: `${info.title} 加速组件可下载`,
    error: ''
  })
  return await ensureRuntimeProfileAvailable(info.profile, {
    emitState: true,
    requireBpmFix
  })
}
