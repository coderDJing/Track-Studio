import { computed, markRaw, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type {
  IPioneerPreviewWaveformData,
  ISongInfo,
  ISongsAreaColumn
} from '../../../../../../types/globals'
import type { SongsAreaPaneKey } from '@renderer/stores/runtime'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import {
  getRekordboxPreviewWaveformStreamChannel,
  resolveSongExternalWaveformSource
} from '@renderer/utils/rekordboxExternalSource'
import { t } from '@renderer/utils/translate'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { WaveformListPreviewData } from '@shared/waveformSurfaceCache'
import type { RekordboxSourceKind } from '@shared/rekordboxSources'
import { createSongListWaveformPreviewWorker } from '@renderer/workers/songListWaveformPreview.workerClient'
import {
  drawSongListCompactVisualWaveform,
  drawSongListMixxxWaveform,
  drawSongListPioneerPreviewWaveform,
  drawSongListTimelineTicks,
  type SongListWaveformRgbMetricsCacheEntry
} from '@renderer/workers/songListWaveformPreview.shared'
import { resolveWaveformTimelineTickThemeVariant } from '@renderer/components/waveformTimelineTicks'
import type {
  SongListWaveformWorkerData,
  SongListWaveformWorkerIncoming
} from '@renderer/workers/songListWaveformPreview.types'
import {
  subscribePioneerPreviewWaveformDone,
  subscribePioneerPreviewWaveformItem,
  subscribeWaveformUpdated,
  type PioneerPreviewWaveformDoneHandler,
  type PioneerPreviewWaveformItemHandler,
  type WaveformUpdatedHandler
} from './waveformPreviewIpcSubscriptions'
import { createWaveformPreviewCanvasRegistry } from './waveformPreviewCanvasRegistry'
import { createWaveformPreviewRetry, type WaveformPlaceholderState } from './waveformPreviewRetry'
type VisibleSongItem = { song: ISongInfo; idx: number }
type WaveformCacheEntry =
  | {
      kind: 'mixxx'
      data: MixxxWaveformData
    }
  | {
      kind: 'pioneer'
      data: IPioneerPreviewWaveformData
    }
  | {
      kind: 'compactVisual'
      data: WaveformListPreviewData
    }
  | null
const PIONEER_WAVEFORM_EAGER_COUNT = 8
const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)
export function useWaveformPreview(params: {
  visibleSongsWithIndex: Ref<VisibleSongItem[]>
  visibleColumns: Ref<ISongsAreaColumn[]>
  sourceLibraryName: Ref<string>
  sourceSongListUUID: Ref<string>
  sourcePaneKey: Ref<SongsAreaPaneKey | ''>
  songListRootDir: Ref<string | undefined>
  externalWaveformRootPath: Ref<string | undefined>
  actualVisibleStartIndex: Ref<number>
  actualVisibleEndIndex: Ref<number>
  getAnalysisProgress?: (filePath: string) => number | null
  isSongNeedsAnalysis?: (filePath: string) => boolean
}) {
  const {
    visibleSongsWithIndex,
    visibleColumns,
    sourceLibraryName,
    sourceSongListUUID,
    sourcePaneKey,
    songListRootDir,
    externalWaveformRootPath,
    actualVisibleStartIndex,
    actualVisibleEndIndex,
    getAnalysisProgress,
    isSongNeedsAnalysis
  } = params
  const runtime = useRuntimeStore()
  const waveformColumn = computed(() =>
    visibleColumns.value.find((col) => col.key === 'waveformPreview')
  )
  const waveformVisible = computed(() => Boolean(waveformColumn.value))
  const waveformColumnWidth = computed(() => waveformColumn.value?.width ?? 0)
  const canUseAsyncWaveformWorker =
    typeof window !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'
  const normalizePath = (value: string | undefined | null) =>
    String(value || '')
      .replace(/\//g, '\\')
      .toLowerCase()
  const dataMap = markRaw(new Map<string, WaveformCacheEntry>())
  const placeholderStateMap = markRaw(new Map<string, WaveformPlaceholderState>())
  const placeholderReasonMap = markRaw(new Map<string, string>())
  const rgbMetricsCache = markRaw(new Map<string, SongListWaveformRgbMetricsCacheEntry>())
  const waveformDataVersionMap = markRaw(new Map<string, number>())
  const inflight = new Set<string>()
  const MAX_CACHE_ENTRIES = 200
  let loadTimer: ReturnType<typeof setTimeout> | null = null
  let drawRaf = 0
  let waveformWorker: Worker | null = null
  let drawAllVisiblePending = false
  let themeClassObserver: MutationObserver | null = null
  const pendingDrawFilePaths = new Set<string>()
  const previewActive = ref(false)
  const previewFilePath = ref<string | null>(null)
  const previewPercent = ref(0)
  const placeholderVersion = ref(0)
  let activePioneerStreamRequestId = ''
  const pioneerStreamFilePathMap = markRaw(new Map<string, string[]>())
  const useHalfWaveform = () => (runtime.setting?.waveformMode ?? 'half') !== 'full'
  const resolveExternalRootPath = () => String(externalWaveformRootPath.value || '').trim()
  const touchPlaceholderState = () => (placeholderVersion.value += 1)
  let waveformPreviewRetry: ReturnType<typeof createWaveformPreviewRetry> | null = null
  const ensureWaveformWorker = () => {
    if (!canUseAsyncWaveformWorker) return null
    if (waveformWorker) return waveformWorker
    waveformWorker = createSongListWaveformPreviewWorker()
    waveformWorker.addEventListener('error', (event) => {
      const message = event instanceof ErrorEvent ? event.message : 'unknown worker error'
      console.error('[song-list-waveform-worker] error', {
        message,
        filename: (event as ErrorEvent)?.filename,
        lineno: (event as ErrorEvent)?.lineno,
        colno: (event as ErrorEvent)?.colno
      })
    })
    waveformWorker.addEventListener('messageerror', () => {
      console.error('[song-list-waveform-worker] messageerror')
    })
    return waveformWorker
  }
  const waveformCanvasRegistry = createWaveformPreviewCanvasRegistry({
    canUseAsyncWaveformWorker,
    ensureWaveformWorker
  })
  const toWorkerData = (data: WaveformCacheEntry): SongListWaveformWorkerData => {
    if (!data) return null
    if (data.kind === 'pioneer') {
      return {
        kind: 'pioneer',
        data: data.data
      }
    }
    if (data.kind === 'compactVisual') {
      return {
        kind: 'compactVisual',
        data: data.data
      }
    }
    return {
      kind: 'mixxx',
      data: data.data
    }
  }
  const syncWaveformDataToWorker = (filePath: string, data: WaveformCacheEntry) => {
    if (!canUseAsyncWaveformWorker || !filePath) return
    const worker = ensureWaveformWorker()
    if (!worker) return
    const payload: SongListWaveformWorkerIncoming =
      data === null
        ? {
            type: 'clearData',
            payload: { filePath }
          }
        : {
            type: 'setData',
            payload: {
              filePath,
              data: toWorkerData(data)
            }
          }
    worker.postMessage(payload)
  }
  const getWaveformDataVersion = (filePath: string) =>
    waveformDataVersionMap.get(normalizePath(filePath)) ?? 0
  const resolveTimelineDurationSec = (filePath: string) => {
    const song = resolveVisibleSongByFilePath(filePath)
    return parseDurationToSeconds(song?.duration)
  }
  const renderWaveformWithWorker = (filePath: string) => {
    if (!canUseAsyncWaveformWorker) return
    const worker = ensureWaveformWorker()
    const canvasEntries = waveformCanvasRegistry.getCanvasEntriesForFilePath(filePath)
    if (!worker || canvasEntries.length === 0) return
    for (const [canvasId, canvas] of canvasEntries) {
      const computedStyle = typeof window !== 'undefined' ? getComputedStyle(canvas) : null
      const accent = computedStyle?.getPropertyValue('--accent') || ''
      const progressColor = accent.trim() || '#0078d4'
      const backgroundColor = computedStyle?.getPropertyValue('--waveform-bg').trim() || '#d9dee6'
      const playedPercent = isWaveformPreviewActive(filePath) ? clamp01(previewPercent.value) : 0
      const message: SongListWaveformWorkerIncoming = {
        type: 'render',
        payload: {
          canvasId,
          filePath,
          width: canvas.clientWidth || 1,
          height: canvas.clientHeight || 1,
          pixelRatio: window.devicePixelRatio || 1,
          isHalf: useHalfWaveform(),
          backgroundColor,
          progressColor,
          playedPercent,
          durationSec: resolveTimelineDurationSec(filePath),
          themeVariant: resolveWaveformTimelineTickThemeVariant(runtime.setting?.themeMode)
        }
      }
      worker.postMessage(message)
    }
  }
  const setWaveformCanvasRef = (
    canvasId: string,
    filePath: string,
    el: HTMLCanvasElement | null
  ) => {
    const result = waveformCanvasRegistry.setCanvasRef(canvasId, filePath, el)
    if (el) {
      if (result.attachedToWorker) {
        syncWaveformDataToWorker(filePath, dataMap.get(filePath) ?? null)
      }
      if (placeholderStateMap.get(filePath) === 'loading') {
        waveformPreviewRetry?.trackLoading(filePath)
      }
      scheduleDrawForFilePath(filePath)
    }
  }
  const getVisiblePaths = (): string[] => {
    const paths: string[] = []
    const seen = new Set<string>()
    for (const item of visibleSongsWithIndex.value || []) {
      const filePath = item?.song?.filePath
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      paths.push(filePath)
    }
    return paths
  }
  const getVisibleSongCanvasIdentity = (song?: ISongInfo | null) =>
    [song?.setItemId, song?.mixtapeItemId, song?.filePath]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(':')
  const resolveVisibleSongByFilePath = (filePath: string) => {
    const normalizedTargetPath = normalizePath(filePath)
    return (
      visibleSongsWithIndex.value.find(
        (item) => normalizePath(String(item?.song?.filePath || '')) === normalizedTargetPath
      )?.song || null
    )
  }
  const resolveWaveformListRootForFilePath = (filePath: string) => {
    const song = resolveVisibleSongByFilePath(filePath)
    const perSongRoot = String(song?.waveformPreviewListRoot || '').trim()
    if (perSongRoot) return perSongRoot
    return (songListRootDir.value || '').trim()
  }
  waveformPreviewRetry = createWaveformPreviewRetry({
    resolvePlaceholderState: (filePath) => placeholderStateMap.get(filePath),
    retryLoading: (filePath) => void fetchWaveformBatch([filePath])
  })
  const buildPioneerStreamRequestId = () =>
    `pioneer-waveform:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const resetPioneerStreamState = () => {
    for (const [, filePaths] of pioneerStreamFilePathMap) {
      for (const filePath of filePaths) {
        inflight.delete(filePath)
      }
    }
    activePioneerStreamRequestId = ''
    pioneerStreamFilePathMap.clear()
  }
  const orderPioneerRequestsForViewport = (
    requests: Array<{
      filePath: string
      analyzePath: string
      sourceKind: RekordboxSourceKind
    }>
  ) => {
    if (!requests.length) return requests
    const requestByFilePath = new Map(requests.map((request) => [request.filePath, request]))
    const eager: typeof requests = []
    const visibleRest: typeof requests = []
    const buffered: typeof requests = []
    let eagerCount = 0
    for (const item of visibleSongsWithIndex.value || []) {
      const filePath = String(item?.song?.filePath || '').trim()
      const request = requestByFilePath.get(filePath)
      if (!request) continue
      requestByFilePath.delete(filePath)
      const idx = Number(item.idx)
      const isActuallyVisible =
        idx >= actualVisibleStartIndex.value && idx < actualVisibleEndIndex.value
      if (isActuallyVisible && eagerCount < PIONEER_WAVEFORM_EAGER_COUNT) {
        eager.push(request)
        eagerCount += 1
      } else if (isActuallyVisible) {
        visibleRest.push(request)
      } else {
        buffered.push(request)
      }
    }
    const remainder = Array.from(requestByFilePath.values())
    return [...eager, ...visibleRest, ...buffered, ...remainder]
  }
  const getWaveformClickPercent = (filePath: string, clientX: number) => {
    const canvas = waveformCanvasRegistry.getCanvasEntriesForFilePath(filePath)[0]?.[1]
    if (!canvas) return 0
    const rect = canvas.getBoundingClientRect()
    if (!rect.width) return 0
    return clamp01((clientX - rect.left) / rect.width)
  }
  const requestWaveformPreview = (song: ISongInfo, startPercent: number) => {
    const filePath = typeof song?.filePath === 'string' ? song.filePath : ''
    if (!filePath) return
    emitter.emit('waveform-preview:play', {
      filePath,
      startPercent: clamp01(startPercent),
      song: { ...song },
      sourceLibraryName: String(sourceLibraryName.value || ''),
      sourceSongListUUID: String(sourceSongListUUID.value || ''),
      sourcePane: sourcePaneKey.value
    })
    previewActive.value = true
    previewFilePath.value = filePath
    previewPercent.value = clamp01(startPercent)
  }
  const requestWaveformPreviewAtSeconds = (song: ISongInfo, startSeconds: number) => {
    const durationSec = parseDurationToSeconds(song?.duration)
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      requestWaveformPreview(song, 0)
      return
    }
    requestWaveformPreview(song, clamp01((Number(startSeconds) || 0) / durationSec))
  }
  const stopWaveformPreview = () => {
    emitter.emit('waveform-preview:stop', { reason: 'explicit' })
  }
  const isWaveformPreviewActive = (filePath: string) =>
    previewActive.value && previewFilePath.value === filePath
  const getWaveformPreviewPlayheadStyle = (filePath: string) => {
    if (!isWaveformPreviewActive(filePath)) return {}
    const percent = clamp01(previewPercent.value)
    return {
      left: `${percent * 100}%`
    }
  }
  const setWaveformPlaceholderLoading = (filePath: string) => {
    if (!filePath) return
    placeholderStateMap.set(filePath, 'loading')
    placeholderReasonMap.delete(filePath)
    waveformPreviewRetry?.trackLoading(filePath)
    touchPlaceholderState()
  }
  const setWaveformPlaceholderUnavailable = (filePath: string, reason?: string) => {
    if (!filePath) return
    placeholderStateMap.set(filePath, 'unavailable')
    if (reason) {
      placeholderReasonMap.set(filePath, reason)
    } else {
      placeholderReasonMap.delete(filePath)
    }
    waveformPreviewRetry?.clear(filePath)
    touchPlaceholderState()
  }
  const setWaveformPlaceholderReady = (filePath: string) => {
    if (!filePath) return
    placeholderStateMap.set(filePath, 'ready')
    placeholderReasonMap.delete(filePath)
    waveformPreviewRetry?.clear(filePath)
    touchPlaceholderState()
  }
  const getWaveformPlaceholderText = (filePath: string) => {
    placeholderVersion.value
    const song = resolveVisibleSongByFilePath(filePath)
    if (song?.fileMissing) return ''

    if (
      !resolveSongExternalWaveformSource(song, {
        rootPath: resolveExternalRootPath(),
        sourceKind: runtime.pioneerDeviceLibrary.selectedSourceKind || undefined
      })
    ) {
      if (getAnalysisProgress) {
        const progress = getAnalysisProgress(filePath)
        if (progress != null) return ''
      }
      if (isSongNeedsAnalysis && isSongNeedsAnalysis(filePath)) {
        return ''
      }
    }

    const state = placeholderStateMap.get(filePath)
    if (state === 'loading') return t('tracks.waveformPreviewLoading')
    if (state === 'unavailable') {
      if (song?.externalSourceKind === 'desktop') {
        return t('rekordboxDesktop.analysisRequired')
      }
      return t('tracks.waveformPreviewUnavailable')
    }
    return ''
  }
  const getWaveformPlaceholderTitle = (filePath: string) => {
    placeholderVersion.value
    if (placeholderStateMap.get(filePath) !== 'unavailable') return ''
    return placeholderReasonMap.get(filePath) || ''
  }
  const clearWaveformDataForFilePath = (filePath: string) => {
    if (!filePath) return
    const normalizedPath = normalizePath(filePath)
    if (normalizedPath) {
      waveformDataVersionMap.set(normalizedPath, getWaveformDataVersion(filePath) + 1)
    }
    dataMap.delete(filePath)
    rgbMetricsCache.delete(filePath)
    inflight.delete(filePath)
    syncWaveformDataToWorker(filePath, null)
    if (canUseAsyncWaveformWorker) {
      waveformCanvasRegistry.clearWorkerCanvasesForFilePath(filePath)
    }
    setWaveformPlaceholderLoading(filePath)
  }
  const storeWaveformData = (filePath: string, data: WaveformCacheEntry) => {
    if (!filePath) return
    if (dataMap.has(filePath)) {
      dataMap.delete(filePath)
    }
    dataMap.set(filePath, data)
    syncWaveformDataToWorker(filePath, data)
    if (dataMap.size > MAX_CACHE_ENTRIES) {
      const oldest = dataMap.keys().next().value
      if (oldest) {
        dataMap.delete(oldest)
        rgbMetricsCache.delete(oldest)
        placeholderStateMap.delete(oldest)
        placeholderReasonMap.delete(oldest)
        waveformPreviewRetry?.clear(oldest)
        syncWaveformDataToWorker(oldest, null)
      }
    }
  }
  const resizeCanvas = (
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ) => {
    const pixelRatio = window.devicePixelRatio || 1
    const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
    const scaledHeight = Math.max(1, Math.floor(height * pixelRatio))
    if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
      canvas.width = scaledWidth
      canvas.height = scaledHeight
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.scale(pixelRatio, pixelRatio)
  }
  const drawWaveform = (filePath: string) => {
    if (canUseAsyncWaveformWorker) {
      renderWaveformWithWorker(filePath)
      return
    }
    for (const [, canvas] of waveformCanvasRegistry.getCanvasEntriesForFilePath(filePath)) {
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      const width = canvas.clientWidth || 1
      const height = canvas.clientHeight || 1
      resizeCanvas(canvas, ctx, width, height)
      const computedStyle = typeof window !== 'undefined' ? getComputedStyle(canvas) : null
      const backgroundColor = computedStyle?.getPropertyValue('--waveform-bg').trim() || '#d9dee6'
      ctx.fillStyle = backgroundColor
      ctx.fillRect(0, 0, width, height)
      const data = dataMap.get(filePath) ?? null
      const accent = computedStyle?.getPropertyValue('--accent') || ''
      const progressColor = accent.trim() || '#0078d4'
      const playedPercent = isWaveformPreviewActive(filePath) ? clamp01(previewPercent.value) : 0
      if (!data) {
        drawSongListTimelineTicks(ctx, width, height, {
          durationSec: resolveTimelineDurationSec(filePath),
          playedPercent,
          themeVariant: resolveWaveformTimelineTickThemeVariant(runtime.setting?.themeMode)
        })
        continue
      }
      if (data.kind === 'pioneer') {
        drawSongListPioneerPreviewWaveform(
          ctx,
          width,
          height,
          data.data,
          playedPercent,
          progressColor
        )
        continue
      }
      if (data.kind === 'compactVisual') {
        drawSongListCompactVisualWaveform(ctx, width, height, data.data, {
          isHalf: useHalfWaveform(),
          progressColor,
          playedPercent
        })
        continue
      }
      drawSongListMixxxWaveform(ctx, width, height, filePath, data.data, {
        isHalf: useHalfWaveform(),
        playedPercent,
        rgbMetricsCache
      })
    }
  }
  const drawVisible = () => {
    if (!waveformVisible.value) return
    const paths = getVisiblePaths()
    for (const filePath of paths) {
      drawWaveform(filePath)
    }
  }
  const drawTargets = (targets: Iterable<string>) => {
    for (const filePath of targets) {
      if (!filePath || !waveformCanvasRegistry.hasCanvasForFilePath(filePath)) continue
      drawWaveform(filePath)
    }
  }
  const scheduleDraw = (targets?: string | string[]) => {
    const queueTargets = () => {
      if (targets === undefined) {
        drawAllVisiblePending = true
        pendingDrawFilePaths.clear()
        return
      }
      const list = Array.isArray(targets) ? targets : [targets]
      if (!list.length || drawAllVisiblePending) return
      for (const filePath of list) {
        const normalizedFilePath = String(filePath || '').trim()
        if (!normalizedFilePath) continue
        pendingDrawFilePaths.add(normalizedFilePath)
      }
    }
    if (typeof requestAnimationFrame === 'undefined') {
      if (targets === undefined) {
        drawVisible()
        return
      }
      drawTargets(Array.isArray(targets) ? targets : [targets])
      return
    }
    queueTargets()
    if (drawRaf) return
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0
      if (drawAllVisiblePending) {
        drawAllVisiblePending = false
        pendingDrawFilePaths.clear()
        drawVisible()
      } else {
        const targetsToDraw = Array.from(pendingDrawFilePaths)
        pendingDrawFilePaths.clear()
        drawTargets(targetsToDraw)
      }
    })
  }
  const scheduleVisibleDraw = () => {
    scheduleDraw(getVisiblePaths())
  }
  const scheduleDrawForFilePath = (filePath: string) => {
    const normalizedFilePath = String(filePath || '').trim()
    if (!normalizedFilePath) return
    scheduleDraw(normalizedFilePath)
  }
  const scheduleDrawForFilePaths = (filePaths: string[]) => {
    if (!Array.isArray(filePaths) || !filePaths.length) return
    scheduleDraw(
      filePaths
        .map((filePath) => String(filePath || '').trim())
        .filter((filePath) => Boolean(filePath))
    )
  }
  const scheduleThemeDraw = () => {
    if (!waveformVisible.value) return
    nextTick(() => scheduleDraw())
  }
  const bindThemeClassObserver = () => {
    if (themeClassObserver || typeof MutationObserver === 'undefined') return
    if (typeof document === 'undefined') return
    const targets = [document.documentElement, document.body].filter(Boolean)
    if (!targets.length) return
    themeClassObserver = new MutationObserver(scheduleThemeDraw)
    for (const target of targets) {
      themeClassObserver.observe(target, {
        attributes: true,
        attributeFilter: ['class']
      })
    }
  }
  const fetchWaveformBatch = async (filePaths: string[]) => {
    if (!filePaths.length) return
    const requestVersions = new Map(
      filePaths.map((filePath) => [filePath, getWaveformDataVersion(filePath)])
    )
    for (const filePath of filePaths) {
      inflight.add(filePath)
      setWaveformPlaceholderLoading(filePath)
    }
    let response: {
      items?: Array<{ filePath: string; data: WaveformListPreviewData | null }>
    } | null = null
    try {
      const groups = new Map<string, string[]>()
      for (const filePath of filePaths) {
        const listRoot = resolveWaveformListRootForFilePath(filePath)
        const group = groups.get(listRoot) || []
        group.push(filePath)
        groups.set(listRoot, group)
      }
      const responses = await Promise.all(
        Array.from(groups.entries()).map(([listRoot, groupedFilePaths]) =>
          window.electron.ipcRenderer.invoke('waveform-list-preview-cache:batch', {
            listRoot,
            filePaths: groupedFilePaths,
            queueIfMissing: false
          })
        )
      )
      response = {
        items: responses.flatMap((item) => (Array.isArray(item?.items) ? item.items : []))
      }
    } catch {
      response = null
    }
    const items = Array.isArray(response?.items) ? response!.items : null
    if (!items) {
      for (const filePath of filePaths) {
        inflight.delete(filePath)
      }
      return
    }
    const itemMap = new Map(items.map((item) => [item.filePath, item.data ?? null]))
    const missing: string[] = []
    for (const filePath of filePaths) {
      if (getWaveformDataVersion(filePath) !== (requestVersions.get(filePath) ?? 0)) {
        inflight.delete(filePath)
        continue
      }
      const data = itemMap.has(filePath) ? itemMap.get(filePath) : null
      storeWaveformData(
        filePath,
        data
          ? {
              kind: 'compactVisual',
              data
            }
          : null
      )
      if (data) {
        setWaveformPlaceholderReady(filePath)
      } else {
        missing.push(filePath)
      }
      inflight.delete(filePath)
    }
    if (missing.length) {
      for (const filePath of missing) {
        setWaveformPlaceholderUnavailable(filePath)
      }
      missing
        .filter((filePath) => getAnalysisProgress?.(filePath) === null)
        .filter((filePath) => isSongNeedsAnalysis?.(filePath) !== true)
        .forEach((filePath) => waveformPreviewRetry?.retryMissingSoon(filePath))
    }
    scheduleDrawForFilePaths(filePaths)
  }
  const fetchExternalWaveformStream = async (
    requests: Array<{
      filePath: string
      analyzePath: string
      sourceKind: RekordboxSourceKind
    }>
  ) => {
    if (!requests.length) return
    const orderedRequests = orderPioneerRequestsForViewport(requests)
    const sourceKind = orderedRequests[0].sourceKind
    const rootPath = resolveExternalRootPath()
    if (!rootPath) {
      for (const request of orderedRequests) {
        inflight.delete(request.filePath)
      }
      return
    }
    resetPioneerStreamState()
    for (const request of orderedRequests) {
      inflight.add(request.filePath)
      setWaveformPlaceholderLoading(request.filePath)
    }
    const requestId = buildPioneerStreamRequestId()
    activePioneerStreamRequestId = requestId
    for (const request of orderedRequests) {
      const list = pioneerStreamFilePathMap.get(request.analyzePath) || []
      list.push(request.filePath)
      pioneerStreamFilePathMap.set(request.analyzePath, list)
    }
    try {
      window.electron.ipcRenderer.send(getRekordboxPreviewWaveformStreamChannel(sourceKind), {
        requestId,
        rootPath,
        analyzePaths: orderedRequests.map((request) => request.analyzePath)
      })
    } catch (error) {
      for (const request of orderedRequests) {
        inflight.delete(request.filePath)
      }
      resetPioneerStreamState()
      throw error
    }
  }
  const loadVisible = async () => {
    if (!waveformVisible.value) return
    const paths = getVisiblePaths()
    if (!paths.length) return
    const pending = paths.filter((filePath) => !dataMap.has(filePath) && !inflight.has(filePath))
    if (!pending.length) {
      scheduleVisibleDraw()
      return
    }
    const externalRequests: Array<{
      filePath: string
      analyzePath: string
      sourceKind: RekordboxSourceKind
    }> = []
    const libraryFilePaths: string[] = []
    const fallbackSourceKind = runtime.pioneerDeviceLibrary.selectedSourceKind || undefined
    for (const filePath of pending) {
      const song = resolveVisibleSongByFilePath(filePath)
      const source = resolveSongExternalWaveformSource(song, {
        rootPath: resolveExternalRootPath(),
        sourceKind: fallbackSourceKind
      })
      if (source) {
        externalRequests.push({
          filePath,
          analyzePath: source.analyzePath,
          sourceKind: source.sourceKind
        })
      } else if (resolveExternalRootPath()) {
        storeWaveformData(filePath, null)
        setWaveformPlaceholderUnavailable(filePath, 'missing analyze path')
      } else {
        libraryFilePaths.push(filePath)
      }
    }
    if (libraryFilePaths.length) {
      await fetchWaveformBatch(libraryFilePaths)
    }
    if (externalRequests.length) {
      await fetchExternalWaveformStream(externalRequests)
    }
  }
  const scheduleLoad = () => {
    if (loadTimer) clearTimeout(loadTimer)
    loadTimer = setTimeout(() => {
      loadTimer = null
      void loadVisible()
    }, 120)
  }
  const handleWaveformUpdated: WaveformUpdatedHandler = (_event, payload) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath || !waveformVisible.value) return
    const song = resolveVisibleSongByFilePath(filePath)
    const visibleFilePath = typeof song?.filePath === 'string' ? song.filePath : ''
    if (!visibleFilePath) return
    if (!waveformCanvasRegistry.hasCanvasForFilePath(visibleFilePath)) return
    if (
      resolveSongExternalWaveformSource(song, {
        rootPath: resolveExternalRootPath(),
        sourceKind: runtime.pioneerDeviceLibrary.selectedSourceKind || undefined
      })
    ) {
      return
    }
    clearWaveformDataForFilePath(visibleFilePath)
    void fetchWaveformBatch([visibleFilePath])
  }
  const handlePioneerPreviewWaveformItem: PioneerPreviewWaveformItemHandler = (_event, payload) => {
    const requestId = String(payload?.requestId || '').trim()
    if (!requestId || requestId !== activePioneerStreamRequestId) return
    const analyzePath = String(payload?.analyzePath || '').trim()
    if (!analyzePath) return
    const filePaths = pioneerStreamFilePathMap.get(analyzePath) || []
    if (!filePaths.length) return
    const data = payload?.data ?? null
    for (const filePath of filePaths) {
      storeWaveformData(
        filePath,
        data
          ? {
              kind: 'pioneer',
              data
            }
          : null
      )
      inflight.delete(filePath)
      if (data) {
        setWaveformPlaceholderReady(filePath)
      } else {
        setWaveformPlaceholderUnavailable(filePath, payload?.error ? String(payload.error) : '')
      }
    }
    pioneerStreamFilePathMap.delete(analyzePath)
    scheduleDrawForFilePaths(filePaths)
  }
  const handlePioneerPreviewWaveformDone: PioneerPreviewWaveformDoneHandler = (_event, payload) => {
    const requestId = String(payload?.requestId || '').trim()
    if (!requestId || requestId !== activePioneerStreamRequestId) return
    const affectedFilePaths = Array.from(pioneerStreamFilePathMap.values()).flat()
    for (const [, filePaths] of pioneerStreamFilePathMap) {
      for (const filePath of filePaths) {
        inflight.delete(filePath)
      }
    }
    for (const [, filePaths] of pioneerStreamFilePathMap) {
      for (const filePath of filePaths) {
        setWaveformPlaceholderUnavailable(
          filePath,
          payload?.error ? String(payload.error) : 'missing preview waveform item'
        )
      }
    }
    resetPioneerStreamState()
    scheduleDrawForFilePaths(affectedFilePaths)
  }
  const handleWaveformPreviewState = (payload: { filePath?: string; active?: boolean }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    const isActive = Boolean(payload?.active)
    if (!isActive) {
      const previousFilePath = previewFilePath.value
      if (!filePath || previewFilePath.value === filePath) {
        previewActive.value = false
        previewFilePath.value = null
        previewPercent.value = 0
      }
      if (previousFilePath) {
        drawWaveform(previousFilePath)
      }
      return
    }
    if (filePath) {
      previewActive.value = true
      previewFilePath.value = filePath
      drawWaveform(filePath)
    }
  }
  const handleWaveformPreviewProgress = (payload: { filePath?: string; percent?: number }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    if (!filePath) return
    const percentRaw = typeof payload?.percent === 'number' ? payload.percent : 0
    previewActive.value = true
    previewFilePath.value = filePath
    previewPercent.value = clamp01(percentRaw)
    drawWaveform(filePath)
  }
  watch(
    () =>
      visibleSongsWithIndex.value.map((item) => getVisibleSongCanvasIdentity(item.song)).join('|'),
    () => {
      if (!waveformVisible.value) return
      if (resolveExternalRootPath()) {
        resetPioneerStreamState()
      }
      scheduleLoad()
      nextTick(() => scheduleVisibleDraw())
    },
    { immediate: true }
  )
  watch(
    () => waveformVisible.value,
    (visible) => {
      if (!visible) return
      scheduleLoad()
      nextTick(() => scheduleVisibleDraw())
    }
  )
  watch(
    () => resolveExternalRootPath(),
    () => {
      resetPioneerStreamState()
      if (canUseAsyncWaveformWorker) {
        for (const filePath of dataMap.keys()) {
          syncWaveformDataToWorker(filePath, null)
        }
        waveformCanvasRegistry.clearWorkerCanvases()
      }
      dataMap.clear()
      inflight.clear()
      rgbMetricsCache.clear()
      placeholderStateMap.clear()
      placeholderReasonMap.clear()
      waveformPreviewRetry?.clearAll()
      if (!waveformVisible.value) return
      scheduleLoad()
      nextTick(() => scheduleVisibleDraw())
    }
  )
  watch(
    () => waveformColumnWidth.value,
    () => {
      if (!waveformVisible.value) return
      scheduleDraw()
    }
  )
  watch(
    () => runtime.setting?.waveformMode,
    () => {
      if (!waveformVisible.value) return
      scheduleDraw()
    }
  )
  watch(
    () => runtime.setting?.themeMode,
    () => {
      scheduleThemeDraw()
    },
    { flush: 'post' }
  )
  watch(
    () => runtime.setting?.accentColor,
    () => {
      scheduleThemeDraw()
    },
    { flush: 'post' }
  )
  const unsubscribeWaveformUpdated = subscribeWaveformUpdated(handleWaveformUpdated)
  const unsubscribePioneerPreviewWaveformItem = subscribePioneerPreviewWaveformItem(
    handlePioneerPreviewWaveformItem
  )
  const unsubscribePioneerPreviewWaveformDone = subscribePioneerPreviewWaveformDone(
    handlePioneerPreviewWaveformDone
  )
  bindThemeClassObserver()
  emitter.on('waveform-preview:state', handleWaveformPreviewState)
  emitter.on('waveform-preview:progress', handleWaveformPreviewProgress)
  onBeforeUnmount(() => {
    if (loadTimer) clearTimeout(loadTimer)
    if (drawRaf) cancelAnimationFrame(drawRaf)
    waveformPreviewRetry?.clearAll()
    themeClassObserver?.disconnect()
    themeClassObserver = null
    drawAllVisiblePending = false
    pendingDrawFilePaths.clear()
    resetPioneerStreamState()
    if (waveformWorker) {
      waveformWorker.terminate()
      waveformWorker = null
    }
    waveformCanvasRegistry.clear()
    unsubscribeWaveformUpdated()
    unsubscribePioneerPreviewWaveformItem()
    unsubscribePioneerPreviewWaveformDone()
    emitter.off('waveform-preview:state', handleWaveformPreviewState)
    emitter.off('waveform-preview:progress', handleWaveformPreviewProgress)
  })
  return {
    setWaveformCanvasRef,
    getWaveformClickPercent,
    requestWaveformPreview,
    requestWaveformPreviewAtSeconds,
    stopWaveformPreview,
    isWaveformPreviewActive,
    getWaveformPreviewPlayheadStyle,
    getWaveformPlaceholderText,
    getWaveformPlaceholderTitle
  }
}
const parseDurationToSeconds = (input: unknown) => {
  const raw = String(input || '').trim()
  if (!raw) return 0
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) || 0)
  const parts = raw
    .split(':')
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part))
  if (!parts.length) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0]
}
