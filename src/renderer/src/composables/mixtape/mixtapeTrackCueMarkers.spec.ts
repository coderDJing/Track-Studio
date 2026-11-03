import { afterEach, describe, expect, it } from 'vitest'
import { buildMixtapeTrackCueMarkers } from './mixtapeTrackCueMarkers'
import {
  applyMixtapeGlobalTempoSnapshot,
  resetMixtapeGlobalTempoState
} from './mixtapeGlobalTempoState'
import type { MixtapeTrack } from './types'

const track = (overrides: Partial<MixtapeTrack> = {}): MixtapeTrack => ({
  id: 'track',
  mixOrder: 1,
  title: 'Track',
  artist: '',
  duration: '01:00',
  filePath: '/track.mp3',
  originPath: '',
  startSec: 0,
  bpm: 120,
  originalBpm: 120,
  gridBaseBpm: 120,
  ...overrides
})
const markers = (overrides: Partial<MixtapeTrack> = {}, sourceDurationSec = 60) =>
  buildMixtapeTrackCueMarkers({ track: track(overrides), sourceDurationSec, pxPerSec: 10 })

afterEach(() => resetMixtapeGlobalTempoState())

describe('Mixtape cue positions on the waveform', () => {
  it('shows both cue kinds with original labels and colors', () => {
    const result = markers({
      hotCues: [{ slot: 1, sec: 10, label: 'Drop', color: '#00ff00', comment: 'Mix in' }],
      memoryCues: [{ sec: 20, comment: 'Mix out' }]
    })
    expect(result.map((m) => [m.kind, m.label, m.localSec, m.leftPx])).toEqual([
      ['hot', 'Drop', 10, 100],
      ['memory', 'M1', 20, 200]
    ])
    expect(result[0].color).toBe('#00ff00')
    expect(result[0].title).toContain('Mix in')
    expect(result[1].title).toContain('Memory Cue')
  })

  it('follows track tempo rather than treating source seconds as timeline seconds', () => {
    expect(markers({ bpm: 60, hotCues: [{ slot: 0, sec: 10 }] })[0].localSec).toBeCloseTo(20, 3)
  })

  it('uses the master BPM and the track position for tempo ramps', () => {
    applyMixtapeGlobalTempoSnapshot({
      playlistId: 'mix',
      source: 'user',
      snapshot: {
        bpmEnvelope: [
          { sec: 0, bpm: 60 },
          { sec: 120, bpm: 180 }
        ],
        bpmEnvelopeDurationSec: 120,
        gridPhaseOffsetSec: 0
      }
    })
    const first = markers({ startSec: 0, hotCues: [{ slot: 0, sec: 10 }] })[0]
    const later = markers({ startSec: 60, hotCues: [{ slot: 0, sec: 10 }] })[0]
    expect(first.localSec).toBeGreaterThan(later.localSec)
    expect(first.localSec).not.toBe(10)
  })

  it('repeats cues inside a Loop and shifts later cues past the repetitions', () => {
    const result = markers(
      {
        loopSegment: { startSec: 2, endSec: 4, repeatCount: 2 },
        hotCues: [{ slot: 0, sec: 3 }],
        memoryCues: [{ sec: 4 }, { sec: 5 }]
      },
      10
    )
    expect(result.filter((m) => m.kind === 'hot').map((m) => m.localSec)).toEqual([3, 5, 7])
    expect(result.filter((m) => m.kind === 'memory').map((m) => m.localSec)).toEqual([8, 9])
    expect(new Set(result.map((m) => m.key)).size).toBe(result.length)
  })

  it('keeps cues at the start and end but omits invalid or out-of-track positions', () => {
    expect(
      markers({
        hotCues: [
          { slot: 0, sec: 0 },
          { slot: 1, sec: 60 },
          { slot: 2, sec: 61 },
          { slot: 3, sec: -1 }
        ]
      }).map((m) => m.localSec)
    ).toEqual([0, 60])
    expect(markers({ memoryCues: [{ sec: 10 }] }, 0)).toEqual([])
  })

  it('converts FRKB timeline cues and Rekordbox audio cues to the same waveform position', () => {
    const result = markers({
      timeBasisOffsetMs: 50,
      hotCues: [
        { slot: 0, sec: 10.05 },
        { slot: 1, sec: 10, source: 'rekordbox' }
      ]
    })
    expect(result.map((m) => m.localSec)).toEqual([10, 10])
  })
})
