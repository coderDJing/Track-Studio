import { computed, markRaw, ref } from 'vue'
import { RendererFilePathMap, RendererFilePathSet } from '@renderer/utils/filePathComparison'
import type { Ref } from 'vue'
import type { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import libraryUtils from '@renderer/utils/libraryUtils'
import {
  LANE_GAP,
  LANE_PADDING_TOP,
  MIXTAPE_SUMMARY_ZOOM,
  MIXTAPE_WAVEFORM_SUPERSAMPLE,
  MIXTAPE_WAVEFORM_Y_OFFSET,
  PRE_RENDER_RANGE_BUFFER,
  RAW_WAVEFORM_BATCH_SIZE,
  RAW_WAVEFORM_MIN_ZOOM,
  RAW_WAVEFORM_TARGET_RATE,
  RENDER_X_BUFFER_PX,
  SHOW_GRID_LINES,
  WAVEFORM_BATCH_SIZE,
  WAVEFORM_TILE_WIDTH,
  ZOOM_MIN
} from '@renderer/composables/mixtape/constants'
import type {
  MinMaxSample,
  MixtapeMixMode,
  MixtapeStemMode,
  MixtapeTrack,
  MixtapeWaveformStemId,
  RawWaveformData,
  RawWaveformLevel,
  SerializedTrackTempoSnapshot,
  StemWaveformData,
  TimelineLayoutSnapshot,
  TimelineRenderPayload,
  WaveformPreRenderTask
} from '@renderer/composables/mixtape/types'
import type { UnifiedDisplayWaveformDetailData } from '@shared/unifiedDisplayWaveform'
import { buildRawWaveformPyramid } from '@renderer/composables/mixtape/waveformPyramid'
import { drawStemWaveform } from '@renderer/composables/mixtape/waveformDraw'
import { drawUnifiedTimelineWaveform } from '@renderer/composables/mixtape/timelineUnifiedWaveform'
import { createTimelineRenderAndLoadModule } from '@renderer/composables/mixtape/timelineRenderAndLoad'
import { createTimelineInteractionsModule } from '@renderer/composables/mixtape/timelineInteractions'
import { createTimelineHelpersModule } from '@renderer/composables/mixtape/timelineHelpers'
import { createTimelineTransportAndDragModule } from '@renderer/composables/mixtape/timelineTransportAndDrag'
import { createTimelineWorkerBridgeModule } from '@renderer/composables/mixtape/timelineWorkerBridge'
import { createTimelineWatchAndMountModule } from '@renderer/composables/mixtape/timelineWatchAndMount'
import { setupTimelineVisualScaleLifecycle } from '@renderer/composables/mixtape/timelineVisualScaleLifecycle'
import { createTimelineViewportModule } from '@renderer/composables/mixtape/timelineViewport'
import {
  resolveTimelineScalableBaseHeightByTrackCount,
  TIMELINE_VISUAL_SCALE_MAX,
  TIMELINE_VISUAL_SCALE_MIN
} from '@renderer/composables/mixtape/timelineVisualScaleConfig'

type UseMixtapeTimelineOptions = {
  tracks: Ref<MixtapeTrack[]>
  bpmAnalysisActive: Ref<boolean>
  bpmAnalysisFailed: Ref<boolean>
  mixtapeMixMode: Ref<MixtapeMixMode>
  mixtapeStemMode: Ref<MixtapeStemMode>
  layoutScaleDeps?: Ref<unknown>[]
}

export const useMixtapeTimeline = (options: UseMixtapeTimelineOptions) => {
  const {
    tracks,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    mixtapeMixMode,
    mixtapeStemMode,
    layoutScaleDeps = []
  } = options
  const isStemMixMode = () => mixtapeMixMode.value === 'stem'
  const zoom = ref(ZOOM_MIN)
  const renderZoom = ref(ZOOM_MIN)
  const zoomTouched = ref(true)
  const timelineRootRef = ref<HTMLElement | null>(null)
  const rulerRef = ref<HTMLElement | null>(null)
  const timelineScrollRef = ref<InstanceType<typeof OverlayScrollbarsComponent> | null>(null)
  const timelineScrollWrapRef = ref<HTMLElement | null>(null)
  const timelineCanvasRef = ref<HTMLCanvasElement | null>(null)
  const timelineViewport = ref<HTMLElement | null>(null)
  const timelineWidth = ref(0)
  const timelineContentWidth = ref(0)
  const timelineScrollLeft = ref(0)
  const timelineScrollTop = ref(0)
  const timelineViewportWidth = ref(0)
  const timelineViewportHeight = ref(0)
  const timelineScrollWidth = ref(0)
  const timelineWorkerReady = ref(false)
  const isTimelinePanning = ref(false)
  const isTimelineZooming = ref(false)
  const timelineVisualScale = ref(1)
  const envelopePreviewRef = ref<HTMLElement | null>(null)
  const overviewRef = ref<HTMLElement | null>(null)
  const overviewWidth = ref(0)
  const isOverviewDragging = ref(false)
  const resolveTimelineScalableBaseHeight = () =>
    resolveTimelineScalableBaseHeightByTrackCount(tracks.value.length)
  let timelineOffscreenCanvas: OffscreenCanvas | null = null
  let timelineObserver: ResizeObserver | null = null
  let timelineViewportObserver: ResizeObserver | null = null
  let overviewObserver: ResizeObserver | null = null
  let timelineRootObserver: ResizeObserver | null = null
  let timelineScaleRaf = 0
  let waveformLoadTimer: ReturnType<typeof setTimeout> | null = null
  let timelineCanvasRaf = 0
  let waveformPreRenderToken = 0
  let waveformPreRenderCursor = 0
  let waveformPreRenderRaf = 0
  let waveformPreRenderTimer: ReturnType<typeof setTimeout> | null = null
  let waveformWorkerPreRenderTimer: ReturnType<typeof setTimeout> | null = null
  let waveformPreRenderQueue: WaveformPreRenderTask[] = []
  let waveformRenderWorker: Worker | null = null
  const waveformTilePending = new Set<string>()
  const waveformScratch = {
    canvas: null as HTMLCanvasElement | null,
    ctx: null as CanvasRenderingContext2D | null
  }
  const waveformDataMap = markRaw(
    new RendererFilePathMap<StemWaveformData | UnifiedDisplayWaveformDetailData | null>()
  )
  const waveformMinMaxCache = markRaw(
    new RendererFilePathMap<{
      source: StemWaveformData | UnifiedDisplayWaveformDetailData
      samples: MinMaxSample[]
    }>()
  )
  const timelineLayoutCache = markRaw(new Map<number, TimelineLayoutSnapshot>())
  const timelineLayoutVersion = ref(0)
  const rawWaveformDataMap = markRaw(new RendererFilePathMap<RawWaveformData | null>())
  const rawWaveformPyramidMap = markRaw(new RendererFilePathMap<RawWaveformLevel[]>())
  const waveformInflight = new RendererFilePathSet()
  const waveformQueuedMissing = new RendererFilePathSet()
  const rawWaveformInflight = new RendererFilePathSet()
  const waveformTileCache = markRaw(new Map<string, { source: CanvasImageSource; used: number }>())
  const waveformTileCacheIndex = markRaw(new RendererFilePathMap<Set<string>>())
  let waveformTileCacheTick = 0
  let waveformTileCacheLimit = 260
  const waveformVersion = ref(0)
  const preRenderState = ref({ active: false, total: 0, done: 0 })
  const preRenderPhase = ref<'idle' | 'tiles' | 'frames'>('idle')
  const preRenderTotals = ref({ tiles: 0, frames: 0 })
  let pendingFramePreRenderTasks: TimelineRenderPayload[] = []
  const waveformTileCacheTickRef = {
    get value() {
      return waveformTileCacheTick
    },
    set value(value: number) {
      waveformTileCacheTick = value
    }
  }
  const waveformTileCacheLimitRef = {
    get value() {
      return waveformTileCacheLimit
    },
    set value(value: number) {
      waveformTileCacheLimit = value
    }
  }
  const {
    clampZoomValue,
    normalizedZoom,
    normalizedRenderZoom,
    resolveRenderZoomLevel,
    alignZoomToRenderLevel,
    resolveGridBarWidth,
    resolveLaneHeightForZoom,
    resolveTimelineBufferId,
    laneHeight,
    laneIndices,
    resolveTrackTitle,
    formatTrackBpm,
    useHalfWaveform,
    resolveRenderPxPerSec,
    renderPxPerSec,
    useRawWaveform,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackTempoRatio,
    resolveTrackFirstBeatSeconds,
    resolveTrackFirstBeatMs,
    resolveTrackTimeMapSignature,
    resolveTrackGridSignature,
    resolveTrackRenderWidthPx,
    clearTimelineLayoutCache,
    forEachVisibleLayoutItem,
    buildSequentialLayoutForZoom,
    resolveTrackBlockStyle,
    resolveGainEnvelopePolyline,
    resolveOverviewTrackStyle,
    drawTrackGridLines,
    resolveWaveformListRoot,
    resolveTrackWaveformSources,
    resolveTrackWaveformFilePaths,
    resolveWaveformSubLaneMetrics,
    isRawWaveformLoading,
    computeTimelineDuration,
    isValidWaveformData,
    decodeRawWaveformData,
    resolveRawWaveformLevel,
    buildWaveformTileCacheKey,
    touchWaveformTileCache,
    registerWaveformTileCacheKey,
    disposeWaveformCacheEntry,
    pruneWaveformTileCache
  } = createTimelineHelpersModule({
    zoom,
    renderZoom,
    tracks,
    mixtapeMixMode,
    mixtapeStemMode,
    t,
    libraryUtils,
    waveformDataMap,
    rawWaveformDataMap,
    waveformInflight,
    rawWaveformInflight,
    waveformMinMaxCache,
    rawWaveformPyramidMap,
    timelineLayoutCache,
    timelineLayoutVersion,
    waveformVersion,
    overviewWidth,
    timelineVisualScale,
    waveformTileCache,
    waveformTileCacheIndex,
    waveformTileCacheTickRef,
    waveformTileCacheLimitRef
  })
  const timelineLayout = computed(() => {
    void timelineLayoutVersion.value
    return buildSequentialLayoutForZoom(normalizedRenderZoom.value)
  })
  const laneTracks = computed(() =>
    laneIndices.map((laneIndex) =>
      timelineLayout.value.layout.filter((item) => item.laneIndex === laneIndex)
    )
  )
  const {
    overviewViewportLeft,
    overviewViewportWidth,
    overviewViewportStyle,
    timelineScrollbarOptions,
    preRenderPercent
  } = createTimelineViewportModule({
    timelineViewportWidth,
    overviewWidth,
    timelineScrollWidth,
    timelineContentWidth,
    timelineLayout,
    timelineScrollLeft,
    preRenderState
  })

  const renderWaveformTileToCache = (task: WaveformPreRenderTask) => {
    const { ctx: render, tile, cacheKey } = task
    const width = Math.max(1, Math.floor(tile.width))
    const height = Math.max(1, Math.floor(render.laneHeight))
    const cachedCanvas = document.createElement('canvas')
    const cachedCtx = cachedCanvas.getContext('2d')
    if (!cachedCtx) return
    resizeCanvas(cachedCanvas, cachedCtx, width, height)
    renderWaveformTileContents(cachedCtx, width, height, render, tile)
    const existing = waveformTileCache.get(cacheKey)
    if (existing) {
      disposeWaveformCacheEntry(existing)
    }
    waveformTileCacheTick += 1
    waveformTileCache.set(cacheKey, { source: cachedCanvas, used: waveformTileCacheTick })
    registerWaveformTileCacheKey(render.waveformFilePath, cacheKey)
    pruneWaveformTileCache()
  }

  const resolvePreRenderZoomLevels = () => {
    const levels = new Set<number>()
    levels.add(resolveRenderZoomLevel(normalizedRenderZoom.value))
    if (MIXTAPE_SUMMARY_ZOOM > 0) {
      levels.add(resolveRenderZoomLevel(MIXTAPE_SUMMARY_ZOOM))
    }
    return Array.from(levels)
  }

  const resolvePreRenderRange = (
    currentZoomValue: number,
    targetZoomValue: number,
    totalWidth: number
  ) => {
    const viewport =
      (timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
      null
    const width = Math.max(0, Math.floor(viewport?.clientWidth || timelineViewportWidth.value))
    const scrollLeft = Math.max(
      0,
      Math.floor(viewport?.scrollLeft || timelineScrollLeft.value || 0)
    )
    const safeTotal = Math.max(0, Math.floor(totalWidth))
    if (!width || !Number.isFinite(width)) {
      return { start: 0, end: safeTotal }
    }
    const buffer = Math.round(width * PRE_RENDER_RANGE_BUFFER)
    const currentPx = resolveRenderPxPerSec(currentZoomValue)
    const targetPx = resolveRenderPxPerSec(targetZoomValue)
    const scale = currentPx > 0 ? targetPx / currentPx : 1
    const start = Math.max(0, Math.floor((scrollLeft - buffer) * scale))
    const end = Math.max(start, Math.ceil((scrollLeft + width + buffer) * scale))
    return { start, end: Math.min(Math.ceil(safeTotal), end) }
  }

  const buildWaveformPreRenderQueue = (): WaveformPreRenderTask[] => {
    const queue: WaveformPreRenderTask[] = []
    if (!tracks.value.length) return queue
    const pixelRatio = window.devicePixelRatio || 1
    const currentZoomValue = normalizedRenderZoom.value
    const levels = resolvePreRenderZoomLevels()
    for (const level of levels) {
      const renderZoomValue = resolveRenderZoomLevel(level)
      const snapshot = buildSequentialLayoutForZoom(renderZoomValue)
      const { totalWidth } = snapshot
      const range = resolvePreRenderRange(currentZoomValue, renderZoomValue, totalWidth)
      if (range.end <= range.start) continue
      forEachVisibleLayoutItem(snapshot, range.start, range.end, (item) => {
        const track = item.track
        const waveformSources = resolveTrackWaveformSources(track)
        if (!waveformSources.length) return
        const laneMetrics = resolveLaneHeightForZoom(renderZoomValue)
        const trackStartX = item.startX
        const trackEndX = trackStartX + item.width
        const visibleStart = Math.max(trackStartX, range.start)
        const visibleEnd = Math.min(trackEndX, range.end)
        if (visibleEnd <= visibleStart) return
        const localStart = visibleStart - trackStartX
        const localEnd = visibleEnd - trackStartX
        const tileStartIndex = Math.max(0, Math.floor(localStart / WAVEFORM_TILE_WIDTH))
        const tileEndIndex = Math.max(
          tileStartIndex,
          Math.floor(Math.max(0, localEnd - 1) / WAVEFORM_TILE_WIDTH)
        )

        for (const waveformSource of waveformSources) {
          const filePath = waveformSource.filePath
          if (!filePath) continue
          const data = waveformDataMap.get(filePath)
          const raw = rawWaveformDataMap.get(filePath)
          const isSummary = renderZoomValue <= MIXTAPE_SUMMARY_ZOOM + 0.0001
          if (!data && !raw && !isSummary) continue
          if (
            useRawWaveform.value &&
            renderZoomValue >= RAW_WAVEFORM_MIN_ZOOM &&
            !raw &&
            !isSummary
          ) {
            continue
          }
          const subLane = resolveWaveformSubLaneMetrics(
            laneMetrics,
            waveformSource.laneIndex,
            waveformSource.laneCount
          )
          const ctx = buildTrackRenderContext(track, {
            renderZoomValue,
            waveformFilePath: filePath,
            waveformStemId: waveformSource.stemId,
            laneHeight: subLane.height
          })
          if (!ctx.trackWidth || !Number.isFinite(ctx.trackWidth)) continue
          const height = Math.max(1, Math.floor(ctx.laneHeight))
          for (let tileIndex = tileStartIndex; tileIndex <= tileEndIndex; tileIndex += 1) {
            const tileStart = tileIndex * WAVEFORM_TILE_WIDTH
            const tileWidth = Math.max(0, Math.min(WAVEFORM_TILE_WIDTH, ctx.trackWidth - tileStart))
            if (!tileWidth) continue
            const cacheKey = buildWaveformTileCacheKey(
              filePath,
              waveformSource.stemId,
              tileIndex,
              renderZoomValue,
              Math.max(1, Math.floor(tileWidth)),
              height,
              pixelRatio,
              ctx.tempoSnapshot.signature
            )
            if (waveformTileCache.has(cacheKey) || waveformTilePending.has(cacheKey)) continue
            queue.push({
              ctx,
              tile: { index: tileIndex, start: tileStart, width: tileWidth },
              cacheKey
            })
          }
        }
      })
    }
    return queue
  }

  const processWaveformPreRenderQueue = (token: number) => {
    if (token !== waveformPreRenderToken) return
    const queue = waveformPreRenderQueue
    if (!queue.length) return
    const startTime = performance.now()
    const budget = 12
    while (waveformPreRenderCursor < queue.length && performance.now() - startTime < budget) {
      const task = queue[waveformPreRenderCursor]
      if (isStemMixMode() && waveformRenderWorker) {
        requestWaveformTileRender(task)
      } else {
        renderWaveformTileToCache(task)
      }
      waveformPreRenderCursor += 1
    }
    if (waveformPreRenderCursor < queue.length) {
      waveformPreRenderRaf = requestAnimationFrame(() => processWaveformPreRenderQueue(token))
    } else {
      waveformPreRenderQueue = []
      scheduleTimelineDraw()
    }
  }

  const startFullPreRender = () => {
    waveformPreRenderToken += 1
    waveformPreRenderCursor = 0
    waveformPreRenderQueue = buildWaveformPreRenderQueue()
    if (!waveformPreRenderQueue.length) return
    const targetLimit = waveformTileCache.size + waveformPreRenderQueue.length + 10
    if (targetLimit > waveformTileCacheLimit) {
      waveformTileCacheLimit = targetLimit
    }
    if (waveformPreRenderRaf) cancelAnimationFrame(waveformPreRenderRaf)
    waveformPreRenderRaf = requestAnimationFrame(() =>
      processWaveformPreRenderQueue(waveformPreRenderToken)
    )
  }

  const scheduleFullPreRender = () => {
    if (isStemMixMode() && timelineWorkerReady.value) return
    if (waveformPreRenderTimer) clearTimeout(waveformPreRenderTimer)
    waveformPreRenderTimer = setTimeout(() => {
      waveformPreRenderTimer = null
      startFullPreRender()
    }, 200)
  }

  const buildWorkerPreRenderTasks = () => {
    const tasks: Array<{
      cacheKey: string
      filePath: string
      stemId: MixtapeWaveformStemId
      zoom: number
      tileIndex: number
      tileStart: number
      tileWidth: number
      trackWidth: number
      durationSeconds: number
      tempoSnapshot: SerializedTrackTempoSnapshot
      laneHeight: number
      pixelRatio: number
      timeMapSignature?: string
    }> = []
    if (!tracks.value.length) return tasks
    const pixelRatio = window.devicePixelRatio || 1
    const currentZoomValue = normalizedRenderZoom.value
    const levels = resolvePreRenderZoomLevels()
    for (const level of levels) {
      const snapshot = buildSequentialLayoutForZoom(level)
      const { totalWidth } = snapshot
      const range = resolvePreRenderRange(currentZoomValue, level, totalWidth)
      if (range.end <= range.start) continue
      forEachVisibleLayoutItem(snapshot, range.start, range.end, (item) => {
        const track = item.track
        const waveformSources = resolveTrackWaveformSources(track)
        if (!waveformSources.length) return
        const laneMetrics = resolveLaneHeightForZoom(level)
        const trackStartX = item.startX
        const trackEndX = trackStartX + item.width
        const visibleStart = Math.max(trackStartX, range.start)
        const visibleEnd = Math.min(trackEndX, range.end)
        if (visibleEnd <= visibleStart) return
        const localStart = visibleStart - trackStartX
        const localEnd = visibleEnd - trackStartX
        const tileStartIndex = Math.max(0, Math.floor(localStart / WAVEFORM_TILE_WIDTH))
        const tileEndIndex = Math.max(
          tileStartIndex,
          Math.floor(Math.max(0, localEnd - 1) / WAVEFORM_TILE_WIDTH)
        )

        for (const waveformSource of waveformSources) {
          const filePath = waveformSource.filePath
          if (!filePath) continue
          const data = waveformDataMap.get(filePath)
          const raw = rawWaveformDataMap.get(filePath)
          const isSummary = level <= MIXTAPE_SUMMARY_ZOOM + 0.0001
          if (!data && !raw && !isSummary) continue
          if (useRawWaveform.value && level >= RAW_WAVEFORM_MIN_ZOOM && !raw && !isSummary) {
            continue
          }
          const subLane = resolveWaveformSubLaneMetrics(
            laneMetrics,
            waveformSource.laneIndex,
            waveformSource.laneCount
          )
          const ctx = buildTrackRenderContext(track, {
            renderZoomValue: level,
            waveformFilePath: filePath,
            waveformStemId: waveformSource.stemId,
            laneHeight: subLane.height
          })
          if (!ctx.trackWidth || !Number.isFinite(ctx.trackWidth)) continue
          const height = Math.max(1, Math.floor(ctx.laneHeight))
          for (let tileIndex = tileStartIndex; tileIndex <= tileEndIndex; tileIndex += 1) {
            const tileStart = tileIndex * WAVEFORM_TILE_WIDTH
            const tileWidth = Math.max(0, Math.min(WAVEFORM_TILE_WIDTH, ctx.trackWidth - tileStart))
            if (!tileWidth) continue
            const cacheKey = buildWaveformTileCacheKey(
              filePath,
              waveformSource.stemId,
              tileIndex,
              level,
              Math.max(1, Math.floor(tileWidth)),
              height,
              pixelRatio,
              ctx.tempoSnapshot.signature
            )
            tasks.push({
              cacheKey,
              filePath,
              stemId: waveformSource.stemId,
              zoom: level,
              tileIndex,
              tileStart,
              tileWidth,
              trackWidth: ctx.trackWidth,
              durationSeconds: ctx.sourceDurationSeconds,
              tempoSnapshot: ctx.tempoSnapshot,
              laneHeight: ctx.laneHeight,
              pixelRatio,
              timeMapSignature: ctx.tempoSnapshot.signature
            })
          }
        }
      })
    }
    return tasks
  }

  const buildWorkerFramePreRenderTasks = () => {
    const tasks: TimelineRenderPayload[] = []
    if (!tracks.value.length) return tasks
    const viewport =
      (timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
      null
    const widthPx = Math.max(0, Math.floor(viewport?.clientWidth || timelineViewportWidth.value))
    const heightPx = Math.max(0, Math.floor(viewport?.clientHeight || timelineViewportHeight.value))
    if (!widthPx || !heightPx) return tasks
    const startX = Math.round(viewport?.scrollLeft || timelineScrollLeft.value || 0)
    const startY = Math.round(viewport?.scrollTop || timelineScrollTop.value || 0)
    const levels = resolvePreRenderZoomLevels()
    for (const level of levels) {
      const payload = buildTimelineRenderPayload(widthPx, heightPx, startX, startY, level)
      if (payload) tasks.push(payload)
    }
    return tasks
  }

  const startWorkerPreRender = () => {
    if (!isStemMixMode()) return
    if (!timelineWorkerReady.value || !waveformRenderWorker) return
    if (!tracks.value.length) return
    if (preRenderState.value.active) {
      cancelWorkerPreRender()
    }
    const tileTasks = buildWorkerPreRenderTasks()
    const frameTasks = buildWorkerFramePreRenderTasks()
    if (!tileTasks.length && !frameTasks.length) return
    pendingFramePreRenderTasks = frameTasks
    preRenderTotals.value = { tiles: tileTasks.length, frames: frameTasks.length }
    preRenderState.value = {
      active: true,
      total: tileTasks.length + frameTasks.length,
      done: 0
    }
    if (tileTasks.length) {
      preRenderPhase.value = 'tiles'
      postWaveformWorkerMessage({ type: 'preRenderTiles', payload: { tasks: tileTasks } })
    } else {
      preRenderPhase.value = 'frames'
      postWaveformWorkerMessage({ type: 'preRenderFrames', payload: { tasks: frameTasks } })
    }
  }

  const scheduleWorkerPreRender = () => {
    if (!isStemMixMode()) return
    if (!timelineWorkerReady.value || !waveformRenderWorker) return
    if (waveformWorkerPreRenderTimer) clearTimeout(waveformWorkerPreRenderTimer)
    waveformWorkerPreRenderTimer = setTimeout(() => {
      waveformWorkerPreRenderTimer = null
      startWorkerPreRender()
    }, 300)
  }

  const cancelWorkerPreRender = () => {
    if (waveformWorkerPreRenderTimer) {
      clearTimeout(waveformWorkerPreRenderTimer)
      waveformWorkerPreRenderTimer = null
    }
    preRenderState.value = { active: false, total: 0, done: 0 }
    preRenderPhase.value = 'idle'
    preRenderTotals.value = { tiles: 0, frames: 0 }
    pendingFramePreRenderTasks = []
    postWaveformWorkerMessage({ type: 'cancelPreRender' })
  }

  const {
    isTrackDragging,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadSec,
    playheadVisible,
    followPlayheadEnabled,
    transportError,
    timelineDurationSec,
    playheadTimeLabel,
    overviewPlayheadStyle,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    handleTransportToggle,
    handleTransportPlayFromStart,
    handleTransportStop,
    handleRulerSeek,
    handleToggleFollowPlayhead,
    stopTransportForTrackChange,
    handleTrackDragStart,
    scheduleTransportPreload,
    cleanupTransportAndDrag,
    renderMixtapeOutputWav,
    setTransportMasterVolume
  } = createTimelineTransportAndDragModule({
    tracks,
    mixtapeMixMode,
    mixtapeStemMode,
    timelineLayout,
    normalizedRenderZoom,
    timelineScrollRef,
    timelineScrollLeft,
    timelineViewportWidth,
    isTimelinePanning,
    isOverviewDragging,
    rulerRef,
    buildSequentialLayoutForZoom,
    resolveRenderPxPerSec,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackTempoRatio,
    resolveTrackFirstBeatSeconds,
    computeTimelineDuration,
    scheduleFullPreRender,
    scheduleWorkerPreRender
  })

  const scheduleTimelineDrawBridgeRef: { value: null | (() => void) } = { value: null }
  const createBridgeRef = <T>(getter: () => T, setter: (value: T) => void) => ({
    get value() {
      return getter()
    },
    set value(value: T) {
      setter(value)
    }
  })
  const waveformRenderWorkerRef = createBridgeRef(
    () => waveformRenderWorker,
    (value: Worker | null) => (waveformRenderWorker = value)
  )
  const timelineOffscreenCanvasRef = createBridgeRef(
    () => timelineOffscreenCanvas,
    (value: OffscreenCanvas | null) => (timelineOffscreenCanvas = value)
  )
  const timelineObserverRef = createBridgeRef(
    () => timelineObserver,
    (value: ResizeObserver | null) => (timelineObserver = value)
  )
  const timelineViewportObserverRef = createBridgeRef(
    () => timelineViewportObserver,
    (value: ResizeObserver | null) => (timelineViewportObserver = value)
  )
  const overviewObserverRef = createBridgeRef(
    () => overviewObserver,
    (value: ResizeObserver | null) => (overviewObserver = value)
  )
  const timelineRootObserverRef = createBridgeRef(
    () => timelineRootObserver,
    (value: ResizeObserver | null) => (timelineRootObserver = value)
  )
  const timelineScaleRafRef = createBridgeRef(
    () => timelineScaleRaf,
    (value: number) => (timelineScaleRaf = value)
  )
  const pendingFramePreRenderTasksRef = createBridgeRef(
    () => pendingFramePreRenderTasks,
    (value: TimelineRenderPayload[]) => (pendingFramePreRenderTasks = value)
  )
  const waveformPreRenderRafRef = createBridgeRef(
    () => waveformPreRenderRaf,
    (value: number) => (waveformPreRenderRaf = value)
  )
  const waveformPreRenderCursorRef = createBridgeRef(
    () => waveformPreRenderCursor,
    (value: number) => (waveformPreRenderCursor = value)
  )
  const waveformPreRenderQueueRef = createBridgeRef(
    () => waveformPreRenderQueue,
    (value: WaveformPreRenderTask[]) => (waveformPreRenderQueue = value)
  )
  const {
    postWaveformWorkerMessage,
    clearWaveformTileCacheForFile,
    pushStemWaveformToWorker,
    pushRawWaveformToWorker,
    handleWaveformWorkerMessage,
    requestWaveformTileRender,
    initTimelineWorkerRenderer,
    buildTimelineRenderPayload,
    requestTimelineWorkerRender
  } = createTimelineWorkerBridgeModule({
    mixtapeMixMode,
    waveformRenderWorkerRef,
    timelineWorkerReady,
    timelineCanvasRef,
    timelineViewport,
    timelineOffscreenCanvasRef,
    waveformTileCache,
    waveformTileCacheIndex,
    waveformTilePending,
    waveformTileCacheTickRef,
    disposeWaveformCacheEntry,
    registerWaveformTileCacheKey,
    pruneWaveformTileCache,
    preRenderPhase,
    preRenderTotals,
    preRenderState,
    pendingFramePreRenderTasksRef,
    waveformPreRenderRafRef,
    waveformPreRenderCursorRef,
    waveformPreRenderQueueRef,
    scheduleWorkerPreRender,
    getScheduleTimelineDraw: () => scheduleTimelineDrawBridgeRef.value,
    buildSequentialLayoutForZoom,
    forEachVisibleLayoutItem,
    resolveTrackWaveformSources,
    resolveWaveformSubLaneMetrics,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatMs,
    resolveTrackTimeMapSignature,
    resolveTrackGridSignature,
    resolveRenderPxPerSec,
    resolveTimelineBufferId,
    resolveLaneHeightForZoom,
    clampZoomValue,
    normalizedRenderZoom,
    waveformVersion,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    SHOW_GRID_LINES,
    RENDER_X_BUFFER_PX,
    LANE_GAP,
    LANE_PADDING_TOP,
    MIXTAPE_WAVEFORM_Y_OFFSET
  })
  const timelineCanvasRafRef = createBridgeRef(
    () => timelineCanvasRaf,
    (value: number) => (timelineCanvasRaf = value)
  )
  const waveformLoadTimerRef = createBridgeRef(
    () => waveformLoadTimer,
    (value: ReturnType<typeof setTimeout> | null) => (waveformLoadTimer = value)
  )
  const waveformPreRenderTimerRef = createBridgeRef(
    () => waveformPreRenderTimer,
    (value: ReturnType<typeof setTimeout> | null) => (waveformPreRenderTimer = value)
  )
  const {
    scheduleTimelineDraw,
    resizeCanvas,
    buildTrackRenderContext,
    renderWaveformTileContents,
    scheduleWaveformDraw,
    scheduleWaveformLoad,
    handleWaveformUpdated
  } = createTimelineRenderAndLoadModule({
    mixtapeMixMode,
    requestTimelineWorkerRender,
    timelineWorkerReady,
    timelineCanvasRef,
    timelineScrollWrapRef,
    timelineScrollRef,
    timelineViewport,
    timelineViewportWidth,
    timelineScrollLeft,
    isTimelineZooming,
    timelineCanvasRafRef,
    normalizedRenderZoom,
    clampZoomValue,
    resolveLaneHeightForZoom,
    resolveGridBarWidth,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    computeTimelineDuration,
    resolveTrackFirstBeatMs,
    resolveTrackTimeMapSignature,
    resolveTrackRenderWidthPx,
    resolveRenderPxPerSec,
    resolveRawWaveformLevel,
    resolveWaveformSubLaneMetrics,
    useHalfWaveform,
    waveformDataMap,
    rawWaveformDataMap,
    waveformMinMaxCache,
    waveformScratch,
    waveformRenderWorker,
    waveformTileCache,
    waveformTileCacheTickRef,
    pushStemWaveformToWorker,
    pushRawWaveformToWorker,
    clearWaveformTileCacheForFile,
    buildRawWaveformPyramid,
    rawWaveformPyramidMap,
    decodeRawWaveformData,
    isValidWaveformData,
    tracks,
    resolveWaveformListRoot,
    resolveTrackWaveformSources,
    resolveTrackWaveformFilePaths,
    waveformInflight,
    waveformQueuedMissing,
    rawWaveformInflight,
    waveformLoadTimerRef,
    buildSequentialLayoutForZoom,
    forEachVisibleLayoutItem,
    buildWaveformTileCacheKey,
    requestWaveformTileRender,
    renderWaveformTileToCache,
    touchWaveformTileCache,
    drawTrackGridLines,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    RENDER_X_BUFFER_PX,
    LANE_GAP,
    LANE_PADDING_TOP,
    MIXTAPE_WAVEFORM_Y_OFFSET,
    SHOW_GRID_LINES,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    MIXTAPE_SUMMARY_ZOOM,
    RAW_WAVEFORM_MIN_ZOOM,
    RAW_WAVEFORM_TARGET_RATE,
    WAVEFORM_TILE_WIDTH,
    WAVEFORM_BATCH_SIZE,
    RAW_WAVEFORM_BATCH_SIZE,
    MIXTAPE_WAVEFORM_SUPERSAMPLE,
    drawUnifiedTimelineWaveform,
    drawStemWaveform,
    useRawWaveform,
    waveformVersion,
    transportPreloading
  })
  scheduleTimelineDrawBridgeRef.value = scheduleTimelineDraw
  const {
    applyRenderZoomImmediate,
    setZoomValue,
    updateTimelineWidth,
    startTimelineScrollSampler,
    handleTimelineWheel,
    handleTimelinePanStart,
    handleTimelineHorizontalPanStart,
    updateOverviewWidth,
    handleOverviewMouseDown,
    handleOverviewClick,
    setTimelineWheelTarget,
    cleanupInteractions
  } = createTimelineInteractionsModule({
    zoom,
    renderZoom,
    zoomTouched,
    normalizedZoom,
    resolveRenderZoomLevel,
    timelineScrollRef,
    timelineViewportWidth,
    timelineScrollWidth,
    timelineContentWidth,
    timelineScrollLeft,
    timelineScrollTop,
    timelineViewportHeight,
    timelineLayout,
    timelineWidth,
    isTimelinePanning,
    isTimelineZooming,
    envelopePreviewRef,
    isOverviewDragging,
    overviewRef,
    overviewWidth,
    overviewViewportLeft,
    overviewViewportWidth,
    alignZoomToRenderLevel,
    clampZoomValue,
    computeTimelineDuration,
    renderPxPerSec,
    scheduleTimelineDraw,
    scheduleWaveformLoad,
    scheduleFullPreRender
  })

  createTimelineWatchAndMountModule({
    tracks,
    mixtapeMixMode,
    mixtapeStemMode,
    resolveTrackWaveformFilePaths,
    resolveTrackGridSignature,
    isTrackDragging,
    bpmAnalysisActive,
    timelineDurationSec,
    playheadSec,
    renderPxPerSec,
    waveformVersion,
    stopTransportForTrackChange,
    clearTimelineLayoutCache,
    updateTimelineWidth,
    scheduleWaveformLoad,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    scheduleTimelineDraw,
    scheduleWaveformDraw,
    waveformRenderWorkerRef,
    handleWaveformWorkerMessage,
    pushStemWaveformToWorker,
    pushRawWaveformToWorker,
    waveformDataMap,
    rawWaveformDataMap,
    initTimelineWorkerRenderer,
    timelineScrollRef,
    setTimelineWheelTarget,
    timelineViewport,
    timelineObserverRef,
    timelineViewportObserverRef,
    overviewObserverRef,
    overviewRef,
    updateOverviewWidth,
    startTimelineScrollSampler,
    handleTimelineWheel,
    handleWaveformUpdated,
    scheduleTransportPreload
  })
  setupTimelineVisualScaleLifecycle({
    tracks,
    timelineRootRef,
    transportError,
    timelineVisualScale,
    layoutScaleDeps,
    resolveTimelineScalableBaseHeight,
    timelineVisualScaleMin: TIMELINE_VISUAL_SCALE_MIN,
    timelineVisualScaleMax: TIMELINE_VISUAL_SCALE_MAX,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    cleanupTransportAndDrag,
    timelineObserverRef,
    timelineViewportObserverRef,
    overviewObserverRef,
    timelineRootObserverRef,
    timelineScaleRafRef,
    setTimelineWheelTarget,
    handleWaveformUpdated,
    waveformLoadTimerRef,
    waveformPreRenderTimerRef,
    cancelWorkerPreRender,
    waveformPreRenderRafRef,
    waveformPreRenderQueueRef,
    waveformRenderWorkerRef,
    postWaveformWorkerMessage,
    timelineWorkerReady,
    timelineOffscreenCanvasRef,
    timelineCanvasRafRef,
    cleanupInteractions
  })

  return {
    clearTimelineLayoutCache,
    updateTimelineWidth,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    renderZoomLevel: normalizedRenderZoom,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatSeconds,
    laneIndices,
    laneHeight,
    laneTracks,
    resolveTrackBlockStyle,
    resolveGainEnvelopePolyline,
    resolveTrackTitle,
    formatTrackBpm,
    isRawWaveformLoading,
    preRenderState,
    preRenderPercent,
    timelineRootRef,
    rulerRef,
    timelineVisualScale,
    timelineScrollWrapRef,
    isTimelinePanning,
    handleTimelinePanStart,
    handleTimelineHorizontalPanStart,
    timelineScrollRef,
    timelineScrollbarOptions,
    timelineViewport,
    timelineContentWidth,
    timelineScrollLeft,
    timelineViewportWidth,
    timelineCanvasRef,
    envelopePreviewRef,
    overviewRef,
    isOverviewDragging,
    handleOverviewMouseDown,
    handleOverviewClick,
    resolveOverviewTrackStyle,
    overviewViewportStyle,
    scheduleWaveformDraw,
    handleTrackDragStart,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadVisible,
    playheadSec,
    followPlayheadEnabled,
    playheadTimeLabel,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    overviewPlayheadStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    handleTransportToggle,
    handleTransportPlayFromStart,
    handleTransportStop,
    handleRulerSeek,
    handleToggleFollowPlayhead,
    transportError,
    renderMixtapeOutputWav,
    setTransportMasterVolume,
    setZoomValue,
    applyRenderZoomImmediate
  }
}
