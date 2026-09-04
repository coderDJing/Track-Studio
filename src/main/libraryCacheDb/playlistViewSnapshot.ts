import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import type { ISongInfo } from '../../types/globals'
import type { SqliteDatabase } from '../libraryDb'
import { resolveListRootInput } from './pathResolvers'

/**
 * 打开歌单的视图快照。整张歌单存一行（items_json 为 ISongInfo[]），
 * 打开路径只需一次主键查询 + 一次 JSON.parse，不进 worker、不 stat、不逐行 parse。
 *
 * 红线：快照只服务“读 / 展示”。任何写操作（移动、删除、改标签、写分析、
 * 导出 rekordbox XML、云同步对账）都必须先走精确磁盘核对，禁止读快照。
 */
export type PlaylistViewSnapshotMeta = {
  songListUUID: string
  listRoot: string
  revision: number
  identityDigest: string
  itemCount: number
  builtAtMs: number
  /** 0 = 已被标记为"内容可能已变"，需要后台重建一次；> 0 是最近一次核对通过的时间。 */
  verifiedAtMs: number
}

export type PlaylistViewSnapshotRecord = PlaylistViewSnapshotMeta & {
  items: ISongInfo[]
  missingWaveformFilePaths: string[]
}

export type PlaylistViewSnapshotWriteInput = {
  songListUUID: string
  listRoot: string
  identityDigest: string
  items: ISongInfo[]
  missingWaveformFilePaths?: string[]
  verifiedAtMs?: number
}

type SnapshotRow = {
  song_list_uuid?: unknown
  list_root?: unknown
  revision?: unknown
  identity_digest?: unknown
  item_count?: unknown
  items_json?: unknown
  missing_waveform_json?: unknown
  built_at_ms?: unknown
  verified_at_ms?: unknown
}

type SnapshotStatements = {
  selectByUuid: ReturnType<SqliteDatabase['prepare']>
  selectMetaByUuid: ReturnType<SqliteDatabase['prepare']>
  selectUuidsByRoot: ReturnType<SqliteDatabase['prepare']>
  selectVerificationCandidates: ReturnType<SqliteDatabase['prepare']>
  upsert: ReturnType<SqliteDatabase['prepare']>
  touchVerified: ReturnType<SqliteDatabase['prepare']>
  touchIdentity: ReturnType<SqliteDatabase['prepare']>
  markStaleByRoot: ReturnType<SqliteDatabase['prepare']>
  deleteByUuid: ReturnType<SqliteDatabase['prepare']>
  deleteByRoot: ReturnType<SqliteDatabase['prepare']>
  listUuids: ReturnType<SqliteDatabase['prepare']>
}

// 打开歌单是热路径：statement 只在同一个连接上准备一次，换库自动失效。
const statementCache = new WeakMap<SqliteDatabase, SnapshotStatements>()

const SNAPSHOT_COLUMNS =
  'song_list_uuid, list_root, revision, identity_digest, item_count, items_json, missing_waveform_json, built_at_ms, verified_at_ms'

function getStatements(db: SqliteDatabase): SnapshotStatements {
  const cached = statementCache.get(db)
  if (cached) return cached
  const statements: SnapshotStatements = {
    selectByUuid: db.prepare(
      `SELECT ${SNAPSHOT_COLUMNS} FROM playlist_view_snapshot WHERE song_list_uuid = ?`
    ),
    selectMetaByUuid: db.prepare(
      `SELECT song_list_uuid, list_root, revision, identity_digest, item_count, built_at_ms, verified_at_ms
       FROM playlist_view_snapshot WHERE song_list_uuid = ?`
    ),
    selectUuidsByRoot: db.prepare(
      `SELECT song_list_uuid FROM playlist_view_snapshot WHERE list_root = ?`
    ),
    // 空闲轮转核对：先补哨兵行（verified_at_ms = 0），再按最久没核对的顺序往下走。
    selectVerificationCandidates: db.prepare(
      `SELECT song_list_uuid, list_root, revision, identity_digest, item_count, built_at_ms, verified_at_ms
       FROM playlist_view_snapshot ORDER BY verified_at_ms ASC LIMIT ?`
    ),
    upsert: db.prepare(
      `INSERT INTO playlist_view_snapshot
         (song_list_uuid, list_root, revision, identity_digest, item_count, items_json, missing_waveform_json, built_at_ms, verified_at_ms)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(song_list_uuid) DO UPDATE SET
         list_root = excluded.list_root,
         revision = playlist_view_snapshot.revision + 1,
         identity_digest = excluded.identity_digest,
         item_count = excluded.item_count,
         items_json = excluded.items_json,
         missing_waveform_json = excluded.missing_waveform_json,
         built_at_ms = excluded.built_at_ms,
         verified_at_ms = excluded.verified_at_ms`
    ),
    touchVerified: db.prepare(
      `UPDATE playlist_view_snapshot SET verified_at_ms = ? WHERE song_list_uuid = ?`
    ),
    // 后台重扫后内容其实没变时走这条：只换身份摘要和核对时间，不重写 items_json。
    // 大歌单的 items_json 有几 MB，为"没变化"付一次全量写是纯浪费。
    touchIdentity: db.prepare(
      `UPDATE playlist_view_snapshot SET identity_digest = ?, verified_at_ms = ? WHERE song_list_uuid = ?`
    ),
    markStaleByRoot: db.prepare(
      `UPDATE playlist_view_snapshot SET verified_at_ms = 0 WHERE list_root = ? AND verified_at_ms != 0`
    ),
    deleteByUuid: db.prepare(`DELETE FROM playlist_view_snapshot WHERE song_list_uuid = ?`),
    deleteByRoot: db.prepare(`DELETE FROM playlist_view_snapshot WHERE list_root = ?`),
    listUuids: db.prepare(`SELECT song_list_uuid FROM playlist_view_snapshot`)
  }
  statementCache.set(db, statements)
  return statements
}

const normalizeUuid = (value: unknown): string => String(value || '').trim()

/** 与 song_cache 的 list_root 用同一套归一化，便于按目录整体失效。 */
export function normalizeSnapshotListRoot(listRoot: string): string {
  const resolved = resolveListRootInput(String(listRoot || ''))
  return resolved?.key || ''
}

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : fallback
}

const readMetaFromRow = (row: SnapshotRow): PlaylistViewSnapshotMeta => ({
  songListUUID: String(row.song_list_uuid || ''),
  listRoot: String(row.list_root || ''),
  revision: toFiniteNumber(row.revision),
  identityDigest: String(row.identity_digest || ''),
  itemCount: toFiniteNumber(row.item_count),
  builtAtMs: toFiniteNumber(row.built_at_ms),
  verifiedAtMs: toFiniteNumber(row.verified_at_ms)
})

/** 缺波形列表是“打开后立刻要用”的字段，重算需要 stat，所以随快照一起存。 */
const readStringArrayJson = (value: unknown): string[] => {
  try {
    const parsed: unknown = JSON.parse(String(value || '[]'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {
    return []
  }
}

export function loadPlaylistViewSnapshot(songListUUID: string): PlaylistViewSnapshotRecord | null {
  const uuid = normalizeUuid(songListUUID)
  if (!uuid) return null
  const db = getLibraryDb()
  if (!db) return null
  try {
    const row = getStatements(db).selectByUuid.get(uuid) as SnapshotRow | undefined
    if (!row) return null
    const parsed: unknown = JSON.parse(String(row.items_json || '[]'))
    if (!Array.isArray(parsed)) return null
    return {
      ...readMetaFromRow(row),
      items: parsed as ISongInfo[],
      missingWaveformFilePaths: readStringArrayJson(row.missing_waveform_json)
    }
  } catch (error) {
    log.error('[playlist-snapshot] load failed', error)
    return null
  }
}

export function loadPlaylistViewSnapshotMeta(
  songListUUID: string
): PlaylistViewSnapshotMeta | null {
  const uuid = normalizeUuid(songListUUID)
  if (!uuid) return null
  const db = getLibraryDb()
  if (!db) return null
  try {
    const row = getStatements(db).selectMetaByUuid.get(uuid) as SnapshotRow | undefined
    return row ? readMetaFromRow(row) : null
  } catch (error) {
    log.error('[playlist-snapshot] load meta failed', error)
    return null
  }
}

/** 写入/覆盖快照并让 revision 自增，返回写入后的 revision（失败返回 null）。 */
export function savePlaylistViewSnapshot(input: PlaylistViewSnapshotWriteInput): number | null {
  const uuid = normalizeUuid(input.songListUUID)
  const listRoot = normalizeSnapshotListRoot(input.listRoot)
  if (!uuid || !listRoot) return null
  const db = getLibraryDb()
  if (!db) return null
  const now = Date.now()
  try {
    const statements = getStatements(db)
    statements.upsert.run(
      uuid,
      listRoot,
      String(input.identityDigest || ''),
      input.items.length,
      JSON.stringify(input.items),
      JSON.stringify(input.missingWaveformFilePaths || []),
      now,
      toFiniteNumber(input.verifiedAtMs, now)
    )
    const meta = statements.selectMetaByUuid.get(uuid) as SnapshotRow | undefined
    return meta ? toFiniteNumber(meta.revision) : null
  } catch (error) {
    log.error('[playlist-snapshot] save failed', error)
    return null
  }
}

export function touchPlaylistViewSnapshotVerified(songListUUID: string, verifiedAtMs = Date.now()) {
  const uuid = normalizeUuid(songListUUID)
  if (!uuid) return
  const db = getLibraryDb()
  if (!db) return
  try {
    getStatements(db).touchVerified.run(verifiedAtMs, uuid)
  } catch (error) {
    log.error('[playlist-snapshot] touch verified failed', error)
  }
}

/**
 * 后台核对发现"文件身份变了但歌单内容等价"时用它收尾：更新身份摘要 + 核对时间，
 * 不重写 items_json。不更新摘要的话下一轮核对会再判一次不一致，永远重扫。
 */
export function touchPlaylistViewSnapshotIdentity(
  songListUUID: string,
  identityDigest: string,
  verifiedAtMs = Date.now()
): void {
  const uuid = normalizeUuid(songListUUID)
  if (!uuid) return
  const db = getLibraryDb()
  if (!db) return
  try {
    getStatements(db).touchIdentity.run(String(identityDigest || ''), verifiedAtMs, uuid)
  } catch (error) {
    log.error('[playlist-snapshot] touch identity failed', error)
  }
}

/**
 * 把某个目录下的快照标记为"内容可能已变"（verified_at_ms = 0）。
 *
 * 这是唯一可信的失效信号：song_cache 的写入函数会调它。之所以不用
 * globalSongSearch 的 dirtyPlaylists，是因为那边不带 uuid 调用时会把所有歌单
 * 一起标脏，精度不够。
 */
export function markPlaylistViewSnapshotContentStale(listRoot: string): void {
  const normalized = normalizeSnapshotListRoot(listRoot)
  if (!normalized) return
  const db = getLibraryDb()
  if (!db) return
  try {
    getStatements(db).markStaleByRoot.run(normalized)
  } catch (error) {
    log.error('[playlist-snapshot] mark stale failed', error)
  }
}

/** 目录级反查：文件系统事件只知道路径，得先换成 uuid 才能定向核对。 */
export function findPlaylistViewSnapshotUuidsByRoot(listRoot: string): string[] {
  const normalized = normalizeSnapshotListRoot(listRoot)
  if (!normalized) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = getStatements(db).selectUuidsByRoot.all(normalized) as SnapshotRow[]
    return rows.map((row) => String(row.song_list_uuid || '')).filter(Boolean)
  } catch (error) {
    log.error('[playlist-snapshot] find by root failed', error)
    return []
  }
}

/** 空闲轮转核对的候选：verified_at_ms 最小的排前面（0 是待重建哨兵）。 */
export function listPlaylistViewSnapshotVerificationCandidates(
  limit: number
): PlaylistViewSnapshotMeta[] {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 1))
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = getStatements(db).selectVerificationCandidates.all(safeLimit) as SnapshotRow[]
    return rows.map(readMetaFromRow).filter((meta) => Boolean(meta.songListUUID && meta.listRoot))
  } catch (error) {
    log.error('[playlist-snapshot] list verification candidates failed', error)
    return []
  }
}

export function deletePlaylistViewSnapshot(songListUUID: string): void {
  const uuid = normalizeUuid(songListUUID)
  if (!uuid) return
  const db = getLibraryDb()
  if (!db) return
  try {
    getStatements(db).deleteByUuid.run(uuid)
  } catch (error) {
    log.error('[playlist-snapshot] delete failed', error)
  }
}

export function deletePlaylistViewSnapshotsByRoot(listRoot: string): void {
  const normalized = normalizeSnapshotListRoot(listRoot)
  if (!normalized) return
  const db = getLibraryDb()
  if (!db) return
  try {
    getStatements(db).deleteByRoot.run(normalized)
  } catch (error) {
    log.error('[playlist-snapshot] delete by root failed', error)
  }
}

/** 树对账后清掉已经不存在的歌单快照，避免 UUID 复用时读到旧内容。 */
export function prunePlaylistViewSnapshots(knownSongListUUIDs: Iterable<string>): number {
  const db = getLibraryDb()
  if (!db) return 0
  const known = new Set<string>()
  for (const uuid of knownSongListUUIDs) {
    const normalized = normalizeUuid(uuid)
    if (normalized) known.add(normalized)
  }
  try {
    const statements = getStatements(db)
    const rows = statements.listUuids.all() as SnapshotRow[]
    const stale = rows
      .map((row) => String(row.song_list_uuid || ''))
      .filter((uuid) => uuid && !known.has(uuid))
    if (stale.length === 0) return 0
    const removeAll = db.transaction((uuids: string[]) => {
      for (const uuid of uuids) statements.deleteByUuid.run(uuid)
    })
    removeAll(stale)
    return stale.length
  } catch (error) {
    log.error('[playlist-snapshot] prune failed', error)
    return 0
  }
}
