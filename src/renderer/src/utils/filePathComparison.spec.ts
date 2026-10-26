// Run: pnpm exec vitest run src/renderer/src/utils/filePathComparison.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RendererFilePathMap,
  RendererFilePathSet,
  rendererFilePathKey,
  sameRendererFilePath,
  uniqueRendererFilePaths
} from './filePathComparison'
import { useHorizontalBrowseSongsRemoved } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseSongsRemoved'
import type { ISongInfo } from 'src/types/globals'
import { createSongRowPlaybackLookup } from './songRowPlaybackIdentity'

afterEach(() => vi.unstubAllGlobals())

describe.each([
  { platform: 'Win32', original: 'G:\\音乐\\Ä Track.mp3', alias: 'g:/音乐/ä track.mp3', count: 1 },
  {
    platform: 'MacIntel',
    original: '/Volumes/音乐/Track.mp3',
    alias: '/Volumes/音乐/track.mp3',
    count: 2
  }
])('$platform file identity', ({ platform, original, alias, count }) => {
  it('compares platform identity without changing filesystem spelling', () => {
    vi.stubGlobal('navigator', { platform })
    expect(sameRendererFilePath(original, alias)).toBe(count === 1)
    expect(uniqueRendererFilePaths([original, alias, original])).toEqual(
      count === 1 ? [original] : [original, alias]
    )
    expect(sameRendererFilePath(original, `${alias}.other`)).toBe(false)
  })

  it('uses aliases for cache reads, updates and deletes while retaining original iteration keys', () => {
    vi.stubGlobal('navigator', { platform })
    const map = new RendererFilePathMap([[original, 1]])
    expect(map.get(alias)).toBe(count === 1 ? 1 : undefined)
    map.set(alias, 2)
    expect(map.size).toBe(count)
    expect([...map.keys()]).toEqual(count === 1 ? [original] : [original, alias])
    expect(map.get(original)).toBe(count === 1 ? 2 : 1)
    expect(map.delete(alias)).toBe(true)
    expect(map.has(original)).toBe(count === 2)
    map.clear()
    expect(map.size).toBe(0)
    expect(map.has(alias)).toBe(false)
    map.set(alias, 3)
    expect([...map]).toEqual([[alias, 3]])
  })

  it('deduplicates pending paths and preserves set iteration and deletion semantics', () => {
    vi.stubGlobal('navigator', { platform })
    const pending = new RendererFilePathSet([original, alias])
    expect(pending.size).toBe(count)
    expect([...pending]).toEqual(count === 1 ? [original] : [original, alias])
    pending.delete(alias)
    expect(pending.has(original)).toBe(count === 2)
    pending.clear()
    pending.add(alias)
    expect([...pending]).toEqual([alias])
  })

  it('only ejects decks whose file was confirmed removed', () => {
    vi.stubGlobal('navigator', { platform })
    const loaded = { filePath: original } as ISongInfo
    const eject = vi.fn(async () => {})
    const listener = useHorizontalBrowseSongsRemoved({
      resolveDeckSong: (deck) => (deck === 'top' ? loaded : null),
      handleDeckEjectSong: eject
    })
    listener.handleSongsRemoved({ paths: [alias] })
    expect(eject).toHaveBeenCalledTimes(count === 1 ? 1 : 0)
  })

  it('maps a loaded SET song to the external library actual row ID', () => {
    vi.stubGlobal('navigator', { platform })
    const external = { filePath: original, mixtapeItemId: 'usb-track-42' } as ISongInfo
    const resolve = createSongRowPlaybackLookup(
      [external],
      (song) => song.mixtapeItemId || song.filePath
    )
    const loaded = { filePath: count === 1 ? alias : original, setItemId: 'set-entry' } as ISongInfo
    expect(resolve(loaded)).toEqual(['usb-track-42'])
    expect(resolve({ ...loaded, filePath: `${original}.different` })).toEqual([])
  })

  it('keeps opaque external row IDs case-sensitive even on Windows', () => {
    vi.stubGlobal('navigator', { platform })
    const first = { filePath: original, mixtapeItemId: 'Track-ID' } as ISongInfo
    const second = { filePath: original, mixtapeItemId: 'track-id' } as ISongInfo
    const resolve = createSongRowPlaybackLookup(
      [first, second],
      (song) => song.mixtapeItemId || song.filePath
    )
    expect(resolve(second)).toEqual(['track-id'])
  })
})

it('keeps absent values distinct from empty strings and handles missing renderer context', () => {
  vi.stubGlobal('navigator', undefined)
  expect(sameRendererFilePath(undefined, undefined)).toBe(true)
  expect(sameRendererFilePath(undefined, '')).toBe(false)
  expect(sameRendererFilePath(null, undefined)).toBe(false)
  expect(rendererFilePathKey(undefined)).toBe('')
  expect(sameRendererFilePath('/Music/A.mp3', '/Music/a.mp3')).toBe(false)
})
