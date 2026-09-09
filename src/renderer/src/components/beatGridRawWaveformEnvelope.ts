import type { RawWaveformData } from '@renderer/composables/mixtape/types'

type RawWaveformAmps = {
  ampTop: number
  ampBottom: number
}

type RawEnergyProfile = RawWaveformAmps & {
  base: number
  peak: number
  samplePeak: number
  hasSignal: boolean
  shape: RawEnergyShapeParams
}

export type RawEnergyShapeParams = {
  peakBlendWeight: number
  outputGamma: number
  attackWeight: number
}

// Raw buffers are normalized PCM amplitudes; 1.0 is the fixed 0 dBFS visual reference.
const RAW_ENERGY_FIXED_REFERENCE_AMPLITUDE = 1
const RAW_ENERGY_FIXED_VISUAL_GAIN = 1
const RAW_ENERGY_PEAK_BLEND_WEIGHT = 0.55
const RAW_ENERGY_OUTPUT_GAMMA = 1.74
const RAW_ENERGY_GATE = 0.02
// 只有所有采样都严格为零才算真正的数字静音，允许渲染成空白。
// 任何非零 PCM（包括极弱的残响、噪声底和衰减尾音）都必须保留最小可见波形。
const RAW_ENERGY_SILENCE_SAMPLE_PEAK = 0
// 有信号但整形后被门限压掉时，保底渲染的“细线”幅度，保证弱音段落仍然可见。
export const RAW_ENERGY_PRESENCE_FLOOR_AMP = 0.012
const RAW_ENERGY_ATTACK_WEIGHT = 0.78
const RAW_ENERGY_ATTACK_RISE = 0.105
const RAW_ENERGY_FULL_TRACK_START_SEC = 20
const RAW_ENERGY_FULL_TRACK_TARGET_SEC = 45
const RAW_ENERGY_FULL_TRACK_PEAK_BLEND_WEIGHT = 1
const RAW_ENERGY_FULL_TRACK_OUTPUT_GAMMA = 1.5
const RAW_ENERGY_FULL_TRACK_ATTACK_WEIGHT = 0

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const lerp = (start: number, end: number, ratio: number) => start + (end - start) * ratio
const normalizeWaveformGain = (value?: number) => {
  if (typeof value === 'undefined') return 1
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return clamp(numeric, 0, 16)
}

const resolveLoadedFrames = (rawData: RawWaveformData) =>
  Math.max(
    0,
    Math.min(
      Math.floor(Number(rawData.loadedFrames ?? rawData.frames) || 0),
      Math.floor(Number(rawData.frames) || 0),
      rawData.minLeft.length,
      rawData.maxLeft.length,
      rawData.minRight.length,
      rawData.maxRight.length
    )
  )

const resolveFrameEnergy = (rawData: RawWaveformData, frame: number) => {
  const rmsLeft = rawData.rmsLeft?.[frame]
  const rmsRight = rawData.rmsRight?.[frame]
  if (
    typeof rmsLeft === 'number' &&
    typeof rmsRight === 'number' &&
    Number.isFinite(rmsLeft) &&
    Number.isFinite(rmsRight)
  ) {
    const rms = Math.sqrt((rmsLeft * rmsLeft + rmsRight * rmsRight) / 2)
    // RMS 为 0 但峰值非零时不能当成静音，否则弱信号会被整列丢弃。
    if (rms > 0) return rms
  }

  const minLeft = rawData.minLeft[frame] || 0
  const maxLeft = rawData.maxLeft[frame] || 0
  const minRight = rawData.minRight[frame] || 0
  const maxRight = rawData.maxRight[frame] || 0
  return Math.sqrt(
    (minLeft * minLeft + maxLeft * maxLeft + minRight * minRight + maxRight * maxRight) / 4
  )
}

export const resolveRawEnergyShapeParamsByDuration = (
  durationSec: number
): RawEnergyShapeParams => {
  const fullTrackRatio = clamp(
    (durationSec - RAW_ENERGY_FULL_TRACK_START_SEC) /
      (RAW_ENERGY_FULL_TRACK_TARGET_SEC - RAW_ENERGY_FULL_TRACK_START_SEC),
    0,
    1
  )
  return {
    peakBlendWeight: lerp(
      RAW_ENERGY_PEAK_BLEND_WEIGHT,
      RAW_ENERGY_FULL_TRACK_PEAK_BLEND_WEIGHT,
      fullTrackRatio
    ),
    outputGamma: lerp(RAW_ENERGY_OUTPUT_GAMMA, RAW_ENERGY_FULL_TRACK_OUTPUT_GAMMA, fullTrackRatio),
    attackWeight: lerp(
      RAW_ENERGY_ATTACK_WEIGHT,
      RAW_ENERGY_FULL_TRACK_ATTACK_WEIGHT,
      fullTrackRatio
    )
  }
}

const resolveRawEnergyShapeParams = (rawData: RawWaveformData): RawEnergyShapeParams => {
  const loadedFrames = resolveLoadedFrames(rawData)
  const rate = Number(rawData.rate) || 0
  const rawDurationSec = Number(rawData.duration)
  const durationSec =
    Number.isFinite(rawDurationSec) && rawDurationSec > 0
      ? rawDurationSec
      : rate > 0
        ? loadedFrames / rate
        : 0
  return resolveRawEnergyShapeParamsByDuration(durationSec)
}

/**
 * 把归一化能量映射成可视幅度。
 *
 * `presenceFloorAmp` 用于“弱信号保底”：非静音片段即使被噪声门限压掉，也要退回到该幅度渲染一条细线，
 * 只有真正的数字静音（由调用方判定后传入 0）才允许返回 0 并留白。
 */
export const shapeRawEnergyAmpValue = (
  value: number,
  outputGamma = RAW_ENERGY_OUTPUT_GAMMA,
  presenceFloorAmp = 0
) => {
  if (!(value > 0)) return 0
  const amp = Math.pow(clamp(value, 0, 1), outputGamma)
  if (amp >= RAW_ENERGY_GATE) return amp
  return presenceFloorAmp > 0 ? presenceFloorAmp : 0
}

export const hasRawEnergySignal = (samplePeak: number) =>
  Number.isFinite(samplePeak) && samplePeak > RAW_ENERGY_SILENCE_SAMPLE_PEAK

export const resolveRawEnergyAttackAmp = (
  base: number | undefined,
  peak: number | undefined,
  previousBase: number | undefined,
  shapeParams?: RawEnergyShapeParams
) => {
  if (
    typeof base !== 'number' ||
    typeof peak !== 'number' ||
    typeof previousBase !== 'number' ||
    base - previousBase < RAW_ENERGY_ATTACK_RISE ||
    peak <= base
  ) {
    return null
  }
  const attackWeight = shapeParams?.attackWeight ?? RAW_ENERGY_ATTACK_WEIGHT
  return shapeRawEnergyAmpValue(
    base * (1 - attackWeight) + peak * attackWeight,
    shapeParams?.outputGamma,
    peak > 0 ? RAW_ENERGY_PRESENCE_FLOOR_AMP : 0
  )
}

export const resolveRawEnergyProfileByRange = (
  rawData: RawWaveformData,
  startFrame: number,
  endFrame: number,
  maxSamplesPerPixel?: number,
  waveformGain?: number
): RawEnergyProfile => {
  const span = endFrame - startFrame + 1
  const sampleCap = Number(maxSamplesPerPixel)
  const step =
    Number.isFinite(sampleCap) && sampleCap > 0
      ? Math.max(1, Math.floor(span / Math.max(1, Math.floor(sampleCap))))
      : 1
  let sum = 0
  let peak = 0
  let samplePeak = 0
  let count = 0
  let lastFrame = startFrame
  const addFrame = (frame: number) => {
    const energy = resolveFrameEnergy(rawData, frame)
    sum += energy
    if (energy > peak) peak = energy
    const frameSamplePeak = Math.max(
      Math.abs(rawData.minLeft[frame] || 0),
      Math.abs(rawData.maxLeft[frame] || 0),
      Math.abs(rawData.minRight[frame] || 0),
      Math.abs(rawData.maxRight[frame] || 0)
    )
    if (frameSamplePeak > samplePeak) samplePeak = frameSamplePeak
    count += 1
  }
  for (let frame = startFrame; frame <= endFrame; frame += step) {
    addFrame(frame)
    lastFrame = frame
  }
  if (lastFrame !== endFrame) addFrame(endFrame)

  const scale =
    RAW_ENERGY_FIXED_REFERENCE_AMPLITUDE /
    Math.max(0.000001, RAW_ENERGY_FIXED_VISUAL_GAIN * normalizeWaveformGain(waveformGain))
  const shapeParams = resolveRawEnergyShapeParams(rawData)
  const mean = count > 0 ? clamp(sum / count / scale, 0, 1) : 0
  const normalizedPeak = clamp(peak / scale, 0, 1)
  const base =
    mean * (1 - shapeParams.peakBlendWeight) + normalizedPeak * shapeParams.peakBlendWeight
  const hasSignal = hasRawEnergySignal(samplePeak / scale)
  const amp = shapeRawEnergyAmpValue(
    base,
    shapeParams.outputGamma,
    hasSignal ? RAW_ENERGY_PRESENCE_FLOOR_AMP : 0
  )
  return {
    ampTop: amp,
    ampBottom: amp,
    base,
    peak: normalizedPeak,
    samplePeak: clamp(samplePeak / scale, 0, 1),
    hasSignal,
    shape: shapeParams
  }
}
