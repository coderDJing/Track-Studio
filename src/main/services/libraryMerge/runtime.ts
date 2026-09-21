import type { BrowserWindow } from 'electron'
import { isAnyMixtapeWindowOpen } from '../../window/mixtapeWindow'
import {
  cancelAllKeyAnalysisForLibraryMerge,
  getKeyAnalysisLibraryMergeActivity
} from '../keyAnalysisQueue'
import {
  cancelAllMetadataAutoFill,
  isMetadataAutoFillBusy,
  waitForMetadataAutoFillIdle
} from '../metadataAutoFill'
import { isAudioConversionBusy } from '../audioConversion'
import { isPlaylistBatchRenameBusy } from '../playlistBatchRename'
import {
  cancelMixtapeRawWaveformQueueForLibraryMerge,
  isMixtapeRawWaveformQueueBusy,
  waitForMixtapeRawWaveformQueueIdle
} from '../mixtapeRawWaveformQueue'
import { isMixtapeStemQueueBusy } from '../mixtapeStemQueue'
import {
  cancelMixtapeWaveformQueueForLibraryMerge,
  isMixtapeWaveformQueueBusy,
  waitForMixtapeWaveformQueueIdle
} from '../mixtapeWaveformQueue'
import {
  discardPendingLibraryTreeReconcile,
  startLibraryTreeWatcher,
  stopLibraryTreeWatcher,
  waitForLibraryTreeWatcherIdle
} from '../../libraryTreeWatcher'
import {
  getBackgroundTaskExecutionStatus,
  interruptBackgroundTaskExecution
} from '../backgroundOrchestrator'
import { isHorizontalBrowseTransportRecordingActive } from '../../ipc/horizontalBrowseTransportBridge'
import { isImportSongsBusy } from './operationActivity'
import {
  LibraryMergeError,
  type LibraryMergeBusyClassification,
  type LibraryMergeBusyReason,
  type LibraryMergeScope
} from './types'
import {
  acquireLibraryMergeLockAfterMaintenanceIdle,
  drainDeferredLibraryMaintenance,
  isLibraryMergeMutationLocked
} from './mutationGate'
import { waitForAllRecycleBinCacheTransfers } from '../recycleBinCacheTransferQueue'

export {
  deferLibraryMaintenanceAfterMergeLockReleased,
  isLibraryMergeMutationLocked,
  tryBeginLibraryMaintenanceMutation
} from './mutationGate'

/**
 * Finer busy policy (risk-tiered):
 * - Only real in-flight work needs a confirm dialog (cancellable).
 * - Pending-only queues are cleared silently before taking the lock.
 * - Hard-blocking covers moves/import/rename/recording and full-scope mixtape writers.
 * - Curated merge does not hard-block open mixtape windows or stem jobs (they do not
 *   share curated playlist / analysis write paths the same way full merge does).
 * - Library tree watcher is never a user-facing busy reason: debounce is discarded,
 *   real reconcile/bulk is waited on silently, then the watcher is stopped for the lock.
 */
const CANCELLABLE_BUSY_REASONS = new Set<LibraryMergeBusyReason>([
  'key-analysis',
  'metadata-auto-fill',
  'mixtape-waveform',
  'mixtape-raw-waveform'
])

type BusyCollectOptions = {
  /** When true, surface a running orchestrator callback (rarely needed for UI). */
  includeBackgroundTask?: boolean
  scope?: LibraryMergeScope
}

const normalizeScope = (scope?: LibraryMergeScope): LibraryMergeScope =>
  scope === 'curated' ? 'curated' : 'full'

/**
 * User-facing busy reasons only. Pending-only key-analysis is intentionally omitted —
 * acquireLibraryMergeMutationLock clears it without prompting.
 */
const collectBusyReasons = (options: BusyCollectOptions = {}): LibraryMergeBusyReason[] => {
  const scope = normalizeScope(options.scope)
  const reasons: LibraryMergeBusyReason[] = []

  const keyActivity = getKeyAnalysisLibraryMergeActivity()
  // Confirm only when analysis is actually running / writing, not when merely queued.
  if (keyActivity.inFlight) {
    reasons.push('key-analysis')
  }

  if (isMetadataAutoFillBusy()) reasons.push('metadata-auto-fill')
  if (isAudioConversionBusy()) reasons.push('audio-conversion')
  if (isPlaylistBatchRenameBusy()) reasons.push('playlist-batch-rename')
  if (isImportSongsBusy()) reasons.push('import')

  // Waveform cache writers touch the library cache DB; cancel when in-flight.
  if (isMixtapeWaveformQueueBusy()) reasons.push('mixtape-waveform')
  if (isMixtapeRawWaveformQueueBusy()) reasons.push('mixtape-raw-waveform')

  // Full merge rewrites mixtape-related tree + files; curated import does not.
  if (scope === 'full') {
    if (isMixtapeStemQueueBusy()) reasons.push('mixtape-stem')
    if (isAnyMixtapeWindowOpen()) reasons.push('mixtape-window')
  }

  // library-tree-watcher is handled silently in acquireLibraryMergeMutationLock
  // (discard debounce + wait for real reconcile/bulk). Never surface as user-facing busy.
  if (isHorizontalBrowseTransportRecordingActive()) reasons.push('recording')

  // Pending orchestrator work is dropped by interruptBackgroundTaskExecution.
  // Only a currently running callback is worth surfacing (and even then we wait,
  // not force-kill). Default probe path keeps this off to avoid noisy prompts.
  if (options.includeBackgroundTask === true) {
    const backgroundStatus = getBackgroundTaskExecutionStatus()
    if (backgroundStatus.running) reasons.push('background-task')
  }

  return reasons
}

export const classifyLibraryMergeBusyReasons = (
  reasons: readonly string[]
): LibraryMergeBusyClassification => {
  const cancellable: LibraryMergeBusyReason[] = []
  const blocking: LibraryMergeBusyReason[] = []
  for (const reason of reasons) {
    const normalized = String(reason || '').trim() as LibraryMergeBusyReason
    if (!normalized) continue
    if (CANCELLABLE_BUSY_REASONS.has(normalized)) {
      if (!cancellable.includes(normalized)) cancellable.push(normalized)
      continue
    }
    if (!blocking.includes(normalized)) blocking.push(normalized)
  }
  return { cancellable, blocking }
}

export const getLibraryMergeBusySnapshot = (
  options: BusyCollectOptions = {}
): LibraryMergeBusyClassification => classifyLibraryMergeBusyReasons(collectBusyReasons(options))

/** Drop queued key-analysis work that has not started writing yet — no user prompt. */
const silentClearPendingOnlyKeyAnalysis = async (): Promise<void> => {
  const activity = getKeyAnalysisLibraryMergeActivity()
  if (activity.any && !activity.inFlight) {
    await cancelAllKeyAnalysisForLibraryMerge()
  }
}

const cancelCancellableBusyTasks = async (
  reasons: readonly LibraryMergeBusyReason[]
): Promise<void> => {
  const reasonSet = new Set(reasons)
  if (reasonSet.has('key-analysis')) {
    await cancelAllKeyAnalysisForLibraryMerge()
  }
  if (reasonSet.has('metadata-auto-fill')) {
    cancelAllMetadataAutoFill()
    const idle = await waitForMetadataAutoFillIdle()
    if (!idle) {
      throw new LibraryMergeError(
        'LIBRARY_BUSY_CANCEL_FAILED',
        '无法及时停止元数据自动补全任务，请稍后再试'
      )
    }
  }
  if (reasonSet.has('mixtape-waveform')) {
    cancelMixtapeWaveformQueueForLibraryMerge()
    const idle = await waitForMixtapeWaveformQueueIdle()
    if (!idle) {
      throw new LibraryMergeError(
        'LIBRARY_BUSY_CANCEL_FAILED',
        '无法及时停止 Mixtape 波形分析任务，请稍后再试'
      )
    }
  }
  if (reasonSet.has('mixtape-raw-waveform')) {
    cancelMixtapeRawWaveformQueueForLibraryMerge()
    const idle = await waitForMixtapeRawWaveformQueueIdle()
    if (!idle) {
      throw new LibraryMergeError(
        'LIBRARY_BUSY_CANCEL_FAILED',
        '无法及时停止 Mixtape 原始波形任务，请稍后再试'
      )
    }
  }
}

export type AcquireLibraryMergeMutationLockOptions = {
  cancelCancellableTasks?: boolean
  scope?: LibraryMergeScope
}

export const acquireLibraryMergeMutationLock = async (
  mainWindow: BrowserWindow | null,
  options: AcquireLibraryMergeMutationLockOptions = {}
): Promise<() => void> => {
  if (isLibraryMergeMutationLocked()) {
    throw new LibraryMergeError('MERGE_ALREADY_ACTIVE', '当前库已有合并任务正在运行')
  }

  const scope = normalizeScope(options.scope)

  // Tree watcher is internal bookkeeping, not a user-facing busy task:
  // drop debounce, wait for real reconcile/bulk, stop the watcher ASAP so new
  // fs events cannot re-arm it, then re-check once for a race that slipped in.
  discardPendingLibraryTreeReconcile()
  let treeIdle = await waitForLibraryTreeWatcherIdle(30000)
  if (!treeIdle) {
    throw new LibraryMergeError('LIBRARY_TREE_BUSY', '库树后台更新尚未完成，请稍后再试')
  }
  stopLibraryTreeWatcher()
  discardPendingLibraryTreeReconcile()
  treeIdle = await waitForLibraryTreeWatcherIdle(5000)
  if (!treeIdle) {
    startLibraryTreeWatcher(mainWindow)
    throw new LibraryMergeError('LIBRARY_TREE_BUSY', '库树后台更新尚未完成，请稍后再试')
  }

  // Drop pending orchestrator work and wait for any running bounded callback.
  const resumeBackgroundTasks = await interruptBackgroundTaskExecution()
  try {
    await waitForAllRecycleBinCacheTransfers()
    // Pending-only analysis queues never need a confirm dialog.
    await silentClearPendingOnlyKeyAnalysis()

    let snapshot = getLibraryMergeBusySnapshot({
      includeBackgroundTask: false,
      scope
    })
    if (snapshot.blocking.length > 0) {
      throw new LibraryMergeError('LIBRARY_BUSY_BLOCKING', '当前库仍有不能自动取消的任务', {
        blocking: snapshot.blocking,
        cancellable: snapshot.cancellable
      })
    }
    if (snapshot.cancellable.length > 0) {
      if (!options.cancelCancellableTasks) {
        throw new LibraryMergeError('LIBRARY_BUSY_CANCELLABLE', '当前库仍有可安全取消的分析任务', {
          blocking: [],
          cancellable: snapshot.cancellable
        })
      }
      await cancelCancellableBusyTasks(snapshot.cancellable)
      snapshot = getLibraryMergeBusySnapshot({
        includeBackgroundTask: false,
        scope
      })
      if (snapshot.blocking.length > 0 || snapshot.cancellable.length > 0) {
        throw new LibraryMergeError(
          'LIBRARY_BUSY_CANCEL_FAILED',
          '已尝试取消分析任务，但当前库仍未完全空闲',
          {
            blocking: snapshot.blocking,
            cancellable: snapshot.cancellable
          }
        )
      }
    }

    // 库写收尾任务（如删歌后的序号整理 + 缓存整表写回）不占合并锁，但会和合并写同一份
    // 缓存。它们只能登记到 mutationGate 的互斥名额上，所以合并必须等它们退出；不能只在
    // 长任务的入口查一次锁——那时合并还没开始，查了也没用。
    //
    // 这一步可能因为「已有合并」而被拒（并发发起的第二个请求），所以必须留在 try 内：
    // 获取失败时同样要把暂停的后台任务与树监听恢复回去，否则一次失败的获取会把库树
    // 更新与后台维护永久停掉。
    const releaseLibraryMergeLock = await acquireLibraryMergeLockAfterMaintenanceIdle()
    let released = false
    return () => {
      if (released) return
      released = true
      releaseLibraryMergeLock()
      resumeBackgroundTasks()
      startLibraryTreeWatcher(mainWindow)
      // 锁已释放：把合并期间被挡下的收尾补跑掉，而不是让它们永久丢失。
      drainDeferredLibraryMaintenance()
    }
  } catch (error) {
    // 「已有合并在跑」时**不能**恢复：暂停的后台执行与「已停止的树监听」是持锁那次获取
    // 维持的静默状态，由它自己的 release 恢复。这里恢复会把状态提前解除，让后台任务和
    // 库树核对在合并期间重新抢库——正是停它们要防的事。
    const heldByAnotherMerge =
      error instanceof LibraryMergeError && error.code === 'MERGE_ALREADY_ACTIVE'
    if (!heldByAnotherMerge) {
      resumeBackgroundTasks()
      startLibraryTreeWatcher(mainWindow)
    }
    throw error
  }
}

export const assertLibraryMergeMutationAllowed = (): void => {
  if (isLibraryMergeMutationLocked()) {
    throw new LibraryMergeError('LIBRARY_MERGE_IN_PROGRESS', '正在合并音乐库，暂时不能修改当前库')
  }
}
