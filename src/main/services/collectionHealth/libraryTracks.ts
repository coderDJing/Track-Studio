import path from 'node:path'
import store from '../../store'
import { getCoreFsDirName, type CoreLibraryName } from '../../coreLibraries'
import { loadLibraryNodes, type LibraryNodeRow } from '../../libraryTreeDb'
import { getLibraryDb } from '../../libraryDb'
import { SONG_CACHE_INFO_PATH_SQL } from '../../libraryCacheDb/songCachePathSql'
import { resolveCacheListRootAbs } from '../../libraryCacheDb'
import { mainFilePathKey } from '../../filePathComparison'

/** 曲库体检的曲目身份：list_root + file_path 与 song_cache 一致，便于合并时重映射。 */
export type LibraryTrack = {
  listRoot: string
  filePath: string
  absFilePath: string
  fileName: string
  title: string
  artist: string
  album: string
  duration: string
  bitrate: number | null
  size: number
  mtimeMs: number
  songListName: string
  songListUuid: string
}

export function getCollectionHealthLibraryRoot(libraryName: CoreLibraryName): string | null {
  const dbRoot = String(store.databaseDir || '').trim()
  if (!dbRoot) return null
  return path.join(dbRoot, 'library', getCoreFsDirName(libraryName))
}

type PlaylistMeta = { uuid: string; dirName: string }

const normalizeRelativeKey = (value: string): string => value.replace(/\\/g, '/').toLowerCase()

const buildPlaylistMeta = () => {
  const byListRoot = new Map<string, PlaylistMeta>()
  const byAbsPath = new Map<string, PlaylistMeta>()
  const dbRoot = String(store.databaseDir || '').trim()
  const rows: readonly LibraryNodeRow[] = loadLibraryNodes(dbRoot || undefined) || []
  if (!rows.length || !dbRoot) return { byListRoot, byAbsPath }

  const childrenByParent = new Map<string, LibraryNodeRow[]>()
  for (const row of rows) {
    if (!row.parentUuid) continue
    const list = childrenByParent.get(row.parentUuid)
    if (list) list.push(row)
    else childrenByParent.set(row.parentUuid, [row])
  }
  const pathByUuid = new Map<string, string>()
  const root = rows.find((row) => row.parentUuid === null && row.nodeType === 'root')
  if (!root) return { byListRoot, byAbsPath }
  pathByUuid.set(root.uuid, root.dirName)
  const queue: LibraryNodeRow[] = [root]
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i]
    const basePath = pathByUuid.get(current.uuid)
    if (!basePath) continue
    for (const child of childrenByParent.get(current.uuid) || []) {
      const childPath = path.join(basePath, child.dirName)
      if (!pathByUuid.has(child.uuid)) pathByUuid.set(child.uuid, childPath)
      queue.push(child)
    }
  }
  for (const row of rows) {
    if (
      row.nodeType !== 'songList' &&
      row.nodeType !== 'mixtapeList' &&
      row.nodeType !== 'setList'
    ) {
      continue
    }
    const relPath = pathByUuid.get(row.uuid)
    if (!relPath) continue
    const meta: PlaylistMeta = { uuid: row.uuid, dirName: row.dirName }
    byListRoot.set(normalizeRelativeKey(relPath), meta)
    byAbsPath.set(mainFilePathKey(path.join(dbRoot, relPath)), meta)
  }
  return { byListRoot, byAbsPath }
}

const resolvePlaylistMeta = (
  listRoot: string,
  meta: ReturnType<typeof buildPlaylistMeta>
): PlaylistMeta | null => {
  const direct = meta.byListRoot.get(normalizeRelativeKey(listRoot))
  if (direct) return direct
  const abs = resolveCacheListRootAbs(listRoot)
  if (!abs) return null
  return meta.byAbsPath.get(mainFilePathKey(abs)) || null
}

type SongCacheScanRow = {
  row_id: number
  list_root: string
  file_path: string
  size: number
  mtime_ms: number
  info_json: string
}

const PAGE_SIZE = 200

const parseInfo = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(String(raw || '{}')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** 专辑名保留原始空白，体检需要识别“只有首尾空格不同”的标签混乱。 */
const readRawText = (value: unknown): string => (typeof value === 'string' ? value : '')

/** song_cache 里存的是 music-metadata 的 bps（如 320000），体检统一换算成 kbps。 */
const readBitrate = (value: unknown): number | null => {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  return num >= 1000 ? Math.round(num / 1000) : Math.round(num)
}

/**
 * 以物理库根为范围枚举 song_cache。路径过滤走 info_json.filePath 的规范化表达式索引，
 * 不依赖 list_root 的写法规格；同一条绝对路径在一个库里只保留一行。
 */
export async function enumerateLibraryTracks(
  libraryName: CoreLibraryName,
  shouldAbort: () => boolean = () => false
): Promise<LibraryTrack[] | null> {
  const db = getLibraryDb()
  const rootAbs = getCollectionHealthLibraryRoot(libraryName)
  if (!db || !rootAbs) return null
  const rootKey = mainFilePathKey(rootAbs).replace(/\//g, '\\')
  const prefix = rootKey.endsWith('\\') ? rootKey : `${rootKey}\\`
  const upper = `${prefix}\uffff`

  const statement = db.prepare<SongCacheScanRow>(
    `SELECT rowid AS row_id, list_root, file_path, size, mtime_ms, info_json
       FROM song_cache
      WHERE ${SONG_CACHE_INFO_PATH_SQL} >= ?
        AND ${SONG_CACHE_INFO_PATH_SQL} < ?
        AND rowid > ?
      ORDER BY rowid ASC
      LIMIT ?`
  )

  const meta = buildPlaylistMeta()
  const tracks: LibraryTrack[] = []
  const seen = new Set<string>()
  let cursor = 0
  while (true) {
    if (shouldAbort()) return null
    const rows = statement.all(prefix, upper, cursor, PAGE_SIZE)
    if (rows.length === 0) break
    for (const row of rows) {
      cursor = Number(row.row_id)
      const info = parseInfo(row.info_json)
      const absFilePath = readText(info?.filePath)
      if (!absFilePath) continue
      const key = mainFilePathKey(absFilePath)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const listRoot = String(row.list_root || '').trim()
      const filePath = String(row.file_path || '').trim() || path.basename(absFilePath)
      if (!listRoot) continue
      const playlist = resolvePlaylistMeta(listRoot, meta)
      tracks.push({
        listRoot,
        filePath,
        absFilePath,
        fileName: readText(info?.fileName) || path.basename(absFilePath),
        title: readText(info?.title) || path.basename(absFilePath),
        artist: readText(info?.artist),
        album: readRawText(info?.album),
        duration: String(info?.duration ?? '').trim(),
        bitrate: readBitrate(info?.bitrate),
        size: Number(row.size) || 0,
        mtimeMs: Number(row.mtime_ms) || 0,
        songListName: playlist?.dirName || '',
        songListUuid: playlist?.uuid || ''
      })
    }
    if (rows.length < PAGE_SIZE) break
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return tracks
}
