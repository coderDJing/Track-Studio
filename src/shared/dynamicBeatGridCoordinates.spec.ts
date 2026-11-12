import { describe, expect, it } from 'vitest'
import {
  createSongBeatGridMapV2FromClips,
  projectSongBeatGridMapV2ToFixedGrid
} from './songBeatGridMapV2'
import {
  convertDynamicAudioGridMapToTimeline,
  convertDynamicTimelineGridMapToAudio,
  deriveDynamicAudioGridMapForDuration
} from './dynamicBeatGridCoordinates'

const createAudioMap = (durationSec = 180) =>
  createSongBeatGridMapV2FromClips(
    [
      { startSec: 0, anchorSec: 0.1, bpm: 120, downbeatBeatOffset: 0 },
      { startSec: 60, anchorSec: 60.05, bpm: 128, downbeatBeatOffset: 2 }
    ],
    'analysis',
    { allowSingleClip: true, durationSec }
  )

describe('dynamic beat grid audio <-> timeline coordinates', () => {
  it('keeps first clip start at 0 and applies the time-basis offset exactly once', () => {
    const audioMap = createAudioMap()
    expect(audioMap).not.toBeNull()
    if (!audioMap) return
    const result = convertDynamicAudioGridMapToTimeline({
      beatGridMap: audioMap,
      audioDurationSec: 180,
      timeBasisOffsetMs: 250
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.durationSec).toBeCloseTo(180.25, 6)
    expect(result.map.clips).toHaveLength(2)
    expect(result.map.clips[0].startSec).toBe(0)
    expect(result.map.clips[0].anchorSec).toBeCloseTo(0.35, 6)
    expect(result.map.clips[1].startSec).toBeCloseTo(60.25, 6)
    expect(result.map.clips[1].anchorSec).toBeCloseTo(60.3, 6)
    expect(result.projection.firstBeatMs).toBeCloseTo(350, 3)

    const audioProjection = projectSongBeatGridMapV2ToFixedGrid(audioMap)
    expect(audioProjection).not.toBeNull()
    if (audioProjection) {
      expect(result.projection.firstBeatMs).toBeCloseTo(audioProjection.firstBeatMs + 250, 3)
      expect(result.projection.bpm).toBeCloseTo(audioProjection.bpm, 6)
      expect(result.projection.downbeatBeatOffset).toBe(audioProjection.downbeatBeatOffset)
    }
  })

  it('round-trips back to the same audio clips without double-applying the offset', () => {
    const audioMap = createAudioMap()
    expect(audioMap).not.toBeNull()
    if (!audioMap) return
    const timeline = convertDynamicAudioGridMapToTimeline({
      beatGridMap: audioMap,
      audioDurationSec: 180,
      timeBasisOffsetMs: 250
    })
    expect(timeline.status).toBe('ok')
    if (timeline.status !== 'ok') return
    const roundTrip = convertDynamicTimelineGridMapToAudio({
      beatGridMap: timeline.map,
      timelineDurationSec: 180.25,
      timeBasisOffsetMs: 250,
      audioDurationSec: 180
    })
    expect(roundTrip.status).toBe('ok')
    if (roundTrip.status !== 'ok') return
    expect(roundTrip.map.clips).toHaveLength(2)
    expect(roundTrip.map.clips[0].anchorSec).toBeCloseTo(0.1, 6)
    expect(roundTrip.map.clips[1].startSec).toBeCloseTo(60, 6)
    expect(roundTrip.map.clips[1].anchorSec).toBeCloseTo(60.05, 6)
  })

  it('rejects invalid offsets, durations and maps without clipping', () => {
    const audioMap = createAudioMap()
    expect(audioMap).not.toBeNull()
    if (!audioMap) return
    expect(
      convertDynamicAudioGridMapToTimeline({
        beatGridMap: audioMap,
        audioDurationSec: 180,
        timeBasisOffsetMs: -1
      }).status
    ).toBe('error')
    expect(
      convertDynamicAudioGridMapToTimeline({
        beatGridMap: audioMap,
        audioDurationSec: 180,
        timeBasisOffsetMs: 250,
        timelineDurationSec: 180
      }).status
    ).toBe('error')
    expect(
      convertDynamicAudioGridMapToTimeline({
        beatGridMap: null,
        audioDurationSec: 180,
        timeBasisOffsetMs: 250
      }).status
    ).toBe('error')
  })

  it('rejects timeline clips that fall outside the timeline or collapse after inverse conversion', () => {
    const lateMap = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 },
        { startSec: 181, anchorSec: 181, bpm: 120, downbeatBeatOffset: 0 }
      ],
      'analysis',
      { allowSingleClip: true, durationSec: 200 }
    )
    expect(lateMap).not.toBeNull()
    if (!lateMap) return
    const outside = convertDynamicAudioGridMapToTimeline({
      beatGridMap: lateMap,
      audioDurationSec: 200,
      timeBasisOffsetMs: 0,
      timelineDurationSec: 180
    })
    expect(outside.status).toBe('error')

    const collapsedTimeline = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0.2, bpm: 120, downbeatBeatOffset: 0 },
        { startSec: 0.2, anchorSec: 0.2, bpm: 120, downbeatBeatOffset: 0 }
      ],
      'analysis',
      { allowSingleClip: true, durationSec: 100 }
    )
    expect(collapsedTimeline).not.toBeNull()
    if (!collapsedTimeline) return
    const collapsed = convertDynamicTimelineGridMapToAudio({
      beatGridMap: collapsedTimeline,
      timelineDurationSec: 100,
      timeBasisOffsetMs: 250,
      audioDurationSec: 99.75
    })
    expect(collapsed.status).toBe('error')
  })

  it('rejects invalid raw ordering, null offsets and loose duration relations before normalize', () => {
    const audioMap = createAudioMap()
    expect(audioMap).not.toBeNull()
    if (!audioMap) return
    const unsorted = {
      version: 2,
      source: 'analysis',
      clips: [
        { startSec: 0, anchorSec: 0.1, bpm: 120, downbeatBeatOffset: 0 },
        { startSec: 60, anchorSec: 60.05, bpm: 128, downbeatBeatOffset: 2 },
        { startSec: 30, anchorSec: 30.05, bpm: 124, downbeatBeatOffset: 1 }
      ]
    }
    expect(
      convertDynamicAudioGridMapToTimeline({
        beatGridMap: unsorted,
        audioDurationSec: 180,
        timeBasisOffsetMs: 250
      }).status
    ).toBe('error')
    expect(
      convertDynamicAudioGridMapToTimeline({
        beatGridMap: audioMap,
        audioDurationSec: 180,
        timeBasisOffsetMs: null
      }).status
    ).toBe('error')
    expect(
      convertDynamicAudioGridMapToTimeline({
        beatGridMap: audioMap,
        audioDurationSec: '180',
        timeBasisOffsetMs: 250
      }).status
    ).toBe('error')
    expect(
      convertDynamicAudioGridMapToTimeline({
        beatGridMap: audioMap,
        audioDurationSec: 180,
        timeBasisOffsetMs: 250,
        timelineDurationSec: 180.25 + 0.002
      }).status
    ).toBe('error')
  })

  it('derives a separate audio-duration crop without mutating the shared source map', () => {
    const source = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 },
        { startSec: 60, anchorSec: 60, bpm: 128, downbeatBeatOffset: 2 },
        { startSec: 120, anchorSec: 120, bpm: 100, downbeatBeatOffset: 1 }
      ],
      'manual',
      { allowSingleClip: true, durationSec: 180 }
    )
    expect(source).not.toBeNull()
    if (!source) return
    const before = JSON.stringify(source)
    const derived = deriveDynamicAudioGridMapForDuration({
      beatGridMap: source,
      audioDurationSec: 90
    })
    expect(derived.status).toBe('ok')
    if (derived.status !== 'ok') return
    expect(derived.map.clips).toHaveLength(2)
    expect(derived.map.clips[0].startSec).toBe(0)
    expect(derived.map.clips[1].startSec).toBeCloseTo(60, 6)
    expect(derived.map.clips[1].anchorSec).toBeCloseTo(60, 6)
    expect(JSON.stringify(source)).toBe(before)
  })
})
