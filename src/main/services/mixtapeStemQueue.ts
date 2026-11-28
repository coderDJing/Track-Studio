import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveBundledFfmpegPath } from '../ffmpeg'
import { log } from '../log'
import mixtapeWindow from '../window/mixtapeWindow'
import type { MixtapeStemMode } from '../mixtapeDb'
import { listMixtapeItems } from '../mixtapeDb'
import { resolveBundledDemucsRuntimeCandidates } from '../demucs'
import {
  DEFAULT_MIXTAPE_STEM_PROFILE,
  normalizeMixtapeStemProfile,
  parseMixtapeStemModel,
  resolveMixtapeStemModelByProfile,
  type MixtapeStemProfile
} from '../../shared/mixtapeStemProfiles'
import { normalizeMixtapeStemMode } from '../../shared/mixtapeStemMode'
import { prewarmMixtapeStemWaveformBundle } from './mixtapeStemWaveformService'
import {
  getMixtapeStemAsset,
  listMixtapeTrackStemStatusByPlaylist,
  summarizeMixtapeStemStatusByPlaylist,
  type MixtapeStemStatus,
  upsertMixtapeItemStemStateById,
  upsertMixtapeStemAsset
} from '../mixtapeStemDb'
import { findSongListRoot } from './cacheMaintenance'
import { computeLibraryStemSourceSignature, getLibraryRootAbs } from './libraryStemAssetStorage'
import {
  configureLibraryStemSeparationService,
  createLibraryStemSnapshot,
  notifyLibraryStemStatus
} from './libraryStemSeparationService'
import { isStemCancelledError } from './mixtapeStemSeparationShared'
import { getStemBackgroundConcurrencyHint } from './backgroundIdleGate'
import { isLibraryMergeMutationLocked } from './libraryMerge/mutationGate'
import { getCachedStemDeviceProbeSnapshot, probeDemucsDevices } from './mixtapeStemSeparationProbe'
import type {
  MixtapeStemComputeDevice,
  MixtapeStemCpuFallbackReasonCode,
  MixtapeStemSeparationResult
} from './mixtapeStemSeparationShared'
import {
  STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_2,
  STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_3,
  STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_2,
  STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_3
} from './mixtapeStemSeparationShared'

const DEFAULT_STEM_MODEL = resolveMixtapeStemModelByProfile(DEFAULT_MIXTAPE_STEM_PROFILE)
const DEFAULT_STEM_VERSION = 'demucs-waveform-builtin-20260313-stem-v2'
type MixtapeStemQueueTarget = {
  playlistId: string
  itemIds: string[]
}

type MixtapeStemQueueJob = {
  key: string
  sourceSignature: string
  filePath: string
  stemMode: MixtapeStemMode
  model: string
  stemVersion: string
  source: MixtapeStemEnqueueSource
  libraryRoot: string
  targets: Map<string, Set<string>>
}

type MixtapeStemEnqueueSource = 'foreground' | 'background'

type StemAnalysisState = Record<string, unknown>

type ErrorWithCode = Error & {
  code?: string
}

type MixtapeStemEnqueueParams = {
  playlistId: string
  filePaths: string[]
  stemMode: MixtapeStemMode
  force?: boolean
  profile?: MixtapeStemProfile
  model?: string
  stemVersion?: string
  source?: MixtapeStemEnqueueSource
}

type MixtapeStemRetryParams = {
  playlistId: string
  stemMode: MixtapeStemMode
  itemIds?: string[]
  filePaths?: string[]
  profile?: MixtapeStemProfile
  model?: string
  stemVersion?: string
}

type MixtapeStemEnqueueResult = {
  total: number
  queued: number
  merged: number
  readyFromCache: number
  skipped: number
}

const pendingQueue: MixtapeStemQueueJob[] = []
const pendingJobMap = new Map<string, MixtapeStemQueueJob>()
const inFlightJobMap = new Map<string, MixtapeStemQueueJob>()
const inFlightAbortByKey = new Map<string, AbortController>()
const inFlightDoneByKey = new Map<string, Promise<void>>()
const cancelledJobKeySet = new Set<string>()
let activeWorkers = 0
let stemQueueProbeWarmupPromise: Promise<void> | null = null
const cpuSlowHintNotifiedPlaylistIdSet = new Set<string>()

const normalizeText = (value: unknown, maxLen = 2000): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen)
}

const normalizeNumberOrNull = (value: unknown): number | null => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

const normalizeFilePath = (value: unknown): string => normalizeText(value, 4000)

const normalizePlaylistId = (value: unknown): string => normalizeText(value, 80)

const normalizeStemProfile = (
  value: unknown,
  fallback: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): MixtapeStemProfile => normalizeMixtapeStemProfile(normalizeText(value, 24), fallback)

const normalizeModel = (
  value: unknown,
  fallbackProfile: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): string => {
  const parsed = parseMixtapeStemModel(normalizeText(value, 128), fallbackProfile)
  return normalizeText(parsed.requestedModel, 128) || DEFAULT_STEM_MODEL
}

const normalizeStemVersion = (value: unknown, _model?: string): string => {
  const normalized = normalizeText(value, 128)
  if (!normalized) return DEFAULT_STEM_VERSION
  return normalized
}

const normalizeEnqueueSource = (value: unknown): MixtapeStemEnqueueSource =>
  value === 'background' ? 'background' : 'foreground'

const isStemAnalysisState = (value: unknown): value is StemAnalysisState =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const getErrorCode = (error: unknown): string => {
  if (!error || typeof error !== 'object') return ''
  return normalizeText(Reflect.get(error, 'code'), 80)
}

const createStemQueueError = (message: string, code: string): ErrorWithCode => {
  const error = new Error(message) as ErrorWithCode
  error.code = code
  return error
}

const hasExistingStemAnalysisState = (info: StemAnalysisState | null): boolean => {
  if (!info || typeof info !== 'object') return false
  const stemStatus = normalizeText(info?.stemStatus, 32)
  if (stemStatus === 'ready') return true
  if (normalizeText(info?.stemModel, 128)) return true
  if (normalizeText(info?.stemVocalPath, 4000)) return true
  if (normalizeText(info?.stemInstPath, 4000)) return true
  if (normalizeText(info?.stemBassPath, 4000)) return true
  if (normalizeText(info?.stemDrumsPath, 4000)) return true
  const stemReadyAt = Number(info?.stemReadyAt)
  return Number.isFinite(stemReadyAt) && stemReadyAt > 0
}

const shouldBypassReadyCacheForLegacyStemVersion = (params: {
  playlistId: string
  itemIds: string[]
  stemVersion: string
}): boolean => {
  if (params.stemVersion !== DEFAULT_STEM_VERSION) return false
  const targetItemIdSet = new Set(
    (params.itemIds || []).map((itemId) => normalizeText(itemId, 80)).filter(Boolean)
  )
  if (!targetItemIdSet.size) return false
  try {
    const items = listMixtapeItems(params.playlistId)
    for (const item of items) {
      const itemId = normalizeText(item.id, 80)
      if (!itemId || !targetItemIdSet.has(itemId)) continue
      const infoJsonRaw = normalizeText(item.infoJson, 200_000)
      if (!infoJsonRaw) {
        continue
      }
      try {
        const info = JSON.parse(infoJsonRaw)
        if (!isStemAnalysisState(info) || !hasExistingStemAnalysisState(info)) {
          continue
        }
        const currentStemVersion = normalizeText(info?.stemVersion, 128)
        if (!currentStemVersion) {
          return true
        }
        if (currentStemVersion !== params.stemVersion) {
          return true
        }
      } catch {}
    }
  } catch {}
  return false
}

const normalizePathKey = (value: string): string => {
  const normalized = normalizeFilePath(value)
  if (!normalized) return ''
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const buildJobKey = (params: {
  libraryRoot: string
  sourceSignature: string
  stemMode: MixtapeStemMode
  model: string
}) => {
  const rootKey = normalizePathKey(params.libraryRoot)
  const sourceKey = normalizeText(params.sourceSignature, 160).toLowerCase()
  return `${rootKey}::${sourceKey}::${params.stemMode}::${params.model}`
}

const notifyStemStatusUpdated = (params: {
  playlistId: string
  itemIds: string[]
  stemStatus: MixtapeStemStatus
  filePath?: string
  errorCode?: string | null
  errorMessage?: string | null
  stemReadyAt?: number | null
  stemVocalPath?: string | null
  stemInstPath?: string | null
  stemBassPath?: string | null
  stemDrumsPath?: string | null
}) => {
  const playlistId = normalizePlaylistId(params.playlistId)
  if (!playlistId) return
  try {
    mixtapeWindow.broadcast?.('mixtape-stem-status-updated', {
      playlistId,
      itemIds: params.itemIds,
      stemStatus: params.stemStatus,
      filePath: normalizeFilePath(params.filePath),
      errorCode: normalizeText(params.errorCode, 80) || null,
      errorMessage: normalizeText(params.errorMessage, 1200) || null,
      stemReadyAt:
        typeof params.stemReadyAt === 'number' && Number.isFinite(params.stemReadyAt)
          ? params.stemReadyAt
          : null,
      stemVocalPath: normalizeFilePath(params.stemVocalPath),
      stemInstPath: normalizeFilePath(params.stemInstPath),
      stemBassPath: normalizeFilePath(params.stemBassPath),
      stemDrumsPath: normalizeFilePath(params.stemDrumsPath),
      stemSummary: summarizeMixtapeStemStatusByPlaylist(playlistId)
    })
  } catch {}
}

const notifyStemCpuSlowHint = (params: {
  playlistId: string
  filePath?: string
  model?: string
  reasonCode?: MixtapeStemCpuFallbackReasonCode
  reasonDetail?: string
}) => {
  const playlistId = normalizePlaylistId(params.playlistId)
  if (!playlistId) return
  if (cpuSlowHintNotifiedPlaylistIdSet.has(playlistId)) return
  cpuSlowHintNotifiedPlaylistIdSet.add(playlistId)
  try {
    mixtapeWindow.broadcast?.('mixtape-stem-cpu-slow-hint', {
      playlistId,
      filePath: normalizeFilePath(params.filePath),
      model: normalizeText(params.model, 128) || null,
      reasonCode:
        params.reasonCode === 'gpu_unavailable' ||
        params.reasonCode === 'gpu_failed' ||
        params.reasonCode === 'gpu_backend_missing'
          ? params.reasonCode
          : null,
      reasonDetail: normalizeText(params.reasonDetail, 600) || null
    })
  } catch {}
}

const notifyStemRuntimeProgress = (params: {
  playlistId: string
  itemIds: string[]
  filePath?: string
  model?: string
  device: MixtapeStemComputeDevice
  stage: 'separating' | 'rendering' | 'validating' | 'saving' | 'cleaning'
  percent: number
  activityConfirmedAt?: number | null
  stageCompleted: number | null
  stageTotal: number | null
  processedSec: number | null
  totalSec: number | null
  etaSec: number | null
}) => {
  const playlistId = normalizePlaylistId(params.playlistId)
  if (!playlistId) return
  const itemIds = Array.from(
    new Set((params.itemIds || []).map((itemId) => normalizeText(itemId, 80)).filter(Boolean))
  )
  if (!itemIds.length) return
  const percent = Math.max(0, Math.min(100, Math.round(Number(params.percent) || 0)))
  try {
    mixtapeWindow.broadcast?.('mixtape-stem-runtime-progress', {
      playlistId,
      itemIds,
      filePath: normalizeFilePath(params.filePath),
      model: normalizeText(params.model, 128) || null,
      device: params.device,
      stage: params.stage,
      percent,
      activityConfirmedAt: normalizeNumberOrNull(params.activityConfirmedAt),
      stageCompleted: normalizeNumberOrNull(params.stageCompleted),
      stageTotal: normalizeNumberOrNull(params.stageTotal),
      processedSec: normalizeNumberOrNull(params.processedSec),
      totalSec: normalizeNumberOrNull(params.totalSec),
      etaSec: normalizeNumberOrNull(params.etaSec),
      updatedAt: Date.now()
    })
  } catch {}
}

const collectTargetsForFilePaths = (playlistId: string, filePaths: string[]) => {
  const normalizedPlaylistId = normalizePlaylistId(playlistId)
  if (!normalizedPlaylistId) return new Map<string, { filePath: string; itemIds: string[] }>()
  const requestedPathMap = new Map<string, string>()
  for (const item of filePaths) {
    const normalizedPath = normalizeFilePath(item)
    const pathKey = normalizePathKey(normalizedPath)
    if (!normalizedPath || !pathKey || requestedPathMap.has(pathKey)) continue
    requestedPathMap.set(pathKey, normalizedPath)
  }
  if (!requestedPathMap.size) return new Map<string, { filePath: string; itemIds: string[] }>()
  const matched = new Map<string, { filePath: string; itemIds: string[] }>()
  const items = listMixtapeItems(normalizedPlaylistId)
  for (const item of items) {
    const itemId = normalizeText(item?.id, 80)
    const filePath = normalizeFilePath(item?.filePath)
    const pathKey = normalizePathKey(filePath)
    if (!itemId || !filePath || !pathKey || !requestedPathMap.has(pathKey)) continue
    const existing = matched.get(pathKey)
    if (existing) {
      existing.itemIds.push(itemId)
      continue
    }
    matched.set(pathKey, {
      filePath,
      itemIds: [itemId]
    })
  }
  return matched
}

const upsertItemStemStatus = (
  targets: MixtapeStemQueueTarget[],
  status: MixtapeStemStatus,
  extra?: {
    stemError?: string | null
    stemReadyAt?: number | null
    stemModel?: string | null
    stemVersion?: string | null
    stemVocalPath?: string | null
    stemInstPath?: string | null
    stemBassPath?: string | null
    stemDrumsPath?: string | null
    filePath?: string
    errorCode?: string | null
  }
) => {
  for (const target of targets) {
    const itemIds = Array.from(
      new Set(target.itemIds.map((itemId) => normalizeText(itemId, 80)).filter(Boolean))
    )
    if (!itemIds.length) continue
    upsertMixtapeItemStemStateById(
      itemIds.map((itemId) => ({
        itemId,
        stemStatus: status,
        stemError: Object.prototype.hasOwnProperty.call(extra || {}, 'stemError')
          ? extra?.stemError || null
          : undefined,
        stemReadyAt: Object.prototype.hasOwnProperty.call(extra || {}, 'stemReadyAt')
          ? (extra?.stemReadyAt ?? null)
          : undefined,
        stemModel: Object.prototype.hasOwnProperty.call(extra || {}, 'stemModel')
          ? extra?.stemModel || null
          : undefined,
        stemVersion: Object.prototype.hasOwnProperty.call(extra || {}, 'stemVersion')
          ? extra?.stemVersion || null
          : undefined,
        stemVocalPath: Object.prototype.hasOwnProperty.call(extra || {}, 'stemVocalPath')
          ? extra?.stemVocalPath || null
          : undefined,
        stemInstPath: Object.prototype.hasOwnProperty.call(extra || {}, 'stemInstPath')
          ? extra?.stemInstPath || null
          : undefined,
        stemBassPath: Object.prototype.hasOwnProperty.call(extra || {}, 'stemBassPath')
          ? extra?.stemBassPath || null
          : undefined,
        stemDrumsPath: Object.prototype.hasOwnProperty.call(extra || {}, 'stemDrumsPath')
          ? extra?.stemDrumsPath || null
          : undefined
      }))
    )
    notifyStemStatusUpdated({
      playlistId: target.playlistId,
      itemIds,
      stemStatus: status,
      filePath: extra?.filePath,
      errorCode: extra?.errorCode || null,
      errorMessage: extra?.stemError || null,
      stemReadyAt: extra?.stemReadyAt ?? null,
      stemVocalPath: extra?.stemVocalPath ?? null,
      stemInstPath: extra?.stemInstPath ?? null,
      stemBassPath: extra?.stemBassPath ?? null,
      stemDrumsPath: extra?.stemDrumsPath ?? null
    })
  }
}

const buildQueueTargets = (job: MixtapeStemQueueJob): MixtapeStemQueueTarget[] => {
  const targets: MixtapeStemQueueTarget[] = []
  for (const [playlistId, itemIds] of job.targets.entries()) {
    targets.push({
      playlistId,
      itemIds: Array.from(itemIds)
    })
  }
  return targets
}

const resolveAssetRequiredPaths = (
  _stemMode: MixtapeStemMode,
  result: MixtapeStemSeparationResult
): string[] => {
  return [result.vocalPath, result.instPath, result.bassPath, result.drumsPath]
    .map((item) => normalizeFilePath(item))
    .filter(Boolean)
}

const hasReadyStemAssets = (
  stemMode: MixtapeStemMode,
  asset: ReturnType<typeof getMixtapeStemAsset> | null
): boolean => {
  if (!asset) return false
  if (asset.status !== 'ready') return false
  const requiredPaths = resolveAssetRequiredPaths(stemMode, {
    vocalPath: asset.vocalPath,
    instPath: asset.instPath,
    bassPath: asset.bassPath,
    drumsPath: asset.drumsPath
  })
  if (!requiredPaths.length) return false
  return requiredPaths.every((filePath) => fs.existsSync(filePath))
}

const prewarmStemWaveformBundleFromPaths = (params: {
  libraryRoot: string
  sourceFilePath: string
  stemMode: MixtapeStemMode
  stemModel: string
  stemVersion: string
  vocalPath?: string | null
  instPath?: string | null
  bassPath?: string | null
  drumsPath?: string | null
}) => {
  prewarmMixtapeStemWaveformBundle({
    listRoot: params.libraryRoot,
    sourceFilePath: params.sourceFilePath,
    stemMode: params.stemMode,
    stemModel: params.stemModel,
    stemVersion: params.stemVersion,
    stemPaths: {
      vocalPath: params.vocalPath || null,
      instPath: params.instPath || null,
      bassPath: params.bassPath || null,
      drumsPath: params.drumsPath || null
    }
  })
}

const STEM_QUEUE_CPU_JOB_CONCURRENCY_MAX = 4
const STEM_QUEUE_CPU_JOB_CORE_DIVISOR = 2
const STEM_QUEUE_XPU_JOB_CONCURRENCY_MAX = 2
const STEM_QUEUE_DIRECTML_JOB_CONCURRENCY_MAX = 1

const hasBundledXpuRuntimeCandidate = () =>
  resolveBundledDemucsRuntimeCandidates().some((candidate) => {
    const runtimeKey = normalizeText(candidate?.key, 64).toLowerCase()
    return runtimeKey === 'runtime-xpu'
  })

const ensureStemQueueDeviceProbe = () => {
  if (getCachedStemDeviceProbeSnapshot()) return
  if (stemQueueProbeWarmupPromise) return
  const ffmpegPath = resolveBundledFfmpegPath()
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) return
  stemQueueProbeWarmupPromise = probeDemucsDevices(ffmpegPath)
    .catch(() => {})
    .then(() => undefined)
    .finally(() => {
      stemQueueProbeWarmupPromise = null
      runQueueLoop()
    })
}

const resolveGpuDeviceCap = (preferredDevice: MixtapeStemComputeDevice) => {
  const totalMemoryGb = Math.max(1, Math.floor(os.totalmem() / 1024 ** 3))
  const freeMemoryGb = Math.max(0, Math.floor(os.freemem() / 1024 ** 3))
  let cap = 1
  if (
    totalMemoryGb >= STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_2 &&
    freeMemoryGb >= STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_2
  ) {
    cap = 2
  }
  if (
    preferredDevice === 'cuda' &&
    totalMemoryGb >= STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_3 &&
    freeMemoryGb >= STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_3
  ) {
    cap = 3
  }
  if (preferredDevice === 'xpu') {
    cap = Math.min(cap, STEM_QUEUE_XPU_JOB_CONCURRENCY_MAX)
  }
  if (preferredDevice === 'directml') {
    cap = STEM_QUEUE_DIRECTML_JOB_CONCURRENCY_MAX
  }
  return {
    cap,
    totalMemoryGb,
    freeMemoryGb
  }
}

const resolveStemQueueConcurrency = () => {
  const cpuCount = Math.max(1, os.cpus().length || 1)
  const cpuCap = Math.max(
    1,
    Math.min(
      STEM_QUEUE_CPU_JOB_CONCURRENCY_MAX,
      Math.floor(cpuCount / STEM_QUEUE_CPU_JOB_CORE_DIVISOR)
    )
  )
  const deviceSnapshot = getCachedStemDeviceProbeSnapshot()
  const probePending = !deviceSnapshot
  if (probePending) {
    ensureStemQueueDeviceProbe()
  }
  const preferredDevice =
    deviceSnapshot?.devices.find((device) => device !== 'cpu') ||
    (process.platform === 'win32' && hasBundledXpuRuntimeCandidate() ? 'xpu' : 'cpu')
  const gpuDevice = preferredDevice !== 'cpu'
  const gpuDeviceCap = gpuDevice ? resolveGpuDeviceCap(preferredDevice) : null
  const resolvedDeviceCap = preferredDevice === 'cpu' ? cpuCap : gpuDeviceCap?.cap || 1
  const deviceCap = probePending ? 1 : resolvedDeviceCap
  const hasForegroundQueueJob = pendingQueue.some((job) => job.source === 'foreground')
  const hasForegroundInFlightJob = Array.from(inFlightJobMap.values()).some(
    (job) => job.source === 'foreground'
  )
  const hasForegroundDemand = hasForegroundQueueJob || hasForegroundInFlightJob
  const idleHint = getStemBackgroundConcurrencyHint()
  const backgroundTarget = probePending ? 1 : Math.max(1, Math.min(deviceCap, idleHint.target))
  const maxWorkers = hasForegroundDemand ? deviceCap : backgroundTarget
  return {
    maxWorkers,
    cpuCount,
    cpuCap,
    deviceCap,
    preferredDevice,
    probePending,
    totalMemoryGb:
      gpuDeviceCap?.totalMemoryGb || Math.max(1, Math.floor(os.totalmem() / 1024 ** 3)),
    freeMemoryGb: gpuDeviceCap?.freeMemoryGb || Math.max(0, Math.floor(os.freemem() / 1024 ** 3)),
    hasForegroundDemand,
    backgroundTarget,
    idleTarget: idleHint.target,
    idleProfile: idleHint.profile,
    idleAllowed: idleHint.allowed,
    foregroundBusy: idleHint.foregroundBusy,
    systemIdleSeconds: idleHint.systemIdleSeconds,
    systemIdleState: idleHint.systemIdleState
  }
}

const runQueueLoop = () => {
  const concurrency = resolveStemQueueConcurrency()
  const maxWorkers = concurrency.maxWorkers
  while (activeWorkers < maxWorkers && pendingQueue.length > 0) {
    const job = pendingQueue.shift()
    if (!job) continue
    if (pendingJobMap.get(job.key) !== job) continue
    pendingJobMap.delete(job.key)
    inFlightJobMap.set(job.key, job)
    const abortController = new AbortController()
    inFlightAbortByKey.set(job.key, abortController)
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    inFlightDoneByKey.set(job.key, done)
    activeWorkers += 1
    void processQueueJob(job, abortController.signal)
      .catch((error) => {
        if (isStemCancelledError(error)) return
        log.error('[mixtape-stem] process queue job failed', {
          filePath: job.filePath,
          stemMode: job.stemMode,
          error
        })
      })
      .finally(() => {
        activeWorkers = Math.max(0, activeWorkers - 1)
        if (inFlightJobMap.get(job.key) === job) {
          inFlightJobMap.delete(job.key)
        }
        inFlightAbortByKey.delete(job.key)
        inFlightDoneByKey.delete(job.key)
        cancelledJobKeySet.delete(job.key)
        resolveDone()
        runQueueLoop()
      })
  }
}

const processQueueJob = async (job: MixtapeStemQueueJob, signal?: AbortSignal) => {
  const targets = buildQueueTargets(job)
  upsertItemStemStatus(targets, 'running', {
    stemError: null,
    stemModel: job.model,
    stemVersion: job.stemVersion,
    stemReadyAt: null,
    stemVocalPath: null,
    stemInstPath: null,
    stemBassPath: null,
    stemDrumsPath: null,
    filePath: job.filePath
  })
  upsertMixtapeStemAsset({
    libraryRoot: job.libraryRoot,
    sourceSignature: job.sourceSignature,
    filePath: job.filePath,
    stemMode: job.stemMode,
    model: job.model,
    status: 'running',
    errorCode: null,
    errorMessage: null
  })
  notifyLibraryStemStatus(
    createLibraryStemSnapshot({
      filePath: job.filePath,
      stemMode: job.stemMode,
      model: job.model,
      status: 'running'
    })
  )
  try {
    const { runStemSeparation } = await import('./mixtapeStemSeparationRun')
    const separation = await runStemSeparation({
      filePath: job.filePath,
      sourceSignature: job.sourceSignature,
      stemMode: job.stemMode,
      model: job.model,
      signal,
      onDeviceStart: (device, context) => {
        if (device !== 'cpu') return
        for (const target of targets) {
          notifyStemCpuSlowHint({
            playlistId: target.playlistId,
            filePath: job.filePath,
            model: job.model,
            reasonCode: context?.reasonCode,
            reasonDetail: context?.reasonDetail
          })
        }
      },
      onProgress: (progress) => {
        for (const target of targets) {
          notifyStemRuntimeProgress({
            playlistId: target.playlistId,
            itemIds: target.itemIds,
            filePath: job.filePath,
            model: job.model,
            device: progress.device,
            stage: progress.stage,
            percent: progress.percent,
            activityConfirmedAt: progress.activityConfirmedAt,
            stageCompleted: progress.stageCompleted,
            stageTotal: progress.stageTotal,
            processedSec: progress.processedSec,
            totalSec: progress.totalSec,
            etaSec: progress.etaSec
          })
        }
        notifyLibraryStemStatus(
          createLibraryStemSnapshot({
            filePath: job.filePath,
            stemMode: job.stemMode,
            model: job.model,
            status: 'running',
            percent: progress.percent,
            activityConfirmedAt: progress.activityConfirmedAt,
            device: progress.device,
            stage: progress.stage,
            stageCompleted: progress.stageCompleted,
            stageTotal: progress.stageTotal,
            processedSec: progress.processedSec,
            totalSec: progress.totalSec,
            etaSec: progress.etaSec
          })
        )
      }
    })
    const requiredPaths = resolveAssetRequiredPaths(job.stemMode, separation)
    if (!requiredPaths.length || !requiredPaths.every((filePath) => fs.existsSync(filePath))) {
      throw createStemQueueError('STEM_ASSET_MISSING', 'STEM_ASSET_MISSING')
    }
    upsertMixtapeStemAsset({
      libraryRoot: job.libraryRoot,
      sourceSignature: job.sourceSignature,
      filePath: job.filePath,
      stemMode: job.stemMode,
      model: job.model,
      status: 'ready',
      vocalPath: separation.vocalPath || null,
      instPath: separation.instPath || null,
      bassPath: separation.bassPath || null,
      drumsPath: separation.drumsPath || null,
      errorCode: null,
      errorMessage: null
    })
    upsertItemStemStatus(targets, 'ready', {
      stemError: null,
      stemModel: job.model,
      stemVersion: job.stemVersion,
      stemReadyAt: Date.now(),
      stemVocalPath: separation.vocalPath || null,
      stemInstPath: separation.instPath || null,
      stemBassPath: separation.bassPath || null,
      stemDrumsPath: separation.drumsPath || null,
      filePath: job.filePath
    })
    if (job.targets.size > 0)
      prewarmStemWaveformBundleFromPaths({
        libraryRoot: job.libraryRoot,
        sourceFilePath: job.filePath,
        stemMode: job.stemMode,
        stemModel: job.model,
        stemVersion: job.stemVersion,
        vocalPath: separation.vocalPath || null,
        instPath: separation.instPath || null,
        bassPath: separation.bassPath || null,
        drumsPath: separation.drumsPath || null
      })
    notifyLibraryStemStatus(
      createLibraryStemSnapshot({
        filePath: job.filePath,
        stemMode: job.stemMode,
        model: job.model,
        status: 'ready',
        vocalPath: separation.vocalPath,
        instPath: separation.instPath,
        bassPath: separation.bassPath,
        drumsPath: separation.drumsPath
      })
    )
  } catch (error) {
    if (isStemCancelledError(error) || cancelledJobKeySet.has(job.key)) {
      resetCancelledJob(job)
      return
    }
    const errorCode = getErrorCode(error) || 'STEM_SPLIT_FAILED'
    const errorMessage = normalizeText(
      error instanceof Error ? error.message : String(error || 'stem split failed'),
      1200
    )
    log.error('[mixtape-stem] stem split failed', {
      filePath: job.filePath,
      stemMode: job.stemMode,
      model: job.model,
      errorCode,
      errorMessage
    })
    upsertMixtapeStemAsset({
      libraryRoot: job.libraryRoot,
      sourceSignature: job.sourceSignature,
      filePath: job.filePath,
      stemMode: job.stemMode,
      model: job.model,
      status: 'failed',
      errorCode,
      errorMessage
    })
    upsertItemStemStatus(targets, 'failed', {
      stemError: errorMessage,
      stemModel: job.model,
      stemVersion: job.stemVersion,
      stemReadyAt: null,
      stemVocalPath: null,
      stemInstPath: null,
      stemBassPath: null,
      stemDrumsPath: null,
      filePath: job.filePath,
      errorCode
    })
    notifyLibraryStemStatus(
      createLibraryStemSnapshot({
        filePath: job.filePath,
        stemMode: job.stemMode,
        model: job.model,
        status: 'failed',
        errorCode,
        errorMessage
      })
    )
  }
}

const mergeJobTargets = (job: MixtapeStemQueueJob, targets: MixtapeStemQueueTarget[]) => {
  for (const target of targets) {
    const playlistId = normalizePlaylistId(target.playlistId)
    if (!playlistId) continue
    const existing = job.targets.get(playlistId) || new Set<string>()
    for (const itemId of target.itemIds) {
      const normalizedItemId = normalizeText(itemId, 80)
      if (!normalizedItemId) continue
      existing.add(normalizedItemId)
    }
    if (existing.size > 0) {
      job.targets.set(playlistId, existing)
    }
  }
}

const resolveLibraryRootForFile = async (filePath: string): Promise<string> => {
  const normalizedPath = normalizeFilePath(filePath)
  if (!normalizedPath) return ''
  const libraryRoot = normalizeFilePath(getLibraryRootAbs() || '')
  if (libraryRoot) return libraryRoot
  try {
    const resolved = await findSongListRoot(path.dirname(normalizedPath))
    if (resolved) return normalizeFilePath(resolved)
  } catch {}
  return normalizeFilePath(path.dirname(normalizedPath))
}

const getLibraryStemQueueJobStatus = (jobKey: string): 'idle' | 'pending' | 'running' => {
  return inFlightJobMap.has(jobKey) ? 'running' : pendingJobMap.has(jobKey) ? 'pending' : 'idle'
}

const resetCancelledJob = (job: MixtapeStemQueueJob) => {
  const targets = buildQueueTargets(job)
  upsertMixtapeStemAsset({
    libraryRoot: job.libraryRoot,
    sourceSignature: job.sourceSignature,
    filePath: job.filePath,
    stemMode: job.stemMode,
    model: job.model,
    status: 'idle',
    vocalPath: null,
    instPath: null,
    bassPath: null,
    drumsPath: null,
    errorCode: null,
    errorMessage: null
  })
  if (targets.length) {
    upsertItemStemStatus(targets, 'idle', {
      stemError: null,
      stemModel: job.model,
      stemVersion: job.stemVersion,
      stemReadyAt: null,
      stemVocalPath: null,
      stemInstPath: null,
      stemBassPath: null,
      stemDrumsPath: null,
      filePath: job.filePath
    })
  }
  notifyLibraryStemStatus(
    createLibraryStemSnapshot({
      filePath: job.filePath,
      stemMode: job.stemMode,
      model: job.model,
      status: 'idle'
    })
  )
}

const waitForInFlightJob = async (jobKey: string, timeoutMs: number) => {
  const done = inFlightDoneByKey.get(jobKey)
  if (!done) return
  await Promise.race([
    done,
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(1000, timeoutMs))
    })
  ])
}

const cancelQueueJob = async (jobKey: string) => {
  const pending = pendingJobMap.get(jobKey)
  if (pending) {
    pendingJobMap.delete(jobKey)
    const index = pendingQueue.indexOf(pending)
    if (index >= 0) pendingQueue.splice(index, 1)
    resetCancelledJob(pending)
    return
  }
  const running = inFlightJobMap.get(jobKey)
  if (!running) return
  cancelledJobKeySet.add(jobKey)
  inFlightAbortByKey.get(jobKey)?.abort()
  await waitForInFlightJob(jobKey, 8000)
  if (inFlightJobMap.get(jobKey) === running) {
    resetCancelledJob(running)
  }
}

configureLibraryStemSeparationService({
  isMutationLocked: isLibraryMergeMutationLocked,
  resolveLibraryRootForFile,
  getJobStatus: getLibraryStemQueueJobStatus,
  enqueueForegroundJob: (input) => {
    const currentStatus = getLibraryStemQueueJobStatus(input.key)
    if (currentStatus !== 'idle') return currentStatus
    const job: MixtapeStemQueueJob = {
      ...input,
      source: 'foreground',
      targets: new Map<string, Set<string>>()
    }
    pendingJobMap.set(job.key, job)
    pendingQueue.push(job)
    runQueueLoop()
    return 'pending'
  },
  cancelJob: cancelQueueJob
})

export async function enqueueMixtapeStemJobs(
  params: MixtapeStemEnqueueParams
): Promise<MixtapeStemEnqueueResult> {
  if (isLibraryMergeMutationLocked()) {
    return { total: 0, queued: 0, merged: 0, readyFromCache: 0, skipped: 0 }
  }
  const playlistId = normalizePlaylistId(params?.playlistId)
  const stemMode = normalizeMixtapeStemMode(params?.stemMode)
  const force = !!params?.force
  const profile = normalizeStemProfile(params?.profile, DEFAULT_MIXTAPE_STEM_PROFILE)
  const model = normalizeModel(params?.model, profile)
  const stemVersion = normalizeStemVersion(params?.stemVersion)
  const source = normalizeEnqueueSource(params?.source)
  const inputPaths = Array.isArray(params?.filePaths) ? params.filePaths : []
  if (!playlistId || !inputPaths.length) {
    return {
      total: 0,
      queued: 0,
      merged: 0,
      readyFromCache: 0,
      skipped: 0
    }
  }

  const targetByPath = collectTargetsForFilePaths(playlistId, inputPaths)
  const total = targetByPath.size
  let queued = 0
  let merged = 0
  let readyFromCache = 0
  let skipped = 0

  for (const { filePath, itemIds } of targetByPath.values()) {
    if (!filePath || !itemIds.length) {
      skipped += 1
      continue
    }
    const libraryRoot = await resolveLibraryRootForFile(filePath)
    if (!libraryRoot) {
      skipped += 1
      continue
    }
    const sourceSignature = await computeLibraryStemSourceSignature(filePath)
    if (!sourceSignature) {
      skipped += 1
      continue
    }

    const queueTargets: MixtapeStemQueueTarget[] = [{ playlistId, itemIds }]
    const jobKey = buildJobKey({
      libraryRoot,
      sourceSignature,
      stemMode,
      model
    })
    const bypassReadyCache = shouldBypassReadyCacheForLegacyStemVersion({
      playlistId,
      itemIds,
      stemVersion
    })
    if (!force) {
      if (!bypassReadyCache) {
        const cachedAsset = getMixtapeStemAsset({
          libraryRoot,
          sourceSignature,
          stemMode,
          model
        })
        if (hasReadyStemAssets(stemMode, cachedAsset)) {
          readyFromCache += 1
          upsertItemStemStatus(queueTargets, 'ready', {
            stemError: null,
            stemModel: model,
            stemVersion,
            stemReadyAt: Date.now(),
            stemVocalPath: cachedAsset?.vocalPath || null,
            stemInstPath: cachedAsset?.instPath || null,
            stemBassPath: cachedAsset?.bassPath || null,
            stemDrumsPath: cachedAsset?.drumsPath || null,
            filePath
          })
          prewarmStemWaveformBundleFromPaths({
            libraryRoot,
            sourceFilePath: filePath,
            stemMode,
            stemModel: model,
            stemVersion,
            vocalPath: cachedAsset?.vocalPath || null,
            instPath: cachedAsset?.instPath || null,
            bassPath: cachedAsset?.bassPath || null,
            drumsPath: cachedAsset?.drumsPath || null
          })
          continue
        }
      }
    }

    const pendingJob = pendingJobMap.get(jobKey)
    if (pendingJob) {
      mergeJobTargets(pendingJob, queueTargets)
      if (source === 'foreground' && pendingJob.source !== 'foreground') {
        pendingJob.source = 'foreground'
      }
      upsertItemStemStatus(queueTargets, 'pending', {
        stemError: null,
        stemModel: pendingJob.model,
        stemVersion: pendingJob.stemVersion,
        stemReadyAt: null,
        stemVocalPath: null,
        stemInstPath: null,
        stemBassPath: null,
        stemDrumsPath: null,
        filePath
      })
      merged += 1
      continue
    }
    const inFlightJob = inFlightJobMap.get(jobKey)
    if (inFlightJob) {
      mergeJobTargets(inFlightJob, queueTargets)
      if (source === 'foreground' && inFlightJob.source !== 'foreground') {
        inFlightJob.source = 'foreground'
      }
      upsertItemStemStatus(queueTargets, 'running', {
        stemError: null,
        stemModel: inFlightJob.model,
        stemVersion: inFlightJob.stemVersion,
        stemReadyAt: null,
        stemVocalPath: null,
        stemInstPath: null,
        stemBassPath: null,
        stemDrumsPath: null,
        filePath
      })
      merged += 1
      continue
    }
    upsertItemStemStatus(queueTargets, 'pending', {
      stemError: null,
      stemModel: model,
      stemVersion,
      stemReadyAt: null,
      stemVocalPath: null,
      stemInstPath: null,
      stemBassPath: null,
      stemDrumsPath: null,
      filePath
    })
    upsertMixtapeStemAsset({
      libraryRoot,
      sourceSignature,
      filePath,
      stemMode,
      model,
      status: 'pending',
      errorCode: null,
      errorMessage: null
    })
    const job: MixtapeStemQueueJob = {
      key: jobKey,
      sourceSignature,
      filePath,
      stemMode,
      model,
      stemVersion,
      source,
      libraryRoot,
      targets: new Map<string, Set<string>>()
    }
    mergeJobTargets(job, queueTargets)
    pendingJobMap.set(jobKey, job)
    pendingQueue.push(job)
    queued += 1
  }

  runQueueLoop()
  return {
    total,
    queued,
    merged,
    readyFromCache,
    skipped
  }
}

export function isMixtapeStemQueueBusy(): boolean {
  return pendingQueue.length > 0 || inFlightJobMap.size > 0 || activeWorkers > 0
}

export async function retryMixtapeStemJobs(params: MixtapeStemRetryParams) {
  const playlistId = normalizePlaylistId(params?.playlistId)
  const stemMode = normalizeMixtapeStemMode(params?.stemMode)
  if (!playlistId) {
    return {
      total: 0,
      queued: 0,
      merged: 0,
      readyFromCache: 0,
      skipped: 0
    }
  }
  const explicitFilePaths = Array.isArray(params?.filePaths)
    ? params.filePaths.map((item) => normalizeFilePath(item)).filter(Boolean)
    : []
  const explicitItemIds = new Set(
    Array.isArray(params?.itemIds)
      ? params.itemIds.map((item) => normalizeText(item, 80)).filter(Boolean)
      : []
  )
  const statusRows = listMixtapeTrackStemStatusByPlaylist(playlistId)
  const failedRows = statusRows.filter((row) => row.stemStatus === 'failed')
  const failedFilePathSet = new Set<string>(
    failedRows.map((row) => normalizeFilePath(row.filePath)).filter(Boolean)
  )
  if (explicitItemIds.size > 0) {
    for (const row of failedRows) {
      if (!explicitItemIds.has(row.itemId)) continue
      const filePath = normalizeFilePath(row.filePath)
      if (filePath) failedFilePathSet.add(filePath)
    }
  }
  for (const item of explicitFilePaths) {
    failedFilePathSet.add(item)
  }
  const profile = normalizeStemProfile(params?.profile, DEFAULT_MIXTAPE_STEM_PROFILE)
  return enqueueMixtapeStemJobs({
    playlistId,
    filePaths: Array.from(failedFilePathSet),
    stemMode,
    force: true,
    profile,
    model: params?.model,
    stemVersion: params?.stemVersion
  })
}

export function getMixtapeStemStatusSnapshot(playlistId: string) {
  const normalizedPlaylistId = normalizePlaylistId(playlistId)
  if (!normalizedPlaylistId) {
    return {
      items: [],
      stemSummary: summarizeMixtapeStemStatusByPlaylist('')
    }
  }
  return {
    items: listMixtapeTrackStemStatusByPlaylist(normalizedPlaylistId),
    stemSummary: summarizeMixtapeStemStatusByPlaylist(normalizedPlaylistId)
  }
}
