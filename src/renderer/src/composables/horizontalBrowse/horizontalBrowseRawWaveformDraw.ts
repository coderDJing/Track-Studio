import type { Ref } from 'vue'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { PREVIEW_MAX_SAMPLES_PER_PIXEL } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { startHorizontalBrowseUserTiming } from './horizontalBrowseUserTiming'
import { hasHorizontalBrowseDrawableRawFrames } from './horizontalBrowseRawWaveformRenderPayload'
import {
  isHorizontalBrowseRawDataCoveringRenderRange,
  isHorizontalBrowseRawDataIntersectingRenderRange,
  resolveHorizontalBrowseActiveMixxxSelectionForCanvas
} from './horizontalBrowseRawWaveformCanvasHelpers'
import type { UseHorizontalBrowseRawWaveformCanvasOptions } from './horizontalBrowseRawWaveformCanvasTypes'
import type { HorizontalBrowseRawWaveformDrawOptions } from './horizontalBrowseRawWaveformDrawScheduler'

export type HorizontalBrowseLiveWaveformRenderPayload = {
  rangeStartSec: number
  rangeDurationSec: number
  rawData: RawWaveformData | null
  maxSamplesPerPixel: number
  allowScrollReuse: boolean
  preferRawPeaksOnly: boolean
  completeSeekTransition?: boolean
  preferPreviewStart?: boolean
  viewportOnly?: boolean
}

export type HorizontalBrowseRawWaveformDrawState = {
  suppressNextPlaybackScrollReuse: boolean
  lastRenderedRawData: RawWaveformData | null
  lastDrawPlaybackActive: boolean
}

type DrawParams = {
  options: UseHorizontalBrowseRawWaveformCanvasOptions
  state: HorizontalBrowseRawWaveformDrawState
  wrapRef: Ref<HTMLDivElement | null>
  activeWaveformCanvas: () => HTMLCanvasElement | null
  dragPresentationActive: () => boolean
  resolvePreviewDurationSec: () => number
  resolveVisibleDurationSec: () => number
  clampPreviewStart: (seconds: number) => number
  resolveSnappedRenderStartSec: (visibleDurationSec: number) => number
  resolvePlaybackDrivenRenderStartSec: (visibleDurationSec: number) => number
  resolveDisplayReadyForReuse: () => boolean
  resolveStableWaveformSource: () => boolean
  resolveTimeBasisOffsetSec: () => number
  canShowTimelinePlaceholder: () => boolean
  placeholderVisible: Ref<boolean>
  clearCanvas: () => void
  setDisplayReady: (ready: boolean) => void
  queueLiveWaveformRender: (payload: HorizontalBrowseLiveWaveformRenderPayload) => boolean
}

export const createHorizontalBrowseRawWaveformDraw = (params: DrawParams) => {
  const {
    options,
    state,
    wrapRef,
    activeWaveformCanvas,
    dragPresentationActive,
    resolvePreviewDurationSec,
    resolveVisibleDurationSec,
    clampPreviewStart,
    resolveSnappedRenderStartSec,
    resolvePlaybackDrivenRenderStartSec,
    resolveDisplayReadyForReuse,
    resolveStableWaveformSource,
    resolveTimeBasisOffsetSec,
    canShowTimelinePlaceholder,
    placeholderVisible,
    clearCanvas,
    setDisplayReady,
    queueLiveWaveformRender
  } = params

  return (drawOptions: HorizontalBrowseRawWaveformDrawOptions = {}) => {
    if (dragPresentationActive()) return
    if (!wrapRef.value || !activeWaveformCanvas()) return

    const duration = resolvePreviewDurationSec()
    if (!duration) {
      placeholderVisible.value = false
      clearCanvas()
      setDisplayReady(false)
      return
    }

    const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
    options.previewStartSec.value = clampPreviewStart(options.previewStartSec.value)
    const renderStartSec =
      drawOptions.preferPreviewStart === true
        ? resolveSnappedRenderStartSec(visibleDuration)
        : resolvePlaybackDrivenRenderStartSec(visibleDuration)
    const wasDisplayReady = resolveDisplayReadyForReuse()
    const stableWaveformSource = resolveStableWaveformSource()
    const playbackViewportMoving = options.playing.value && !options.dragging.value
    const playbackStartedThisDraw = playbackViewportMoving && !state.lastDrawPlaybackActive
    state.lastDrawPlaybackActive = playbackViewportMoving
    const canReusePlaybackScroll =
      playbackViewportMoving &&
      wasDisplayReady &&
      !state.suppressNextPlaybackScrollReuse &&
      (!playbackStartedThisDraw || stableWaveformSource)
    const maxSamplesPerPixel = PREVIEW_MAX_SAMPLES_PER_PIXEL
    const activeMixxxSelection = resolveHorizontalBrowseActiveMixxxSelectionForCanvas(
      options.mixxxData.value
    )
    const preferPreviewStart = drawOptions.preferPreviewStart === true
    const viewportOnly = drawOptions.viewportOnly === true
    const effectiveRawData = options.rawData.value
    const effectiveMixxxSelection = activeMixxxSelection.data
      ? activeMixxxSelection
      : { data: null, source: 'none' as const }
    const effectiveMixxxDrawable =
      !!effectiveMixxxSelection.data && effectiveMixxxSelection.source !== 'placeholder'
    const timeBasisOffsetSec = resolveTimeBasisOffsetSec()
    const effectiveRawCoverage = isHorizontalBrowseRawDataCoveringRenderRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration,
      timeBasisOffsetSec
    )
    const allowPlaybackScrollReuse = canReusePlaybackScroll
    const effectiveRawIntersection = isHorizontalBrowseRawDataIntersectingRenderRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration,
      timeBasisOffsetSec
    )
    const drawableRawData = effectiveRawIntersection ? effectiveRawData : null
    const canRenderWithoutRawCoverage = effectiveMixxxSelection.source === 'live'
    const shouldHoldPlaybackFrame =
      playbackViewportMoving && !stableWaveformSource && wasDisplayReady
    const hasBeatGridTarget = Number(options.previewBpm.value) > 0 || !!options.beatGridMap?.()
    const hasTimelinePlaceholderTarget =
      canShowTimelinePlaceholder() &&
      !hasBeatGridTarget &&
      !hasHorizontalBrowseDrawableRawFrames(drawableRawData)
    const shouldShowEmptySurface = hasTimelinePlaceholderTarget || hasBeatGridTarget

    if (!effectiveMixxxDrawable && !drawableRawData) {
      if (shouldHoldPlaybackFrame) return
      state.lastRenderedRawData = null
      placeholderVisible.value = shouldShowEmptySurface
      setDisplayReady(false)
      queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: null,
        maxSamplesPerPixel,
        allowScrollReuse: false,
        preferRawPeaksOnly: false,
        preferPreviewStart,
        viewportOnly
      })
    } else if (options.playing.value || options.dragging.value) {
      const rawDataRefStable =
        drawableRawData != null && drawableRawData === state.lastRenderedRawData
      const allowPartialViewportPaint =
        Boolean(drawableRawData) &&
        !playbackViewportMoving &&
        (options.dragging.value || !options.playing.value || !wasDisplayReady)
      const canDrawWaveform =
        Boolean(drawableRawData) &&
        (effectiveRawCoverage ||
          (allowPlaybackScrollReuse && rawDataRefStable) ||
          allowPartialViewportPaint)
      if (!canDrawWaveform) {
        if (shouldHoldPlaybackFrame) return
        state.lastRenderedRawData = null
        placeholderVisible.value = shouldShowEmptySurface
        setDisplayReady(false)
        queueLiveWaveformRender({
          rangeStartSec: renderStartSec,
          rangeDurationSec: visibleDuration,
          rawData: null,
          maxSamplesPerPixel,
          allowScrollReuse: false,
          preferRawPeaksOnly: false,
          preferPreviewStart,
          viewportOnly
        })
      } else {
        const finishTiming = startHorizontalBrowseUserTiming(
          `frkb:hb:canvas:worker-live:${options.direction()}`
        )
        const queued = queueLiveWaveformRender({
          rangeStartSec: renderStartSec,
          rangeDurationSec: visibleDuration,
          rawData: drawableRawData,
          maxSamplesPerPixel,
          allowScrollReuse: allowPlaybackScrollReuse,
          preferRawPeaksOnly: false,
          completeSeekTransition: effectiveRawCoverage,
          preferPreviewStart,
          viewportOnly
        })
        if (queued) state.lastRenderedRawData = drawableRawData
        state.suppressNextPlaybackScrollReuse = false
        finishTiming()
      }
    } else if (!drawableRawData && !canRenderWithoutRawCoverage) {
      state.lastRenderedRawData = null
      placeholderVisible.value = shouldShowEmptySurface
      setDisplayReady(false)
      queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: null,
        maxSamplesPerPixel,
        allowScrollReuse: false,
        preferRawPeaksOnly: false,
        preferPreviewStart,
        viewportOnly
      })
    } else {
      placeholderVisible.value = false
      const finishTiming = startHorizontalBrowseUserTiming(
        `frkb:hb:canvas:worker-live:${options.direction()}`
      )
      const queued = queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: drawableRawData,
        maxSamplesPerPixel,
        allowScrollReuse: allowPlaybackScrollReuse,
        preferRawPeaksOnly: false,
        completeSeekTransition: effectiveRawCoverage,
        preferPreviewStart,
        viewportOnly
      })
      if (queued) state.lastRenderedRawData = drawableRawData
      state.suppressNextPlaybackScrollReuse = false
      finishTiming()
    }
  }
}
