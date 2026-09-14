import fs from 'fs-extra'
import store from '../../store'
import { persistSettingConfig } from '../../settingsPersistence'
import { closeLibraryDb } from '../../libraryDb'
import {
  discardPendingLibraryTreeReconcile,
  stopLibraryTreeWatcher,
  waitForLibraryTreeWatcherIdle
} from '../../libraryTreeWatcher'
import { interruptBackgroundTaskExecution } from '../backgroundOrchestrator'
import { waitForAllRecycleBinCacheTransfers } from '../recycleBinCacheTransferQueue'
import {
  cancelAllKeyAnalysisForLibraryMerge,
  getKeyAnalysisLibraryMergeActivity
} from '../keyAnalysisQueue'
import { isLibraryMergeActive } from '../libraryMerge'
import { getLibraryMergeBusySnapshot } from '../libraryMerge/runtime'
import {
  clearLibraryRelocateJournal,
  patchLibraryRelocateJournal,
  readLibraryRelocateJournal
} from './journal'
import {
  collectLibraryInventory,
  hasIncompleteLibraryMergeWork,
  isFrkbLibraryRoot
} from './inventory'
import { previewLibraryRelocate } from './preflight'
import {
  copyLibraryTree,
  removeRelocateDestMarker,
  removeRelocateDirectory,
  renameLibraryRoot,
  verifyLibraryTree
} from './copyTree'
import { pathsEqual } from './paths'
import {
  LibraryRelocateError,
  type LibraryRelocateErrorCode,
  type LibraryRelocateJournal,
  type LibraryRelocatePreview,
  type LibraryRelocateProgress,
  type PendingRelocateInspection
} from './types'

let relocateActive = false
let abortController: AbortController | null = null
let latestProgress: LibraryRelocateProgress | null = null
let enterResolver: (() => void) | null = null
let lastJournalWriteAt = 0

const JOURNAL_WRITE_INTERVAL_MS = 1500

const nowIso = () => new Date().toISOString()

const getSourceRoot = (): string =>
  String(store.databaseDir || store.settingConfig?.databaseUrl || '').trim()

const buildProgress = (
  patch: Partial<LibraryRelocateProgress> &
    Pick<LibraryRelocateProgress, 'phase' | 'sourcePath' | 'destPath'>
): LibraryRelocateProgress => ({
  copiedBytes: 0,
  totalBytes: 0,
  copiedFiles: 0,
  totalFiles: 0,
  currentPath: '',
  sameVolume: false,
  canCancel: patch.phase === 'copying' || patch.phase === 'renaming',
  ...latestProgress,
  ...patch
})

const emitProgress = (
  patch: Partial<LibraryRelocateProgress> &
    Pick<LibraryRelocateProgress, 'phase' | 'sourcePath' | 'destPath'>,
  onProgress?: (progress: LibraryRelocateProgress) => void
) => {
  latestProgress = buildProgress(patch)
  onProgress?.(latestProgress)
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new LibraryRelocateError('CANCELED', '已取消移动音乐库')
  }
}

export const isLibraryRelocateActive = (): boolean => relocateActive

export const getLibraryRelocateProgress = (): LibraryRelocateProgress | null => latestProgress

export const hasPendingLibraryRelocateJournal = async (): Promise<boolean> => {
  const journal = await readLibraryRelocateJournal()
  return !!journal
}

export const inspectPendingLibraryRelocate = async (): Promise<PendingRelocateInspection> => {
  const journal = await readLibraryRelocateJournal()
  if (!journal) return { kind: 'none' }
  const sourceExists = await fs.pathExists(journal.sourcePath)
  const destExists = await fs.pathExists(journal.destPath)
  if (!sourceExists && !destExists) return { kind: 'orphan' }
  if (
    journal.phase === 'switching' ||
    journal.phase === 'deleting-source' ||
    journal.phase === 'source-cleanup-failed'
  ) {
    return { kind: 'auto-finish', journal }
  }
  if (
    journal.phase === 'renaming' &&
    destExists &&
    !sourceExists &&
    (await isFrkbLibraryRoot(journal.destPath))
  ) {
    return { kind: 'auto-finish', journal }
  }
  if (!sourceExists) {
    return { kind: 'abort-only', journal, sourceExists: false, destExists }
  }
  return { kind: 'prompt', journal, sourceExists: true, destExists }
}

export const waitForRelocateUserEnter = (): Promise<void> =>
  new Promise((resolve) => {
    enterResolver = resolve
  })

export const notifyRelocateUserEnter = (): void => {
  enterResolver?.()
  enterResolver = null
}

const switchDatabaseUrl = async (destPath: string): Promise<void> => {
  store.settingConfig.databaseUrl = destPath
  store.databaseDir = destPath
  await persistSettingConfig()
  if (String(process.env.FRKB_DEV_DATABASE_URL || '').trim()) {
    process.env.FRKB_DEV_DATABASE_URL = destPath
  }
}

const flushJournal = async (
  preview: LibraryRelocatePreview,
  patch: Partial<LibraryRelocateJournal>,
  force = false
) => {
  const now = Date.now()
  if (!force && now - lastJournalWriteAt < JOURNAL_WRITE_INTERVAL_MS) return
  lastJournalWriteAt = now
  await patchLibraryRelocateJournal({
    sourcePath: preview.sourcePath,
    destPath: preview.destPath,
    parentPath: preview.parentPath,
    folderName: preview.folderName,
    totalBytes: preview.totalBytes,
    totalFiles: preview.totalFiles,
    sameVolume: preview.sameVolume,
    createdAt: (await readLibraryRelocateJournal())?.createdAt || nowIso(),
    ...patch
  })
}

const quiesceLibraryRuntime = async (): Promise<void> => {
  discardPendingLibraryTreeReconcile()
  const treeIdle = await waitForLibraryTreeWatcherIdle(30000)
  if (!treeIdle) {
    throw new LibraryRelocateError('LIBRARY_BUSY', '库树后台更新尚未完成，请稍后再试')
  }
  stopLibraryTreeWatcher()
  discardPendingLibraryTreeReconcile()
  await interruptBackgroundTaskExecution()
  await waitForAllRecycleBinCacheTransfers()
  const keyActivity = getKeyAnalysisLibraryMergeActivity()
  if (keyActivity.any && !keyActivity.inFlight) {
    await cancelAllKeyAnalysisForLibraryMerge()
  }
  closeLibraryDb()
}

const assertRelocateReady = async (sourcePath: string): Promise<void> => {
  if (relocateActive) {
    throw new LibraryRelocateError('RELOCATE_ACTIVE', '正在移动音乐库')
  }
  if (isLibraryMergeActive()) {
    throw new LibraryRelocateError('MERGE_PENDING', '请先完成或恢复当前的合并库任务')
  }
  if (await hasIncompleteLibraryMergeWork(sourcePath)) {
    throw new LibraryRelocateError('MERGE_PENDING', '检测到未完成的合并库作业，请先完成或恢复')
  }
  const busy = getLibraryMergeBusySnapshot({ includeBackgroundTask: false, scope: 'full' })
  if (busy.blocking.length > 0 || busy.cancellable.length > 0) {
    throw new LibraryRelocateError('LIBRARY_BUSY', '当前仍有进行中的任务，请等待结束后再移动', {
      blocking: busy.blocking,
      cancellable: busy.cancellable
    })
  }
}

export const checkLibraryRelocateReady = async (): Promise<{ sourcePath: string }> => {
  const sourcePath = getSourceRoot()
  if (!sourcePath || !(await fs.pathExists(sourcePath))) {
    throw new LibraryRelocateError('SOURCE_NOT_READY', '当前音乐库尚未打开或不存在')
  }
  if (await readLibraryRelocateJournal()) {
    throw new LibraryRelocateError('RELOCATE_ACTIVE', '有未完成的音乐库移动，请先继续或放弃')
  }
  await assertRelocateReady(sourcePath)
  return { sourcePath }
}

const deleteSourceAfterSwitch = async (
  preview: LibraryRelocatePreview,
  onProgress?: (progress: LibraryRelocateProgress) => void
): Promise<string | null> => {
  emitProgress(
    {
      phase: 'deleting-source',
      sourcePath: preview.sourcePath,
      destPath: preview.destPath,
      sameVolume: preview.sameVolume,
      canCancel: false,
      totalBytes: preview.totalBytes,
      totalFiles: preview.totalFiles,
      copiedBytes: preview.totalBytes,
      copiedFiles: preview.totalFiles
    },
    onProgress
  )
  await flushJournal(preview, { phase: 'deleting-source' }, true)
  if (!(await fs.pathExists(preview.sourcePath))) return null
  if (pathsEqual(preview.sourcePath, preview.destPath)) {
    throw new LibraryRelocateError('SAME_PATH', '源路径与目标路径相同，拒绝删除')
  }
  if (!(await isFrkbLibraryRoot(preview.destPath))) {
    throw new LibraryRelocateError('VERIFY_FAILED', '目标目录不是完整音乐库，拒绝删除旧目录')
  }
  try {
    await removeRelocateDirectory(preview.sourcePath)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error || 'delete failed')
  }
}

const completeRelocate = async (
  preview: LibraryRelocatePreview,
  leftoverSourcePath: string | null,
  leftoverMessage: string | null,
  onProgress?: (progress: LibraryRelocateProgress) => void
) => {
  await removeRelocateDestMarker(preview.destPath)
  await clearLibraryRelocateJournal()
  relocateActive = false
  abortController = null
  if (leftoverSourcePath) {
    emitProgress(
      {
        phase: 'source-cleanup-failed',
        sourcePath: preview.sourcePath,
        destPath: preview.destPath,
        leftoverSourcePath,
        errorCode: 'DELETE_SOURCE_FAILED',
        errorMessage: leftoverMessage || '旧目录删除失败，请手动删除',
        canCancel: false,
        copiedBytes: preview.totalBytes,
        totalBytes: preview.totalBytes,
        copiedFiles: preview.totalFiles,
        totalFiles: preview.totalFiles,
        sameVolume: preview.sameVolume
      },
      onProgress
    )
    return
  }
  emitProgress(
    {
      phase: 'completed',
      sourcePath: preview.sourcePath,
      destPath: preview.destPath,
      canCancel: false,
      copiedBytes: preview.totalBytes,
      totalBytes: preview.totalBytes,
      copiedFiles: preview.totalFiles,
      totalFiles: preview.totalFiles,
      sameVolume: preview.sameVolume
    },
    onProgress
  )
}

const runCopyRelocate = async (
  preview: LibraryRelocatePreview,
  signal: AbortSignal,
  onProgress?: (progress: LibraryRelocateProgress) => void
) => {
  emitProgress(
    {
      phase: 'copying',
      sourcePath: preview.sourcePath,
      destPath: preview.destPath,
      sameVolume: preview.sameVolume,
      totalBytes: preview.totalBytes,
      totalFiles: preview.totalFiles,
      canCancel: true
    },
    onProgress
  )
  await flushJournal(preview, { phase: 'copying', copiedBytes: 0, copiedFiles: 0 }, true)
  const inventory = await collectLibraryInventory(preview.sourcePath)
  preview.totalBytes = inventory.totalBytes
  preview.totalFiles = inventory.files.length
  await copyLibraryTree({
    sourcePath: preview.sourcePath,
    destPath: preview.destPath,
    files: inventory.files,
    signal,
    onProgress: (copiedBytes, copiedFiles, currentPath) => {
      emitProgress(
        {
          phase: 'copying',
          sourcePath: preview.sourcePath,
          destPath: preview.destPath,
          sameVolume: preview.sameVolume,
          copiedBytes,
          copiedFiles,
          currentPath,
          totalBytes: preview.totalBytes,
          totalFiles: preview.totalFiles,
          canCancel: true
        },
        onProgress
      )
      void flushJournal(preview, {
        phase: 'copying',
        copiedBytes,
        copiedFiles,
        totalBytes: preview.totalBytes,
        totalFiles: preview.totalFiles
      })
    }
  })
  throwIfAborted(signal)
  emitProgress(
    {
      phase: 'verifying',
      sourcePath: preview.sourcePath,
      destPath: preview.destPath,
      sameVolume: preview.sameVolume,
      copiedBytes: preview.totalBytes,
      copiedFiles: preview.totalFiles,
      totalBytes: preview.totalBytes,
      totalFiles: preview.totalFiles,
      canCancel: true
    },
    onProgress
  )
  await flushJournal(preview, { phase: 'verifying' }, true)
  await verifyLibraryTree({ sourcePath: preview.sourcePath, destPath: preview.destPath })
  throwIfAborted(signal)
  emitProgress(
    {
      phase: 'switching',
      sourcePath: preview.sourcePath,
      destPath: preview.destPath,
      canCancel: false,
      copiedBytes: preview.totalBytes,
      totalBytes: preview.totalBytes,
      copiedFiles: preview.totalFiles,
      totalFiles: preview.totalFiles,
      sameVolume: preview.sameVolume
    },
    onProgress
  )
  await flushJournal(preview, { phase: 'switching' }, true)
  await switchDatabaseUrl(preview.destPath)
  const leftoverMessage = await deleteSourceAfterSwitch(preview, onProgress)
  await completeRelocate(
    preview,
    leftoverMessage ? preview.sourcePath : null,
    leftoverMessage,
    onProgress
  )
}

const runRenameRelocate = async (
  preview: LibraryRelocatePreview,
  signal: AbortSignal,
  onProgress?: (progress: LibraryRelocateProgress) => void
) => {
  emitProgress(
    {
      phase: 'renaming',
      sourcePath: preview.sourcePath,
      destPath: preview.destPath,
      sameVolume: true,
      totalBytes: preview.totalBytes,
      totalFiles: preview.totalFiles,
      canCancel: true
    },
    onProgress
  )
  await flushJournal(preview, { phase: 'renaming' }, true)
  throwIfAborted(signal)
  await renameLibraryRoot({
    sourcePath: preview.sourcePath,
    destPath: preview.destPath,
    signal
  })
  emitProgress(
    {
      phase: 'switching',
      sourcePath: preview.sourcePath,
      destPath: preview.destPath,
      canCancel: false,
      copiedBytes: preview.totalBytes,
      totalBytes: preview.totalBytes,
      copiedFiles: preview.totalFiles,
      totalFiles: preview.totalFiles,
      sameVolume: true
    },
    onProgress
  )
  await flushJournal(preview, { phase: 'switching' }, true)
  await switchDatabaseUrl(preview.destPath)
  await completeRelocate(preview, null, null, onProgress)
}

export const prepareLibraryRuntimeForRelocate = async (): Promise<void> => {
  await quiesceLibraryRuntime()
}

export const runLibraryRelocate = async (params: {
  preview: LibraryRelocatePreview
  signal?: AbortSignal
  onProgress?: (progress: LibraryRelocateProgress) => void
}): Promise<LibraryRelocateProgress> => {
  const preview = { ...params.preview }
  const signal = params.signal || abortController?.signal
  relocateActive = true
  try {
    if (preview.sameVolume) {
      try {
        await runRenameRelocate(preview, signal || new AbortController().signal, params.onProgress)
        return latestProgress as LibraryRelocateProgress
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '')
            : ''
        if (code !== 'EXDEV') throw error
      }
    }
    await runCopyRelocate(preview, signal || new AbortController().signal, params.onProgress)
    return latestProgress as LibraryRelocateProgress
  } catch (error) {
    if (error instanceof LibraryRelocateError && error.code === 'CANCELED') {
      throw error
    }
    const code: LibraryRelocateErrorCode =
      error instanceof LibraryRelocateError ? error.code : 'COPY_FAILED'
    emitProgress(
      {
        phase: 'failed',
        sourcePath: preview.sourcePath,
        destPath: preview.destPath,
        errorCode: code,
        errorMessage: error instanceof Error ? error.message : String(error || 'unknown error'),
        canCancel: false,
        sameVolume: preview.sameVolume,
        totalBytes: preview.totalBytes,
        totalFiles: preview.totalFiles
      },
      params.onProgress
    )
    throw error
  } finally {
    if (latestProgress?.phase !== 'source-cleanup-failed') {
      relocateActive = latestProgress?.phase === 'failed'
    } else {
      relocateActive = false
    }
  }
}

export const abortLibraryRelocate = async (params?: {
  onProgress?: (progress: LibraryRelocateProgress) => void
}): Promise<{ sourceExists: boolean; destPath: string; sourcePath: string }> => {
  abortController?.abort()
  const journal = await readLibraryRelocateJournal()
  const progress = latestProgress
  const sourcePath = journal?.sourcePath || progress?.sourcePath || getSourceRoot()
  const destPath = journal?.destPath || progress?.destPath || ''
  emitProgress(
    {
      phase: 'cleanup',
      sourcePath,
      destPath,
      canCancel: false,
      sameVolume: journal?.sameVolume === true
    },
    params?.onProgress
  )
  if (
    destPath &&
    sourcePath &&
    !pathsEqual(sourcePath, destPath) &&
    (await fs.pathExists(destPath))
  ) {
    try {
      await removeRelocateDirectory(destPath)
    } catch (error) {
      throw new LibraryRelocateError(
        'COPY_FAILED',
        error instanceof Error ? error.message : '清理不完整的新目录失败'
      )
    }
  }
  await clearLibraryRelocateJournal()
  relocateActive = false
  abortController = null
  const sourceExists = !!sourcePath && (await fs.pathExists(sourcePath))
  latestProgress = null
  return { sourceExists, destPath, sourcePath }
}

export const autoFinishPendingRelocate = async (
  onProgress?: (progress: LibraryRelocateProgress) => void
): Promise<LibraryRelocateProgress> => {
  const journal = await readLibraryRelocateJournal()
  if (!journal) {
    throw new LibraryRelocateError('JOURNAL_INVALID', '没有可恢复的音乐库移动任务')
  }
  relocateActive = true
  abortController = new AbortController()
  const preview: LibraryRelocatePreview = {
    sourcePath: journal.sourcePath,
    destPath: journal.destPath,
    parentPath: journal.parentPath,
    folderName: journal.folderName,
    totalBytes: journal.totalBytes,
    totalFiles: journal.totalFiles,
    sameVolume: journal.sameVolume
  }
  try {
    if (!(await fs.pathExists(preview.destPath)) || !(await isFrkbLibraryRoot(preview.destPath))) {
      throw new LibraryRelocateError('VERIFY_FAILED', '目标音乐库不完整，无法完成收尾')
    }
    if (!pathsEqual(String(store.settingConfig.databaseUrl || ''), preview.destPath)) {
      await switchDatabaseUrl(preview.destPath)
    }
    const leftoverMessage = await deleteSourceAfterSwitch(preview, onProgress)
    await completeRelocate(
      preview,
      leftoverMessage ? preview.sourcePath : null,
      leftoverMessage,
      onProgress
    )
    return latestProgress as LibraryRelocateProgress
  } finally {
    if (latestProgress?.phase !== 'source-cleanup-failed') {
      relocateActive = false
    }
  }
}

export const beginRelocateAbortSignal = (): AbortSignal => {
  abortController?.abort()
  abortController = new AbortController()
  relocateActive = true
  return abortController.signal
}

export const requestRelocateCancel = (): void => {
  abortController?.abort()
}

export const previewFromJournal = async (
  journal: LibraryRelocateJournal
): Promise<LibraryRelocatePreview> =>
  previewLibraryRelocate({
    sourcePath: journal.sourcePath,
    parentPath: journal.parentPath,
    resumeDestPath: journal.destPath
  })

export { previewLibraryRelocate }
export type { LibraryRelocatePreview }

export const toRelocateErrorCode = (error: unknown): LibraryRelocateErrorCode =>
  error instanceof LibraryRelocateError ? error.code : 'COPY_FAILED'

export const toRelocateErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'unknown error')

export const getRelocateBusyDetails = (
  error: unknown
): { blocking: string[]; cancellable: string[] } | null => {
  if (!(error instanceof LibraryRelocateError) || error.code !== 'LIBRARY_BUSY') return null
  const blocking = Array.isArray(error.details?.blocking)
    ? error.details.blocking.map((item) => String(item))
    : []
  const cancellable = Array.isArray(error.details?.cancellable)
    ? error.details.cancellable.map((item) => String(item))
    : []
  return { blocking, cancellable }
}

export const journalToPreview = (journal: LibraryRelocateJournal): LibraryRelocatePreview => ({
  sourcePath: journal.sourcePath,
  destPath: journal.destPath,
  parentPath: journal.parentPath,
  folderName: journal.folderName,
  totalBytes: journal.totalBytes,
  totalFiles: journal.totalFiles,
  sameVolume: journal.sameVolume
})
