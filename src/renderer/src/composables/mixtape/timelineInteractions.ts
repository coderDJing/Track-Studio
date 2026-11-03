import { nextTick } from 'vue'
import {
  BASE_PX_PER_SEC,
  MIXTAPE_WIDTH_SCALE,
  TIMELINE_SIDE_PADDING_PX,
  ZOOM_STEP,
  WHEEL_LINE_HEIGHT_PX,
  WHEEL_MAX_STEPS_PER_FRAME,
  WHEEL_ZOOM_BASE_STEP,
  WHEEL_ZOOM_MAX_STEP,
  WHEEL_ZOOM_RATIO_STEP
} from '@renderer/composables/mixtape/constants'
import type { TimelineLayoutSnapshot } from '@renderer/composables/mixtape/types'

type ValueRef<T> = {
  value: T
}

type TimelineScrollHost = {
  osInstance: () => { elements(): { viewport?: HTMLElement } } | null
}

type TimelineInteractionsContext = {
  zoom: ValueRef<number>
  renderZoom: ValueRef<number>
  zoomTouched: ValueRef<boolean>
  normalizedZoom: ValueRef<number>
  resolveRenderZoomLevel: (value: number) => number
  timelineScrollRef: ValueRef<TimelineScrollHost | null>
  timelineViewportWidth: ValueRef<number>
  timelineScrollWidth: ValueRef<number>
  timelineContentWidth: ValueRef<number>
  timelineScrollLeft: ValueRef<number>
  timelineScrollTop: ValueRef<number>
  timelineViewportHeight: ValueRef<number>
  timelineLayout: ValueRef<TimelineLayoutSnapshot>
  timelineWidth: ValueRef<number>
  isTimelinePanning: ValueRef<boolean>
  isTimelineZooming: ValueRef<boolean>
  envelopePreviewRef: ValueRef<HTMLElement | null>
  isOverviewDragging: ValueRef<boolean>
  overviewRef: ValueRef<HTMLElement | null>
  overviewWidth: ValueRef<number>
  overviewViewportLeft: ValueRef<number>
  overviewViewportWidth: ValueRef<number>
  alignZoomToRenderLevel: (value: number) => number
  clampZoomValue: (value: number) => number
  computeTimelineDuration: () => number
  renderPxPerSec: ValueRef<number>
  scheduleTimelineDraw: () => void
  scheduleWaveformLoad: () => void
  scheduleFullPreRender: () => void
}

export const createTimelineInteractionsModule = (ctx: TimelineInteractionsContext) => {
  const {
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
  } = ctx

  let timelineScrollRaf = 0
  let wheelZoomRaf = 0
  let wheelZoomDelta = 0
  let wheelZoomAnchorClientX = 0
  let timelineZoomingTimer: ReturnType<typeof setTimeout> | null = null
  let timelineWheelTarget: HTMLElement | null = null
  let timelinePanStartX = 0
  let timelinePanStartY = 0
  let timelinePanStartLeft = 0
  let timelinePanStartTop = 0
  let timelinePanMoved = false
  let timelinePanLockHorizontal = false
  let overviewDragOffset = 0
  let overviewDragStartX = 0
  let overviewDragMoved = false
  let overviewSuppressClick = false
  const FLOAT_EPSILON = 0.01
  const nearlyEqual = (a: number, b: number) => Math.abs(a - b) < FLOAT_EPSILON
  const resolveScrollableWidth = (viewport: HTMLElement) => {
    const viewportWidth = viewport.clientWidth || 0
    const domScrollWidth = Number(viewport.scrollWidth || 0)
    const stateScrollWidth = Number(timelineScrollWidth.value || 0)
    const layoutWidth = Number(timelineLayout.value.totalWidth || 0)
    return Math.max(viewportWidth, domScrollWidth, stateScrollWidth, layoutWidth)
  }
  const applyRenderZoomImmediate = () => {
    const target = resolveRenderZoomLevel(normalizedZoom.value)
    if (target === renderZoom.value) return
    renderZoom.value = target
    scheduleTimelineDraw()
    scheduleWaveformLoad()
    scheduleFullPreRender()
  }

  const markTimelineZooming = () => {
    isTimelineZooming.value = true
    if (timelineZoomingTimer) clearTimeout(timelineZoomingTimer)
    timelineZoomingTimer = setTimeout(() => {
      timelineZoomingTimer = null
      isTimelineZooming.value = false
    }, 180)
  }

  const setZoomValue = (value: number) => {
    const nextZoom = alignZoomToRenderLevel(value)
    if (Math.abs(nextZoom - zoom.value) < 0.0001) return
    zoom.value = nextZoom
    zoomTouched.value = true
  }

  const autoFitZoom = (viewportWidth: number, timelineDuration: number) => {
    if (zoomTouched.value) return false
    if (!viewportWidth || !timelineDuration || !Number.isFinite(timelineDuration)) return false
    const target =
      (viewportWidth * 0.95) / (timelineDuration * BASE_PX_PER_SEC * MIXTAPE_WIDTH_SCALE)
    const nextZoom = alignZoomToRenderLevel(target)
    if (!Number.isFinite(nextZoom)) return false
    if (Math.abs(nextZoom - zoom.value) < ZOOM_STEP * 0.5) return false
    zoom.value = nextZoom
    renderZoom.value = nextZoom
    scheduleTimelineDraw()
    scheduleFullPreRender()
    return true
  }

  const updateTimelineWidth = (allowAutoFit: boolean = true) => {
    const viewport = timelineScrollRef.value?.osInstance()?.elements()
      .viewport as HTMLElement | null
    const viewportWidth = viewport?.clientWidth || 0
    timelineViewportWidth.value = viewportWidth
    const timelineDuration = computeTimelineDuration()
    if (allowAutoFit && autoFitZoom(viewportWidth, timelineDuration)) {
      return
    }
    const totalWidth = Math.max(0, timelineLayout.value.totalWidth)
    const contentWidth = Math.max(viewportWidth, Math.ceil(totalWidth))
    timelineContentWidth.value = contentWidth
    timelineWidth.value = contentWidth
  }

  const syncTimelineScrollState = () => {
    const viewport = timelineScrollRef.value?.osInstance()?.elements()
      .viewport as HTMLElement | null
    if (!viewport) return
    const nextLeft = Number(viewport.scrollLeft || 0)
    const nextTop = Number(viewport.scrollTop || 0)
    const nextWidth = Number(viewport.clientWidth || 0)
    const nextHeight = Number(viewport.clientHeight || 0)
    const nextScrollWidth = Number(viewport.scrollWidth || nextWidth || 0)
    const widthChanged = !nearlyEqual(nextWidth, Number(timelineViewportWidth.value || 0))
    const heightChanged = !nearlyEqual(nextHeight, Number(timelineViewportHeight.value || 0))
    const scrollWidthChanged = !nearlyEqual(nextScrollWidth, Number(timelineScrollWidth.value || 0))
    const movedScroll =
      !nearlyEqual(nextLeft, Number(timelineScrollLeft.value || 0)) ||
      !nearlyEqual(nextTop, Number(timelineScrollTop.value || 0))
    let changed = false
    if (!nearlyEqual(nextLeft, Number(timelineScrollLeft.value || 0))) {
      timelineScrollLeft.value = nextLeft
      changed = true
    }
    if (!nearlyEqual(nextTop, Number(timelineScrollTop.value || 0))) {
      timelineScrollTop.value = nextTop
      changed = true
    }
    if (widthChanged) {
      timelineViewportWidth.value = nextWidth
      changed = true
    }
    if (heightChanged) {
      timelineViewportHeight.value = nextHeight
      changed = true
    }
    if (scrollWidthChanged) {
      timelineScrollWidth.value = nextScrollWidth
      changed = true
    }
    if (changed) {
      if (movedScroll || widthChanged || scrollWidthChanged) {
        scheduleWaveformLoad()
      }
      scheduleTimelineDraw()
    }
  }

  const startTimelineScrollSampler = () => {
    if (typeof requestAnimationFrame === 'undefined') return
    if (timelineScrollRaf !== 0) return
    const tick = () => {
      syncTimelineScrollState()
      timelineScrollRaf = requestAnimationFrame(tick)
    }
    timelineScrollRaf = requestAnimationFrame(tick)
  }

  const resolveTimelineViewportEl = () =>
    ((timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
      timelineWheelTarget ||
      null) as HTMLElement | null

  const normalizeWheelDeltaY = (event: WheelEvent) => {
    const delta = event.deltaY
    if (!Number.isFinite(delta) || delta === 0) return 0
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      return delta * WHEEL_LINE_HEIGHT_PX
    }
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      const viewport = resolveTimelineViewportEl()
      return delta * Math.max(1, viewport?.clientHeight || 800)
    }
    return delta
  }

  const resolveZoomTargetScrollLeft = (
    viewport: HTMLElement,
    prevLeft: number,
    anchorX: number,
    prevScale: number,
    nextScale: number
  ) => {
    const targetLeft =
      (prevLeft + anchorX - TIMELINE_SIDE_PADDING_PX) * (nextScale / prevScale) +
      TIMELINE_SIDE_PADDING_PX -
      anchorX
    const layoutWidth = Math.max(0, Number(timelineLayout.value.totalWidth || 0))
    const predictedScrollWidth = Math.max(resolveScrollableWidth(viewport), layoutWidth)
    const maxLeft = Math.max(0, predictedScrollWidth - viewport.clientWidth)
    return Math.max(0, Math.min(maxLeft, targetLeft))
  }

  const flushPendingWheelZoom = () => {
    if (!wheelZoomDelta) return
    const delta = wheelZoomDelta
    wheelZoomDelta = 0
    const viewport = resolveTimelineViewportEl()
    const prevScale = Math.max(0.0001, renderPxPerSec.value)
    const prevLeft = viewport?.scrollLeft || 0
    const rect = viewport?.getBoundingClientRect()
    const anchorX = rect ? Math.max(0, Math.min(rect.width, wheelZoomAnchorClientX - rect.left)) : 0
    const direction = delta < 0 ? 1 : -1
    const rawSteps = Math.abs(delta) / Math.max(1, WHEEL_LINE_HEIGHT_PX)
    const steps = Math.max(1, Math.min(WHEEL_MAX_STEPS_PER_FRAME, rawSteps))
    const zoomRatioPerStep = Math.min(
      1 + WHEEL_ZOOM_MAX_STEP,
      Math.max(1 + WHEEL_ZOOM_RATIO_STEP, 1 + WHEEL_ZOOM_BASE_STEP)
    )
    const zoomScale = Math.pow(zoomRatioPerStep, steps)
    const scaledZoom =
      direction > 0 ? normalizedZoom.value * zoomScale : normalizedZoom.value / zoomScale
    let nextZoom = clampZoomValue(scaledZoom)
    const alignedCurrentZoom = resolveRenderZoomLevel(normalizedZoom.value)
    const alignedNextZoom = resolveRenderZoomLevel(nextZoom)
    if (Math.abs(alignedNextZoom - alignedCurrentZoom) < 0.0001) {
      nextZoom = clampZoomValue(alignedCurrentZoom + direction * WHEEL_ZOOM_BASE_STEP)
    }
    if (Math.abs(nextZoom - normalizedZoom.value) < 0.0001) return

    markTimelineZooming()
    setZoomValue(nextZoom)
    applyRenderZoomImmediate()

    if (!viewport) return
    const nextScale = Math.max(0.0001, renderPxPerSec.value)
    const targetLeft = resolveZoomTargetScrollLeft(
      viewport,
      prevLeft,
      anchorX,
      prevScale,
      nextScale
    )
    viewport.scrollLeft = targetLeft
    // 先同步响应式 scroll 状态，避免播放线在缩放和滚动补偿之间出现一帧错位。
    timelineScrollLeft.value = targetLeft
    nextTick(() => {
      const latestScale = Math.max(0.0001, renderPxPerSec.value)
      const correctedLeft = resolveZoomTargetScrollLeft(
        viewport,
        prevLeft,
        anchorX,
        prevScale,
        latestScale
      )
      viewport.scrollLeft = correctedLeft
      timelineScrollLeft.value = correctedLeft
    })
  }

  const scheduleWheelZoomFlush = () => {
    if (typeof requestAnimationFrame === 'undefined') {
      flushPendingWheelZoom()
      return
    }
    if (wheelZoomRaf) return
    wheelZoomRaf = requestAnimationFrame(() => {
      wheelZoomRaf = 0
      flushPendingWheelZoom()
    })
  }

  const isWheelInsideTimeline = (event: WheelEvent) => {
    const viewport = resolveTimelineViewportEl()
    const envelopePreviewEl = (envelopePreviewRef?.value as HTMLElement | null) || null
    if (!viewport && !envelopePreviewEl) return false
    const target = event.target as Node | null
    if (target && viewport?.contains(target)) return true
    if (target && envelopePreviewEl?.contains(target)) return true
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    if (viewport && path.includes(viewport)) return true
    return !!(envelopePreviewEl && path.includes(envelopePreviewEl))
  }

  const handleTimelineWheel = (event: WheelEvent) => {
    if (!isWheelInsideTimeline(event)) return
    event.preventDefault()
    event.stopPropagation()

    // Shift + 纵向滚轮用于横向浏览；触控板/横向滚轮也走同一分支。
    // 必须在缩放累计之前处理，否则修饰键会被普通滚轮缩放吞掉。
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      const viewport = resolveTimelineViewportEl()
      if (!viewport) return
      const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (!Number.isFinite(rawDelta) || rawDelta === 0) return
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? WHEEL_LINE_HEIGHT_PX
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? Math.max(1, viewport.clientWidth)
            : 1
      const maxLeft = Math.max(0, resolveScrollableWidth(viewport) - viewport.clientWidth)
      const nextLeft = Math.max(0, Math.min(maxLeft, viewport.scrollLeft + rawDelta * unit))
      if (nearlyEqual(nextLeft, viewport.scrollLeft)) return
      viewport.scrollLeft = nextLeft
      syncTimelineScrollState()
      return
    }

    const delta = normalizeWheelDeltaY(event)
    if (!delta) return

    wheelZoomAnchorClientX = event.clientX
    wheelZoomDelta += delta
    scheduleWheelZoomFlush()
  }

  const startTimelinePan = (event: MouseEvent, horizontalOnly: boolean) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target && target.closest('.os-scrollbar')) return
    if (target && target.closest('input, textarea, select, button')) return
    const viewport =
      (timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
      null
    if (!viewport) return
    isTimelinePanning.value = true
    timelinePanMoved = false
    timelinePanStartX = event.clientX
    timelinePanStartY = event.clientY
    timelinePanStartLeft = viewport.scrollLeft || 0
    timelinePanStartTop = viewport.scrollTop || 0
    timelinePanLockHorizontal = horizontalOnly
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = 'none'
    }
    window.addEventListener('mousemove', handleTimelinePanMove, { passive: false })
    window.addEventListener('mouseup', handleTimelinePanEnd, { passive: true })
  }

  const handleTimelinePanStart = (event: MouseEvent) => {
    startTimelinePan(event, false)
  }

  const handleTimelineHorizontalPanStart = (event: MouseEvent) => {
    startTimelinePan(event, true)
  }

  const handleTimelinePanMove = (event: MouseEvent) => {
    if (!isTimelinePanning.value) return
    const viewport =
      (timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
      null
    if (!viewport) return
    const dx = event.clientX - timelinePanStartX
    const dy = timelinePanLockHorizontal ? 0 : event.clientY - timelinePanStartY
    if (!timelinePanMoved && Math.abs(dx) + Math.abs(dy) > 2) {
      timelinePanMoved = true
    }
    const maxLeft = Math.max(0, resolveScrollableWidth(viewport) - viewport.clientWidth)
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    viewport.scrollLeft = Math.max(0, Math.min(maxLeft, Math.round(timelinePanStartLeft - dx)))
    viewport.scrollTop = Math.max(0, Math.min(maxTop, Math.round(timelinePanStartTop - dy)))
    event.preventDefault()
  }

  const handleTimelinePanEnd = () => {
    if (!isTimelinePanning.value) return
    isTimelinePanning.value = false
    timelinePanLockHorizontal = false
    window.removeEventListener('mousemove', handleTimelinePanMove as EventListener)
    window.removeEventListener('mouseup', handleTimelinePanEnd as EventListener)
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = ''
    }
  }

  const clampNumber = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value))

  const updateOverviewWidth = () => {
    const width = Math.round(overviewRef.value?.clientWidth || 0)
    if (width !== overviewWidth.value) {
      overviewWidth.value = width
    }
  }

  const resolveOverviewPointer = (event: MouseEvent) => {
    const rect = overviewRef.value?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return null
    const x = clampNumber(event.clientX - rect.left, 0, rect.width)
    return { rect, x }
  }

  const scrollTimelineToRatio = (ratio: number) => {
    const viewport = resolveTimelineViewportEl()
    if (!viewport) return
    const viewportWidth = viewport.clientWidth || 0
    const scrollableWidth = resolveScrollableWidth(viewport)
    if (!scrollableWidth) return
    const maxLeft = Math.max(0, scrollableWidth - viewportWidth)
    const safeRatio = clampNumber(ratio, 0, 1)
    const nextLeft = clampNumber(safeRatio * maxLeft, 0, maxLeft)
    viewport.scrollLeft = Math.round(nextLeft)
  }

  const scrollTimelineToCenterRatio = (ratio: number) => {
    const viewport = resolveTimelineViewportEl()
    if (!viewport) return
    const viewportWidth = viewport.clientWidth || 0
    const scrollableWidth = resolveScrollableWidth(viewport)
    if (!scrollableWidth) return
    const maxLeft = Math.max(0, scrollableWidth - viewportWidth)
    const safeRatio = clampNumber(ratio, 0, 1)
    const targetLeft = safeRatio * scrollableWidth - viewportWidth / 2
    viewport.scrollLeft = Math.round(clampNumber(targetLeft, 0, maxLeft))
  }

  const handleOverviewMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    const pointer = resolveOverviewPointer(event)
    if (!pointer) return
    const { rect, x } = pointer
    overviewDragStartX = x
    overviewDragMoved = false
    overviewSuppressClick = false
    const viewportLeft = overviewViewportLeft.value
    const viewportWidth = overviewViewportWidth.value
    if (viewportWidth > 0 && x >= viewportLeft && x <= viewportLeft + viewportWidth) {
      overviewDragOffset = x - viewportLeft
    } else {
      overviewDragOffset = viewportWidth ? viewportWidth / 2 : 0
      scrollTimelineToCenterRatio(x / rect.width)
    }
    isOverviewDragging.value = true
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = 'none'
    }
    window.addEventListener('mousemove', handleOverviewMouseMove, { passive: false })
    window.addEventListener('mouseup', handleOverviewMouseUp, { passive: true })
    event.preventDefault()
  }

  const handleOverviewMouseMove = (event: MouseEvent) => {
    if (!isOverviewDragging.value) return
    const pointer = resolveOverviewPointer(event)
    if (!pointer) return
    const { rect, x } = pointer
    if (!overviewDragMoved && Math.abs(x - overviewDragStartX) > 2) {
      overviewDragMoved = true
    }
    const width = rect.width
    const handleWidth = overviewViewportWidth.value
    const maxLeft = Math.max(0, width - handleWidth)
    const nextLeft = clampNumber(x - overviewDragOffset, 0, maxLeft)
    const ratio = maxLeft > 0 ? nextLeft / maxLeft : 0
    scrollTimelineToRatio(ratio)
    event.preventDefault()
  }

  const handleOverviewMouseUp = () => {
    if (!isOverviewDragging.value) return
    isOverviewDragging.value = false
    overviewSuppressClick = overviewDragMoved
    overviewDragMoved = false
    window.removeEventListener('mousemove', handleOverviewMouseMove as EventListener)
    window.removeEventListener('mouseup', handleOverviewMouseUp as EventListener)
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = ''
    }
  }

  const handleOverviewClick = (event: MouseEvent) => {
    if (overviewSuppressClick) {
      overviewSuppressClick = false
      return
    }
    const pointer = resolveOverviewPointer(event)
    if (!pointer) return
    scrollTimelineToCenterRatio(pointer.x / pointer.rect.width)
  }

  const cleanupInteractions = () => {
    if (timelineScrollRaf) {
      cancelAnimationFrame(timelineScrollRaf)
      timelineScrollRaf = 0
    }
    if (wheelZoomRaf) {
      cancelAnimationFrame(wheelZoomRaf)
      wheelZoomRaf = 0
    }
    if (timelineZoomingTimer) {
      clearTimeout(timelineZoomingTimer)
      timelineZoomingTimer = null
    }
    isTimelineZooming.value = false
    wheelZoomDelta = 0
    timelineWheelTarget = null
    try {
      window.removeEventListener('mousemove', handleTimelinePanMove as EventListener)
      window.removeEventListener('mouseup', handleTimelinePanEnd as EventListener)
    } catch {}
    try {
      window.removeEventListener('mousemove', handleOverviewMouseMove as EventListener)
      window.removeEventListener('mouseup', handleOverviewMouseUp as EventListener)
    } catch {}
    try {
      if (typeof window !== 'undefined') {
        window.removeEventListener('wheel', handleTimelineWheel as EventListener)
      }
    } catch {}
    isTimelinePanning.value = false
    isOverviewDragging.value = false
    timelinePanLockHorizontal = false
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = ''
    }
  }

  return {
    applyRenderZoomImmediate,
    setZoomValue,
    autoFitZoom,
    updateTimelineWidth,
    syncTimelineScrollState,
    startTimelineScrollSampler,
    resolveTimelineViewportEl,
    normalizeWheelDeltaY,
    flushPendingWheelZoom,
    scheduleWheelZoomFlush,
    isWheelInsideTimeline,
    handleTimelineWheel,
    handleTimelinePanStart,
    handleTimelineHorizontalPanStart,
    handleTimelinePanMove,
    handleTimelinePanEnd,
    updateOverviewWidth,
    resolveOverviewPointer,
    scrollTimelineToRatio,
    scrollTimelineToCenterRatio,
    handleOverviewMouseDown,
    handleOverviewMouseMove,
    handleOverviewMouseUp,
    handleOverviewClick,
    setTimelineWheelTarget: (target: HTMLElement | null) => {
      timelineWheelTarget = target
    },
    cleanupInteractions
  }
}
