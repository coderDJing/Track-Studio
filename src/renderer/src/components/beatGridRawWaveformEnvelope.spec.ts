import { describe, expect, it } from 'vitest'
import {
  RAW_ENERGY_PRESENCE_FLOOR_AMP,
  resolveRawEnergyProfileByRange,
  shapeRawEnergyAmpValue
} from '@renderer/components/beatGridRawWaveformEnvelope'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'

const FRAME_COUNT = 64
const RAW_RATE = 2400

const createRawWaveformData = (peak: number, rms: number): RawWaveformData => {
  const fill = (value: number) => Float32Array.from(new Array(FRAME_COUNT).fill(value))
  const min = fill(-peak)
  const max = fill(peak)
  return {
    startSec: 0,
    duration: FRAME_COUNT / RAW_RATE,
    sampleRate: 48000,
    rate: RAW_RATE,
    frames: FRAME_COUNT,
    loadedFrames: FRAME_COUNT,
    minLeft: min,
    maxLeft: max,
    minRight: min,
    maxRight: max,
    meanLeft: fill(0),
    meanRight: fill(0),
    rmsLeft: fill(rms),
    rmsRight: fill(rms)
  } as unknown as RawWaveformData
}

describe('resolveRawEnergyProfileByRange', () => {
  it('弱信号即使被噪声门限压掉，也要保底返回细线幅度', () => {
    const profile = resolveRawEnergyProfileByRange(createRawWaveformData(0.05, 0.02), 0, 7)
    expect(profile.hasSignal).toBe(true)
    expect(profile.ampTop).toBe(RAW_ENERGY_PRESENCE_FLOOR_AMP)
    expect(profile.ampBottom).toBe(RAW_ENERGY_PRESENCE_FLOOR_AMP)
  })

  it('强信号仍然走正常包络，不会被保底幅度拉平', () => {
    const profile = resolveRawEnergyProfileByRange(createRawWaveformData(0.9, 0.5), 0, 7)
    expect(profile.ampTop).toBeGreaterThan(RAW_ENERGY_PRESENCE_FLOOR_AMP)
  })

  it('真正的数字静音仍然渲染为空白', () => {
    const profile = resolveRawEnergyProfileByRange(createRawWaveformData(0, 0), 0, 7)
    expect(profile.hasSignal).toBe(false)
    expect(profile.ampTop).toBe(0)
    expect(profile.ampBottom).toBe(0)
  })

  it('保底幅度为 0 时维持原有的门限行为', () => {
    expect(shapeRawEnergyAmpValue(0.02, 1.74)).toBe(0)
    expect(shapeRawEnergyAmpValue(0.02, 1.74, RAW_ENERGY_PRESENCE_FLOOR_AMP)).toBe(
      RAW_ENERGY_PRESENCE_FLOOR_AMP
    )
    expect(shapeRawEnergyAmpValue(0, 1.74, RAW_ENERGY_PRESENCE_FLOOR_AMP)).toBe(0)
  })
})
