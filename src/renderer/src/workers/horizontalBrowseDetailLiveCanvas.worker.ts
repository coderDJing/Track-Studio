import {
  createHorizontalBrowseDetailLiveCanvasWaveformPainter,
  ensureHorizontalBrowseDetailLiveCanvasScratch
} from './horizontalBrowseDetailLiveCanvasWaveformPainter'
import { clampNumber } from '@renderer/composables/horizontalBrowse/horizontalBrowseMath'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { resolveCanvasScaleMetrics } from '@renderer/utils/canvasScale'
import { createHorizontalBrowseDetailLiveCanvasOverlayRenderer } from './horizontalBrowseDetailLiveCanvasOverlay'
import { createHorizontalBrowseDetailLiveCanvasBufferManager } from './horizontalBrowseDetailLiveCanvasBuffers'
import { createHorizontalBrowseDetailLiveCanvasRawStore } from './horizontalBrowseDetailLiveCanvasRawStore'
import { renderHorizontalBrowseTimelineFallback } from './horizontalBrowseDetailLiveCanvasTimelineFallback'
import { resolvePresentationOffsetCssPx } from './horizontalBrowseDetailLiveCanvasPresentation'
import {
  PLAYBACK_CLOCK_REANCHOR_MIN_FRAME_GAP_MS,
  PLAYBACK_INITIAL_FULL_RENDER_LEAD_DEFAULT_MS,
  PLAYBACK_RENDER_FALLBACK_TIMEOUT_MS,
  PLAYBACK_RENDER_INTERVAL_MS,
  PLAYBACK_RENDER_MIN_FRAME_GAP_MS,
  PLAYBACK_SCROLL_REUSE_MAX_FRAME_GAP_MS,
  PLAYBACK_SCROLL_REUSE_RECOVERY_FRAMES,
  buildPlaybackRenderRequest,
  clampPlaybackRenderLeadMs,
  hasPlaybackRenderClock,
  resolvePlaybackRenderClockStartedAtMs,
  resolvePlaybackSeconds
} from './horizontalBrowseDetailLiveCanvasPlayback'
import {
  canPreserveHorizontalBrowseWaveformAfterRenderMiss,
  canPreservePlaybackFrameOnMissingRaw
} from './horizontalBrowseDetailLiveCanvasRenderGuards'
import type {
  CanvasMetrics,
  FrameState,
  PlaybackAnimationState,
  WorkerAnimationFrameScope
} from './horizontalBrowseDetailLiveCanvasRenderState'
import type {
  HorizontalBrowseDetailLiveCanvasRenderRequest,
  HorizontalBrowseDetailLiveCanvasTileRenderRequest,
  HorizontalBrowseDetailLiveCanvasWorkerIncoming,
  HorizontalBrowseDetailLiveCanvasWorkerOutgoing
} from './horizontalBrowseDetailLiveCanvas.types'

const {
  drawRange,
  ensureSegmentScratch,
  renderSegmentToScratch,
  copySegmentToCanvas,
  renderViewportSegment
} = createHorizontalBrowseDetailLiveCanvasWaveformPainter()

const normalizeWaveformGain = (value: number) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return clampNumber(numeric, 0, 16)
}
let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
let scrollSourceCanvas: OffscreenCanvas | null = null
let lastFrame: FrameState | null = null
let lastWaveformScrollShiftScaledPx: number | null = null
let scrollScratchCanvas: OffscreenCanvas | null = null
let scrollScratchCtx: OffscreenCanvasRenderingContext2D | null = null
let pendingRender: HorizontalBrowseDetailLiveCanvasRenderRequest | null = null
let renderTimer: ReturnType<typeof setTimeout> | null = null
let playbackAnimation: PlaybackAnimationState | null = null
let playbackAnimationToken = 0
let playbackTimer: ReturnType<typeof setTimeout> | null = null
let playbackRaf = 0
let playbackInitialFullRenderLeadMs = PLAYBACK_INITIAL_FULL_RENDER_LEAD_DEFAULT_MS
const postToMain = (message: HorizontalBrowseDetailLiveCanvasWorkerOutgoing) =>
  (
    self as typeof globalThis & {
      postMessage: (payload: HorizontalBrowseDetailLiveCanvasWorkerOutgoing) => void
    }
  ).postMessage(message)
let overlayRenderer = createHorizontalBrowseDetailLiveCanvasOverlayRenderer()
const canvasBufferManager = createHorizontalBrowseDetailLiveCanvasBufferManager()
// 分块路径：[buffer0 的块列表, buffer1 的块列表]。attach 一次后数量固定。
let waveformTileBuffers: Array<
  Array<{
    canvas: OffscreenCanvas
    ctx: OffscreenCanvasRenderingContext2D
  }>
> = []

const resetFrameState = () => {
  lastFrame = lastWaveformScrollShiftScaledPx = null
}
const invalidateRawFrameReuse = () => {
  lastWaveformScrollShiftScaledPx = null
}
const rawStore = createHorizontalBrowseDetailLiveCanvasRawStore(invalidateRawFrameReuse)
const resolveWorkerAnimationFrameScope = () => self as WorkerAnimationFrameScope
const clearPlaybackFrameSchedule = () => {
  if (playbackTimer) {
    clearTimeout(playbackTimer)
    playbackTimer = null
  }
  if (playbackRaf) {
    const scope = resolveWorkerAnimationFrameScope()
    if (typeof scope.cancelAnimationFrame === 'function') {
      scope.cancelAnimationFrame(playbackRaf)
    }
    playbackRaf = 0
  }
}

const consumePlaybackFrameSchedule = () => {
  const raf = playbackRaf
  const timer = playbackTimer
  playbackRaf = 0
  playbackTimer = null
  if (timer) {
    clearTimeout(timer)
  }
  if (raf) {
    const scope = resolveWorkerAnimationFrameScope()
    if (typeof scope.cancelAnimationFrame === 'function') {
      scope.cancelAnimationFrame(raf)
    }
  }
}

const stopPlaybackAnimation = () => {
  playbackAnimationToken += 1
  playbackAnimation = null
  clearPlaybackFrameSchedule()
}

const stopPlaybackAnimationAndPendingRender = () => {
  stopPlaybackAnimation()
  pendingRender = null
  if (renderTimer) {
    clearTimeout(renderTimer)
    renderTimer = null
  }
}

const ensureCanvasMetrics = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest
): CanvasMetrics | null => {
  if (!canvas || !ctx) return null
  const metrics = resolveCanvasScaleMetrics(request.width, request.height, request.pixelRatio, {
    preserveFractionalCssSize: true
  })
  const previousWidth = canvas.width
  const previousHeight = canvas.height
  if (canvas.width !== metrics.scaledWidth) {
    canvas.width = metrics.scaledWidth
  }
  if (canvas.height !== metrics.scaledHeight) {
    canvas.height = metrics.scaledHeight
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.imageSmoothingEnabled = false
  return {
    ...metrics,
    resized: previousWidth !== metrics.scaledWidth || previousHeight !== metrics.scaledHeight
  }
}

const selectRenderBuffer = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
  const selected = canvasBufferManager.resolve(request.renderTargetIndex)
  canvas = selected?.canvas ?? null
  ctx = selected?.ctx ?? null
  overlayRenderer = selected?.overlayRenderer ?? overlayRenderer
  scrollSourceCanvas = canvasBufferManager.resolve(request.renderSourceIndex)?.canvas ?? canvas
}

const copyScrollSourceToTarget = (
  metrics: CanvasMetrics,
  targetCtx: OffscreenCanvasRenderingContext2D
) => {
  const sourceCanvas = scrollSourceCanvas ?? canvas
  if (!sourceCanvas) return false
  if (sourceCanvas === canvas) return true
  targetCtx.setTransform(1, 0, 0, 1, 0, 0)
  targetCtx.imageSmoothingEnabled = false
  targetCtx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
  targetCtx.drawImage(sourceCanvas, 0, 0)
  return true
}

const ensureScrollScratch = (scaledWidth: number, scaledHeight: number) => {
  const scratch = ensureHorizontalBrowseDetailLiveCanvasScratch(
    scrollScratchCanvas,
    scrollScratchCtx,
    scaledWidth,
    scaledHeight
  )
  if (!scratch) return null
  scrollScratchCanvas = scratch.canvas
  scrollScratchCtx = scratch.ctx
  return scratch
}

const resolveRawForRender = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) =>
  rawStore.resolveForRender(request.rawSlot)
const resolveRawRevisionForRender = (rawData: RawWaveformData | null) => {
  return rawStore.resolveRevisionForRender(rawData)
}

const buildFrameState = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  rawData: RawWaveformData | null
): FrameState => ({
  width: metrics.cssWidth,
  height: metrics.cssHeight,
  firstBeatMs: Number(request.firstBeatMs) || 0,
  timeBasisOffsetMs: Number(request.timeBasisOffsetMs) || 0,
  rangeStartSec: Number.isFinite(request.rangeStartSec) ? request.rangeStartSec : 0,
  rangeDurationSec: Math.max(0.0001, Number(request.rangeDurationSec) || 0.0001),
  rawData,
  rawRevision: resolveRawRevisionForRender(rawData),
  maxSamplesPerPixel: request.maxSamplesPerPixel,
  showDetailHighlights: request.showDetailHighlights,
  showCenterLine: request.showCenterLine,
  showBackground: request.showBackground,
  waveformLayout: request.waveformLayout,
  waveformRenderStyle: request.waveformRenderStyle,
  preferRawPeaksOnly: request.preferRawPeaksOnly,
  themeVariant: request.themeVariant,
  waveformGain: normalizeWaveformGain(request.waveformGain),
  playbackSyncRevision: Math.max(0, Math.floor(Number(request.playbackSyncRevision) || 0))
})

const canReusePreviousFrame = (
  current: FrameState,
  metrics: CanvasMetrics,
  ignoreFirstBeatMs = false,
  ignoreRawRevision = false
) => {
  if (metrics.resized || !lastFrame) return false
  return (
    lastFrame.width === current.width &&
    lastFrame.height === current.height &&
    (ignoreFirstBeatMs || lastFrame.firstBeatMs === current.firstBeatMs) &&
    lastFrame.timeBasisOffsetMs === current.timeBasisOffsetMs &&
    lastFrame.rangeDurationSec === current.rangeDurationSec &&
    lastFrame.rawData === current.rawData &&
    (ignoreRawRevision || lastFrame.rawRevision === current.rawRevision) &&
    lastFrame.showDetailHighlights === current.showDetailHighlights &&
    lastFrame.showCenterLine === current.showCenterLine &&
    lastFrame.showBackground === current.showBackground &&
    lastFrame.waveformLayout === current.waveformLayout &&
    lastFrame.waveformRenderStyle === current.waveformRenderStyle &&
    lastFrame.preferRawPeaksOnly === current.preferRawPeaksOnly &&
    lastFrame.themeVariant === current.themeVariant &&
    lastFrame.waveformGain === current.waveformGain &&
    lastFrame.playbackSyncRevision === current.playbackSyncRevision
  )
}

const clearWaveformPixels = () => {
  if (canvas && ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }
  resetFrameState()
}

const clearCanvasPixels = () => {
  pendingRender = null
  stopPlaybackAnimation()
  canvasBufferManager.clearAll()
  // 分块路径：块画布像素也要清，否则主线程块池失效后旧块内容仍会露出来。
  clearDeferredTileWork()
  for (const tileBuffer of waveformTileBuffers) {
    for (const tile of tileBuffer) {
      tile.ctx.setTransform(1, 0, 0, 1, 0, 0)
      tile.ctx.clearRect(0, 0, tile.canvas.width, tile.canvas.height)
    }
  }
  resetFrameState()
}

const shouldUseStableColumnGrid = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  state: FrameState
) =>
  request.playbackActive === true &&
  state.waveformRenderStyle === 'columns' &&
  state.waveformLayout !== 'full'

const resolveStableColumnRangeStartSec = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  state: FrameState,
  phaseShiftSec = 0
) => {
  if (!shouldUseStableColumnGrid(request, state)) return state.rangeStartSec
  const scaledPxPerSec = metrics.scaledWidth / Math.max(0.0001, state.rangeDurationSec)
  return (
    Math.round((state.rangeStartSec - phaseShiftSec) * scaledPxPerSec) / scaledPxPerSec +
    phaseShiftSec
  )
}

const renderFullFrame = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  state: FrameState
) => {
  if (!ctx) return false
  const phaseAwareScrollReuse = request.phaseAwareScrollReuse === true
  const canReuseSameRawDataWithNewRevision =
    request.playbackActive === true && lastFrame?.rawData === state.rawData
  const resolveReusedFrameState = () =>
    canReuseSameRawDataWithNewRevision && lastFrame && lastFrame.rawRevision !== state.rawRevision
      ? { ...state, rawRevision: lastFrame.rawRevision }
      : state
  const resolvePhaseShiftSec = (previous: FrameState) =>
    phaseAwareScrollReuse ? (state.firstBeatMs - previous.firstBeatMs) / 1000 : 0
  lastWaveformScrollShiftScaledPx = null

  if (
    request.allowScrollReuse !== false &&
    canReusePreviousFrame(
      state,
      metrics,
      phaseAwareScrollReuse,
      canReuseSameRawDataWithNewRevision
    ) &&
    lastFrame &&
    Math.abs(state.rangeStartSec - lastFrame.rangeStartSec - resolvePhaseShiftSec(lastFrame)) <=
      0.000001
  ) {
    state.rangeStartSec = lastFrame.rangeStartSec + resolvePhaseShiftSec(lastFrame)
    if (!copyScrollSourceToTarget(metrics, ctx)) return false
    lastFrame = resolveReusedFrameState()
    return true
  }

  let reused = false
  if (
    request.allowScrollReuse !== false &&
    canReusePreviousFrame(
      state,
      metrics,
      phaseAwareScrollReuse,
      canReuseSameRawDataWithNewRevision
    ) &&
    lastFrame
  ) {
    const phaseShiftSec = resolvePhaseShiftSec(lastFrame)
    const requestedRangeStartSec = resolveStableColumnRangeStartSec(
      request,
      metrics,
      state,
      phaseShiftSec
    )
    const requestedShiftScaledPx =
      ((requestedRangeStartSec - lastFrame.rangeStartSec - phaseShiftSec) /
        state.rangeDurationSec) *
      metrics.scaledWidth
    const shiftScaledPx = Math.round(requestedShiftScaledPx)
    const quantizedRangeStartSec =
      lastFrame.rangeStartSec +
      phaseShiftSec +
      (shiftScaledPx / metrics.scaledWidth) * state.rangeDurationSec
    const absShiftScaledPx = Math.abs(shiftScaledPx)
    if (absShiftScaledPx === 0) {
      state.rangeStartSec = lastFrame.rangeStartSec + phaseShiftSec
      lastWaveformScrollShiftScaledPx = 0
      reused = copyScrollSourceToTarget(metrics, ctx)
    } else if (absShiftScaledPx < metrics.scaledWidth) {
      state.rangeStartSec = quantizedRangeStartSec
      const scratch = ensureScrollScratch(metrics.scaledWidth, metrics.scaledHeight)
      if (scratch) {
        scratch.ctx.setTransform(1, 0, 0, 1, 0, 0)
        scratch.ctx.imageSmoothingEnabled = false
        scratch.ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
        const sourceCanvas = scrollSourceCanvas ?? canvas
        if (sourceCanvas) {
          scratch.ctx.drawImage(sourceCanvas, 0, 0)
        }

        const segmentPaddingScaledPx = Math.max(2, Math.ceil(metrics.scaleX * 2))
        let segment: ReturnType<typeof renderSegmentToScratch> | false = false
        if (shiftScaledPx > 0) {
          const segmentX = Math.max(
            0,
            metrics.scaledWidth - absShiftScaledPx - segmentPaddingScaledPx
          )
          const segmentWidth = Math.max(1, metrics.scaledWidth - segmentX)
          segment = renderSegmentToScratch(metrics, state, segmentX, segmentWidth)
        } else {
          const segmentWidth = Math.max(
            1,
            Math.min(metrics.scaledWidth, absShiftScaledPx + segmentPaddingScaledPx)
          )
          segment = renderSegmentToScratch(metrics, state, 0, segmentWidth)
        }
        if (segment) {
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.imageSmoothingEnabled = false
          ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)

          const keepScaledWidth = Math.max(0, metrics.scaledWidth - absShiftScaledPx)
          if (keepScaledWidth > 0) {
            if (shiftScaledPx > 0) {
              ctx.drawImage(
                scratch.canvas,
                absShiftScaledPx,
                0,
                keepScaledWidth,
                metrics.scaledHeight,
                0,
                0,
                keepScaledWidth,
                metrics.scaledHeight
              )
            } else {
              ctx.drawImage(
                scratch.canvas,
                0,
                0,
                keepScaledWidth,
                metrics.scaledHeight,
                absShiftScaledPx,
                0,
                keepScaledWidth,
                metrics.scaledHeight
              )
            }
          }

          copySegmentToCanvas(ctx, metrics, segment)
          reused = true
        }
        if (reused) {
          lastWaveformScrollShiftScaledPx = shiftScaledPx
        }
      }
    }
  }

  if (!reused) {
    state.rangeStartSec = resolveStableColumnRangeStartSec(request, metrics, state)
    if (request.renderViewportOnly === true) {
      reused = renderViewportSegment(ctx, request, metrics, state)
    } else {
      const fullFrame = ensureSegmentScratch(metrics.scaledWidth, metrics.scaledHeight)
      if (fullFrame) {
        fullFrame.ctx.setTransform(1, 0, 0, 1, 0, 0)
        fullFrame.ctx.imageSmoothingEnabled = false
        fullFrame.ctx.clearRect(0, 0, fullFrame.canvas.width, fullFrame.canvas.height)
        reused = drawRange(
          fullFrame.ctx,
          metrics.scaledWidth,
          metrics.scaledHeight,
          state.rangeStartSec,
          state.rangeDurationSec,
          state
        )
        if (reused) {
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.imageSmoothingEnabled = false
          ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
          ctx.drawImage(fullFrame.canvas, 0, 0)
        }
      }
    }
  }

  if (!reused) {
    return false
  }

  lastFrame =
    request.renderViewportOnly === true
      ? null
      : lastWaveformScrollShiftScaledPx === null
        ? state
        : resolveReusedFrameState()
  return true
}

const postPresentationOffset = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  committedRangeStartSec: number,
  committedRangeDurationSec: number
) => {
  const offset = resolvePresentationOffsetCssPx(
    request,
    metrics,
    committedRangeStartSec,
    committedRangeDurationSec
  )
  postToMain({
    type: 'presentation',
    payload: { renderToken: request.renderToken, offsetCssPx: Number.isFinite(offset) ? offset : 0 }
  })
}

const processRender = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  notifyMain = true
) => {
  selectRenderBuffer(request)
  const metrics = ensureCanvasMetrics(request)
  const rawData = resolveRawForRender(request)
  const state = metrics ? buildFrameState(request, metrics, rawData) : null
  const renderState = state as FrameState | null
  const previousFrame = lastFrame
  // 分块路径：波形层改由块画布承载，整帧超宽位图不再绘制波形（这才是「少合成面积」的收益来源）。
  // overlay 仍走下方原有单层路径，不分块。
  const tileResult = request.tilePlan ? renderWaveformTiles(request, rawData) : null
  if (tileResult) {
    if (canvas && ctx) {
      // 旧超宽位图不再承载波形，但它仍在 DOM 里且位于块容器之下：残留像素会从块的透明处透出来。
      // 清空一次即可（后续每轮它都保持空白），代价是一个 clearRect。
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
    // 超宽位图已无波形内容，任何基于它的滚动复用都会画出错误画面。
    resetFrameState()
  }
  const ready = tileResult
    ? tileResult.visibleReady
    : !!metrics && !!rawData && renderFullFrame(request, metrics, renderState as FrameState)

  const holdMissingPlaybackRaw =
    !!metrics &&
    !!renderState &&
    !ready &&
    request.playbackActive === true &&
    request.rawSlot !== null &&
    !rawData &&
    canPreservePlaybackFrameOnMissingRaw(renderState, previousFrame)
  // 分块路径不走整帧 preserve：块画布各自保留自己的内容，旧可见面由主线程的
  // preserveSurfaceUntilNextReady 负责，不需要把超宽位图拷来拷去。
  const shouldPreserve =
    !tileResult &&
    (holdMissingPlaybackRaw ||
      (!!metrics &&
        !!renderState &&
        !ready &&
        canPreserveHorizontalBrowseWaveformAfterRenderMiss(request, renderState, previousFrame)))
  const preserved = shouldPreserve && !!metrics && !!ctx && copyScrollSourceToTarget(metrics, ctx)
  const notReadyReason =
    ready || preserved
      ? undefined
      : !metrics
        ? 'missing-metrics'
        : !rawData
          ? 'missing-raw-data'
          : tileResult
            ? 'tile-visible-not-ready'
            : 'render-full-frame-failed'
  if (preserved) {
    lastFrame = previousFrame
    lastWaveformScrollShiftScaledPx = null
  } else if (metrics && renderState && !ready && !tileResult) {
    clearWaveformPixels()
    if (request.showTimelinePlaceholder && ctx) {
      renderHorizontalBrowseTimelineFallback(ctx, request, metrics)
    }
  }
  // committed range 是本次实际留在 canvas 上的波形坐标；preserved 帧必须回报旧帧坐标。
  const committedRangeStartSec =
    preserved && previousFrame
      ? previousFrame.rangeStartSec
      : (renderState?.rangeStartSec ?? request.rangeStartSec)
  const committedRangeDurationSec =
    preserved && previousFrame
      ? previousFrame.rangeDurationSec
      : (renderState?.rangeDurationSec ?? request.rangeDurationSec)
  const overlayRenderResult =
    metrics && renderState
      ? overlayRenderer.render(
          request,
          committedRangeStartSec,
          committedRangeDurationSec,
          lastWaveformScrollShiftScaledPx
        )
      : null
  if (
    metrics &&
    renderState &&
    !ready &&
    !preserved &&
    request.stableWaveformSource === true &&
    request.showBeatGrid === true &&
    request.renderSourceIndex !== request.renderTargetIndex
  ) {
    const sourceBuffer = canvasBufferManager.resolve(request.renderSourceIndex)
    if (sourceBuffer && sourceBuffer.overlayRenderer !== overlayRenderer) {
      sourceBuffer.overlayRenderer.render(
        request,
        committedRangeStartSec,
        committedRangeDurationSec,
        lastWaveformScrollShiftScaledPx
      )
    }
  }
  if (metrics && renderState && !overlayRenderResult) {
    overlayRenderer.clear()
  }

  if (metrics && renderState) {
    postPresentationOffset(request, metrics, committedRangeStartSec, committedRangeDurationSec)
  }

  if (notifyMain) {
    postToMain({
      type: 'rendered',
      payload: {
        renderToken: request.renderToken,
        rangeStartSec: committedRangeStartSec,
        rangeDurationSec: committedRangeDurationSec,
        ready: ready || preserved,
        renderViewportOnly: request.renderViewportOnly === true,
        renderTargetIndex: request.renderTargetIndex,
        stableWaveformSource: request.stableWaveformSource === true,
        rawWaveformKind: rawData?.nativeWaveformKind,
        renderedTileSlotIndexes: tileResult?.renderedTileSlotIndexes,
        tilesPending: tileResult?.tilesPending,
        notReadyReason
      }
    })
  }
}

// 分块路径的单块绘制。
//
// 复用与旧路径完全相同的 drawRange，只是每次的时间窗口更窄、目标画布更小——因此波形外观、
// 平滑、增益、主题与旧路径逐像素同源，不引入新的绘制分支。
const drawWaveformTile = (
  tileBuffer: Array<{ canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }>,
  baseState: FrameState,
  tile: HorizontalBrowseDetailLiveCanvasTileRenderRequest
) => {
  const target = tileBuffer[tile.slotIndex]
  if (!target) return false
  if (target.canvas.width !== tile.scaledWidth) target.canvas.width = tile.scaledWidth
  if (target.canvas.height !== tile.scaledHeight) target.canvas.height = tile.scaledHeight
  target.ctx.setTransform(1, 0, 0, 1, 0, 0)
  target.ctx.imageSmoothingEnabled = false
  target.ctx.clearRect(0, 0, tile.scaledWidth, tile.scaledHeight)
  const tileState: FrameState = {
    ...baseState,
    rangeStartSec: tile.rangeStartSec,
    rangeDurationSec: tile.rangeDurationSec
  }
  return drawRange(
    target.ctx,
    tile.scaledWidth,
    tile.scaledHeight,
    tile.rangeStartSec,
    tile.rangeDurationSec,
    tileState
  )
}

// 每块自己的 FrameState：除时间范围与尺寸外，全部字段与整帧路径一致。
const resolveTileBaseState = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  rawData: RawWaveformData
) =>
  buildFrameState(
    request,
    {
      ...resolveCanvasScaleMetrics(request.width, request.height, request.pixelRatio, {
        preserveFractionalCssSize: true
      }),
      resized: false
    },
    rawData
  )

// 屏幕外块（P1/P2）的续画队列。P0 画完、rendered 已回报之后才继续，避免 overscan 拖住上屏。
let deferredTileWork: {
  renderToken: number
  targetIndex: number
  request: HorizontalBrowseDetailLiveCanvasRenderRequest
  tiles: HorizontalBrowseDetailLiveCanvasTileRenderRequest[]
} | null = null
let deferredTileTimer: ReturnType<typeof setTimeout> | null = null
let deferredTileRaf = 0

function clearDeferredTileWork() {
  deferredTileWork = null
  if (deferredTileTimer) {
    clearTimeout(deferredTileTimer)
    deferredTileTimer = null
  }
  if (deferredTileRaf) {
    const scope = resolveWorkerAnimationFrameScope()
    if (typeof scope.cancelAnimationFrame === 'function') {
      scope.cancelAnimationFrame(deferredTileRaf)
    }
    deferredTileRaf = 0
  }
}

// 每帧只补一块：屏幕外块不参与用户可见的就绪判定，分摊开画可避免一次性长任务再次造成掉帧。
const TILE_DEFERRED_BATCH_SIZE = 1

const scheduleDeferredTiles = () => {
  if (deferredTileRaf || deferredTileTimer || !deferredTileWork) return
  const scope = resolveWorkerAnimationFrameScope()
  if (typeof scope.requestAnimationFrame === 'function') {
    deferredTileRaf = scope.requestAnimationFrame(pumpDeferredTiles)
    return
  }
  deferredTileTimer = setTimeout(pumpDeferredTiles, 0)
}

function pumpDeferredTiles() {
  deferredTileRaf = 0
  deferredTileTimer = null
  const work = deferredTileWork
  if (!work) return
  const tileBuffer = waveformTileBuffers[work.targetIndex] ?? null
  const rawData = resolveRawForRender(work.request)
  if (!tileBuffer || !rawData) {
    deferredTileWork = null
    return
  }
  const baseState = resolveTileBaseState(work.request, rawData)
  const batch = work.tiles.splice(0, TILE_DEFERRED_BATCH_SIZE)
  const renderedTileSlotIndexes: number[] = []
  for (const tile of batch) {
    if (drawWaveformTile(tileBuffer, baseState, tile)) {
      renderedTileSlotIndexes.push(tile.slotIndex)
    }
  }
  const tilesPending = work.tiles.length > 0
  if (renderedTileSlotIndexes.length > 0) {
    // 屏幕外块画好后也要回报，主线程据此更新块池 ready，才能在后续滚动中复用它们。
    // renderViewportOnly=true 让主线程只更新块池、不触碰 promote 与可见面。
    postToMain({
      type: 'rendered',
      payload: {
        renderToken: work.renderToken,
        rangeStartSec: work.request.rangeStartSec,
        rangeDurationSec: work.request.rangeDurationSec,
        ready: true,
        renderViewportOnly: true,
        renderTargetIndex: work.targetIndex,
        stableWaveformSource: work.request.stableWaveformSource === true,
        renderedTileSlotIndexes,
        tilesPending
      }
    })
  }
  if (!tilesPending) {
    deferredTileWork = null
    return
  }
  scheduleDeferredTiles()
}

/**
 * 分块波形渲染：先画可见区（P0），把屏幕外块推入续画队列。
 *
 * 返回可见区是否就绪。false 时 processRender 回报 ready=false，主线程据现有
 * `preserveSurfaceUntilNextReady` 语义继续显示旧可见面——不切换、不露白。
 */
const renderWaveformTiles = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  rawData: RawWaveformData | null
) => {
  const tilePlan = request.tilePlan
  if (!tilePlan) return null
  const targetIndex = request.renderTargetIndex === 1 ? 1 : 0
  const tileBuffer = waveformTileBuffers[targetIndex] ?? null
  if (!tileBuffer || !rawData) {
    return {
      visibleReady: false,
      renderedTileSlotIndexes: [] as number[],
      tilesPending: false
    }
  }
  const baseState = resolveTileBaseState(request, rawData)
  const visibleSlotSet = new Set(tilePlan.visibleSlotIndexes)
  const visibleTiles = tilePlan.tiles.filter((tile) => visibleSlotSet.has(tile.slotIndex))
  const offscreenTiles = tilePlan.tiles.filter((tile) => !visibleSlotSet.has(tile.slotIndex))

  const renderedTileSlotIndexes: number[] = []
  for (const tile of visibleTiles) {
    if (!tileBuffer[tile.slotIndex]) continue
    if (drawWaveformTile(tileBuffer, baseState, tile)) {
      renderedTileSlotIndexes.push(tile.slotIndex)
    }
  }
  // 可见区块要么本轮画成功，要么本就不在待画列表里（= 已复用上一代同块内容）。
  const renderedSlotSet = new Set(renderedTileSlotIndexes)
  const pendingSlotSet = new Set(tilePlan.tiles.map((tile) => tile.slotIndex))
  const visibleReady = tilePlan.visibleSlotIndexes.every(
    (slotIndex) => renderedSlotSet.has(slotIndex) || !pendingSlotSet.has(slotIndex)
  )

  clearDeferredTileWork()
  if (offscreenTiles.length > 0) {
    deferredTileWork = {
      renderToken: request.renderToken,
      targetIndex,
      request,
      tiles: offscreenTiles
    }
    scheduleDeferredTiles()
  }
  return {
    visibleReady,
    renderedTileSlotIndexes,
    tilesPending: offscreenTiles.length > 0
  }
}

const schedulePlaybackRender = (token: number) => {
  clearPlaybackFrameSchedule()
  const renderFrame = () => {
    consumePlaybackFrameSchedule()
    const animation = playbackAnimation
    if (!animation || animation.token !== token || token !== playbackAnimationToken) return
    const nowMs = performance.now()
    const frameGapMs = Math.max(0, nowMs - animation.lastRenderedAtMs)
    if (
      animation.request.rawSlot !== null &&
      frameGapMs > 0 &&
      frameGapMs < PLAYBACK_RENDER_MIN_FRAME_GAP_MS
    ) {
      const delayMs = Math.max(1, PLAYBACK_RENDER_MIN_FRAME_GAP_MS - frameGapMs)
      playbackTimer = setTimeout(renderFrame, delayMs)
      return
    }
    const frameGapTooLong = frameGapMs > PLAYBACK_SCROLL_REUSE_MAX_FRAME_GAP_MS
    const scrollReuseSuppressed = animation.scrollReuseSuppressedFrames > 0
    if (scrollReuseSuppressed) animation.scrollReuseSuppressedFrames -= 1
    if (
      frameGapMs > PLAYBACK_CLOCK_REANCHOR_MIN_FRAME_GAP_MS &&
      !hasPlaybackRenderClock(animation.request)
    ) {
      animation.baseSeconds = resolvePlaybackSeconds(
        animation.request,
        animation.baseSeconds,
        animation.startedAtMs,
        animation.lastRenderedAtMs
      )
      animation.startedAtMs = nowMs
    }
    if (frameGapTooLong)
      animation.scrollReuseSuppressedFrames = PLAYBACK_SCROLL_REUSE_RECOVERY_FRAMES
    const allowScrollReuse =
      !scrollReuseSuppressed && !frameGapTooLong && animation.request.allowScrollReuse !== false
    processRender(buildPlaybackRenderRequest(animation, allowScrollReuse, nowMs), false)
    animation.lastRenderedAtMs = nowMs
    if (playbackAnimation?.token === token && token === playbackAnimationToken) {
      schedulePlaybackRender(token)
    }
  }
  const scope = resolveWorkerAnimationFrameScope()
  if (typeof scope.requestAnimationFrame === 'function') {
    playbackRaf = scope.requestAnimationFrame(renderFrame)
  }
  playbackTimer = setTimeout(
    renderFrame,
    playbackRaf ? PLAYBACK_RENDER_FALLBACK_TIMEOUT_MS : PLAYBACK_RENDER_INTERVAL_MS
  )
}

const activatePlaybackAnimation = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
  const current = playbackAnimation
  const nowMs = performance.now()
  const incomingSeconds = Number(request.playbackSeconds) || 0
  const requestUsesRenderClock = hasPlaybackRenderClock(request)
  const incomingStartedAtMs = resolvePlaybackRenderClockStartedAtMs(request, nowMs)
  const forceIncomingSeconds =
    current &&
    Math.floor(Number(request.playbackSyncRevision) || 0) !==
      Math.floor(Number(current.request.playbackSyncRevision) || 0)
  const shouldRestartSchedule = !current || forceIncomingSeconds
  const token = shouldRestartSchedule || !current ? playbackAnimationToken + 1 : current.token
  const baseSeconds = current
    ? forceIncomingSeconds || requestUsesRenderClock
      ? incomingSeconds
      : resolvePlaybackSeconds(current.request, current.baseSeconds, current.startedAtMs, nowMs)
    : incomingSeconds
  const currentSuppressedFrames =
    current && !forceIncomingSeconds ? current.scrollReuseSuppressedFrames : 0
  const shouldWarmUpScrollReuse =
    request.playbackActive === true &&
    request.allowScrollReuse === false &&
    request.rawSlot !== null
  const scrollReuseSuppressedFrames = shouldWarmUpScrollReuse
    ? Math.max(currentSuppressedFrames, PLAYBACK_SCROLL_REUSE_RECOVERY_FRAMES)
    : currentSuppressedFrames
  const animationRequest = shouldWarmUpScrollReuse
    ? { ...request, allowScrollReuse: true }
    : request
  const canContinueCurrentAnimation =
    !!current &&
    !!lastFrame &&
    !forceIncomingSeconds &&
    request.rawSlot !== null &&
    current.request.rawSlot === request.rawSlot &&
    current.request.width === request.width &&
    current.request.height === request.height &&
    current.request.pixelRatio === request.pixelRatio &&
    current.request.rangeDurationSec === request.rangeDurationSec &&
    current.request.waveformLayout === request.waveformLayout &&
    current.request.waveformRenderStyle === request.waveformRenderStyle &&
    current.request.themeVariant === request.themeVariant &&
    normalizeWaveformGain(current.request.waveformGain) ===
      normalizeWaveformGain(request.waveformGain)
  if (canContinueCurrentAnimation) {
    current.request = animationRequest
    if (requestUsesRenderClock) {
      current.baseSeconds = baseSeconds
      current.startedAtMs = incomingStartedAtMs
    }
    current.scrollReuseSuppressedFrames = scrollReuseSuppressedFrames
    const continuedRenderRequest = buildPlaybackRenderRequest(
      current,
      request.allowScrollReuse !== false,
      nowMs
    )
    processRender(
      {
        ...continuedRenderRequest,
        renderToken: request.renderToken
      },
      true
    )
    current.lastRenderedAtMs = performance.now()
    if (!playbackTimer) {
      schedulePlaybackRender(current.token)
    }
    return
  }
  if (shouldRestartSchedule) {
    playbackAnimationToken = token
  }
  clearPlaybackFrameSchedule()
  playbackAnimation = {
    token,
    request: animationRequest,
    baseSeconds,
    startedAtMs: requestUsesRenderClock ? incomingStartedAtMs : nowMs,
    lastRenderedAtMs: nowMs,
    scrollReuseSuppressedFrames
  }
  const shouldPredictInitialFullRender =
    !requestUsesRenderClock && request.rawSlot !== null && request.allowScrollReuse === false
  const initialRenderLeadMs = shouldPredictInitialFullRender
    ? clampPlaybackRenderLeadMs(playbackInitialFullRenderLeadMs)
    : 0
  const initialRenderRequest = buildPlaybackRenderRequest(
    playbackAnimation,
    request.allowScrollReuse !== false,
    nowMs + initialRenderLeadMs
  )
  processRender(initialRenderRequest, true)
  if (shouldPredictInitialFullRender && playbackAnimation) {
    const committedAtMs = performance.now()
    const renderElapsedMs = Math.max(0, committedAtMs - nowMs)
    playbackInitialFullRenderLeadMs = clampPlaybackRenderLeadMs(
      playbackInitialFullRenderLeadMs * 0.65 + renderElapsedMs * 0.35
    )
    playbackAnimation.baseSeconds = initialRenderRequest.playbackSeconds
    playbackAnimation.startedAtMs = committedAtMs
    playbackAnimation.lastRenderedAtMs = committedAtMs
  }
  if (playbackAnimation?.token === token && !playbackTimer) {
    schedulePlaybackRender(token)
  }
}

const processRenderRequest = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
  const stableWaveformSource = request.stableWaveformSource === true
  const shouldAnimatePlayback = request.playbackActive === true && !stableWaveformSource

  if (shouldAnimatePlayback) {
    activatePlaybackAnimation(request)
    return
  }

  if (request.playbackActive !== true || stableWaveformSource) {
    stopPlaybackAnimation()
  }
  processRender(request)
}

const scheduleRender = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
  if (request.renderPriority === 'immediate') {
    if (renderTimer) {
      clearTimeout(renderTimer)
      renderTimer = null
    }
    pendingRender = null
    processRenderRequest(request)
    return
  }
  pendingRender = request
  if (renderTimer) return
  renderTimer = setTimeout(() => {
    renderTimer = null
    const nextRender = pendingRender
    pendingRender = null
    if (nextRender) {
      processRenderRequest(nextRender)
    }
  }, 0)
}

self.onmessage = (event: MessageEvent<HorizontalBrowseDetailLiveCanvasWorkerIncoming>) => {
  const message = event.data
  if (!message?.type) return

  if (message.type === 'attachCanvas') {
    canvasBufferManager.attach(
      message.payload.waveformCanvases ?? [message.payload.waveformCanvas],
      message.payload.overlayCanvases ?? [message.payload.overlayCanvas]
    )
    waveformTileBuffers = (message.payload.waveformTileCanvases ?? []).map((bufferTiles) =>
      bufferTiles.flatMap((tileCanvas) => {
        const tileCtx = tileCanvas.getContext('2d')
        return tileCtx ? [{ canvas: tileCanvas, ctx: tileCtx }] : []
      })
    )
    const selected = canvasBufferManager.resolve(0)
    canvas = selected?.canvas ?? null
    ctx = selected?.ctx ?? null
    overlayRenderer = selected?.overlayRenderer ?? overlayRenderer
    scrollSourceCanvas = canvas
    resetFrameState()
    return
  }

  if (message.type === 'clear') {
    clearCanvasPixels()
    return
  }

  if (message.type === 'clearRaw') {
    rawStore.clear()
    clearCanvasPixels()
    return
  }

  if (message.type === 'stopPlayback') {
    stopPlaybackAnimationAndPendingRender()
    return
  }

  if (message.type === 'replaceRaw') {
    rawStore.replace(message.payload.data)
    return
  }

  if (message.type === 'render') {
    scheduleRender(message.payload)
  }
}
