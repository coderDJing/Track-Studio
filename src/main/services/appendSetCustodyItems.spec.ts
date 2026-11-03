// Run: pnpm exec vitest run src/main/services/appendSetCustodyItems.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import type { ISongInfo } from '../../types/globals'
import store from '../store'
import { appendSetItems } from '../setListDb'
import { removeSongCacheEntry, upsertSongCacheEntry } from '../libraryCacheDb'
import { scanSongList } from './scanSongs'
import { appendSetCustodyItems } from './appendSetCustodyItems'
import { getSetCustodyDirAbs } from './setCustody'

vi.mock('../store', () => ({ default: { databaseDir: '', settingConfig: { audioExt: ['mp3'] } } }))
vi.mock('../coreLibraries', () => ({ getCoreFsDirName: () => 'SetLibrary' }))
vi.mock('../libraryTreeDb', () => ({
  loadLibraryNodes: () => [{ uuid: 'set', nodeType: 'setList' }]
}))
vi.mock('../setListDb', () => ({ appendSetItems: vi.fn() }))
vi.mock('../libraryCacheDb', () => ({
  upsertSongCacheEntry: vi.fn(),
  removeSongCacheEntry: vi.fn(async () => true)
}))
vi.mock('./scanSongs', () => ({ scanSongList: vi.fn() }))

let root = ''
const song = (filePath: string): ISongInfo => ({
  filePath,
  fileName: path.basename(filePath),
  fileFormat: 'MP3',
  cover: null,
  duration: '03:00',
  title: 'USB Track',
  artist: 'Artist',
  album: undefined,
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined,
  bpm: 128,
  externalSourceKind: 'usb',
  pioneerUsbSource: { rootPath: root, libraryType: 'oneLibrary', trackId: 7 },
  hotCues: [{ slot: 0, sec: 12, label: 'Start' }],
  memoryCues: [{ sec: 24, comment: 'Verse' }],
  beatGridMap: {
    version: 2,
    source: 'rekordbox',
    signature: 'test',
    clips: [{ startSec: 0, anchorSec: 0.1, bpm: 128, downbeatBeatOffset: 0 }]
  }
})

beforeEach(async () => {
  vi.clearAllMocks()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-set-custody-'))
  store.databaseDir = path.join(root, 'database')
  vi.mocked(upsertSongCacheEntry).mockResolvedValue(true)
  vi.mocked(appendSetItems).mockImplementation((playlistUuid, items) =>
    items.map((item, index) => ({
      ...item,
      id: String(index),
      playlistUuid,
      sortOrder: index + 1,
      createdAtMs: 1
    }))
  )
  vi.mocked(scanSongList).mockImplementation(async (paths, _exts, songListUUID) => ({
    scanData: (Array.isArray(paths) ? paths : [paths]).map(
      (filePath) =>
        ({
          filePath,
          fileName: path.basename(filePath),
          fileFormat: 'MP3',
          title: 'Read from disk',
          cover: null,
          duration: '03:00'
        }) as ISongInfo
    ),
    songListUUID,
    missingWaveformFilePaths: [],
    playlistTrackNumbering: null,
    cacheIdentityVerified: true,
    identityDigest: '',
    perf: {
      listFilesMs: 0,
      cacheCheckMs: 0,
      parseMetadataMs: 0,
      totalMs: 0,
      filesCount: 0,
      successCount: 0,
      failedCount: 0,
      cacheHits: 0,
      parsedCount: 0,
      cacheLoadedFromDb: false,
      cacheLoadMs: 0,
      cacheRows: 0,
      cacheMisses: { noEntry: 0, sizeMismatch: 0, mtimeMismatch: 0, analysisOnly: 0 },
      cacheRootResolveMs: 0,
      identityDigestMs: 0,
      waveformAvailabilityMs: 0,
      cacheMatchMs: 0,
      metadataModuleLoadMs: 0,
      cacheWriteMs: 0,
      cacheWriteDeferred: false,
      trackFinalizeMs: 0,
      statMs: 0,
      listMode: 'js',
      skippedCount: 0,
      refreshMissingMs: 0,
      refreshMissingCount: 0,
      refreshMissingChangedCount: 0
    }
  }))
})

afterEach(async () => {
  await fs.remove(root)
})

describe('external songs in SET custody', () => {
  it('keeps USB files intact and stores local audio, grid and cues without USB runtime identity', async () => {
    const sourcePath = path.join(root, 'usb', 'track.mp3')
    await fs.outputFile(sourcePath, 'original audio')
    const source = song(sourcePath)
    const inserted = await appendSetCustodyItems({
      playlistUuid: 'set',
      items: [{ song: source, originPathSnapshot: 'USB / Playlist' }]
    })
    expect(await fs.readFile(sourcePath, 'utf8')).toBe('original audio')
    expect(await fs.readFile(inserted[0].filePath, 'utf8')).toBe('original audio')
    expect(inserted[0].filePath.startsWith(getSetCustodyDirAbs() + path.sep)).toBe(true)
    expect(inserted[0].originPathSnapshot).toBe('USB / Playlist')
    const cache = vi.mocked(upsertSongCacheEntry).mock.calls[0][2]
    expect(cache.info).toMatchObject({
      filePath: inserted[0].filePath,
      title: 'Read from disk',
      bpm: 128,
      beatGridMap: source.beatGridMap,
      hotCues: source.hotCues,
      memoryCues: source.memoryCues
    })
    expect(cache.info).not.toHaveProperty('externalSourceKind')
    expect(cache.info).not.toHaveProperty('pioneerUsbSource')
  })

  it('preserves duplicate rows while keeping different files with the same name separate', async () => {
    const first = path.join(root, 'usb', 'a', 'track.mp3')
    const second = path.join(root, 'usb', 'b', 'track.mp3')
    await fs.outputFile(first, 'first')
    await fs.outputFile(second, 'second')
    const inserted = await appendSetCustodyItems({
      playlistUuid: 'set',
      items: [first, second, first].map((filePath) => ({ song: song(filePath) }))
    })
    expect(inserted).toHaveLength(3)
    expect(inserted[0].filePath).toBe(inserted[2].filePath)
    expect(inserted[0].filePath).not.toBe(inserted[1].filePath)
    expect(await fs.readFile(inserted[1].filePath, 'utf8')).toBe('second')
    expect(upsertSongCacheEntry).toHaveBeenCalledTimes(2)
  })

  it('removes copied files and caches if append fails, retaining the USB source', async () => {
    const sourcePath = path.join(root, 'track.mp3')
    await fs.outputFile(sourcePath, 'audio')
    vi.mocked(appendSetItems).mockReturnValue([])
    await expect(
      appendSetCustodyItems({
        playlistUuid: 'set',
        items: [{ song: song(sourcePath) }]
      })
    ).rejects.toThrow('加入 SET 歌单失败')
    expect(await fs.readdir(getSetCustodyDirAbs())).toEqual([])
    expect(await fs.readFile(sourcePath, 'utf8')).toBe('audio')
    expect(removeSongCacheEntry).toHaveBeenCalledOnce()
  })

  it('does not add a partial batch when a source file is missing', async () => {
    const sourcePath = path.join(root, 'track.mp3')
    await fs.outputFile(sourcePath, 'audio')
    await expect(
      appendSetCustodyItems({
        playlistUuid: 'set',
        items: [sourcePath, path.join(root, 'missing.mp3')].map((filePath) => ({
          song: song(filePath)
        }))
      })
    ).rejects.toThrow()
    expect(appendSetItems).not.toHaveBeenCalled()
    expect(await fs.readdir(getSetCustodyDirAbs())).toEqual([])
    expect(await fs.readFile(sourcePath, 'utf8')).toBe('audio')
  })
})
