import { describe, expect, it, vi } from 'vitest'
import { createMixtapeSongMetadataSync } from './mixtapeSongMetadataSync'
import { parseSnapshot } from './mixtapeTrackSnapshot'

const setup = () => {
  const item = { id: 'track', filePath: '/music/track.mp3', infoJson: '{}' }
  const tracks = { value: [parseSnapshot(item, 0, 'Unknown')] }
  const mixtapeRawItems = { value: [item] }
  const refresh = vi.fn()
  const handlers = createMixtapeSongMetadataSync({
    tracks,
    mixtapeRawItems,
    normalizeMixtapeFilePath: (value) => (typeof value === 'string' ? value : ''),
    normalizeBpm: (value) => Number(value) || null,
    normalizeFirstBeatMs: Number,
    normalizeDownbeatBeatOffset: Number,
    refreshMixtapeTrackDerivedUi: refresh
  })
  return { tracks, mixtapeRawItems, refresh, ...handlers }
}

describe('Mixtape live cue updates', () => {
  it('updates both cue kinds in place and persists the in-memory snapshot without reloading the timeline', () => {
    const s = setup(),
      array = s.tracks.value,
      original = s.tracks.value[0]
    s.handleSongHotCuesUpdated(null, {
      filePath: original.filePath,
      hotCues: [{ slot: 0, sec: 12 }]
    })
    s.handleSongMemoryCuesUpdated(null, { filePath: original.filePath, memoryCues: [{ sec: 20 }] })
    expect(s.tracks.value).toBe(array)
    expect(s.tracks.value[0]).toBe(original)
    expect(original.hotCues).toMatchObject([{ slot: 0, sec: 12 }])
    expect(original.memoryCues).toMatchObject([{ sec: 20 }])
    expect(JSON.parse(s.mixtapeRawItems.value[0].infoJson)).toMatchObject({
      hotCues: [{ sec: 12 }],
      memoryCues: [{ sec: 20 }]
    })
    expect(s.refresh).not.toHaveBeenCalled()
  })

  it('makes no assignments for duplicate/unrelated updates and removes deleted cues', () => {
    const s = setup(),
      filePath = s.tracks.value[0].filePath
    const update = { filePath, hotCues: [{ slot: 0, sec: 12 }] }
    s.handleSongHotCuesUpdated(null, update)
    const cues = s.tracks.value[0].hotCues,
      raw = s.mixtapeRawItems.value
    s.handleSongHotCuesUpdated(null, update)
    s.handleSongHotCuesUpdated(null, { ...update, filePath: '/other.mp3' })
    expect(s.tracks.value[0].hotCues).toBe(cues)
    expect(s.mixtapeRawItems.value).toBe(raw)
    s.handleSongHotCuesUpdated(null, { filePath, hotCues: [] })
    expect(s.tracks.value[0].hotCues).toEqual([])
  })
})
