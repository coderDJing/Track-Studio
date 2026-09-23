import type { IPioneerPreviewWaveformData } from 'src/types/globals'
import type {
  MixxxWaveformData,
  RGBWaveformBandKey
} from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { WaveformListPreviewData } from '@shared/waveformSurfaceCache'
import type { SeratoWaveformOverviewData } from '@shared/seratoWaveformOverview'
import {
  formatSaturatedWaveformRgb,
  resolveSaturatedWaveformColor
} from '@shared/waveformDisplayColor'
import { drawCompactVisualWaveform } from '@renderer/components/compactVisualWaveformRenderer'
import {
  drawWaveformTimelineTicks,
  type WaveformTimelineTickThemeVariant
} from '@renderer/components/waveformTimelineTicks'

type SongListWaveformCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

type MixxxColumnMetrics = {
  amplitudeLeft: number
  amplitudeRight: number
  color: { r: number; g: number; b: number }
  progressColor: { r: number; g: number; b: number }
}

export type SongListWaveformRgbMetricsCacheEntry = {
  source: MixxxWaveformData
  columnCount: number
  metrics: MixxxColumnMetrics[]
}

const MIXXX_MAX_RGB_ENERGY = Math.sqrt(255 * 255 * 3)
const MIXXX_RGB_BRIGHTNESS_SCALE = 0.95
const MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE = 0.6
const MIXXX_RGB_COMPONENTS: Record<RGBWaveformBandKey, { r: number; g: number; b: number }> = {
  low: { r: 1, g: 0, b: 0 },
  mid: { r: 0, g: 1, b: 0 },
  high: { r: 0, g: 0, b: 1 }
}

const toColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)

export const drawSongListTimelineTicks = (
  ctx: SongListWaveformCanvasContext,
  width: number,
  height: number,
  options: {
    durationSec: number
    playedPercent: number
    themeVariant: WaveformTimelineTickThemeVariant
  }
) => {
  drawWaveformTimelineTicks(ctx, width, height, options.durationSec, options.themeVariant, {
    playedPercent: options.playedPercent
  })
}

const computeSongListMixxxColumnMetrics = (
  filePath: string,
  columnCount: number,
  waveformData: MixxxWaveformData | null,
  rgbMetricsCache: Map<string, SongListWaveformRgbMetricsCacheEntry>
): MixxxColumnMetrics[] => {
  if (!waveformData || columnCount <= 0) return []
  const cached = rgbMetricsCache.get(filePath)
  if (cached && cached.source === waveformData && cached.columnCount === columnCount) {
    return cached.metrics
  }
  const low = waveformData.bands.low
  const mid = waveformData.bands.mid
  const high = waveformData.bands.high
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length
  )
  if (frameCount === 0) return []
  const columns: MixxxColumnMetrics[] = new Array(columnCount)
  const dataSize = frameCount * 2
  const gain = dataSize / Math.max(1, columnCount)
  const lastVisualFrame = frameCount - 1
  for (let x = 0; x < columnCount; x++) {
    const xSampleWidth = gain * x
    const xVisualSampleIndex = xSampleWidth
    const maxSamplingRange = gain / 2
    let visualFrameStart = Math.floor(xVisualSampleIndex / 2 - maxSamplingRange + 0.5)
    let visualFrameStop = Math.floor(xVisualSampleIndex / 2 + maxSamplingRange + 0.5)
    if (visualFrameStart < 0) visualFrameStart = 0
    if (visualFrameStop > lastVisualFrame) visualFrameStop = lastVisualFrame
    if (visualFrameStop < visualFrameStart) {
      visualFrameStop = visualFrameStart
    }
    let maxLow = 0
    let maxMid = 0
    let maxHigh = 0
    let maxAllLeft = 0
    let maxAllRight = 0
    for (let i = visualFrameStart; i <= visualFrameStop; i++) {
      const lowLeft = low.left[i]
      const lowRight = low.right[i]
      const midLeft = mid.left[i]
      const midRight = mid.right[i]
      const highLeft = high.left[i]
      const highRight = high.right[i]
      const lowLeftAmp = low.peakLeft ? low.peakLeft[i] : lowLeft
      const lowRightAmp = low.peakRight ? low.peakRight[i] : lowRight
      const midLeftAmp = mid.peakLeft ? mid.peakLeft[i] : midLeft
      const midRightAmp = mid.peakRight ? mid.peakRight[i] : midRight
      const highLeftAmp = high.peakLeft ? high.peakLeft[i] : highLeft
      const highRightAmp = high.peakRight ? high.peakRight[i] : highRight
      if (lowLeft > maxLow) maxLow = lowLeft
      if (lowRight > maxLow) maxLow = lowRight
      if (midLeft > maxMid) maxMid = midLeft
      if (midRight > maxMid) maxMid = midRight
      if (highLeft > maxHigh) maxHigh = highLeft
      if (highRight > maxHigh) maxHigh = highRight
      const allLeft = lowLeftAmp * lowLeftAmp + midLeftAmp * midLeftAmp + highLeftAmp * highLeftAmp
      const allRight =
        lowRightAmp * lowRightAmp + midRightAmp * midRightAmp + highRightAmp * highRightAmp
      if (allLeft > maxAllLeft) maxAllLeft = allLeft
      if (allRight > maxAllRight) maxAllRight = allRight
    }
    const red =
      maxLow * MIXXX_RGB_COMPONENTS.low.r +
      maxMid * MIXXX_RGB_COMPONENTS.mid.r +
      maxHigh * MIXXX_RGB_COMPONENTS.high.r
    const green =
      maxLow * MIXXX_RGB_COMPONENTS.low.g +
      maxMid * MIXXX_RGB_COMPONENTS.mid.g +
      maxHigh * MIXXX_RGB_COMPONENTS.high.g
    const blue =
      maxLow * MIXXX_RGB_COMPONENTS.low.b +
      maxMid * MIXXX_RGB_COMPONENTS.mid.b +
      maxHigh * MIXXX_RGB_COMPONENTS.high.b
    const maxColor = Math.max(red, green, blue)
    const color =
      maxColor > 0
        ? resolveSaturatedWaveformColor({
            r: toColorChannel((red / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
            g: toColorChannel((green / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
            b: toColorChannel((blue / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE)
          })
        : { r: 0, g: 0, b: 0 }
    const progressColor =
      maxColor > 0
        ? resolveSaturatedWaveformColor({
            r: toColorChannel((red / maxColor) * 255 * MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE),
            g: toColorChannel((green / maxColor) * 255 * MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE),
            b: toColorChannel((blue / maxColor) * 255 * MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE)
          })
        : { r: 0, g: 0, b: 0 }
    const amplitudeLeft = Math.min(1, Math.sqrt(maxAllLeft) / MIXXX_MAX_RGB_ENERGY)
    const amplitudeRight = Math.min(1, Math.sqrt(maxAllRight) / MIXXX_MAX_RGB_ENERGY)
    columns[x] = {
      amplitudeLeft,
      amplitudeRight,
      color,
      progressColor
    }
  }
  rgbMetricsCache.set(filePath, { source: waveformData, columnCount, metrics: columns })
  return columns
}

export const drawSongListPioneerPreviewWaveform = (
  ctx: SongListWaveformCanvasContext,
  width: number,
  height: number,
  waveformData: IPioneerPreviewWaveformData,
  playedPercent: number,
  progressColor: string
) => {
  const columns = Array.isArray(waveformData?.columns) ? waveformData.columns : []
  const maxHeight = Math.max(
    1,
    Number(waveformData?.maxHeight) ||
      columns.reduce((value, column) => Math.max(value, Number(column?.backHeight) || 0), 0)
  )
  if (!columns.length || width <= 0 || height <= 0 || maxHeight <= 0) return
  const columnCount = Math.max(1, Math.floor(width))
  const samplesPerColumn = columns.length / columnCount
  const spacing = width / columnCount
  const drawWidth = Math.max(1, spacing)
  const verticalPadding = Math.min(4, Math.max(0, Math.floor((height - 1) / 2)))
  const drawableHeight = Math.max(1, height - verticalPadding * 2)
  const scaleY = drawableHeight / maxHeight
  for (let index = 0; index < columnCount; index++) {
    const start = Math.floor(index * samplesPerColumn)
    const end = Math.min(
      columns.length,
      Math.max(start + 1, Math.floor((index + 1) * samplesPerColumn))
    )
    let selected = columns[start] || null
    for (let i = start; i < end; i++) {
      const candidate = columns[i]
      if (!candidate) continue
      if (!selected || (candidate.backHeight || 0) >= (selected.backHeight || 0)) {
        selected = candidate
      }
    }
    if (!selected) continue
    const backHeight = Math.max(0, Number(selected.backHeight) || 0)
    const frontHeight = Math.max(0, Number(selected.frontHeight) || 0)
    const x = Math.min(width - drawWidth, index * spacing)
    if (backHeight > 0) {
      const backPixelHeight = Math.max(1, backHeight * scaleY)
      ctx.fillStyle = formatSaturatedWaveformRgb({
        r: selected.backColorR || 0,
        g: selected.backColorG || 0,
        b: selected.backColorB || 0
      })
      ctx.fillRect(x, height - verticalPadding - backPixelHeight, drawWidth, backPixelHeight)
    }
    if (frontHeight > 0) {
      const frontPixelHeight = Math.max(1, frontHeight * scaleY)
      ctx.fillStyle = formatSaturatedWaveformRgb({
        r: selected.frontColorR || 0,
        g: selected.frontColorG || 0,
        b: selected.frontColorB || 0
      })
      ctx.fillRect(x, height - verticalPadding - frontPixelHeight, drawWidth, frontPixelHeight)
    }
  }
  const clampedPlayed = clamp01(playedPercent)
  if (clampedPlayed <= 0) return
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.globalAlpha = 0.32
  ctx.fillStyle = progressColor
  ctx.fillRect(0, 0, width * clampedPlayed, height)
  ctx.restore()
}

export const drawSongListSeratoOverview = (
  ctx: SongListWaveformCanvasContext,
  width: number,
  height: number,
  waveformData: SeratoWaveformOverviewData,
  playedPercent: number,
  progressColor: string
) => {
  const sourceColumns = Math.max(0, Number(waveformData?.columnCount) || 0)
  const sourceRows = Math.max(0, Number(waveformData?.rowCount) || 0)
  const pixels = waveformData?.pixels
  if (!sourceColumns || sourceRows !== 16 || !(pixels instanceof Uint8Array)) return
  if (pixels.length < sourceColumns * sourceRows || width <= 0 || height <= 0) return

  const targetColumns = Math.max(1, Math.floor(width))
  const columnWidth = width / targetColumns
  const rowHeight = height / sourceRows
  for (let x = 0; x < targetColumns; x++) {
    const sourceX = Math.min(sourceColumns - 1, Math.floor((x / targetColumns) * sourceColumns))
    const offset = sourceX * sourceRows
    let lowValueCount = 0
    for (let row = 0; row < sourceRows; row++) {
      if (pixels[offset + row] < 0x80) lowValueCount += 1
    }
    const hue = ((lowValueCount / sourceRows) * 1.5 * 360) % 360
    for (let row = 0; row < sourceRows; row++) {
      const value = pixels[offset + row]
      if (value <= 1) continue
      const luminance = 12 + Math.sqrt(value / 255) * 70
      ctx.fillStyle = `hsl(${hue} 58% ${luminance}%)`
      ctx.fillRect(x * columnWidth, row * rowHeight, Math.max(1, columnWidth), rowHeight + 0.5)
    }
  }

  const clampedPlayed = clamp01(playedPercent)
  if (clampedPlayed <= 0) return
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.globalAlpha = 0.3
  ctx.fillStyle = progressColor
  ctx.fillRect(0, 0, width * clampedPlayed, height)
  ctx.restore()
}

const drawSongListRgbWaveform = (
  ctx: SongListWaveformCanvasContext,
  width: number,
  height: number,
  filePath: string,
  waveformData: MixxxWaveformData,
  isHalf: boolean,
  playedPercent: number,
  rgbMetricsCache: Map<string, SongListWaveformRgbMetricsCacheEntry>
) => {
  const columns = computeSongListMixxxColumnMetrics(
    filePath,
    Math.max(1, Math.floor(width)),
    waveformData,
    rgbMetricsCache
  )
  if (!columns.length) return
  const centerY = height / 2
  const maxAmplitude = isHalf ? height : centerY
  const playedColumns = Math.min(
    columns.length,
    Math.max(0, Math.floor(columns.length * playedPercent))
  )
  for (let x = 0; x < columns.length; x++) {
    const column = columns[x]
    const { r, g, b } = x < playedColumns ? column.progressColor : column.color
    if (!r && !g && !b) continue
    const amplitudeTop = Math.max(1, column.amplitudeLeft * maxAmplitude)
    const amplitudeBottom = Math.max(1, column.amplitudeRight * maxAmplitude)
    const rectHeight = isHalf
      ? Math.max(amplitudeTop, amplitudeBottom)
      : amplitudeTop + amplitudeBottom
    const yTop = isHalf ? height - rectHeight : centerY - amplitudeTop
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
    ctx.fillRect(x, yTop, 1, rectHeight)
  }
}

export const drawSongListCompactVisualWaveform = (
  ctx: SongListWaveformCanvasContext,
  width: number,
  height: number,
  waveformData: WaveformListPreviewData,
  options: {
    isHalf: boolean
    progressColor: string
    playedPercent: number
  }
) => {
  drawCompactVisualWaveform(ctx, {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
    data: waveformData,
    rangeStartSec: 0,
    rangeDurationSec: Math.max(0.0001, Number(waveformData.duration) || 0),
    showDetailHighlights: false,
    showCenterLine: false,
    waveformLayout: options.isHalf ? 'top-half' : 'full'
  })
  const clampedPlayed = clamp01(options.playedPercent)
  if (clampedPlayed > 0 && clampedPlayed < 1) {
    ctx.save()
    ctx.globalCompositeOperation = 'source-atop'
    ctx.globalAlpha = 0.22
    ctx.fillStyle = '#000000'
    ctx.fillRect(width * clampedPlayed, 0, width * (1 - clampedPlayed), height)
    ctx.restore()
  }
}

export const drawSongListMixxxWaveform = (
  ctx: SongListWaveformCanvasContext,
  width: number,
  height: number,
  filePath: string,
  waveformData: MixxxWaveformData,
  options: {
    isHalf: boolean
    playedPercent: number
    rgbMetricsCache: Map<string, SongListWaveformRgbMetricsCacheEntry>
  }
) => {
  drawSongListRgbWaveform(
    ctx,
    width,
    height,
    filePath,
    waveformData,
    options.isHalf,
    options.playedPercent,
    options.rgbMetricsCache
  )
}
