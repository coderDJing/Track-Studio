import { canEditNeteasePlaylistTracks } from '@shared/netease'
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
