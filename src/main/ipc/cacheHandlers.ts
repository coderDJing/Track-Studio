import { ipcMain } from 'electron'
import { FIXED_MIXTAPE_STEM_MODE } from '../../shared/mixtapeStemMode'
import fs from 'node:fs/promises'
import path from 'node:path'
import { clearTrackCoreAnalysisForReanalysis, findSongListRoot } from '../services/cacheMaintenance'
import { getLibrary, resolveLibraryPath } from '../utils'
import * as LibraryCacheDb from '../libraryCacheDb'
import type { StemWaveformDataLite } from '../stemWaveformCache'
import { queueMixtapeWaveforms } from '../services/mixtapeWaveformQueue'
import { ensureMixtapeStemWaveformBundle } from '../services/mixtapeStemWaveformService'
import { registerMixtapeRawWaveformHandlers } from './mixtapeRawWaveformHandlers'
import mainWindow from '../window/mainWindow'
import { scheduleStartupLibraryTreeReconcile } from '../libraryTreeWatcher'
import { enqueueKeyAnalysisList, enqueueManualKeyAnalysisBatch } from '../services/keyAnalysisQueue'
import { isInRecordingLibraryAbsPath } from '../recordingLibraryService'
import { normalizeAnalysisBpmRangeId } from '../../shared/analysisBpmRange'
import {
  hasAnyTrackReanalysisUserSelection,
  isFullTrackReanalysisPlan,
  normalizeTrackReanalysisSelection,
  resolveTrackReanalysisPlan
} from '../../shared/trackReanalysisSelection'
import type { UnifiedDisplayWaveformDetailData } from '../../shared/unifiedDisplayWaveform'
import type {
  WaveformGlobalOverviewData,
  WaveformListPreviewData
} from '../../shared/waveformSurfaceCache'
import {
  assertLibraryMergeMutationAllowed,
  isLibraryMergeMutationLocked
} from '../services/libraryMerge/runtime'

type TrackCacheClearBatchPayload = {
  filePaths?: string[]
  selection?: unknown
  analysisBpmRangeId?: string
}

const normalizeClearBatchFilePaths = (payload: unknown) => {
  const rawPaths = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as TrackCacheClearBatchPayload).filePaths
      : []
  return Array.from(
    new Set(
      (Array.isArray(rawPaths) ? rawPaths : [])
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => p.trim())
    )
  )
}

type PlayerWaveformCacheItem = {
  filePath: string
  data: WaveformGlobalOverviewData | null
}

type SurfaceCacheLoadOptions = {
  queueIfMissing?: boolean
}

type CacheFileStatResult =
  | {
      status: 'ready'
      stat: { size: number; mtimeMs: number }
    }
  | {
      status: 'missing'
    }
  | {
      status: 'unavailable'
    }

const isMissingFileError = (error: unknown): boolean => {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : ''
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const readCacheFileStat = async (filePath: string): Promise<CacheFileStatResult> => {
  try {
    const fsStat = await fs.stat(filePath)
    return {
      status: 'ready',
      stat: { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    }
  } catch (error) {
    return { status: isMissingFileError(error) ? 'missing' : 'unavailable' }
  }
}

export function registerCacheHandlers() {
  registerMixtapeRawWaveformHandlers()

  const clearLegacyLargeWaveformCaches = async (listRoot: string, filePath: string) => {
    await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
    await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
    await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(listRoot, filePath)
  }

  const resolvePayloadListRoot = async (listRootRaw: string, filePath: string) => {
    let listRoot = ''
    if (listRootRaw) {
      try {
        let input = listRootRaw
        if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
        listRoot = path.isAbsolute(input) ? input : resolveLibraryPath(input).absPath
      } catch {
        listRoot = ''
      }
    }
    if (!listRoot) {
      listRoot = (await findSongListRoot(path.dirname(filePath))) || ''
    }
    return listRoot
  }

  const queueSurfaceAnalysis = (filePath: string, priority: 'low' | 'medium') => {
    if (isLibraryMergeMutationLocked()) return
    enqueueKeyAnalysisList([filePath], priority, {
      source: 'foreground',
      preemptible: true,
      category: 'waveform-preview',
      waveformOnly: true,
      includeStructure: false
    })
  }

  const loadListPreviewSurface = async (
    filePath: string,
    listRootRaw: string,
    priority: 'low' | 'medium',
    options: SurfaceCacheLoadOptions = {}
  ): Promise<WaveformListPreviewData | null> => {
    if (isLibraryMergeMutationLocked()) return null
    const listRoot = await resolvePayloadListRoot(listRootRaw, filePath)
    if (!listRoot) return null
    const statResult = await readCacheFileStat(filePath)
    if (statResult.status === 'missing') {
      await LibraryCacheDb.removeSongCacheEntry(listRoot, filePath)
      await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
      await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
      await LibraryCacheDb.removeWaveformSurfaceCacheEntry(listRoot, filePath)
      return null
    }
    if (statResult.status === 'unavailable') return null
    try {
      const data = await LibraryCacheDb.loadWaveformListPreviewCacheData(
        listRoot,
        filePath,
        statResult.stat
      )
      if (data) {
        await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
        await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
        return data
      }
      if (options.queueIfMissing === true) {
        await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
        await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
        queueSurfaceAnalysis(filePath, priority)
      }
      return null
    } catch {
      return null
    }
  }

  const loadGlobalOverviewSurface = async (
    filePath: string,
    listRootRaw: string,
    priority: 'low' | 'medium',
    options: SurfaceCacheLoadOptions = {}
  ): Promise<WaveformGlobalOverviewData | null> => {
    if (isLibraryMergeMutationLocked()) return null
    const listRoot = await resolvePayloadListRoot(listRootRaw, filePath)
    if (!listRoot) return null
    const statResult = await readCacheFileStat(filePath)
    if (statResult.status === 'missing') {
      await LibraryCacheDb.removeSongCacheEntry(listRoot, filePath)
      await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
      await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
      await LibraryCacheDb.removeWaveformSurfaceCacheEntry(listRoot, filePath)
      return null
    }
    if (statResult.status === 'unavailable') return null
    try {
      const data = await LibraryCacheDb.loadWaveformGlobalOverviewCacheData(
        listRoot,
        filePath,
        statResult.stat
      )
      if (data) {
        await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
        await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
        return data
      }
      if (options.queueIfMissing === true) {
        await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
        await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
        queueSurfaceAnalysis(filePath, priority)
      }
      return null
    } catch {
      return null
    }
  }

  ipcMain.handle(
    'track:cache:clear:batch',
    async (_e, payload: string[] | TrackCacheClearBatchPayload) => {
      assertLibraryMergeMutationAllowed()
      const files = normalizeClearBatchFilePaths(payload)
      const selection = normalizeTrackReanalysisSelection(
        Array.isArray(payload) ? undefined : payload?.selection
      )
      const plan = resolveTrackReanalysisPlan(selection)
      if (files.length === 0 || !hasAnyTrackReanalysisUserSelection(plan)) {
        return { cleared: 0, queued: 0, skipped: 0, skippedItems: [] }
      }

      const progressId = `reanalyze_${Date.now()}`
      const sendProgress = (now: number, dismiss = false) => {
        mainWindow.instance?.webContents.send('progressSet', {
          id: progressId,
          titleKey: 'tracks.clearingOldAnalysis',
          now,
          total: files.length,
          dismiss
        })
      }
      sendProgress(0)

      const clearedFiles: string[] = []
      const skippedItems: Array<{ filePath: string; reason: string }> = []
      for (let i = 0; i < files.length; i++) {
        const filePath = files[i]
        if (isInRecordingLibraryAbsPath(filePath)) {
          skippedItems.push({ filePath, reason: 'recording-library-unsupported' })
        } else {
          const result = await clearTrackCoreAnalysisForReanalysis(filePath, plan)
          if (result.status === 'cleared') {
            clearedFiles.push(result.filePath)
          } else {
            skippedItems.push({ filePath: result.filePath, reason: result.reason })
          }
        }
        const processed = i + 1
        if (processed % 10 === 0 || processed === files.length) {
          sendProgress(processed)
        }
      }

      if (clearedFiles.length > 0) {
        enqueueManualKeyAnalysisBatch(clearedFiles, {
          titleKey: 'tracks.reanalyzingTracks',
          forceAnalysis: isFullTrackReanalysisPlan(plan),
          analysisTargets: {
            key: plan.key,
            bpm: plan.beatGrid,
            waveform: plan.waveform,
            energy: plan.energy,
            structure: plan.structure
          },
          includeStructure: plan.structure,
          analysisBpmRangeId: plan.beatGrid
            ? normalizeAnalysisBpmRangeId(
                Array.isArray(payload) ? undefined : payload?.analysisBpmRangeId
              )
            : undefined
        })
      }

      sendProgress(files.length, true)
      return {
        cleared: clearedFiles.length,
        queued: clearedFiles.length,
        skipped: skippedItems.length,
        skippedItems
      }
    }
  )

  ipcMain.handle('getLibrary', async () => {
    return await getLibrary()
  })

  // 主窗口首屏只读 SQLite 中已持久化的树，不能在这里递归扫描音乐库。
  // renderer 绘制完后会通过 library-tree:startup-ready 触发一次后台磁盘核对。
  ipcMain.handle('getLibrary:cached', async () => {
    return await getLibrary({ skipSync: true, skipPreparation: true })
  })

  ipcMain.on('library-tree:startup-ready', (event) => {
    scheduleStartupLibraryTreeReconcile(event.sender)
  })

  ipcMain.handle(
    'unified-display-waveform-cache:load',
    async (
      _e,
      payload: {
        listRoot?: string
        filePath?: string
      }
    ) => {
      if (isLibraryMergeMutationLocked()) return { status: 'missing' as const, data: null }
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      if (!filePath) return { status: 'missing' as const, data: null }
      let listRoot = ''
      const listRootRaw = typeof payload?.listRoot === 'string' ? payload.listRoot.trim() : ''
      if (listRootRaw) {
        try {
          let input = listRootRaw
          if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
          listRoot = path.isAbsolute(input) ? input : resolveLibraryPath(input).absPath
        } catch {
          listRoot = ''
        }
      }
      if (!listRoot) {
        listRoot = (await findSongListRoot(path.dirname(filePath))) || ''
      }
      if (!listRoot) return { status: 'missing' as const, data: null }
      const statResult = await readCacheFileStat(filePath)
      if (statResult.status === 'missing') {
        await LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
        await clearLegacyLargeWaveformCaches(listRoot, filePath)
        return { status: 'missing' as const, data: null }
      }
      if (statResult.status === 'unavailable') {
        return { status: 'missing' as const, data: null }
      }
      try {
        const data = await LibraryCacheDb.loadUnifiedDisplayWaveformCacheData(
          listRoot,
          filePath,
          statResult.stat
        )
        if (data) {
          await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
          await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(listRoot, filePath)
          return { status: 'ready' as const, data }
        }
        await clearLegacyLargeWaveformCaches(listRoot, filePath)
        return { status: 'missing' as const, data: null }
      } catch {
        await LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
        await clearLegacyLargeWaveformCaches(listRoot, filePath)
        return { status: 'missing' as const, data: null }
      }
    }
  )

  ipcMain.handle(
    'unified-display-waveform-cache:batch',
    async (
      _e,
      payload: {
        listRoot?: string
        filePaths?: string[]
      }
    ) => {
      if (isLibraryMergeMutationLocked()) {
        return {
          items: [] as Array<{ filePath: string; data: UnifiedDisplayWaveformDetailData | null }>
        }
      }
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      const normalizedPaths = filePaths.filter(
        (filePath) => typeof filePath === 'string' && filePath.trim().length > 0
      )
      if (normalizedPaths.length === 0) {
        return {
          items: [] as Array<{ filePath: string; data: UnifiedDisplayWaveformDetailData | null }>
        }
      }

      const items: Array<{ filePath: string; data: UnifiedDisplayWaveformDetailData | null }> = []
      const listRootRaw = typeof payload?.listRoot === 'string' ? payload.listRoot.trim() : ''
      let resolvedListRoot = ''
      if (listRootRaw) {
        let input = listRootRaw
        if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
        if (path.isAbsolute(input)) {
          resolvedListRoot = input
        } else {
          resolvedListRoot = resolveLibraryPath(input).absPath
        }
      }
      for (const filePath of normalizedPaths) {
        let listRoot = resolvedListRoot
        if (!listRoot) {
          listRoot = (await findSongListRoot(path.dirname(filePath))) || ''
        }
        if (!listRoot) {
          items.push({ filePath, data: null })
          continue
        }
        try {
          const statResult = await readCacheFileStat(filePath)
          if (statResult.status === 'missing') {
            await LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
            await clearLegacyLargeWaveformCaches(listRoot, filePath)
            items.push({ filePath, data: null })
            continue
          }
          if (statResult.status === 'unavailable') {
            items.push({ filePath, data: null })
            continue
          }
          const data = await LibraryCacheDb.loadUnifiedDisplayWaveformCacheData(
            listRoot,
            filePath,
            statResult.stat
          )
          if (data) {
            await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
            await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(listRoot, filePath)
            items.push({ filePath, data })
            continue
          }
          await clearLegacyLargeWaveformCaches(listRoot, filePath)
          enqueueKeyAnalysisList([filePath], 'low', {
            source: 'foreground',
            preemptible: true,
            category: 'waveform-preview',
            waveformOnly: true
          })
          items.push({ filePath, data: null })
        } catch {
          await LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
          await clearLegacyLargeWaveformCaches(listRoot, filePath)
          items.push({ filePath, data: null })
        }
      }

      return { items }
    }
  )

  const handleGlobalOverviewLoad = async (payload: {
    listRoot?: string
    filePath?: string
    queueIfMissing?: boolean
  }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return { status: 'missing' as const, data: null }
    const listRootRaw = typeof payload?.listRoot === 'string' ? payload.listRoot.trim() : ''
    const data = await loadGlobalOverviewSurface(filePath, listRootRaw, 'medium', {
      queueIfMissing: payload?.queueIfMissing
    })
    return data ? { status: 'ready' as const, data } : { status: 'missing' as const, data: null }
  }

  const handleListPreviewBatch = async (payload: {
    listRoot?: string
    filePaths?: string[]
    queueIfMissing?: boolean
  }) => {
    const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
    const normalizedPaths = filePaths.filter(
      (filePath) => typeof filePath === 'string' && filePath.trim().length > 0
    )
    if (normalizedPaths.length === 0) {
      return { items: [] as Array<{ filePath: string; data: WaveformListPreviewData | null }> }
    }
    const items: Array<{ filePath: string; data: WaveformListPreviewData | null }> = []
    const listRootRaw = typeof payload?.listRoot === 'string' ? payload.listRoot.trim() : ''
    for (const filePath of normalizedPaths) {
      items.push({
        filePath,
        data: await loadListPreviewSurface(filePath, listRootRaw, 'low', {
          queueIfMissing: payload?.queueIfMissing
        })
      })
    }
    return { items }
  }

  const handleGlobalOverviewBatch = async (payload: {
    listRoot?: string
    filePaths?: string[]
    queueIfMissing?: boolean
  }) => {
    const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
    const normalizedPaths = filePaths.filter(
      (filePath) => typeof filePath === 'string' && filePath.trim().length > 0
    )
    if (normalizedPaths.length === 0) {
      return { items: [] as PlayerWaveformCacheItem[] }
    }
    const items: PlayerWaveformCacheItem[] = []
    const listRootRaw = typeof payload?.listRoot === 'string' ? payload.listRoot.trim() : ''
    for (const filePath of normalizedPaths) {
      items.push({
        filePath,
        data: await loadGlobalOverviewSurface(filePath, listRootRaw, 'low', {
          queueIfMissing: payload?.queueIfMissing
        })
      })
    }
    return { items }
  }

  ipcMain.handle(
    'waveform-list-preview-cache:load',
    async (_e, payload: { listRoot?: string; filePath?: string; queueIfMissing?: boolean }) => {
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      if (!filePath) return { status: 'missing' as const, data: null }
      const listRootRaw = typeof payload?.listRoot === 'string' ? payload.listRoot.trim() : ''
      const data = await loadListPreviewSurface(filePath, listRootRaw, 'medium', {
        queueIfMissing: payload?.queueIfMissing
      })
      return data ? { status: 'ready' as const, data } : { status: 'missing' as const, data: null }
    }
  )

  ipcMain.handle(
    'waveform-list-preview-cache:batch',
    async (_e, payload: { listRoot?: string; filePaths?: string[]; queueIfMissing?: boolean }) => {
      return await handleListPreviewBatch(payload)
    }
  )

  ipcMain.handle(
    'waveform-global-overview-cache:load',
    async (_e, payload: { listRoot?: string; filePath?: string; queueIfMissing?: boolean }) => {
      return await handleGlobalOverviewLoad(payload)
    }
  )

  ipcMain.handle(
    'waveform-global-overview-cache:batch',
    async (_e, payload: { listRoot?: string; filePaths?: string[]; queueIfMissing?: boolean }) => {
      return await handleGlobalOverviewBatch(payload)
    }
  )

  ipcMain.handle(
    'mixtape-stem-waveform-cache:batch',
    async (
      _e,
      payload: {
        items?: Array<{
          listRoot?: string
          sourceFilePath?: string
          stemMode?: typeof FIXED_MIXTAPE_STEM_MODE
          stemModel?: string
          stemVersion?: string
          stemPaths?: {
            vocalPath?: string
            instPath?: string
            bassPath?: string
            drumsPath?: string
          }
        }>
      }
    ) => {
      const requests = Array.isArray(payload?.items) ? payload.items : []
      if (!requests.length) {
        return {
          items: [] as Array<{
            sourceFilePath: string
            stems: Array<{ stemId: string; filePath: string; data: StemWaveformDataLite | null }>
          }>
        }
      }

      const items: Array<{
        sourceFilePath: string
        stems: Array<{ stemId: string; filePath: string; data: StemWaveformDataLite | null }>
      }> = []
      for (const request of requests) {
        const sourceFilePath =
          typeof request?.sourceFilePath === 'string' ? request.sourceFilePath.trim() : ''
        if (!sourceFilePath) {
          items.push({ sourceFilePath: '', stems: [] })
          continue
        }
        const stemMode = FIXED_MIXTAPE_STEM_MODE
        try {
          const result = await ensureMixtapeStemWaveformBundle({
            listRoot: typeof request?.listRoot === 'string' ? request.listRoot.trim() : '',
            sourceFilePath,
            stemMode,
            stemModel: request?.stemModel,
            stemVersion: request?.stemVersion,
            stemPaths: {
              vocalPath: request?.stemPaths?.vocalPath,
              instPath: request?.stemPaths?.instPath,
              bassPath: request?.stemPaths?.bassPath,
              drumsPath: request?.stemPaths?.drumsPath
            }
          })
          if (!result) {
            items.push({ sourceFilePath, stems: [] })
            continue
          }
          items.push({
            sourceFilePath: result.sourceFilePath,
            stems: result.stems.map((stem) => ({
              stemId: stem.stemId,
              filePath: stem.filePath,
              data: stem.data ?? null
            }))
          })
        } catch {
          items.push({ sourceFilePath, stems: [] })
        }
      }

      return { items }
    }
  )

  ipcMain.on(
    'mixtape-waveform:queue-visible',
    (_e, payload: { listRoot?: string; filePaths?: string[] }) => {
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      const normalizedPaths = filePaths.filter(
        (filePath) => typeof filePath === 'string' && filePath.trim().length > 0
      )
      if (normalizedPaths.length === 0) return
      const listRootRaw = typeof payload?.listRoot === 'string' ? payload.listRoot.trim() : ''
      let resolvedListRoot = ''
      try {
        if (listRootRaw) {
          let input = listRootRaw
          if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
          if (path.isAbsolute(input)) {
            resolvedListRoot = input
          } else {
            resolvedListRoot = resolveLibraryPath(input).absPath
          }
        }
      } catch {
        return
      }
      queueMixtapeWaveforms(normalizedPaths, resolvedListRoot || undefined)
    }
  )
}
