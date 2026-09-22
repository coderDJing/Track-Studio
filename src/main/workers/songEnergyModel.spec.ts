import { describe, expect, it } from 'vitest'
import {
  CURRENT_SONG_ENERGY_ALGORITHM_VERSION,
  buildSongEnergyScoreFromArousal,
  normalizeSongEnergyAnalysis
} from '../../shared/songEnergy'
import {
  aggregateSongArousal,
  analyzeSongEnergyWithModel,
  buildSongEnergyMelFrames,
  normalizeRhythmicFluxScore,
  normalizeSongEnergyBeatGrid,
  summarizeSongEnergyPredictions,
  summarizeSongEnergyTemporalSegments,
  SONG_ENERGY_MODEL_SAMPLE_RATE
} from './songEnergyModel'

const buildSineWave = (seconds: number, frequency = 440) => {
  const sampleCount = Math.floor(SONG_ENERGY_MODEL_SAMPLE_RATE * seconds)
  return Float32Array.from(
    { length: sampleCount },
    (_, index) => 0.2 * Math.sin((2 * Math.PI * frequency * index) / SONG_ENERGY_MODEL_SAMPLE_RATE)
  )
}

describe('songEnergyModel', () => {
  it('maps the DEAM 1-9 arousal range to the persisted 0-100 range', () => {
    expect(buildSongEnergyScoreFromArousal(1)).toEqual({
      energyScore: 0,
      energyAlgorithmVersion: CURRENT_SONG_ENERGY_ALGORITHM_VERSION
    })
    expect(buildSongEnergyScoreFromArousal(5)?.energyScore).toBe(50)
    expect(buildSongEnergyScoreFromArousal(9)?.energyScore).toBe(100)
  })

  it('uses the median patch arousal as the representative whole-song value', () => {
    expect(aggregateSongArousal([8, 3, 5])).toBe(5)
    expect(aggregateSongArousal([3, 5, 7, 9])).toBe(6)
    expect(aggregateSongArousal([Number.NaN])).toBeNull()
  })

  it('uses a sustained high-energy window and reports ensemble diagnostics', () => {
    const low = Array.from({ length: 12 }, () => 3)
    const high = Array.from({ length: 18 }, () => 7)
    const deam = [...low, ...high, ...low]
    const emomusic = deam.map((value) => value - 0.4)
    const result = summarizeSongEnergyPredictions({
      deam,
      emomusic,
      patchStarts: deam.map((_, index) => index * 93)
    })
    expect(result?.sustainedScore).toBeGreaterThan(result?.medianScore ?? 100)
    expect(result?.peakScore).toBeGreaterThanOrEqual(result?.sustainedScore ?? 100)
    expect(result?.rangeScore).toBeGreaterThan(0)
    expect(result?.confidence).toBeGreaterThan(50)
  })

  it('normalizes diagnostics', () => {
    const analysis = normalizeSongEnergyAnalysis({
      version: 5,
      model: 'musicnn-deam-emomusic',
      sustainedScore: 72,
      averageScore: 65,
      medianScore: 66,
      peakScore: 80,
      rangeScore: 35,
      confidence: 88,
      patchCount: 12
    })
    expect(analysis?.sustainedScore).toBe(72)
  })

  it('preserves the current structural diagnostics and compact energy curve', () => {
    const analysis = normalizeSongEnergyAnalysis({
      version: 11,
      model: 'musicnn-deam-emomusic-structure-v11',
      sustainedScore: 72,
      averageScore: 65,
      medianScore: 66,
      peakScore: 80,
      rangeScore: 35,
      confidence: 88,
      patchCount: 12,
      drivingScore: 74,
      energyCurve: [{ timeMs: 12000, score: 76, role: 'high' }]
    })
    expect(analysis?.version).toBe(11)
    expect(analysis?.drivingScore).toBe(74)
    expect(analysis?.energyCurve?.[0]?.role).toBe('high')
  })

  it('projects a negative beat anchor onto the first non-negative beat', () => {
    expect(normalizeSongEnergyBeatGrid(125, -2)).toEqual({
      bpm: 125,
      firstBeatMs: 478
    })
    expect(normalizeSongEnergyBeatGrid(125, 48.113)).toEqual({
      bpm: 125,
      firstBeatMs: 48.113
    })
    expect(normalizeSongEnergyBeatGrid(0, -2)).toBeNull()
    expect(normalizeSongEnergyBeatGrid(125, undefined)).toBeNull()
  })

  it('keeps rhythmic flux scores monotonic without saturating ordinary dance music', () => {
    const observedTrackScore = normalizeRhythmicFluxScore(0.130785086)
    expect(observedTrackScore).toBeGreaterThan(65)
    expect(observedTrackScore).toBeLessThan(85)
    expect(normalizeRhythmicFluxScore(0)).toBe(0)
    expect(normalizeRhythmicFluxScore(0.3)).toBeGreaterThan(observedTrackScore)
    expect(normalizeRhythmicFluxScore(0.3)).toBeLessThan(100)
  })

  it('creates finite MusiCNN mel frames', () => {
    const result = buildSongEnergyMelFrames(buildSineWave(3))
    expect(result.frameCount).toBeGreaterThanOrEqual(187)
    expect(result.frames.length).toBe(result.frameCount * 96)
    expect(Array.from(result.frames).every(Number.isFinite)).toBe(true)
  })

  it('keeps a long intro and outro from dominating the main-section energy', () => {
    const values = [18, 22, 28, 38, 78, 84, 82, 80, 76, 34, 20]
    const summary = summarizeSongEnergyTemporalSegments(
      values.map((modelScore, index) => ({
        startSeconds: index * 12,
        endSeconds: (index + 1) * 12,
        modelScore,
        activityScore: modelScore,
        rhythmicScore: modelScore,
        lowFrequencyScore: modelScore
      }))
    )
    expect(summary?.representativeScore).toBeGreaterThan(55)
    expect(summary?.mainSectionScore).toBeGreaterThan(55)
    expect(summary?.energyCurve.some((point) => point.role === 'high')).toBe(true)
  })

  it('detects structural transitions without adding another model', () => {
    const values = [25, 28, 30, 76, 80, 78, 32, 26, 74, 79, 76, 30]
    const summary = summarizeSongEnergyTemporalSegments(
      values.map((modelScore, index) => ({
        startSeconds: index * 10,
        endSeconds: (index + 1) * 10,
        modelScore,
        activityScore: modelScore,
        rhythmicScore: modelScore,
        lowFrequencyScore: modelScore
      }))
    )
    expect(summary?.dropScore).toBeGreaterThan(30)
    expect(summary?.breakdownScore).toBeGreaterThan(30)
    expect(summary?.dropCount).toBeGreaterThanOrEqual(1)
    expect(summary?.breakdownCount).toBeGreaterThanOrEqual(1)
    expect(summary?.drivingScore).toBeGreaterThan(30)
  })

  it('runs the bundled MusiCNN and DEAM models locally', async () => {
    const samples = buildSineWave(3.1)
    const result = await analyzeSongEnergyWithModel({
      pcmData: samples,
      sampleRate: SONG_ENERGY_MODEL_SAMPLE_RATE,
      channels: 1
    })
    expect(result?.analysis.patchCount).toBeGreaterThan(0)
    expect(result?.analysis.model).toBe('musicnn-deam-emomusic-structure-v11')
    expect(result?.analysis.energyCurve?.length).toBeGreaterThan(0)
    expect(result?.analysis.dancefloorScore).toBeGreaterThanOrEqual(0)
    expect(result?.analysis.danceabilityScore).toBeGreaterThanOrEqual(0)
    expect(result?.energyScore).toBeGreaterThanOrEqual(0)
    expect(result?.energyScore).toBeLessThanOrEqual(100)
  })
})
