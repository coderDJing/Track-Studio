// Run: pnpm exec vitest run src/main/netease/schema.spec.ts
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { applyNeteaseSchema } from './schema'

const columnNames = (db: InstanceType<typeof Database>, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).map((row) =>
    String(row.name || '')
  )

describe('applyNeteaseSchema', () => {
  it('给没有 sync_state 的旧库补列，默认 ok，且重复执行不报错', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE netease_playlist (
        list_root    TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        playlist_id  TEXT NOT NULL,
        kind         TEXT NOT NULL,
        title        TEXT NOT NULL,
        cover_url    TEXT NOT NULL DEFAULT '',
        track_count  INTEGER NOT NULL DEFAULT 0,
        sort_index   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (list_root, user_id, playlist_id)
      );
    `)

    applyNeteaseSchema(db)
    applyNeteaseSchema(db)

    expect(columnNames(db, 'netease_playlist')).toContain('sync_state')
    db.prepare(
      `INSERT INTO netease_playlist (list_root, user_id, playlist_id, kind, title)
       VALUES ('root', 'u1', 'pl1', 'created', 't')`
    ).run()
    const row = db
      .prepare(`SELECT sync_state FROM netease_playlist WHERE playlist_id = 'pl1'`)
      .get() as { sync_state: string }
    expect(row.sync_state).toBe('ok')
  })
})
