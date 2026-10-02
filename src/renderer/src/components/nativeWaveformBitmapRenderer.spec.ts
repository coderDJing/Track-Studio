import { describe, expect, it, vi } from 'vitest'
import {
  drawNativeOverviewEnvelope,
  resolveNativeOverviewColumns
} from './nativeWaveformBitmapRenderer'

const makeBitmap = () => {
  const rgba = new Uint8Array(4 * 8 * 4)
  const set = (x: number, y: number, alpha = 255) => {
    const index = (y * 4 + x) * 4
    rgba.set([40, 100, 200, alpha], index)
  }
  set(0, 3)
  set(0, 4)
  for (let row = 0; row < 8; row += 1) set(1, row)
  set(2, 3)
  set(2, 4)
  set(2, 0, 1)
  return { width: 4, height: 8, rgba }
}

describe('native overview silhouette rendering', () => {
  it('pools narrow peaks when shrinking, keeps silent columns empty and preserves native data', () => {
    const bitmap = makeBitmap()
    const original = bitmap.rgba.slice()
    const columns = resolveNativeOverviewColumns(bitmap)
    expect(columns[1].top).toBe(1)
    expect(columns[2].top).toBe(0.25)
    expect(columns[3].top).toBe(0)
    expect(resolveNativeOverviewColumns(bitmap)).toBe(columns)
    const fillRect = vi.fn()
    const ctx = { save: vi.fn(), restore: vi.fn(), fillRect, fillStyle: '' }
    const options = {
      width: 2,
      height: 32,
      durationSec: 1,
      rangeStartSec: 0,
      rangeDurationSec: 1,
      waveformLayout: 'top-half' as const,
      themeVariant: 'dark' as const
    }
    expect(
      drawNativeOverviewEnvelope(ctx as unknown as CanvasRenderingContext2D, bitmap, options)
    ).toBe(true)
    expect(fillRect.mock.calls[0][3]).toBe(24)
    expect(fillRect.mock.calls[1][3]).toBe(6)
    expect(bitmap.rgba).toEqual(original)
    fillRect.mockClear()
    expect(
      drawNativeOverviewEnvelope(ctx as unknown as CanvasRenderingContext2D, bitmap, {
        ...options,
        rangeStartSec: 1
      })
    ).toBe(false)
    expect(fillRect).not.toHaveBeenCalled()
  })

  it('uses darker native hues against the light gray background', () => {
    const ctx = { save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), fillStyle: '' }
    const options = { width: 1, height: 24, durationSec: 1, rangeStartSec: 0, rangeDurationSec: 1 }
    drawNativeOverviewEnvelope(ctx as unknown as CanvasRenderingContext2D, makeBitmap(), {
      ...options,
      themeVariant: 'dark'
    })
    expect(ctx.fillStyle).toBe('rgb(45, 113, 226)')
    drawNativeOverviewEnvelope(ctx as unknown as CanvasRenderingContext2D, makeBitmap(), {
      ...options,
      themeVariant: 'light'
    })
    expect(ctx.fillStyle).toBe('rgb(33, 82, 164)')
  })
})
