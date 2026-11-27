import { watch, type Ref } from 'vue'
import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import type {
  HorizontalBrowseDetailZoomChangePayload,
  HorizontalBrowseDragSessionEndPayload
} from './horizontalBrowseRawWaveformDetailTypes'

type DragPresentationStartResult = {
  viewportStartSec: number | null
}

type DragPresentationEndResult = {
  requiresRender: boolean
}

type PointerInteractionOptions = {
  wrapRef: Ref<HTMLDivElement | null>
  dragging: Ref<boolean>
  previewStartSec: Ref<number>
  previewZoom: Ref<number>
  previewMaxZoom: Ref<number>
  direction: () => 'up' | 'down'
  hasSong: () => boolean
  resolvePreviewDurationSec: () => number
  resolveVisibleDurationSec: () => number
  resolvePreviewAnchorSec: () => number
  resolveWaveformCurrentSeconds: () => number
  clampPreviewStart: (seconds: number) => number
  beginDragCanvasPresentation: () => DragPresentationStartResult
  updateDragCanvasPresentation: () => void
  endDragCanvasPresentation: (
    viewportStartSec?: number,
    linkedRelease?: boolean
  ) => DragPresentationEndResult
  clearDragReleaseHandoff: () => void
  beginDragReleaseHandoff: (anchorSec: number) => void
  scrubPreview: {
    start: (anchorSec: number) => void
    update: (anchorSec: number) => void
    stop: (options?: { flushPending?: boolean }) => void
  }
  handlePreviewMouseDownForGridTargetSelect: (event: PointerEvent) => boolean
  emitToolbarState: () => void
  schedulePersistGridDefinition: () => void
  emitDragSessionStart: () => void
  emitDragSessionEnd: (payload: HorizontalBrowseDragSessionEndPayload) => void
  emitZoomChange: (payload: HorizontalBrowseDetailZoomChangePayload) => void
  linkedDragActive?: () => boolean
  linkedDragAnchorSec?: () => number | null
  resolvePlaybackActive: () => boolean
  maybeContinueWaveformSource: (anchorSec?: number) => void
  drawWaveformNow: (options?: { preferPreviewStart?: boolean; viewportOnly?: boolean }) => void
  scheduleDraw: (drawOptions?: { preferPreviewStart?: boolean; viewportOnly?: boolean }) => void
  zoomStepFactor: number
  minZoom: number
  clampNumber: (value: number, min: number, max: number) => number
}

export const createHorizontalBrowseWaveformPointerInteraction = (
  options: PointerInteractionOptions
) => {
  let dragStartClientX = 0
  let dragStartSec = 0
  let activeDragPointerId: number | null = null
  let linkedDragPresentationActive = false

  const finishLinkedDragPresentation = (committed = false) => {
    if (!linkedDragPresentationActive) return
    const finalAnchorSec = options.resolvePreviewAnchorSec()
    const finalPreviewStartSec = options.previewStartSec.value
    linkedDragPresentationActive = false
    if (committed) {
      options.beginDragReleaseHandoff(finalAnchorSec)
    } else {
      options.clearDragReleaseHandoff()
    }
    const dragRelease = options.endDragCanvasPresentation(finalPreviewStartSec, committed)
    options.maybeContinueWaveformSource(finalAnchorSec)
    // 正常联结松手会由共享 presentation commit 统一触发最终帧；这里抢先绘制会让被动轨
    // 比主动轨更早 promote 一张过渡帧，随后又被共享提交帧替换，形成可见的单轨闪动。
    if (dragRelease.requiresRender && !committed) {
      options.drawWaveformNow({ preferPreviewStart: true })
    }
  }

  if (options.linkedDragActive && options.linkedDragAnchorSec) {
    watch(
      () =>
        [
          Boolean(options.linkedDragActive?.()),
          Number(options.linkedDragAnchorSec?.()),
          options.hasSong()
        ] as const,
      ([active, anchorSec, hasSong]) => {
        if (options.dragging.value) return
        if (!active || !hasSong || !Number.isFinite(anchorSec)) {
          finishLinkedDragPresentation(!active && hasSong)
          return
        }
        const wrap = options.wrapRef.value
        const visibleDuration = options.resolveVisibleDurationSec()
        if (!wrap || !visibleDuration) return
        if (!linkedDragPresentationActive) {
          const dragPresentation = options.beginDragCanvasPresentation()
          linkedDragPresentationActive = true
          const visualStartSec = dragPresentation.viewportStartSec
          options.previewStartSec.value =
            visualStartSec !== null && Number.isFinite(visualStartSec)
              ? options.clampPreviewStart(visualStartSec)
              : options.previewStartSec.value
        }
        const nextPreviewStartSec = options.clampPreviewStart(
          anchorSec - visibleDuration * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
        )
        options.previewStartSec.value = nextPreviewStartSec
        options.updateDragCanvasPresentation()
      },
      { flush: 'post' }
    )
  }

  const handleDragPointerMove = (event: PointerEvent) => {
    if (!options.dragging.value) return
    if (activeDragPointerId !== null && event.pointerId !== activeDragPointerId) return
    if (event.pointerType === 'touch') {
      event.preventDefault()
    }
    const wrap = options.wrapRef.value
    if (!wrap) return
    const visibleDuration = options.resolveVisibleDurationSec()
    if (!visibleDuration) return
    const deltaX = event.clientX - dragStartClientX
    const deltaSec = (deltaX / Math.max(1, wrap.clientWidth)) * visibleDuration
    options.previewStartSec.value = options.clampPreviewStart(dragStartSec - deltaSec)
    options.updateDragCanvasPresentation()
    options.scrubPreview.update(options.resolvePreviewAnchorSec())
  }

  const stopDragging = (commitPlayhead = false, refreshWaveform = true) => {
    if (!options.dragging.value) return
    const finalAnchorSec = options.resolvePreviewAnchorSec()
    const finalPreviewStartSec = options.previewStartSec.value
    const committed = commitPlayhead && options.hasSong()
    if (committed && refreshWaveform) {
      options.beginDragReleaseHandoff(finalAnchorSec)
    } else {
      options.clearDragReleaseHandoff()
    }
    const dragRelease = options.endDragCanvasPresentation(
      finalPreviewStartSec,
      committed && options.linkedDragActive?.() === true
    )
    options.dragging.value = false
    activeDragPointerId = null
    options.scrubPreview.stop({ flushPending: committed && refreshWaveform })
    window.removeEventListener('pointermove', handleDragPointerMove)
    window.removeEventListener('pointerup', handleWindowPointerUp)
    window.removeEventListener('pointercancel', handleWindowPointerCancel)
    options.emitDragSessionEnd({
      anchorSec: finalAnchorSec,
      committed
    })
    if (refreshWaveform) {
      options.maybeContinueWaveformSource(finalAnchorSec)
      if (dragRelease.requiresRender && !committed) {
        options.drawWaveformNow({ preferPreviewStart: true })
      }
    }
  }

  const beginWaveformDrag = (event: PointerEvent) => {
    options.clearDragReleaseHandoff()
    finishLinkedDragPresentation()
    options.dragging.value = true
    activeDragPointerId = event.pointerId
    dragStartClientX = event.clientX
    options.emitDragSessionStart()
    const dragPresentation = options.beginDragCanvasPresentation()
    const visualStartSec = dragPresentation.viewportStartSec
    dragStartSec =
      visualStartSec !== null && Number.isFinite(visualStartSec)
        ? options.clampPreviewStart(visualStartSec)
        : options.previewStartSec.value
    options.previewStartSec.value = dragStartSec
    options.scrubPreview.start(options.resolvePreviewAnchorSec())
    window.addEventListener('pointermove', handleDragPointerMove, { passive: false })
    window.addEventListener('pointerup', handleWindowPointerUp, { passive: true })
    window.addEventListener('pointercancel', handleWindowPointerCancel, { passive: true })
  }

  const handleWindowPointerUp = (event: PointerEvent) => {
    if (activeDragPointerId !== null && event.pointerId !== activeDragPointerId) return
    handleDragPointerMove(event)
    stopDragging(true)
  }

  const handleWindowPointerCancel = (event: PointerEvent) => {
    if (activeDragPointerId !== null && event.pointerId !== activeDragPointerId) return
    stopDragging(false)
  }

  const handlePointerDown = (event: PointerEvent) => {
    const durationSec = options.resolvePreviewDurationSec()
    if (event.button !== 0 || options.dragging.value) return
    if (!options.hasSong() || !durationSec) return
    if (options.handlePreviewMouseDownForGridTargetSelect(event)) {
      options.emitToolbarState()
      options.schedulePersistGridDefinition()
      return
    }
    beginWaveformDrag(event)
    event.preventDefault()
  }

  const handleWheel = (event: WheelEvent) => {
    const wrap = options.wrapRef.value
    const duration = options.resolvePreviewDurationSec()
    if (!wrap || !duration) return

    event.preventDefault()
    const rect = wrap.getBoundingClientRect()
    const ratio =
      rect.width > 0 ? options.clampNumber((event.clientX - rect.left) / rect.width, 0, 1) : 0.5
    const playbackActive = options.resolvePlaybackActive()
    const beforeVisible = options.resolveVisibleDurationSec()
    const anchorRatio = playbackActive ? HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO : ratio
    const anchorSec = playbackActive
      ? options.resolveWaveformCurrentSeconds()
      : options.previewStartSec.value + beforeVisible * ratio
    const factor = event.deltaY < 0 ? options.zoomStepFactor : 1 / options.zoomStepFactor
    const nextZoom = options.clampNumber(
      options.previewZoom.value * factor,
      options.minZoom,
      options.previewMaxZoom.value
    )
    if (Math.abs(nextZoom - options.previewZoom.value) <= 0.000001) return

    options.previewZoom.value = nextZoom
    const nextVisible = options.resolveVisibleDurationSec()
    options.previewStartSec.value = options.clampPreviewStart(anchorSec - nextVisible * anchorRatio)
    options.emitZoomChange({
      value: options.previewZoom.value,
      anchorRatio,
      sourceDirection: options.direction(),
      anchorSec,
      viewportStartSec: options.previewStartSec.value,
      visibleDurationSec: nextVisible
    })
    options.maybeContinueWaveformSource(options.resolvePreviewAnchorSec())
    if (!playbackActive) {
      options.scheduleDraw({ preferPreviewStart: true, viewportOnly: true })
    }
  }

  return {
    stopDragging,
    handlePointerDown,
    handleWheel
  }
}
