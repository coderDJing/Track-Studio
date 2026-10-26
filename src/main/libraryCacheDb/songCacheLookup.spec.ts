import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeLibraryDb, initLibraryDb, type SqliteDatabase } from '../libraryDb'
import { applyLibraryDbSchema } from '../libraryDbSchema'
import store from '../store'
import { loadSongCacheEntry } from './songCache'
import { listPlaylistViewSnapshotVerificationCandidates } from './playlistViewSnapshot'
import { normalizedSongCachePathSql } from './songCachePathSql'

const previousDatabaseDir = store.databaseDir
let root: string
let db: SqliteDatabase

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-cache-lookup-'))
  await fs.mkdir(path.join(root, 'library'))
  store.databaseDir = root
  const instance = initLibraryDb(root)
  if (!instance) throw new Error('test database did not open')
  db = instance
})

afterEach(async () => {
  vi.restoreAllMocks()
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  await fs.rm(root, { recursive: true, force: true })
})

const insert = (listRoot: string, filePath: string, info: string) =>
  db.prepare('INSERT INTO song_cache VALUES (?, ?, 100, 123, ?)').run(listRoot, filePath, info)

describe('song cache indexed path lookups', () => {
  it('keeps every legacy and missing-path lookup indexed with the installed schema', async () => {
    // 既有库仍使用原索引，不依赖重建库或变更 user_version 才修好查询。
    applyLibraryDbSchema(db, 39)
    const listRoot = path.join(root, 'library', 'AI生成')
    insert('library\\other', 'existing.wav', JSON.stringify({ title: 'existing' }))
    const prepare = vi.spyOn(db, 'prepare')
    await expect(
      loadSongCacheEntry(listRoot, path.join(listRoot, 'missing.wav'))
    ).resolves.toBeNull()
    const queries = new Set(
      prepare.mock.calls.map(([sql]) => sql).filter((sql) => /^SELECT .*FROM song_cache/.test(sql))
    )
    expect(queries.size).toBeGreaterThanOrEqual(5)
    prepare.mockRestore()
    for (const sql of queries) {
      const parameters = Array.from({ length: (sql.match(/\?/g) || []).length }, () => 'missing')
      const plan = db.prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)
      expect(plan.map((row) => row.detail).join('\n'), sql).toMatch(/SEARCH song_cache USING/)
      expect(plan.map((row) => row.detail).join('\n'), sql).not.toMatch(/SCAN song_cache/)
    }
  })

  it('matches mixed separators and ASCII case in old cache keys', async () => {
    insert(
      'Library/AI生成',
      'Song.WAV',
      JSON.stringify({
        filePath: path.join(root, 'library', 'AI生成', 'Song.WAV'),
        key: '8A',
        bpm: 128
      })
    )
    const listRoot = path.join(root, 'library', 'AI生成')
    const result = await loadSongCacheEntry(listRoot, path.join(listRoot, 'song.wav'))
    expect(result?.info).toMatchObject({ key: '8A', bpm: 128 })
  })

  it('finds cross-playlist analysis by JSON absolute path and ignores invalid JSON', async () => {
    const listRoot = path.join(root, 'library', 'AI生成')
    const filePath = path.join(listRoot, 'song.wav')
    insert('library\\bad', 'bad.wav', '{invalid')
    insert(
      'library\\source',
      'source.wav',
      JSON.stringify({ filePath: filePath.replace(/\\/g, '/').toUpperCase(), key: '9A', bpm: 126 })
    )
    const result = await loadSongCacheEntry(listRoot, filePath)
    expect(result?.info).toMatchObject({ key: '9A', bpm: 126, filePath })
  })

  it('normalizes a slash to exactly one backslash in SQL', () => {
    const row = db
      .prepare<{ normalized: string }>(`SELECT ${normalizedSongCachePathSql('?')} AS normalized`)
      .get('Library/AI生成/Song.WAV')
    expect(row?.normalized).toBe('library\\ai生成\\song.wav')
  })

  it('reads verification metadata from a covering index without sorting snapshot JSON rows', () => {
    const prepare = vi.spyOn(db, 'prepare')
    listPlaylistViewSnapshotVerificationCandidates(3)
    const sql = prepare.mock.calls
      .map(([value]) => value)
      .find((value) => value.includes('ORDER BY verified_at_ms'))
    prepare.mockRestore()
    expect(sql).toBeDefined()
    const plan = db.prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).all(3)
    const details = plan.map((row) => row.detail).join('\n')
    expect(details).toContain('USING COVERING INDEX idx_playlist_view_snapshot_verification')
    expect(details).not.toContain('TEMP B-TREE')
  })
})
