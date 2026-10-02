import type { NativeWaveformBitmap } from '@shared/compactVisualWaveform'

type RasterOptions = {
  width: number
  height: number
  durationSec: number
  rangeStartSec: number
  rangeDurationSec: number
  waveformLayout?: 'full' | 'top-half' | 'bottom-half'
  themeVariant?: 'light' | 'dark'
}

const columnPeaks = new WeakMap<NativeWaveformBitmap, Uint8Array>()
const surfaces = new WeakMap<NativeWaveformBitmap, Map<string, OffscreenCanvas>>()

const resolveColumnPeaks = (bitmap: NativeWaveformBitmap) => {
  const cached = columnPeaks.get(bitmap)
  if (cached) return cached
  const peaks = new Uint8Array(bitmap.width)
  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      peaks[x] = Math.max(peaks[x], bitmap.rgba[(y * bitmap.width + x) * 4 + 3])
    }
  }
  columnPeaks.set(bitmap, peaks)
  return peaks
}

// Keep the native vertical color layers. Flattening all rows into a single RGB
// average makes Traktor's blue/pink/yellow layers turn into pale purple columns.
export const buildNativeOverviewRaster = (bitmap: NativeWaveformBitmap, options: RasterOptions) => {
  const width = Math.floor(options.width)
  const height = Math.floor(options.height)
  if (
    width <= 0 ||
    height <= 0 ||
    bitmap.width <= 0 ||
    bitmap.height <= 0 ||
    bitmap.rgba.length !== bitmap.width * bitmap.height * 4 ||
    options.durationSec <= 0 ||
    options.rangeDurationSec <= 0
  )
    return null
  const pixels = new Uint8ClampedArray(width * height * 4)
  const peaks = resolveColumnPeaks(bitmap)
  const layout = options.waveformLayout || 'full'
  const sourceTop = layout === 'bottom-half' ? bitmap.height / 2 : 0
  const sourceHeight = layout === 'full' ? bitmap.height : bitmap.height / 2
  const padding = Math.min(4, Math.floor((height - 1) / 2))
  const drawableHeight = height - padding * 2
  const displayValue = options.themeVariant === 'light' ? 164 : 226
  for (let x = 0; x < width; x += 1) {
    const start = options.rangeStartSec + (x / width) * options.rangeDurationSec
    const end = options.rangeStartSec + ((x + 1) / width) * options.rangeDurationSec
    if (end <= 0 || start >= options.durationSec) continue
    const first = Math.max(0, Math.floor((start / options.durationSec) * bitmap.width))
    const last = Math.min(
      bitmap.width,
      Math.max(first + 1, Math.ceil((end / options.durationSec) * bitmap.width))
    )
    let columnPeak = 0
    for (let sx = first; sx < last; sx += 1) columnPeak = Math.max(columnPeak, peaks[sx])
    if (!columnPeak) continue
    const threshold = Math.max(8, columnPeak * 0.12)
    for (let y = 0; y < drawableHeight; y += 1) {
      const top = Math.floor(sourceTop + (y / drawableHeight) * sourceHeight)
      const bottom = Math.min(
        bitmap.height,
        Math.max(top + 1, Math.ceil(sourceTop + ((y + 1) / drawableHeight) * sourceHeight))
      )
      let alpha = 0,
        weight = 0,
        r = 0,
        g = 0,
        b = 0
      for (let sy = top; sy < bottom; sy += 1) {
        for (let sx = first; sx < last; sx += 1) {
          const index = (sy * bitmap.width + sx) * 4
          const a = bitmap.rgba[index + 3]
          if (a < threshold) continue
          alpha = Math.max(alpha, a)
          const value = a * a
          weight += value
          r += bitmap.rgba[index] * value
          g += bitmap.rgba[index + 1] * value
          b += bitmap.rgba[index + 2] * value
        }
      }
      if (!weight) continue
      const colorPeak = Math.max(r, g, b)
      if (!colorPeak) continue
      const target = ((y + padding) * width + x) * 4
      pixels[target] = (r / colorPeak) * displayValue
      pixels[target + 1] = (g / colorPeak) * displayValue
      pixels[target + 2] = (b / colorPeak) * displayValue
      // Make the cached translucent raster readable at list size without changing
      // its RGB ratios or painting its faint edges as a solid full-height column.
      pixels[target + 3] = (alpha / columnPeak) ** 0.6 * 255
    }
  }
  return { width, height, pixels }
}

export const drawNativeOverviewRaster = (
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bitmap: NativeWaveformBitmap,
  options: RasterOptions
) => {
  const key = JSON.stringify(options)
  let cache = surfaces.get(bitmap)
  let canvas = cache?.get(key)
  if (!canvas) {
    const raster = buildNativeOverviewRaster(bitmap, options)
    if (!raster) return false
    canvas = new OffscreenCanvas(raster.width, raster.height)
    const context = canvas.getContext('2d')
    if (!context) return false
    context.putImageData(new ImageData(raster.pixels, raster.width, raster.height), 0, 0)
    if (!cache) {
      cache = new Map()
      surfaces.set(bitmap, cache)
    }
    if (cache.size >= 8) cache.delete(cache.keys().next().value!)
    cache.set(key, canvas)
  }
  ctx.drawImage(canvas, 0, 0, options.width, options.height)
  return true
}
