// Run: pnpm exec vitest run src/renderer/src/composables/mixtape/timelineInteractions.spec.ts
import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTimelineInteractionsModule } from './timelineInteractions'
import { WHEEL_LINE_HEIGHT_PX } from './constants'

const cleanups: Array<() => void> = []

beforeEach(() => {
  vi.stubGlobal('WheelEvent', { DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 })
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.unstubAllGlobals()
})

const createHarness = () => {
  const inside = {} as Node
  const previewInside = {} as Node
  const viewport = {
    scrollLeft: 100,
    scrollTop: 25,
    clientWidth: 300,
    clientHeight: 200,
    scrollWidth: 2000,
    scrollHeight: 500,
    contains: (node: Node) => node === inside,
    getBoundingClientRect: () => ({ left: 0, width: 300 })
  } as unknown as HTMLElement
  const zoom = ref(1)
  const renderZoom = ref(1)
  const scrollLeft = ref(100)
  const scrollTop = ref(25)
  const scheduleTimelineDraw = vi.fn()
  const scheduleWaveformLoad = vi.fn()
  const scheduleFullPreRender = vi.fn()
  const module = createTimelineInteractionsModule({
    zoom,
    renderZoom,
    zoomTouched: ref(false),
    normalizedZoom: computed(() => zoom.value),
    resolveRenderZoomLevel: (value) => value,
    timelineScrollRef: { value: { osInstance: () => ({ elements: () => ({ viewport }) }) } },
    timelineViewportWidth: ref(300),
    timelineScrollWidth: ref(2000),
    timelineContentWidth: ref(2000),
    timelineScrollLeft: scrollLeft,
    timelineScrollTop: scrollTop,
    timelineViewportHeight: ref(200),
    timelineLayout: { value: { totalWidth: 2000, layout: [], startOffsets: [], endOffsets: [] } },
    timelineWidth: ref(2000),
    isTimelinePanning: ref(false),
    isTimelineZooming: ref(false),
    envelopePreviewRef: {
      value: { contains: (node: Node) => node === previewInside } as HTMLElement
    },
    isOverviewDragging: ref(false),
    overviewRef: ref(null),
    overviewWidth: ref(0),
    overviewViewportLeft: ref(0),
    overviewViewportWidth: ref(0),
    alignZoomToRenderLevel: (value) => value,
    clampZoomValue: (value) => Math.max(0.1, Math.min(20, value)),
    computeTimelineDuration: () => 100,
    renderPxPerSec: computed(() => renderZoom.value * 12),
    scheduleTimelineDraw,
    scheduleWaveformLoad,
    scheduleFullPreRender
  })
  cleanups.push(module.cleanupInteractions)
  const wheel = (overrides: Partial<WheelEvent> = {}) =>
    ({
      target: inside,
      clientX: 150,
      deltaX: 0,
      deltaY: 120,
      deltaMode: 0,
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...overrides
    }) as unknown as WheelEvent
  return {
    module,
    wheel,
    viewport,
    zoom,
    renderZoom,
    scrollLeft,
    scrollTop,
    previewInside,
    scheduleTimelineDraw,
    scheduleWaveformLoad,
    scheduleFullPreRender
  }
}

describe('Mixtape timeline wheel shortcuts', () => {
  it('scrolls horizontally with Shift without changing zoom or vertical scroll', () => {
    const h = createHarness(),
      event = h.wheel({ shiftKey: true })
    h.module.handleTimelineWheel(event)
    expect(h.viewport.scrollLeft).toBe(220)
    expect(h.scrollLeft.value).toBe(220)
    expect(h.viewport.scrollTop).toBe(25)
    expect(h.scrollTop.value).toBe(25)
    expect(h.zoom.value).toBe(1)
    expect(h.renderZoom.value).toBe(1)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(h.scheduleTimelineDraw).toHaveBeenCalledOnce()
    expect(h.scheduleWaveformLoad).toHaveBeenCalledOnce()
    expect(h.scheduleFullPreRender).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it.each([true, false])('accepts native horizontal wheel deltas (Shift=%s)', (shiftKey) => {
    const h = createHarness()
    h.module.handleTimelineWheel(h.wheel({ shiftKey, deltaX: 80, deltaY: 0 }))
    expect(h.scrollLeft.value).toBe(180)
    expect(h.zoom.value).toBe(1)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('normalizes line and page scrolling using the horizontal viewport', () => {
    const h = createHarness()
    h.module.handleTimelineWheel(h.wheel({ shiftKey: true, deltaY: 2, deltaMode: 1 }))
    expect(h.scrollLeft.value).toBe(100 + 2 * WHEEL_LINE_HEIGHT_PX)
    h.module.handleTimelineWheel(h.wheel({ shiftKey: true, deltaY: 1, deltaMode: 2 }))
    expect(h.scrollLeft.value).toBe(400 + 2 * WHEEL_LINE_HEIGHT_PX)
  })

  it('uses the main gesture axis when Shift scrolling has small cross-axis noise', () => {
    const h = createHarness()
    h.module.handleTimelineWheel(h.wheel({ shiftKey: true, deltaX: 1, deltaY: 120 }))
    expect(h.scrollLeft.value).toBe(220)
    h.module.handleTimelineWheel(h.wheel({ shiftKey: true, deltaX: -80, deltaY: 1 }))
    expect(h.scrollLeft.value).toBe(140)
  })

  it('clamps horizontal scrolling to both ends without changing track positions', () => {
    const h = createHarness()
    h.module.handleTimelineWheel(h.wheel({ shiftKey: true, deltaY: -10000 }))
    expect(h.scrollLeft.value).toBe(0)
    h.module.handleTimelineWheel(h.wheel({ shiftKey: true, deltaY: 10000 }))
    expect(h.scrollLeft.value).toBe(1700)
  })

  it('also scrolls horizontally over the envelope preview', () => {
    const h = createHarness()
    h.module.handleTimelineWheel(h.wheel({ target: h.previewInside, shiftKey: true, deltaY: -50 }))
    expect(h.scrollLeft.value).toBe(50)
  })

  it('preserves normal vertical wheel zoom', () => {
    const h = createHarness()
    h.module.handleTimelineWheel(h.wheel({ deltaY: -120 }))
    expect(requestAnimationFrame).toHaveBeenCalledOnce()
    h.module.flushPendingWheelZoom()
    expect(h.zoom.value).toBeGreaterThan(1)
    expect(h.renderZoom.value).toBeGreaterThan(1)
  })

  it('leaves wheel events outside the timeline alone', () => {
    const h = createHarness(),
      event = h.wheel({ target: {} as Node, shiftKey: true })
    h.module.handleTimelineWheel(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(h.scrollLeft.value).toBe(100)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })
})
