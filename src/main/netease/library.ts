import { createWriteStream } from 'node:fs'
import { open, readdir, rename, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import fsExtra = require('fs-extra')
import { log } from '../log'
import { getLibraryDb } from '../libraryDb'
import type { SqliteDatabase } from '../libraryDb'
import { moveFileToRecycleBin } from '../recycleBinService'
import { neteaseClient, type NeteaseLevel, type NeteasePlaylist } from './client'
import { NeteaseApiError } from './errors'
import { fetchNeteaseCdn } from './cdn'
import { applyDownloadTags } from './tags'
import { findPreviewCacheFile } from './cache'
import {
  assertAbsPathInsideStore,
  assertSongId,
  ensureNeteaseDirs,
  fromRelativeStorePath,
  getNeteaseRootDir,
  getNeteaseStoreDir,
  getStoreFilePath,
  isSafeSongId,
  toRelativeStorePath
} from './paths'
import { parseAudioHeader } from './audioHeader'
import { replaceStoreFileAtomically } from './storeReplace'
import { getLoggedInUserId, restoreSessionIntoClient } from './session'
import {
  applyRemovedPlaylistTracks,
  assertPlaylistTracksEditable,
  findPlaylistRecord
} from './playlistEdit'

/**
 * 目录同步与本地查询。
 *
 * 分工：
 *   - 歌单结构（netease_playlist / netease_playlist_item）每次同步整体重写；
 *   - 曲目元数据（netease_track）只增改不删，因为已下载的曲目要能脱离歌单独立存在；
 *   - 本地文件（netease_file）只由下载流程写入。
 */

/**
 * 读文件头若干字节。
 *
 * 不能用 `readFile().subarray()`：那是把整首歌（几十到几百 MB）读进内存再扔掉，
 * 「查看已下载」补录几百首时会瞬间吃掉几个 GB。这里只读需要的那一段。
 */
const HEAD_BYTES = 128 * 1024

async function readHeadBytes(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function requireDb(): SqliteDatabase {
  const db = getLibraryDb()
  if (!db) throw new Error('当前没有打开的曲库')
  return db
}

/** 库里的相对路径 → 绝对路径；越界就当作没有文件，绝不让它流到文件操作里 */
function safeStoreAbsPath(relativePath: string): string {
  try {
    return fromRelativeStorePath(relativePath)
  } catch {
    return ''
  }
}

function getListRoot(): string {
  return getNeteaseRootDir()
}

export type NeteaseTreeGroup = {
  id: string
  title: string
  items: Array<{ playlistId: string; title: string; trackCount: number; coverUrl: string }>
}

export type CatalogSyncResult = {
  account: { userId: string; nickname: string; avatarUrl: string; vipType: number }
  groups: NeteaseTreeGroup[]
  playlistCount: number
  trackCount: number
  syncedAtMs: number
}

export type CatalogSyncOptions = {
  /** 歌单列表一到就回调，不用等曲目 id / 曲目详情全部拉完 */
  onGroupsReady?: (groups: NeteaseTreeGroup[]) => void
}

/**
 * 拉一次完整目录并落库。
 * 歌单的曲目 id 顺序按 trackIds 原样保存——这是"只按原始顺序显示"的依据。
 */
export async function syncCatalog(options: CatalogSyncOptions = {}): Promise<CatalogSyncResult> {
  const account = await neteaseClient.fetchAccount()
  if (!account) throw new Error('登录态无效，请重新扫码登录')

  await ensureNeteaseDirs()
  const listRoot = getListRoot()
  const db = requireDb()
  const userId = account.userId

  const playlists = await neteaseClient.listPlaylists(userId)
  const albums = await neteaseClient.listAlbums()
  const all: NeteasePlaylist[] = [...playlists, ...albums]

  const insertPlaylist = db.prepare(
    `INSERT OR REPLACE INTO netease_playlist
       (list_root, user_id, playlist_id, kind, title, cover_url, track_count, sort_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  /**
   * 只删**当前账号**的歌单行。
   *
   * 不能按 list_root 清表：`netease_playlist_item` 没有 user_id（歌单 id 全局唯一，
   * 一首歌是否"还在某个歌单里"是跨账号的事实），所以另一账号的歌单行一旦被抹掉，
   * 它的曲目关系就会被孤儿判定当成"已不在歌单"，用户点一次清理就把别人的缓存删了。
   */
  const deletePlaylistsOfUser = db.prepare(
    `DELETE FROM netease_playlist WHERE list_root = ? AND user_id = ?`
  )
  const selectPlaylistIdsOfUser = db.prepare<{ playlist_id: string }>(
    `SELECT playlist_id FROM netease_playlist WHERE list_root = ? AND user_id = ?`
  )
  const deleteItemsOfPlaylist = db.prepare(
    `DELETE FROM netease_playlist_item WHERE list_root = ? AND playlist_id = ?`
  )
  /**
   * 回收「本账号已经没有这张歌单了」的曲目关系。
   *
   * 需要再挡一次"别的账号还有这张歌单"：两个账号收藏同一张歌单时，曲目关系是共用的一份，
   * 一个账号取消收藏不能把另一个账号的也清掉（那会让已下载文件被判成孤儿）。
   */
  const deleteItemsOfPlaylistIfUnclaimed = db.prepare(
    `DELETE FROM netease_playlist_item
      WHERE list_root = ? AND playlist_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM netease_playlist
           WHERE list_root = ? AND playlist_id = ?
        )`
  )
  const countItemsOfPlaylist = db.prepare<{ n: number }>(
    `SELECT COUNT(*) AS n FROM netease_playlist_item WHERE list_root = ? AND playlist_id = ?`
  )
  const insertItem = db.prepare(
    `INSERT OR REPLACE INTO netease_playlist_item (list_root, playlist_id, song_id, position)
     VALUES (?, ?, ?, ?)`
  )
  const insertAccount = db.prepare(
    `INSERT OR REPLACE INTO netease_account
       (list_root, user_id, nickname, avatar_url, vip_type, last_sync_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  )

  // 先把歌单标题写进库并通知渲染层画树。
  // 曲目关系仍等全部拉完再一次性落库，避免半截写入触发孤儿清理。
  const serverCounts = new Map(all.map((item) => [item.playlistId, item.trackCount]))
  db.transaction(() => {
    insertAccount.run(
      listRoot,
      userId,
      account.nickname,
      account.avatarUrl,
      account.vipType,
      Date.now()
    )
    for (let index = 0; index < all.length; index += 1) {
      const item = all[index]
      insertPlaylist.run(
        listRoot,
        userId,
        item.playlistId,
        item.kind,
        item.title,
        item.coverUrl,
        item.trackCount,
        index
      )
    }
  })()
  options.onGroupsReady?.(buildGroups(all, serverCounts))

  // 先把所有歌单的曲目 id 拉全再落库。
  //
  // 不能边拉边写：删旧数据的那一步一旦执行、后面的网络请求又中断，库里就只剩前几个歌单的
  // 曲目，「已下载」的孤儿判定（"没有任何歌单里有它"）会把这些歌全算成孤儿，
  // 用户一点清理就把缓存删了。
  //
  // 拉取失败分两种，处理方式必须不同：
  //   - 明确取不到（歌单被删 / 转私密 / 403）：跳过这张，**保留它上次的曲目关系**；
  //   - 其他（超时、429、解析失败）：整次中止，一个字节都不写。
  // 用一张"看起来空了"的歌单去覆盖旧数据，就是往孤儿判定里递刀。
  const itemsByPlaylist = new Map<string, string[]>()
  const pendingSongIds = new Set<string>()
  let trackCount = 0
  for (const item of all) {
    try {
      const ids =
        item.kind === 'album'
          ? await neteaseClient.albumTrackIds(item.playlistId)
          : await neteaseClient.playlistTrackIds(item.playlistId)
      itemsByPlaylist.set(item.playlistId, ids)
      for (const id of ids) pendingSongIds.add(id)
      trackCount += ids.length
    } catch (error) {
      if (error instanceof NeteaseApiError && error.unavailable) {
        log.warn(`[netease] 歌单「${item.title}」已不可用，保留上次的曲目关系`, error)
        continue
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`同步中断：拉取歌单「${item.title}」失败（${message}）`, { cause: error })
    }
  }

  /** 落库时真正采用的曲目数（跳过拉取的歌单按库里的旧值算），树和库必须同源 */
  const resolvedCounts = new Map<string, number>()
  db.transaction(() => {
    // 本次同步前，这个账号有哪些歌单；用来精确算出"这次真的消失了的歌单"。
    // 不能用"不在 netease_playlist 里"来判断：另一账号的歌单还在表里，那样会误删它的曲目关系。
    const previousIds = new Set(
      selectPlaylistIdsOfUser.all(listRoot, userId).map((row) => String(row.playlist_id))
    )
    deletePlaylistsOfUser.run(listRoot, userId)
    insertAccount.run(
      listRoot,
      userId,
      account.nickname,
      account.avatarUrl,
      account.vipType,
      Date.now()
    )
    for (let index = 0; index < all.length; index += 1) {
      const item = all[index]
      const ids = itemsByPlaylist.get(item.playlistId)
      previousIds.delete(item.playlistId)
      let count: number
      if (ids) {
        deleteItemsOfPlaylist.run(listRoot, item.playlistId)
        for (let position = 0; position < ids.length; position += 1) {
          insertItem.run(listRoot, item.playlistId, ids[position], position)
        }
        // 数量以真正拿到的曲目 id 为准：服务器的 trackCount 含已下架曲目，
        // 拿它当徽标会和右侧列表的实际条数对不上。
        count = ids.length
      } else {
        // 被跳过的歌单：曲目关系还是上次那份，数量也跟着按库里的实际条数算
        const kept = countItemsOfPlaylist.get(listRoot, item.playlistId)
        count = Number(kept?.n) || item.trackCount
      }
      insertPlaylist.run(
        listRoot,
        userId,
        item.playlistId,
        item.kind,
        item.title,
        item.coverUrl,
        count,
        index
      )
      resolvedCounts.set(item.playlistId, count)
    }
    // 剩下的就是本账号这次真的没了（被删 / 取消收藏）的歌单，它们的曲目关系一起收掉。
    // 别的账号的歌单不在 previousIds 里，永远不会被这一段碰到；
    // 同一张歌单如果还被别的账号收藏着，则保留曲目关系（见 deleteItemsOfPlaylistIfUnclaimed）。
    for (const removedPlaylistId of previousIds) {
      deleteItemsOfPlaylistIfUnclaimed.run(listRoot, removedPlaylistId, listRoot, removedPlaylistId)
    }
  })()

  const groups = buildGroups(all, resolvedCounts)
  options.onGroupsReady?.(groups)
  await upsertSongDetails(db, listRoot, Array.from(pendingSongIds))

  return {
    account,
    groups,
    playlistCount: all.length,
    trackCount,
    syncedAtMs: Date.now()
  }
}

/** 拉曲目元数据并写库；调用方保证 songId 已去重 */
export async function upsertSongDetails(
  db: SqliteDatabase,
  listRoot: string,
  songIds: string[]
): Promise<void> {
  if (songIds.length === 0) return
  const details = await neteaseClient.songDetails(songIds)
  const statement = db.prepare(
    `INSERT OR REPLACE INTO netease_track
       (list_root, song_id, title, artist, album, duration_ms, cover_url, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const now = Date.now()
  db.transaction(() => {
    for (const song of details.values()) {
      statement.run(
        listRoot,
        song.songId,
        song.title,
        song.artist,
        song.album,
        song.durationMs,
        song.coverUrl,
        now
      )
    }
  })()
}

function buildGroups(
  playlists: NeteasePlaylist[],
  countsByPlaylist: Map<string, number>
): NeteaseTreeGroup[] {
  const toItems = (rows: NeteasePlaylist[]) =>
    rows.map((row) => ({
      playlistId: row.playlistId,
      title: row.title,
      // 与落库同源：以真正写进库的曲目数为准
      trackCount: countsByPlaylist.get(row.playlistId) ?? row.trackCount,
      coverUrl: row.coverUrl
    }))

  const groups: NeteaseTreeGroup[] = []
  const liked = playlists.filter((item) => item.kind === 'liked')
  if (liked.length) groups.push({ id: 'liked', title: '我喜欢的音乐', items: toItems(liked) })
  groups.push({
    id: 'created',
    title: '创建的歌单',
    items: toItems(playlists.filter((item) => item.kind === 'created'))
  })
  groups.push({
    id: 'subscribed',
    title: '收藏的歌单',
    items: toItems(playlists.filter((item) => item.kind === 'subscribed'))
  })
  const albums = playlists.filter((item) => item.kind === 'album')
  if (albums.length) groups.push({ id: 'album', title: '收藏的专辑', items: toItems(albums) })
  return groups
}

export type NeteaseTrackRow = {
  songId: string
  title: string
  artist: string
  album: string
  durationMs: number
  coverUrl: string
  position: number
}

/** 歌单里的曲目，按原始顺序 */
export function getPlaylistTracks(playlistId: string): NeteaseTrackRow[] {
  const db = requireDb()
  const listRoot = getListRoot()
  const rows = db
    .prepare<{
      song_id: string
      title: string
      artist: string
      album: string
      duration_ms: number
      cover_url: string
      position: number
    }>(
      `SELECT i.song_id, i.position,
              COALESCE(t.title, '') AS title,
              COALESCE(t.artist, '') AS artist,
              COALESCE(t.album, '') AS album,
              COALESCE(t.duration_ms, 0) AS duration_ms,
              COALESCE(t.cover_url, '') AS cover_url
         FROM netease_playlist_item i
         LEFT JOIN netease_track t
           ON t.list_root = i.list_root AND t.song_id = i.song_id
        WHERE i.list_root = ? AND i.playlist_id = ?
        ORDER BY i.position ASC`
    )
    .all(listRoot, String(playlistId))
  return rows.map((row) => ({
    songId: String(row.song_id),
    title: String(row.title || ''),
    artist: String(row.artist || ''),
    album: String(row.album || ''),
    durationMs: Number(row.duration_ms) || 0,
    coverUrl: String(row.cover_url || ''),
    position: Number(row.position) || 0
  }))
}

export function getPlaylistInfo(playlistId: string): {
  playlistId: string
  kind: string
  title: string
  trackCount: number
  userId: string
} | null {
  const id = String(playlistId || '').trim()
  if (!isSafeSongId(id)) return null
  const record = findPlaylistRecord(requireDb(), getListRoot(), id, getLoggedInUserId())
  if (!record) return null
  return { playlistId: id, ...record }
}

/**
 * 从云端歌单移出曲目，成功后再改本地索引。
 * 不会删除 `.store` 里的文件或 `netease_track` 元数据。
 */
export async function removeTracksFromPlaylist(
  playlistId: string,
  songIds: string[]
): Promise<{ removedIds: string[]; trackCount: number; title: string; kind: string }> {
  const id = String(playlistId || '').trim()
  if (!isSafeSongId(id)) throw new Error('缺少歌单')
  const db = requireDb()
  const listRoot = getListRoot()
  const playlist = findPlaylistRecord(db, listRoot, id, getLoggedInUserId())
  if (!playlist) throw new Error('找不到这张歌单')
  assertPlaylistTracksEditable(playlist.kind)

  const existing = new Set(getPlaylistTracks(id).map((track) => track.songId))
  const ids = [
    ...new Set(
      songIds
        .map((item) => String(item || '').trim())
        .filter((item) => isSafeSongId(item) && existing.has(item))
    )
  ]
  if (ids.length === 0) {
    return {
      removedIds: [],
      trackCount: playlist.trackCount,
      title: playlist.title,
      kind: playlist.kind
    }
  }

  if (!neteaseClient.isLoggedIn) {
    const restored = await restoreSessionIntoClient()
    if (!restored && !neteaseClient.isLoggedIn) {
      throw new Error('需要先登录网易云音乐')
    }
  }
  await neteaseClient.removePlaylistTracks(id, ids)
  const applied = applyRemovedPlaylistTracks(db, listRoot, id, ids)
  return { ...applied, title: playlist.title, kind: playlist.kind }
}

/**
 * 用 `.store` 目录反推「已下载」索引，双向对齐。
 *
 * 补缺：库合并后（行里的 list_root 指向源库，行被丢弃）、或用户手工把 `.store` 搬过来时，
 * 文件在、索引空——列表会是空的，那才是真的糟糕。
 *
 * 删多：文件被别的入口删掉时（播放器的「删除以上」、用户在资源管理器里直接删、
 * 回收站彻底删除），`netease_file` 会留下指不到文件的幽灵行，而列表是纯查表的，
 * 于是「查看已下载」会显示一批已经不存在的东西。这里顺手清掉。
 * 只删本 list_root 的行，且磁盘上还存在 `<songId>.part` 的不算消失（下载进行中）。
 *
 * 磁盘目录读失败时直接返回，绝不因为"看起来全没了"就把索引清空。
 */
export async function reconcileStoreFromDisk(): Promise<number> {
  const db = getLibraryDb()
  if (!db) return 0
  let names: string[]
  try {
    names = await readdir(getNeteaseStoreDir())
  } catch {
    return 0
  }
  const listRoot = getListRoot()
  const known = new Set(
    db
      .prepare<{ song_id: string }>(`SELECT song_id FROM netease_file WHERE list_root = ?`)
      .all(listRoot)
      .map((row) => String(row.song_id))
  )
  const diskSongIds = new Set<string>()
  for (const name of names) {
    if (name.startsWith('.')) continue
    const base = name.endsWith('.part') ? name.slice(0, -'.part'.length) : name
    const dotIndex = base.lastIndexOf('.')
    if (dotIndex <= 0) continue
    const songId = base.slice(0, dotIndex)
    if (songId) diskSongIds.add(songId)
  }
  const removeRow = db.prepare(`DELETE FROM netease_file WHERE list_root = ? AND song_id = ?`)
  for (const songId of [...known]) {
    if (diskSongIds.has(songId)) continue
    removeRow.run(listRoot, songId)
    known.delete(songId)
  }
  const insert = db.prepare(
    `INSERT OR REPLACE INTO netease_file
       (list_root, song_id, file_path, level, bit_depth, sample_rate, channels, size_bytes, downloaded_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  let added = 0
  for (const name of names) {
    if (name.endsWith('.part') || name.startsWith('.')) continue
    const dotIndex = name.lastIndexOf('.')
    if (dotIndex <= 0) continue
    const songId = name.slice(0, dotIndex)
    if (!songId || known.has(songId)) continue
    const absPath = path.join(getNeteaseStoreDir(), name)
    try {
      const info = await stat(absPath)
      if (!info.isFile() || info.size === 0) continue
      const head = await readHeadBytes(absPath)
      const header = parseAudioHeader(head)
      insert.run(
        listRoot,
        songId,
        toRelativeStorePath(absPath),
        '',
        header?.bitDepth || 0,
        header?.sampleRate || 0,
        header?.channels || 0,
        info.size,
        info.mtimeMs || Date.now()
      )
      added += 1
    } catch (error) {
      log.warn(`[netease] 补录 ${name} 失败`, error)
    }
  }
  return added
}

/** 单曲元数据（供导入时拼「艺人 - 标题」文件名，以及下载后写标签用） */
export function getTrackMeta(
  songId: string
): { title: string; artist: string; album: string; coverUrl: string } | null {
  const db = getLibraryDb()
  if (!db) return null
  const row = db
    .prepare<{ title: string; artist: string; album: string; cover_url: string }>(
      `SELECT COALESCE(title, '') AS title,
              COALESCE(artist, '') AS artist,
              COALESCE(album, '') AS album,
              COALESCE(cover_url, '') AS cover_url
         FROM netease_track WHERE list_root = ? AND song_id = ? LIMIT 1`
    )
    .get(getListRoot(), String(songId))
  if (!row) return null
  return {
    title: String(row.title || ''),
    artist: String(row.artist || ''),
    album: String(row.album || ''),
    coverUrl: String(row.cover_url || '')
  }
}

/**
 * `.store/<songId>.<ext>` → 「艺人 - 标题」。
 * 供分轨导出等需要人类可读文件名的场景使用；无法识别时返回空串。
 */
export function getStoreTrackDisplayName(absPath: string): string {
  const songId = path.parse(String(absPath || '')).name.trim()
  if (!isSafeSongId(songId)) return ''
  const meta = getTrackMeta(songId)
  if (!meta) return ''
  const title = String(meta.title || '').trim()
  if (!title) return ''
  const artist = String(meta.artist || '').trim()
  return artist ? `${artist} - ${title}` : title
}

export type DownloadedTrackRow = {
  songId: string
  title: string
  artist: string
  album: string
  durationMs: number
  coverUrl: string
  /** `.store` 里的绝对路径：已下载的曲目可以直接播放、导出、复制到别的库 */
  absPath: string
  /** 相对 store 根的路径，落库用 */
  filePath: string
  level: string
  bitDepth: number
  sampleRate: number
  channels: number
  sizeBytes: number
  downloadedAtMs: number
  /** 是否仍在某个歌单里；false = 孤儿，可批量清理 */
  inPlaylist: boolean
}

/** 「查看已下载」的数据源：只读本地文件表，与本次同步成败无关 */
export function listDownloaded(): DownloadedTrackRow[] {
  const db = requireDb()
  const listRoot = getListRoot()
  const rows = db
    .prepare<{
      song_id: string
      file_path: string
      level: string
      bit_depth: number
      sample_rate: number
      channels: number
      size_bytes: number
      downloaded_at_ms: number
      title: string
      artist: string
      album: string
      duration_ms: number
      cover_url: string
      in_playlist: number
    }>(
      `SELECT f.song_id, f.file_path, f.level, f.bit_depth, f.sample_rate, f.channels,
              f.size_bytes, f.downloaded_at_ms,
              COALESCE(t.title, '') AS title,
              COALESCE(t.artist, '') AS artist,
              COALESCE(t.album, '') AS album,
              COALESCE(t.duration_ms, 0) AS duration_ms,
              COALESCE(t.cover_url, '') AS cover_url,
              EXISTS (
                SELECT 1 FROM netease_playlist_item i
                 WHERE i.list_root = f.list_root AND i.song_id = f.song_id
              ) AS in_playlist
         FROM netease_file f
         LEFT JOIN netease_track t
           ON t.list_root = f.list_root AND t.song_id = f.song_id
        WHERE f.list_root = ?
        ORDER BY f.downloaded_at_ms DESC`
    )
    .all(listRoot)
  return rows.map((row) => ({
    songId: String(row.song_id),
    title: String(row.title || ''),
    artist: String(row.artist || ''),
    album: String(row.album || ''),
    durationMs: Number(row.duration_ms) || 0,
    coverUrl: String(row.cover_url || ''),
    absPath: safeStoreAbsPath(String(row.file_path || '')),
    filePath: String(row.file_path || ''),
    level: String(row.level || ''),
    bitDepth: Number(row.bit_depth) || 0,
    sampleRate: Number(row.sample_rate) || 0,
    channels: Number(row.channels) || 0,
    sizeBytes: Number(row.size_bytes) || 0,
    downloadedAtMs: Number(row.downloaded_at_ms) || 0,
    inPlaylist: Number(row.in_playlist) === 1
  }))
}

/** 「查看已下载」头部要显示的三个数：只做聚合，不把整张表传过去 */
export function getDownloadedSummary(): {
  count: number
  totalBytes: number
  orphanCount: number
  orphanSongIds: string[]
} {
  const db = getLibraryDb()
  if (!db) return { count: 0, totalBytes: 0, orphanCount: 0, orphanSongIds: [] }
  const listRoot = getListRoot()
  const row = db
    .prepare<{ count: number; total_bytes: number; orphan_count: number }>(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(f.size_bytes), 0) AS total_bytes,
              COALESCE(SUM(
                CASE WHEN EXISTS (
                  SELECT 1 FROM netease_playlist_item i
                   WHERE i.list_root = f.list_root AND i.song_id = f.song_id
                ) THEN 0 ELSE 1 END
              ), 0) AS orphan_count
         FROM netease_file f
        WHERE f.list_root = ?`
    )
    .get(listRoot)
  const orphanRows = db
    .prepare<{ song_id: string }>(
      `SELECT f.song_id FROM netease_file f
        WHERE f.list_root = ?
          AND NOT EXISTS (
            SELECT 1 FROM netease_playlist_item i
             WHERE i.list_root = f.list_root AND i.song_id = f.song_id
          )`
    )
    .all(listRoot)
  return {
    count: Number(row?.count) || 0,
    totalBytes: Number(row?.total_bytes) || 0,
    orphanCount: Number(row?.orphan_count) || 0,
    orphanSongIds: orphanRows.map((item) => String(item.song_id))
  }
}

/** 某首歌的本地文件绝对路径（没有则 null）：播放时优先走它，不必流式 */
export function getLocalFilePath(songId: string): string | null {
  const db = getLibraryDb()
  if (!db) return null
  const row = db
    .prepare<{ file_path: string }>(
      `SELECT file_path FROM netease_file WHERE list_root = ? AND song_id = ? LIMIT 1`
    )
    .get(getListRoot(), String(songId))
  if (!row?.file_path) return null
  try {
    return fromRelativeStorePath(String(row.file_path))
  } catch (error) {
    // 库里存了一条越界路径（被手工改过 / 合并过）：当作没有本地文件，别拿去删/读
    log.warn('[netease] 本地文件路径非法，忽略', error)
    return null
  }
}

export type DownloadOutcome = {
  songId: string
  filePath: string
  relativePath: string
  level: string
  bitDepth: number
  sampleRate: number
  channels: number
  sizeBytes: number
}

/**
 * 已经下载好、且文件确实还在盘上的那首。
 *
 * 「确保已下载」的所有入口都先问它：同一张歌单导到第二个库时不该再拉一遍几百兆，
 * 之前导入失败重来一次也不该从零开始。
 */
export async function getLocalFileOutcome(songId: string): Promise<DownloadOutcome | null> {
  const db = getLibraryDb()
  if (!db) return null
  const row = db
    .prepare<{
      file_path: string
      level: string
      bit_depth: number
      sample_rate: number
      channels: number
    }>(
      `SELECT file_path, level, bit_depth, sample_rate, channels
         FROM netease_file WHERE list_root = ? AND song_id = ? LIMIT 1`
    )
    .get(getListRoot(), String(songId))
  if (!row?.file_path) return null
  try {
    const absPath = fromRelativeStorePath(String(row.file_path))
    const info = await stat(absPath)
    if (!info.isFile() || info.size === 0) return null
    return {
      songId: String(songId),
      filePath: absPath,
      relativePath: String(row.file_path),
      level: String(row.level || ''),
      bitDepth: Number(row.bit_depth) || 0,
      sampleRate: Number(row.sample_rate) || 0,
      channels: Number(row.channels) || 0,
      sizeBytes: info.size
    }
  } catch {
    return null
  }
}

/** 同一首歌正在下载时的共享 promise：两路请求同写一个临时文件，谁先谁后都会写坏 */
const inflightDownloads = new Map<string, Promise<DownloadOutcome>>()

/**
 * 下载一首歌到 `.store/`。
 *
 * 同一首并发下载会共用同一个临时文件，所以按 songId 串行化：后到的等前一个的结果。
 */
export type DownloadTrackOptions = {
  /** 临时落点，必须在 `.store` 点目录内。缺省按是否 force 自动挑一个 */
  tempPath?: string
  /** 不复用已有文件，按当前档位重新下载，成功后再原子替换旧文件 */
  force?: boolean
}

/**
 * 下载一首歌到 `.store/`。
 *
 * 同一首并发下载会共用同一个临时文件，所以按 songId（再加 force）串行化：后到的等前一个的结果。
 * `force` 用于换音质重下：先下到临时位，校验并写标签，再替换旧文件；失败时旧文件仍在。
 */
export async function downloadTrack(
  songId: string,
  level: NeteaseLevel,
  options?: DownloadTrackOptions
): Promise<DownloadOutcome> {
  const id = assertSongId(songId)
  const force = options?.force === true
  const key = `${id}:${force ? 'force' : 'normal'}`
  const existing = inflightDownloads.get(key)
  if (existing) return await existing
  const task = downloadTrackInner(id, level, options).finally(() => {
    inflightDownloads.delete(key)
  })
  inflightDownloads.set(key, task)
  return await task
}

async function downloadTrackInner(
  songId: string,
  level: NeteaseLevel,
  options?: DownloadTrackOptions
): Promise<DownloadOutcome> {
  const force = options?.force === true
  if (!force) {
    const existing = await getLocalFileOutcome(songId)
    if (existing) return existing
  }

  await ensureNeteaseDirs()
  const tempPath = options?.tempPath
    ? assertAbsPathInsideStore(options.tempPath)
    : path.join(
        getNeteaseStoreDir(),
        force ? `.${songId}.${level}.${randomUUID()}.part` : `${songId}.${level}.part`
      )
  assertAbsPathInsideStore(tempPath)

  // 试听缓存里已经有这个档位的整首文件时，直接拷进临时位：
  // 用户刚听完一首就点下载，没必要再从 CDN 拉一遍几百兆。
  // 换音质重下也复用同档缓存，但不能复用已经落在 `.store` 的旧文件。
  const cachedSource = await findPreviewCacheFile(songId, level)
  let contentType = ''
  let fileLevel: string = level
  let sourceUrl = ''
  if (cachedSource) {
    try {
      await fsExtra.copy(cachedSource, tempPath, { overwrite: true })
      const cachedExt = path.extname(cachedSource).slice(1).toLowerCase()
      contentType = CONTENT_TYPE_BY_EXT[cachedExt] || ''
    } catch (error) {
      log.warn('[netease] 复用试听缓存失败，改为重新下载', error)
    }
  }

  if (!(await fsExtra.pathExists(tempPath))) {
    const detail = await neteaseClient.songUrl(songId, level)
    if (!detail || !detail.url) throw new Error('没有可用地址（可能需要会员，或该曲已下架）')
    if (detail.trial) throw new Error('只能取到试听片段，这首需要会员')
    sourceUrl = detail.url
    fileLevel = detail.level || level

    const response = await fetchNeteaseCdn(detail.url, { retries: 3 })
    if (!response.ok || !response.body) throw new Error(`下载失败 HTTP ${response.status}`)

    const expectedBytes = Number(response.headers.get('content-length')) || 0
    contentType = String(response.headers.get('content-type') || '')
    const bodyStream = Readable.fromWeb(response.body as never)
    let written = 0
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        written += chunk.length
        callback(null, chunk)
      }
    })
    try {
      await pipeline(bodyStream, counter, createWriteStream(tempPath))
    } catch (error) {
      await fsExtra.remove(tempPath).catch(() => {})
      throw error
    }
    if (expectedBytes > 0 && written !== expectedBytes) {
      await fsExtra.remove(tempPath).catch(() => {})
      throw new Error(`下载不完整（${written}/${expectedBytes} 字节）`)
    }
  }

  let stagingPath = ''
  try {
    const head = await readHeadBytes(tempPath)
    const header = parseAudioHeader(head)
    const ext = resolveDownloadedExt(header, contentType, sourceUrl)
    // 校验完先改成带真实扩展名的临时文件，再写标签：标签逻辑按扩展名走，不能还顶着 .part
    stagingPath = assertAbsPathInsideStore(
      path.join(getNeteaseStoreDir(), `.${songId}.${randomUUID()}.${ext}`)
    )
    await rename(tempPath, stagingPath)

    const meta = getTrackMeta(songId)
    await applyDownloadTags(stagingPath, {
      title: meta?.title || '',
      artist: meta?.artist || '',
      album: meta?.album || '',
      coverUrl: meta?.coverUrl || ''
    })

    const oldPath = force ? getLocalFilePath(songId) : null
    const replaced = await replaceStoreFileAtomically({
      songId,
      ext,
      stagingPath,
      oldPath
    })
    const finalPath = replaced.finalPath

    const fileStat = await stat(finalPath)
    const db = requireDb()
    const listRoot = getListRoot()
    const relativePath = toRelativeStorePath(finalPath)
    db.prepare(
      `INSERT OR REPLACE INTO netease_file
         (list_root, song_id, file_path, level, bit_depth, sample_rate, channels, size_bytes, downloaded_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      listRoot,
      String(songId),
      relativePath,
      fileLevel,
      header?.bitDepth || 0,
      header?.sampleRate || 0,
      header?.channels || 0,
      fileStat.size,
      Date.now()
    )

    return {
      songId,
      filePath: finalPath,
      relativePath,
      level: fileLevel,
      bitDepth: header?.bitDepth || 0,
      sampleRate: header?.sampleRate || 0,
      channels: header?.channels || 0,
      sizeBytes: fileStat.size
    }
  } catch (error) {
    await fsExtra.remove(tempPath).catch(() => {})
    if (stagingPath) await fsExtra.remove(stagingPath).catch(() => {})
    throw error
  }
}

const DOWNLOADABLE_EXTENSIONS = new Set(['flac', 'mp3', 'm4a', 'aac', 'ogg', 'wav'])

/** 复用试听缓存时没有响应头，只能按缓存文件的扩展名反推容器 */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  wav: 'audio/wav'
}

/**
 * 下载落盘的扩展名。
 *
 * 先信文件头（唯一能确定"实际是什么"的依据：同一档位不同曲目返回的规格不一样），
 * 头认不出来再退到 content-type，最后看直链后缀。三条都不成立就报错。
 */
function resolveDownloadedExt(
  header: ReturnType<typeof parseAudioHeader>,
  contentType: string,
  url: string
): string {
  if (header?.format === 'flac') return 'flac'
  if (header?.format === 'mp3') return 'mp3'
  const type = String(contentType || '').toLowerCase()
  if (type.includes('flac')) return 'flac'
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3'
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a'
  const urlExt = path
    .extname(String(url || '').split('?')[0])
    .replace('.', '')
    .toLowerCase()
  if (DOWNLOADABLE_EXTENSIONS.has(urlExt)) return urlExt
  throw new Error('无法识别音频格式（可能拿到的是错误页）')
}

/** 删除本地文件（曲目记录保留，只是回到未下载）；文件进回收站 */
export async function deleteLocalFile(songId: string): Promise<{ removed: boolean }> {
  const db = requireDb()
  const listRoot = getListRoot()
  const row = db
    .prepare<{ file_path: string }>(
      `SELECT file_path FROM netease_file WHERE list_root = ? AND song_id = ? LIMIT 1`
    )
    .get(listRoot, String(songId))

  if (row?.file_path) {
    const absPath = safeStoreAbsPath(String(row.file_path))
    if (absPath) {
      const result = await moveFileToRecycleBin(absPath)
      if (result.status === 'failed') {
        // 回收站不可用时退化为直接删除；文件随时能从网易云重新下回来
        await fsExtra.remove(absPath).catch(() => {})
      }
    }
  }

  db.prepare(`DELETE FROM netease_file WHERE list_root = ? AND song_id = ?`).run(
    listRoot,
    String(songId)
  )
  return { removed: Boolean(row?.file_path) }
}
