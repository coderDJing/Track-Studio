import { describe, expect, it } from 'vitest'
import {
  isPointWithinCoverPopupHoverRegion,
  isPointWithinCoverPopupRectangle
} from './miniPlayerCoverPopupHover'

describe('mini player cover popup hover region', () => {
  const anchor = { x: 10, y: 20, width: 50, height: 50 }
  const popup = { x: 10, y: 74, width: 360, height: 440 }

  it('keeps the popup while the pointer is over either window region', () => {
    expect(isPointWithinCoverPopupHoverRegion({ x: 20, y: 30 }, anchor, popup)).toBe(true)
    expect(isPointWithinCoverPopupHoverRegion({ x: 300, y: 300 }, anchor, popup)).toBe(true)
  })

  it('treats a small cross-window gap as part of the hover path', () => {
    expect(isPointWithinCoverPopupHoverRegion({ x: 20, y: 72 }, anchor, popup, 2)).toBe(true)
  })

  it('allows the watchdog to close after the pointer leaves both regions', () => {
    expect(isPointWithinCoverPopupHoverRegion({ x: 500, y: 300 }, anchor, popup, 2)).toBe(false)
  })

  it('normalizes rectangles defensively', () => {
    expect(
      isPointWithinCoverPopupRectangle({ x: 30, y: 30 }, { x: 60, y: 60, width: -50, height: -50 })
    ).toBe(true)
  })
})
