import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ISongInfo } from '../../types/globals'
import { closeLibraryDb, initLibraryDb } from '../libraryDb'
import store from '../store'
import { loadPlaylistViewSnapshotMeta, savePlaylistViewSnapshot } from './playlistViewSnapshot'
import { loadSongCache, replaceSongCache } from './songCache'
import type { SongCacheEntry } from './types'

const temporaryRoots: string[] = []
const previousDatabaseDir = store.databaseDir

const createSong = (filePath: string, title: string): ISongInfo => ({
  filePath,
  fileName: path.basename(filePath),
  fileFormat: 'MP3',
  cover: null,
  title,
  artist: undefined,
  album: undefined,
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: 'MPEG'
})

const createLibraryRoot = async (): Promise<{ root: string; listRoot: string }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-song-cache-replace-'))
  const listRoot = path.join(root, 'library', 'Local', 'Playlist')
  temporaryRoots.push(root)
  await fs.mkdir(listRoot, { recursive: true })
  store.databaseDir = root
  expect(initLibraryDb(root)).not.toBeNull()
  return { root, listRoot }
}

const toEntries = (songs: ISongInfo[]): Map<string, SongCacheEntry> =>
  new Map(
    songs.map((song, index) => [
      song.filePath,
      { size: 100 + index, mtimeMs: 1_000 + index, info: song }
    ])
  )

afterEach(async () => {
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe('replaceSongCache', () => {
  it('updates and removes only changed entries, while preserving an unchanged snapshot', async () => {
    const { listRoot } = await createLibraryRoot()
    const first = path.join(listRoot, 'first.mp3')
    const second = path.join(listRoot, 'second.mp3')
    const initial = toEntries([createSong(first, 'First'), createSong(second, 'Second')])

    await expect(replaceSongCache(listRoot, initial)).resolves.toBe(true)
    expect(
      savePlaylistViewSnapshot({
        songListUUID: 'song-cache-replace',
        listRoot,
        identityDigest: 'identity',
        items: []
      })
    ).not.toBeNull()

    await expect(replaceSongCache(listRoot, initial)).resolves.toBe(true)
    expect(loadPlaylistViewSnapshotMeta('song-cache-replace')?.verifiedAtMs).toBeGreaterThan(0)

    const changed = toEntries([createSong(first, 'First updated')])
    await expect(replaceSongCache(listRoot, changed)).resolves.toBe(true)

    const cache = await loadSongCache(listRoot)
    expect(cache?.size).toBe(1)
    const cachedSong = cache ? [...cache.values()][0] : undefined
    expect(cachedSong?.info.title).toBe('First updated')
    expect(loadPlaylistViewSnapshotMeta('song-cache-replace')?.verifiedAtMs).toBe(0)
  })

  it('can defer snapshot invalidation until the caller saves the matching scan result', async () => {
    const { listRoot } = await createLibraryRoot()
    const filePath = path.join(listRoot, 'track.mp3')
    await replaceSongCache(listRoot, toEntries([createSong(filePath, 'Original')]))
    expect(
      savePlaylistViewSnapshot({
        songListUUID: 'song-cache-deferred',
        listRoot,
        identityDigest: 'identity',
        items: []
      })
    ).not.toBeNull()

    await expect(
      replaceSongCache(listRoot, toEntries([createSong(filePath, 'Updated')]), {
        markSnapshotStale: false
      })
    ).resolves.toBe(true)

    expect(loadPlaylistViewSnapshotMeta('song-cache-deferred')?.verifiedAtMs).toBeGreaterThan(0)
  })
})
