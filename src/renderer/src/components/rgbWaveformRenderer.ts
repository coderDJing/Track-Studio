import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { isRawPlaceholderMixxxData } from '@renderer/components/beatGridWaveformData'
import { resolveSaturatedWaveformColor } from '@shared/waveformDisplayColor'
import {
  resolveRawEnergyAttackAmp,
  resolveRawEnergyProfileByRange,
  type RawEnergyShapeParams
} from '@renderer/components/beatGridRawWaveformEnvelope'
import { resolveRawFftBandProfile } from '@renderer/components/beatGridRawWaveformColor'
import {
  resolveRekordboxRgbHeightAmp,
  type WaveformFrequencyRatios,
  type WaveformRgbColor
} from '@renderer/components/beatGridRawWaveformShape'
import { drawRawCurveWaveform } from '@renderer/components/beatGridRawCurveWaveformRenderer'

type DrawWaveformOptions = {
  width: number
  height: number
  timeBasisOffsetMs?: number
  rangeStartSec: number
  rangeDurationSec: number
  mixxxData: MixxxWaveformData | null
  rawData?: RawWaveformData | null
  showBackground?: boolean
  maxSamplesPerPixel?: number
  showDetailHighlights?: boolean
  showCenterLine?: boolean
  waveformLayout?: 'full' | 'top-half' | 'bottom-half'
  waveformRenderStyle?: WaveformRenderStyle
  themeVariant?: 'light' | 'dark'
  preferRawPeaksOnly?: boolean
  smoothColumns?: boolean
  waveformGain?: number
}

type WaveformColumn = {
  ampTop: number
  ampBottom: number
  rawEnergyBase?: number
  rawEnergyPeak?: number
  rawEnergyShape?: RawEnergyShapeParams
  frequencyRatios?: WaveformFrequencyRatios
  rekordboxTriBand?: WaveformFrequencyRatios
  color: WaveformRgbColor
}

type WaveformRenderStyle = 'columns' | 'raw-curve'
type WaveformLayout = 'full' | 'top-half' | 'bottom-half'

const MIXXX_MAX_RGB_ENERGY = Math.sqrt(255 * 255 * 3)
const MIXXX_RGB_BRIGHTNESS_SCALE = 0.95
const HALF_WAVEFORM_AMPLITUDE_RATIO = 0.8
const REKORDBOX_RGB_DETAIL_RATE = 150
const COLUMN_DECAY_SMOOTH_PREV2_WEIGHT = 0.04
const COLUMN_DECAY_SMOOTH_PREV1_WEIGHT = 0.16
const COLUMN_DECAY_SMOOTH_CURRENT_WEIGHT = 0.8
const COLUMN_TAIL_RELEASE = 0.42
const COLUMN_ATTACK_MIN_AMP = 0.06
const COLUMN_ATTACK_MIN_RISE = 0.04
const COLUMN_ATTACK_RELATIVE_RISE = 0.65
const RAW_PEAKS_ONLY_FALLBACK_COLOR: WaveformRgbColor = { r: 235, g: 242, b: 248 }
const REKORDBOX_TRI_BAND_COLORS = {
  low: 'rgb(38, 82, 242)',
  mid: 'rgba(255, 143, 20, 0.68)',
  high: 'rgba(245, 250, 255, 0.96)'
}
const MIXXX_RGB_COMPONENTS = {
  low: { r: 1, g: 0, b: 0 },
  mid: { r: 0, g: 1, b: 0 },
  high: { r: 0, g: 0, b: 1 }
}

type WaveformPalette = {
  backgroundStart: string
  backgroundEnd: string
  backgroundStripe: string
  detailHighlightBase: string
  centerLine: string
}

type WaveformCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const DARK_WAVEFORM_PALETTE: WaveformPalette = {
  backgroundStart: '#151515',
  backgroundEnd: '#1c1c1c',
  backgroundStripe: 'rgba(255, 255, 255, 0.03)',
  detailHighlightBase: '255, 255, 255',
  centerLine: 'rgba(210, 236, 255, 0.28)'
}

const LIGHT_WAVEFORM_PALETTE: WaveformPalette = {
  backgroundStart: '#d9dee6',
  backgroundEnd: '#cfd6df',
  backgroundStripe: 'rgba(15, 23, 42, 0.03)',
  detailHighlightBase: '15, 23, 42',
  centerLine: 'rgba(43, 102, 217, 0.18)'
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const toColorChannel = (value: number) => clamp(Math.round(value), 0, 255)
const normalizeWaveformGain = (value?: number) => {
  if (typeof value === 'undefined') return 1
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return clamp(numeric, 0, 16)
}

const isNativeRekordboxWaveform = (rawData: RawWaveformData | null) =>
  rawData?.nativeWaveformKind === 'rekordbox-rgb' ||
  rawData?.nativeWaveformKind === 'rekordbox-triband'
const resolveColumnEnergy = (column: WaveformColumn | null | undefined) =>
  column ? Math.max(column.ampTop, column.ampBottom) : 0

const isColumnAttack = (column: WaveformColumn | null, previousColumn: WaveformColumn | null) => {
  const energy = resolveColumnEnergy(column)
  if (energy < COLUMN_ATTACK_MIN_AMP) return false
  const previousEnergy = resolveColumnEnergy(previousColumn)
  const rise = energy - previousEnergy
  return rise >= Math.max(COLUMN_ATTACK_MIN_RISE, previousEnergy * COLUMN_ATTACK_RELATIVE_RISE)
}

const resolveWaveformPalette = (
  ctx: WaveformCanvasContext,
  themeVariant?: 'light' | 'dark'
): WaveformPalette => {
  if (themeVariant === 'light') return LIGHT_WAVEFORM_PALETTE
  if (themeVariant === 'dark') return DARK_WAVEFORM_PALETTE
  const canvas = ctx.canvas as HTMLCanvasElement | OffscreenCanvas | undefined
  const doc = canvas && 'ownerDocument' in canvas ? canvas.ownerDocument : null
  const htmlEl = doc?.documentElement
  const bodyEl = doc?.body
  const isLight =
    !!htmlEl?.classList.contains('theme-light') || !!bodyEl?.classList.contains('theme-light')
  return isLight ? LIGHT_WAVEFORM_PALETTE : DARK_WAVEFORM_PALETTE
}

const drawBackground = (
  ctx: WaveformCanvasContext,
  width: number,
  height: number,
  palette: WaveformPalette
) => {
  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, palette.backgroundStart)
  gradient.addColorStop(1, palette.backgroundEnd)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = palette.backgroundStripe
  for (let y = 0; y < height; y += 4) {
    ctx.fillRect(0, y, width, 1)
  }
}

const isValidMixxxWaveformData = (data: MixxxWaveformData | null): data is MixxxWaveformData => {
  if (!data) return false
  const low = data.bands?.low
  const mid = data.bands?.mid
  const high = data.bands?.high
  const all = data.bands?.all
  if (!low || !mid || !high || !all) return false
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length,
    all.left.length,
    all.right.length
  )
  return frameCount > 0
}

const isValidRawWaveformData = (data: RawWaveformData | null): data is RawWaveformData => {
  if (!data) return false
  const frames = Math.max(
    0,
    Math.min(
      Number(data.frames) || Number.POSITIVE_INFINITY,
      data.minLeft.length,
      data.maxLeft.length,
      data.minRight.length,
      data.maxRight.length
    )
  )
  if (!Number.isFinite(data.rate) || data.rate <= 0) return false
  if (!Number.isFinite(data.duration) || data.duration <= 0) return false
  return frames > 0
}

const resolveRawPeaksByRange = (
  rawData: RawWaveformData,
  startFrame: number,
  endFrame: number,
  maxSamplesPerPixel?: number
) => {
  const span = endFrame - startFrame + 1
  const sampleCap = Number(maxSamplesPerPixel)
  const step =
    Number.isFinite(sampleCap) && sampleCap > 0
      ? Math.max(1, Math.floor(span / Math.max(1, Math.floor(sampleCap))))
      : 1
  let peakLeft = 0
  let peakRight = 0
  let lastFrame = startFrame
  for (let frame = startFrame; frame <= endFrame; frame += step) {
    const minLeft = Math.abs(rawData.minLeft[frame] || 0)
    const maxLeft = Math.abs(rawData.maxLeft[frame] || 0)
    const minRight = Math.abs(rawData.minRight[frame] || 0)
    const maxRight = Math.abs(rawData.maxRight[frame] || 0)
    peakLeft = Math.max(peakLeft, minLeft, maxLeft)
    peakRight = Math.max(peakRight, minRight, maxRight)
    lastFrame = frame
  }
  if (lastFrame !== endFrame) {
    const minLeft = Math.abs(rawData.minLeft[endFrame] || 0)
    const maxLeft = Math.abs(rawData.maxLeft[endFrame] || 0)
    const minRight = Math.abs(rawData.minRight[endFrame] || 0)
    const maxRight = Math.abs(rawData.maxRight[endFrame] || 0)
    peakLeft = Math.max(peakLeft, minLeft, maxLeft)
    peakRight = Math.max(peakRight, minRight, maxRight)
  }
  return {
    ampTop: Math.max(0, Math.min(1, peakLeft)),
    ampBottom: Math.max(0, Math.min(1, peakRight))
  }
}

const resolveRawColumnByTimeRange = (
  rawData: RawWaveformData,
  rawFrames: number,
  rawRate: number,
  rawStartSec: number,
  startTime: number,
  endTime: number,
  maxSamplesPerPixel: number | undefined,
  preferRawPeaksOnly: boolean,
  useRawEnergyEnvelope: boolean,
  waveformGain: number
): WaveformColumn | null => {
  const rawDuration = rawFrames / rawRate
  const safeRawDuration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0
  const rawEndSec = rawStartSec + safeRawDuration
  if (!safeRawDuration || endTime <= rawStartSec || startTime >= rawEndSec) return null
  const rawLocalStartTime = clamp(startTime - rawStartSec, 0, safeRawDuration)
  const rawLocalEndTime = clamp(endTime - rawStartSec, rawLocalStartTime, safeRawDuration)
  if (rawLocalEndTime <= rawLocalStartTime) return null
  const rawStartFrame = clamp(Math.floor(rawLocalStartTime * rawRate), 0, rawFrames - 1)
  const rawEndFrame = clamp(Math.ceil(rawLocalEndTime * rawRate), rawStartFrame, rawFrames - 1)
  const rawEnergyProfile = useRawEnergyEnvelope
    ? resolveRawEnergyProfileByRange(
        rawData,
        rawStartFrame,
        rawEndFrame,
        maxSamplesPerPixel,
        waveformGain
      )
    : null
  const rawPeaks = rawEnergyProfile
    ? null
    : resolveRawPeaksByRange(rawData, rawStartFrame, rawEndFrame, maxSamplesPerPixel)
  const rawAmps = rawEnergyProfile || {
    ampTop: clamp((rawPeaks?.ampTop ?? 0) * waveformGain, 0, 1),
    ampBottom: clamp((rawPeaks?.ampBottom ?? 0) * waveformGain, 0, 1)
  }
  if (rawAmps.ampTop <= 0 && rawAmps.ampBottom <= 0) return null
  const isNativeRekordboxTriBand = rawData.nativeWaveformKind === 'rekordbox-triband'
  const rawColorUsesEnergyShape =
    preferRawPeaksOnly || isNativeRekordboxWaveform(rawData) ? false : useRawEnergyEnvelope
  let rekordboxTriBand: WaveformFrequencyRatios | undefined
  if (isNativeRekordboxTriBand) {
    let low = 0
    let mid = 0
    let high = 0
    for (let frame = rawStartFrame; frame <= rawEndFrame; frame += 1) {
      low = Math.max(low, rawData.compactColorLow?.[frame] || 0)
      mid = Math.max(mid, rawData.compactColorMid?.[frame] || 0)
      high = Math.max(high, rawData.compactColorHigh?.[frame] || 0)
    }
    rekordboxTriBand = { low: low / 255, mid: mid / 255, high: high / 255 }
  }
  const rawFftProfile = isNativeRekordboxTriBand
    ? null
    : resolveRawFftBandProfile(
        rawData,
        rawStartFrame,
        rawEndFrame,
        maxSamplesPerPixel,
        rawColorUsesEnergyShape
      )
  // 弱信号可能解析不出频段配色，但只要有非零幅度就必须保底出一条细线，不能整列留白。
  const hasRawAmplitude = rawAmps.ampTop > 0 || rawAmps.ampBottom > 0
  const color =
    rawFftProfile?.color ??
    (isNativeRekordboxTriBand ? { r: 38, g: 82, b: 242 } : null) ??
    (preferRawPeaksOnly || hasRawAmplitude ? RAW_PEAKS_ONLY_FALLBACK_COLOR : null)
  if (!color) return null
  return {
    ampTop: rawAmps.ampTop,
    ampBottom: rawAmps.ampBottom,
    rawEnergyBase: rawEnergyProfile?.base,
    rawEnergyPeak: rawEnergyProfile?.peak,
    rawEnergyShape: rawEnergyProfile?.shape,
    frequencyRatios: rawFftProfile?.bands,
    rekordboxTriBand,
    color
  }
}

const buildWaveformColumns = (
  width: number,
  mixxxData: MixxxWaveformData,
  rawData: RawWaveformData | null,
  rangeStartSec: number,
  rangeDurationSec: number,
  maxSamplesPerPixel?: number,
  timeBasisOffsetMs?: number,
  preferRawPeaksOnly = false,
  smoothColumns = false,
  useRawEnergyEnvelope = false,
  waveformGain = 1
): WaveformColumn[] => {
  const low = mixxxData.bands.low
  const mid = mixxxData.bands.mid
  const high = mixxxData.bands.high
  const mixxxIsPlaceholder = isRawPlaceholderMixxxData(mixxxData)
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length
  )
  if (!frameCount || width <= 0 || rangeDurationSec <= 0) return []

  const duration = Number(mixxxData.duration)
  if (!Number.isFinite(duration) || duration <= 0) return []

  const columns: WaveformColumn[] = new Array(width)
  const hasRaw = isValidRawWaveformData(rawData)
  const rawFrames = hasRaw
    ? Math.max(
        1,
        Math.min(
          Math.floor(Number(rawData.loadedFrames ?? rawData.frames) || 0),
          Math.floor(Number(rawData.frames) || 0)
        )
      )
    : 0
  const rawRate = hasRaw ? Number(rawData.rate) : 0
  const timeBasisOffsetSec = Math.max(0, Number(timeBasisOffsetMs) || 0) / 1000
  const rawStartSec = hasRaw
    ? Math.max(0, Number(rawData.startSec) || 0) +
      (isNativeRekordboxWaveform(rawData) ? 0 : timeBasisOffsetSec)
    : 0
  const rawColumnDurationSec = rangeDurationSec / Math.max(1, width)
  const safeWaveformGain = normalizeWaveformGain(waveformGain)
  const rawPeaksOnly = preferRawPeaksOnly === true
  const nativeRekordboxWaveform = isNativeRekordboxWaveform(rawData)
  const shouldSmoothRawColumns = smoothColumns && !rawPeaksOnly && !nativeRekordboxWaveform
  const shouldUseRawEnergyEnvelope =
    useRawEnergyEnvelope && !rawPeaksOnly && !nativeRekordboxWaveform
  const rawDetailColumnDurationSec = Math.max(rawColumnDurationSec, 1 / REKORDBOX_RGB_DETAIL_RATE)
  const rawTimelineColumnCache = new Map<number, WaveformColumn | null>()
  const resolveRawTimelineColumn = (timelineColumnIndex: number) => {
    if (!hasRaw || !rawData || rawFrames <= 0 || rawRate <= 0 || rawDetailColumnDurationSec <= 0) {
      return null
    }
    if (rawTimelineColumnCache.has(timelineColumnIndex)) {
      return rawTimelineColumnCache.get(timelineColumnIndex) ?? null
    }
    const startTime = timelineColumnIndex * rawDetailColumnDurationSec
    const column = resolveRawColumnByTimeRange(
      rawData,
      rawFrames,
      rawRate,
      rawStartSec,
      startTime,
      startTime + rawDetailColumnDurationSec,
      maxSamplesPerPixel,
      rawPeaksOnly,
      shouldUseRawEnergyEnvelope,
      safeWaveformGain
    )
    rawTimelineColumnCache.set(timelineColumnIndex, column)
    return column
  }
  const resolveSmoothedRawTimelineColumn = (timelineColumnIndex: number): WaveformColumn | null => {
    const currentColumn = resolveRawTimelineColumn(timelineColumnIndex)
    if (!currentColumn) return null
    const previousColumn = resolveRawTimelineColumn(timelineColumnIndex - 1)
    let shapedCurrentColumn = currentColumn
    if (shouldUseRawEnergyEnvelope) {
      const attackAmp = resolveRawEnergyAttackAmp(
        currentColumn.rawEnergyBase,
        currentColumn.rawEnergyPeak,
        previousColumn?.rawEnergyBase,
        currentColumn.rawEnergyShape
      )
      if (typeof attackAmp === 'number' && attackAmp > currentColumn.ampTop) {
        shapedCurrentColumn = {
          ...currentColumn,
          ampTop: attackAmp,
          ampBottom: attackAmp
        }
      }
    }
    if (isColumnAttack(shapedCurrentColumn, previousColumn)) {
      return shapedCurrentColumn
    }

    let ampTop = 0
    let ampBottom = 0
    let r = 0
    let g = 0
    let b = 0
    let lowRatio = 0
    let midRatio = 0
    let highRatio = 0
    let totalWeight = 0
    const addColumn = (column: WaveformColumn | null, weight: number) => {
      if (!column) return
      ampTop += column.ampTop * weight
      ampBottom += column.ampBottom * weight
      r += column.color.r * weight
      g += column.color.g * weight
      b += column.color.b * weight
      lowRatio += (column.frequencyRatios?.low ?? 0) * weight
      midRatio += (column.frequencyRatios?.mid ?? 0) * weight
      highRatio += (column.frequencyRatios?.high ?? 0) * weight
      totalWeight += weight
    }

    addColumn(resolveRawTimelineColumn(timelineColumnIndex - 2), COLUMN_DECAY_SMOOTH_PREV2_WEIGHT)
    addColumn(previousColumn, COLUMN_DECAY_SMOOTH_PREV1_WEIGHT)
    addColumn(shapedCurrentColumn, COLUMN_DECAY_SMOOTH_CURRENT_WEIGHT)
    if (totalWeight <= 0 || (ampTop <= 0 && ampBottom <= 0)) return null
    return {
      ampTop: clamp(ampTop / totalWeight, 0, 1),
      ampBottom: clamp(ampBottom / totalWeight, 0, 1),
      color: {
        ...resolveSaturatedWaveformColor({
          r: toColorChannel(r / totalWeight),
          g: toColorChannel(g / totalWeight),
          b: toColorChannel(b / totalWeight)
        })
      },
      frequencyRatios:
        lowRatio > 0 || midRatio > 0 || highRatio > 0
          ? {
              low: clamp(lowRatio / totalWeight, 0, 1),
              mid: clamp(midRatio / totalWeight, 0, 1),
              high: clamp(highRatio / totalWeight, 0, 1)
            }
          : undefined
    }
  }
  const applyRawEnergyColumnPostShape = (
    column: WaveformColumn,
    previousColumn: WaveformColumn | null
  ) => {
    const heightShapedColumn =
      shouldUseRawEnergyEnvelope && column.frequencyRatios
        ? {
            ...column,
            ampTop: resolveRekordboxRgbHeightAmp(column.ampTop, column.frequencyRatios),
            ampBottom: resolveRekordboxRgbHeightAmp(column.ampBottom, column.frequencyRatios)
          }
        : column
    if (
      !shouldUseRawEnergyEnvelope ||
      !previousColumn ||
      isColumnAttack(heightShapedColumn, previousColumn)
    ) {
      return heightShapedColumn
    }
    const previousEnergy = resolveColumnEnergy(previousColumn)
    if (previousEnergy <= 0) return heightShapedColumn
    const releasedAmp = previousEnergy * COLUMN_TAIL_RELEASE
    if (releasedAmp <= Math.max(heightShapedColumn.ampTop, heightShapedColumn.ampBottom)) {
      return heightShapedColumn
    }
    return {
      ...heightShapedColumn,
      ampTop: clamp(Math.max(heightShapedColumn.ampTop, releasedAmp), 0, 1),
      ampBottom: clamp(Math.max(heightShapedColumn.ampBottom, releasedAmp), 0, 1)
    }
  }

  const setRawColumn = (x: number, column: WaveformColumn | null) => {
    if (!column) return
    columns[x] = applyRawEnergyColumnPostShape(column, columns[x - 1] ?? null)
  }

  for (let x = 0; x < width; x += 1) {
    const startTime = rangeStartSec + (x / width) * rangeDurationSec
    const endTime = rangeStartSec + ((x + 1) / width) * rangeDurationSec
    if (endTime <= 0 || startTime >= duration) continue
    const clampedStartTime = clamp(startTime, 0, duration)
    const clampedEndTime = clamp(endTime, clampedStartTime, duration)
    if (clampedEndTime <= clampedStartTime) continue
    const startFrame = clamp(
      Math.floor((clampedStartTime / duration) * frameCount),
      0,
      frameCount - 1
    )
    const endFrame = clamp(
      Math.ceil((clampedEndTime / duration) * frameCount),
      startFrame,
      frameCount - 1
    )

    let maxLow = 0
    let maxMid = 0
    let maxHigh = 0
    let maxAllTop = 0
    let maxAllBottom = 0

    const span = endFrame - startFrame + 1
    const sampleCap = Number(maxSamplesPerPixel)
    const step =
      Number.isFinite(sampleCap) && sampleCap > 0
        ? Math.max(1, Math.floor(span / Math.max(1, Math.floor(sampleCap))))
        : 1

    if (hasRaw && rawData && rawFrames > 0 && rawRate > 0) {
      const rawTimelineColumnIndex = Math.floor(startTime / rawDetailColumnDurationSec)
      let column: WaveformColumn | null = null
      if (shouldSmoothRawColumns) {
        column = resolveSmoothedRawTimelineColumn(rawTimelineColumnIndex)
      } else if (shouldUseRawEnergyEnvelope) {
        column =
          resolveRawTimelineColumn(rawTimelineColumnIndex) ??
          resolveRawColumnByTimeRange(
            rawData,
            rawFrames,
            rawRate,
            rawStartSec,
            startTime,
            endTime,
            maxSamplesPerPixel,
            rawPeaksOnly,
            shouldUseRawEnergyEnvelope,
            safeWaveformGain
          )
      } else {
        column = resolveRawColumnByTimeRange(
          rawData,
          rawFrames,
          rawRate,
          rawStartSec,
          startTime,
          endTime,
          maxSamplesPerPixel,
          rawPeaksOnly,
          shouldUseRawEnergyEnvelope,
          safeWaveformGain
        )
      }
      setRawColumn(x, column)
      continue
    }

    if (mixxxIsPlaceholder) continue

    const applyFrame = (i: number) => {
      const lowTop = low.left[i]
      const lowBottom = low.right[i]
      const midTop = mid.left[i]
      const midBottom = mid.right[i]
      const highTop = high.left[i]
      const highBottom = high.right[i]

      if (lowTop > maxLow) maxLow = lowTop
      if (lowBottom > maxLow) maxLow = lowBottom
      if (midTop > maxMid) maxMid = midTop
      if (midBottom > maxMid) maxMid = midBottom
      if (highTop > maxHigh) maxHigh = highTop
      if (highBottom > maxHigh) maxHigh = highBottom

      const lowTopPeak = low.peakLeft ? low.peakLeft[i] : lowTop
      const lowBottomPeak = low.peakRight ? low.peakRight[i] : lowBottom
      const midTopPeak = mid.peakLeft ? mid.peakLeft[i] : midTop
      const midBottomPeak = mid.peakRight ? mid.peakRight[i] : midBottom
      const highTopPeak = high.peakLeft ? high.peakLeft[i] : highTop
      const highBottomPeak = high.peakRight ? high.peakRight[i] : highBottom

      const allTop = lowTopPeak * lowTopPeak + midTopPeak * midTopPeak + highTopPeak * highTopPeak
      const allBottom =
        lowBottomPeak * lowBottomPeak +
        midBottomPeak * midBottomPeak +
        highBottomPeak * highBottomPeak
      if (allTop > maxAllTop) maxAllTop = allTop
      if (allBottom > maxAllBottom) maxAllBottom = allBottom
    }
    let lastFrame = startFrame
    for (let i = startFrame; i <= endFrame; i += step) {
      applyFrame(i)
      lastFrame = i
    }
    if (lastFrame !== endFrame) {
      applyFrame(endFrame)
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
    const ampTop = Math.min(1, Math.sqrt(maxAllTop) / MIXXX_MAX_RGB_ENERGY)
    const ampBottom = Math.min(1, Math.sqrt(maxAllBottom) / MIXXX_MAX_RGB_ENERGY)
    // 只要有非零幅度就必须渲染；配色解析不出来时退回保底色，而不是整列留白。
    if (ampTop <= 0 && ampBottom <= 0) continue

    const maxColor = Math.max(red, green, blue)
    columns[x] = {
      ampTop: clamp(ampTop * safeWaveformGain, 0, 1),
      ampBottom: clamp(ampBottom * safeWaveformGain, 0, 1),
      color:
        maxColor > 0
          ? resolveSaturatedWaveformColor({
              r: toColorChannel((red / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
              g: toColorChannel((green / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
              b: toColorChannel((blue / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE)
            })
          : RAW_PEAKS_ONLY_FALLBACK_COLOR
    }
  }

  return columns
}

const resolveColumnRect = (
  height: number,
  centerY: number,
  ampScale: number,
  waveformLayout: WaveformLayout,
  ampTop: number,
  ampBottom: number,
  minimumVisibleHeight = 1
) => {
  const resolveVisibleHeight = (amplitude: number) =>
    amplitude > 0 ? Math.max(minimumVisibleHeight, Math.round(amplitude * ampScale)) : 0
  const topHeight = resolveVisibleHeight(ampTop)
  const bottomHeight = resolveVisibleHeight(ampBottom)
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

const drawWaveformColumns = (
  ctx: WaveformCanvasContext,
  width: number,
  height: number,
  columns: WaveformColumn[],
  options?: {
    showDetailHighlights?: boolean
    showCenterLine?: boolean
    palette?: WaveformPalette
    waveformLayout?: WaveformLayout
    nativeRekordboxWaveform?: boolean
  }
) => {
  const centerY = Math.round(height / 2)
  const showDetailHighlights = options?.showDetailHighlights !== false
  const showCenterLine = options?.showCenterLine !== false
  const palette = options?.palette || DARK_WAVEFORM_PALETTE
  const waveformLayout = options?.waveformLayout || 'full'
  // PWV5 的低档位（1/31、2/31）在 1px 时会被随后绘制的中心线遮住，视觉上像空白。
  // 仅对原生 Rekordbox 非零列保留 2px 像素下限；不改 ANLZ 数值，也不套 FRKB 包络。
  const minimumVisibleHeight = options?.nativeRekordboxWaveform ? 2 : 1
  const ampScale =
    waveformLayout === 'full'
      ? Math.max(1, centerY - 2)
      : Math.max(1, Math.floor((height - 2) * HALF_WAVEFORM_AMPLITUDE_RATIO))
  ctx.imageSmoothingEnabled = false

  for (let x = 0; x < width; x += 1) {
    const column = columns[x]
    if (!column) continue
    const ampTop = column.ampTop
    const ampBottom = column.ampBottom
    const rect = resolveColumnRect(
      height,
      centerY,
      ampScale,
      waveformLayout,
      ampTop,
      ampBottom,
      minimumVisibleHeight
    )
    if (column.rekordboxTriBand) {
      const drawBand = (amp: number, color: string) => {
        if (amp <= 0) return
        const bandRect = resolveColumnRect(
          height,
          centerY,
          ampScale,
          waveformLayout,
          amp,
          amp,
          minimumVisibleHeight
        )
        ctx.fillStyle = color
        ctx.fillRect(x, bandRect.y, 1, bandRect.h)
      }
      drawBand(column.rekordboxTriBand.low, REKORDBOX_TRI_BAND_COLORS.low)
      drawBand(column.rekordboxTriBand.mid, REKORDBOX_TRI_BAND_COLORS.mid)
      drawBand(column.rekordboxTriBand.high, REKORDBOX_TRI_BAND_COLORS.high)
      continue
    }
    ctx.fillStyle = `rgb(${column.color.r}, ${column.color.g}, ${column.color.b})`
    ctx.fillRect(x, rect.y, 1, rect.h)

    if (showDetailHighlights) {
      const topHighlight = Math.max(0, rect.y)
      const bottomHighlight = Math.min(height - 1, rect.y + rect.h - 1)
      ctx.fillStyle = `rgba(${palette.detailHighlightBase}, ${
        0.14 + Math.max(ampTop, ampBottom) * 0.3
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
  }

  if (showCenterLine && waveformLayout === 'full') {
    ctx.fillStyle = palette.centerLine
    ctx.fillRect(0, centerY, width, 1)
  }
}

export const drawRgbWaveform = (ctx: WaveformCanvasContext, options: DrawWaveformOptions) => {
  const {
    width,
    height,
    rangeStartSec,
    rangeDurationSec,
    mixxxData,
    rawData,
    showBackground,
    maxSamplesPerPixel,
    showDetailHighlights,
    showCenterLine,
    waveformLayout,
    waveformRenderStyle,
    themeVariant,
    timeBasisOffsetMs,
    preferRawPeaksOnly,
    smoothColumns,
    waveformGain
  } = options
  if (width <= 0 || height <= 0) return false
  const palette = resolveWaveformPalette(ctx, themeVariant)
  const resolvedWaveformLayout = waveformLayout || 'full'

  if (showBackground !== false) {
    drawBackground(ctx, width, height, palette)
  }

  if (!isValidMixxxWaveformData(mixxxData)) return false
  const columns = buildWaveformColumns(
    width,
    mixxxData,
    rawData || null,
    rangeStartSec,
    rangeDurationSec,
    maxSamplesPerPixel,
    timeBasisOffsetMs,
    preferRawPeaksOnly,
    smoothColumns,
    waveformRenderStyle === 'columns',
    waveformGain
  )
  const hasColumns = columns.some(Boolean)

  if (
    waveformRenderStyle === 'raw-curve' &&
    drawRawCurveWaveform({
      ctx,
      width,
      height,
      columns,
      rawData: rawData || null,
      rangeStartSec,
      rangeDurationSec,
      maxSamplesPerPixel,
      timeBasisOffsetMs,
      waveformLayout: resolvedWaveformLayout,
      waveformGain: normalizeWaveformGain(waveformGain)
    })
  ) {
    return true
  }

  if (!hasColumns) return false

  drawWaveformColumns(ctx, width, height, columns, {
    showDetailHighlights,
    showCenterLine,
    palette,
    waveformLayout: resolvedWaveformLayout,
    nativeRekordboxWaveform: isNativeRekordboxWaveform(rawData || null)
  })

  return true
}
