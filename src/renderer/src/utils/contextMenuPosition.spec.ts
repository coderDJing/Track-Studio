import { describe, expect, it } from 'vitest'
import { resolveContextMenuPoint } from './contextMenuPosition'

describe('resolveContextMenuPoint', () => {
  it('keeps a default gap from every viewport edge', () => {
    expect(
      resolveContextMenuPoint(
        { clickX: 0, clickY: 0, menuWidth: 120, menuHeight: 80 },
        { windowWidth: 800, windowHeight: 600, topInset: 0 }
      )
    ).toMatchObject({ x: 8, y: 8 })

    expect(
      resolveContextMenuPoint(
        { clickX: 799, clickY: 599, menuWidth: 120, menuHeight: 80 },
        { windowWidth: 800, windowHeight: 600, topInset: 0 }
      )
    ).toMatchObject({ x: 672, y: 512 })
  })

  it('allows callers to provide a different edge gap', () => {
    expect(
      resolveContextMenuPoint(
        { clickX: 0, clickY: 0, menuWidth: 120, menuHeight: 80 },
        { padding: 14, windowWidth: 800, windowHeight: 600, topInset: 0 }
      )
    ).toMatchObject({ x: 14, y: 14 })
  })
  it('constrains oversized menus below the title bar with gaps at both edges', () => {
    const point = resolveContextMenuPoint(
      { clickX: 300, clickY: 700, menuWidth: 250, menuHeight: 1000 },
      { windowWidth: 1260, windowHeight: 780, topInset: 40 }
    )
    expect(point).toMatchObject({ y: 48, maxHeight: 724 })
    expect(point.y + point.maxHeight).toBe(772)
  })

  it('updates available height when the viewport shrinks', () => {
    const input = { clickX: 300, clickY: 500, menuWidth: 250, menuHeight: 600 }
    const options = { windowWidth: 1260, topInset: 40 }
    expect(resolveContextMenuPoint(input, { ...options, windowHeight: 1000 })).toMatchObject({
      y: 392,
      maxHeight: 944
    })
    expect(resolveContextMenuPoint(input, { ...options, windowHeight: 600 })).toMatchObject({
      y: 48,
      maxHeight: 544
    })
  })
})
