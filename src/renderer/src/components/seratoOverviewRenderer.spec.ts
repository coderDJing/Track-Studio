import { describe, expect, it, vi } from 'vitest'
import { buildSeratoOverviewBitmap, drawSeratoOverview } from './seratoOverviewRenderer'

describe('Serato native overview raster', () => {
  it('decodes packed native RGB while transposing columns and preserving padding', () => {
    const pixels = new Uint8Array(32).fill(1)
    pixels[3] = 108 // bass: (3, 0, 0)
    pixels[16 + 12] = 18 // mid: (0, 3, 0)
    const data = { columnCount: 2, rowCount: 16 as const, pixels, versionMajor: 1, versionMinor: 5 }
    const bitmap = buildSeratoOverviewBitmap(data)!
    expect(bitmap.width).toBe(2)
    expect(Array.from(bitmap.rgba.slice(3 * 2 * 4, 3 * 2 * 4 + 4))).toEqual([153, 0, 0, 255])
    expect(Array.from(bitmap.rgba.slice((12 * 2 + 1) * 4, (12 * 2 + 1) * 4 + 4))).toEqual([
      0, 153, 0, 255
    ])
    expect(Array.from(bitmap.rgba.slice(0, 4))).toEqual([0, 0, 0, 0])
    expect(buildSeratoOverviewBitmap(data)).toBe(bitmap)
    expect(pixels[3]).toBe(108)
    expect(buildSeratoOverviewBitmap({ ...data, pixels: new Uint8Array(1) })).toBeNull()
  })

  it('keeps treble and mixed colors distinct, including the native extended center pixel', () => {
    const pixels = new Uint8Array(16)
    pixels.set([3, 43, 79, 121, 127, 223])
    const bitmap = buildSeratoOverviewBitmap({
      columnCount: 1,
      rowCount: 16,
      pixels,
      versionMajor: 1,
      versionMinor: 5
    })!
    expect(Array.from(bitmap.rgba.slice(0, 24))).toEqual([
      0, 0, 153, 255, 51, 51, 51, 255, 102, 51, 51, 255, 153, 102, 51, 255, 153, 153, 51, 255, 50,
      51, 51, 255
    ])
  })

  it('draws distinct native bass, mid and treble hues in both themes and layouts', () => {
    const pixels = new Uint8Array(48).fill(1)
    for (let row = 4; row < 12; row += 1) {
      pixels[row] = 108
      pixels[16 + row] = 18
      pixels[32 + row] = 3
    }
    const data = { columnCount: 3, rowCount: 16 as const, pixels, versionMajor: 1, versionMinor: 5 }
    for (const themeVariant of ['light', 'dark'] as const) {
      for (const isHalf of [true, false]) {
        const colors: string[] = []
        const ctx = {
          save: vi.fn(),
          restore: vi.fn(),
          fillStyle: '',
          fillRect: () => colors.push(ctx.fillStyle)
        }
        expect(
          drawSeratoOverview(ctx as unknown as CanvasRenderingContext2D, 3, 32, data, {
            themeVariant,
            isHalf
          })
        ).toBe(true)
        const level = themeVariant === 'dark' ? 226 : 164
        expect(colors).toEqual([
          `rgb(${level}, 0, 0)`,
          `rgb(0, ${level}, 0)`,
          `rgb(0, 0, ${level})`
        ])
      }
    }
  })
})
