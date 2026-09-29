import { describe, expect, it } from 'vitest'
import { resolveHorizontalBrowseWaveformTimeScale } from './horizontalBrowseWaveformTimeScale'

describe('双轨大波形节拍标尺', () => {
  const pixelsPerSecond = (bpm: number, playbackRate: number) =>
    playbackRate / resolveHorizontalBrowseWaveformTimeScale(bpm)

  it('未同步的两轨按各自 BPM 以不同像素速度滚动', () => {
    expect(pixelsPerSecond(150, 1) / pixelsPerSecond(120, 1)).toBeCloseTo(1.25)
  })

  it('变速到相同实际 BPM 后两轨以相同像素速度滚动', () => {
    expect(pixelsPerSecond(150, 120 / 150)).toBeCloseTo(pixelsPerSecond(120, 1))
  })

  it('无有效 BPM 时保留普通时间标尺', () => {
    expect(resolveHorizontalBrowseWaveformTimeScale(0)).toBe(1)
    expect(resolveHorizontalBrowseWaveformTimeScale(Number.NaN)).toBe(1)
  })
})
