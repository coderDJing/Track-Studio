import path = require('path')
import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import type { ISongInfo } from '../../types/globals'
import { normalizeFilePathForComparison } from '../../shared/filePathComparison'
import {
  normalizeRoot,
  resolveAbsoluteFilePath,
  resolveListRootInput,
  toNumber
} from '../libraryCacheDb/pathResolvers'
import {
  normalizedSongCachePathSql,
  SONG_CACHE_INFO_PATH_SQL
} from '../libraryCacheDb/songCachePathSql'

export type SetSongCacheCandidate = {
  listRoot: string
  size: number
  mtimeMs: number
  info: ISongInfo
  analysisOnly: boolean
}

type SetSongCacheRow = {
  list_root?: string
  file_path?: string
  size?: unknown
  mtime_ms?: unknown
  info_json?: unknown
}

const CACHE_LOOKUP_CHUNK = 200

export const setSongCacheLookupKey = (filePath: string): string => {
  const trimmed = typeof filePath === 'string' ? filePath.trim() : ''
  if (!trimmed) return ''
  return normalizeFilePathForComparison(path.normalize(trimmed), process.platform === 'win32')
}

const hasDisplayMetadata = (info: ISongInfo | null | undefined): boolean =>
  Boolean(info && String(info.title || info.fileName || '').trim())

const sameFileStat = (
  candidate: SetSongCacheCandidate,
  stats: { size: number; mtimeMs: number }
): boolean =>
  candidate.size === stats.size &&
  Number.isFinite(candidate.mtimeMs) &&
  Number.isFinite(stats.mtimeMs) &&
  Math.abs(candidate.mtimeMs - stats.mtimeMs) < 1

const listRootKey = (value: string): string => {
  const text = value.trim()
  if (!text) return ''
  return resolveListRootInput(text)?.key || normalizeRoot(text)
}

/**
 * 选出和当前文件大小、修改时间一致的完整曲目缓存。
 * 只有分析结果（analysisOnly）或连展示名都没有的缓存不能代替读标签。来源歌单的缓存优先。
 */
export const pickCurrentSetSongCache = (
  candidates: readonly SetSongCacheCandidate[],
  stats: { size: number; mtimeMs: number },
  preferredListRoot: string
): SetSongCacheCandidate | null => {
  const matches = candidates.filter(
    (candidate) =>
      !candidate.analysisOnly &&
      hasDisplayMetadata(candidate.info) &&
      sameFileStat(candidate, stats)
  )
  if (matches.length === 0) return null
  const preferred = listRootKey(preferredListRoot)
  if (!preferred) return matches[0]
  return matches.find((candidate) => listRootKey(candidate.listRoot) === preferred) || matches[0]
}

/**
 * 展示行优先；同一文件在其他歌单里的分析只补展示行还没有的字段。
 * 展示行里已存在的 cue 数组（包括用户清空后的空数组）以它为准，不能被别处的旧 cue 补回来。
 */
export const combineCurrentSetSongCache = (
  picked: SetSongCacheCandidate,
  candidates: readonly SetSongCacheCandidate[],
  stats: { size: number; mtimeMs: number },
  mergeAnalysis: (target: ISongInfo, source: Partial<ISongInfo>) => ISongInfo
): ISongInfo => {
  let info: ISongInfo = { ...picked.info }
  for (const candidate of candidates) {
    if (candidate === picked || !sameFileStat(candidate, stats)) continue
    info = mergeAnalysis(info, candidate.info)
  }
  if (Array.isArray(picked.info.hotCues)) info.hotCues = picked.info.hotCues
  if (Array.isArray(picked.info.memoryCues)) info.memoryCues = picked.info.memoryCues
  return info
}

const parseCacheInfo = (raw: unknown): ISongInfo | null => {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as ISongInfo
  } catch {
    return null
  }
}

/** 按文件路径一次取出各歌单里的曲目缓存。Set 的成员分散在多个歌单，不能按单个目录整表装载。 */
export const loadSetSongCacheCandidates = async (
  filePaths: readonly string[]
): Promise<Map<string, SetSongCacheCandidate[]>> => {
  const result = new Map<string, SetSongCacheCandidate[]>()
  const db = getLibraryDb()
  const uniquePaths = [...new Set(filePaths.map((filePath) => filePath.trim()).filter(Boolean))]
  if (!db || uniquePaths.length === 0) return result

  try {
    const valueExpr = normalizedSongCachePathSql('?')
    const fileExpr = normalizedSongCachePathSql('file_path')
    for (let offset = 0; offset < uniquePaths.length; offset += CACHE_LOOKUP_CHUNK) {
      const chunk = uniquePaths.slice(offset, offset + CACHE_LOOKUP_CHUNK)
      const placeholders = chunk.map(() => valueExpr).join(', ')
      // 现行缓存的 file_path 列是歌单内相对路径；绝对路径写在 info_json.filePath。
      // 旧行可能把绝对路径直接存在 file_path 列，所以两边都查。
      const rows = db
        .prepare<SetSongCacheRow>(
          `SELECT list_root, file_path, size, mtime_ms, info_json
           FROM song_cache
           WHERE ${SONG_CACHE_INFO_PATH_SQL} IN (${placeholders})
              OR ${fileExpr} IN (${placeholders})`
        )
        .all(...chunk, ...chunk)
      for (const row of rows) {
        const storedFilePath = typeof row.file_path === 'string' ? row.file_path : ''
        const listRoot = typeof row.list_root === 'string' ? row.list_root : ''
        const size = toNumber(row.size)
        const mtimeMs = toNumber(row.mtime_ms)
        const info = parseCacheInfo(row.info_json)
        if (!storedFilePath || size === null || mtimeMs === null || !info) continue
        const infoPath = typeof info.filePath === 'string' ? info.filePath.trim() : ''
        const absolutePath = infoPath
          ? path.isAbsolute(infoPath)
            ? infoPath
            : resolveAbsoluteFilePath(listRoot, infoPath)
          : path.isAbsolute(storedFilePath)
            ? storedFilePath
            : resolveAbsoluteFilePath(listRoot, storedFilePath)
        const key = setSongCacheLookupKey(absolutePath)
        if (!key) continue
        const candidate: SetSongCacheCandidate = {
          listRoot,
          size,
          mtimeMs,
          info,
          analysisOnly: info.analysisOnly === true
        }
        const group = result.get(key)
        if (group) group.push(candidate)
        else result.set(key, [candidate])
      }
    }
  } catch (error) {
    log.error('[setList] song cache lookup failed', error)
  }
  return result
}
