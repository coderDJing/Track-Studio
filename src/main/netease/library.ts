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
import { neteaseClient, type NeteaseLevel } from './client'
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
  applyDeletedPlaylist,
  applyRemovedPlaylistTracks,
  assertPlaylistDeletable,
  assertPlaylistTracksEditable,
  findPlaylistRecord,
  listExclusiveDownloadedSongIds
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

/** 同步模块（catalogSync.ts）也要用：取当前曲库连接 */
export function requireDb(): SqliteDatabase {
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

/** 同步模块（catalogSync.ts）也要用：取网易云库根目录 */
export function getListRoot(): string {
  return getNeteaseRootDir()
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

const ensureNeteaseClientLoggedIn = async (): Promise<void> => {
  if (!neteaseClient.isLoggedIn) {
    const restored = await restoreSessionIntoClient()
    if (!restored && !neteaseClient.isLoggedIn) {
      throw new Error('需要先登录网易云音乐')
    }
  }
}

export type NeteasePlaylistDeletePreview = {
  playlistId: string
  kind: string
  title: string
  trackCount: number
  exclusiveDownloadedIds: string[]
}

/** 删除或取消收藏前的本地预览：标题、首数，以及仅属于这张歌单的已下载曲目。 */
export function getPlaylistDeletePreview(playlistId: string): NeteasePlaylistDeletePreview {
  const id = String(playlistId || '').trim()
  if (!isSafeSongId(id)) throw new Error('缺少歌单')
  const db = requireDb()
  const listRoot = getListRoot()
  const playlist = findPlaylistRecord(db, listRoot, id, getLoggedInUserId())
  if (!playlist) throw new Error('找不到这张歌单')
  assertPlaylistDeletable(playlist.kind)
  return {
    playlistId: id,
    kind: playlist.kind,
    title: playlist.title,
    trackCount: playlist.trackCount,
    exclusiveDownloadedIds: listExclusiveDownloadedSongIds(
      db,
      listRoot,
      id,
      playlist.userId || getLoggedInUserId()
    )
  }
}

/**
 * 从云端删除自己创建的歌单，或取消收藏歌单 / 专辑，成功后再改本地索引。
 * 不会删除 `.store` 里的文件或 `netease_track` 元数据。
 */
export async function deletePlaylistFromLibrary(
  playlistId: string
): Promise<NeteasePlaylistDeletePreview> {
  const preview = getPlaylistDeletePreview(playlistId)
  await ensureNeteaseClientLoggedIn()
  const userId = getLoggedInUserId()
  if (!userId) throw new Error('需要先登录网易云音乐')
  if (preview.kind === 'created') {
    await neteaseClient.deletePlaylists([preview.playlistId])
    const remaining = await neteaseClient.listPlaylists(userId)
    if (remaining.some((item) => item.playlistId === preview.playlistId)) {
      throw new Error('网易云没有删除这张歌单，请稍后重试')
    }
  } else if (preview.kind === 'album') {
    await neteaseClient.unsubscribeAlbum(preview.playlistId)
    const remaining = await neteaseClient.listAlbums()
    if (remaining.some((item) => item.playlistId === preview.playlistId)) {
      throw new Error('网易云没有取消收藏这张专辑，请稍后重试')
    }
  } else {
    await neteaseClient.unsubscribePlaylist(preview.playlistId)
    const remaining = await neteaseClient.listPlaylists(userId)
    if (remaining.some((item) => item.playlistId === preview.playlistId)) {
      throw new Error('网易云没有取消收藏这张歌单，请稍后重试')
    }
  }
  applyDeletedPlaylist(requireDb(), getListRoot(), preview.playlistId, userId)
  return preview
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
