import { ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { log } from '../log'
import store from '../store'
import mainWindow from '../window/mainWindow'
import { EXTERNAL_PLAYLIST_UUID } from '../../shared/externalPlayback'
import { scheduleSongListPostScanTasks } from '../services/scanSongs'
import { scanSongListOffMainThread } from '../services/songListScanWorker'
import { beginPlaylistScanDiagnostic } from '../services/playlistScanDiagnostics'
import { recordPlaylistOpenPath } from '../services/playlistOpenPerfTrace'
import {
  preparePlaylistTimeBasisRepair,
  queuePlaylistTimeBasisRepair
} from '../services/playlistTimeBasisRepair'
import {
  countSongListTracksBatchOffMainThread,
  countSongListTracksOffMainThread
} from '../services/songListTrackCount'
import {
  collectFilesWithExtensions,
  getSongsAnalyseResult,
  resolveLibraryPath,
  runWithConcurrency
} from '../utils'
import { isSupportedAudioPath } from '../services/externalOpenQueue'
import { moveFileToRecycleBin, normalizeRendererPlaylistPath } from '../recycleBinService'
import { protectSetReferencedFilesForDeletion } from './setListHandlers'
import { findLibraryNodeByPath, findSongListRootByPath } from '../libraryTreeDb'
import {
  cancelPlaylistBatchRename,
  executePlaylistBatchRename,
  previewPlaylistBatchRename
} from '../services/playlistBatchRename'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import {
  openPlaylistViewFast,
  savePlaylistViewSnapshotFromScan,
  verifyPlaylistViewTracks
} from '../services/playlistViewSnapshotService'
import { scheduleCuratedLibrarySyncIfUnderCurated } from '../cloudSyncScheduler'
import {
  compactSongListTrackNumbers,
  compactSongListTrackNumbersByFilePaths,
  setSongListTrackNumbersByOrder
} from '../services/playlistTrackNumbers'
import { prepareExternalPlaybackPlaylistAnalysis } from '../services/pioneerDeviceLibrary/playlistAnalysis'
import type {
  IBatchRenameExecutionRequestItem,
  IBatchRenameTemplateSegment,
  IBatchRenameTrackInput
} from '../../types/globals'
import { assertLibraryMergeMutationAllowed } from '../services/libraryMerge/runtime'

type DeduplicateSongListPayload =
  | string
  | {
      songListPath?: string
      progressId?: string
    }

type AudioConvertCollectFilesPayload = {
  songLists?: Array<{
    songListPath?: string | string[]
    songListUUID?: string
  }>
  progressId?: string
  titleKey?: string
}

type ReorderSongListTrackNumbersPayload = {
  songListPath?: string
  orderedFilePaths?: string[]
}

type CompactSongListTrackNumbersPayload = {
  songListPath?: string
  filePaths?: string[]
}

type PlaylistScanDiagnosticContext = {
  traceId?: string
  source?: string
}

let playlistScanDiagnosticSequence = 0

const normalizeDiagnosticText = (value: unknown, maxLength: number) =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, '-')
    .slice(0, maxLength)

const createPlaylistScanTraceId = (requestedTraceId: unknown) => {
  const normalized = normalizeDiagnosticText(requestedTraceId, 80)
  if (normalized) return normalized
  playlistScanDiagnosticSequence += 1
  return `main-${Date.now().toString(36)}-${playlistScanDiagnosticSequence.toString(36)}`
}

const summarizeScanPaths = (scanPath: string | string[]) => {
  const paths = Array.isArray(scanPath) ? scanPath : [scanPath]
  return {
    scanPathCount: paths.length,
    scanPaths: paths.slice(0, 3)
  }
}

export function registerPlaylistHandlers() {
  const runSongListScan = async (
    scanPath: string | string[],
    songListUUID: string,
    diagnosticContext?: PlaylistScanDiagnosticContext
  ) => {
    const traceId = createPlaylistScanTraceId(diagnosticContext?.traceId)
    const source = normalizeDiagnosticText(diagnosticContext?.source, 40) || 'unknown'
    const startedAtMs = Date.now()
    const pathSummary = summarizeScanPaths(scanPath)
    const activity = beginPlaylistScanDiagnostic(traceId, {
      source,
      songListUUID,
      ...pathSummary
    })
    let stage = 'worker-scan'

    try {
      const workerStartedAt = Date.now()
      const result = await scanSongListOffMainThread({
        scanPath,
        audioExt: store.settingConfig.audioExt,
        songListUUID,
        databaseDir: store.databaseDir
      })
      const workerDurationMs = Date.now() - workerStartedAt
      activity.update('worker-result-received', {
        trackCount: result.scanData.length,
        workerDurationMs
      })

      // 扫完立刻落视图快照：下次打开这张歌单就只剩"一次主键查询 + 一次 JSON.parse"。
      // 放在这里而不是 renderer，是因为只有主进程知道真实的 list_root。
      savePlaylistViewSnapshotFromScan(songListUUID, scanPath, result)

      stage = 'time-basis-plan'
      const preparedRepair = preparePlaylistTimeBasisRepair(result.scanData)
      activity.update('time-basis-background-queued', {
        trackCount: result.scanData.length,
        ...preparedRepair.plan
      })
      const repairJob = queuePlaylistTimeBasisRepair(preparedRepair, {
        onStarted: (details) => {
          activity.update('time-basis-background-running', details)
        }
      })
      if (repairJob.completion) {
        void repairJob.completion
          .then((diagnostics) => {
            activity.complete({
              trackCount: result.scanData.length,
              backgroundRepairCompleted: true,
              backgroundRepairDurationMs: diagnostics.repairDurationMs,
              backgroundRepairFailedCount: diagnostics.failedCount,
              maxActiveCount: diagnostics.maxActiveCount
            })
          })
          .catch((error) => {
            const message = error instanceof Error ? error.stack || error.message : String(error)
            activity.fail({ stage: 'time-basis-background-repair', message })
            log.error('[playlist-scan-diagnostic] time-basis background repair failed', {
              traceId,
              error: message
            })
          })
      }
      stage = 'post-scan-schedule'
      activity.update('post-scan-schedule')
      void scheduleSongListPostScanTasks(scanPath, result.scanData)

      const responseReadyAtMs = Date.now()
      const mainDurationMs = responseReadyAtMs - startedAtMs
      // 整单重扫是兜底档：只有真的慢（≥ 阈值）才会写一行日志，正常什么都不写。
      recordPlaylistOpenPath({
        source: 'full-scan',
        hit: true,
        tookMs: mainDurationMs,
        itemCount: result.scanData.length,
        reason: source,
        songListUUID,
        details: {
          workerDurationMs,
          listFilesMs: result.perf?.listFilesMs,
          listMode: result.perf?.listMode,
          cacheLoadMs: result.perf?.cacheLoadMs,
          statMs: result.perf?.statMs,
          parseMetadataMs: result.perf?.parseMetadataMs,
          refreshMissingMs: result.perf?.refreshMissingMs,
          parsedCount: result.perf?.parsedCount
        }
      })
      if (repairJob.completion) {
        activity.update('response-ready-background-repair', {
          trackCount: result.scanData.length,
          mainDurationMs,
          workerDurationMs,
          backgroundRepairPending: true
        })
      } else {
        activity.complete({
          trackCount: result.scanData.length,
          mainDurationMs,
          workerDurationMs,
          backgroundRepairPending: false
        })
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error)
      activity.fail({ stage, message })
      log.error('[playlist-scan-diagnostic] main scan failed', {
        traceId,
        source,
        songListUUID,
        stage,
        durationMs: Date.now() - startedAtMs,
        error: message
      })
      throw error
    }
  }

  ipcMain.handle(
    'scanSongList',
    async (
      _e,
      songListPath: string | string[],
      songListUUID: string,
      diagnosticContext?: PlaylistScanDiagnosticContext
    ) => {
      assertLibraryMergeMutationAllowed()
      if (typeof songListPath === 'string') {
        const scanPath = resolveLibraryPath(songListPath).absPath
        return await runSongListScan(scanPath, songListUUID, diagnosticContext)
      } else {
        const scanPaths = songListPath.map((p) => resolveLibraryPath(p).absPath)
        return await runSongListScan(scanPaths, songListUUID, diagnosticContext)
      }
    }
  )

  // 前台打开歌单的快路径：只读快照表，绝不碰文件系统。
  // 没命中就老老实实回 hit=false，让 renderer 走 scanSongList——**只起一个 worker**。
  ipcMain.handle(
    'playlist:fast-open',
    (_e, payload: { songListUUID?: string; songListPath?: string }) => {
      const songListUUID = String(payload?.songListUUID || '').trim()
      if (!songListUUID) {
        return {
          hit: false,
          source: 'miss',
          songListUUID: '',
          revision: 0,
          items: [],
          missingWaveformFilePaths: [],
          tookMs: 0
        }
      }
      const rawPath = String(payload?.songListPath || '').trim()
      const songListPath = rawPath ? resolveLibraryPath(rawPath).absPath : ''
      const result = openPlaylistViewFast({ songListUUID, songListPath })
      // 只累计命中率与未命中原因（内存计数器）；这条路径正常是个位数毫秒，不会写日志。
      recordPlaylistOpenPath({
        source: 'snapshot',
        hit: result.hit,
        tookMs: result.tookMs,
        itemCount: result.items.length,
        reason: result.hit ? undefined : 'no-snapshot-row',
        songListUUID
      })
      return result
    }
  )

  // 分散核对：renderer 滚动到某几行 / 选中 / 播放时报上来，只 stat 这几首。
  ipcMain.handle(
    'playlist:verify-tracks',
    async (_e, payload: { songListUUID?: string; songListPath?: string; filePaths?: unknown }) => {
      const songListUUID = String(payload?.songListUUID || '').trim()
      if (!songListUUID) return { scheduled: false }
      const filePaths = Array.isArray(payload?.filePaths)
        ? payload.filePaths.map((item) => String(item || '').trim()).filter(Boolean)
        : []
      if (filePaths.length === 0) return { scheduled: false }
      const rawPath = String(payload?.songListPath || '').trim()
      const songListPath = rawPath ? resolveLibraryPath(rawPath).absPath : ''
      const scheduled = await verifyPlaylistViewTracks({ songListUUID, songListPath, filePaths })
      return { scheduled }
    }
  )

  ipcMain.handle(
    'songList:reorder-track-numbers',
    async (_e, payload: ReorderSongListTrackNumbersPayload) => {
      assertLibraryMergeMutationAllowed()
      const songListPath = String(payload?.songListPath || '').trim()
      const orderedFilePaths = Array.isArray(payload?.orderedFilePaths)
        ? payload.orderedFilePaths.map((item) => String(item || '').trim()).filter(Boolean)
        : []
      if (!songListPath) {
        throw new Error('缺少歌单路径')
      }
      if (orderedFilePaths.length === 0) {
        throw new Error('缺少排序后的曲目列表')
      }
      const resolvedPlaylist = resolveLibraryPath(songListPath)
      const result = await setSongListTrackNumbersByOrder({
        listRoot: resolvedPlaylist.absPath,
        orderedFilePaths
      })
      if (!result.updated || result.total <= 0) {
        throw new Error('重排序号未写入，目标歌单可能不支持真实序号或没有可写入曲目')
      }
      markGlobalSongSearchDirty('songList:reorder-track-numbers', {
        songListUUID: findLibraryNodeByPath(resolvedPlaylist.mappedPath)?.uuid
      })
      scheduleCuratedLibrarySyncIfUnderCurated([resolvedPlaylist.absPath])
      return result
    }
  )

  ipcMain.handle(
    'songList:compact-track-numbers',
    async (_e, payload: CompactSongListTrackNumbersPayload) => {
      assertLibraryMergeMutationAllowed()
      const songListPath = String(payload?.songListPath || '').trim()
      if (songListPath) {
        const resolvedPlaylist = resolveLibraryPath(songListPath)
        const result = await compactSongListTrackNumbers(resolvedPlaylist.absPath)
        markGlobalSongSearchDirty('songList:compact-track-numbers', {
          songListUUID: findLibraryNodeByPath(resolvedPlaylist.mappedPath)?.uuid
        })
        if (result.updated) {
          scheduleCuratedLibrarySyncIfUnderCurated([resolvedPlaylist.absPath])
        }
        return {
          ...result,
          roots: 1
        }
      }

      const filePaths = Array.isArray(payload?.filePaths)
        ? payload.filePaths.map((item) => String(item || '').trim()).filter(Boolean)
        : []
      const result = await compactSongListTrackNumbersByFilePaths(filePaths)
      if (result.roots > 0) {
        markGlobalSongSearchDirty('songList:compact-track-numbers')
      }
      if (result.updated) {
        scheduleCuratedLibrarySyncIfUnderCurated(filePaths)
      }
      return result
    }
  )

  ipcMain.handle(
    'audio:convert:collect-files',
    async (_e, payload: AudioConvertCollectFilesPayload) => {
      assertLibraryMergeMutationAllowed()
      const requests = Array.isArray(payload?.songLists) ? payload.songLists : []
      const progressId =
        typeof payload?.progressId === 'string' && payload.progressId.trim()
          ? payload.progressId.trim()
          : `audio_convert_collect_${Date.now()}`
      const titleKey =
        typeof payload?.titleKey === 'string' && payload.titleKey.trim()
          ? payload.titleKey.trim()
          : 'convert.scanningSourceFiles'
      const total = requests.length

      if (total <= 0) {
        return { files: [] as string[] }
      }

      mainWindow.instance?.webContents.send('progressSet', {
        id: progressId,
        titleKey,
        now: 0,
        total,
        isInitial: true,
        noProgress: true
      })

      const files: string[] = []
      for (let index = 0; index < requests.length; index++) {
        const request = requests[index]
        try {
          const rawSongListPath = request?.songListPath
          const songListUUID = String(request?.songListUUID || '')
          const hasValidPath =
            (typeof rawSongListPath === 'string' && rawSongListPath.trim().length > 0) ||
            (Array.isArray(rawSongListPath) &&
              rawSongListPath.some((item) => String(item || '').trim()))
          if (!hasValidPath) {
            continue
          }
          const scanPath = Array.isArray(rawSongListPath)
            ? rawSongListPath.map((item) => resolveLibraryPath(item).absPath)
            : resolveLibraryPath(String(rawSongListPath || '')).absPath
          const result = await runSongListScan(scanPath, songListUUID)
          const songFiles = Array.isArray(result?.scanData)
            ? result.scanData.map((item) => item.filePath).filter((item): item is string => !!item)
            : []
          files.push(...songFiles)
        } catch (error) {
          log.error('audio:convert:collect-files scan failed', error)
        } finally {
          mainWindow.instance?.webContents.send('progressSet', {
            id: progressId,
            titleKey,
            now: index + 1,
            total,
            isInitial: true,
            noProgress: true
          })
        }
      }

      return { files: Array.from(new Set(files)) }
    }
  )

  ipcMain.handle('externalPlaylist:scan', async (_e, rawPaths: string[]) => {
    assertLibraryMergeMutationAllowed()
    try {
      const arr = Array.isArray(rawPaths) ? rawPaths : []
      const normalized = Array.from(
        new Set(
          arr
            .map((p) => (typeof p === 'string' ? p.trim() : ''))
            .filter((p) => p.length > 0)
            .map((p) => path.resolve(p))
        )
      )
      const filtered = normalized.filter((p) => isSupportedAudioPath(p))
      if (!filtered.length) {
        return { scanData: [], songListUUID: EXTERNAL_PLAYLIST_UUID }
      }
      const result = await runSongListScan(filtered, EXTERNAL_PLAYLIST_UUID)
      try {
        await prepareExternalPlaybackPlaylistAnalysis({
          tracks: Array.isArray(result?.scanData) ? result.scanData : []
        })
      } catch (prepareError) {
        log.error('externalPlaylist:prepare-analysis failed', prepareError)
      }
      return result
    } catch (error) {
      log.error('externalPlaylist:scan failed', error)
      return { scanData: [], songListUUID: EXTERNAL_PLAYLIST_UUID }
    }
  })

  ipcMain.handle('getSongListTrackCount', async (_e, songListPath: string) => {
    try {
      const scanPath = resolveLibraryPath(songListPath).absPath
      return await countSongListTracksOffMainThread({
        scanPath,
        audioExt: store.settingConfig.audioExt
      })
    } catch {
      return 0
    }
  })

  // 库树按曲目数排序时需要一次拿到整棵树的数量，逐歌单往返会导致列表反复重排
  ipcMain.handle(
    'playlist:batchTrackCount',
    async (_e, payload?: { songLists?: Array<{ uuid?: string; songListPath?: string }> }) => {
      const result: Record<string, number> = {}
      try {
        const requests = Array.isArray(payload?.songLists) ? payload.songLists : []
        const resolved: Array<{ uuid: string; scanPath: string }> = []
        for (const item of requests) {
          const uuid = String(item?.uuid || '').trim()
          const songListPath = String(item?.songListPath || '').trim()
          if (!uuid || !songListPath) continue
          if (result[uuid] !== undefined) continue
          result[uuid] = 0
          try {
            resolved.push({ uuid, scanPath: resolveLibraryPath(songListPath).absPath })
          } catch {
            // 路径已失效的节点保持 0，不影响其余歌单
          }
        }
        if (!resolved.length) return result
        const counts = await countSongListTracksBatchOffMainThread({
          scanPaths: resolved.map((item) => item.scanPath),
          audioExt: store.settingConfig.audioExt
        })
        resolved.forEach((item, index) => {
          result[item.uuid] = counts[index] ?? 0
        })
        return result
      } catch (error) {
        log.error('playlist:batchTrackCount failed', error)
        return result
      }
    }
  )

  ipcMain.handle('songList:resolve-by-file-path', async (_e, rawFilePath?: string) => {
    try {
      const filePath = String(rawFilePath || '').trim()
      if (!filePath) {
        return { songListUuid: '', songListPath: '' }
      }
      const songListRoot = await findSongListRootByPath(path.dirname(filePath))
      if (!songListRoot) {
        return { songListUuid: '', songListPath: '' }
      }
      const relativeSongListPath = path.relative(store.databaseDir, songListRoot)
      const node = findLibraryNodeByPath(relativeSongListPath)
      return {
        songListUuid: String(node?.uuid || ''),
        songListPath: relativeSongListPath
      }
    } catch (error) {
      log.error('songList:resolve-by-file-path failed', error)
      return { songListUuid: '', songListPath: '' }
    }
  })

  ipcMain.handle(
    'playlist:batchRename:preview',
    async (
      _e,
      payload: {
        tracks?: IBatchRenameTrackInput[]
        templateSegments?: IBatchRenameTemplateSegment[]
      }
    ) => {
      const tracks = Array.isArray(payload?.tracks) ? payload.tracks : []
      const templateSegments = Array.isArray(payload?.templateSegments)
        ? payload.templateSegments
        : []
      return await previewPlaylistBatchRename(tracks, templateSegments)
    }
  )

  ipcMain.handle(
    'playlist:batchRename:execute',
    async (
      _e,
      payload: {
        taskId?: string
        items?: IBatchRenameExecutionRequestItem[]
      }
    ) => {
      assertLibraryMergeMutationAllowed()
      return await executePlaylistBatchRename({
        taskId: String(payload?.taskId || ''),
        items: Array.isArray(payload?.items) ? payload.items : []
      }).then((result) => {
        if (result.summary.success > 0) {
          scheduleCuratedLibrarySyncIfUnderCurated([
            ...result.updates.map((item) => item.oldFilePath),
            ...result.updates.map((item) => item.song.filePath)
          ])
        }
        return result
      })
    }
  )

  ipcMain.handle(
    'playlist:batchRename:cancel',
    async (_e, payload: { taskId?: string } | string) => {
      const taskId =
        typeof payload === 'string'
          ? payload
          : payload && typeof payload === 'object'
            ? String(payload.taskId || '')
            : ''
      return cancelPlaylistBatchRename(taskId)
    }
  )

  ipcMain.handle(
    'deduplicateSongListByFingerprint',
    async (_e, payload: DeduplicateSongListPayload) => {
      assertLibraryMergeMutationAllowed()
      let rendererPath = ''
      let incomingProgressId = ''
      if (typeof payload === 'string') {
        rendererPath = payload
      } else if (payload && typeof payload === 'object') {
        rendererPath = String(payload.songListPath || '')
        incomingProgressId = payload.progressId ? String(payload.progressId) : ''
      }
      if (!rendererPath) {
        throw new Error('缺少有效的歌单路径')
      }

      const progressId = incomingProgressId || `playlist_dedup_${Date.now()}`
      const pushProgress = (
        titleKey: string,
        now: number,
        total: number,
        options?: { isInitial?: boolean }
      ) => {
        if (!mainWindow.instance) return
        mainWindow.instance.webContents.send('progressSet', {
          id: progressId,
          titleKey,
          now,
          total,
          isInitial: !!options?.isInitial
        })
      }

      try {
        const startedAt = Date.now()
        const mode = store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
        const scanPath = resolveLibraryPath(rendererPath).absPath

        const summaryBase = {
          scannedCount: 0,
          analyzeFailedCount: 0,
          duplicatesRemovedCount: 0,
          removedFilePaths: [] as string[],
          fingerprintMode: mode,
          durationMs: 0,
          recycleBinInfo: null as null | {
            dirName: string
            uuid: string
            type: string
            order: number
          },
          progressId
        }

        pushProgress('playlist.deduplicateProgressScanning', 0, 1, { isInitial: true })

        const songFileUrlsRaw = await collectFilesWithExtensions(
          scanPath,
          store.settingConfig.audioExt
        )
        const songFileUrls = Array.isArray(songFileUrlsRaw)
          ? Array.from(
              new Set(
                songFileUrlsRaw.filter(
                  (item): item is string => typeof item === 'string' && item.trim().length > 0
                )
              )
            )
          : []

        pushProgress('playlist.deduplicateProgressScanning', 1, 1)

        if (songFileUrls.length === 0) {
          pushProgress('playlist.deduplicateProgressFinished', 1, 1)
          return { ...summaryBase, durationMs: Date.now() - startedAt }
        }

        const analysisTotal = songFileUrls.length
        pushProgress('playlist.deduplicateProgressAnalyzing', 0, analysisTotal)

        const { songsAnalyseResult, errorSongsAnalyseResult } = await getSongsAnalyseResult(
          songFileUrls,
          (processed: number) => {
            const current = Math.min(processed, analysisTotal)
            pushProgress('playlist.deduplicateProgressAnalyzing', current, analysisTotal)
          }
        )

        pushProgress('playlist.deduplicateProgressAnalyzing', analysisTotal, analysisTotal)

        const groups = new Map<string, string[]>()
        for (const item of songsAnalyseResult) {
          const hash = item?.sha256_Hash
          const filePath = item?.file_path
          if (!hash || hash === 'error' || !filePath) continue
          const list = groups.get(hash) || []
          list.push(filePath)
          groups.set(hash, list)
        }

        const duplicates: string[] = []
        groups.forEach((paths) => {
          if (paths.length <= 1) return
          paths.sort((a: string, b: string) =>
            a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
          )
          duplicates.push(...paths.slice(1))
        })

        const existingToRemove: string[] = []
        for (const filePath of duplicates) {
          try {
            if (await fs.pathExists(filePath)) {
              existingToRemove.push(filePath)
            }
          } catch (err) {
            log.error('检查重复文件是否存在失败', { filePath, err })
          }
        }

        if (existingToRemove.length === 0) {
          pushProgress('playlist.deduplicateProgressFinished', 1, 1)
          return {
            scannedCount: songFileUrls.length,
            analyzeFailedCount: errorSongsAnalyseResult.length,
            duplicatesRemovedCount: 0,
            removedFilePaths: [],
            fingerprintMode: mode,
            durationMs: Date.now() - startedAt,
            recycleBinInfo: null,
            progressId
          }
        }

        pushProgress('playlist.deduplicateProgressRemoving', 0, existingToRemove.length)

        const originalPlaylistPath = normalizeRendererPlaylistPath(rendererPath)
        const setProtection = await protectSetReferencedFilesForDeletion(existingToRemove)
        const protectedMovedPaths = setProtection.protectedFiles
          .filter((protectedFile) => protectedFile.success)
          .map((protectedFile) => protectedFile.filePath)
        const protectedFailed = setProtection.protectedFiles.filter(
          (protectedFile) => !protectedFile.success
        )
        const protectedHandledCount = setProtection.protectedFiles.length
        const moveTasks = setProtection.unprotectedFiles.map((srcPath) => async () => {
          const result = await moveFileToRecycleBin(srcPath, { originalPlaylistPath })
          if (result.status === 'failed') {
            throw new Error(result.error || 'move to recycle bin failed')
          }
          return srcPath
        })

        const { results: moveResults } = await runWithConcurrency(moveTasks, {
          concurrency: 16,
          onProgress: (done: number, total: number) => {
            pushProgress(
              'playlist.deduplicateProgressRemoving',
              protectedHandledCount + done,
              protectedHandledCount + total
            )
          }
        })
        const movedPaths = moveResults
          .filter((item): item is string => typeof item === 'string')
          .concat(protectedMovedPaths)
        const failedMoves = moveResults.filter((item) => item instanceof Error) as Error[]

        if (failedMoves.length > 0) {
          failedMoves.forEach((err, index) => {
            log.error('指纹去重移动重复文件失败', { error: err?.message, index })
          })
        }
        if (protectedFailed.length > 0) {
          protectedFailed.forEach((item) => {
            log.error('指纹去重保护 SET 引用文件失败', {
              filePath: item.filePath,
              error: item.error
            })
          })
        }
        if (movedPaths.length > 0) {
          await compactSongListTrackNumbers(scanPath)
          markGlobalSongSearchDirty('deduplicateSongListByFingerprint')
          scheduleCuratedLibrarySyncIfUnderCurated([scanPath, ...movedPaths])
        }

        const recycleBinInfo = null

        pushProgress('playlist.deduplicateProgressFinished', 1, 1)

        return {
          scannedCount: songFileUrls.length,
          analyzeFailedCount: errorSongsAnalyseResult.length,
          duplicatesRemovedCount: movedPaths.length,
          removedFilePaths: movedPaths,
          fingerprintMode: mode,
          durationMs: Date.now() - startedAt,
          recycleBinInfo,
          progressId
        }
      } catch (error) {
        pushProgress('playlist.deduplicateProgressFailed', 1, 1)
        throw error
      }
    }
  )
}
