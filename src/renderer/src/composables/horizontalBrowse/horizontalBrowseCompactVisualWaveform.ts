import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { UnifiedDisplayWaveformDetailData } from '@shared/unifiedDisplayWaveform'
import {
  normalizeWaveformSurfaceData,
  type WaveformGlobalOverviewData
} from '@shared/waveformSurfaceCache'

type UnifiedDisplayWaveformLoadResponse = {
  status?: 'ready' | 'missing'
  data?: UnifiedDisplayWaveformDetailData | null
}

type WaveformGlobalOverviewLoadResponse = {
  status?: 'ready' | 'missing'
  data?: WaveformGlobalOverviewData | null
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const WAVEFORM_TRACE_TWO_PI = Math.PI * 2
const WAVEFORM_TRACE_ATTACK_LOCK_PHASE = Math.PI * 0.5
const WAVEFORM_TRACE_ATTACK_LOCK_THRESHOLD = 0.16
const WAVEFORM_TRACE_ATTACK_LOCK_MIN_AMPLITUDE = 0.08
const WAVEFORM_TRACE_ATTACK_LOCK_MIN_RISE = 0.05
const WAVEFORM_TRACE_ATTACK_LOCK_COOLDOWN_SEC = 0.012

const toUint8Array = (value: unknown) => {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  return new Uint8Array(0)
}

const resolveColorFrequency = (colorIndex: number, rate: number) => {
  const nyquistLimit = Math.max(8, rate * 0.45)
  if (colorIndex === 0) return Math.min(72, nyquistLimit)
  if (colorIndex === 1) return Math.min(176, nyquistLimit)
  if (colorIndex === 2) return Math.min(280, nyquistLimit)
  return Math.min(120, nyquistLimit)
}

const readClampedByte = (values: Uint8Array, index: number, fallback: number) => {
  if (!values.length) return fallback
  return values[clamp(Math.floor(index), 0, values.length - 1)] ?? fallback
}

const writeBalancedSignedTrace = (
  meanLeft: Float32Array,
  meanRight: Float32Array,
  amplitudes: Float32Array,
  colors: Uint8Array,
  rate: number,
  attacks?: Float32Array
) => {
  const frames = Math.min(meanLeft.length, meanRight.length, amplitudes.length, colors.length)
  const phases = new Float32Array(frames)
  const cycleIndexes = new Uint32Array(frames)
  const cycleAmplitudes: number[] = []
  const cyclePositivePeaks: number[] = []
  const cycleNegativePeaks: number[] = []
  let phase = 0
  let cycleIndex = 0
  const safeRate = Math.max(1, Number(rate) || 1)
  const lockCooldownFrames = Math.max(
    2,
    Math.round(safeRate * WAVEFORM_TRACE_ATTACK_LOCK_COOLDOWN_SEC)
  )
  let lastPhaseLockFrame = -lockCooldownFrames
  let previousAmplitude = 0
  let previousAttack = 0
  for (let index = 0; index < frames; index += 1) {
    const amplitude = clamp(amplitudes[index] || 0, 0, 1)
    const attack = attacks ? clamp(attacks[index] || 0, 0, 1) : 0
    const attackRise = attack - previousAttack
    const amplitudeRise = amplitude - previousAmplitude
    const attackLeadingEdge =
      attack >= WAVEFORM_TRACE_ATTACK_LOCK_THRESHOLD &&
      (attackRise >= WAVEFORM_TRACE_ATTACK_LOCK_MIN_RISE ||
        (previousAttack < WAVEFORM_TRACE_ATTACK_LOCK_THRESHOLD * 0.65 &&
          attack >= WAVEFORM_TRACE_ATTACK_LOCK_THRESHOLD * 1.5))
    const strongAmplitudeRise =
      attack >= WAVEFORM_TRACE_ATTACK_LOCK_THRESHOLD * 0.5 &&
      amplitudeRise >= WAVEFORM_TRACE_ATTACK_LOCK_MIN_RISE
    if (
      amplitude >= WAVEFORM_TRACE_ATTACK_LOCK_MIN_AMPLITUDE &&
      index - lastPhaseLockFrame >= lockCooldownFrames &&
      (attackLeadingEdge || strongAmplitudeRise)
    ) {
      if (index > 0) cycleIndex += 1
      phase = WAVEFORM_TRACE_ATTACK_LOCK_PHASE
      lastPhaseLockFrame = index
    }

    phases[index] = phase
    cycleIndexes[index] = cycleIndex
    cycleAmplitudes[cycleIndex] = Math.max(cycleAmplitudes[cycleIndex] || 0, amplitude)
    const frequency = resolveColorFrequency(colors[index] || 3, safeRate)
    const nextPhase = phase + (WAVEFORM_TRACE_TWO_PI * frequency) / safeRate
    const completedCycles = Math.floor(nextPhase / WAVEFORM_TRACE_TWO_PI)
    if (completedCycles > 0) {
      cycleIndex += completedCycles
      phase = nextPhase - completedCycles * WAVEFORM_TRACE_TWO_PI
    } else {
      phase = nextPhase
    }
    previousAmplitude = amplitude
    previousAttack = attack
  }

  for (let index = 0; index < frames; index += 1) {
    const baseSample = Math.sin(phases[index])
    const cycle = cycleIndexes[index]
    if (baseSample >= 0) {
      cyclePositivePeaks[cycle] = Math.max(cyclePositivePeaks[cycle] || 0, baseSample)
    } else {
      cycleNegativePeaks[cycle] = Math.max(cycleNegativePeaks[cycle] || 0, -baseSample)
    }
  }

  for (let index = 0; index < frames; index += 1) {
    const cycle = cycleIndexes[index]
    const amplitude = cycleAmplitudes[cycle] || 0
    const baseSample = Math.sin(phases[index])
    const peak = baseSample >= 0 ? cyclePositivePeaks[cycle] || 0 : cycleNegativePeaks[cycle] || 0
    const waveformSample =
      peak > 0.000001 ? (baseSample / peak) * amplitude : baseSample * amplitude
    meanLeft[index] = waveformSample
    meanRight[index] = waveformSample
  }
}

export const normalizeUnifiedDisplayWaveformData = (
  value: unknown
): UnifiedDisplayWaveformDetailData | null => {
  const payload =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as UnifiedDisplayWaveformDetailData)
      : null
  if (!payload) return null
  const height = toUint8Array(payload.height)
  const attack = toUint8Array(payload.attack)
  const colorIndex = toUint8Array(payload.colorIndex)
  const colorLow = toUint8Array(payload.colorLow)
  const colorMid = toUint8Array(payload.colorMid)
  const colorHigh = toUint8Array(payload.colorHigh)
  const colorRed = toUint8Array(payload.colorRed)
  const colorGreen = toUint8Array(payload.colorGreen)
  const colorBlue = toUint8Array(payload.colorBlue)
  const body = toUint8Array(payload.body)
  const overviewHeight = toUint8Array(payload.overviewHeight)
  const frames = Math.min(
    height.length,
    attack.length,
    colorIndex.length,
    colorLow.length,
    colorMid.length,
    colorHigh.length,
    colorRed.length,
    colorGreen.length,
    colorBlue.length
  )
  const duration = Math.max(0, Number(payload.duration) || 0)
  const detailRate = Math.max(0, Number(payload.detailRate) || 0)
  const sampleRate = Math.max(0, Number(payload.sampleRate) || 0)
  if (!frames || !duration || !detailRate || !sampleRate || !body.length) return null
  return {
    version: Math.max(0, Number(payload.version) || 0),
    parameterVersion: Math.max(0, Number(payload.parameterVersion) || 0),
    duration,
    sampleRate,
    detailRate,
    overviewRate: Math.max(0, Number(payload.overviewRate) || 0),
    bodyRateDivisor: Math.max(1, Number(payload.bodyRateDivisor) || 1),
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

export const unifiedDisplayWaveformToRawData = (
  data: UnifiedDisplayWaveformDetailData
): RawWaveformData | null => {
  const normalized = normalizeUnifiedDisplayWaveformData(data)
  if (!normalized) return null
  const frames = Math.min(
    normalized.height.length,
    normalized.attack.length,
    normalized.colorIndex.length,
    normalized.colorLow.length,
    normalized.colorMid.length,
    normalized.colorHigh.length,
    normalized.colorRed.length,
    normalized.colorGreen.length,
    normalized.colorBlue.length
  )
  const minLeft = new Float32Array(frames)
  const maxLeft = new Float32Array(frames)
  const minRight = new Float32Array(frames)
  const maxRight = new Float32Array(frames)
  const meanLeft = new Float32Array(frames)
  const meanRight = new Float32Array(frames)
  const rmsLeft = new Float32Array(frames)
  const rmsRight = new Float32Array(frames)
  const traceAmplitudes = new Float32Array(frames)
  const traceAttacks = new Float32Array(frames)
  const traceColors = new Uint8Array(frames)
  const colorLow = new Uint8Array(frames)
  const colorMid = new Uint8Array(frames)
  const colorHigh = new Uint8Array(frames)
  const colorRed = new Uint8Array(frames)
  const colorGreen = new Uint8Array(frames)
  const colorBlue = new Uint8Array(frames)
  for (let index = 0; index < frames; index += 1) {
    const height = clamp((normalized.height[index] || 0) / 255, 0, 1)
    const attack = clamp((normalized.attack[index] || 0) / 255, 0, 1)
    const body = readClampedByte(
      normalized.body,
      Math.floor(index / normalized.bodyRateDivisor),
      Math.round(height * 255)
    )
    const color = readClampedByte(normalized.colorIndex, index, 3)
    const bodyAmp = clamp(body / 255, 0, 1)
    const rms = clamp(Math.max(bodyAmp, height * 0.42, attack * 0.72), 0, 1)
    minLeft[index] = -height
    maxLeft[index] = height
    minRight[index] = -height
    maxRight[index] = height
    rmsLeft[index] = rms
    rmsRight[index] = rms
    traceAmplitudes[index] = clamp(Math.max(bodyAmp * 0.86, height * 0.94, attack * 0.68), 0, 1)
    traceAttacks[index] = attack
    traceColors[index] = color
    colorLow[index] = readClampedByte(normalized.colorLow, index, 0)
    colorMid[index] = readClampedByte(normalized.colorMid, index, 0)
    colorHigh[index] = readClampedByte(normalized.colorHigh, index, 0)
    colorRed[index] = readClampedByte(normalized.colorRed, index, 235)
    colorGreen[index] = readClampedByte(normalized.colorGreen, index, 242)
    colorBlue[index] = readClampedByte(normalized.colorBlue, index, 248)
  }
  writeBalancedSignedTrace(
    meanLeft,
    meanRight,
    traceAmplitudes,
    traceColors,
    normalized.detailRate,
    traceAttacks
  )
  return {
    duration: normalized.duration,
    sampleRate: normalized.sampleRate,
    rate: normalized.detailRate,
    frames,
    startSec: 0,
    loadedFrames: frames,
    minLeft,
    maxLeft,
    minRight,
    maxRight,
    meanLeft,
    meanRight,
    rmsLeft,
    rmsRight,
    compactColorIndex: normalized.colorIndex,
    compactColorLow: colorLow,
    compactColorMid: colorMid,
    compactColorHigh: colorHigh,
    compactColorRed: colorRed,
    compactColorGreen: colorGreen,
    compactColorBlue: colorBlue,
    compactColorRateDivisor: 1,
    compactColorStartFrame: 0
  }
}

export const loadUnifiedDisplayWaveformData = async (
  filePath: string,
  listRoot?: string,
  manualOnly = false
): Promise<UnifiedDisplayWaveformDetailData | null> => {
  const response = (await window.electron.ipcRenderer.invoke(
    'unified-display-waveform-cache:load',
    {
      filePath,
      listRoot,
      manualOnly
    }
  )) as UnifiedDisplayWaveformLoadResponse | null
  if (response?.status !== 'ready') return null
  return normalizeUnifiedDisplayWaveformData(response.data)
}

export const loadWaveformGlobalOverviewData = async (
  filePath: string,
  listRoot?: string,
  manualOnly = false
): Promise<WaveformGlobalOverviewData | null> => {
  const response = (await window.electron.ipcRenderer.invoke(
    'waveform-global-overview-cache:load',
    {
      filePath,
      listRoot,
      manualOnly
    }
  )) as WaveformGlobalOverviewLoadResponse | null
  if (response?.status !== 'ready') return null
  return normalizeWaveformSurfaceData<WaveformGlobalOverviewData>(response.data, 'globalOverview')
}
