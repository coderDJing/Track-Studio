import path = require('node:path')
import type { BrowserWindow } from 'electron'
import store from '../store'
import { log } from '../log'
import { getCoreFsDirName } from '../utils'
import { findLibraryNodeByPath, removeLibraryNodesByParentUuid } from '../libraryTreeDb'
import { getRecycleBinRootAbs, permanentlyDeleteFile } from '../recycleBinService'
import {
  deleteRecycleBinRecords,
  listRecycleBinRecords,
  type RecycleBinRecord
} from '../recycleBinDb'
import { listMixtapeFilePathsInUse } from '../mixtapeDb'
import { cancelKeyAnalysisForPaths } from './keyAnalysisQueue'
import {
  deleteRecycleBinEntriesOffMainThread,
  removeRecycleBinDirectoriesOffMainThread,
  scanRecycleBinOffMainThread,
  type RecycleBinDeleteEntry
} from './recycleBinDeleteWorker'

export const RECYCLE_BIN_EMPTY_COMPLETED_CHANNEL = 'recycle-bin:empty-completed'

export type RecycleBinDeleteSummary = {
  total: number
  success: number
  failed: number
  removedPaths: string[]
}

export type RecycleBinEmptyJobStart = {
  accepted: boolean
  jobId: string
}

type PreparedRecord = {
  record: RecycleBinRecord
  recordKey: string
  legacyPath: string | null
}

type ProgressSender = (payload: Record<string, unknown>) => void

let activeJobId = ''

const normalizePathKey = (value: string) => {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const emptySummary = (): RecycleBinDeleteSummary => ({
  total: 0,
  success: 0,
  failed: 0,
  removedPaths: []
})

const sendCompletion = (
  getWindow: () => BrowserWindow | null,
  jobId: string,
  summary: RecycleBinDeleteSummary
) => {
  const window = getWindow()
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(RECYCLE_BIN_EMPTY_COMPLETED_CHANNEL, { jobId, summary })
}

const runRecycleBinEmptyJob = async (
  progressId: string,
  sendProgress: ProgressSender
): Promise<RecycleBinDeleteSummary> => {
  const recycleBinPath = getRecycleBinRootAbs()
  if (!recycleBinPath) return emptySummary()

  let total = 0
  let success = 0
  const removedPaths: string[] = []
  try {
    sendProgress({
      id: progressId,
      titleKey: 'recycleBin.progressScanning',
      now: 0,
      total: 0,
      isInitial: true,
      noProgress: true
    })
    const initialScan = await scanRecycleBinOffMainThread(recycleBinPath)
    if (!initialScan.rootExists) {
      sendProgress({
        id: progressId,
        titleKey: 'recycleBin.progressFinished',
        now: 1,
        total: 1
      })
      return emptySummary()
    }
    const filePaths = initialScan.filePaths
    total = filePaths.length
    if (total > 0) {
      sendProgress({
        id: progressId,
        titleKey: 'recycleBin.progressDeleting',
        now: 0,
        total,
        noProgress: false
      })
    }

    const libraryRoot = path.join(store.databaseDir, 'library')
    const records = listRecycleBinRecords()
    const recordByAbsPath = new Map<string, PreparedRecord>()
    const referenceCandidates = [...filePaths]
    for (const record of records) {
      const absPath = path.isAbsolute(record.filePath)
        ? record.filePath
        : path.join(libraryRoot, record.filePath)
      const legacyPath =
        record.originalPlaylistPath && record.originalFileName
          ? path.join(libraryRoot, record.originalPlaylistPath, record.originalFileName)
          : null
      recordByAbsPath.set(normalizePathKey(absPath), {
        record,
        recordKey: record.filePath,
        legacyPath
      })
      if (legacyPath) referenceCandidates.push(legacyPath)
    }

    const referencedPathKeys = new Set(
      listMixtapeFilePathsInUse(referenceCandidates).map(normalizePathKey)
    )
    const recordKeyByFilePath = new Map<string, string>()
    const ordinaryEntries: RecycleBinDeleteEntry[] = []
    const referencedEntries: Array<{
      filePath: string
      prepared?: PreparedRecord
      referencedMixtapePath: string
    }> = []

    for (const filePath of filePaths) {
      const filePathKey = normalizePathKey(filePath)
      const prepared = recordByAbsPath.get(filePathKey)
      if (prepared) recordKeyByFilePath.set(filePathKey, prepared.recordKey)
      const referencedMixtapePath = referencedPathKeys.has(filePathKey)
        ? filePath
        : prepared?.legacyPath && referencedPathKeys.has(normalizePathKey(prepared.legacyPath))
          ? prepared.legacyPath
          : null
      if (referencedMixtapePath) {
        referencedEntries.push({ filePath, prepared, referencedMixtapePath })
      } else {
        ordinaryEntries.push({
          filePath,
          listRoot: recycleBinPath,
          originalPath: prepared?.legacyPath,
          originalListRoot: prepared?.legacyPath ? path.dirname(prepared.legacyPath) : null
        })
      }
    }

    if (ordinaryEntries.length > 0) {
      await cancelKeyAnalysisForPaths(ordinaryEntries.map((entry) => entry.filePath))
    }
    const ordinaryResults = await deleteRecycleBinEntriesOffMainThread(
      store.databaseDir,
      ordinaryEntries,
      (completed) => {
        sendProgress({
          id: progressId,
          titleKey: 'recycleBin.progressDeleting',
          now: completed,
          total,
          noProgress: false
        })
      }
    )
    success = 0
    for (const result of ordinaryResults) {
      if (!result.success) continue
      success += 1
      removedPaths.push(result.filePath)
    }

    let processed = ordinaryEntries.length
    for (const entry of referencedEntries) {
      const deleted = await permanentlyDeleteFile(entry.filePath, {
        recordLookup: entry.prepared
          ? { record: entry.prepared.record, recordKey: entry.prepared.recordKey }
          : { record: null, recordKey: null },
        referencedMixtapePath: entry.referencedMixtapePath,
        deferRecordDelete: true
      })
      if (deleted) {
        success += 1
        removedPaths.push(entry.filePath)
      }
      processed += 1
      sendProgress({
        id: progressId,
        titleKey: 'recycleBin.progressDeleting',
        now: processed,
        total,
        noProgress: false
      })
    }

    const removedRecordKeys = removedPaths
      .map((filePath) => recordKeyByFilePath.get(normalizePathKey(filePath)))
      .filter((recordKey): recordKey is string => typeof recordKey === 'string')
    if (removedRecordKeys.length > 0) deleteRecycleBinRecords(removedRecordKeys)

    await removeRecycleBinDirectoriesOffMainThread(initialScan.directories)
    const remainingScan = await scanRecycleBinOffMainThread(recycleBinPath)
    const remainingPathKeys = new Set(remainingScan.filePaths.map(normalizePathKey))
    const missingRecords = records
      .filter((record) => {
        const absPath = path.isAbsolute(record.filePath)
          ? record.filePath
          : path.join(libraryRoot, record.filePath)
        return !remainingPathKeys.has(normalizePathKey(absPath))
      })
      .map((record) => record.filePath)
    if (missingRecords.length > 0) deleteRecycleBinRecords(missingRecords)

    const audioExtensions = new Set(
      (store.settingConfig.audioExt || []).map((extension) =>
        extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
      )
    )
    const hasAudioFiles = remainingScan.filePaths.some((filePath) =>
      audioExtensions.has(path.extname(filePath).toLowerCase())
    )
    if (!hasAudioFiles) {
      const parentNode = findLibraryNodeByPath(path.join('library', getCoreFsDirName('RecycleBin')))
      if (parentNode) removeLibraryNodesByParentUuid(parentNode.uuid)
    }

    const failed = Math.max(0, total - success)
    sendProgress({
      id: progressId,
      titleKey: failed === 0 ? 'recycleBin.progressFinished' : 'recycleBin.progressFailed',
      now: 1,
      total: 1
    })
    return { total, success, failed, removedPaths }
  } catch (error) {
    const failed = Math.max(0, total - success)
    sendProgress({
      id: progressId,
      titleKey: 'recycleBin.progressFailed',
      now: 1,
      total: 1
    })
    log.error('清空回收站后台任务失败:', error)
    return { total, success, failed, removedPaths }
  }
}

export function startRecycleBinEmptyTask(
  getWindow: () => BrowserWindow | null,
  sendProgress: ProgressSender
): RecycleBinEmptyJobStart {
  if (activeJobId) return { accepted: false, jobId: activeJobId }
  const jobId = `recycle_bin_empty_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
  activeJobId = jobId
  setImmediate(() => {
    const finish = (summary: RecycleBinDeleteSummary) => {
      if (activeJobId === jobId) activeJobId = ''
      sendCompletion(getWindow, jobId, summary)
    }
    void runRecycleBinEmptyJob(jobId, sendProgress).then(finish, (error) => {
      log.error('清空回收站后台任务异常退出:', error)
      finish(emptySummary())
    })
  })
  return { accepted: true, jobId }
}
