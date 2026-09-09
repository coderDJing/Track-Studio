import type { CompactVisualWaveformData } from '@shared/compactVisualWaveform'
import { resolveSaturatedWaveformColor } from '@shared/waveformDisplayColor'
import {
  RAW_ENERGY_PRESENCE_FLOOR_AMP,
  resolveRawEnergyShapeParamsByDuration,
  shapeRawEnergyAmpValue
} from '@renderer/components/beatGridRawWaveformEnvelope'
import {
  resolveRekordboxRgbHeightAmp,
  type WaveformFrequencyRatios,
  type WaveformRgbColor
} from '@renderer/components/beatGridRawWaveformShape'

type CompactVisualWaveformCanvasContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D

type CompactVisualWaveformRenderable = CompactVisualWaveformData

type CompactVisualWaveformLayout = 'full' | 'top-half' | 'bottom-half'

type CompactVisualWaveformColumn = {
  ampTop: number
  ampBottom: number
  color: WaveformRgbColor
  frequencyRatios?: WaveformFrequencyRatios
}

type DrawCompactVisualWaveformOptions = {
  width: number
  height: number
  data: CompactVisualWaveformRenderable | null
  rangeStartSec: number
  rangeDurationSec: number
  timeBasisOffsetMs?: number
  waveformLayout?: CompactVisualWaveformLayout
  showDetailHighlights?: boolean
  showCenterLine?: boolean
  themeVariant?: 'light' | 'dark'
  waveformGain?: number
}

const HALF_WAVEFORM_AMPLITUDE_RATIO = 0.8
const COLUMN_TAIL_RELEASE = 0.42
const COLUMN_ATTACK_MIN_AMP = 0.06
const COLUMN_ATTACK_MIN_RISE = 0.04
const COLUMN_ATTACK_RELATIVE_RISE = 0.65
const COMPACT_FALLBACK_COLOR: WaveformRgbColor = { r: 235, g: 242, b: 248 }
const DETAIL_HIGHLIGHT_DARK = '255, 255, 255'
const DETAIL_HIGHLIGHT_LIGHT = '15, 23, 42'
const CENTER_LINE_DARK = 'rgba(210, 236, 255, 0.28)'
const CENTER_LINE_LIGHT = 'rgba(43, 102, 217, 0.18)'

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const clamp01 = (value: number) => clamp(Number.isFinite(value) ? value : 0, 0, 1)
const toColorChannel = (value: number) => clamp(Math.round(value), 0, 255)

const resolveWaveformGain = (value?: number) => {
  if (typeof value === 'undefined') return 1
  const numeric = Number(value)
  return Number.isFinite(numeric) ? clamp(numeric, 0, 16) : 1
}

const resolveDetailFrames = (data: CompactVisualWaveformRenderable) =>
  Math.max(0, Math.min(data.detailPeakTop?.length || 0, data.detailPeakBottom?.length || 0))

const resolveDataStartSec = (_data: CompactVisualWaveformRenderable, timeBasisOffsetMs?: number) =>
  Math.max(0, Number(timeBasisOffsetMs) || 0) / 1000

const readByte = (values: Uint8Array | undefined, index: number, fallback = 0) => {
  if (!values?.length) return fallback
  return values[clamp(Math.floor(index), 0, values.length - 1)] ?? fallback
}

const resolveDetailFrameEnergy = (
  data: CompactVisualWaveformRenderable,
  localFrame: number,
  globalFrame: number
) => {
  const top = clamp01((data.detailPeakTop[localFrame] || 0) / 255)
  const bottom = clamp01((data.detailPeakBottom[localFrame] || 0) / 255)
  const bodyRateDivisor = Math.max(1, Math.floor(Number(data.bodyRateDivisor) || 1))
  const body = readByte(
    data.detailBody,
    Math.floor(globalFrame / bodyRateDivisor),
    Math.round(Math.max(top, bottom) * 255)
  )
  return clamp01(Math.max(body / 255, (top + bottom) * 0.32))
}

const resolveColumnEnergy = (column: CompactVisualWaveformColumn | null | undefined) =>
  column ? Math.max(column.ampTop, column.ampBottom) : 0

const isColumnAttack = (
  column: CompactVisualWaveformColumn | null,
  previousColumn: CompactVisualWaveformColumn | null
) => {
  const energy = resolveColumnEnergy(column)
  if (energy < COLUMN_ATTACK_MIN_AMP) return false
  const previousEnergy = resolveColumnEnergy(previousColumn)
  const rise = energy - previousEnergy
  return rise >= Math.max(COLUMN_ATTACK_MIN_RISE, previousEnergy * COLUMN_ATTACK_RELATIVE_RISE)
}

const resolveCompactColorProfile = (
  data: CompactVisualWaveformRenderable,
  globalStartFrame: number,
  globalEndFrame: number
) => {
  const divisor = Math.max(1, Math.floor(Number(data.colorRateDivisor) || 1))
  const colorFrames = Math.min(
    data.colorIndex?.length || 0,
    data.colorRed?.length || 0,
    data.colorGreen?.length || 0,
    data.colorBlue?.length || 0
  )
  if (!colorFrames) return null

  const detailFrames = resolveDetailFrames(data)
  const first = clamp(Math.floor(globalStartFrame / divisor), 0, colorFrames - 1)
  const last = clamp(Math.floor(globalEndFrame / divisor), first, colorFrames - 1)
  let selectedIndex = first
  let selectedPeak = -1
  let selectedSum = -1
  for (let index = first; index <= last; index += 1) {
    const bucketStartFrame = index * divisor
    const bucketEndFrame = bucketStartFrame + divisor - 1
    const startFrame = Math.max(globalStartFrame, bucketStartFrame)
    const endFrame = Math.min(globalEndFrame, bucketEndFrame)
    let energyPeak = 0
    let energySum = 0
    if (endFrame >= startFrame) {
      const localStart = clamp(startFrame, 0, detailFrames - 1)
      const localEnd = clamp(endFrame, localStart, detailFrames - 1)
      for (let localFrame = localStart; localFrame <= localEnd; localFrame += 1) {
        const energy = resolveDetailFrameEnergy(data, localFrame, localFrame)
        energyPeak = Math.max(energyPeak, energy)
        energySum += energy
      }
    }
    if (energyPeak > selectedPeak || (energyPeak === selectedPeak && energySum > selectedSum)) {
      selectedIndex = index
      selectedPeak = energyPeak
      selectedSum = energySum
    }
  }

  const low = data.colorLow?.[selectedIndex] || 0
  const mid = data.colorMid?.[selectedIndex] || 0
  const high = data.colorHigh?.[selectedIndex] || 0
  const red = data.colorRed[selectedIndex] || 0
  const green = data.colorGreen[selectedIndex] || 0
  const blue = data.colorBlue[selectedIndex] || 0
  const maxBand = Math.max(low, mid, high)
  const maxColor = Math.max(red, green, blue)
  // 弱信号会把频段字节量化成 0，这里退回保底色，避免整列被判定为空白。
  if (maxBand <= 0 && maxColor <= 0) {
    return { frequencyRatios: undefined, color: COMPACT_FALLBACK_COLOR }
  }
  const color =
    maxColor > 0
      ? resolveSaturatedWaveformColor({
          r: toColorChannel(red),
          g: toColorChannel(green),
          b: toColorChannel(blue)
        })
      : COMPACT_FALLBACK_COLOR

  return {
    frequencyRatios:
      maxBand > 0
        ? {
            low: clamp01(low / maxBand),
            mid: clamp01(mid / maxBand),
            high: clamp01(high / maxBand)
          }
        : undefined,
    color
  }
}

const resolveCompactVisualColumn = (
  data: CompactVisualWaveformRenderable,
  localStartFrame: number,
  localEndFrame: number,
  waveformGain: number
): CompactVisualWaveformColumn | null => {
  const detailFrames = resolveDetailFrames(data)
  if (!detailFrames) return null
  const safeStart = clamp(localStartFrame, 0, detailFrames - 1)
  const safeEnd = clamp(localEndFrame, safeStart, detailFrames - 1)
  const globalStartFrame = safeStart
  const globalEndFrame = safeEnd

  let energySum = 0
  let energyPeak = 0
  let count = 0
  for (let frame = safeStart; frame <= safeEnd; frame += 1) {
    const energy = clamp01(resolveDetailFrameEnergy(data, frame, frame) * waveformGain)
    energySum += energy
    energyPeak = Math.max(energyPeak, energy)
    count += 1
  }
  // 能量被字节量化成 0 意味着这一段确实是静音（或低于 1/255 量化下限），才允许留白。
  if (count <= 0 || energyPeak <= 0) return null

  const colorProfile = resolveCompactColorProfile(data, globalStartFrame, globalEndFrame)
  const shape = resolveRawEnergyShapeParamsByDuration(Math.max(0, Number(data.duration) || 0))
  const mean = clamp01(energySum / count)
  const base = mean * (1 - shape.peakBlendWeight) + energyPeak * shape.peakBlendWeight
  const amp = shapeRawEnergyAmpValue(base, shape.outputGamma, RAW_ENERGY_PRESENCE_FLOOR_AMP)
  if (amp <= 0) return null
  const shapedAmp = colorProfile?.frequencyRatios
    ? resolveRekordboxRgbHeightAmp(amp, colorProfile.frequencyRatios)
    : amp

  return {
    ampTop: shapedAmp,
    ampBottom: shapedAmp,
    color: colorProfile?.color ?? COMPACT_FALLBACK_COLOR,
    frequencyRatios: colorProfile?.frequencyRatios
  }
}

const applyTailRelease = (
  column: CompactVisualWaveformColumn,
  previousColumn: CompactVisualWaveformColumn | null
) => {
  if (!previousColumn || isColumnAttack(column, previousColumn)) return column
  const previousEnergy = resolveColumnEnergy(previousColumn)
  if (previousEnergy <= 0) return column
  const releasedAmp = previousEnergy * COLUMN_TAIL_RELEASE
  if (releasedAmp <= Math.max(column.ampTop, column.ampBottom)) return column
  return {
    ...column,
    ampTop: clamp01(Math.max(column.ampTop, releasedAmp)),
    ampBottom: clamp01(Math.max(column.ampBottom, releasedAmp))
  }
}

const resolveColumnRect = (
  height: number,
  centerY: number,
  ampScale: number,
  waveformLayout: CompactVisualWaveformLayout,
  ampTop: number,
  ampBottom: number
) => {
  const topHeight = Math.max(1, Math.round(ampTop * ampScale))
  const bottomHeight = Math.max(1, Math.round(ampBottom * ampScale))
  const singleHeight = Math.max(topHeight, bottomHeight)
  if (waveformLayout === 'top-half') {
    return {
      y: Math.max(0, height - singleHeight),
      h: singleHeight
    }
  }
  if (waveformLayout === 'bottom-half') {
    return {
      y: 0,
      h: singleHeight
    }
  }
  return {
    y: centerY - topHeight,
    h: topHeight + bottomHeight
  }
}

export const drawCompactVisualWaveform = (
  ctx: CompactVisualWaveformCanvasContext,
  options: DrawCompactVisualWaveformOptions
) => {
  const { data } = options
  const width = Math.max(1, Math.floor(options.width))
  const height = Math.max(1, Math.floor(options.height))
  const rangeDurationSec = Math.max(0.0001, Number(options.rangeDurationSec) || 0)
  if (!data || width <= 0 || height <= 0 || rangeDurationSec <= 0) return false
  const detailFrames = resolveDetailFrames(data)
  const duration = Math.max(0, Number(data.duration) || 0)
  const rawDetailRate = Number(data.detailRate)
  const detailRate =
    Number.isFinite(rawDetailRate) && rawDetailRate > 0
      ? rawDetailRate
      : detailFrames / Math.max(0.0001, duration)
  if (!detailFrames || !duration) return false

  const dataStartSec = resolveDataStartSec(data, options.timeBasisOffsetMs)
  const dataEndSec = dataStartSec + detailFrames / detailRate
  const rangeStartSec = Number(options.rangeStartSec) || 0
  const waveformLayout = options.waveformLayout || 'full'
  const waveformGain = resolveWaveformGain(options.waveformGain)
  const centerY = Math.round(height / 2)
  const ampScale =
    waveformLayout === 'full'
      ? Math.max(1, centerY - 2)
      : Math.max(1, Math.floor((height - 2) * HALF_WAVEFORM_AMPLITUDE_RATIO))
  const highlightBase =
    options.themeVariant === 'light' ? DETAIL_HIGHLIGHT_LIGHT : DETAIL_HIGHLIGHT_DARK
  const centerLine = options.themeVariant === 'light' ? CENTER_LINE_LIGHT : CENTER_LINE_DARK
  const showDetailHighlights = options.showDetailHighlights === true

  ctx.imageSmoothingEnabled = false
  let previousColumn: CompactVisualWaveformColumn | null = null
  let hasDrawn = false
  for (let x = 0; x < width; x += 1) {
    const startTime = rangeStartSec + (x / width) * rangeDurationSec
    const endTime = rangeStartSec + ((x + 1) / width) * rangeDurationSec
    if (endTime <= dataStartSec || startTime >= dataEndSec) {
      previousColumn = null
      continue
    }
    const localStartSec = clamp(startTime - dataStartSec, 0, dataEndSec - dataStartSec)
    const localEndSec = clamp(endTime - dataStartSec, localStartSec, dataEndSec - dataStartSec)
    if (localEndSec <= localStartSec) {
      previousColumn = null
      continue
    }
    const localStartFrame = clamp(Math.floor(localStartSec * detailRate), 0, detailFrames - 1)
    const localEndFrame = clamp(
      Math.ceil(localEndSec * detailRate),
      localStartFrame,
      detailFrames - 1
    )
    const column = resolveCompactVisualColumn(data, localStartFrame, localEndFrame, waveformGain)
    if (!column) {
      previousColumn = null
      continue
    }
    const shapedColumn = applyTailRelease(column, previousColumn)
    previousColumn = shapedColumn
    const rect = resolveColumnRect(
      height,
      centerY,
      ampScale,
      waveformLayout,
      shapedColumn.ampTop,
      shapedColumn.ampBottom
    )
    ctx.fillStyle = `rgb(${shapedColumn.color.r}, ${shapedColumn.color.g}, ${shapedColumn.color.b})`
    ctx.fillRect(x, rect.y, 1, rect.h)
    if (showDetailHighlights) {
      const topHighlight = Math.max(0, rect.y)
      const bottomHighlight = Math.min(height - 1, rect.y + rect.h - 1)
      ctx.fillStyle = `rgba(${highlightBase}, ${
        0.14 + Math.max(shapedColumn.ampTop, shapedColumn.ampBottom) * 0.3
      })`
      if (waveformLayout === 'top-half') {
        ctx.fillRect(x, topHighlight, 1, 1)
      } else if (waveformLayout === 'bottom-half') {
        ctx.fillRect(x, bottomHighlight, 1, 1)
      } else {
        ctx.fillRect(x, topHighlight, 1, 1)
        ctx.fillRect(x, bottomHighlight, 1, 1)
      }
    }
    hasDrawn = true
  }

  if (hasDrawn && options.showCenterLine === true && waveformLayout === 'full') {
    ctx.fillStyle = centerLine
    ctx.fillRect(0, centerY, width, 1)
  }
  return hasDrawn
}
