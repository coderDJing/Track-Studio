import type { SeratoWaveformOverviewData } from '@shared/seratoWaveformOverview'
import type { NativeWaveformBitmap } from '@shared/compactVisualWaveform'
import { drawNativeOverviewEnvelope } from './nativeWaveformBitmapRenderer'

const bitmaps = new WeakMap<SeratoWaveformOverviewData, NativeWaveformBitmap>()

// Overview stores indexed RGB pixels, not amplitudes: R * 36 + G * 6 + B.
// Each channel has six levels spaced by 51; native decoding writes uint8 channels
// (including wraparound for extended indices). Index 1 is the transparent padding.
// Verified against the installed Serato DJ Lite decoder; keep the native 16-row geometry.
export const buildSeratoOverviewBitmap = (data: SeratoWaveformOverviewData) => {
  const cached = bitmaps.get(data)
  if (cached) return cached
  if (!data.columnCount || data.rowCount !== 16 || data.pixels.length !== data.columnCount * 16)
    return null
  const rgba = new Uint8Array(data.pixels.length * 4)
  for (let column = 0; column < data.columnCount; column += 1) {
    for (let row = 0; row < 16; row += 1) {
      const value = data.pixels[column * 16 + row]
      if (value <= 1) continue
      const red = Math.floor(value / 36)
      const remainder = value - red * 36
      const green = Math.floor(remainder / 6)
      const blue = remainder - green * 6
      const target = (row * data.columnCount + column) * 4
      rgba[target] = (red * 51) & 255
      rgba[target + 1] = green * 51
      rgba[target + 2] = blue * 51
      rgba[target + 3] = 255
    }
  }
  const bitmap = { width: data.columnCount, height: 16, rgba }
  bitmaps.set(data, bitmap)
  return bitmap
}

export const drawSeratoOverview = (
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  data: SeratoWaveformOverviewData,
  options: { isHalf?: boolean; themeVariant?: 'light' | 'dark' } = {}
) => {
  const bitmap = buildSeratoOverviewBitmap(data)
  if (!bitmap) return false
  return drawNativeOverviewEnvelope(ctx, bitmap, {
    width,
    height,
    durationSec: 1,
    rangeStartSec: 0,
    rangeDurationSec: 1,
    waveformLayout: options.isHalf ? 'top-half' : 'full',
    themeVariant: options.themeVariant
  })
}
