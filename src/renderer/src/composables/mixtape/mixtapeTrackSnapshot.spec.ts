import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import { parseSnapshot } from './mixtapeTrackSnapshot'

describe('mixtape track snapshot', () => {
  it('keeps Hot Cue and Memory Cue metadata for the timeline overlay', () => {
    const track = parseSnapshot(
      {
        infoJson: JSON.stringify({
          hotCues: [{ slot: 1, sec: 12, label: 'Drop', color: '#20c997', comment: 'First drop' }],
          memoryCues: [{ sec: 30, order: 0, comment: 'Mix out' }, { sec: -1 }]
        })
      },
      0,
      'Unknown'
    )
    expect(track.hotCues).toMatchObject([
      { slot: 1, sec: 12, label: 'Drop', color: '#20c997', comment: 'First drop' }
    ])
    expect(track.memoryCues).toMatchObject([{ sec: 30, order: 0, comment: 'Mix out' }])
  })
  it('uses the transient canonical v2 grid instead of an item JSON grid copy', () => {
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 3,
      source: 'analysis'
    })
    expect(beatGridMap).not.toBeNull()

    const track = parseSnapshot(
      {
        id: 'item-1',
        filePath: 'D:\\music\\track.wav',
        infoJson: JSON.stringify({
          title: 'Track',
          bpm: 111,
          firstBeatMs: 500,
          downbeatBeatOffset: 0,
          beatGridMap: { version: 1 }
        }),
        canonicalGrid: {
          beatGridMap,
          timeBasisOffsetMs: 7
        }
      },
      0,
      'Unknown'
    )

    expect(track.beatGridMap).toEqual(beatGridMap)
    expect(track.bpm).toBe(128)
    expect(track.firstBeatMs).toBe(125)
    expect(track.downbeatBeatOffset).toBe(3)
    expect(track.timeBasisOffsetMs).toBe(7)
  })
})
