import fs from 'node:fs'
import mainWindow from '../window/mainWindow'
import type { MixtapeStemMode } from '../mixtapeDb'
import {
  getMixtapeStemAsset,
  upsertMixtapeStemAsset,
  type MixtapeStemStatus
} from '../mixtapeStemDb'
import { FIXED_MIXTAPE_STEM_MODE, normalizeMixtapeStemMode } from '../../shared/mixtapeStemMode'
import {
  DEFAULT_MIXTAPE_STEM_PROFILE,
  parseMixtapeStemModel,
  resolveMixtapeStemModelByProfile
} from '../../shared/mixtapeStemProfiles'
import { computeLibraryStemSourceSignature } from './libraryStemAssetStorage'
import { isAnalysisRuntimeAvailable } from './analysisRuntimeDownload'
import { isDemucsUltraModelInstalled } from './demucsUltraModelDownload'
import type {
  MixtapeStemComputeDevice,
  MixtapeStemRuntimeStage
} from './mixtapeStemSeparationShared'

const DEFAULT_STEM_MODEL = resolveMixtapeStemModelByProfile(DEFAULT_MIXTAPE_STEM_PROFILE)
const DEFAULT_STEM_VERSION = 'demucs-waveform-builtin-20260313-stem-v2'

export type LibraryStemStatus = 'idle' | MixtapeStemStatus

export type LibraryStemStatusSnapshot = {
  filePath: string
  stemMode: MixtapeStemMode
  model: string
  status: LibraryStemStatus
  errorCode: string | null
  errorMessage: string | null
  vocalPath: string | null
  instPath: string | null
  bassPath: string | null
  drumsPath: string | null
  percent: number | null
  activityConfirmedAt: number | null
  device: MixtapeStemComputeDevice | null
  stage: MixtapeStemRuntimeStage | null
  stageCompleted: number | null
  stageTotal: number | null
  processedSec: number | null
  totalSec: number | null
  etaSec: number | null
}

type LibraryStemJobInput = {
  key: string
  sourceSignature: string
  filePath: string
  stemMode: MixtapeStemMode
  model: string
  stemVersion: string
  libraryRoot: string
}

type LibraryStemQueueAdapter = {
  isMutationLocked: () => boolean
  resolveLibraryRootForFile: (filePath: string) => Promise<string>
  getJobStatus: (jobKey: string) => 'idle' | 'pending' | 'running'
  enqueueForegroundJob: (job: LibraryStemJobInput) => 'pending' | 'running'
  cancelJob: (jobKey: string) => Promise<void>
}

let queueAdapter: LibraryStemQueueAdapter | null = null

const normalizeText = (value: unknown, maxLen = 2000): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLen) : ''
}

const normalizeFilePath = (value: unknown) => normalizeText(value, 4000)

const normalizeStemModel = (value: unknown) =>
  parseMixtapeStemModel(value, DEFAULT_MIXTAPE_STEM_PROFILE).requestedModel

const normalizeNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizePathKey = (value: string): string => {
  const normalized = normalizeFilePath(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const buildJobKey = (params: {
  libraryRoot: string
  sourceSignature: string
  stemMode: MixtapeStemMode
  model: string
}) =>
  `${normalizePathKey(params.libraryRoot)}::${normalizeText(params.sourceSignature, 160).toLowerCase()}::${params.stemMode}::${params.model}`

const getQueueAdapter = () => {
  if (!queueAdapter) throw new Error('LIBRARY_STEM_QUEUE_UNAVAILABLE')
  return queueAdapter
}

const hasReadyStemAssets = (asset: ReturnType<typeof getMixtapeStemAsset> | null): boolean => {
  if (!asset || asset.status !== 'ready') return false
  return [asset.vocalPath, asset.instPath, asset.bassPath, asset.drumsPath]
    .map((item) => normalizeFilePath(item))
    .every((filePath) => !!filePath && fs.existsSync(filePath))
}

export const createLibraryStemSnapshot = (
  params: Partial<LibraryStemStatusSnapshot> & Pick<LibraryStemStatusSnapshot, 'filePath'>
): LibraryStemStatusSnapshot => ({
  filePath: normalizeFilePath(params.filePath),
  stemMode: params.stemMode || normalizeMixtapeStemMode(FIXED_MIXTAPE_STEM_MODE),
  model: normalizeStemModel(params.model || DEFAULT_STEM_MODEL),
  status: params.status || 'idle',
  errorCode: normalizeText(params.errorCode, 80) || null,
  errorMessage: normalizeText(params.errorMessage, 1200) || null,
  vocalPath: normalizeFilePath(params.vocalPath) || null,
  instPath: normalizeFilePath(params.instPath) || null,
  bassPath: normalizeFilePath(params.bassPath) || null,
  drumsPath: normalizeFilePath(params.drumsPath) || null,
  percent: normalizeNumberOrNull(params.percent),
  activityConfirmedAt: normalizeNumberOrNull(params.activityConfirmedAt),
  device: params.device || null,
  stage: params.stage || null,
  stageCompleted: normalizeNumberOrNull(params.stageCompleted),
  stageTotal: normalizeNumberOrNull(params.stageTotal),
  processedSec: normalizeNumberOrNull(params.processedSec),
  totalSec: normalizeNumberOrNull(params.totalSec),
  etaSec: normalizeNumberOrNull(params.etaSec)
})

export const notifyLibraryStemStatus = (snapshot: LibraryStemStatusSnapshot) => {
  if (!snapshot.filePath) return
  try {
    mainWindow.instance?.webContents.send('library-stem-status-updated', snapshot)
  } catch {}
}

export function configureLibraryStemSeparationService(adapter: LibraryStemQueueAdapter) {
  queueAdapter = adapter
}

export async function getLibraryStemStatusSnapshot(
  inputFilePath: string,
  inputModel?: unknown
): Promise<LibraryStemStatusSnapshot> {
  const filePath = normalizeFilePath(inputFilePath)
  const stemMode = normalizeMixtapeStemMode(FIXED_MIXTAPE_STEM_MODE)
  const model = normalizeStemModel(inputModel || DEFAULT_STEM_MODEL)
  if (!filePath || !fs.existsSync(filePath)) {
    return createLibraryStemSnapshot({
      filePath,
      stemMode,
      model,
      status: 'failed',
      errorCode: 'STEM_SOURCE_MISSING',
      errorMessage: 'Stem 源文件不存在'
    })
  }

  const adapter = getQueueAdapter()
  const libraryRoot = await adapter.resolveLibraryRootForFile(filePath)
  const sourceSignature = await computeLibraryStemSourceSignature(filePath)
  if (!libraryRoot || !sourceSignature) {
    return createLibraryStemSnapshot({
      filePath,
      stemMode,
      model,
      status: 'failed',
      errorCode: 'STEM_SOURCE_UNREADABLE',
      errorMessage: '无法读取 Stem 源文件'
    })
  }

  const jobKey = buildJobKey({ libraryRoot, sourceSignature, stemMode, model })
  const asset = getMixtapeStemAsset({ libraryRoot, sourceSignature, stemMode, model })
  if (hasReadyStemAssets(asset)) {
    return createLibraryStemSnapshot({
      filePath,
      stemMode,
      model,
      status: 'ready',
      vocalPath: asset?.vocalPath,
      instPath: asset?.instPath,
      bassPath: asset?.bassPath,
      drumsPath: asset?.drumsPath
    })
  }

  const jobStatus = adapter.getJobStatus(jobKey)
  if (jobStatus !== 'idle') {
    return createLibraryStemSnapshot({ filePath, stemMode, model, status: jobStatus })
  }
  if (asset?.status === 'failed') {
    return createLibraryStemSnapshot({
      filePath,
      stemMode,
      model,
      status: 'failed',
      errorCode: asset.errorCode,
      errorMessage: asset.errorMessage
    })
  }
  return createLibraryStemSnapshot({ filePath, stemMode, model })
}

export async function enqueueLibraryStemJob(params: {
  filePath: string
  model?: unknown
  force?: boolean
}): Promise<LibraryStemStatusSnapshot> {
  const model = normalizeStemModel(params?.model || DEFAULT_STEM_MODEL)
  const adapter = getQueueAdapter()
  if (adapter.isMutationLocked()) {
    return createLibraryStemSnapshot({
      filePath: params?.filePath || '',
      model,
      status: 'failed',
      errorCode: 'LIBRARY_MUTATION_LOCKED',
      errorMessage: '音乐库整理中，暂时不能开始 Stem 分离'
    })
  }

  const snapshot = await getLibraryStemStatusSnapshot(params?.filePath || '', model)
  if (!snapshot.filePath || !fs.existsSync(snapshot.filePath)) return snapshot
  if (!(await isAnalysisRuntimeAvailable('stem'))) {
    return createLibraryStemSnapshot({
      ...snapshot,
      status: 'failed',
      errorCode: 'STEM_RUNTIME_NOT_INSTALLED',
      errorMessage: '分析运行时尚未下载'
    })
  }
  if (parseMixtapeStemModel(model).profile === 'ultra' && !(await isDemucsUltraModelInstalled())) {
    return createLibraryStemSnapshot({
      ...snapshot,
      status: 'failed',
      errorCode: 'STEM_ULTRA_MODEL_NOT_INSTALLED',
      errorMessage: '超高质量模型尚未下载'
    })
  }
  if (snapshot.status === 'ready' && !params?.force) {
    notifyLibraryStemStatus(snapshot)
    return snapshot
  }

  const libraryRoot = await adapter.resolveLibraryRootForFile(snapshot.filePath)
  const sourceSignature = await computeLibraryStemSourceSignature(snapshot.filePath)
  if (!libraryRoot || !sourceSignature) {
    return createLibraryStemSnapshot({
      ...snapshot,
      status: 'failed',
      errorCode: 'STEM_SOURCE_UNREADABLE',
      errorMessage: '无法读取 Stem 源文件'
    })
  }

  const job: LibraryStemJobInput = {
    key: buildJobKey({
      libraryRoot,
      sourceSignature,
      stemMode: snapshot.stemMode,
      model: snapshot.model
    }),
    sourceSignature,
    filePath: snapshot.filePath,
    stemMode: snapshot.stemMode,
    model: snapshot.model,
    stemVersion: DEFAULT_STEM_VERSION,
    libraryRoot
  }
  const queueStatus = adapter.getJobStatus(job.key)
  if (queueStatus !== 'idle') {
    const queued = createLibraryStemSnapshot({ ...snapshot, status: queueStatus })
    notifyLibraryStemStatus(queued)
    return queued
  }

  const pending = createLibraryStemSnapshot({ ...snapshot, status: 'pending' })
  upsertMixtapeStemAsset({
    libraryRoot,
    sourceSignature,
    filePath: pending.filePath,
    stemMode: pending.stemMode,
    model: pending.model,
    status: 'pending',
    errorCode: null,
    errorMessage: null
  })
  const scheduledStatus = adapter.enqueueForegroundJob(job)
  const queued = createLibraryStemSnapshot({ ...pending, status: scheduledStatus })
  notifyLibraryStemStatus(queued)
  return queued
}

export async function cancelLibraryStemJob(params: {
  filePath: string
  model?: unknown
}): Promise<LibraryStemStatusSnapshot> {
  const snapshot = await getLibraryStemStatusSnapshot(params?.filePath || '', params?.model)
  if (snapshot.status !== 'pending' && snapshot.status !== 'running') return snapshot

  const adapter = getQueueAdapter()
  const libraryRoot = await adapter.resolveLibraryRootForFile(snapshot.filePath)
  const sourceSignature = await computeLibraryStemSourceSignature(snapshot.filePath)
  if (!libraryRoot || !sourceSignature) return snapshot

  await adapter.cancelJob(
    buildJobKey({
      libraryRoot,
      sourceSignature,
      stemMode: snapshot.stemMode,
      model: snapshot.model
    })
  )
  return await getLibraryStemStatusSnapshot(snapshot.filePath, snapshot.model)
}
