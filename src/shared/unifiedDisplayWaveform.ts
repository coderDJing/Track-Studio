import { buildRawWaveformColorProfile, type RawWaveformColorSource } from './rawWaveformColor'

export const UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION = 1
export const UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION = 3
export const UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE = 1200
const UNIFIED_DISPLAY_WAVEFORM_OVERVIEW_RATE = 32
const UNIFIED_DISPLAY_WAVEFORM_BODY_RATE_DIVISOR = 4

export type UnifiedDisplayWaveformDetailData = {
  version: number
  parameterVersion: number
  duration: number
  sampleRate: number
  detailRate: number
  overviewRate: number
  bodyRateDivisor: number
  height: Uint8Array
  attack: Uint8Array
  colorIndex: Uint8Array
  colorLow: Uint8Array
  colorMid: Uint8Array
  colorHigh: Uint8Array
  colorRed: Uint8Array
  colorGreen: Uint8Array
  colorBlue: Uint8Array
  body: Uint8Array
  overviewHeight: Uint8Array
}

type UnifiedDisplayWaveformBuildSourceBand = {
  left: Uint8Array
  right: Uint8Array
  peakLeft?: Uint8Array
  peakRight?: Uint8Array
}

type UnifiedDisplayWaveformBuildSource = {
  duration: number
  sampleRate: number
  bands: {
    all: UnifiedDisplayWaveformBuildSourceBand
  }
}

type PersistedMixxxWaveformBuildSource = UnifiedDisplayWaveformBuildSource & {
  bands: UnifiedDisplayWaveformBuildSource['bands'] & {
    low: UnifiedDisplayWaveformBuildSourceBand
    mid: UnifiedDisplayWaveformBuildSourceBand
    high: UnifiedDisplayWaveformBuildSourceBand
  }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const toByte = (value: number) => clamp(Math.round(value), 0, 255)

const resolveFrame = (sourceFrames: number, targetIndex: number, targetFrames: number) => {
  if (sourceFrames <= 1 || targetFrames <= 1) return 0
  return clamp(Math.floor((targetIndex / targetFrames) * sourceFrames), 0, sourceFrames - 1)
}

const resolveBandPeak = (
  band: UnifiedDisplayWaveformBuildSourceBand,
  frame: number,
  side: 'left' | 'right'
) => {
  const body = side === 'left' ? band.left[frame] : band.right[frame]
  const peak = side === 'left' ? band.peakLeft?.[frame] : band.peakRight?.[frame]
  return Math.max(Number(body) || 0, Number(peak) || 0)
}

const resolveAttackByte = (height: number, previousHeight: number, previousSmooth: number) => {
  const directRise = Math.max(0, height - previousHeight)
  const smoothRise = Math.max(0, height - previousSmooth)
  return toByte(directRise * 1.35 + smoothRise * 1.8)
}

export const buildUnifiedDisplayWaveformDetailFromMixxx = (
  source: UnifiedDisplayWaveformBuildSource,
  rawColorSource: RawWaveformColorSource
): UnifiedDisplayWaveformDetailData | null => {
  const duration = Math.max(0, Number(source?.duration) || 0)
  const sampleRate = Math.max(0, Number(source?.sampleRate) || 0)
  const sourceFrames = Math.min(
    source?.bands?.all?.left?.length || 0,
    source?.bands?.all?.right?.length || 0
  )
  if (!duration || !sampleRate || sourceFrames <= 0) return null

  const detailRate = UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE
  const detailFrames = Math.max(1, Math.ceil(duration * detailRate))
  const overviewFrames = Math.max(1, Math.ceil(duration * UNIFIED_DISPLAY_WAVEFORM_OVERVIEW_RATE))
  const height = new Uint8Array(detailFrames)
  const attack = new Uint8Array(detailFrames)
  const body = new Uint8Array(
    Math.max(1, Math.ceil(detailFrames / UNIFIED_DISPLAY_WAVEFORM_BODY_RATE_DIVISOR))
  )
  const overviewHeight = new Uint8Array(overviewFrames)
  const colorProfile = buildRawWaveformColorProfile(rawColorSource, detailFrames, detailRate, 1)
  const colorIndex = colorProfile?.colorIndex?.length
    ? colorProfile.colorIndex
    : new Uint8Array(detailFrames).fill(3)
  const colorLow = colorProfile?.colorLow?.length
    ? colorProfile.colorLow
    : new Uint8Array(detailFrames)
  const colorMid = colorProfile?.colorMid?.length
    ? colorProfile.colorMid
    : new Uint8Array(detailFrames)
  const colorHigh = colorProfile?.colorHigh?.length
    ? colorProfile.colorHigh
    : new Uint8Array(detailFrames)
  const colorRed = colorProfile?.colorRed?.length
    ? colorProfile.colorRed
    : new Uint8Array(detailFrames).fill(235)
  const colorGreen = colorProfile?.colorGreen?.length
    ? colorProfile.colorGreen
    : new Uint8Array(detailFrames).fill(242)
  const colorBlue = colorProfile?.colorBlue?.length
    ? colorProfile.colorBlue
    : new Uint8Array(detailFrames).fill(248)

  let previousHeight = 0
  let previousSmooth = 0
  for (let index = 0; index < detailFrames; index += 1) {
    const sourceFrame = resolveFrame(sourceFrames, index, detailFrames)
    const peak = Math.max(
      resolveBandPeak(source.bands.all, sourceFrame, 'left'),
      resolveBandPeak(source.bands.all, sourceFrame, 'right')
    )
    const currentHeight = toByte(peak)
    height[index] = currentHeight
    attack[index] = resolveAttackByte(currentHeight, previousHeight, previousSmooth)
    previousSmooth = previousSmooth * 0.82 + currentHeight * 0.18
    previousHeight = currentHeight
  }

  for (let index = 0; index < body.length; index += 1) {
    const start = index * UNIFIED_DISPLAY_WAVEFORM_BODY_RATE_DIVISOR
    const end = Math.min(detailFrames, start + UNIFIED_DISPLAY_WAVEFORM_BODY_RATE_DIVISOR)
    let peak = 0
    let sum = 0
    for (let frame = start; frame < end; frame += 1) {
      const value = height[frame] || 0
      peak = Math.max(peak, value)
      sum += value
    }
    const mean = sum / Math.max(1, end - start)
    body[index] = toByte(mean * 0.7 + peak * 0.3)
  }

  for (let index = 0; index < overviewFrames; index += 1) {
    const start = Math.floor((index / overviewFrames) * detailFrames)
    const end = Math.max(start + 1, Math.ceil(((index + 1) / overviewFrames) * detailFrames))
    let peak = 0
    for (let frame = start; frame < Math.min(detailFrames, end); frame += 1) {
      peak = Math.max(peak, height[frame] || 0)
    }
    overviewHeight[index] = peak
  }

  return {
    version: UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
    parameterVersion: UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION,
    duration,
    sampleRate,
    detailRate,
    overviewRate: UNIFIED_DISPLAY_WAVEFORM_OVERVIEW_RATE,
    bodyRateDivisor: UNIFIED_DISPLAY_WAVEFORM_BODY_RATE_DIVISOR,
    height,
    attack,
    colorIndex,
    colorLow,
    colorMid,
    colorHigh,
    colorRed,
    colorGreen,
    colorBlue,
    body,
    overviewHeight
  }
}

/**
 * Rehydrates the unified detail waveform from the persisted Mixxx RGB bands.
 * External-library analysis intentionally stores the compact Mixxx waveform in
 * SQLite; this recreates the display payload without decoding the audio again.
 */
export const buildUnifiedDisplayWaveformDetailFromPersistedMixxx = (
  source: PersistedMixxxWaveformBuildSource
): UnifiedDisplayWaveformDetailData | null => {
  const empty = new Float32Array(0)
  const detail = buildUnifiedDisplayWaveformDetailFromMixxx(source, {
    rate: 1,
    frames: 0,
    loadedFrames: 0,
    minLeft: empty,
    maxLeft: empty,
    minRight: empty,
    maxRight: empty
  })
  if (!detail) return null

  const sourceFrames = Math.min(
    source.bands.low.left.length,
    source.bands.low.right.length,
    source.bands.mid.left.length,
    source.bands.mid.right.length,
    source.bands.high.left.length,
    source.bands.high.right.length
  )
  if (!sourceFrames) return detail

  const readBandPeak = (band: UnifiedDisplayWaveformBuildSourceBand, frame: number) =>
    Math.max(resolveBandPeak(band, frame, 'left'), resolveBandPeak(band, frame, 'right'))

  for (let index = 0; index < detail.height.length; index += 1) {
    const sourceFrame = resolveFrame(sourceFrames, index, detail.height.length)
    const low = readBandPeak(source.bands.low, sourceFrame)
    const mid = readBandPeak(source.bands.mid, sourceFrame)
    const high = readBandPeak(source.bands.high, sourceFrame)
    const peak = Math.max(low, mid, high)
    if (peak <= 0) continue
    const lowRatio = low / peak
    const midRatio = mid / peak
    const highRatio = high / peak
    detail.colorIndex[index] = low >= mid && low >= high ? 0 : mid >= high ? 1 : 2
    detail.colorLow[index] = toByte(lowRatio * 255)
    detail.colorMid[index] = toByte(midRatio * 255)
    detail.colorHigh[index] = toByte(highRatio * 255)
    detail.colorRed[index] = toByte(lowRatio * 255 * 0.95)
    detail.colorGreen[index] = toByte(midRatio * 255 * 0.95)
    detail.colorBlue[index] = toByte(highRatio * 255 * 0.95)
  }

  return detail
}
