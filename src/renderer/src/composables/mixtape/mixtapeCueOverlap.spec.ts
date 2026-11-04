import { afterEach, describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import { buildMixtapeCueOverlapPlan } from './mixtapeCueOverlap'
import {
  applyMixtapeGlobalTempoSnapshot,
  readMixtapeGlobalTempoSnapshot,
  resetMixtapeGlobalTempoState
} from './mixtapeGlobalTempoState'
import type { MixtapeTrack } from './types'
import { buildMixtapeTrackCueMarkers } from './mixtapeTrackCueMarkers'
import { buildTrackRuntimeTempoSnapshot } from './trackRuntimeTempoSnapshot'

const track = (id: string, bpm = 120, overrides: Partial<MixtapeTrack> = {}): MixtapeTrack => ({
  id,
  title: id,
  mixOrder: Number(id),
  filePath: `/${id}.mp3`,
  artist: '',
  originPath: '',
  duration: '02:00',
  startSec: 0,
  originalBpm: bpm,
  gridBaseBpm: bpm,
  bpm,
  beatGridMap:
    createSongBeatGridMapV2FromFixedGrid({
      bpm,
      firstBeatMs: 0,
      downbeatBeatOffset: 0,
      source: 'analysis'
    }) ?? undefined,
  hotCues: [
    { slot: 0, sec: 10 },
    { slot: 1, sec: 90 }
  ],
  ...overrides
})
const plan = (tracks: MixtapeTrack[], bpm = 120) =>
  buildMixtapeCueOverlapPlan({
    tracks,
    settings: { startCue: 0, endCue: 1, bpm },
    resolveSourceDuration: () => 120
  })
afterEach(() => resetMixtapeGlobalTempoState())

describe('manual Hot Cue overlap planning', () => {
  it('aligns the actual aiSet second/third grids when the incoming start Cue is missing', () => {
    const makeTrack = (id: string, bpm: number, anchorMs: number, endCueSec: number) =>
      track(id, bpm, {
        timeBasisOffsetMs: 23.021,
        beatGridMap:
          createSongBeatGridMapV2FromFixedGrid({
            bpm,
            firstBeatMs: anchorMs,
            downbeatBeatOffset: 0,
            source: 'analysis'
          }) ?? undefined,
        hotCues: [{ slot: 1, sec: endCueSec }]
      })
    const tracks = [makeTrack('2', 124, 25.771, 154.864), makeTrack('3', 125, 7.521, 138.248)]
    const result = buildMixtapeCueOverlapPlan({
      tracks,
      settings: { startCue: 0, endCue: 1, bpm: 126 },
      resolveSourceDuration: () => 200
    })
    expect(result.valid).toBe(true)
    expect(result.rows[1].inSec).toBeLessThan(0)
    applyMixtapeGlobalTempoSnapshot({
      playlistId: 'mix',
      source: 'user',
      snapshot: result.snapshot
    })
    const maps = tracks.map((item, index) =>
      buildTrackRuntimeTempoSnapshot({
        track: { ...item, bpm: 126, startSec: result.rows[index].startSec },
        sourceDurationSec: 200,
        zoom: 99
      })
    )
    // Compare rendered beat positions throughout the overlap, not only Cue timestamps.
    for (const beat of [1, 8, 32]) {
      const expected = result.rows[0].startSec + result.rows[0].outSec + (beat * 60) / 126
      for (let index = 0; index < maps.length; index++) {
        const positions = maps[index].visibleGridLines.map(
          (line) => result.rows[index].startSec + line.sec
        )
        expect(Math.min(...positions.map((sec) => Math.abs(sec - expected)))).toBeLessThan(0.0002)
      }
    }
  })
  it('aligns outgoing and incoming cues at the same global time after unifying BPM', () => {
    const result = plan([track('1'), track('2', 60), track('3', 180)])
    expect(result.valid).toBe(true)
    expect(result.rows.map((row) => row.startSec)).toEqual([0, 85, 115])
    expect(result.rows.map((row) => row.durationSec)).toEqual([120, 60, 180])
    result.rows.slice(1).forEach((row, index) => {
      const previous = result.rows[index]
      expect(row.startSec + row.inSec).toBeCloseTo(previous.startSec + previous.outSec, 3)
    })
    expect(result.snapshot.bpmEnvelope.map((point) => point.bpm)).toEqual([120, 120])
  })

  it('snaps off-grid Cues to the nearest beat before positioning tracks', () => {
    const result = plan([
      track('1', 120, {
        hotCues: [
          { slot: 0, sec: 10.12 },
          { slot: 1, sec: 90.18 }
        ]
      }),
      track('2', 120, {
        hotCues: [
          { slot: 0, sec: 10.21 },
          { slot: 1, sec: 90.13 }
        ]
      })
    ])
    expect(result.valid).toBe(true)
    expect(result.rows.map((row) => [row.inSec, row.outSec])).toEqual([
      [10, 90],
      [10, 90]
    ])
    expect(result.rows[1].startSec).toBe(80)
  })

  it('uses project order and preserves the first track start', () => {
    const result = plan([track('3'), track('1', 120, { startSec: 12 }), track('2')])
    expect(result.rows.map((row) => row.id)).toEqual(['1', '2', '3'])
    expect(result.rows.map((row) => row.startSec)).toEqual([12, 92, 172])
  })

  it('aligns the nearest rendered beat lines after applying the plan', () => {
    const tracks = [
      track('1', 126, { timeBasisOffsetMs: 50 }),
      track('2', 130, {
        timeBasisOffsetMs: 50,
        hotCues: [
          { slot: 0, sec: 10, source: 'rekordbox' },
          { slot: 1, sec: 90 }
        ]
      })
    ]
    const result = plan(tracks, 128)
    applyMixtapeGlobalTempoSnapshot({
      playlistId: 'mix',
      source: 'user',
      snapshot: result.snapshot
    })
    const positioned = tracks.map((item, index) => ({
      ...item,
      bpm: 128,
      startSec: result.rows[index].startSec
    }))
    const markers = positioned.map((item) =>
      buildMixtapeTrackCueMarkers({ track: item, sourceDurationSec: 120, pxPerSec: 10 })
    )
    const outgoing = markers[0].find((marker) => marker.hotCue?.slot === 1)
    const incoming = markers[1].find((marker) => marker.hotCue?.slot === 0)
    expect(outgoing).toBeDefined()
    expect(incoming).toBeDefined()
    const snap = (index: number, sec: number) =>
      buildTrackRuntimeTempoSnapshot({
        track: positioned[index],
        sourceDurationSec: 120
      }).timeMap.snapLocalSec(sec, Number.POSITIVE_INFINITY)
    expect(positioned[0].startSec + snap(0, outgoing?.localSec || 0)).toBeCloseTo(
      positioned[1].startSec + snap(1, incoming?.localSec || 0),
      3
    )
  })

  it('uses track boundaries and reports missing selected cues just like SET duration', () => {
    const result = plan([track('1', 120, { hotCues: [] }), track('2', 120, { hotCues: [] })])
    expect(result.valid).toBe(true)
    expect(result.missingStartCount).toBe(2)
    expect(result.missingEndCount).toBe(2)
    expect(result.rows.map((row) => row.startSec)).toEqual([0, 120])
  })

  it('accepts explicit start/end boundaries and rejects invalid selections', () => {
    const build = (startCue: 'start' | number, endCue: 'end' | number) =>
      buildMixtapeCueOverlapPlan({
        tracks: [track('1'), track('2')],
        settings: { startCue, endCue, bpm: 120 },
        resolveSourceDuration: () => 120
      })
    expect(build('start', 'end').rows.map((row) => row.startSec)).toEqual([0, 120])
    expect(build(0, 0).valid).toBe(false)
    expect(plan([track('1'), track('2')], 0).valid).toBe(false)
    expect(plan([track('1')]).valid).toBe(false)
  })

  it('rejects reversed cues, missing grid, unknown duration, and negative timeline placement', () => {
    expect(
      plan([
        track('1', 120, {
          hotCues: [
            { slot: 0, sec: 100 },
            { slot: 1, sec: 10 }
          ]
        }),
        track('2')
      ]).rows[0].error
    ).toBe('cueOrder')
    expect(plan([track('1', 120, { beatGridMap: undefined }), track('2')]).rows[0].error).toBe(
      'grid'
    )
    expect(
      buildMixtapeCueOverlapPlan({
        tracks: [track('1'), track('2')],
        settings: { startCue: 0, endCue: 1, bpm: 120 },
        resolveSourceDuration: () => 0
      }).valid
    ).toBe(false)
    const result = plan([
      track('1', 120, {
        hotCues: [
          { slot: 0, sec: 0 },
          { slot: 1, sec: 5 }
        ]
      }),
      track('2', 120, {
        hotCues: [
          { slot: 0, sec: 100 },
          { slot: 1, sec: 110 }
        ]
      })
    ])
    expect(result.rows[1].error).toBe('negativeStart')
    expect(result.valid).toBe(false)
  })

  it('uses the final occurrence of the outgoing Cue in a repeated Loop', () => {
    const result = plan([
      track('1', 120, {
        hotCues: [
          { slot: 0, sec: 1 },
          { slot: 1, sec: 3 }
        ],
        loopSegment: { startSec: 2, endSec: 4, repeatCount: 2 }
      }),
      track('2', 120, {
        hotCues: [
          { slot: 0, sec: 1 },
          { slot: 1, sec: 90 }
        ]
      })
    ])
    expect(result.rows[0].outSec).toBe(7)
    expect(result.rows[1].startSec).toBe(6)
  })

  it('does not change the live BPM curve or track metadata while building a preview', () => {
    applyMixtapeGlobalTempoSnapshot({
      playlistId: 'mix',
      source: 'user',
      snapshot: {
        bpmEnvelope: [
          { sec: 0, bpm: 90 },
          { sec: 300, bpm: 140 }
        ],
        bpmEnvelopeDurationSec: 300
      }
    })
    const tracks = [track('1'), track('2')]
    const before = JSON.stringify(tracks),
      tempoBefore = readMixtapeGlobalTempoSnapshot()
    plan(tracks, 128)
    expect(JSON.stringify(tracks)).toBe(before)
    expect(readMixtapeGlobalTempoSnapshot()).toEqual(tempoBefore)
  })
})
