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
})
