import { ref, watch, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { resolveHorizontalBrowseDefaultCuePointSec } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailMath'
import type { HorizontalBrowseRawWaveformDrawOptions } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDrawScheduler'
import {
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
  HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR,
  HORIZONTAL_BROWSE_EDIT_DETAIL_MAX_ZOOM
} from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { clampNumber } from '@renderer/components/MixtapeBeatAlignDialog.constants'

type UseMixtapeBeatAlignWaveformErrorParams = {
  previewWaveformRequestStarted: Ref<boolean>
  previewLoading: Ref<boolean>
  previewMixxxData: Ref<MixxxWaveformData | null>
  previewError: Ref<string>
  resolveUnavailableText: () => string
}

export const useMixtapeBeatAlignWaveformError = (
  params: UseMixtapeBeatAlignWaveformErrorParams
) => {
  const syncPreviewWaveformError = () => {
    if (!params.previewWaveformRequestStarted.value) return
    if (params.previewLoading.value) {
      params.previewError.value = ''
      return
    }
    params.previewError.value = params.previewMixxxData.value ? '' : params.resolveUnavailableText()
  }

  watch(
    () => [params.previewLoading.value, params.previewMixxxData.value] as const,
    () => {
      syncPreviewWaveformError()
    }
  )

  return {
    syncPreviewWaveformError
  }
}

type UseMixtapeBeatAlignInitialGridAlignmentParams = {
  song: () => ISongInfo | null
  previewWaveformData: Ref<RawWaveformData | null>
  previewMixxxData: Ref<MixxxWaveformData | null>
  previewStartSec: Ref<number>
  resolvePreviewDurationSec: () => number
  resolvePlaybackAlignedStart: (seconds: number) => number
  schedulePreviewDraw: () => void
}

export const useMixtapeBeatAlignInitialGridAlignment = (
  params: UseMixtapeBeatAlignInitialGridAlignmentParams
) => {
  const pending = ref(false)

  const alignPreviewStartToInitialGrid = () => {
    const durationSec = params.resolvePreviewDurationSec()
    if (durationSec <= 0) return false
    const defaultCueSec = resolveHorizontalBrowseDefaultCuePointSec(params.song(), durationSec)
    params.previewStartSec.value = params.resolvePlaybackAlignedStart(defaultCueSec)
    return true
  }

  watch(
    () => [params.previewWaveformData.value, params.previewMixxxData.value] as const,
    () => {
      if (!pending.value || !params.previewMixxxData.value) return
      if (!alignPreviewStartToInitialGrid()) return
      pending.value = false
      params.schedulePreviewDraw()
    }
  )

  return {
    markInitialGridAlignmentPending: () => {
      pending.value = true
    },
    clearInitialGridAlignmentPending: () => {
      pending.value = false
    }
  }
}

type DragPresentationStartResult = {
  viewportStartSec: number | null
}

type DragPresentationEndResult = {
  requiresRender: boolean
}

type UseMixtapeBeatAlignPreviewInteractionParams = {
  previewWrapRef: Ref<HTMLDivElement | null>
  previewDragging: Ref<boolean>
  previewPlaying: Ref<boolean>
  previewMixxxData: Ref<MixxxWaveformData | null>
  previewStartSec: Ref<number>
  previewZoom: Ref<number>
  resolvePreviewDurationSec: () => number
  resolveVisibleDurationSec: () => number
  resolvePreviewAnchorSec: () => number
  clampPreviewStart: (value: number) => number
  getPreviewPlaybackSec: () => number
  handlePreviewMouseDownForGridTargetSelect: (event: MouseEvent) => boolean
  requestCompactVisualWaveformStrip: (
    anchorSec?: number,
    options?: { force?: boolean; clearIfOutside?: boolean }
  ) => Promise<boolean>
  startPreviewScrub: (
    anchorSec: number,
    options?: { resumePlaybackOnStop?: boolean }
  ) => Promise<boolean>
  updatePreviewScrub: (anchorSec: number, rate: number) => void
  stopPreviewScrub: (anchorSec?: number) => Promise<boolean>
  seekPreviewAnchorSec: (anchorSec: number) => Promise<void>
  beginDragCanvasPresentation: () => DragPresentationStartResult
  updateDragCanvasPresentation: () => void
  endDragCanvasPresentation: (viewportStartSec?: number) => DragPresentationEndResult
  drawWaveformNow: (drawOptions?: HorizontalBrowseRawWaveformDrawOptions) => void
  schedulePreviewDraw: (drawOptions?: HorizontalBrowseRawWaveformDrawOptions) => void
  resetGridRenderer: () => void
}

export const useMixtapeBeatAlignPreviewInteraction = (
  params: UseMixtapeBeatAlignPreviewInteractionParams
) => {
  let dragStartClientX = 0
  let dragStartSec = 0
  let dragLastAnchorSec = 0
  let dragLastTs = 0
  let dragScrubbing = false
  let dragScrubToken = 0

  const handlePreviewWheel = (event: WheelEvent) => {
    const wrap = params.previewWrapRef.value
    const total = params.resolvePreviewDurationSec()
    if (!wrap || !total) return
    event.preventDefault()

    const rect = wrap.getBoundingClientRect()
    const pointerRatio =
      rect.width > 0 ? clampNumber((event.clientX - rect.left) / rect.width, 0, 1) : 0.5
    const playbackActive = params.previewPlaying.value
    const beforeDuration = params.resolveVisibleDurationSec()
    const anchorRatio = playbackActive ? HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO : pointerRatio
    const anchorSec = playbackActive
      ? params.getPreviewPlaybackSec()
      : params.previewStartSec.value + beforeDuration * pointerRatio
    const factor =
      event.deltaY < 0
        ? HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR
        : 1 / HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR
    const nextZoom = clampNumber(
      params.previewZoom.value * factor,
      HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
      HORIZONTAL_BROWSE_EDIT_DETAIL_MAX_ZOOM
    )
    if (Math.abs(nextZoom - params.previewZoom.value) <= 0.000001) return
    params.previewZoom.value = nextZoom
    const nextDuration = params.resolveVisibleDurationSec()
    params.previewStartSec.value = params.clampPreviewStart(anchorSec - nextDuration * anchorRatio)
    params.resetGridRenderer()
    void params.requestCompactVisualWaveformStrip(params.resolvePreviewAnchorSec(), {
      clearIfOutside: true
    })
    params.schedulePreviewDraw(
      playbackActive ? undefined : { preferPreviewStart: true, viewportOnly: true }
    )
  }

  const handlePreviewDragMove = (event: MouseEvent) => {
    if (!params.previewDragging.value) return
    const wrap = params.previewWrapRef.value
    if (!wrap) return
    const width = Math.max(1, wrap.clientWidth)
    const visibleDuration = params.resolveVisibleDurationSec()
    if (!visibleDuration) return

    const deltaX = event.clientX - dragStartClientX
    const deltaSec = (deltaX / width) * visibleDuration
    params.previewStartSec.value = params.clampPreviewStart(dragStartSec - deltaSec)
    params.updateDragCanvasPresentation()

    const anchorSec = params.resolvePreviewAnchorSec()
    const now = performance.now()
    if (dragScrubbing) {
      const dtSec = Math.max(0.001, (now - dragLastTs) / 1000)
      params.updatePreviewScrub(anchorSec, (anchorSec - dragLastAnchorSec) / dtSec)
    }
    dragLastAnchorSec = anchorSec
    dragLastTs = now
  }

  const stopPreviewDragging = () => {
    if (!params.previewDragging.value) return
    params.previewDragging.value = false
    window.removeEventListener('mousemove', handlePreviewDragMove)
    window.removeEventListener('mouseup', stopPreviewDragging)
    const finalAnchorSec = params.resolvePreviewAnchorSec()
    dragScrubToken += 1
    if (dragScrubbing) {
      dragScrubbing = false
      void params.stopPreviewScrub(finalAnchorSec)
    } else if (params.previewPlaying.value) {
      void params.seekPreviewAnchorSec(finalAnchorSec)
    }
    const dragRelease = params.endDragCanvasPresentation(params.previewStartSec.value)
    void params.requestCompactVisualWaveformStrip(finalAnchorSec, { clearIfOutside: true })
    if (dragRelease.requiresRender) {
      params.drawWaveformNow({ preferPreviewStart: true })
    } else {
      params.schedulePreviewDraw({ preferPreviewStart: true })
    }
  }

  const handlePreviewMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !params.previewMixxxData.value) return
    if (params.handlePreviewMouseDownForGridTargetSelect(event)) return

    params.previewDragging.value = true
    dragStartClientX = event.clientX
    const dragPresentation = params.beginDragCanvasPresentation()
    dragStartSec =
      dragPresentation.viewportStartSec !== null &&
      Number.isFinite(dragPresentation.viewportStartSec)
        ? params.clampPreviewStart(dragPresentation.viewportStartSec)
        : params.previewStartSec.value
    params.previewStartSec.value = dragStartSec
    dragLastAnchorSec = params.resolvePreviewAnchorSec()
    dragLastTs = performance.now()
    dragScrubbing = false
    const shouldResumePlayback = params.previewPlaying.value
    const token = ++dragScrubToken
    void params
      .startPreviewScrub(dragLastAnchorSec, { resumePlaybackOnStop: shouldResumePlayback })
      .then((started) => {
        if (!started) return
        if (token !== dragScrubToken || !params.previewDragging.value) {
          void params.stopPreviewScrub(params.resolvePreviewAnchorSec())
          return
        }
        dragScrubbing = true
        dragLastAnchorSec = params.resolvePreviewAnchorSec()
        dragLastTs = performance.now()
        params.updatePreviewScrub(dragLastAnchorSec, 0)
      })
    window.addEventListener('mousemove', handlePreviewDragMove, { passive: false })
    window.addEventListener('mouseup', stopPreviewDragging, { passive: true })
  }

  return {
    handlePreviewWheel,
    handlePreviewMouseDown,
    stopPreviewDragging
  }
}
