import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import {
  normalizePath,
  resolveAbsoluteFilePath,
  resolveAbsoluteListRoot,
  resolveFilePathInput,
  resolveListRootInput
} from './pathResolvers'

/**
 * 分散核对专用的"只取 size / mtime"批量探针。
 *
 * 与 loadSongCacheEntry 的区别（别把两者混用）：
 *  - 这里**不做**松散比较、跨库补分析、写回，也不解析 info_json；查不到就当"不知道"，
 *    上层据此跳过该行，不会因为 key 归一化差异误报"变了"。
 *  - 目的只有一个：用户滚动/播放到某几行时，花一条走索引的 SQL + 几次 stat
 *    判断这几首有没有被外部改过，不必整单重扫。
 *
 * 返回值的键是 normalizePath 归一化后的绝对路径（win32 上是小写），调用方查表时
 * 必须用同一个 normalizePath，不能直接拿 path.resolve 的原始大小写去查。
 */
export type SongCacheFileStat = {
  size: number
  mtimeMs: number
}

type FileStatRow = {
  file_path?: unknown
  size?: unknown
  mtime_ms?: unknown
}

const toFiniteNumber = (value: unknown): number | null => {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

/** 一条 SQL 最多带这么多参数，超了分批，避免 SQLITE_MAX_VARIABLE_NUMBER。 */
const MAX_KEYS_PER_QUERY = 200

export function loadSongCacheFileStats(
  listRoot: string,
  filePaths: readonly string[]
): Map<string, SongCacheFileStat> {
  const stats = new Map<string, SongCacheFileStat>()
  const db = getLibraryDb()
  if (!db || !listRoot || filePaths.length === 0) return stats
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return stats
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)

  const keys: string[] = []
  const seenKeys = new Set<string>()
  for (const filePath of filePaths) {
    const resolvedFile = resolveFilePathInput(listRootAbs, String(filePath || ''))
    if (!resolvedFile) continue
    if (seenKeys.has(resolvedFile.key)) continue
    seenKeys.add(resolvedFile.key)
    keys.push(resolvedFile.key)
  }
  if (keys.length === 0) return stats

  try {
    for (let offset = 0; offset < keys.length; offset += MAX_KEYS_PER_QUERY) {
      const batch = keys.slice(offset, offset + MAX_KEYS_PER_QUERY)
      const placeholders = batch.map(() => '?').join(', ')
      const rows = db
        .prepare(
          `SELECT file_path, size, mtime_ms FROM song_cache
           WHERE list_root = ? AND file_path IN (${placeholders})`
        )
        .all(listRootKey, ...batch) as FileStatRow[]
      for (const row of rows) {
        const size = toFiniteNumber(row?.size)
        const mtimeMs = toFiniteNumber(row?.mtime_ms)
        if (size === null || mtimeMs === null) continue
        const abs = resolveAbsoluteFilePath(listRootKey, String(row?.file_path || ''))
        if (!abs) continue
        stats.set(normalizePath(abs), { size, mtimeMs })
      }
    }
  } catch (error) {
    log.error('[sqlite] song cache file stats load failed', error)
    return new Map()
  }
  return stats
}
