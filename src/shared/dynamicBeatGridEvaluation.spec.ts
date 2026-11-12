import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromClips } from './songBeatGridMapV2'
import { evaluateDynamicBeatGrid } from './dynamicBeatGridEvaluation'

const createMap = (
  clips: Parameters<typeof createSongBeatGridMapV2FromClips>[0],
  durationSec: number
) => createSongBeatGridMapV2FromClips(clips, 'analysis', { allowSingleClip: true, durationSec })

describe('evaluateDynamicBeatGrid', () => {
  it('fully matches an identical multi-clip candidate and truth map', () => {
    const map = createMap(
      [
        { startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 },
        { startSec: 60, anchorSec: 60, bpm: 128, downbeatBeatOffset: 2 }
      ],
      180
    )
    expect(map).not.toBeNull()
    if (!map) return
    const report = evaluateDynamicBeatGrid(
      {
        beatGridMap: map,
        durationSec: 180,
        coordinate: 'audio',
        identity: 'candidate-map',
        policyVersion: 'test-policy',
        audioIdentity: 'sha256:test-audio'
      },
      {
        beatGridMap: map,
        durationSec: 180,
        coordinate: 'audio',
        identity: 'truth-map',
        audioIdentity: 'sha256:test-audio'
      }
    )
    expect(report.status).toBe('ok')
    if (report.status !== 'ok') return
    expect(report.beats.missingCount).toBe(0)
    expect(report.beats.extraCount).toBe(0)
    expect(report.beats.matchedCount).toBe(report.beats.truthCount)
    expect(report.beats.error.maxMs).toBe(0)
    expect(report.downbeats.missingCount).toBe(0)
    expect(report.downbeats.misplacedCount).toBe(0)
    expect(report.boundaries.maxBoundaryErrorMs).toBe(0)
    expect(report.tail.tailErrorMs).toBe(0)
    expect(report.segments.extraClipCount).toBe(0)
    expect(report.input.candidateIdentity).toBe('candidate-map')
    expect(report.input.truthIdentity).toBe('truth-map')
    expect(report.input.candidatePolicyVersion).toBe('test-policy')
    expect(report.input.coordinate).toBe('audio')
    expect(report.input.matchToleranceMs).toBe(80)
    expect(report.input.audioIdentityMatched).toBe(true)
    expect(report.qualification.scientificValidationEligible).toBe(false)
    expect(report.qualification.syntheticOrDevelopmentOnly).toBe(true)
    expect(report.qualification.centralRegistryUsed).toBe(false)
    expect(report.qualification.audioIdentityPresent).toBe(true)
  })

  it('penalizes missing and extra beats with monotonic one-to-one matching', () => {
    const candidateMap = createMap(
      [{ startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 }],
      10
    )
    expect(candidateMap).not.toBeNull()
    if (!candidateMap) return
    const truthTimes = Array.from({ length: 20 }, (_, index) => index * 0.5).filter(
      (timeSec) => Math.abs(timeSec - 2) > 1e-9
    )
    truthTimes.push(2.25)
    truthTimes.sort((left, right) => left - right)
    const report = evaluateDynamicBeatGrid(
      { beatGridMap: candidateMap, durationSec: 10, coordinate: 'audio' },
      {
        durationSec: 10,
        coordinate: 'audio',
        beatTimesSec: truthTimes,
        downbeatTimesSec: [0, 4, 8],
        clipCount: 1
      }
    )
    expect(report.status).toBe('ok')
    if (report.status !== 'ok') return
    expect(report.beats.truthCount).toBe(20)
    expect(report.beats.candidateCount).toBe(20)
    expect(report.beats.missingCount).toBe(1)
    expect(report.beats.extraCount).toBe(1)
    expect(report.beats.matchedCount).toBe(19)
    expect(report.beats.truthMatchRate).toBeCloseTo(19 / 20, 6)
    expect(report.beats.candidateMatchRate).toBeCloseTo(19 / 20, 6)
  })

  it('counts downbeat misplacement separately from beat-line error', () => {
    const candidateMap = createMap(
      [{ startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 1 }],
      10
    )
    expect(candidateMap).not.toBeNull()
    if (!candidateMap) return
    const report = evaluateDynamicBeatGrid(
      { beatGridMap: candidateMap, durationSec: 10, coordinate: 'audio' },
      {
        durationSec: 10,
        coordinate: 'audio',
        beatTimesSec: Array.from({ length: 20 }, (_, index) => index * 0.5),
        downbeatTimesSec: [0, 2, 4, 6, 8],
        clipCount: 1
      }
    )
    expect(report.status).toBe('ok')
    if (report.status !== 'ok') return
    expect(report.beats.missingCount).toBe(0)
    expect(report.downbeats.matchedCount).toBe(0)
    expect(report.downbeats.misplacedCount).toBe(5)
    expect(report.downbeats.error.maxMs).toBeNull()
  })

  it('reports boundary and tail errors for multi-clip candidates', () => {
    const candidateMap = createMap(
      [
        { startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 },
        { startSec: 5, anchorSec: 5, bpm: 120, downbeatBeatOffset: 0 }
      ],
      10
    )
    expect(candidateMap).not.toBeNull()
    if (!candidateMap) return
    const report = evaluateDynamicBeatGrid(
      { beatGridMap: candidateMap, durationSec: 10, coordinate: 'audio' },
      {
        durationSec: 10,
        coordinate: 'audio',
        beatTimesSec: Array.from({ length: 20 }, (_, index) => index * 0.5),
        downbeatTimesSec: [0, 2, 4, 6, 8],
        boundarySecs: [5],
        clipCount: 2
      }
    )
    expect(report.status).toBe('ok')
    if (report.status !== 'ok') return
    expect(report.boundaries.truthCount).toBe(1)
    expect(report.boundaries.candidateCount).toBe(1)
    expect(report.boundaries.maxBoundaryErrorMs).toBe(0)
    expect(report.boundaries.maxBoundaryLineErrorMs).toBe(0)
    expect(report.tail.lastTruthBeatSec).toBe(9.5)
    expect(report.tail.tailErrorMs).toBe(0)
    expect(report.segments.overSegmented).toBe(false)
  })

  it('refuses to compare candidate and truth in different coordinates or with missing coordinates', () => {
    const map = createMap([{ startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 }], 10)
    expect(map).not.toBeNull()
    if (!map) return
    expect(
      evaluateDynamicBeatGrid(
        { beatGridMap: map, durationSec: 10, coordinate: 'timeline' },
        { beatGridMap: map, durationSec: 10, coordinate: 'audio' }
      ).status
    ).toBe('error')
    expect(
      evaluateDynamicBeatGrid(
        { beatGridMap: map, durationSec: 10, coordinate: 'audio', audioIdentity: 'a' },
        { beatGridMap: map, durationSec: 10, coordinate: 'audio', audioIdentity: 'b' }
      ).status
    ).toBe('error')
  })

  it('returns explicit errors for invalid candidate/truth input', () => {
    expect(
      evaluateDynamicBeatGrid(
        { beatGridMap: null, durationSec: 10, coordinate: 'audio' },
        { durationSec: 10, coordinate: 'audio', beatTimesSec: [0, 0.5] }
      ).status
    ).toBe('error')
    expect(
      evaluateDynamicBeatGrid(
        {
          beatGridMap: { version: 2, source: 'analysis', clips: [] },
          durationSec: 10,
          coordinate: 'audio'
        },
        { durationSec: 10, coordinate: 'audio', beatTimesSec: [0, 0.5] }
      ).status
    ).toBe('error')
    expect(
      evaluateDynamicBeatGrid(
        {
          beatGridMap: createMap(
            [{ startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 }],
            10
          ),
          durationSec: 10,
          coordinate: 'audio'
        },
        { durationSec: 10, coordinate: 'audio' }
      ).status
    ).toBe('error')
  })
})
