import type { SqliteDatabase } from '../libraryDb'

/**
 * 网易云音乐库的表结构。
 *
 * 全部是幂等 DDL，挂在 applyLibraryDbSchema 的无条件段里执行，**不推进 user_version**：
 * 旧版本 FRKB 打开新库时只要把这几张表当成"不认识的表"忽略即可，
 * 不需要升版本，也不需要写迁移步骤。
 *
 * 表的关系：
 *   netease_account        账号（按 list_root + user_id，可多行）
 *   netease_playlist       歌单目录结构（liked / created / subscribed / album）
 *   netease_playlist_item  歌单与曲目的顺序关系
 *   netease_track          曲目元数据（与歌单无关，跨歌单复用一行）
 *   netease_file           本地文件（一首歌一行；有没有这一行 = 是否已下载）
 */
export function applyNeteaseSchema(instance: SqliteDatabase): void {
  instance.exec(`
    CREATE TABLE IF NOT EXISTS netease_account (
      list_root        TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      nickname         TEXT NOT NULL DEFAULT '',
      avatar_url       TEXT NOT NULL DEFAULT '',
      vip_type         INTEGER NOT NULL DEFAULT 0,
      last_sync_at_ms  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (list_root, user_id)
    );

    CREATE TABLE IF NOT EXISTS netease_playlist (
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

    CREATE INDEX IF NOT EXISTS idx_netease_playlist_kind
      ON netease_playlist(list_root, user_id, kind, sort_index);

    CREATE TABLE IF NOT EXISTS netease_track (
      list_root      TEXT NOT NULL,
      song_id        TEXT NOT NULL,
      title          TEXT NOT NULL DEFAULT '',
      artist         TEXT NOT NULL DEFAULT '',
      album          TEXT NOT NULL DEFAULT '',
      duration_ms    INTEGER NOT NULL DEFAULT 0,
      cover_url      TEXT NOT NULL DEFAULT '',
      updated_at_ms  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (list_root, song_id)
    );

    CREATE TABLE IF NOT EXISTS netease_playlist_item (
      list_root    TEXT NOT NULL,
      playlist_id  TEXT NOT NULL,
      song_id      TEXT NOT NULL,
      position     INTEGER NOT NULL,
      PRIMARY KEY (list_root, playlist_id, song_id)
    );

    CREATE INDEX IF NOT EXISTS idx_netease_playlist_item_position
      ON netease_playlist_item(list_root, playlist_id, position);

    CREATE INDEX IF NOT EXISTS idx_netease_playlist_item_song
      ON netease_playlist_item(list_root, song_id);

    -- file_path 相对 list_root；level 记录这一份实际取到的是哪一档（jymaster/lossless/exhigh/standard）
    CREATE TABLE IF NOT EXISTS netease_file (
      list_root        TEXT NOT NULL,
      song_id          TEXT NOT NULL,
      file_path        TEXT NOT NULL,
      level            TEXT NOT NULL DEFAULT '',
      bit_depth        INTEGER NOT NULL DEFAULT 0,
      sample_rate      INTEGER NOT NULL DEFAULT 0,
      channels         INTEGER NOT NULL DEFAULT 0,
      size_bytes       INTEGER NOT NULL DEFAULT 0,
      downloaded_at_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (list_root, song_id)
    );
  `)
}
