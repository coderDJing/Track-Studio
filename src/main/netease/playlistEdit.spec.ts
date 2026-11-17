// Run: pnpm exec vitest run src/main/netease/playlistEdit.spec.ts
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  applyRemovedPlaylistTracks,
  assertPlaylistTracksEditable,
  findPlaylistRecord
} from './playlistEdit'

const setup = () => {
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
    CREATE TABLE netease_playlist_item (
      list_root    TEXT NOT NULL,
      playlist_id  TEXT NOT NULL,
      song_id      TEXT NOT NULL,
      position     INTEGER NOT NULL,
      PRIMARY KEY (list_root, playlist_id, song_id)
    );
    CREATE TABLE netease_track (
      list_root TEXT NOT NULL,
      song_id   TEXT NOT NULL,
      title     TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (list_root, song_id)
    );
    CREATE TABLE netease_file (
      list_root TEXT NOT NULL,
      song_id   TEXT NOT NULL,
      file_path TEXT NOT NULL,
      PRIMARY KEY (list_root, song_id)
    );
  `)
  const insertPlaylist = db.prepare(
    `INSERT INTO netease_playlist
      (list_root, user_id, playlist_id, kind, title, track_count, sort_index)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  insertPlaylist.run('root', 'u1', '100', 'created', '我的歌单', 4, 0)
  insertPlaylist.run('root', 'u2', '100', 'created', '旧账号同名', 4, 1)
  insertPlaylist.run('root', 'u1', '200', 'subscribed', '收藏的歌单', 1, 0)
  db.exec(`
    INSERT INTO netease_playlist_item (list_root, playlist_id, song_id, position) VALUES
      ('root', '100', '11', 0),
      ('root', '100', '22', 1),
      ('root', '100', '33', 2),
      ('root', '100', '44', 3),
      ('root', '200', '22', 0);
    INSERT INTO netease_track (list_root, song_id, title) VALUES
      ('root', '11', 'A'), ('root', '22', 'B'), ('root', '33', 'C'), ('root', '44', 'D');
    INSERT INTO netease_file (list_root, song_id, file_path) VALUES
      ('root', '22', '.store/22.flac');
  `)
  return db
}

describe('playlistEdit', () => {
  it('只允许自己创建的歌单和「我喜欢的音乐」改曲目', () => {
    expect(() => assertPlaylistTracksEditable('created')).not.toThrow()
    expect(() => assertPlaylistTracksEditable('liked')).not.toThrow()
    expect(() => assertPlaylistTracksEditable('subscribed')).toThrow(/收藏/)
    expect(() => assertPlaylistTracksEditable('album')).toThrow(/收藏/)
  })

  it('优先取当前登录账号的歌单记录', () => {
    const db = setup()
    const preferred = findPlaylistRecord(db, 'root', '100', 'u1')
    const fallback = findPlaylistRecord(db, 'root', '100', 'missing')
    expect(preferred?.title).toBe('我的歌单')
    expect(preferred?.userId).toBe('u1')
    expect(fallback?.title).toBe('我的歌单')
    db.close()
  })

  it('移出曲目后重排位置、更新首数，并保留其它歌单关系和本地文件', () => {
    const db = setup()
    const result = applyRemovedPlaylistTracks(db, 'root', '100', ['22', '22', '33', '99'])
    expect(result.removedIds).toEqual(['22', '33'])
    expect(result.trackCount).toBe(2)

    const items = db
      .prepare(
        `SELECT song_id, position FROM netease_playlist_item
          WHERE list_root = 'root' AND playlist_id = '100'
          ORDER BY position ASC`
      )
      .all() as Array<{ song_id: string; position: number }>
    expect(items).toEqual([
      { song_id: '11', position: 0 },
      { song_id: '44', position: 1 }
    ])

    const counts = db
      .prepare(
        `SELECT user_id, track_count FROM netease_playlist WHERE playlist_id = '100' ORDER BY user_id`
      )
      .all() as Array<{ user_id: string; track_count: number }>
    expect(counts).toEqual([
      { user_id: 'u1', track_count: 2 },
      { user_id: 'u2', track_count: 2 }
    ])

    expect(
      db.prepare(`SELECT song_id FROM netease_playlist_item WHERE playlist_id = '200'`).all()
    ).toEqual([{ song_id: '22' }])
    expect(db.prepare(`SELECT song_id FROM netease_track ORDER BY song_id`).all()).toHaveLength(4)
    expect(db.prepare(`SELECT song_id FROM netease_file`).all()).toEqual([{ song_id: '22' }])
    db.close()
  })
})
