// Run: pnpm exec vitest run src/renderer/src/composables/mixtape/timelineFollowPlayhead.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { scrollTimelineViewportToPlayhead } from './timelineFollowPlayhead'

describe('timeline follow scrolling', () => {
  it('preserves fractional scroll positions and synchronizes in the same frame', () => {
    const viewport = { scrollLeft: 10, scrollWidth: 1000 } as HTMLElement
    const syncScrollState = vi.fn(() => expect(viewport.scrollLeft).toBeCloseTo(10.25))
    scrollTimelineViewportToPlayhead({
      viewport,
      viewportWidth: 300,
      layoutTotalWidth: 1000,
      playheadX: 110.25,
      syncScrollState
    })
    expect(viewport.scrollLeft).toBeCloseTo(10.25)
    expect(syncScrollState).toHaveBeenCalledOnce()
  })

  it('synchronizes only when the browser actually moves and respects the scroll bounds', () => {
    let left = 10
    const viewport = {
      scrollWidth: 1000,
      get scrollLeft() {
        return left
      },
      set scrollLeft(value: number) {
        left = Math.round(value * 2) / 2
      }
    } as HTMLElement
    const syncScrollState = vi.fn()
    const params = { viewport, viewportWidth: 300, layoutTotalWidth: 1000, syncScrollState }
    scrollTimelineViewportToPlayhead({ ...params, playheadX: 110.2 })
    expect(left).toBe(10)
    expect(syncScrollState).not.toHaveBeenCalled()
    scrollTimelineViewportToPlayhead({ ...params, playheadX: 110.3 })
    expect(left).toBe(10.5)
    expect(syncScrollState).toHaveBeenCalledOnce()
    scrollTimelineViewportToPlayhead({ ...params, playheadX: 5000 })
    expect(left).toBe(700)
    scrollTimelineViewportToPlayhead({ ...params, playheadX: 0 })
    expect(left).toBe(0)
  })
})
