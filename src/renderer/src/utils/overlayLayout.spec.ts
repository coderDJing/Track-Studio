import { describe, expect, it } from 'vitest'
import { constrainDialog, positionPopover } from './overlayLayout'

describe('small-window overlay boundaries', () => {
  it('recovers the entire settings dialog after shrinking from a dragged position', () => {
    expect(constrainDialog(250, 730, 756, 455, 1260, 650)).toEqual({ left: 250, top: 187 })
  })
  it('keeps a dialog below the title bar and inside both horizontal edges', () => {
    expect(constrainDialog(-200, -100, 756, 455, 1260, 650)).toEqual({ left: 8, top: 43 })
    expect(constrainDialog(1200, 100, 756, 455, 1260, 650)).toEqual({ left: 496, top: 100 })
  })
  it('opens a bottom-edge panel upwards and keeps its right edge visible', () => {
    expect(
      positionPopover({
        anchor: { left: 1200, top: 550, bottom: 578, width: 50 },
        width: 242,
        contentHeight: 214,
        maxHeight: 220,
        viewportWidth: 1260,
        viewportHeight: 650
      })
    ).toEqual({ left: 1010, top: 332, width: 242, maxHeight: 220 })
  })
  it('keeps a short list below the anchor when it fits', () => {
    expect(
      positionPopover({
        anchor: { left: 100, top: 480, bottom: 508, width: 200 },
        width: 200,
        contentHeight: 80,
        maxHeight: 220,
        viewportWidth: 1260,
        viewportHeight: 650
      })
    ).toEqual({ left: 100, top: 512, width: 200, maxHeight: 130 })
  })
  it('limits a long list to the available side of a short viewport', () => {
    const result = positionPopover({
      anchor: { left: 100, top: 130, bottom: 158, width: 200 },
      width: 200,
      contentHeight: 1000,
      maxHeight: 500,
      viewportWidth: 1260,
      viewportHeight: 300
    })
    expect(result.top + result.maxHeight).toBe(292)
  })
})
