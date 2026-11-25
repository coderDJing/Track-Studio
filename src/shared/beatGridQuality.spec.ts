import { describe, expect, it } from 'vitest'
import {
  createSongBeatGridDegradedQuality,
  isSameSongBeatGridQuality,
  normalizeSongBeatGridQuality,
  resolveSongBeatGridDriftQuality,
  resolveSongBeatGridFixedDriftQuality,
  SONG_BEAT_GRID_FIXED_DRIFT_LIMIT_MS,
  SONG_BEAT_GRID_QUALITY_VERSION,
  SONG_BEAT_GRID_QUALITY_THRESHOLDS
} from './beatGridQuality'
import { analyzeDynamicBeatGridEvidence } from './dynamicBeatGridAnalysis'

const REJECT_THRESHOLDS = {
  p95ResidualMs: 15,
  maxResidualMs: 40,
  maxUnexplainedBeatRatio: 0.02
}

const segments = (values: readonly { clipIndex: number; p95: number; max: number }[]) =>
  values.map((value) => ({
    clipIndex: value.clipIndex,
    residualP95Ms: value.p95,
    residualMaxMs: value.max
  }))

describe('resolveSongBeatGridDriftQuality', () => {
  it('干净的网格不产生标记', () => {
    const quality = resolveSongBeatGridDriftQuality({
      unexplainedBeatRatio: 0,
      segments: segments([{ clipIndex: 0, p95: 1, max: 3 }]),
      rejectThresholds: REJECT_THRESHOLDS
    })
    expect(quality).toBeUndefined()
  })

  it('接近 reject 阈值时标出最靠前的那一段', () => {
    const p95Limit =
      REJECT_THRESHOLDS.p95ResidualMs * SONG_BEAT_GRID_QUALITY_THRESHOLDS.residualP95Ratio
    const quality = resolveSongBeatGridDriftQuality({
      unexplainedBeatRatio: 0,
      segments: segments([
        { clipIndex: 0, p95: p95Limit - 0.001, max: 1 },
        { clipIndex: 3, p95: p95Limit + 0.5, max: 1 },
        { clipIndex: 7, p95: p95Limit + 4, max: 1 }
      ]),
      rejectThresholds: REJECT_THRESHOLDS
    })
    expect(quality?.status).toBe('unsure')
    expect(quality?.reason).toBe('drift')
    // 取最靠前漂移的那段，而不是残差最大的那段。
    expect(quality?.clipIndex).toBe(3)
  })

  it('第一段就漂时不带 clipIndex，表示整曲都值得复查', () => {
    const p95Limit =
      REJECT_THRESHOLDS.p95ResidualMs * SONG_BEAT_GRID_QUALITY_THRESHOLDS.residualP95Ratio
    const quality = resolveSongBeatGridDriftQuality({
      unexplainedBeatRatio: 0,
      segments: segments([{ clipIndex: 0, p95: p95Limit + 1, max: 1 }]),
      rejectThresholds: REJECT_THRESHOLDS
    })
    expect(quality?.clipIndex).toBeUndefined()
  })

  it('无法解释的拍点占比偏高时也标出来', () => {
    const limit =
      REJECT_THRESHOLDS.maxUnexplainedBeatRatio * SONG_BEAT_GRID_QUALITY_THRESHOLDS.unexplainedRatio
    const quality = resolveSongBeatGridDriftQuality({
      unexplainedBeatRatio: limit,
      segments: segments([{ clipIndex: 0, p95: 1, max: 1 }]),
      rejectThresholds: REJECT_THRESHOLDS
    })
    expect(quality?.reason).toBe('drift')
    expect(quality?.clipIndex).toBeUndefined()
  })
})

describe('resolveSongBeatGridFixedDriftQuality', () => {
  it('漂移在阈值内不产生标记', () => {
    expect(
      resolveSongBeatGridFixedDriftQuality({
        estimatedDrift128Ms: SONG_BEAT_GRID_FIXED_DRIFT_LIMIT_MS
      })
    ).toBeUndefined()
  })

  it('超过阈值时标出整曲问题', () => {
    const quality = resolveSongBeatGridFixedDriftQuality({ estimatedDrift128Ms: 12.5 })
    expect(quality?.status).toBe('unsure')
    expect(quality?.reason).toBe('drift')
    // 整曲性问题：没有 clip 序号，也没有时间定位。
    expect(quality?.clipIndex).toBeUndefined()
    expect(quality?.sinceSec).toBeUndefined()
  })

  it('没有测量值时不做判断', () => {
    expect(resolveSongBeatGridFixedDriftQuality({ estimatedDrift128Ms: undefined })).toBeUndefined()
  })
})

describe('normalizeSongBeatGridQuality', () => {
  it('合法的标记被保留并补齐版本', () => {
    const quality = normalizeSongBeatGridQuality({
      status: 'unsure',
      reason: 'drift',
      version: '',
      clipIndex: 2,
      sinceSec: 83.4567
    })
    expect(quality?.version).toBe(SONG_BEAT_GRID_QUALITY_VERSION)
    expect(quality?.clipIndex).toBe(2)
    expect(quality?.sinceSec).toBe(83.457)
  })

  it('不认识的值一律丢掉', () => {
    expect(normalizeSongBeatGridQuality(undefined)).toBeUndefined()
    expect(normalizeSongBeatGridQuality(null)).toBeUndefined()
    expect(normalizeSongBeatGridQuality('unsure')).toBeUndefined()
    expect(normalizeSongBeatGridQuality({ status: 'ok', reason: 'drift' })).toBeUndefined()
    expect(normalizeSongBeatGridQuality({ status: 'unsure', reason: 'unknown' })).toBeUndefined()
  })
})

describe('isSameSongBeatGridQuality', () => {
  it('两边都没有算相同', () => {
    expect(isSameSongBeatGridQuality(undefined, undefined)).toBe(true)
  })

  it('只有一个有算不同', () => {
    expect(isSameSongBeatGridQuality(createSongBeatGridDegradedQuality(), undefined)).toBe(false)
  })

  it('内容一致算相同', () => {
    const left = createSongBeatGridDegradedQuality()
    const right = createSongBeatGridDegradedQuality()
    expect(isSameSongBeatGridQuality(left, right)).toBe(true)
  })
})

describe('动态网格分析产出的质量标记', () => {
  const buildWindows = (jitterAmp: number, durationSec = 150, bpmFrom = 120, bpmTo = 120) => {
    const beats: number[] = []
    const downbeats: number[] = []
    let time = 0.2
    let index = 0
    while (time < durationSec) {
      const progress = time / durationSec
      const bpm = bpmFrom + (bpmTo - bpmFrom) * progress
      const jitterSeed = (Math.sin(index * 12.9898) * 43758.5453) % 1
      const jitterSec = jitterAmp * jitterSeed
      beats.push(Number((time + jitterSec).toFixed(6)))
      if (index % 4 === 0) downbeats.push(Number((time + jitterSec).toFixed(6)))
      time += 60 / bpm
      index += 1
    }
    const windowSec = 30
    const stepSec = 15
    const windows = []
    for (let start = 0; start + windowSec <= durationSec; start += stepSec) {
      windows.push({
        windowId: `w-${start}`,
        startAudioSec: start,
        analyzedDurationSec: windowSec,
        status: 'ok' as const,
        beatsAudioSec: beats.filter((t) => t >= start && t < start + windowSec),
        downbeatsAudioSec: downbeats.filter((t) => t >= start && t < start + windowSec)
      })
    }
    return windows
  }

  it('残差逼近阈值时产出 drift 标记', () => {
    const outcome = analyzeDynamicBeatGridEvidence({
      windows: buildWindows(0.012) as never,
      durationAudioSec: 150
    })
    expect(outcome.status === 'fixed' || outcome.status === 'dynamic').toBe(true)
    if (outcome.status !== 'fixed' && outcome.status !== 'dynamic') return
    expect(outcome.quality?.reason).toBe('drift')
    expect(outcome.quality?.version).toBe(SONG_BEAT_GRID_QUALITY_VERSION)
    // 整曲都在漂移：第一段就出问题，没有 clip 序号，也就没有时间定位。
    expect(outcome.quality?.clipIndex).toBeUndefined()
  })

  it('干净的网格不产出标记', () => {
    const outcome = analyzeDynamicBeatGridEvidence({
      windows: buildWindows(0) as never,
      durationAudioSec: 150
    })
    expect(outcome.status === 'fixed' || outcome.status === 'dynamic').toBe(true)
    if (outcome.status !== 'fixed' && outcome.status !== 'dynamic') return
    expect(outcome.quality).toBeUndefined()
  })

  it('速度漂移 + 真实量级抖动时仍能拟合出分段网格', () => {
    // 120 -> 132 BPM 线性漂移 + ±10ms 抖动。
    // 回归点：DP 的预筛门槛曾经是 5ms（低于拍点检测的噪声底噪），
    // 导致这类真实音频永远分不出段，动态网格路径整体失效。
    const outcome = analyzeDynamicBeatGridEvidence({
      windows: buildWindows(0.01, 150, 120, 132) as never,
      durationAudioSec: 150
    })
    expect(outcome.status).toBe('dynamic')
    if (outcome.status !== 'fixed' && outcome.status !== 'dynamic') return
    expect(outcome.beatGridMap.clips.length).toBeGreaterThan(1)
  })
})
