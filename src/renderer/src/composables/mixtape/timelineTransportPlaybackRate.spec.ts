import { describe, expect, it } from 'vitest'
import {
  resolveTransportEntryPlaybackRate,
  resolveTransportEntryTimeMap
} from './timelineTransportPlaybackRate'
import { resolveTransportClockSec } from './timelineTransportClock'
import type { SerializedTrackTempoSnapshot } from './types'

const snapshot = (): SerializedTrackTempoSnapshot => ({
  signature: 'same-signature',
  durationSec: 120,
  baseDurationSec: 120,
  sourceDurationSec: 120,
  baseBpm: 120,
  gridSourceBpm: 120,
  originalBpm: 120,
  firstBeatSourceSec: 0,
  beatSourceSec: 0.5,
  downbeatBeatOffset: 0,
  controlPoints: [
    { sec: 0, bpm: 120 },
    { sec: 120, bpm: 180 }
  ]
})

describe('Mixtape output clock and tempo contract', () => {
  it('starts a seek at the local tempo, including a loop occurrence, rather than the track average', () => {
    const entry = { tempoSnapshot: snapshot(), tempoRatio: 1, originalBpm: 120 }
    expect(resolveTransportEntryPlaybackRate(entry, 60)).toBeCloseTo(1.25)
    const looped = {
      ...entry,
      tempoSnapshot: { ...snapshot(), loopSegments: [{ startSec: 10, endSec: 20, repeatCount: 2 }] }
    }
    expect(resolveTransportEntryPlaybackRate(looped, 25)).toBeCloseTo(127.5 / 120)
  })

  it('uses the active source grid clip at a dynamic BPM boundary', () => {
    const entry = {
      tempoSnapshot: snapshot(),
      tempoRatio: 1,
      dynamicTempoSegments: [
        {
          key: 'changed',
          localStartSec: 60,
          localEndSec: 120,
          sourceStartSec: 60,
          sourceEndSec: 120,
          sourceBpm: 100,
          beatSec: 0.6,
          syncAnchorSec: 60
        }
      ]
    }
    expect(resolveTransportEntryPlaybackRate(entry, 60)).toBeCloseTo(1.5)
  })

  it('does not reuse another project time map merely because its signature matches', () => {
    const first = { tempoSnapshot: snapshot() }
    const second = {
      tempoSnapshot: {
        ...snapshot(),
        controlPoints: [
          { sec: 0, bpm: 90 },
          { sec: 120, bpm: 90 }
        ]
      }
    }
    expect(resolveTransportEntryTimeMap(first).sampleBpmAtLocal(60)).toBe(150)
    expect(resolveTransportEntryTimeMap(second).sampleBpmAtLocal(60)).toBe(90)
    expect(resolveTransportEntryTimeMap(first)).toBe(resolveTransportEntryTimeMap(first))
  })

  it('holds before scheduled start, pauses with the output clock and resumes without jumping to the end', () => {
    expect(resolveTransportClockSec(10, 10.03, 50)).toBe(50)
    const paused = resolveTransportClockSec(12.03, 10.03, 50)
    expect(paused).toBe(52)
    expect(resolveTransportClockSec(12.03, 10.03, 50)).toBe(paused)
    expect(resolveTransportClockSec(101.03, 100.03, paused)).toBe(53)
  })
})
