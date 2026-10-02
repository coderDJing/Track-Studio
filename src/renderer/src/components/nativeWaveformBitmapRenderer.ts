import type { NativeWaveformBitmap } from '@shared/compactVisualWaveform'

type CanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

type OverviewColumn = { top: number; bottom: number; r: number; g: number; b: number }
const envelopeColumns = new WeakMap<NativeWaveformBitmap, OverviewColumn[]>()

// At list widths several source columns share one display pixel. Pool their native
// silhouette rather than shrinking translucent raster stripes into a comb-like image.
export const resolveNativeOverviewColumns = (bitmap: NativeWaveformBitmap) => {
  const cached = envelopeColumns.get(bitmap)
  if (cached) return cached
  const columns: OverviewColumn[] = []
  const center = bitmap.height / 2
  for (let x = 0; x < bitmap.width; x += 1) {
    let peakAlpha = 0
    for (let y = 0; y < bitmap.height; y += 1) {
      peakAlpha = Math.max(peakAlpha, bitmap.rgba[(y * bitmap.width + x) * 4 + 3])
    }
    const threshold = Math.max(8, peakAlpha * 0.12)
    let top = 0
    let bottom = 0
    let weight = 0
    let r = 0
    let g = 0
    let b = 0
    for (let y = 0; y < bitmap.height; y += 1) {
      const index = (y * bitmap.width + x) * 4
      const alpha = bitmap.rgba[index + 3]
      if (alpha < threshold) continue
      top = Math.max(top, center - y)
      bottom = Math.max(bottom, y + 1 - center)
      const value = alpha * alpha
      weight += value
      r += bitmap.rgba[index] * value
      g += bitmap.rgba[index + 1] * value
      b += bitmap.rgba[index + 2] * value
    }
    columns.push({
      top: top / center,
      bottom: bottom / center,
      r: weight ? r / weight : 0,
      g: weight ? g / weight : 0,
      b: weight ? b / weight : 0
    })
  }
  envelopeColumns.set(bitmap, columns)
  return columns
}

export const drawNativeOverviewEnvelope = (
  ctx: CanvasContext,
  bitmap: NativeWaveformBitmap,
  options: {
    width: number
    height: number
    durationSec: number
    rangeStartSec: number
    rangeDurationSec: number
    waveformLayout?: 'full' | 'top-half' | 'bottom-half'
    themeVariant?: 'light' | 'dark'
  }
) => {
  const { width, height, durationSec, rangeDurationSec } = options
  if (
    width <= 0 ||
    height <= 0 ||
    durationSec <= 0 ||
    rangeDurationSec <= 0 ||
    bitmap.width <= 0 ||
    bitmap.height <= 0 ||
    bitmap.rgba.length !== bitmap.width * bitmap.height * 4
  )
    return false
  const source = resolveNativeOverviewColumns(bitmap)
  const padding = Math.min(4, Math.max(0, (height - 1) / 2))
  const drawableHeight = height - padding * 2
  const layout = options.waveformLayout || 'full'
  const targetColumns = Math.max(1, Math.ceil(width))
  const step = width / targetColumns
  const displayValue = options.themeVariant === 'light' ? 164 : 226
  let drawn = false
  ctx.save()
  for (let x = 0; x < targetColumns; x += 1) {
    const startSec = options.rangeStartSec + (x / targetColumns) * rangeDurationSec
    const endSec = options.rangeStartSec + ((x + 1) / targetColumns) * rangeDurationSec
    if (endSec <= 0 || startSec >= durationSec) continue
    const first = Math.max(0, Math.floor((startSec / durationSec) * bitmap.width))
    const last = Math.min(
      bitmap.width,
      Math.max(first + 1, Math.ceil((endSec / durationSec) * bitmap.width))
    )
    let top = 0,
      bottom = 0,
      r = 0,
      g = 0,
      b = 0,
      weight = 0
    for (let index = first; index < last; index += 1) {
      const column = source[index]
      top = Math.max(top, column.top)
      bottom = Math.max(bottom, column.bottom)
      const value = Math.max(column.top, column.bottom)
      r += column.r * value
      g += column.g * value
      b += column.b * value
      weight += value
    }
    if (!weight) continue
    const peak = Math.max(r, g, b)
    if (!peak) continue
    ctx.fillStyle = `rgb(${Math.round((r / peak) * displayValue)}, ${Math.round((g / peak) * displayValue)}, ${Math.round((b / peak) * displayValue)})`
    const topHeight = top * drawableHeight * (layout === 'full' ? 0.5 : 1)
    const bottomHeight = bottom * drawableHeight * (layout === 'full' ? 0.5 : 1)
    const y =
      layout === 'bottom-half'
        ? padding
        : padding + (layout === 'full' ? drawableHeight / 2 : drawableHeight) - topHeight
    const drawHeight =
      layout === 'full'
        ? topHeight + bottomHeight
        : layout === 'bottom-half'
          ? bottomHeight
          : topHeight
    if (drawHeight <= 0) continue
    ctx.fillRect(x * step, y, step + 0.01, drawHeight)
    drawn = true
  }
  ctx.restore()
  return drawn
}
