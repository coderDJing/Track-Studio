import { EventEmitter } from 'node:events'
import { is } from '@electron-toolkit/utils'
import { KeyAnalysisQueue } from './keyAnalysis/queue'
import type {
  KeyAnalysisBackgroundStatus,
  KeyAnalysisPriority,
  KeyAnalysisQueueCategory,
  KeyAnalysisRequestFlags
} from './keyAnalysis/types'
import { KEY_ANALYSIS_WORKER_MAX, normalizePath } from './keyAnalysis/types'
import * as LibraryCacheDb from '../libraryCacheDb'
import { isLibraryMergeMutationLocked } from './libraryMerge/mutationGate'
import type { AnalysisBpmRangePresetId } from '../../shared/analysisBpmRange'
import type { AnalysisGridMode } from '../../shared/analysisGridMode'
import { isAnalysisGridModeSupported } from '../../shared/analysisGridMode'

type EnqueueKeyAnalysisOptions = KeyAnalysisRequestFlags & {
  urgent?: boolean
  source?: 'foreground' | 'background'
  fastAnalysis?: boolean
  focusSlot?: string
  preemptible?: boolean
  category?: KeyAnalysisQueueCategory
  waveformOnly?: boolean
  includeStructure?: boolean
  analysisBpmRangeId?: AnalysisBpmRangePresetId
  analysisGridMode?: AnalysisGridMode
  manualBatchId?: string
  manualBatchIds?: string[]
}

// 全局并发策略：所有分析任务共享同一个全局队列和并发额度。
// 并发上限属于全局队列，不属于任何单个任务或 batch。
// 即使存在多个手动批量任务，也必须共享同一份额度，不能按任务线性放大。
const KEY_ANALYSIS_WORKER_MIN = 1

// 提升到 2 路并发所需的冷却时间（最后一次 transport 操作后需等待的毫秒数）
const CONCURRENCY_BOOST_COOLDOWN_MS = 5000

// 播放状态跟踪
let isAnyDeckPlaying = false
let lastTransportActivityAt = 0
let concurrencyCooldownTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 解析全局 key-analysis worker 数量。
 * 提升到 2 的条件（全部满足）：
 * - 队列里有手动批量任务，且待分析数量大于 1
 * - 当前没有播放中的 deck
 * - 最近 5 秒内没有 preparePlayhead / seek / 切歌操作
 * 降回 1 的条件（任意一个）：
 * - 播放开始
 * - 用户频繁切歌、seek、拖动横向浏览
 * - 队列里只有后台闲时分析
 */
function resolveKeyAnalysisWorkerCount(): number {
  if (isAnyDeckPlaying) return KEY_ANALYSIS_WORKER_MIN
  if (Date.now() - lastTransportActivityAt < CONCURRENCY_BOOST_COOLDOWN_MS) {
    return KEY_ANALYSIS_WORKER_MIN
  }
  if (manualBatches.size > 0) {
    const hasPendingWork = Array.from(manualBatches.values()).some(
      (batch) => batch.pendingByPath.size > 1
    )
    if (hasPendingWork) return KEY_ANALYSIS_WORKER_MAX
  }
  return KEY_ANALYSIS_WORKER_MIN
}

/**
 * 通知队列播放状态变化，触发并发策略重新评估。
 */
export function notifyPlaybackStateChange(playing: boolean) {
  if (isAnyDeckPlaying === playing) return
  isAnyDeckPlaying = playing
  reevaluateConcurrency()
  if (!playing) {
    scheduleCooldownReevaluation()
  }
}

/**
 * 通知队列 transport 操作发生（preparePlayhead / seek / 切歌），触发并发降级。
 */
export function notifyTransportActivity() {
  lastTransportActivityAt = Date.now()
  reevaluateConcurrency()
  scheduleCooldownReevaluation()
}

function reevaluateConcurrency() {
  if (!queue) return
  const target = resolveKeyAnalysisWorkerCount()
  queue.setGlobalConcurrency(target)
}

function scheduleCooldownReevaluation() {
  if (concurrencyCooldownTimer) {
    clearTimeout(concurrencyCooldownTimer)
    concurrencyCooldownTimer = null
  }
  if (isAnyDeckPlaying) return
  const remaining = CONCURRENCY_BOOST_COOLDOWN_MS - (Date.now() - lastTransportActivityAt)
  if (remaining <= 0) return
  concurrencyCooldownTimer = setTimeout(() => {
    concurrencyCooldownTimer = null
    reevaluateConcurrency()
  }, remaining + 10)
}

export const keyAnalysisEvents = new EventEmitter()
let queue: KeyAnalysisQueue | null = null
let nextManualBatchSeq = 0

type ManualKeyAnalysisBatch = {
  id: string
  titleKey: string
  filePaths: string[]
  pendingByPath: Map<string, string>
  /** 本轮真失败的曲目与原因；只有它非空时批次结束才需要向用户汇总。 */
  failedByPath: Map<string, string>
  total: number
  completed: number
  canceled: boolean
}

const manualBatches = new Map<string, ManualKeyAnalysisBatch>()

const isPathTrackedByQueue = (normalizedPath: string): boolean =>
  Boolean(queue?.hasTrackedPath(normalizedPath))

/** 等待中、进行中或延迟补跑的分析任务都视为已在队列中。 */
export function isKeyAnalysisPathQueued(filePath: string): boolean {
  const normalized = normalizePath(typeof filePath === 'string' ? filePath.trim() : '')
  if (!normalized) return false
  return isPathTrackedByQueue(normalized)
}

const isPathPendingInManualBatch = (normalizedPath: string): boolean => {
  if (!normalizedPath) return false
  for (const batch of manualBatches.values()) {
    if (batch.pendingByPath.has(normalizedPath) && isPathTrackedByQueue(normalizedPath)) {
      return true
    }
  }
  return false
}

export function getManualKeyAnalysisPendingFilePaths(filePaths?: string[]) {
  pruneUntrackedManualBatchPaths()
  const filterSet = new Set(
    (Array.isArray(filePaths) ? filePaths : [])
      .map((filePath) => (typeof filePath === 'string' ? normalizePath(filePath.trim()) : ''))
      .filter(Boolean)
  )
  const result: string[] = []
  const seen = new Set<string>()
  for (const batch of manualBatches.values()) {
    for (const [normalizedPath, filePath] of batch.pendingByPath) {
      if (!isPathTrackedByQueue(normalizedPath)) continue
      if (filterSet.size > 0 && !filterSet.has(normalizedPath)) continue
      if (seen.has(normalizedPath)) continue
      seen.add(normalizedPath)
      result.push(filePath)
    }
  }
  return result
}

/**
 * 获取全局单例队列实例。
 * 禁止任何入口直接 new KeyAnalysisQueue(...)，所有分析必须通过这个单例。
 * 任务只负责逻辑归属（batch id、进度、取消），不持有并发额度，不自己 drain 队列。
 */
const getQueue = () => {
  if (!queue) {
    queue = new KeyAnalysisQueue(resolveKeyAnalysisWorkerCount(), keyAnalysisEvents)
  }
  return queue
}

export function enqueueKeyAnalysis(
  filePath: string,
  priority: KeyAnalysisPriority = 'low',
  options: EnqueueKeyAnalysisOptions = {}
) {
  if (isLibraryMergeMutationLocked()) return
  getQueue().enqueue(filePath, priority, options)
}

export function enqueueKeyAnalysisList(
  filePaths: string[],
  priority: KeyAnalysisPriority = 'low',
  options: EnqueueKeyAnalysisOptions = {}
) {
  if (isLibraryMergeMutationLocked()) return
  getQueue().enqueueList(filePaths, priority, options)
}

const emitManualBatchProgress = (batch: ManualKeyAnalysisBatch) => {
  keyAnalysisEvents.emit('manual-batch-progress', {
    id: batch.id,
    titleKey: batch.titleKey,
    now: Math.min(batch.completed, batch.total),
    total: batch.total,
    cancelable: true,
    cancelChannel: 'key-analysis:cancel-manual-batch',
    cancelPayload: { batchId: batch.id }
  })
}

const finishManualBatch = (
  batch: ManualKeyAnalysisBatch,
  canceled = false,
  terminalStage?: 'job-done' | 'job-error'
) => {
  if (!manualBatches.has(batch.id)) return
  manualBatches.delete(batch.id)
  batch.canceled = canceled
  // 取消的批次不汇总失败：用户已经主动中止，逐个报告失败没有意义。
  const failedItems = canceled
    ? []
    : Array.from(batch.failedByPath, ([filePath, detail]) => ({ filePath, detail }))
  keyAnalysisEvents.emit('manual-batch-end', {
    batchId: batch.id,
    filePaths: batch.filePaths,
    canceled,
    total: batch.total,
    failed: failedItems.length,
    // 只带前若干条明细，避免大批量失败时把整份清单塞进 IPC。
    failedItems: failedItems.slice(0, 20)
  })
  keyAnalysisEvents.emit('manual-batch-progress', {
    id: batch.id,
    ...(canceled
      ? { dismiss: true }
      : {
          titleKey: batch.titleKey,
          now: batch.total,
          total: batch.total,
          cancelable: false
        })
  })
  const stageToEmit = terminalStage || (canceled ? 'job-error' : undefined)
  if (stageToEmit) {
    for (const filePath of batch.filePaths) {
      keyAnalysisEvents.emit('analysis-stage-update', {
        filePath,
        stage: stageToEmit,
        manualBatchIds: [batch.id]
      })
    }
  }
  reevaluateConcurrency()
}

function pruneUntrackedManualBatchPaths() {
  for (const batch of Array.from(manualBatches.values())) {
    let changed = false
    for (const normalizedPath of Array.from(batch.pendingByPath.keys())) {
      if (isPathTrackedByQueue(normalizedPath)) continue
      batch.pendingByPath.delete(normalizedPath)
      changed = true
    }
    if (changed && batch.pendingByPath.size === 0) {
      finishManualBatch(batch, false, 'job-done')
    }
  }
}

const completeManualBatchFile = (
  filePath: string,
  manualBatchIds?: string[],
  failure?: { detail: string }
) => {
  const normalizedPath = normalizePath(filePath)
  if (!normalizedPath) return
  const batchIdSet =
    Array.isArray(manualBatchIds) && manualBatchIds.length > 0 ? new Set(manualBatchIds) : null
  let changed = false
  for (const batch of manualBatches.values()) {
    if (batchIdSet && !batchIdSet.has(batch.id)) continue
    if (!batch.pendingByPath.has(normalizedPath)) continue
    if (failure) batch.failedByPath.set(normalizedPath, failure.detail)
    batch.pendingByPath.delete(normalizedPath)
    batch.completed = Math.min(batch.total, batch.completed + 1)
    changed = true
    if (batch.pendingByPath.size === 0) {
      finishManualBatch(batch)
    } else {
      emitManualBatchProgress(batch)
    }
  }
  if (changed) {
    reevaluateConcurrency()
  }
}

keyAnalysisEvents.on(
  'analysis-stage-update',
  (payload?: {
    filePath?: string
    stage?: string
    manualBatchIds?: string[]
    manualBatchFailed?: boolean
    manualBatchFailureDetail?: string
  }) => {
    const stage = String(payload?.stage || '')
    if (stage !== 'job-done' && stage !== 'job-error') return
    // 只有主进程明确标记过的“真失败”才计数：结果作废等 job-error 不算。
    const failure =
      payload?.manualBatchFailed === true
        ? { detail: String(payload?.manualBatchFailureDetail || '').slice(0, 200) }
        : undefined
    completeManualBatchFile(String(payload?.filePath || ''), payload?.manualBatchIds, failure)
  }
)

keyAnalysisEvents.on(
  'analysis-job-skipped',
  (payload?: { filePath?: string; manualBatchIds?: string[] }) => {
    if (!Array.isArray(payload?.manualBatchIds) || payload.manualBatchIds.length === 0) return
    keyAnalysisEvents.emit('analysis-stage-update', {
      filePath: String(payload?.filePath || ''),
      stage: 'job-done',
      manualBatchIds: payload.manualBatchIds
    })
  }
)

export function enqueueManualKeyAnalysisBatch(
  filePaths: string[],
  options?: {
    titleKey?: string
    analysisBpmRangeId?: AnalysisBpmRangePresetId
    analysisGridMode?: AnalysisGridMode
    includeStructure?: boolean
  } & KeyAnalysisRequestFlags
) {
  if (isLibraryMergeMutationLocked()) return { batchId: '', queued: 0 }
  if (
    options?.analysisGridMode === 'dynamic' &&
    !isAnalysisGridModeSupported(options.analysisGridMode, { isDevelopment: is.dev })
  ) {
    return { batchId: '', queued: 0, blocked: true, reason: 'dynamic-grid-unavailable' }
  }
  pruneUntrackedManualBatchPaths()
  const pendingByPath = new Map<string, string>()
  for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
    if (typeof filePath !== 'string') continue
    const trimmed = filePath.trim()
    if (!trimmed) continue
    const normalized = normalizePath(trimmed)
    if (!normalized || pendingByPath.has(normalized)) continue
    if (isPathPendingInManualBatch(normalized)) continue
    pendingByPath.set(normalized, trimmed)
  }
  const uniqueFilePaths = Array.from(pendingByPath.values())
  if (uniqueFilePaths.length === 0) {
    return { batchId: '', queued: 0 }
  }

  const batchId = `key-analysis.manual.${Date.now()}.${++nextManualBatchSeq}`
  const batch: ManualKeyAnalysisBatch = {
    id: batchId,
    titleKey: String(options?.titleKey || 'tracks.analyzingTracks'),
    filePaths: uniqueFilePaths,
    pendingByPath,
    failedByPath: new Map(),
    total: uniqueFilePaths.length,
    completed: 0,
    canceled: false
  }
  manualBatches.set(batchId, batch)
  keyAnalysisEvents.emit('manual-batch-start', {
    batchId,
    filePaths: uniqueFilePaths
  })
  emitManualBatchProgress(batch)
  enqueueKeyAnalysisList(uniqueFilePaths, 'medium', {
    source: 'foreground',
    preemptible: true,
    category: 'manual-batch',
    manualBatchId: batchId,
    forceAnalysis: options?.forceAnalysis,
    analysisTargets: options?.analysisTargets,
    analysisGridMode: options?.analysisGridMode,
    analysisBpmRangeId: options?.analysisBpmRangeId,
    includeStructure: options?.includeStructure ?? true
  })
  reevaluateConcurrency()
  scheduleCooldownReevaluation()
  return { batchId, queued: uniqueFilePaths.length }
}

export async function cancelManualKeyAnalysisBatch(batchId: string) {
  const normalizedBatchId = String(batchId || '').trim()
  const batch = manualBatches.get(normalizedBatchId)
  if (!batch) return { canceled: false }
  await getQueue().cancelManualBatch(normalizedBatchId)
  finishManualBatch(batch, true)
  return { canceled: true }
}

/** Cancel every key-analysis queue item (manual/playing/background) before library merge. */
export async function cancelAllKeyAnalysisForLibraryMerge() {
  const batches = Array.from(manualBatches.values())
  for (const batch of batches) {
    finishManualBatch(batch, true)
  }
  if (!queue) return
  await queue.cancelAllWorkForLibraryMerge()
}

export function startKeyAnalysisBackground() {
  if (isLibraryMergeMutationLocked()) return
  getQueue().startBackgroundSweep()
}

export function cancelKeyAnalysisBackground(pauseMs?: number) {
  if (!queue) return
  queue.cancelBackgroundWork(pauseMs)
}

export async function cancelKeyAnalysisForPaths(filePaths: string[] | string) {
  if (!queue) return
  const list = Array.isArray(filePaths) ? filePaths : [filePaths]
  await queue.cancelByPath(list)
  pruneUntrackedManualBatchPaths()
}

export function getKeyAnalysisBackgroundStatus(): KeyAnalysisBackgroundStatus {
  if (!queue) {
    return {
      active: false,
      pending: 0,
      inFlight: 0,
      processing: 0,
      scanInProgress: false,
      enabled: false
    }
  }
  return queue.getBackgroundStatusSnapshot()
}

export function isKeyAnalysisForegroundBusy(): boolean {
  if (!queue) return false
  return queue.isForegroundBusy()
}

export const getKeyAnalysisDiagnosticSnapshot = () => queue?.getDiagnosticSnapshot() ?? null

/** Activity snapshot for library-merge busy gating (in-flight vs pending-only). */
export function getKeyAnalysisLibraryMergeActivity(): {
  inFlight: boolean
  pendingOnly: boolean
  any: boolean
} {
  if (!queue) {
    return { inFlight: false, pendingOnly: false, any: false }
  }
  return queue.getLibraryMergeActivity()
}

export function invalidateKeyAnalysisCache(filePaths: string[] | string) {
  if (!queue) return
  const list = Array.isArray(filePaths) ? filePaths : [filePaths]
  queue.invalidateDoneByPath(list)
  LibraryCacheDb.unregisterExternalAnalysisContexts(list)
}

export function remapKeyAnalysisTrackedPath(fromPath: string, toPath: string) {
  if (!queue) return
  queue.remapTrackedPath(fromPath, toPath)
}

export type { KeyAnalysisBackgroundStatus } from './keyAnalysis/types'
