// Run: pnpm exec vitest run src/main/libraryCacheDb/songCachePathSql.spec.ts
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureSongCachePathIndexes, normalizedSongCachePathSql } from './songCachePathSql'
import { registerFilePathComparison } from '../filePathComparison'

let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  registerFilePathComparison({
    function: (name, options, callback) => db.function(name, options, callback)
  })
  db.exec('CREATE TABLE song_cache (list_root TEXT, file_path TEXT, info_json TEXT)')
  const insert = db.prepare('INSERT INTO song_cache VALUES (?, ?, ?)')
  insert.run('/Volumes/Music', '/Volumes/Music/Track.mp3', '{}')
  insert.run('/Volumes/Music', '/Volumes/Music/track.mp3', '{}')
})
afterEach(() => db.close())
const adapter = () => ({
  exec: vi.fn((sql: string) => db.exec(sql)),
  prepare: (sql: string) => ({ get: (name: string) => db.prepare(sql).get(name) })
})

describe('platform-aware song cache SQL identity', () => {
  it('repairs legacy lowercase indexes for macOS and still uses an index for case-sensitive lookups', () => {
    const connection = adapter()
    db.exec(
      "CREATE INDEX idx_song_cache_file_normalized ON song_cache(REPLACE(LOWER(file_path), '/', '\\'))"
    )
    ensureSongCachePathIndexes(connection, false)
    const expression = normalizedSongCachePathSql('file_path', false)
    const value = normalizedSongCachePathSql('?', false)
    const sql = `SELECT file_path FROM song_cache WHERE ${expression} = ${value}`
    expect(
      db
        .prepare(sql)
        .all('/Volumes/Music/Track.mp3')
        .map((row) => row.file_path)
    ).toEqual(['/Volumes/Music/Track.mp3'])
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('/Volumes/Music/Track.mp3')
    expect(plan.some((row) => String(row.detail).includes('idx_song_cache_file_normalized'))).toBe(
      true
    )
    connection.exec.mockClear()
    ensureSongCachePathIndexes(connection, false)
    expect(connection.exec.mock.calls.some(([sql]) => sql.includes('DROP INDEX'))).toBe(false)
  })

  it('keeps Windows comparison insensitive to case and separators with the same indexed expression', () => {
    ensureSongCachePathIndexes(adapter(), true)
    const sql = `SELECT file_path FROM song_cache WHERE ${normalizedSongCachePathSql('file_path', true)} = ${normalizedSongCachePathSql('?', true)}`
    expect(db.prepare(sql).all('\\VOLUMES\\MUSIC\\TRACK.MP3')).toHaveLength(2)
    db.prepare('INSERT INTO song_cache VALUES (?, ?, ?)').run(
      'G:/音乐',
      'G:/音乐/Ä Track.mp3',
      '{}'
    )
    expect(db.prepare(sql).all('g:\\音乐\\ä track.mp3')).toHaveLength(1)
  })

  it('rebuilds comparison indexes when moving a library between macOS and Windows', () => {
    const connection = adapter()
    ensureSongCachePathIndexes(connection, false)
    connection.exec.mockClear()
    ensureSongCachePathIndexes(connection, true)
    expect(connection.exec.mock.calls.filter(([sql]) => sql.includes('DROP INDEX'))).toHaveLength(3)
  })
})
