import { describe, expect, it } from 'vitest'
import { getBottomDropPad } from './dropPadGeometry'

describe('bottom reorder drop area', () => {
  it('does not cover rows when the scrolled list continues below the viewport', () => {
    expect(getBottomDropPad({ top: 100, bottom: 700 }, { top: -800, bottom: 1000 })).toEqual({
      top: 700,
      height: 0
    })
  })

  it('covers only the empty space below the last row', () => {
    expect(getBottomDropPad({ top: 100, bottom: 700 }, { top: -800, bottom: 550 })).toEqual({
      top: 550,
      height: 150
    })
  })
})
