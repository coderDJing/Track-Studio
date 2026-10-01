import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import * as beatGrid from '@shared/songBeatGridMapV2'
import { useHorizontalBrowseSongBeatGridLookup } from './useHorizontalBrowseSongBeatGridLookup'

const createDynamicMap = () =>
  beatGrid.createSongBeatGridMapV2FromClips(
    [
      { startSec: 0, anchorSec: 0.125, bpm: 120, downbeatBeatOffset: 0 },
      { startSec: 10, anchorSec: 10.25, bpm: 150, downbeatBeatOffset: 2 }
    ],
    'manual'
  )

afterEach(() => vi.restoreAllMocks())

describe('playback beat grid lookup', () => {
  it('builds once across playback ticks and retains boundary, seek and clamping behavior', () => {
    const map = ref(createDynamicMap())
    const duration = ref(30)
    const seconds = [-1, 0, 9.9, 9.999999, 10, 10.001, 20, 30, 40, Number.NaN]
    const expected = seconds.map((sec) =>
      beatGrid.resolveSongBeatGridV2BpmAtSec(map.value, duration.value, sec)
    )
    const build = vi.spyOn(beatGrid, 'createSongBeatGridRuntimeV2')
    const lookup = useHorizontalBrowseSongBeatGridLookup({
      beatGridMap: () => map.value,
      durationSeconds: () => duration.value
    })
    expect(seconds.map(lookup.resolveBpmAtSeconds)).toEqual(expected)
    const runtime = lookup.runtime.value
    for (let tick = 0; tick < 500; tick += 1) {
      expect(lookup.resolveBpmAtSeconds(tick / 100)).toBe(120)
      expect(lookup.runtime.value).toBe(runtime)
    }
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('rebuilds on in-place grid edits and duration changes without a global cache', () => {
    const song = ref({ beatGridMap: createDynamicMap(), duration: 30 })
    const build = vi.spyOn(beatGrid, 'createSongBeatGridRuntimeV2')
    const lookup = useHorizontalBrowseSongBeatGridLookup({
      beatGridMap: () => song.value.beatGridMap,
      durationSeconds: () => song.value.duration
    })
    expect(lookup.resolveBpmAtSeconds(11)).toBe(150)
    const previous = lookup.runtime.value
    if (!song.value.beatGridMap) throw new Error('missing grid')
    song.value.beatGridMap.clips[1].bpm = 180
    song.value.beatGridMap.clips[1].anchorSec = 10.5
    expect(lookup.resolveBpmAtSeconds(11)).toBe(180)
    expect(lookup.runtime.value).not.toBe(previous)
    expect(lookup.runtime.value?.clips[1].anchorSec).toBe(10.5)
    song.value.duration = 40
    expect(lookup.runtime.value?.durationSec).toBe(40)
    expect(build).toHaveBeenCalledTimes(3)
  })

  it('clears stale runtime when a song is replaced, removed or has invalid duration', () => {
    const song = ref({ beatGridMap: createDynamicMap(), duration: 30 })
    const lookup = useHorizontalBrowseSongBeatGridLookup({
      beatGridMap: () => song.value.beatGridMap,
      durationSeconds: () => song.value.duration
    })
    expect(lookup.resolveBpmAtSeconds(11)).toBe(150)
    song.value = {
      beatGridMap: beatGrid.createSongBeatGridMapV2FromFixedGrid({
        bpm: 174,
        firstBeatMs: 0,
        downbeatBeatOffset: 0
      }),
      duration: 272
    }
    expect(lookup.resolveBpmAtSeconds(11)).toBe(174)
    expect(lookup.runtime.value?.durationSec).toBe(272)
    song.value.duration = 0
    expect(lookup.runtime.value).toBeNull()
    expect(lookup.resolveBpmAtSeconds(11)).toBeNull()
    song.value = { beatGridMap: null, duration: 272 }
    expect(lookup.runtime.value).toBeNull()
  })

  it('keeps separate deck runtimes when only one deck grid changes', () => {
    const top = ref(createDynamicMap())
    const bottom = ref(createDynamicMap())
    const topLookup = useHorizontalBrowseSongBeatGridLookup({
      beatGridMap: () => top.value,
      durationSeconds: () => 30
    })
    const bottomLookup = useHorizontalBrowseSongBeatGridLookup({
      beatGridMap: () => bottom.value,
      durationSeconds: () => 30
    })
    expect(topLookup.resolveBpmAtSeconds(11)).toBe(150)
    expect(bottomLookup.resolveBpmAtSeconds(11)).toBe(150)
    const bottomRuntime = bottomLookup.runtime.value
    if (!top.value) throw new Error('missing grid')
    top.value.clips[1].bpm = 180
    expect(topLookup.resolveBpmAtSeconds(11)).toBe(180)
    expect(bottomLookup.resolveBpmAtSeconds(11)).toBe(150)
    expect(bottomLookup.runtime.value).toBe(bottomRuntime)
  })
})
