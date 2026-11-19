// Run: pnpm exec vitest run src/main/netease/playlistEdit.spec.ts
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  applyDeletedPlaylist,
  applyRemovedPlaylistTracks,
  assertPlaylistDeletable,
  assertPlaylistTracksEditable,
  findPlaylistRecord,
  listExclusiveDownloadedSongIds
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
  insertPlaylist.run('root', 'u1', '300', 'created', '独有歌单', 2, 2)
  insertPlaylist.run('root', 'u1', '400', 'liked', '我喜欢的音乐', 1, 3)
  db.exec(`
    INSERT INTO netease_playlist_item (list_root, playlist_id, song_id, position) VALUES
      ('root', '100', '11', 0),
      ('root', '100', '22', 1),
      ('root', '100', '33', 2),
      ('root', '100', '44', 3),
      ('root', '200', '22', 0),
      ('root', '300', '55', 0),
      ('root', '300', '66', 1),
      ('root', '400', '77', 0);
    INSERT INTO netease_track (list_root, song_id, title) VALUES
      ('root', '11', 'A'), ('root', '22', 'B'), ('root', '33', 'C'),
      ('root', '44', 'D'), ('root', '55', 'E'), ('root', '66', 'F'), ('root', '77', 'G');
    INSERT INTO netease_file (list_root, song_id, file_path) VALUES
      ('root', '22', '.store/22.flac'),
      ('root', '55', '.store/55.flac'),
      ('root', '66', '.store/66.flac');
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

  it('自己创建的歌单和收藏可以删或取消收藏，「我喜欢的音乐」不能删', () => {
    expect(() => assertPlaylistDeletable('created')).not.toThrow()
    expect(() => assertPlaylistDeletable('subscribed')).not.toThrow()
    expect(() => assertPlaylistDeletable('album')).not.toThrow()
    expect(() => assertPlaylistDeletable('liked')).toThrow(/我喜欢的音乐/)
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
    expect(db.prepare(`SELECT song_id FROM netease_track ORDER BY song_id`).all()).toHaveLength(7)
    expect(db.prepare(`SELECT song_id FROM netease_file ORDER BY song_id`).all()).toEqual([
      { song_id: '22' },
      { song_id: '55' },
      { song_id: '66' }
    ])
    db.close()
  })

  it('只列出删掉这张歌单后会变成孤儿的已下载曲目', () => {
    const db = setup()
    expect(listExclusiveDownloadedSongIds(db, 'root', '300', 'u1')).toEqual(['55', '66'])
    // 22 还在收藏歌单里，而且这张歌单还被另一个账号挂着
    expect(listExclusiveDownloadedSongIds(db, 'root', '100', 'u1')).toEqual([])
    expect(listExclusiveDownloadedSongIds(db, 'root', '200', 'u1')).toEqual([])
    db.close()
  })

  it('删除当前账号的歌单后，若还有其它账号收藏则保留曲目关系', () => {
    const db = setup()
    expect(applyDeletedPlaylist(db, 'root', '100', 'u1')).toEqual({ removed: true })
    expect(
      db
        .prepare(`SELECT user_id FROM netease_playlist WHERE playlist_id = '100' ORDER BY user_id`)
        .all()
    ).toEqual([{ user_id: 'u2' }])
    expect(
      db
        .prepare(
          `SELECT song_id FROM netease_playlist_item WHERE playlist_id = '100' ORDER BY position`
        )
        .all()
    ).toEqual([{ song_id: '11' }, { song_id: '22' }, { song_id: '33' }, { song_id: '44' }])
    expect(db.prepare(`SELECT song_id FROM netease_file ORDER BY song_id`).all()).toEqual([
      { song_id: '22' },
      { song_id: '55' },
      { song_id: '66' }
    ])
    db.close()
  })

  it('删除当前账号独有的歌单时回收曲目关系，但保留元数据和本地文件记录', () => {
    const db = setup()
    expect(applyDeletedPlaylist(db, 'root', '300', 'u1')).toEqual({ removed: true })
    expect(
      db.prepare(`SELECT 1 AS ok FROM netease_playlist WHERE playlist_id = '300'`).get()
    ).toBeUndefined()
    expect(
      db.prepare(`SELECT song_id FROM netease_playlist_item WHERE playlist_id = '300'`).all()
    ).toEqual([])
    expect(
      db
        .prepare(`SELECT song_id FROM netease_track WHERE song_id IN ('55', '66') ORDER BY song_id`)
        .all()
    ).toEqual([{ song_id: '55' }, { song_id: '66' }])
    expect(
      db
        .prepare(`SELECT song_id FROM netease_file WHERE song_id IN ('55', '66') ORDER BY song_id`)
        .all()
    ).toEqual([{ song_id: '55' }, { song_id: '66' }])
    db.close()
  })
})
