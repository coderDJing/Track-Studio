import { app, ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import store from '../store'
import mainWindow from '../window/mainWindow'
import {
  getCoreFsDirName,
  resolveLibraryPath,
  runWithConcurrency,
  waitForUserDecision
} from '../utils'
import {
  getRecycleBinRootAbs,
  moveFileToRecycleBin,
  normalizeRendererPlaylistPath,
  permanentlyDeleteFile,
  resolveRecycleBinRecordAbsPath,
  restoreRecycleBinFile,
  toLibraryRelativePath,
  type RecycleBinMoveResult
} from '../recycleBinService'
import { findLibraryNodeByPath } from '../libraryTreeDb'
import {
  listRecycleBinRecords,
  deleteRecycleBinRecords,
  upsertRecycleBinRecord,
  type RecycleBinRecord
} from '../recycleBinDb'
import { scanSongList as svcScanSongList } from '../services/scanSongs'
import { RECYCLE_BIN_UUID } from '../../shared/recycleBin'
import {
  RECORDING_LIBRARY_CHANGED_EVENT,
  RECORDING_LIBRARY_UUID
} from '../../shared/recordingLibrary'
import { getLibraryDb, type SqliteDatabase } from '../libraryDb'
import { getLibraryStemCacheRootAbs } from '../services/libraryStemAssetStorage'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import { waitForPlaybackForegroundIdle } from '../services/playbackForegroundActivity'
import { beginLibraryTreeWatcherBulkOperation } from '../libraryTreeWatcher'
import {
  scheduleCuratedLibrarySyncAfterLocalChange,
  scheduleCuratedLibrarySyncIfUnderCurated
} from '../cloudSyncScheduler'
import { getCuratedLibraryAbsRoot, isPathInside } from '../curatedLibrarySync/paths'
import {
  getRecordingLibraryRootAbs,
  hasRecordings,
  isInRecordingLibraryAbsPath
} from '../recordingLibraryService'
import {
  appendSongListTrackNumbers,
  compactSongListTrackNumbers,
  compactSongListTrackNumbersByFilePaths,
  isSupportedPlaylistTrackNumberListRoot
} from '../services/playlistTrackNumbers'
import { protectSetReferencedFilesForDeletion } from './setListHandlers'
import { assertLibraryMergeMutationAllowed } from '../services/libraryMerge/runtime'

const DIRTY_DATA_SQL_TABLES = [
  'song_cache',
  'cover_index',
  'waveform_cache',
  'compact_visual_waveform_cache',
  'unified_display_waveform_cache',
  'waveform_surface_cache',
  'pioneer_preview_waveform_cache',
  // 歌单视图快照也是纯派生缓存：清脏数据后不一起删，下次打开歌单还会命中旧快照，
  // 用户点了"清理"却看到和清理前一样的列表。删掉即可，下次扫描会重新落一份。
  'playlist_view_snapshot',
  'external_analysis_devices',
  'external_analysis_cache',
  'mixtape_items',
  'mixtape_projects',
  'mixtape_stem_assets',
  'library_stem_assets',
  'mixtape_waveform_cache',
  'mixtape_raw_waveform_cache',
  'mixtape_stem_waveform_cache'
] as const

const DELETE_SONGS_BATCH_CONCURRENCY = 4
const DELETE_SONGS_BATCH_YIELD_EVERY = 1

type DirtyDataSqlSummary = {
  removedRows: number
  removedByTable: Record<string, number>
  missingTables: string[]
}

type DirtyDataPathSummary = {
  removedCount: number
  removedPaths: string[]
}

type ErrorWithCode = Error & {
  code?: string
}

type RestoreProgressPayload = {
  id: string
  titleKey?: string
  now?: number
  total?: number
  isInitial?: boolean
  noProgress?: boolean
  dismiss?: boolean
}

const sendRestoreProgress = (payload: RestoreProgressPayload) => {
  mainWindow.instance?.webContents.send('progressSet', payload)
}

const getErrorCode = (error: ErrorWithCode): string => String(error.code || '').trim()

const isRecycleBinMoveResult = (value: unknown): value is RecycleBinMoveResult =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof Reflect.get(value, 'status') === 'string' &&
  typeof Reflect.get(value, 'srcPath') === 'string'

function clearDirtyDataSqlTables(db: SqliteDatabase): DirtyDataSqlSummary {
  const removedByTable: Record<string, number> = {}
  const missingTables: string[] = []
  let removedRows = 0
  const existingRows = db
    .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
  const existingTableSet = new Set(existingRows.map((row) => String(row.name)))
  const runDelete = db.transaction(() => {
    for (const table of DIRTY_DATA_SQL_TABLES) {
      if (!existingTableSet.has(table)) {
        missingTables.push(table)
        removedByTable[table] = 0
        continue
      }
      const info = db.prepare(`DELETE FROM ${table}`).run()
      const changes = Number(info?.changes || 0)
      removedByTable[table] = changes
      removedRows += changes
    }
  })
  runDelete()
  return {
    removedRows,
    removedByTable,
    missingTables
  }
}

async function collectLibraryDirtyCacheTargets(libraryRoot: string): Promise<string[]> {
  if (!libraryRoot || !(await fs.pathExists(libraryRoot))) return []
  const targets: string[] = []
  const queue: string[] = [libraryRoot]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isFile() && entry.name === '.songs.cache.json') {
        targets.push(fullPath)
        continue
      }
      if (!entry.isDirectory()) continue
      if (entry.name === '.frkb_covers') {
        targets.push(fullPath)
        continue
      }
      if (entry.name.startsWith('.')) continue
      queue.push(fullPath)
    }
  }
  return targets
}

async function removeExistingPaths(paths: string[]): Promise<DirtyDataPathSummary> {
  const removedPaths: string[] = []
  const uniquePaths = Array.from(new Set(paths.filter((item) => !!item)))
  for (const item of uniquePaths) {
    try {
      if (!(await fs.pathExists(item))) continue
      await fs.remove(item)
      removedPaths.push(item)
    } catch {}
  }
  return {
    removedCount: removedPaths.length,
    removedPaths
  }
}

function normalizeAudioExtensions(input?: string[]): Set<string> {
  const result = new Set<string>()
  if (!Array.isArray(input)) return result
  for (const raw of input) {
    if (!raw) continue
    let ext = String(raw).trim().toLowerCase()
    if (!ext) continue
    if (!ext.startsWith('.')) ext = `.${ext}`
    result.add(ext)
  }
  return result
}

export function registerLibraryMaintenanceHandlers() {
  const executeDelSongs = async (
    payload: { filePaths: string[]; songListPath?: string; sourceType?: string } | string[]
  ) => {
    assertLibraryMergeMutationAllowed()
    const filePaths = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.filePaths)
        ? payload.filePaths
        : []
    if (!filePaths.length) {
      return {
        total: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        hasENOSPC: false,
        removedPaths: [] as string[]
      }
    }
    const originalPlaylistPath =
      payload && !Array.isArray(payload) && payload.songListPath
        ? normalizeRendererPlaylistPath(payload.songListPath)
        : null
    const sourceSongListRoot =
      payload && !Array.isArray(payload) && payload.songListPath
        ? resolveLibraryPath(payload.songListPath).absPath
        : ''
    const sourceType =
      payload && !Array.isArray(payload) && payload.sourceType ? payload.sourceType : null
    const uniquePaths = Array.from(new Set(filePaths.filter(Boolean)))
    const setProtection = await protectSetReferencedFilesForDeletion(uniquePaths)
    const protectedMovedPaths = setProtection.protectedFiles
      .filter((item) => item.success)
      .map((item) => item.filePath)
    const protectedFailedCount = setProtection.protectedFiles.filter((item) => !item.success).length
    const protectedHandledCount = setProtection.protectedFiles.length
    const tasks: Array<() => Promise<RecycleBinMoveResult>> = []
    for (const item of setProtection.unprotectedFiles) {
      tasks.push(async () => {
        await waitForPlaybackForegroundIdle('delSongs:task-start', {
          filePath: item
        })
        const result = await moveFileToRecycleBin(item, {
          originalPlaylistPath,
          sourceType
        })
        if (result.status === 'failed') {
          throw new Error(result.error || 'move to recycle bin failed')
        }
        return result
      })
    }
    const batchId = `delSongs_${Date.now()}`
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'library.deleteProgressRemoving',
        now: protectedHandledCount,
        total: uniquePaths.length,
        isInitial: true
      })
    }
    const releaseLibraryTreeWatcherBulk = beginLibraryTreeWatcherBulkOperation()
    const { success, failed, hasENOSPC, skipped, results } = await (async () => {
      try {
        return await runWithConcurrency(tasks, {
          concurrency: DELETE_SONGS_BATCH_CONCURRENCY,
          yieldEvery: DELETE_SONGS_BATCH_YIELD_EVERY,
          onProgress: (done, total) => {
            if (mainWindow.instance) {
              mainWindow.instance.webContents.send('progressSet', {
                id: batchId,
                titleKey: 'library.deleteProgressRemoving',
                now: protectedHandledCount + done,
                total: protectedHandledCount + total
              })
            }
          },
          stopOnENOSPC: true,
          onInterrupted: async (interruptPayload) =>
            waitForUserDecision(mainWindow.instance ?? null, batchId, 'delSongs', interruptPayload)
        })
      } finally {
        releaseLibraryTreeWatcherBulk()
      }
    })()
    if (hasENOSPC && mainWindow.instance) {
      mainWindow.instance.webContents.send('file-batch-summary', {
        context: 'delSongs',
        total: uniquePaths.length,
        success: success + protectedMovedPaths.length,
        failed: failed + protectedFailedCount,
        hasENOSPC,
        skipped,
        errorSamples: results
          .map((r, i) =>
            r instanceof Error ? { code: getErrorCode(r), message: r.message, index: i } : null
          )
          .filter(Boolean)
          .slice(0, 3)
      })
    }
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'library.deleteProgressRemoving',
        now: uniquePaths.length,
        total: uniquePaths.length
      })
    }
    const removedPaths = results
      .filter(
        (item): item is RecycleBinMoveResult =>
          !(item instanceof Error) && isRecycleBinMoveResult(item)
      )
      .map((item) => item.srcPath)
      .concat(protectedMovedPaths)
    if (removedPaths.length > 0) {
      let compacted = false
      if (sourceSongListRoot) {
        if (isSupportedPlaylistTrackNumberListRoot(sourceSongListRoot)) {
          await compactSongListTrackNumbers(sourceSongListRoot)
          compacted = true
        }
      } else {
        const compactResult = await compactSongListTrackNumbersByFilePaths(removedPaths)
        compacted = compactResult.roots > 0
      }
      if (compacted) {
        markGlobalSongSearchDirty('delSongs')
      }
      if (removedPaths.some((item) => isPathInside(item, getCuratedLibraryAbsRoot()))) {
        scheduleCuratedLibrarySyncAfterLocalChange()
      }
      if (removedPaths.some((item) => isInRecordingLibraryAbsPath(item))) {
        mainWindow.instance?.webContents.send(RECORDING_LIBRARY_CHANGED_EVENT, {
          hasRecordings: await hasRecordings()
        })
      }
    }
    return {
      total: uniquePaths.length,
      success: success + protectedMovedPaths.length,
      failed: failed + protectedFailedCount,
      skipped,
      hasENOSPC,
      removedPaths,
      protectedFiles: setProtection.protectedFiles
    }
  }

  ipcMain.on(
    'delSongs',
    async (
      _e,
      payload: { filePaths: string[]; songListPath?: string; sourceType?: string } | string[]
    ) => {
      await executeDelSongs(payload)
    }
  )

  ipcMain.handle(
    'delSongsAwaitable',
    async (
      _e,
      payload: { filePaths: string[]; songListPath?: string; sourceType?: string } | string[]
    ) => {
      try {
        return await executeDelSongs(payload)
      } catch {
        return {
          total: 0,
          success: 0,
          failed: 0,
          removedPaths: []
        }
      }
    }
  )

  ipcMain.handle('permanentlyDelSongs', async (_e, songFilePaths: string[]) => {
    assertLibraryMergeMutationAllowed()
    const uniquePaths = Array.isArray(songFilePaths)
      ? Array.from(new Set(songFilePaths.filter(Boolean)))
      : []
    if (uniquePaths.length === 0) {
      return {
        total: 0,
        success: 0,
        failed: 0,
        removedPaths: []
      }
    }
    try {
      const tasks = uniquePaths.map((item) => async () => {
        const ok = await permanentlyDeleteFile(item)
        if (!ok) {
          throw new Error('delete failed')
        }
        return item
      })
      const batchId = `permanentlyDelSongs_${Date.now()}`
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('progressSet', {
          id: batchId,
          titleKey: 'recycleBin.progressDeleting',
          now: 0,
          total: tasks.length,
          isInitial: true
        })
      }
      const { results, success, failed } = await runWithConcurrency(tasks, {
        concurrency: 16,
        onProgress: (done, total) => {
          if (mainWindow.instance) {
            mainWindow.instance.webContents.send('progressSet', {
              id: batchId,
              titleKey: 'recycleBin.progressDeleting',
              now: done,
              total
            })
          }
        }
      })
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('progressSet', {
          id: batchId,
          titleKey: 'recycleBin.progressDeleting',
          now: tasks.length,
          total: tasks.length
        })
      }
      const removedPaths = results
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item)
      return {
        total: results.length,
        success,
        failed,
        removedPaths
      }
    } catch {
      return {
        total: uniquePaths.length,
        success: 0,
        failed: uniquePaths.length,
        removedPaths: []
      }
    }
  })

  ipcMain.handle('recycleBin:list', async () => {
    assertLibraryMergeMutationAllowed()
    const records = listRecycleBinRecords()
    const recordMap = new Map(records.map((r) => [r.filePath, r]))
    const rootDir = store.databaseDir
    if (!rootDir) {
      return { scanData: [], songListUUID: RECYCLE_BIN_UUID }
    }
    const recycleRoot = getRecycleBinRootAbs()
    const recycleRootExists = recycleRoot ? await fs.pathExists(recycleRoot) : false
    if (recycleRootExists && recycleRoot) {
      const audioExts = normalizeAudioExtensions(store.settingConfig?.audioExt || [])
      let entries: fs.Dirent[] = []
      try {
        entries = await fs.readdir(recycleRoot, { withFileTypes: true })
      } catch {
        entries = []
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const ext = path.extname(entry.name).toLowerCase()
        if (!audioExts.has(ext)) continue
        const absPath = path.join(recycleRoot, entry.name)
        const rel = toLibraryRelativePath(absPath)
        if (!rel || recordMap.has(rel)) continue
        const stat = await fs.stat(absPath).catch(() => null)
        const deletedAtMs = stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : Date.now()
        const newRecord = {
          filePath: rel,
          deletedAtMs,
          originalPlaylistPath: null,
          originalFileName: entry.name,
          sourceType: null
        }
        upsertRecycleBinRecord(newRecord)
        records.push(newRecord)
        recordMap.set(rel, newRecord)
      }
    }
    const existing: Array<{ record: RecycleBinRecord; absPath: string }> = []
    const missingRecords: string[] = []
    for (const record of records) {
      const absPath = resolveRecycleBinRecordAbsPath(record.filePath)
      if (!absPath || !(await fs.pathExists(absPath))) {
        missingRecords.push(record.filePath)
      } else {
        existing.push({ record, absPath })
      }
    }
    if (missingRecords.length > 0) {
      deleteRecycleBinRecords(missingRecords)
    }
    const filePaths = existing.map((item) => item.absPath)
    const scanTarget = recycleRootExists && recycleRoot ? recycleRoot : filePaths
    if (Array.isArray(scanTarget) && scanTarget.length === 0) {
      return { scanData: [], songListUUID: RECYCLE_BIN_UUID }
    }
    const { scanData } = await svcScanSongList(
      scanTarget,
      store.settingConfig.audioExt,
      RECYCLE_BIN_UUID
    )
    const recordByPath = new Map<string, RecycleBinRecord>()
    for (const item of existing) {
      recordByPath.set(path.resolve(item.absPath), item.record)
    }
    const merged = scanData.map((song) => {
      const record = recordByPath.get(path.resolve(song.filePath))
      if (!record) return song
      return {
        ...song,
        deletedAtMs: record.deletedAtMs,
        originalPlaylistPath: record.originalPlaylistPath ?? null,
        recycleBinSourceType: record.sourceType ?? null
      }
    })
    return { scanData: merged, songListUUID: RECYCLE_BIN_UUID }
  })

  ipcMain.handle('recordingLibrary:list', async () => {
    const recordingRoot = getRecordingLibraryRootAbs()
    if (!recordingRoot || !(await fs.pathExists(recordingRoot))) {
      return { scanData: [], songListUUID: RECORDING_LIBRARY_UUID }
    }
    const { scanData } = await svcScanSongList(recordingRoot, ['.wav'], RECORDING_LIBRARY_UUID, {
      enablePostScanTasks: false
    })
    return { scanData, songListUUID: RECORDING_LIBRARY_UUID }
  })

  ipcMain.handle('recordingLibrary:has-recordings', async () => {
    return await hasRecordings()
  })

  ipcMain.handle('recycleBin:restore', async (_e, payload: { filePaths?: string[] } | string[]) => {
    assertLibraryMergeMutationAllowed()
    const filePaths = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.filePaths)
        ? payload.filePaths
        : []
    const rootDir = store.databaseDir
    const uniquePaths = Array.from(new Set(filePaths.filter(Boolean)))
    if (uniquePaths.length === 0) {
      return {
        total: 0,
        restored: 0,
        missingPlaylist: 0,
        missingRecord: 0,
        missingFile: 0,
        failed: 0,
        removedPaths: [],
        playlistUuids: []
      }
    }
    const progressId = `recycle_bin_restore_${Date.now()}`
    sendRestoreProgress({
      id: progressId,
      titleKey: 'recycleBin.restoreProgressRestoring',
      now: 0,
      total: uniquePaths.length,
      isInitial: true,
      noProgress: false
    })
    try {
      const tasks = uniquePaths.map((filePath) => async () => {
        return await restoreRecycleBinFile(filePath)
      })
      const { results } = await runWithConcurrency(tasks, {
        concurrency: 8,
        onProgress: (done: number, total: number) => {
          sendRestoreProgress({
            id: progressId,
            titleKey: 'recycleBin.restoreProgressRestoring',
            now: done,
            total,
            noProgress: false
          })
        }
      })
      let restored = 0
      let missingPlaylist = 0
      let missingRecord = 0
      let missingFile = 0
      let failed = 0
      const removedPaths: string[] = []
      const playlistUuids = new Set<string>()
      for (const res of results) {
        if (res instanceof Error || !res) {
          failed += 1
          continue
        }
        if (res.status === 'restored') {
          restored += 1
          removedPaths.push(res.srcPath)
          if (res.playlistPath) {
            const node = findLibraryNodeByPath(path.join('library', res.playlistPath))
            if (node?.uuid) playlistUuids.add(node.uuid)
          }
          continue
        }
        if (res.status === 'missing_playlist') {
          missingPlaylist += 1
          continue
        }
        if (res.status === 'missing_record') {
          missingRecord += 1
          continue
        }
        if (res.status === 'missing_file') {
          missingFile += 1
          removedPaths.push(res.srcPath)
          continue
        }
        if (res.status === 'failed') {
          failed += 1
        }
      }
      if (restored > 0) {
        const restoredByPlaylist = new Map<string, string[]>()
        for (const res of results) {
          if (res instanceof Error || !res || res.status !== 'restored') continue
          const playlistPath = String(res.playlistPath || '').trim()
          const destPath = String(res.destPath || '').trim()
          if (!playlistPath || !destPath) continue
          const list = restoredByPlaylist.get(playlistPath) || []
          list.push(destPath)
          restoredByPlaylist.set(playlistPath, list)
        }
        for (const [playlistPath, destPaths] of restoredByPlaylist) {
          const playlistRoot = path.join(rootDir, playlistPath)
          if (!isSupportedPlaylistTrackNumberListRoot(playlistRoot)) continue
          await appendSongListTrackNumbers({
            listRoot: playlistRoot,
            appendedFilePaths: destPaths
          })
        }
        markGlobalSongSearchDirty('recycleBin:restore')
        scheduleCuratedLibrarySyncIfUnderCurated([...restoredByPlaylist.values()].flat())
      }
      return {
        total: uniquePaths.length,
        restored,
        missingPlaylist,
        missingRecord,
        missingFile,
        failed,
        removedPaths,
        playlistUuids: Array.from(playlistUuids)
      }
    } finally {
      sendRestoreProgress({
        id: progressId,
        dismiss: true
      })
    }
  })

  ipcMain.handle('dirPathExists', async (_e, targetPath: string) => {
    try {
      const { mappedPath, absPath } = resolveLibraryPath(targetPath)
      if (!(await fs.pathExists(absPath))) return false
      const node = findLibraryNodeByPath(mappedPath)
      const validTypes = ['root', 'library', 'dir', 'songList', 'mixtapeList', 'setList']
      return !!(node && validTypes.includes(node.nodeType))
    } catch {
      return false
    }
  })

  ipcMain.handle('library:clear-dirty-data', async () => {
    assertLibraryMergeMutationAllowed()
    const dbRoot = store.databaseDir
    if (!dbRoot) {
      throw new Error('databaseDir is empty')
    }
    const db = getLibraryDb()
    if (!db) {
      throw new Error('library db unavailable')
    }
    const database = clearDirtyDataSqlTables(db)

    const libraryRoot = path.join(dbRoot, 'library')
    const mixtapeVaultPath = path.join(
      libraryRoot,
      getCoreFsDirName('MixtapeLibrary'),
      '.mixtape_vault'
    )
    const libraryStemCachePath = getLibraryStemCacheRootAbs()
    const libraryDirtyTargets = await collectLibraryDirtyCacheTargets(libraryRoot)
    libraryDirtyTargets.push(mixtapeVaultPath)
    if (libraryStemCachePath) {
      libraryDirtyTargets.push(libraryStemCachePath)
    }
    const libraryCache = await removeExistingPaths(libraryDirtyTargets)

    const userDataRoot = app.getPath('userData')
    const userDataCache = await removeExistingPaths([
      path.join(userDataRoot, 'stems'),
      path.join(userDataRoot, 'cache', 'musicbrainz'),
      path.join(userDataRoot, 'fingerprintCache.json'),
      path.join(userDataRoot, 'waveforms', 'mixxx-waveform-v1')
    ])

    return {
      success: true,
      database,
      libraryCache,
      userDataCache
    }
  })
}
