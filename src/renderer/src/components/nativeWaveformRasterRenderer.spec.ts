import { describe, expect, it } from 'vitest'
import { buildNativeOverviewRaster } from './nativeWaveformRasterRenderer'

const bitmap = () => ({
  width: 2,
  height: 4,
  rgba: new Uint8Array([
    0, 0, 0, 0, 0, 0, 0, 0, 20, 80, 200, 100, 20, 80, 200, 100, 180, 40, 120, 200, 180, 40, 120,
    200, 0, 0, 0, 0, 0, 0, 0, 0
  ])
})
const options = { width: 1, height: 12, durationSec: 1, rangeStartSec: 0, rangeDurationSec: 1 }

describe('native raster overview', () => {
  it('preserves vertical hues instead of turning blue and pink layers into a pale column', () => {
    const source = bitmap()
    const original = source.rgba.slice()
    const result = buildNativeOverviewRaster(source, options)!
    expect(Array.from(result.pixels.slice(5 * 4, 5 * 4 + 3))).toEqual([23, 90, 226])
    expect(Array.from(result.pixels.slice(6 * 4, 6 * 4 + 4))).toEqual([226, 50, 151, 255])
    expect(result.pixels[4 * 4 + 3]).toBe(0)
    expect(result.pixels[5 * 4 + 3]).toBeGreaterThan(100)
    expect(source.rgba).toEqual(original)
  })

  it('crops the requested half and keeps light colors darker on the shared gray background', () => {
    const top = buildNativeOverviewRaster(bitmap(), { ...options, waveformLayout: 'top-half' })!
    const bottom = buildNativeOverviewRaster(bitmap(), {
      ...options,
      waveformLayout: 'bottom-half',
      themeVariant: 'light'
    })!
    expect(Array.from(top.pixels.slice(6 * 4, 6 * 4 + 3))).toEqual([23, 90, 226])
    expect(Array.from(bottom.pixels.slice(4 * 4, 4 * 4 + 3))).toEqual([164, 36, 109])
    expect(bottom.pixels[6 * 4 + 3]).toBe(0)
    expect(
      buildNativeOverviewRaster(bitmap(), { ...options, rangeStartSec: 1 })!.pixels.every(
        (value) => value === 0
      )
    ).toBe(true)
    expect(buildNativeOverviewRaster(bitmap(), { ...options, durationSec: 0 })).toBeNull()
  })
})
