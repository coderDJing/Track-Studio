import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { createRawPlaceholderMixxxData } from '@renderer/components/beatGridWaveformPlaceholder'
import { drawRgbWaveform } from '@renderer/components/rgbWaveformRenderer'
import { clampNumber } from '@renderer/composables/horizontalBrowse/horizontalBrowseMath'
import { canCommitHorizontalBrowseBlankRawSegment } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCoverage'
import type { CanvasMetrics, FrameState } from './horizontalBrowseDetailLiveCanvasRenderState'
import type { HorizontalBrowseDetailLiveCanvasRenderRequest } from './horizontalBrowseDetailLiveCanvas.types'

const COLUMN_SMOOTH_OVERSCAN_SCALED_PX = 2
const VIEWPORT_RENDER_GUARD_RATIO = 0.35

export const ensureHorizontalBrowseDetailLiveCanvasScratch = (
  currentCanvas: OffscreenCanvas | null,
  currentCtx: OffscreenCanvasRenderingContext2D | null,
  scaledWidth: number,
  scaledHeight: number
) => {
  let nextCanvas = currentCanvas
  let nextCtx = currentCtx
  if (!nextCanvas) {
    nextCanvas = new OffscreenCanvas(scaledWidth, scaledHeight)
    nextCtx = nextCanvas.getContext('2d')
  }
  if (!nextCanvas || !nextCtx) return null
  if (nextCanvas.width !== scaledWidth || nextCanvas.height !== scaledHeight) {
    nextCanvas.width = scaledWidth
    nextCanvas.height = scaledHeight
  }
  return {
    canvas: nextCanvas,
    ctx: nextCtx
  }
}

export const createHorizontalBrowseDetailLiveCanvasWaveformPainter = () => {
  let segmentCanvas: OffscreenCanvas | null = null
  let segmentCtx: OffscreenCanvasRenderingContext2D | null = null

  const ensureSegmentScratch = (scaledWidth: number, scaledHeight: number) => {
    const scratch = ensureHorizontalBrowseDetailLiveCanvasScratch(
      segmentCanvas,
      segmentCtx,
      scaledWidth,
      scaledHeight
    )
    if (!scratch) return null
    segmentCanvas = scratch.canvas
    segmentCtx = scratch.ctx
    return scratch
  }

  const createMixxxData = (rawData: RawWaveformData | null): MixxxWaveformData | null =>
    rawData ? createRawPlaceholderMixxxData(rawData) : null

  const drawRange = (
    targetCtx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number,
    rangeStartSec: number,
    rangeDurationSec: number,
    state: FrameState
  ) =>
    drawRgbWaveform(targetCtx, {
      width,
      height,
      timeBasisOffsetMs: state.timeBasisOffsetMs,
      rangeStartSec,
      rangeDurationSec,
      mixxxData: createMixxxData(state.rawData),
      rawData: state.rawData,
      showBackground: state.showBackground,
      maxSamplesPerPixel: state.maxSamplesPerPixel,
      showDetailHighlights: state.showDetailHighlights,
      showCenterLine: state.showCenterLine,
      waveformLayout: state.waveformLayout,
      waveformRenderStyle: state.waveformRenderStyle,
      preferRawPeaksOnly: state.preferRawPeaksOnly,
      smoothColumns: state.waveformRenderStyle === 'columns' && state.waveformLayout !== 'full',
      themeVariant: state.themeVariant,
      waveformGain: state.waveformGain
    }) ||
    // 曲头、曲尾的合法空白也能作为已就绪帧提交，播放可沿这张帧继续滚动。
    canCommitHorizontalBrowseBlankRawSegment(
      state.rawData,
      rangeStartSec,
      rangeDurationSec,
      Math.max(0, Number(state.timeBasisOffsetMs) || 0) / 1000
    )

  const renderSegmentToScratch = (
    metrics: CanvasMetrics,
    state: FrameState,
    segmentScaledX: number,
    segmentScaledWidth: number
  ) => {
    const smoothingOverscanScaledPx =
      state.waveformRenderStyle === 'columns' && state.waveformLayout !== 'full'
        ? COLUMN_SMOOTH_OVERSCAN_SCALED_PX
        : 0
    const safeSegmentX = clampNumber(
      Math.floor(segmentScaledX),
      0,
      Math.max(0, metrics.scaledWidth - 1)
    )
    const safeSegmentWidth = clampNumber(
      Math.ceil(segmentScaledWidth),
      1,
      Math.max(1, metrics.scaledWidth - safeSegmentX)
    )
    const drawSegmentX = clampNumber(
      safeSegmentX - smoothingOverscanScaledPx,
      0,
      Math.max(0, metrics.scaledWidth - 1)
    )
    const drawSegmentEndX = clampNumber(
      safeSegmentX + safeSegmentWidth + smoothingOverscanScaledPx,
      drawSegmentX + 1,
      metrics.scaledWidth
    )
    const drawSegmentWidth = Math.max(1, drawSegmentEndX - drawSegmentX)
    const sourceX = safeSegmentX - drawSegmentX
    const segment = ensureSegmentScratch(drawSegmentWidth, metrics.scaledHeight)
    if (!segment) return false

    const segmentStartSec =
      state.rangeStartSec + (drawSegmentX / metrics.scaledWidth) * state.rangeDurationSec
    const segmentDurationSec = (drawSegmentWidth / metrics.scaledWidth) * state.rangeDurationSec

    segment.ctx.setTransform(1, 0, 0, 1, 0, 0)
    segment.ctx.clearRect(0, 0, segment.canvas.width, segment.canvas.height)
    segment.ctx.imageSmoothingEnabled = false
    const rendered = drawRange(
      segment.ctx,
      drawSegmentWidth,
      metrics.scaledHeight,
      segmentStartSec,
      segmentDurationSec,
      state
    )
    if (!rendered) return false

    return {
      canvas: segment.canvas,
      safeSegmentX,
      safeSegmentWidth,
      sourceX
    }
  }

  const copySegmentToCanvas = (
    targetCtx: OffscreenCanvasRenderingContext2D,
    metrics: CanvasMetrics,
    segment: Exclude<ReturnType<typeof renderSegmentToScratch>, false>
  ) => {
    const destX = clampNumber(segment.safeSegmentX, 0, Math.max(0, metrics.scaledWidth - 1))
    const copyWidth = Math.max(1, Math.min(segment.safeSegmentWidth, metrics.scaledWidth - destX))
    targetCtx.setTransform(1, 0, 0, 1, 0, 0)
    targetCtx.imageSmoothingEnabled = false
    targetCtx.clearRect(destX, 0, copyWidth, metrics.scaledHeight)
    targetCtx.drawImage(
      segment.canvas,
      segment.sourceX,
      0,
      copyWidth,
      metrics.scaledHeight,
      destX,
      0,
      copyWidth,
      metrics.scaledHeight
    )
  }

  const drawSegment = (
    targetCtx: OffscreenCanvasRenderingContext2D,
    metrics: CanvasMetrics,
    state: FrameState,
    segmentScaledX: number,
    segmentScaledWidth: number
  ) => {
    const segment = renderSegmentToScratch(metrics, state, segmentScaledX, segmentScaledWidth)
    if (!segment) return false
    copySegmentToCanvas(targetCtx, metrics, segment)
    return true
  }

  const renderViewportSegment = (
    ctx: OffscreenCanvasRenderingContext2D,
    request: HorizontalBrowseDetailLiveCanvasRenderRequest,
    metrics: CanvasMetrics,
    state: FrameState
  ) => {
    const viewportWidth = Math.max(1, Number(request.viewportWidth) || metrics.cssWidth)
    if (Math.abs(viewportWidth - metrics.cssWidth) <= 0.5) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
      return drawRange(
        ctx,
        metrics.scaledWidth,
        metrics.scaledHeight,
        state.rangeStartSec,
        state.rangeDurationSec,
        state
      )
    }
    const viewportRangeStartSec = Number(request.viewportRangeStartSec)
    const viewportRangeDurationSec = Number(request.viewportRangeDurationSec)
    if (
      !Number.isFinite(viewportRangeStartSec) ||
      !Number.isFinite(viewportRangeDurationSec) ||
      viewportRangeDurationSec <= 0
    ) {
      return false
    }
    const rawSegmentX =
      ((viewportRangeStartSec - state.rangeStartSec) / Math.max(0.0001, state.rangeDurationSec)) *
      metrics.scaledWidth
    const rawSegmentWidth =
      (viewportRangeDurationSec / Math.max(0.0001, state.rangeDurationSec)) * metrics.scaledWidth
    const guardScaledPx = Math.min(
      metrics.scaledWidth,
      Math.max(metrics.scaleX * 32, rawSegmentWidth * VIEWPORT_RENDER_GUARD_RATIO)
    )
    const segmentX = Math.max(0, rawSegmentX - guardScaledPx)
    const segmentWidth = Math.min(
      metrics.scaledWidth - segmentX,
      rawSegmentWidth + guardScaledPx * 2
    )
    const clearX = clampNumber(Math.floor(segmentX) - 2, 0, Math.max(0, metrics.scaledWidth - 1))
    const clearEndX = clampNumber(
      Math.ceil(segmentX + segmentWidth) + 2,
      clearX + 1,
      metrics.scaledWidth
    )
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(clearX, 0, clearEndX - clearX, metrics.scaledHeight)
    return drawSegment(ctx, metrics, state, segmentX, segmentWidth)
  }

  return {
    drawRange,
    ensureSegmentScratch,
    renderSegmentToScratch,
    copySegmentToCanvas,
    renderViewportSegment
  }
}
