import { ipcMain } from 'electron'
import path from 'node:path'
import fs = require('fs-extra')
import mixtapeWindow, {
  isMixtapeWindowOpenByPlaylistId,
  type MixtapeWindowPayload
} from '../window/mixtapeWindow'
import mainWindow from '../window/mainWindow'
import { log } from '../log'
import {
  appendMixtapeItems,
  getMixtapeProjectMixMode,
  getMixtapeProjectStemConfig,
  listMixtapeItems,
  listMixtapeItemsByItemIds,
  listMixtapeItemsByFilePath,
  listMixtapeFilePathsByItemIds,
  removeMixtapeItemsById,
  removeMixtapeItemsByFilePath,
  reorderMixtapeItems,
  upsertMixtapeProjectMixMode,
  upsertMixtapeProjectStemProfile,
  clearMixtapeItemGridCopiesByFilePath,
  upsertMixtapeItemGainEnvelopeById,
  upsertMixtapeItemLoopSegmentsById,
  upsertMixtapeItemMixEnvelopeById,
  upsertMixtapeItemVolumeMuteSegmentsById,
  upsertMixtapeItemStartSecById,
  type MixtapeMixMode,
  type MixtapeStemMode,
  type MixtapeStemProfile
} from '../mixtapeDb'
import { summarizeMixtapeStemStatusByPlaylist } from '../mixtapeStemDb'
import { FIXED_MIXTAPE_STEM_MODE } from '../../shared/mixtapeStemMode'
import { queueMixtapeRawWaveforms } from '../services/mixtapeRawWaveformQueue'
import { queueUnifiedDisplayWaveforms } from '../services/unifiedDisplayWaveformQueue'
import {
  cleanupMixtapeWaveformCache,
  cleanupOrphanedMixtapeVaultFiles
} from '../services/mixtapeWaveformMaintenance'
import {
  enqueueMixtapeStemJobs,
  getMixtapeStemStatusSnapshot,
  retryMixtapeStemJobs
} from '../services/mixtapeStemQueue'
import { isAnalysisRuntimeAvailable } from '../services/analysisRuntimeDownload'
import {
  analyzeMixtapeBpmBatchShared,
  reconcileMixtapeMissingFiles
} from './mixtapeHandlers.shared'
import {
  loadSharedSongGridDefinition,
  loadSharedSongGridDefinitions,
  type SharedSongGridDefinition
} from '../services/sharedSongGrid'
import {
  clearMixtapeItemsGridCopiesFromShared,
  persistAndBroadcastSharedGridBatch,
  persistAndBroadcastSharedGridEntries,
  resolveWritableSharedGridEntries
} from './mixtapeSharedGridPersistence'
import { CURRENT_BEAT_GRID_ALGORITHM_VERSION } from '../services/beatGridAlgorithmVersion'
import { createMixtapeNoBpmGuard } from '../services/mixtapeNoBpmGuard'
import {
  cancelMixtapeOutputControl,
  createMixtapeOutputControl,
  runMixtapeOutput,
  type MixtapeOutputInput,
  type MixtapeOutputControl,
  type MixtapeOutputProgressPayload
} from '../services/mixtapeOutput'
import { moveOrCopyItemWithCheckIsExist, runWithConcurrency, waitForUserDecision } from '../utils'
import { getMixtapeVaultRootAbs } from '../recycleBinService'
import { enqueueKeyAnalysis } from '../services/keyAnalysisQueue'
import {
  MIXTAPE_ANALYSIS_COPY_FIELDS,
  type MixtapeAnalysisInfo
} from '../services/mixtapeAnalysisInfo'
import {
  createSongBeatGridMapV2FromFixedGrid,
  normalizeSongBeatGridMapV2,
  type SongBeatGridMapV2
} from '../../shared/songBeatGridMapV2'
import { isLibraryMergeMutationLocked } from '../services/libraryMerge/runtime'

const normalizeStemProfileInput = (
  value: unknown,
  fallback: MixtapeStemProfile
): MixtapeStemProfile => {
  return value === 'quality' ? 'quality' : fallback
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function registerMixtapeHandlers() {
  const mixtapeOutputControls = new Map<string, MixtapeOutputControl>()
  const MIXTAPE_OUTPUT_TIMEOUT_MS = 3 * 60 * 60 * 1000

  const normalizeMixtapeOutputRequestId = (payload?: { requestId?: unknown }) => {
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : ''
    return requestId || `mixtape_output_${Date.now()}`
  }

  const broadcastMixtapeItemsRemoved = (
    sender: Electron.WebContents | null,
    payload: {
      playlistId: string
      itemIds: string[]
      removedPaths: string[]
      removed: number
    }
  ) => {
    if (!payload.playlistId || payload.removed <= 0) return
    if (mainWindow.instance && mainWindow.instance.webContents !== sender) {
      mainWindow.instance.webContents.send('mixtape-items-removed', payload)
    }
    mixtapeWindow.broadcast?.('mixtape-items-removed', payload)
  }

  // 注意：此处存在理论上的 TOCTOU 竞态（检查 runtime 可用性后、打开窗口前 runtime 可能被卸载），
  // 但实际触发概率极低（需要用户在毫秒级窗口内卸载 runtime），不影响正常使用。
  ipcMain.on('mixtape:open', async (_e, payload: MixtapeWindowPayload) => {
    if (isLibraryMergeMutationLocked()) return
    const nextPayload = payload || {}
    const playlistId = typeof nextPayload.playlistId === 'string' ? nextPayload.playlistId : ''
    if (playlistId && getMixtapeProjectMixMode(playlistId) === 'stem') {
      const runtimeAvailable = await isAnalysisRuntimeAvailable('stem').catch(() => false)
      if (!runtimeAvailable) {
        try {
          mainWindow.instance?.webContents.send(
            'openDialogFromTray',
            'menu.downloadAnalysisRuntime'
          )
        } catch {}
        return
      }
    }
    mixtapeWindow.open(nextPayload)
  })

  ipcMain.handle('mixtape:is-window-open-by-playlist-id', (_e, playlistId?: string) => {
    return isMixtapeWindowOpenByPlaylistId(typeof playlistId === 'string' ? playlistId : '')
  })

  ipcMain.on('mixtapeWindow-open-dialog', (_e, key: string) => {
    if (!key) return
    try {
      mainWindow.instance?.webContents.send('openDialogFromTray', key)
    } catch {}
  })

  ipcMain.handle('mixtape:list', async (_e, payload: { playlistId?: string }) => {
    const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
    const { items, recovery } = await reconcileMixtapeMissingFiles(playlistId)
    const gridCleanup = await clearMixtapeItemsGridCopiesFromShared(items)
    const currentItems = gridCleanup.updated > 0 ? listMixtapeItems(playlistId) : items
    const sharedGridByFilePath = await loadSharedSongGridDefinitions(
      currentItems.map((item) => item.filePath)
    )
    const itemsWithCanonicalGrid = currentItems.map((item) => {
      const canonicalGrid = sharedGridByFilePath.get(item.filePath)
      return canonicalGrid ? { ...item, canonicalGrid } : item
    })
    const stemConfig = getMixtapeProjectStemConfig(playlistId)
    const stemSummary = summarizeMixtapeStemStatusByPlaylist(playlistId)
    return {
      items: itemsWithCanonicalGrid,
      recovery,
      mixMode: stemConfig.mixMode,
      stemProfile: stemConfig.stemProfile,
      stemSummary
    }
  })

  ipcMain.handle('mixtape:project:get-mix-mode', async (_e, payload?: { playlistId?: string }) => {
    const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
    return {
      mixMode: getMixtapeProjectMixMode(playlistId)
    }
  })

  ipcMain.handle(
    'mixtape:project:set-mix-mode',
    async (_e, payload?: { playlistId?: string; mixMode?: string }) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const mixModeRaw = typeof payload?.mixMode === 'string' ? payload.mixMode : 'stem'
      return upsertMixtapeProjectMixMode(playlistId, mixModeRaw as MixtapeMixMode)
    }
  )

  ipcMain.handle(
    'mixtape:project:get-stem-profile',
    async (_e, payload?: { playlistId?: string }) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const config = getMixtapeProjectStemConfig(playlistId)
      return {
        stemProfile: config.stemProfile
      }
    }
  )

  ipcMain.handle(
    'mixtape:project:set-stem-profile',
    async (
      _e,
      payload?: {
        playlistId?: string
        stemProfile?: string
      }
    ) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const current = getMixtapeProjectStemConfig(playlistId)
      return upsertMixtapeProjectStemProfile(
        playlistId,
        normalizeStemProfileInput(payload?.stemProfile, current.stemProfile)
      )
    }
  )

  ipcMain.handle(
    'mixtape:stem:enqueue',
    async (
      _e,
      payload?: {
        playlistId?: string
        filePaths?: string[]
        stemMode?: string
        force?: boolean
        model?: string
        stemVersion?: string
        profile?: string
      }
    ) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const current = getMixtapeProjectStemConfig(playlistId)
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      const stemModeRaw =
        typeof payload?.stemMode === 'string' ? payload.stemMode : FIXED_MIXTAPE_STEM_MODE
      return enqueueMixtapeStemJobs({
        playlistId,
        filePaths,
        stemMode: stemModeRaw as MixtapeStemMode,
        force: !!payload?.force,
        model: typeof payload?.model === 'string' ? payload.model : undefined,
        stemVersion: typeof payload?.stemVersion === 'string' ? payload.stemVersion : undefined,
        profile: normalizeStemProfileInput(payload?.profile, current.stemProfile)
      })
    }
  )

  ipcMain.handle(
    'mixtape:stem:retry',
    async (
      _e,
      payload?: {
        playlistId?: string
        stemMode?: string
        itemIds?: string[]
        filePaths?: string[]
        model?: string
        stemVersion?: string
        profile?: string
      }
    ) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const current = getMixtapeProjectStemConfig(playlistId)
      const stemModeRaw =
        typeof payload?.stemMode === 'string' ? payload.stemMode : FIXED_MIXTAPE_STEM_MODE
      return retryMixtapeStemJobs({
        playlistId,
        stemMode: stemModeRaw as MixtapeStemMode,
        itemIds: Array.isArray(payload?.itemIds) ? payload.itemIds : [],
        filePaths: Array.isArray(payload?.filePaths) ? payload.filePaths : [],
        model: typeof payload?.model === 'string' ? payload.model : undefined,
        stemVersion: typeof payload?.stemVersion === 'string' ? payload.stemVersion : undefined,
        profile: normalizeStemProfileInput(payload?.profile, current.stemProfile)
      })
    }
  )

  ipcMain.handle('mixtape:stem:get-status', async (_e, payload?: { playlistId?: string }) => {
    const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
    return getMixtapeStemStatusSnapshot(playlistId)
  })

  ipcMain.handle('mixtape:copy-files-to-vault', async (_e, payload?: { filePaths?: string[] }) => {
    const vaultRoot = getMixtapeVaultRootAbs()
    if (!vaultRoot) {
      throw new Error('MIXTAPE_VAULT_UNAVAILABLE')
    }
    await fs.ensureDir(vaultRoot)

    const sourcePaths = Array.from(
      new Set(
        (Array.isArray(payload?.filePaths) ? payload.filePaths : [])
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      )
    )
    if (!sourcePaths.length) {
      return []
    }

    const batchId = `mixtape_copy_to_vault_${Date.now()}`
    try {
      mainWindow.instance?.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'tracks.copyingTracks',
        now: 0,
        total: sourcePaths.length,
        isInitial: true
      })
    } catch {}

    const tasks = sourcePaths.map(
      (sourcePath) => async (): Promise<{ sourcePath: string; targetPath: string }> => {
        const targetPath = path.join(vaultRoot, path.basename(sourcePath))
        const copiedPath = await moveOrCopyItemWithCheckIsExist(sourcePath, targetPath, false)
        return {
          sourcePath,
          targetPath: copiedPath
        }
      }
    )

    const { failed, skipped, results } = await runWithConcurrency(tasks, {
      concurrency: 8,
      onProgress: (done, total) => {
        try {
          mainWindow.instance?.webContents.send('progressSet', {
            id: batchId,
            titleKey: 'tracks.copyingTracks',
            now: done,
            total
          })
        } catch {}
      },
      stopOnENOSPC: true,
      onInterrupted: async (progressPayload) =>
        waitForUserDecision(
          mainWindow.instance ?? null,
          batchId,
          'mixtapeCopyToVault',
          progressPayload
        )
    })

    try {
      mainWindow.instance?.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'tracks.copyingTracks',
        now: sourcePaths.length,
        total: sourcePaths.length
      })
    } catch {}

    const successfulResults = results.filter(
      (item): item is { sourcePath: string; targetPath: string } => !(item instanceof Error)
    )
    if (failed > 0 || skipped > 0 || successfulResults.length !== sourcePaths.length) {
      await Promise.all(
        successfulResults.map(async (item) => {
          try {
            await fs.remove(item.targetPath)
          } catch {}
        })
      )
      throw new Error('MIXTAPE_COPY_TO_VAULT_FAILED')
    }

    return successfulResults
  })

  ipcMain.handle(
    'mixtape:append',
    async (
      _e,
      payload: {
        playlistId?: string
        items?: Array<{
          filePath: string
          originPlaylistUuid?: string | null
          originPathSnapshot?: string | null
          info?: MixtapeAnalysisInfo | null
          sourcePlaylistId?: string | null
          sourceItemId?: string | null
        }>
      }
    ) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const inputItems = Array.isArray(payload?.items) ? payload.items : []

      const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
      const normalizeInfo = (value: unknown): MixtapeAnalysisInfo | null => {
        if (!isRecord(value)) return null
        return value
      }
      const parseInfoJson = (value: unknown): MixtapeAnalysisInfo | null => {
        if (typeof value !== 'string' || !value.trim()) return null
        try {
          const parsed = JSON.parse(value)
          return normalizeInfo(parsed)
        } catch {
          return null
        }
      }
      const isLikelyAudioFilePath = (value: string) => {
        const normalized = normalizeText(value)
        if (!normalized) return false
        return path.isAbsolute(normalized)
      }
      const hasReadyStemPaths = (info: MixtapeAnalysisInfo | null): boolean => {
        if (!info) return false
        const vocal = normalizeText(info.stemVocalPath)
        const inst = normalizeText(info.stemInstPath)
        const drums = normalizeText(info.stemDrumsPath)
        if (!vocal || !inst || !drums) return false
        const bass = normalizeText(info.stemBassPath)
        return !!bass
      }
      const hasBpmReady = (info: MixtapeAnalysisInfo | null): boolean => {
        if (!info) return false
        const bpm = Number(info.bpm)
        return Number.isFinite(bpm) && bpm > 0
      }
      const noBpmGuard = createMixtapeNoBpmGuard()
      const pickAnalysisInfo = (info: MixtapeAnalysisInfo | null): MixtapeAnalysisInfo | null => {
        if (!info) return null
        const picked: MixtapeAnalysisInfo = {}
        for (const key of MIXTAPE_ANALYSIS_COPY_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(info, key)) continue
          const value = info[key]
          if (value === undefined || value === null) continue
          if (typeof value === 'string' && !value.trim()) continue
          if (key === 'stemStatus' && value !== 'ready') continue
          Reflect.set(picked, key, value)
        }
        return Object.keys(picked).length > 0 ? picked : null
      }
      const mergeInfoWithAnalysis = (
        baseInfo: MixtapeAnalysisInfo | null,
        analysisInfo: MixtapeAnalysisInfo | null
      ): MixtapeAnalysisInfo | null => {
        if (!baseInfo && !analysisInfo) return null
        if (!analysisInfo) return baseInfo
        if (!baseInfo) return { ...analysisInfo }
        const merged: MixtapeAnalysisInfo = { ...baseInfo }
        for (const key of MIXTAPE_ANALYSIS_COPY_FIELDS) {
          const nextValue = analysisInfo[key]
          if (nextValue === undefined || nextValue === null) continue
          if (
            merged[key] === undefined ||
            merged[key] === null ||
            (typeof merged[key] === 'string' && !String(merged[key]).trim())
          ) {
            Reflect.set(merged, key, nextValue)
          }
        }
        return merged
      }

      const targetStemConfig = getMixtapeProjectStemConfig(playlistId)
      const targetPlaylistMixMode = targetStemConfig.mixMode
      const playlistMixModeById = new Map<string, string>([[playlistId, targetPlaylistMixMode]])
      const resolvePlaylistMixMode = (playlistUuid: string) => {
        const normalized = normalizeText(playlistUuid)
        if (!normalized) return ''
        const cached = playlistMixModeById.get(normalized)
        if (cached) return cached
        const config = getMixtapeProjectStemConfig(normalized)
        const mixMode = config.mixMode
        playlistMixModeById.set(normalized, mixMode)
        return mixMode
      }
      const sourceRefsByPlaylist = new Map<string, Set<string>>()
      for (const item of inputItems) {
        const sourcePlaylistId =
          normalizeText(item?.sourcePlaylistId) || normalizeText(item?.originPlaylistUuid)
        const sourceItemId = normalizeText(item?.sourceItemId)
        if (!sourcePlaylistId || !sourceItemId) continue
        if (!sourceRefsByPlaylist.has(sourcePlaylistId)) {
          sourceRefsByPlaylist.set(sourcePlaylistId, new Set<string>())
        }
        sourceRefsByPlaylist.get(sourcePlaylistId)?.add(sourceItemId)
      }

      const reusableInfoBySourceKey = new Map<string, MixtapeAnalysisInfo>()
      for (const [sourcePlaylistId, sourceItemIdSet] of sourceRefsByPlaylist.entries()) {
        if (resolvePlaylistMixMode(sourcePlaylistId) !== targetPlaylistMixMode) continue
        const sourceItemIds = Array.from(sourceItemIdSet)
        const sourceRows = listMixtapeItemsByItemIds(sourcePlaylistId, sourceItemIds)
        for (const row of sourceRows) {
          const sourceItemId = normalizeText(row?.id)
          const parsedInfo = parseInfoJson(row?.infoJson)
          if (!sourceItemId || !parsedInfo) continue
          reusableInfoBySourceKey.set(`${sourcePlaylistId}::${sourceItemId}`, parsedInfo)
        }
      }
      const reusableAnalysisByFilePath = new Map<string, MixtapeAnalysisInfo>()
      const uniqueInputFilePaths = Array.from(
        new Set(
          inputItems
            .map((item) => normalizeText(item?.filePath))
            .filter((filePath) => isLikelyAudioFilePath(filePath))
        )
      )
      for (const filePath of uniqueInputFilePaths) {
        const candidateRows = listMixtapeItemsByFilePath(filePath)
        let bestAnalysisInfo: MixtapeAnalysisInfo | null = null
        let bestScore = -1
        for (const row of candidateRows) {
          const candidatePlaylistId = normalizeText(row?.playlistUuid)
          if (!candidatePlaylistId) continue
          if (resolvePlaylistMixMode(candidatePlaylistId) !== targetPlaylistMixMode) continue
          const analysisInfo = pickAnalysisInfo(parseInfoJson(row?.infoJson))
          if (!analysisInfo) continue
          const score =
            (hasReadyStemPaths(analysisInfo) ? 10 : 0) + (hasBpmReady(analysisInfo) ? 1 : 0)
          if (score < bestScore) continue
          bestScore = score
          bestAnalysisInfo = analysisInfo
        }
        if (bestAnalysisInfo) {
          reusableAnalysisByFilePath.set(filePath, bestAnalysisInfo)
        }
      }

      const normalizedItems: Array<{
        filePath: string
        originPlaylistUuid?: string | null
        originPathSnapshot?: string | null
        info?: MixtapeAnalysisInfo | null
      }> = []
      const filePathSet = new Set<string>()
      const bpmAnalyzeFilePathSet = new Set<string>()
      const stemEnqueueFilePathSet = new Set<string>()
      let skippedNoBpm = 0
      for (const item of inputItems) {
        const filePath = normalizeText(item?.filePath)
        if (!filePath) continue
        if (!isLikelyAudioFilePath(filePath)) {
          continue
        }
        const sourcePlaylistId =
          normalizeText(item?.sourcePlaylistId) || normalizeText(item?.originPlaylistUuid)
        const sourceItemId = normalizeText(item?.sourceItemId)
        const sourceInfo =
          sourcePlaylistId && sourceItemId
            ? reusableInfoBySourceKey.get(`${sourcePlaylistId}::${sourceItemId}`) || null
            : null
        const itemInfo = normalizeInfo(item?.info)
        const fallbackAnalysisInfo =
          sourceInfo || !reusableAnalysisByFilePath.has(filePath)
            ? null
            : reusableAnalysisByFilePath.get(filePath) || null
        const info = sourceInfo || mergeInfoWithAnalysis(itemInfo, fallbackAnalysisInfo)
        if (await noBpmGuard.shouldBlock(filePath, info)) {
          skippedNoBpm += 1
          continue
        }
        normalizedItems.push({
          filePath,
          originPlaylistUuid: item?.originPlaylistUuid || null,
          originPathSnapshot: item?.originPathSnapshot || null,
          info
        })
        filePathSet.add(filePath)
        if (!hasBpmReady(info)) {
          bpmAnalyzeFilePathSet.add(filePath)
        }
        if (!hasReadyStemPaths(info)) {
          stemEnqueueFilePathSet.add(filePath)
        }
      }
      const result = appendMixtapeItems(playlistId, normalizedItems)
      const filePaths = Array.from(filePathSet)
      if (filePaths.length > 0) {
        if (targetPlaylistMixMode === 'eq') {
          queueUnifiedDisplayWaveforms(filePaths)
        }
        if (targetPlaylistMixMode === 'stem') {
          queueMixtapeRawWaveforms(filePaths)
        }
        const stemEnqueueFilePaths = Array.from(stemEnqueueFilePathSet)
        if (stemEnqueueFilePaths.length > 0) {
          void enqueueMixtapeStemJobs({
            playlistId,
            filePaths: stemEnqueueFilePaths,
            stemMode: FIXED_MIXTAPE_STEM_MODE,
            profile: targetStemConfig.stemProfile
          }).catch((error) => {
            log.error('[mixtape-stem] enqueue after append failed', {
              playlistId,
              fileCount: stemEnqueueFilePaths.length,
              error
            })
          })
        }
        const bpmAnalyzeFilePaths = Array.from(bpmAnalyzeFilePathSet)
        if (bpmAnalyzeFilePaths.length > 0) {
          // 预分析 BPM（后台，不阻塞返回）
          void analyzeMixtapeBpmBatchShared(bpmAnalyzeFilePaths)
            .then(async (bpmResult) => {
              if (bpmResult.results.length > 0) {
                const analysisGridEntries = bpmResult.results.flatMap((item) => {
                  const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
                    bpm: item.bpm,
                    firstBeatMs: item.firstBeatMs,
                    downbeatBeatOffset: item.downbeatBeatOffset,
                    source: 'analysis'
                  })
                  return beatGridMap
                    ? [
                        {
                          filePath: item.filePath,
                          timeBasisOffsetMs: item.timeBasisOffsetMs,
                          beatGridMap,
                          beatGridAlgorithmVersion: item.beatGridAlgorithmVersion
                        }
                      ]
                    : []
                })
                const writableGridResults =
                  await resolveWritableSharedGridEntries(analysisGridEntries)
                if (!writableGridResults.length) return
                clearMixtapeItemGridCopiesByFilePath(writableGridResults)
                void persistAndBroadcastSharedGridEntries(writableGridResults)
                try {
                  mixtapeWindow.broadcast?.('mixtape-bpm-batch-ready', {
                    results: writableGridResults
                  })
                } catch {}
              }
            })
            .catch(() => {})
        }
      }
      return {
        ...result,
        skippedNoBpm
      }
    }
  )

  ipcMain.handle(
    'mixtape:remove',
    async (_e, payload: { playlistId?: string; filePaths?: string[]; itemIds?: string[] }) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const itemIds = Array.isArray(payload?.itemIds) ? payload.itemIds : []
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      if (itemIds.length > 0) {
        const removedPaths = listMixtapeFilePathsByItemIds(playlistId, itemIds)
        const result = removeMixtapeItemsById(playlistId, itemIds)
        await cleanupMixtapeWaveformCache(removedPaths)
        await cleanupOrphanedMixtapeVaultFiles(removedPaths)
        broadcastMixtapeItemsRemoved(_e.sender, {
          playlistId,
          itemIds,
          removedPaths,
          removed: Number(result?.removed || 0)
        })
        return result
      }
      const result = removeMixtapeItemsByFilePath(playlistId, filePaths)
      await cleanupMixtapeWaveformCache(filePaths)
      await cleanupOrphanedMixtapeVaultFiles(filePaths)
      broadcastMixtapeItemsRemoved(_e.sender, {
        playlistId,
        itemIds: [],
        removedPaths: filePaths,
        removed: Number(result?.removed || 0)
      })
      return result
    }
  )

  ipcMain.handle(
    'mixtape:reorder',
    async (_e, payload: { playlistId?: string; orderedIds?: string[] }) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const orderedIds = Array.isArray(payload?.orderedIds) ? payload.orderedIds : []
      return reorderMixtapeItems(playlistId, orderedIds)
    }
  )

  ipcMain.handle('mixtape:analyze-bpm', async (_e, payload: { filePaths?: string[] }) => {
    const input = Array.isArray(payload?.filePaths) ? payload.filePaths : []
    try {
      const result = await analyzeMixtapeBpmBatchShared(input)
      let writableGridResults: SharedSongGridDefinition[] = []
      if (result.results.length > 0) {
        const analysisGridEntries = result.results.flatMap((item) => {
          const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
            bpm: item.bpm,
            firstBeatMs: item.firstBeatMs,
            downbeatBeatOffset: item.downbeatBeatOffset,
            source: 'analysis'
          })
          return beatGridMap
            ? [
                {
                  filePath: item.filePath,
                  timeBasisOffsetMs: item.timeBasisOffsetMs,
                  beatGridMap,
                  beatGridAlgorithmVersion: item.beatGridAlgorithmVersion
                }
              ]
            : []
        })
        writableGridResults = await resolveWritableSharedGridEntries(analysisGridEntries)
        if (writableGridResults.length > 0) {
          clearMixtapeItemGridCopiesByFilePath(writableGridResults)
          await persistAndBroadcastSharedGridEntries(writableGridResults)
        }
      }
      return result.results.length > 0 ? { ...result, results: writableGridResults } : result
    } catch (error) {
      log.error('[mixtape] BPM analyze invoke failed', {
        requested: input.length,
        error: error instanceof Error ? error.message : String(error)
      })
      return {
        results: [],
        unresolved: input,
        unresolvedDetails: input.map((filePath) => ({ filePath, reason: 'invoke failed' }))
      }
    }
  })

  ipcMain.handle('mixtape:output', async (event, payload?: MixtapeOutputInput) => {
    const requestId = normalizeMixtapeOutputRequestId(payload)
    const control = createMixtapeOutputControl(requestId)
    mixtapeOutputControls.set(requestId, control)
    const timeout = setTimeout(() => {
      cancelMixtapeOutputControl(control, 'mixtape.outputTimeout')
    }, MIXTAPE_OUTPUT_TIMEOUT_MS)
    const sendProgress = (progress: MixtapeOutputProgressPayload) => {
      try {
        event.sender.send('mixtape-output:progress', progress)
      } catch {}
    }
    try {
      const result = await runMixtapeOutput({
        payload: payload || {},
        control,
        onProgress: sendProgress
      })
      sendProgress({
        stageKey: 'mixtape.outputProgressFinished',
        done: 100,
        total: 100,
        percent: 100
      })
      return {
        ok: true,
        ...result
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'common.error')
      sendProgress({
        stageKey: 'mixtape.outputProgressFailed',
        done: 100,
        total: 100,
        percent: 100
      })
      if (message !== 'mixtape.outputCancelled') {
        log.error('[mixtape-output] export failed', { message, error })
      }
      return {
        ok: false,
        error: message
      }
    } finally {
      clearTimeout(timeout)
      mixtapeOutputControls.delete(requestId)
    }
  })

  ipcMain.handle('mixtape:output:cancel', async (_event, payload?: { requestId?: string }) => {
    const requestId = normalizeMixtapeOutputRequestId(payload)
    const control = mixtapeOutputControls.get(requestId)
    if (!control) {
      return { canceled: false }
    }
    cancelMixtapeOutputControl(control)
    return { canceled: true }
  })

  ipcMain.handle('song:get-shared-grid-definition', async (_e, payload?: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return null
    return loadSharedSongGridDefinition(filePath)
  })

  ipcMain.handle(
    'mixtape:update-grid-definition',
    async (
      _e,
      payload: {
        filePath?: string
        beatGridMap?: SongBeatGridMapV2 | null
        enqueueAnalysis?: boolean
        rebuildWaveform?: boolean
      }
    ) => {
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      const hasBeatGridMapInput = Object.prototype.hasOwnProperty.call(payload || {}, 'beatGridMap')
      const nextBeatGridMap = normalizeSongBeatGridMapV2(payload?.beatGridMap, {
        allowSingleClip: true
      })
      if (!filePath || !hasBeatGridMapInput) {
        return { updated: 0 }
      }
      const result = clearMixtapeItemGridCopiesByFilePath([{ filePath }])
      await persistAndBroadcastSharedGridBatch(
        [
          {
            filePath,
            beatGridMap: nextBeatGridMap ?? null,
            beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION
          }
        ],
        'manual'
      )
      if (nextBeatGridMap) {
        if (payload?.enqueueAnalysis === false) {
          if (payload?.rebuildWaveform === true) {
            enqueueKeyAnalysis(filePath, 'low', {
              source: 'foreground',
              preemptible: true,
              category: 'waveform-preview',
              waveformOnly: true,
              includeStructure: false
            })
          }
        } else {
          enqueueKeyAnalysis(filePath, 'low', {
            source: 'foreground',
            preemptible: true,
            includeStructure: true
          })
        }
      }
      return result
    }
  )

  ipcMain.handle(
    'mixtape:update-gain-envelope',
    async (
      _e,
      payload?: {
        entries?: Array<{ itemId?: string; gainEnvelope?: Array<{ sec?: number; gain?: number }> }>
      }
    ) => {
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      return upsertMixtapeItemGainEnvelopeById(
        entries.map((item) => ({
          itemId: typeof item?.itemId === 'string' ? item.itemId : '',
          gainEnvelope: Array.isArray(item?.gainEnvelope)
            ? item.gainEnvelope
                .map((point) => ({
                  sec: Number(point?.sec),
                  gain: Number(point?.gain)
                }))
                .filter(
                  (point) =>
                    Number.isFinite(point.sec) &&
                    point.sec >= 0 &&
                    Number.isFinite(point.gain) &&
                    point.gain > 0
                )
            : []
        }))
      )
    }
  )

  ipcMain.handle(
    'mixtape:update-mix-envelope',
    async (
      _e,
      payload?: {
        param?: string
        entries?: Array<{ itemId?: string; gainEnvelope?: Array<{ sec?: number; gain?: number }> }>
      }
    ) => {
      const paramRaw = typeof payload?.param === 'string' ? payload.param.trim() : ''
      const supportedParams = new Set([
        'gain',
        'high',
        'mid',
        'low',
        'vocal',
        'inst',
        'bass',
        'drums',
        'volume'
      ])
      if (!supportedParams.has(paramRaw)) {
        return { updated: 0 }
      }
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      return upsertMixtapeItemMixEnvelopeById(
        paramRaw as
          'gain' | 'high' | 'mid' | 'low' | 'vocal' | 'inst' | 'bass' | 'drums' | 'volume',
        entries.map((item) => ({
          itemId: typeof item?.itemId === 'string' ? item.itemId : '',
          gainEnvelope: Array.isArray(item?.gainEnvelope)
            ? item.gainEnvelope
                .map((point) => ({
                  sec: Number(point?.sec),
                  gain: Number(point?.gain)
                }))
                .filter(
                  (point) =>
                    Number.isFinite(point.sec) &&
                    point.sec >= 0 &&
                    Number.isFinite(point.gain) &&
                    point.gain > 0
                )
            : []
        }))
      )
    }
  )

  ipcMain.handle(
    'mixtape:update-volume-mute-segments',
    async (
      _e,
      payload?: {
        entries?: Array<{
          itemId?: string
          segments?: Array<{ startSec?: number; endSec?: number }>
        }>
      }
    ) => {
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      return upsertMixtapeItemVolumeMuteSegmentsById(
        entries.map((item) => ({
          itemId: typeof item?.itemId === 'string' ? item.itemId : '',
          segments: Array.isArray(item?.segments)
            ? item.segments
                .map((segment) => ({
                  startSec: Number(segment?.startSec),
                  endSec: Number(segment?.endSec)
                }))
                .filter(
                  (segment) =>
                    Number.isFinite(segment.startSec) &&
                    segment.startSec >= 0 &&
                    Number.isFinite(segment.endSec) &&
                    segment.endSec > segment.startSec
                )
            : []
        }))
      )
    }
  )

  const handleUpdateTrackLoops = async (
    _e: unknown,
    payload?: {
      entries?: Array<{
        itemId?: string
        loopSegments?: Array<{
          startSec?: number
          endSec?: number
          repeatCount?: number
        }> | null
        loopSegment?: {
          startSec?: number
          endSec?: number
          repeatCount?: number
        } | null
      }>
    }
  ) => {
    const entries = Array.isArray(payload?.entries) ? payload.entries : []
    return upsertMixtapeItemLoopSegmentsById(
      entries.map((item) => ({
        itemId: typeof item?.itemId === 'string' ? item.itemId : '',
        loopSegments: Array.isArray(item?.loopSegments)
          ? item.loopSegments
              .map((segment) => ({
                startSec: Number(segment?.startSec),
                endSec: Number(segment?.endSec),
                repeatCount: Number(segment?.repeatCount)
              }))
              .filter(
                (segment) =>
                  Number.isFinite(segment.startSec) &&
                  Number.isFinite(segment.endSec) &&
                  Number.isFinite(segment.repeatCount)
              )
          : item?.loopSegment && typeof item.loopSegment === 'object'
            ? [
                {
                  startSec: Number(item.loopSegment.startSec),
                  endSec: Number(item.loopSegment.endSec),
                  repeatCount: Number(item.loopSegment.repeatCount)
                }
              ]
            : []
      }))
    )
  }

  ipcMain.handle('mixtape:update-track-loops', handleUpdateTrackLoops)
  ipcMain.handle('mixtape:update-track-loop', handleUpdateTrackLoops)

  ipcMain.handle(
    'mixtape:update-track-start-sec',
    async (
      _e,
      payload?: {
        entries?: Array<{
          itemId?: string
          startSec?: number
          masterTempo?: boolean
          originalBpm?: number
          laneIndex?: number
        }>
      }
    ) => {
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      return upsertMixtapeItemStartSecById(
        entries.map((item) => ({
          itemId: typeof item?.itemId === 'string' ? item.itemId : '',
          startSec: Number(item?.startSec),
          masterTempo: typeof item?.masterTempo === 'boolean' ? item.masterTempo : undefined,
          originalBpm: Number(item?.originalBpm),
          laneIndex: Number(item?.laneIndex)
        }))
      )
    }
  )
}
