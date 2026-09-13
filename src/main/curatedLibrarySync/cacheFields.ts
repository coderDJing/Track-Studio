import path from 'node:path'
import { findSongListRootByPath } from '../libraryTreeDb'
import * as LibraryCacheDb from '../libraryCacheDb'
import type { SongCacheEntry } from '../libraryCacheDb'
import { normalizeAddedAtMs } from '../../shared/songAddedAt'
import { normalizePlaylistTrackNumber } from '../services/playlistTrackNumbers'

export type CuratedCacheFields = {
  trackNumber: number | null
  addedAtMs: number | null
}

const EMPTY_CACHE_FIELDS: CuratedCacheFields = { trackNumber: null, addedAtMs: null }

const normalizeAbsPath = (value: string): string => {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved
}

const toCacheFields = (entry: SongCacheEntry | null | undefined): CuratedCacheFields => ({
  trackNumber: normalizePlaylistTrackNumber(entry?.info?.playlistTrackNumber) ?? null,
  addedAtMs: normalizeAddedAtMs(entry?.info?.addedAtMs) ?? null
})

export const readCacheFields = async (absPath: string): Promise<CuratedCacheFields> => {
  try {
    const listRoot = await findSongListRootByPath(path.dirname(absPath))
    if (!listRoot) return EMPTY_CACHE_FIELDS
    return toCacheFields(await LibraryCacheDb.loadSongCacheEntry(listRoot, absPath))
  } catch {
    return EMPTY_CACHE_FIELDS
  }
}

/**
 * 按歌单整批读取实时曲序/加入时间。同步落地必须在写曲序前重新读取一次，不能使用
 * 扫描开始时的旧值；同时也不能逐首查询 SQLite，否则大歌单会产生线性主进程开销。
 */
export const readCacheFieldsBatch = async (
  absPaths: readonly string[]
): Promise<Map<string, CuratedCacheFields>> => {
  const result = new Map<string, CuratedCacheFields>()
  const listRootByDirectory = new Map<string, string | null>()
  const pathsByListRoot = new Map<string, { listRoot: string; paths: string[] }>()

  for (const absPath of absPaths) {
    const directory = path.dirname(absPath)
    const directoryKey = normalizeAbsPath(directory)
    let listRoot = listRootByDirectory.get(directoryKey)
    if (!listRootByDirectory.has(directoryKey)) {
      listRoot = (await findSongListRootByPath(directory)) || null
      listRootByDirectory.set(directoryKey, listRoot)
    }
    if (!listRoot) {
      result.set(absPath, EMPTY_CACHE_FIELDS)
      continue
    }
    const listRootKey = normalizeAbsPath(listRoot)
    const group = pathsByListRoot.get(listRootKey) || { listRoot, paths: [] }
    group.paths.push(absPath)
    pathsByListRoot.set(listRootKey, group)
  }

  for (const { listRoot, paths } of pathsByListRoot.values()) {
    try {
      const cache = await LibraryCacheDb.loadSongCache(listRoot)
      const normalizedCache = new Map<string, SongCacheEntry>()
      for (const [filePath, entry] of cache || []) {
        normalizedCache.set(normalizeAbsPath(filePath), entry)
      }
      for (const absPath of paths) {
        result.set(absPath, toCacheFields(normalizedCache.get(normalizeAbsPath(absPath))))
      }
    } catch {
      for (const absPath of paths) result.set(absPath, EMPTY_CACHE_FIELDS)
    }
  }

  return result
}
