import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { readSongCacheOffMainThread } from './songCacheReadWorker'
import type { SqliteDatabase } from '../libraryDb'

// pnpm run build 后运行：npx vitest run src/main/services/songCacheReadWorker.spec.ts
vi.mock('../workerPath', () => ({
  resolveMainWorkerPath: (_dirname: string, filename: string) =>
    path.resolve('out/main/workers', filename)
}))

const roots: string[] = []
const databases: SqliteDatabase[] = []
afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const createDatabase = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-cache-read-'))
  roots.push(root)
  const db = new Database(path.join(root, 'cache.sqlite'))
  databases.push(db)
  db.exec(`CREATE TABLE song_cache (
    list_root TEXT, file_path TEXT, size INTEGER, mtime_ms INTEGER, info_json TEXT,
    PRIMARY KEY (list_root, file_path)
  )`)
  db.prepare('INSERT INTO song_cache VALUES (?, ?, ?, ?, ?)').run(
    'library/test',
    'a.mp3',
    10,
    20,
    '{}'
  )
  return db
}

describe('song cache read worker', () => {
  it('reads committed updates and isolates concurrent requests by database and roots', async () => {
    const first = await createDatabase()
    const second = await createDatabase()
    second.exec("UPDATE song_cache SET file_path = 'b.mp3'")
    const [firstRows, secondRows] = await Promise.all([
      readSongCacheOffMainThread(first, ['library/test', 'missing']),
      readSongCacheOffMainThread(second, ['library/test'])
    ])
    expect(firstRows[0][0].file_path).toBe('a.mp3')
    expect(firstRows[1]).toEqual([])
    expect(secondRows[0][0].file_path).toBe('b.mp3')
    first.exec('UPDATE song_cache SET size = 99')
    expect((await readSongCacheOffMainThread(first, ['library/test']))[0][0].size).toBe(99)
  })

  it('keeps the main event loop responsive while a database lock blocks the read', async () => {
    const db = await createDatabase()
    // 先预热 worker，把启动时间与 SQLite 锁等待区分开。
    await readSongCacheOffMainThread(db, ['library/test'])
    const writer = new Database(db.name)
    writer.exec('BEGIN EXCLUSIVE')
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    const release = setTimeout(() => writer.exec('COMMIT'), 120)
    try {
      const rows = await readSongCacheOffMainThread(db, ['library/test'])
      expect(rows[0]).toHaveLength(1)
      expect(ticks).toBeGreaterThanOrEqual(3)
    } finally {
      clearTimeout(release)
      clearInterval(timer)
      if (writer.inTransaction) writer.exec('ROLLBACK')
      writer.close()
    }
  })

  it('uses the originating connection for uncommitted transaction data', async () => {
    const db = await createDatabase()
    db.exec('BEGIN; UPDATE song_cache SET size = 77')
    try {
      expect((await readSongCacheOffMainThread(db, ['library/test']))[0][0].size).toBe(77)
    } finally {
      db.exec('ROLLBACK')
    }
  })
})
