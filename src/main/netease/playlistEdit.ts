import { canDeleteNeteasePlaylist, canEditNeteasePlaylistTracks } from '@shared/netease'
import { isSafeSongId } from './paths'

type SqlStatement = {
  get: (...params: unknown[]) => unknown
  all: (...params: unknown[]) => unknown[]
  run: (...params: unknown[]) => unknown
}

export type PlaylistEditDb = {
  prepare: (sql: string) => SqlStatement
  transaction: <T>(fn: () => T) => () => T
}

export type PlaylistRecord = {
  userId: string
  kind: string
  title: string
  trackCount: number
}

const uniqueSafeIds = (songIds: string[]): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of songIds) {
    const id = String(item || '').trim()
    if (!isSafeSongId(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function findPlaylistRecord(
  db: PlaylistEditDb,
  listRoot: string,
  playlistId: string,
  preferredUserId = ''
): PlaylistRecord | null {
  const rows = db
    .prepare(
      `SELECT user_id, kind, title, track_count
         FROM netease_playlist
        WHERE list_root = ? AND playlist_id = ?
        ORDER BY sort_index ASC`
    )
    .all(listRoot, String(playlistId)) as Array<{
    user_id: string
    kind: string
    title: string
    track_count: number
  }>
  if (rows.length === 0) return null
  const preferred = preferredUserId
    ? rows.find((row) => String(row.user_id) === preferredUserId)
    : undefined
  const row = preferred || rows[0]
  return {
    userId: String(row.user_id || ''),
    kind: String(row.kind || ''),
    title: String(row.title || ''),
    trackCount: Number(row.track_count) || 0
  }
}

export function assertPlaylistTracksEditable(kind: string): void {
  if (canEditNeteasePlaylistTracks(kind)) return
  throw new Error('只能从自己创建的歌单或「我喜欢的音乐」里移除歌曲。收藏的歌单和专辑不能改。')
}

export function assertPlaylistDeletable(kind: string): void {
  if (canDeleteNeteasePlaylist(kind)) return
  throw new Error('「我喜欢的音乐」不能删除。收藏的歌单和专辑可以取消收藏。')
}

/**
 * 删除一张歌单在当前账号下的本地记录。
 * 只有没有任何账号还挂着这张歌单时，才回收曲目关系；不删 netease_track / netease_file。
 */
export function applyDeletedPlaylist(
  db: PlaylistEditDb,
  listRoot: string,
  playlistId: string,
  userId: string
): { removed: boolean } {
  const id = String(playlistId || '').trim()
  const uid = String(userId || '').trim()
  if (!id || !uid) return { removed: false }

  return db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT 1 AS ok FROM netease_playlist
          WHERE list_root = ? AND user_id = ? AND playlist_id = ?`
      )
      .get(listRoot, uid, id) as { ok?: number } | undefined
    if (!existing) return { removed: false }

    db.prepare(
      `DELETE FROM netease_playlist WHERE list_root = ? AND user_id = ? AND playlist_id = ?`
    ).run(listRoot, uid, id)

    db.prepare(
      `DELETE FROM netease_playlist_item
        WHERE list_root = ? AND playlist_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM netease_playlist
             WHERE list_root = ? AND playlist_id = ?
          )`
    ).run(listRoot, id, listRoot, id)

    return { removed: true }
  })()
}

/**
 * 这张歌单里已下载、且删掉/取消收藏后会变成孤儿的曲目。
 * 还出现在其它歌单、或仍被另一个账号收藏着的，不算在内。
 */
export function listExclusiveDownloadedSongIds(
  db: PlaylistEditDb,
  listRoot: string,
  playlistId: string,
  userId: string
): string[] {
  const id = String(playlistId || '').trim()
  const uid = String(userId || '').trim()
  if (!id || !uid) return []
  const rows = db
    .prepare(
      `SELECT i.song_id AS song_id
         FROM netease_playlist_item i
         INNER JOIN netease_file f
            ON f.list_root = i.list_root AND f.song_id = i.song_id
        WHERE i.list_root = ? AND i.playlist_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM netease_playlist_item other
             WHERE other.list_root = i.list_root
               AND other.song_id = i.song_id
               AND other.playlist_id != i.playlist_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM netease_playlist p
             WHERE p.list_root = i.list_root
               AND p.playlist_id = i.playlist_id
               AND p.user_id != ?
          )`
    )
    .all(listRoot, id, uid) as Array<{ song_id: string }>
  return uniqueSafeIds(rows.map((row) => String(row.song_id || '')))
}

/**
 * 只改本地索引：从歌单关系里拿掉这些 song_id，重排剩余曲目，更新 track_count。
 * 不删 netease_track / netease_file——本地缓存还在，只是这首歌不再属于这张歌单。
 */
export function applyRemovedPlaylistTracks(
  db: PlaylistEditDb,
  listRoot: string,
  playlistId: string,
  songIds: string[]
): { removedIds: string[]; trackCount: number } {
  const ids = uniqueSafeIds(songIds)
  if (!playlistId || ids.length === 0) {
    const current = db
      .prepare(
        `SELECT COUNT(*) AS count FROM netease_playlist_item WHERE list_root = ? AND playlist_id = ?`
      )
      .get(listRoot, playlistId) as { count?: number } | undefined
    return { removedIds: [], trackCount: Number(current?.count) || 0 }
  }

  return db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT song_id FROM netease_playlist_item
          WHERE list_root = ? AND playlist_id = ?
          ORDER BY position ASC`
      )
      .all(listRoot, playlistId) as Array<{ song_id: string }>
    const remove = new Set(ids)
    const removedIds = existing
      .map((row) => String(row.song_id))
      .filter((songId) => remove.has(songId))
    if (removedIds.length === 0) {
      return { removedIds: [], trackCount: existing.length }
    }

    const deleteOne = db.prepare(
      `DELETE FROM netease_playlist_item
        WHERE list_root = ? AND playlist_id = ? AND song_id = ?`
    )
    for (const songId of removedIds) {
      deleteOne.run(listRoot, playlistId, songId)
    }

    const remaining = db
      .prepare(
        `SELECT song_id FROM netease_playlist_item
          WHERE list_root = ? AND playlist_id = ?
          ORDER BY position ASC`
      )
      .all(listRoot, playlistId) as Array<{ song_id: string }>
    const updatePosition = db.prepare(
      `UPDATE netease_playlist_item
          SET position = ?
        WHERE list_root = ? AND playlist_id = ? AND song_id = ?`
    )
    remaining.forEach((row, index) => {
      updatePosition.run(index, listRoot, playlistId, String(row.song_id))
    })

    const trackCount = remaining.length
    db.prepare(
      `UPDATE netease_playlist
          SET track_count = ?
        WHERE list_root = ? AND playlist_id = ?`
    ).run(trackCount, listRoot, playlistId)
    return { removedIds, trackCount }
  })()
}
