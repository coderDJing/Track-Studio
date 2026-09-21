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
  upsertRecycleBinRecords,
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
import {
  runPlaybackAwareBackgroundFileIo,
  waitForPlaybackForegroundIdle
} from '../services/playbackForegroundActivity'
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
import {
  assertLibraryMergeMutationAllowed,
  deferLibraryMaintenanceAfterMergeLockReleased,
  tryBeginLibraryMaintenanceMutation
} from '../services/libraryMerge/runtime'
import { beginPlaylistViewSnapshotMutationByPaths } from '../services/playlistViewSnapshotService'

export const RECYCLE_BIN_BACKGROUND_DELETE_COMPLETED_CHANNEL =
  'recycle-bin:background-delete-completed'

let activeRecycleBinBackgroundDeleteJobId = ''

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
/**
 * 推迟落库的回收站记录攒够这么多条就先提交一次。
 *
 * 记录推迟到批次结束才写，好处是整批只提交一次；代价是文件已经移走、记录还没落库的窗口
 * 从"单文件几毫秒"拉长到"整批几秒"。这期间主进程被强杀 / 掉电，回收站目录里就会留下
 * 查不到记录的孤儿文件。按条数分批提交把这个窗口压回秒级以内，同时保留绝大部分批量收益。
 */
const DELETED_SONGS_RECYCLE_BIN_FLUSH_BATCH = 32

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

const DEL_SONGS_POST_DELETE_TASK = 'delSongs:post-delete-compact'

/**
 * 排一次删歌收尾：走后台文件 I/O 通道（先等播放让路、再排队等 I/O 槽位），IPC 只等到
 * 文件搬完就返回。真正的互斥登记在通道里开跑之后才做，排队期间不会挡住合并。
 */
function scheduleDelSongsPostDeleteMaintenance(
  removedPaths: string[],
  sourceSongListRoot: string
): void {
  void runPlaybackAwareBackgroundFileIo(
    DEL_SONGS_POST_DELETE_TASK,
    { count: removedPaths.length, songListRoot: sourceSongListRoot },
    () => runDelSongsPostDeleteMaintenance(removedPaths, sourceSongListRoot),
    { priority: 'background' }
  ).catch(() => {})
}

/**
 * 删歌后的收尾：序号整理 → 全局搜索置脏 → 触发云库同步 → 通知录音库变更。
 *
 * 由 `runPlaybackAwareBackgroundFileIo` 在后台通道里调用，不再挂在 `delSongsAwaitable` 的
 * await 上。收尾会写 song_cache 等库内缓存，必须和音乐库合并互斥，而现在它既可能跑在
 * IPC 返回之后、也可能跑在合并开始之后，所以不能只在入口查一次锁：
 *  - 查锁通过之后合并才拿到锁 → 收尾会与合并并发写同一份缓存；
 *  - 查锁时合并已在跑 → 直接 return 等于把这次的序号整理 / 云同步彻底丢掉。
 * 因此改为向 `tryBeginLibraryMaintenanceMutation()` 登记：登记成功即让合并上锁时必须先等
 * 我们退出；登记不上则挂到合并释放锁之后的补跑队列（见 drainDeferredLibraryMaintenance）。
 */
async function runDelSongsPostDeleteMaintenance(
  removedPaths: string[],
  sourceSongListRoot: string
): Promise<void> {
  const releaseMaintenanceMutation = tryBeginLibraryMaintenanceMutation()
  if (!releaseMaintenanceMutation) {
    deferLibraryMaintenanceAfterMergeLockReleased(DEL_SONGS_POST_DELETE_TASK, () =>
      scheduleDelSongsPostDeleteMaintenance(removedPaths, sourceSongListRoot)
    )
    return
  }
  try {
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
  } finally {
    releaseMaintenanceMutation()
  }
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
    const releasePlaylistViewSnapshotMutation =
      beginPlaylistViewSnapshotMutationByPaths(uniquePaths)
    const releaseLibraryTreeWatcherBulk = beginLibraryTreeWatcherBulkOperation()
    // 推迟到批次中分片提交的回收站记录；finally 里再兜底一次，避免中途抛错时文件已经移走、
    // 记录却没落库（那样回收站里会出现无法还原的孤儿文件）。
    const deferredRecycleBinRecords: RecycleBinRecord[] = []
    const flushDeferredRecycleBinRecords = () => {
      if (deferredRecycleBinRecords.length === 0) return
      upsertRecycleBinRecords(deferredRecycleBinRecords.splice(0))
    }
    const deferRecycleBinRecord = (record: RecycleBinRecord) => {
      deferredRecycleBinRecords.push(record)
      if (deferredRecycleBinRecords.length >= DELETED_SONGS_RECYCLE_BIN_FLUSH_BATCH) {
        flushDeferredRecycleBinRecords()
      }
    }
    try {
      const setProtection = await protectSetReferencedFilesForDeletion(uniquePaths)
      const protectedMovedPaths = setProtection.protectedFiles
        .filter((item) => item.success)
        .map((item) => item.filePath)
      const protectedFailedCount = setProtection.protectedFiles.filter(
        (item) => !item.success
      ).length
      const protectedHandledCount = setProtection.protectedFiles.length
      const tasks: Array<() => Promise<RecycleBinMoveResult>> = []
      // 同一次删歌里大量文件来自同一个歌单目录，按目录记忆化，省掉逐文件的库树解析。
      const listRootByDirCache = new Map<string, string | null>()
      for (const item of setProtection.unprotectedFiles) {
        tasks.push(async () => {
          await waitForPlaybackForegroundIdle('delSongs:task-start', {
            filePath: item
          })
          const result = await moveFileToRecycleBin(item, {
            originalPlaylistPath,
            sourceType,
            deferDerivedCacheTransfer: true,
            deferRecycleBinRecord: true,
            listRootByDirCache
          })
          if (result.status === 'failed') {
            throw new Error(result.error || 'move to recycle bin failed')
          }
          // 文件已经落进回收站目录，记录必须跟着走；顺手按条数分片提交，别攒到批次结束。
          if (result.pendingRecycleBinRecord) {
            deferRecycleBinRecord(result.pendingRecycleBinRecord)
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
      const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
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
      // 回收站记录已在每个文件搬完后分片落库（见 deferRecycleBinRecord），这里只兜底清一次尾巴。
      flushDeferredRecycleBinRecords()
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
      const moveResults = results.filter(
        (item): item is RecycleBinMoveResult =>
          !(item instanceof Error) && isRecycleBinMoveResult(item)
      )
      const removedPaths = moveResults.map((item) => item.srcPath).concat(protectedMovedPaths)
      // 序号整理要 readdir 整个歌单、全量读一次缓存、逐个 stat 幸存文件、再整表写回，
      // 几百首的量级就是秒级主线程工作；而它在最后一个进度事件之后，白白占着 renderer 的
      // await，进度条已经满了界面却还锁着。挪进后台 I/O 通道排队，IPC 只等到文件搬完就返回。
      // 三件事的相对顺序（整理 → 置脏 → 触发云同步）保持不变。
      if (removedPaths.length > 0) {
        scheduleDelSongsPostDeleteMaintenance(removedPaths, sourceSongListRoot)
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
    } finally {
      flushDeferredRecycleBinRecords()
      releaseLibraryTreeWatcherBulk()
      releasePlaylistViewSnapshotMutation()
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

  const executePermanentlyDelSongs = async (songFilePaths: string[]) => {
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
    const releasePlaylistViewSnapshotMutation =
      beginPlaylistViewSnapshotMutationByPaths(uniquePaths)
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
    } finally {
      releasePlaylistViewSnapshotMutation()
    }
  }

  ipcMain.handle('permanentlyDelSongs', async (_e, songFilePaths: string[]) => {
    assertLibraryMergeMutationAllowed()
    return await executePermanentlyDelSongs(songFilePaths)
  })

  // “删除当前播放曲目前所有曲目”已先在 renderer 乐观移除；这里仅启动真实删除，
  // 不能让磁盘/缓存清理的完成时间继续占住播放器操作。完成后把精确摘要推回同一 renderer。
  ipcMain.handle('recycleBin:permanently-delete-background', (event, songFilePaths: string[]) => {
    assertLibraryMergeMutationAllowed()
    if (activeRecycleBinBackgroundDeleteJobId) {
      return { accepted: false, jobId: activeRecycleBinBackgroundDeleteJobId }
    }
    const uniquePaths = Array.isArray(songFilePaths)
      ? Array.from(new Set(songFilePaths.filter(Boolean)))
      : []
    if (uniquePaths.length === 0) return { accepted: false, jobId: '' }

    const jobId = `recycle_bin_delete_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    const sender = event.sender
    activeRecycleBinBackgroundDeleteJobId = jobId
    setImmediate(() => {
      const finish = (summary: {
        total: number
        success: number
        failed: number
        removedPaths: string[]
      }) => {
        if (activeRecycleBinBackgroundDeleteJobId === jobId) {
          activeRecycleBinBackgroundDeleteJobId = ''
        }
        if (sender.isDestroyed()) return
        sender.send(RECYCLE_BIN_BACKGROUND_DELETE_COMPLETED_CHANNEL, { jobId, summary })
      }
      void executePermanentlyDelSongs(uniquePaths).then(finish, () => {
        finish({
          total: uniquePaths.length,
          success: 0,
          failed: uniquePaths.length,
          removedPaths: []
        })
      })
    })
    return { accepted: true, jobId }
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
