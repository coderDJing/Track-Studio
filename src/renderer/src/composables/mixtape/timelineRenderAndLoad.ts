import { RendererFilePathMap } from '@renderer/utils/filePathComparison'
import type { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { MIXTAPE_WAVEFORM_HEIGHT_SCALE } from '@renderer/composables/mixtape/constants'
import type { UnifiedDisplayWaveformDetailData } from '@shared/unifiedDisplayWaveform'
import { normalizeUnifiedDisplayWaveformData } from '@renderer/composables/horizontalBrowse/horizontalBrowseCompactVisualWaveform'
import type {
  MinMaxSample,
  MixtapeMixMode,
  MixtapeTrack,
  MixtapeWaveformStemId,
  RawWaveformData,
  RawWaveformLevel,
  StemWaveformData,
  TimelineLayoutSnapshot,
  TimelineTrackLayout,
  WaveformRenderContext,
  WaveformPreRenderTask,
  WaveformTile
} from '@renderer/composables/mixtape/types'
import type { TimelineWaveformData } from '@renderer/composables/mixtape/timelineRenderAndLoadTypes'
import {
  buildTrackRuntimeTempoSnapshot,
  serializeTrackRuntimeTempoSnapshot
} from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import { resolveMixtapeTrackLoopTileSections } from '@renderer/composables/mixtape/mixtapeTrackLoop'
import { createTrackTimeMapFromSnapshotPayload } from '@renderer/composables/mixtape/trackTimeMapFactory'
import { createTimelineWaveformLoadingModule } from '@renderer/composables/mixtape/timelineWaveformLoading'
import { resizeCanvasWithScaleMetrics } from '@renderer/utils/canvasScale'

type ValueRef<T> = {
  value: T
}
type TimelineScrollHost = InstanceType<typeof OverlayScrollbarsComponent>

type WaveformCacheEntry = {
  source: CanvasImageSource
  used: number
}

type TimelineWaveformSource = {
  filePath: string
  listRoot?: string
  laneIndex: number
  laneCount: number
  stemId: MixtapeWaveformStemId
}

type TimelineRenderAndLoadContext = {
  mixtapeMixMode: ValueRef<MixtapeMixMode>
  requestTimelineWorkerRender: (
    widthPx: number,
    heightPx: number,
    startX: number,
    startY: number
  ) => void
  timelineWorkerReady: ValueRef<boolean>
  timelineCanvasRef: ValueRef<HTMLCanvasElement | null>
  timelineScrollWrapRef: ValueRef<HTMLElement | null>
  timelineScrollRef: ValueRef<TimelineScrollHost | null>
  timelineViewport: ValueRef<HTMLElement | null>
  timelineViewportWidth: ValueRef<number>
  timelineScrollLeft: ValueRef<number>
  isTimelineZooming: ValueRef<boolean>
  timelineCanvasRafRef: ValueRef<number>
  normalizedRenderZoom: ValueRef<number>
  waveformLoadTimerRef: ValueRef<ReturnType<typeof setTimeout> | null>
  clampZoomValue: (value: number) => number
  resolveLaneHeightForZoom: (value: number) => number
  resolveGridBarWidth: (zoomValue: number) => number
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  computeTimelineDuration: () => number
  resolveTrackFirstBeatMs: (track: MixtapeTrack) => number
  resolveTrackTimeMapSignature: (track: MixtapeTrack, durationSec?: number) => string
  resolveTrackRenderWidthPx: (track: MixtapeTrack, zoomValue?: number) => number
  resolveRenderPxPerSec: (value: number) => number
  resolveRawWaveformLevel: (
    filePath: string,
    raw: RawWaveformData | null,
    samplesPerPixel: number
  ) => RawWaveformData | null
  resolveWaveformSubLaneMetrics: (
    laneHeight: number,
    laneIndex: number,
    laneCount: number
  ) => { offset: number; height: number }
  useHalfWaveform: () => boolean
  isValidWaveformData: (data: TimelineWaveformData | null) => data is TimelineWaveformData
  waveformMinMaxCache: Map<string, { source: TimelineWaveformData; samples: MinMaxSample[] }>
  waveformScratch: {
    canvas: HTMLCanvasElement | null
    ctx: CanvasRenderingContext2D | null
  }
  waveformRenderWorker: Worker | null
  waveformTileCache: Map<string, WaveformCacheEntry>
  waveformTileCacheTickRef: ValueRef<number>
  clearWaveformTileCacheForFile: (filePath: string) => void
  pushStemWaveformToWorker: (filePath: string, data: StemWaveformData | null) => void
  pushRawWaveformToWorker: (filePath: string, data: RawWaveformData | null) => void
  decodeRawWaveformData: (payload: unknown) => RawWaveformData | null
  buildWaveformTileCacheKey: (
    filePath: string,
    stemId: MixtapeWaveformStemId,
    tileIndex: number,
    zoomValue: number,
    width: number,
    height: number,
    pixelRatio: number,
    timeMapSignature?: string
  ) => string
  requestWaveformTileRender: (task: WaveformPreRenderTask) => void
  renderWaveformTileToCache: (task: WaveformPreRenderTask) => void
  touchWaveformTileCache: (key: string) => void
  resolveTrackWaveformSources: (track: MixtapeTrack) => TimelineWaveformSource[]
  resolveTrackWaveformFilePaths: (track: MixtapeTrack) => string[]
  resolveWaveformListRoot: (track: MixtapeTrack) => string
  tracks: ValueRef<MixtapeTrack[]>
  waveformDataMap: Map<string, TimelineWaveformData | null>
  rawWaveformDataMap: Map<string, RawWaveformData | null>
  waveformInflight: Set<string>
  waveformQueuedMissing: Set<string>
  rawWaveformInflight: Set<string>
  rawWaveformPyramidMap: Map<string, RawWaveformLevel[]>
  waveformVersion: ValueRef<number>
  buildRawWaveformPyramid: (raw: RawWaveformData) => RawWaveformLevel[]
  buildSequentialLayoutForZoom: (zoomValue: number) => TimelineLayoutSnapshot
  forEachVisibleLayoutItem: (
    snapshot: TimelineLayoutSnapshot,
    visibleStart: number,
    visibleEnd: number,
    iteratee: (item: TimelineTrackLayout) => void
  ) => void
  drawTrackGridLines: (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    track: MixtapeTrack,
    trackStartSec: number,
    renderPxPerSec: number,
    downbeatBeatOffset: number,
    range: { start: number; end: number },
    barWidth: number
  ) => void
  LANE_GAP: number
  LANE_PADDING_TOP: number
  MIXTAPE_WAVEFORM_Y_OFFSET: number
  SHOW_GRID_LINES: boolean
  RENDER_X_BUFFER_PX: number
  bpmAnalysisActive: ValueRef<boolean>
  bpmAnalysisFailed: ValueRef<boolean>
  transportPreloading: ValueRef<boolean>
  MIXTAPE_SUMMARY_ZOOM: number
  RAW_WAVEFORM_MIN_ZOOM: number
  RAW_WAVEFORM_TARGET_RATE: number
  WAVEFORM_TILE_WIDTH: number
  WAVEFORM_BATCH_SIZE: number
  RAW_WAVEFORM_BATCH_SIZE: number
  MIXTAPE_WAVEFORM_SUPERSAMPLE: number
  scheduleFullPreRender: () => void
  scheduleWorkerPreRender: () => void
  drawUnifiedTimelineWaveform: (params: {
    ctx: CanvasRenderingContext2D
    width: number
    height: number
    data: UnifiedDisplayWaveformDetailData
    startTime: number
    endTime: number
    isHalf: boolean
  }) => boolean
  drawStemWaveform: (...args: unknown[]) => void
  useRawWaveform: ValueRef<boolean>
}

export const createTimelineRenderAndLoadModule = (ctx: TimelineRenderAndLoadContext) => {
  const {
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
    resolveTrackRenderWidthPx,
    resolveRenderPxPerSec,
    resolveRawWaveformLevel,
    resolveTrackWaveformFilePaths,
    resolveWaveformSubLaneMetrics,
    useHalfWaveform,
    waveformDataMap,
    rawWaveformDataMap,
    waveformMinMaxCache,
    waveformScratch,
    waveformRenderWorker,
    waveformTileCache,
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
    transportPreloading,
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
    waveformVersion
  } = ctx
  const isStemMixMode = () => mixtapeMixMode?.value !== 'eq'
  // Stem 场景先用低分辨率预览波形兜底，raw 波形继续按可见区细化
  const ENABLE_STEM_PREVIEW_WAVEFORM = true
  const isStemWaveformData = (value: unknown): value is StemWaveformData =>
    Boolean(value && typeof value === 'object' && (value as StemWaveformData).all)
  const isUnifiedWaveformData = (value: unknown): value is UnifiedDisplayWaveformDetailData =>
    Boolean(
      value && typeof value === 'object' && (value as UnifiedDisplayWaveformDetailData).height
    )

  const resolveTrackContentTop = () => {
    const root = timelineViewport?.value || null
    const lanes = root?.querySelector?.('.timeline-lanes') as HTMLElement | null
    return Math.max(0, Math.round(Number(lanes?.offsetTop) || 0))
  }

  const getTimelineCanvasRaf = () => Number(timelineCanvasRafRef.value || 0)
  const setTimelineCanvasRaf = (value: number) => {
    timelineCanvasRafRef.value = value
  }
  const getWaveformLoadTimer = () =>
    waveformLoadTimerRef.value as ReturnType<typeof setTimeout> | null
  const setWaveformLoadTimer = (value: ReturnType<typeof setTimeout> | null) => {
    waveformLoadTimerRef.value = value
  }
  const RAW_VISIBLE_BUFFER_PX = Math.max(WAVEFORM_TILE_WIDTH, Math.round(RENDER_X_BUFFER_PX * 1.5))
  const RAW_BATCH_MAX_CONCURRENT = 2
  const isTransportPreloadingActive = () => Boolean(transportPreloading?.value)
  const drawTimelineCanvas = () => {
    const canvas = timelineCanvasRef.value
    const wrap = timelineScrollWrapRef.value
    const viewport =
      (timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
      null
    if (!canvas || !wrap || !viewport) return
    const width = viewport.clientWidth || 0
    const height = viewport.clientHeight || 0
    if (!width || !height) return
    const wrapRect = wrap.getBoundingClientRect()
    const viewRect = viewport.getBoundingClientRect()
    const left = Math.max(0, viewRect.left - wrapRect.left)
    const top = Math.max(0, viewRect.top - wrapRect.top)
    const widthPx = Math.max(0, Math.floor(width))
    const heightPx = Math.max(0, Math.floor(height))
    if (canvas.style.left !== `${left}px`) canvas.style.left = `${left}px`
    if (canvas.style.top !== `${top}px`) canvas.style.top = `${top}px`
    if (canvas.style.width !== `${widthPx}px`) canvas.style.width = `${widthPx}px`
    if (canvas.style.height !== `${heightPx}px`) canvas.style.height = `${heightPx}px`
    const startX = Math.max(0, Number(viewport.scrollLeft || 0))
    const startY = Math.max(0, Number(viewport.scrollTop || 0))

    if (isStemMixMode() && timelineWorkerReady.value) {
      requestTimelineWorkerRender(widthPx, heightPx, startX, startY)
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    resizeCanvas(canvas, ctx, widthPx, heightPx)
    const endX = startX + widthPx
    const renderStartX = Math.max(0, Math.floor(startX - RENDER_X_BUFFER_PX))
    const renderEndX = Math.max(renderStartX, Math.ceil(endX + RENDER_X_BUFFER_PX))
    const zoomValue = normalizedRenderZoom.value
    const laneH = resolveLaneHeightForZoom(zoomValue)
    if (!laneH || laneH <= 0) return
    const laneStride = laneH + LANE_GAP
    const trackContentTop = resolveTrackContentTop()
    const lanePaddingTop = LANE_PADDING_TOP + MIXTAPE_WAVEFORM_Y_OFFSET
    const pixelRatio = window.devicePixelRatio || 1
    const showGridLines = SHOW_GRID_LINES && !bpmAnalysisActive.value && !bpmAnalysisFailed.value
    const allowTileBuild = true
    const snapshot = buildSequentialLayoutForZoom(zoomValue)

    forEachVisibleLayoutItem(snapshot, renderStartX, renderEndX, (item: TimelineTrackLayout) => {
      const track = item.track
      const waveformSources = resolveTrackWaveformSources(track)
      if (!waveformSources.length) return
      const trackWidth = item.width
      if (!trackWidth || !Number.isFinite(trackWidth)) return
      const trackStartX = item.startX
      const trackEndX = trackStartX + trackWidth
      if (trackEndX < renderStartX || trackStartX > renderEndX) return
      const trackY = trackContentTop + lanePaddingTop + item.laneIndex * laneStride - startY
      const visibleStart = Math.max(trackStartX, startX)
      const visibleEnd = Math.min(trackEndX, endX)
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
        const subLane = resolveWaveformSubLaneMetrics(
          laneH,
          waveformSource.laneIndex,
          waveformSource.laneCount
        )
        const subTrackY = trackY + subLane.offset
        if (subTrackY > heightPx || subTrackY + subLane.height < 0) continue
        const renderCtx = buildTrackRenderContext(track, {
          renderZoomValue: zoomValue,
          waveformFilePath: filePath,
          waveformStemId: waveformSource.stemId,
          laneHeight: subLane.height
        })
        for (let tileIndex = tileStartIndex; tileIndex <= tileEndIndex; tileIndex += 1) {
          const tileStart = tileIndex * WAVEFORM_TILE_WIDTH
          const tileWidth = Math.max(0, Math.min(WAVEFORM_TILE_WIDTH, trackWidth - tileStart))
          if (!tileWidth) continue
          const cacheKey = buildWaveformTileCacheKey(
            filePath,
            waveformSource.stemId,
            tileIndex,
            zoomValue,
            Math.max(1, Math.floor(tileWidth)),
            Math.max(1, Math.floor(subLane.height)),
            pixelRatio,
            renderCtx.tempoSnapshot.signature
          )
          let cached = waveformTileCache.get(cacheKey)
          if (!cached) {
            if (allowTileBuild) {
              const task = {
                ctx: renderCtx,
                tile: { index: tileIndex, start: tileStart, width: tileWidth },
                cacheKey
              }
              if (isStemMixMode() && waveformRenderWorker) {
                requestWaveformTileRender(task)
              } else {
                renderWaveformTileToCache(task)
                cached = waveformTileCache.get(cacheKey)
              }
            }
          }
          if (cached) {
            const source = cached.source
            ctx.drawImage(
              source,
              trackStartX + tileStart - startX,
              subTrackY,
              tileWidth,
              subLane.height
            )
            touchWaveformTileCache(cacheKey)
          }
        }
      }
      const visibleWidth = Math.max(0, localEnd - localStart)
      if (showGridLines && visibleWidth > 0) {
        for (const waveformSource of waveformSources) {
          const subLane = resolveWaveformSubLaneMetrics(
            laneH,
            waveformSource.laneIndex,
            waveformSource.laneCount
          )
          const subTrackY = trackY + subLane.offset
          if (subTrackY > heightPx || subTrackY + subLane.height < 0) continue
          ctx.save()
          ctx.translate(trackStartX + localStart - startX, subTrackY)
          drawTrackGridLines(
            ctx,
            visibleWidth,
            subLane.height,
            track,
            Number(item.startSec) || 0,
            resolveRenderPxPerSec(zoomValue),
            Number(track.downbeatBeatOffset) || 0,
            { start: localStart, end: localEnd },
            resolveGridBarWidth(zoomValue)
          )
          ctx.restore()
        }
      }
    })
  }

  const scheduleTimelineDraw = () => {
    if ((!isStemMixMode() || !timelineWorkerReady.value) && isTimelineZooming.value) {
      drawTimelineCanvas()
      return
    }
    if (typeof requestAnimationFrame === 'undefined') {
      drawTimelineCanvas()
      return
    }
    if (getTimelineCanvasRaf()) return
    setTimelineCanvasRaf(
      requestAnimationFrame(() => {
        setTimelineCanvasRaf(0)
        drawTimelineCanvas()
      })
    )
  }

  const resizeCanvas = (
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ) => {
    resizeCanvasWithScaleMetrics(canvas, ctx, width, height, window.devicePixelRatio || 1)
  }

  const ensureWaveformScratch = (width: number, height: number) => {
    if (!waveformScratch.canvas) {
      waveformScratch.canvas = document.createElement('canvas')
      waveformScratch.ctx = waveformScratch.canvas.getContext('2d')
    }
    const canvas = waveformScratch.canvas
    const ctx = waveformScratch.ctx
    if (!canvas || !ctx) return null
    resizeCanvas(canvas, ctx, width, height)
    return { canvas, ctx }
  }

  const resolveWaveformFrameCount = (
    data: TimelineWaveformData | null,
    stemMode: boolean
  ): number => {
    if (!data) return 0
    if (stemMode && isStemWaveformData(data)) {
      const all = data.all
      return Math.min(all.left.length, all.right.length)
    }
    if (!stemMode && isUnifiedWaveformData(data)) {
      return data.height.length
    }
    return 0
  }

  const buildTrackRenderContext = (
    track: MixtapeTrack,
    options?: {
      renderZoomValue?: number
      waveformFilePath?: string
      waveformStemId?: MixtapeWaveformStemId
      laneHeight?: number
    }
  ): WaveformRenderContext => {
    const waveformFilePath = String(options?.waveformFilePath || track.filePath || '').trim()
    const waveformStemId = options?.waveformStemId || 'inst'
    const data = (waveformDataMap.get(waveformFilePath) || null) as TimelineWaveformData | null
    const sourceDurationSeconds =
      data && Number.isFinite(data.duration) && data.duration > 0
        ? data.duration
        : resolveTrackSourceDurationSeconds(track)
    const durationSeconds = resolveTrackDurationSeconds(track)
    const zoomValue =
      typeof options?.renderZoomValue === 'number'
        ? clampZoomValue(options.renderZoomValue)
        : normalizedRenderZoom.value
    const rawData =
      useRawWaveform.value && zoomValue >= RAW_WAVEFORM_MIN_ZOOM
        ? rawWaveformDataMap.get(waveformFilePath) || null
        : null
    const frameCount = resolveWaveformFrameCount(data, isStemMixMode())
    const tempoSnapshot = serializeTrackRuntimeTempoSnapshot(
      buildTrackRuntimeTempoSnapshot({
        track,
        sourceDurationSec: sourceDurationSeconds,
        durationSec: durationSeconds,
        zoom: zoomValue
      })
    )
    const trackWidth = resolveTrackRenderWidthPx(track, zoomValue)
    return {
      track,
      waveformFilePath,
      waveformStemId,
      trackWidth,
      sourceDurationSeconds,
      durationSeconds,
      tempoSnapshot,
      data,
      frameCount,
      rawData,
      renderZoom: zoomValue,
      renderPxPerSec: resolveRenderPxPerSec(zoomValue),
      laneHeight: Math.max(
        1,
        Math.round(
          Number.isFinite(Number(options?.laneHeight))
            ? Number(options?.laneHeight)
            : resolveLaneHeightForZoom(zoomValue)
        )
      )
    }
  }

  const renderSummaryWaveformBar = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ) => {
    const barHeight = Math.max(4, Math.round(height * 0.55 * MIXTAPE_WAVEFORM_HEIGHT_SCALE))
    const y = Math.round((height - barHeight) / 2)
    ctx.fillStyle = 'rgba(120, 205, 255, 0.52)'
    ctx.fillRect(0, y, width, barHeight)
  }

  const renderWaveformTileContents = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    render: WaveformRenderContext,
    tile: WaveformTile
  ) => {
    const { trackWidth, sourceDurationSeconds, data, rawData } = render
    const loopValue =
      Array.isArray(render.tempoSnapshot.loopSegments) && render.tempoSnapshot.loopSegments.length
        ? render.tempoSnapshot.loopSegments
        : render.tempoSnapshot.loopSegment
    const hasLoopSegment = !!loopValue
    if (!hasLoopSegment && render.renderZoom <= MIXTAPE_SUMMARY_ZOOM + 0.0001) {
      renderSummaryWaveformBar(ctx, width, height)
      return
    }
    const rawDurationSeconds =
      rawData && Number.isFinite(rawData.duration) && rawData.duration > 0 ? rawData.duration : 0
    const waveformDurationSeconds =
      rawDurationSeconds > 0 ? rawDurationSeconds : sourceDurationSeconds
    const localStartSec = render.tempoSnapshot.durationSec
      ? (tile.start / Math.max(1, trackWidth)) * render.durationSeconds
      : 0
    const localEndSec = render.tempoSnapshot.durationSec
      ? ((tile.start + tile.width) / Math.max(1, trackWidth)) * render.durationSeconds
      : 0
    const localSpanSec = Math.max(0.0001, localEndSec - localStartSec)
    const renderTimeMap = createTrackTimeMapFromSnapshotPayload({
      ...render.tempoSnapshot,
      sourceDurationSec: waveformDurationSeconds
    })

    const stemMode = isStemMixMode()
    const stemData = stemMode && isStemWaveformData(data) ? data : null
    const unifiedData = !stemMode && isUnifiedWaveformData(data) ? data : null
    const baseDurationSeconds = Math.max(
      0,
      Number(render.tempoSnapshot.baseDurationSec || render.durationSeconds) || 0
    )
    const loopSections = resolveMixtapeTrackLoopTileSections({
      localStartSec,
      localEndSec,
      baseDurationSec: baseDurationSeconds,
      loopSegments: Array.isArray(render.tempoSnapshot.loopSegments)
        ? render.tempoSnapshot.loopSegments
        : undefined,
      loopSegment: render.tempoSnapshot.loopSegment
    })

    const drawWaveform = (
      targetCtx: CanvasRenderingContext2D,
      targetWidth: number,
      section: {
        kind?: string
        displayStartSec: number
        displayEndSec: number
        baseStartSec: number
        baseEndSec: number
      }
    ) => {
      const startTime = waveformDurationSeconds
        ? renderTimeMap.mapLocalToSource(section.baseStartSec)
        : 0
      const endTime = waveformDurationSeconds
        ? renderTimeMap.mapLocalToSource(section.baseEndSec)
        : 0
      const pixelRatio = window.devicePixelRatio || 1
      const rawSpan = Math.max(0, endTime - startTime)
      const rawSamplesPerPixel =
        rawData && rawSpan > 0
          ? (rawData.rate * rawSpan) / Math.max(1, targetWidth * pixelRatio)
          : 0
      const resolvedRaw =
        render.waveformFilePath && rawData
          ? resolveRawWaveformLevel(render.waveformFilePath, rawData, rawSamplesPerPixel)
          : rawData
      if (stemMode) {
        if (!stemData && !resolvedRaw) {
          targetCtx.strokeStyle = 'rgba(128, 128, 128, 0.3)'
          targetCtx.setLineDash([4, 4])
          const midY = height / 2
          targetCtx.beginPath()
          targetCtx.moveTo(0, midY)
          targetCtx.lineTo(targetWidth, midY)
          targetCtx.stroke()
          targetCtx.setLineDash([])
          return
        }
        const frameCountFromStem = stemData
          ? Math.min(stemData.all.left.length, stemData.all.right.length)
          : 0
        const startFrame =
          frameCountFromStem > 0 && baseDurationSeconds > 0
            ? Math.floor(
                (section.baseStartSec / Math.max(0.0001, baseDurationSeconds)) * frameCountFromStem
              )
            : 0
        const endFrame =
          frameCountFromStem > 0 && baseDurationSeconds > 0
            ? Math.ceil(
                (section.baseEndSec / Math.max(0.0001, baseDurationSeconds)) * frameCountFromStem
              )
            : 1
        drawStemWaveform(targetCtx, targetWidth, height, stemData, useHalfWaveform(), {
          startFrame,
          endFrame,
          startTime,
          endTime,
          raw: resolvedRaw,
          stemId: render.waveformStemId
        })
        return
      }
      const frameCount = unifiedData?.height?.length || 0
      if (!unifiedData || frameCount <= 0) {
        targetCtx.strokeStyle = 'rgba(128, 128, 128, 0.3)'
        targetCtx.setLineDash([4, 4])
        const midY = height / 2
        targetCtx.beginPath()
        targetCtx.moveTo(0, midY)
        targetCtx.lineTo(targetWidth, midY)
        targetCtx.stroke()
        targetCtx.setLineDash([])
        return
      }
      drawUnifiedTimelineWaveform({
        ctx: targetCtx,
        width: targetWidth,
        height,
        data: unifiedData,
        startTime,
        endTime,
        isHalf: useHalfWaveform()
      })
    }

    const drawLoopAwareWaveform = (targetCtx: CanvasRenderingContext2D, targetWidth: number) => {
      const sectionCanvasCache = new Map<string, HTMLCanvasElement>()
      const buildSectionCacheKey = (
        section: {
          baseStartSec: number
          baseEndSec: number
        },
        sectionWidth: number
      ) =>
        [
          render.waveformFilePath,
          render.waveformStemId,
          Math.round(section.baseStartSec * 1000),
          Math.round(section.baseEndSec * 1000),
          Math.max(1, Math.round(sectionWidth))
        ].join(':')

      const getOrCreateSectionCanvas = (
        section: {
          kind?: string
          displayStartSec: number
          displayEndSec: number
          baseStartSec: number
          baseEndSec: number
        },
        sectionWidth: number
      ) => {
        const cacheKey = buildSectionCacheKey(section, sectionWidth)
        const cachedCanvas = sectionCanvasCache.get(cacheKey)
        if (cachedCanvas) return cachedCanvas
        const cacheCanvas = document.createElement('canvas')
        cacheCanvas.width = sectionWidth
        cacheCanvas.height = height
        const cacheCtx = cacheCanvas.getContext('2d')
        if (!cacheCtx) return null
        drawWaveform(cacheCtx, sectionWidth, {
          ...section,
          displayStartSec: section.baseStartSec,
          displayEndSec: section.baseEndSec
        })
        sectionCanvasCache.set(cacheKey, cacheCanvas)
        return cacheCanvas
      }

      for (const section of loopSections) {
        const sectionStartRatio = (section.displayStartSec - localStartSec) / localSpanSec
        const sectionEndRatio = (section.displayEndSec - localStartSec) / localSpanSec
        const sectionStartX = Math.max(0, Math.floor(sectionStartRatio * targetWidth))
        const sectionEndX = Math.min(targetWidth, Math.ceil(sectionEndRatio * targetWidth))
        const sectionWidth = Math.max(1, sectionEndX - sectionStartX)
        targetCtx.save()
        targetCtx.translate(sectionStartX, 0)
        if (section.kind === 'loop-source' || section.kind === 'loop-repeat') {
          const cachedCanvas = getOrCreateSectionCanvas(section, sectionWidth)
          if (cachedCanvas) {
            targetCtx.drawImage(cachedCanvas, 0, 0, sectionWidth, height)
          } else {
            drawWaveform(targetCtx, sectionWidth, section)
          }
        } else {
          drawWaveform(targetCtx, sectionWidth, section)
        }
        targetCtx.restore()
      }
    }

    const renderScale = render.renderZoom >= 1 ? MIXTAPE_WAVEFORM_SUPERSAMPLE : 1
    if (renderScale > 1) {
      const scratch = ensureWaveformScratch(width * renderScale, height)
      if (scratch) {
        drawLoopAwareWaveform(scratch.ctx, width * renderScale)
        ctx.save()
        ctx.imageSmoothingEnabled = true
        ctx.clearRect(0, 0, width, height)
        ctx.drawImage(
          scratch.canvas,
          0,
          0,
          scratch.canvas.width,
          scratch.canvas.height,
          0,
          0,
          width,
          height
        )
        ctx.restore()
        return
      }
    }

    drawLoopAwareWaveform(ctx, width)
  }

  const scheduleWaveformDraw = (_deferSwap: boolean = false) => {
    scheduleTimelineDraw()
  }

  const decodeUint8Array = (value: unknown): Uint8Array | null => {
    if (!value) return null
    if (value instanceof Uint8Array) return value
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value)
    }
    if (Array.isArray(value)) {
      return Uint8Array.from(value.map((item) => Number(item) || 0))
    }
    return null
  }

  const decodeStemWaveformData = (payload: unknown): StemWaveformData | null => {
    if (!payload || typeof payload !== 'object') return null
    const source = payload as Record<string, unknown>
    const bandsSource =
      source.bands && typeof source.bands === 'object'
        ? (source.bands as Record<string, unknown>)
        : null
    const allRaw = source.all || bandsSource?.all
    if (!allRaw || typeof allRaw !== 'object') return null
    const allRawRecord = allRaw as Record<string, unknown>
    const left = decodeUint8Array(allRawRecord.left)
    const right = decodeUint8Array(allRawRecord.right)
    const peakLeft = decodeUint8Array(allRawRecord.peakLeft) || left
    const peakRight = decodeUint8Array(allRawRecord.peakRight) || right
    if (!left || !right || !peakLeft || !peakRight) return null
    const frameCount = Math.min(left.length, right.length, peakLeft.length, peakRight.length)
    if (!frameCount) return null
    return {
      duration: Number(source.duration) || 0,
      sampleRate: Number(source.sampleRate) || 0,
      step: Number(source.step) || 0,
      all: {
        left: left.subarray(0, frameCount),
        right: right.subarray(0, frameCount),
        peakLeft: peakLeft.subarray(0, frameCount),
        peakRight: peakRight.subarray(0, frameCount)
      }
    }
  }

  const storeWaveformData = (filePath: string, data: TimelineWaveformData | null) => {
    if (!filePath) return
    const normalized = isValidWaveformData(data) ? data : null
    if (waveformDataMap.has(filePath)) {
      waveformDataMap.delete(filePath)
    }
    waveformDataMap.set(filePath, normalized)
    if (isStemMixMode()) {
      const stemData = normalized && isStemWaveformData(normalized) ? normalized : null
      pushStemWaveformToWorker(filePath, stemData)
    }
    clearWaveformTileCacheForFile(filePath)
    if (!normalized) {
      waveformMinMaxCache.delete(filePath)
    }
    waveformVersion.value += 1
    scheduleWaveformDraw()
    scheduleFullPreRender()
    scheduleWorkerPreRender()
  }

  const fetchWaveformBatch = async (filePaths: string[], listRoot?: string) => {
    if (!filePaths.length) return
    if (isStemMixMode()) return
    for (const filePath of filePaths) {
      waveformInflight.add(filePath)
    }
    let response: { items?: Array<{ filePath: string; data: unknown }> } | null = null
    try {
      response = await window.electron.ipcRenderer.invoke('unified-display-waveform-cache:batch', {
        filePaths,
        listRoot
      })
    } catch {
      response = null
    }
    const items = Array.isArray(response?.items) ? response!.items : null
    if (!items) {
      for (const filePath of filePaths) {
        waveformInflight.delete(filePath)
      }
      return
    }

    const itemMap = new RendererFilePathMap(
      items.map(
        (item) => [item.filePath, normalizeUnifiedDisplayWaveformData(item.data) ?? null] as const
      )
    )
    const missing: string[] = []
    for (const filePath of filePaths) {
      const data = itemMap.has(filePath) ? itemMap.get(filePath) : null
      storeWaveformData(filePath, data ?? null)
      if (data) {
        waveformQueuedMissing.delete(filePath)
      } else {
        missing.push(filePath)
      }
      waveformInflight.delete(filePath)
    }

    if (missing.length) {
      const toQueue = missing.filter((filePath) => !waveformQueuedMissing.has(filePath))
      if (toQueue.length) {
        for (const filePath of toQueue) {
          waveformQueuedMissing.add(filePath)
        }
        window.electron.ipcRenderer.send('key-analysis:queue-visible', {
          analysisAuthority: 'frkb',
          filePaths: toQueue,
          waveformOnly: true,
          scope: 'waveform-preview'
        })
      }
    }
  }
  const waveformLoadingModule = createTimelineWaveformLoadingModule({
    tracks,
    waveformDataMap,
    waveformQueuedMissing,
    rawWaveformDataMap,
    rawWaveformPyramidMap,
    waveformInflight,
    rawWaveformInflight,
    waveformVersion,
    pushStemWaveformToWorker,
    pushRawWaveformToWorker,
    clearWaveformTileCacheForFile,
    scheduleWaveformDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    resolveWaveformListRoot,
    resolveTrackWaveformSources,
    resolveTrackWaveformFilePaths,
    buildSequentialLayoutForZoom,
    forEachVisibleLayoutItem,
    normalizedRenderZoom,
    timelineScrollRef,
    timelineScrollLeft,
    timelineViewportWidth,
    decodeStemWaveformData,
    storeWaveformData,
    fetchWaveformBatch,
    decodeRawWaveformData,
    buildRawWaveformPyramid,
    isStemMixMode,
    useRawWaveform,
    getWaveformLoadTimer,
    setWaveformLoadTimer,
    isTransportPreloadingActive,
    ENABLE_STEM_PREVIEW_WAVEFORM,
    WAVEFORM_BATCH_SIZE,
    RAW_WAVEFORM_BATCH_SIZE,
    RAW_WAVEFORM_TARGET_RATE,
    RAW_VISIBLE_BUFFER_PX,
    RAW_BATCH_MAX_CONCURRENT
  })

  return {
    drawTimelineCanvas,
    scheduleTimelineDraw,
    resizeCanvas,
    ensureWaveformScratch,
    buildTrackRenderContext,
    renderSummaryWaveformBar,
    renderWaveformTileContents,
    scheduleWaveformDraw,
    storeWaveformData,
    fetchWaveformBatch,
    fetchRawWaveformBatch: waveformLoadingModule.fetchRawWaveformBatch,
    loadWaveforms: waveformLoadingModule.loadWaveforms,
    loadRawWaveforms: waveformLoadingModule.loadRawWaveforms,
    scheduleWaveformLoad: waveformLoadingModule.scheduleWaveformLoad,
    handleWaveformUpdated: waveformLoadingModule.handleWaveformUpdated
  }
}
