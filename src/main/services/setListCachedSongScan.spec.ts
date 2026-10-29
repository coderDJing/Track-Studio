// Run: pnpm exec vitest run src/main/services/setListCachedSongScan.spec.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeLibraryDb, initLibraryDb, type SqliteDatabase } from '../libraryDb'
import store from '../store'
import type { ISongInfo } from '../../types/globals'
import {
  combineCurrentSetSongCache,
  loadSetSongCacheCandidates,
  pickCurrentSetSongCache,
  setSongCacheLookupKey,
  type SetSongCacheCandidate
} from './setListCachedSongScan'

const previousDatabaseDir = store.databaseDir
let root = ''
let db: SqliteDatabase

const song = (title: string, analysisOnly = false): ISongInfo =>
  ({
    filePath: '',
    fileName: `${title}.mp3`,
    title,
    artist: 'Artist',
    duration: '03:00',
    analysisOnly
  }) as ISongInfo

const candidate = (
  listRoot: string,
  title: string,
  overrides: Partial<SetSongCacheCandidate> = {}
): SetSongCacheCandidate => ({
  listRoot,
  size: 100,
  mtimeMs: 1_000,
  info: song(title),
  analysisOnly: false,
  ...overrides
})

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-set-cache-'))
  await fs.mkdir(path.join(root, 'library'))
  store.databaseDir = root
  const instance = initLibraryDb(root)
  if (!instance) throw new Error('test database did not open')
  db = instance
})

afterEach(async () => {
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  await fs.rm(root, { recursive: true, force: true })
})

describe('set song cache selection', () => {
  const stats = { size: 100, mtimeMs: 1_000 }

  it('uses a cache row whose size and mtime still match the file', () => {
    const picked = pickCurrentSetSongCache(
      [candidate('library/FilterLibrary/House', 'Keep')],
      stats,
      ''
    )
    expect(picked?.info.title).toBe('Keep')
  })

  it('prefers the origin playlist when several current rows exist', () => {
    const origin = path.join(root, 'library', 'FilterLibrary', 'House')
    const picked = pickCurrentSetSongCache(
      [
        candidate('library/Other', 'Other'),
        candidate(path.join('library', 'FilterLibrary', 'House'), 'Origin')
      ],
      stats,
      origin
    )
    expect(picked?.info.title).toBe('Origin')
  })

  it('rejects stale, analysis-only, and title-less rows', () => {
    expect(
      pickCurrentSetSongCache([candidate('library/A', 'Stale', { mtimeMs: 2_000 })], stats, '')
    ).toBeNull()
    expect(
      pickCurrentSetSongCache(
        [candidate('library/A', 'Analysis', { analysisOnly: true, info: song('Analysis', true) })],
        stats,
        ''
      )
    ).toBeNull()
    expect(
      pickCurrentSetSongCache(
        [candidate('library/A', '', { info: { filePath: 'x.mp3' } as ISongInfo })],
        stats,
        ''
      )
    ).toBeNull()
  })
})

describe('set song cache lookup', () => {
  const insert = (
    listRoot: string,
    filePath: string,
    info: ISongInfo,
    size = 100,
    mtimeMs = 1_000
  ) => {
    db.prepare(
      'INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
    ).run(listRoot, filePath, size, mtimeMs, JSON.stringify(info))
  }

  it('finds a row stored with a playlist-relative file_path and an absolute info path', async () => {
    const filePath = path.join(root, 'library', 'FilterLibrary', 'House', 'track.mp3')
    insert(path.join('library', 'FilterLibrary', 'House'), 'track.mp3', {
      ...song('Cached'),
      filePath
    })

    const loaded = await loadSetSongCacheCandidates([filePath])
    const picked = pickCurrentSetSongCache(
      loaded.get(setSongCacheLookupKey(filePath)) || [],
      { size: 100, mtimeMs: 1_000 },
      ''
    )
    expect(picked?.info.title).toBe('Cached')
  })

  it('still finds a legacy row whose file_path column is absolute', async () => {
    const filePath = path.join(root, 'library', 'FilterLibrary', 'House', 'legacy.mp3')
    insert('library/FilterLibrary/House', filePath, { ...song('Legacy'), filePath: '' })

    const loaded = await loadSetSongCacheCandidates([filePath])
    const picked = pickCurrentSetSongCache(
      loaded.get(setSongCacheLookupKey(filePath)) || [],
      { size: 100, mtimeMs: 1_000 },
      ''
    )
    expect(picked?.info.title).toBe('Legacy')
  })
})

describe('set song cache analysis merge', () => {
  it('fills missing analysis from another current row without replacing the display title', () => {
    const display = candidate('library/FilterLibrary/House', 'Display')
    const analysis = candidate('library/Other', 'Hidden', {
      analysisOnly: true,
      info: { ...song('Hidden', true), key: '8A' }
    })
    const combined = combineCurrentSetSongCache(
      display,
      [analysis, display],
      { size: 100, mtimeMs: 1_000 },
      (target, source) => ({
        ...target,
        key: target.key || source.key
      })
    )
    expect(combined.title).toBe('Display')
    expect(combined.key).toBe('8A')
  })

  it('keeps cues the user cleared on the display row', () => {
    const display = candidate('library/FilterLibrary/House', 'Display', {
      info: { ...song('Display'), hotCues: [], memoryCues: [] }
    })
    const stale = candidate('library/Other', 'Stale', {
      info: { ...song('Stale'), hotCues: [{ slot: 0, sec: 1 }], memoryCues: [{ sec: 2 }] }
    })
    const combined = combineCurrentSetSongCache(
      display,
      [display, stale],
      { size: 100, mtimeMs: 1_000 },
      (target, source) => ({ ...target, hotCues: source.hotCues, memoryCues: source.memoryCues })
    )
    expect(combined.hotCues).toEqual([])
    expect(combined.memoryCues).toEqual([])
  })
})
