import fs from 'node:fs/promises'
import path from 'node:path'
import store from '../store'
import { getCoreFsDirName } from '../coreLibraries'
import { collectFilesWithExtensions } from '../nodeTaskUtils'
import * as LibraryCacheDb from '../libraryCacheDb'
import { findSongListRootByPath } from '../libraryTreeDb'
import type { SongCacheEntry } from '../libraryCacheDb/types'
import type { ISongInfo } from '../../types/globals'
import { buildLiteSongInfo, applyLiteDefaults } from './songInfoLite'

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

type PlaylistTrackNumberEnsureResult = {
  changed: boolean
  initialized: boolean
  repaired: boolean
}

const normalizePath = (value: string) => {
  const resolved = path.resolve(String(value || ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export const normalizePlaylistTrackNumber = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  const rounded = Math.floor(numeric)
  if (rounded <= 0) return undefined
  return rounded
}

const compareStableFilePath = (listRoot: string, leftPath: string, rightPath: string) => {
  const leftRelative = path.relative(listRoot, leftPath).replace(/\\/g, '/')
  const rightRelative = path.relative(listRoot, rightPath).replace(/\\/g, '/')
  const relativeCompare = collator.compare(leftRelative, rightRelative)
  if (relativeCompare !== 0) return relativeCompare
  const leftName = path.basename(leftPath)
  const rightName = path.basename(rightPath)
  const nameCompare = collator.compare(leftName, rightName)
  if (nameCompare !== 0) return nameCompare
  return collator.compare(leftPath, rightPath)
}

const compareStableSong = (listRoot: string, left: ISongInfo, right: ISongInfo) =>
  compareStableFilePath(listRoot, left.filePath, right.filePath)

const isSupportedPlaylistTrackNumberListRoot = (listRoot: string) => {
  const dbRoot = String(store.databaseDir || '').trim()
  if (!dbRoot || !listRoot) return false
  const resolvedListRoot = normalizePath(listRoot)
  const coreRoots = [
    path.join(dbRoot, 'library', getCoreFsDirName('FilterLibrary')),
    path.join(dbRoot, 'library', getCoreFsDirName('CuratedLibrary'))
  ].map((item) => normalizePath(item))
  return coreRoots.some(
    (rootPath) =>
      resolvedListRoot === rootPath || resolvedListRoot.startsWith(`${rootPath}${path.sep}`)
  )
}

const hasContinuousTrackNumbers = (songs: ISongInfo[]) => {
  if (songs.length === 0) return true
  const numbers = songs.map((song) => normalizePlaylistTrackNumber(song.playlistTrackNumber))
  if (numbers.some((value) => value === undefined)) return false
  const normalized = numbers as number[]
  const unique = new Set(normalized)
  if (unique.size !== songs.length) return false
  const max = Math.max(...normalized)
  const min = Math.min(...normalized)
  return min === 1 && max === songs.length
}

const buildRepairOrder = (songs: ISongInfo[], listRoot: string) =>
  [...songs].sort((left, right) => {
    const leftNumber = normalizePlaylistTrackNumber(left.playlistTrackNumber)
    const rightNumber = normalizePlaylistTrackNumber(right.playlistTrackNumber)
    if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) {
      return leftNumber - rightNumber
    }
    if (leftNumber !== undefined && rightNumber === undefined) return -1
    if (leftNumber === undefined && rightNumber !== undefined) return 1
    return compareStableSong(listRoot, left, right)
  })

export const ensurePlaylistTrackNumbers = (
  songs: ISongInfo[],
  listRoot: string
): PlaylistTrackNumberEnsureResult => {
  if (!isSupportedPlaylistTrackNumberListRoot(listRoot) || songs.length === 0) {
    return { changed: false, initialized: false, repaired: false }
  }
  const numberedCount = songs.filter(
    (song) => normalizePlaylistTrackNumber(song.playlistTrackNumber) !== undefined
  ).length
  if (numberedCount === songs.length && hasContinuousTrackNumbers(songs)) {
    return { changed: false, initialized: false, repaired: false }
  }

  const orderedSongs =
    numberedCount <= 0
      ? [...songs].sort((left, right) => compareStableSong(listRoot, left, right))
      : buildRepairOrder(songs, listRoot)

  let changed = false
  orderedSongs.forEach((song, index) => {
    const nextNumber = index + 1
    if (normalizePlaylistTrackNumber(song.playlistTrackNumber) !== nextNumber) {
      changed = true
    }
    song.playlistTrackNumber = nextNumber
  })

  return {
    changed,
    initialized: numberedCount <= 0 && changed,
    repaired: numberedCount > 0 && changed
  }
}

export const sortSongsByPlaylistTrackNumber = (songs: ISongInfo[], listRoot: string) => {
  if (!isSupportedPlaylistTrackNumberListRoot(listRoot)) return [...songs]
  return [...songs].sort((left, right) => {
    const leftNumber = normalizePlaylistTrackNumber(left.playlistTrackNumber)
    const rightNumber = normalizePlaylistTrackNumber(right.playlistTrackNumber)
    if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) {
      return leftNumber - rightNumber
    }
    if (leftNumber !== undefined && rightNumber === undefined) return -1
    if (leftNumber === undefined && rightNumber !== undefined) return 1
    return compareStableSong(listRoot, left, right)
  })
}

const uniqueExistingFiles = async (listRoot: string) => {
  const files = await collectFilesWithExtensions(listRoot, store.settingConfig.audioExt || [])
  const normalizedByPath = new Map<string, string>()
  for (const filePath of files) {
    const resolved = path.resolve(filePath)
    const key = normalizePath(resolved)
    if (!normalizedByPath.has(key)) {
      normalizedByPath.set(key, resolved)
    }
  }
  return [...normalizedByPath.values()]
}

type PlaylistOrderKey = {
  filePath: string
  trackNumber: number | undefined
  relativePath: string
  baseName: string
}

const buildPlaylistOrderKey = (
  filePath: string,
  cacheMapByNormalizedPath: Map<string, SongCacheEntry>,
  listRoot: string
): PlaylistOrderKey => ({
  filePath,
  trackNumber: normalizePlaylistTrackNumber(
    cacheMapByNormalizedPath.get(normalizePath(filePath))?.info?.playlistTrackNumber
  ),
  relativePath: path.relative(listRoot, filePath).replace(/\\/g, '/'),
  baseName: path.basename(filePath)
})

/** 与 `compareStableFilePath` 同序，只是吃预计算好的键。 */
const comparePlaylistOrderKey = (left: PlaylistOrderKey, right: PlaylistOrderKey) => {
  const leftNumber = left.trackNumber
  const rightNumber = right.trackNumber
  if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) {
    return leftNumber - rightNumber
  }
  if (leftNumber !== undefined && rightNumber === undefined) return -1
  if (leftNumber === undefined && rightNumber !== undefined) return 1
  const relativeCompare = collator.compare(left.relativePath, right.relativePath)
  if (relativeCompare !== 0) return relativeCompare
  const nameCompare = collator.compare(left.baseName, right.baseName)
  if (nameCompare !== 0) return nameCompare
  return collator.compare(left.filePath, right.filePath)
}

/**
 * 排序键先算一遍再排。
 *
 * 原来的比较器在每次比较里现算 `normalizePath`（path.resolve + 小写）和
 * `compareStableFilePath`（path.relative + 正则 + Intl.Collator）。n log n 次比较下，
 * 同一个路径的这些字符串操作会被重复上千次，而它们的值只由路径本身决定。整理几百首的
 * 歌单时这段是秒级收尾里实打实的一块。
 */
const resolveExistingOrder = (
  currentFiles: string[],
  cacheMapByNormalizedPath: Map<string, SongCacheEntry>,
  listRoot: string
) =>
  currentFiles
    .map((filePath) => buildPlaylistOrderKey(filePath, cacheMapByNormalizedPath, listRoot))
    .sort(comparePlaylistOrderKey)
    .map((key) => key.filePath)

const buildEntryForFile = async (
  filePath: string,
  entry: SongCacheEntry | undefined,
  playlistTrackNumber: number
): Promise<[string, SongCacheEntry] | null> => {
  try {
    const stat = await fs.stat(filePath)
    const nextInfo = entry?.info
      ? applyLiteDefaults({ ...entry.info }, filePath)
      : buildLiteSongInfo(filePath)
    nextInfo.filePath = filePath
    nextInfo.playlistTrackNumber = playlistTrackNumber
    return [
      filePath,
      {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        info: nextInfo
      }
    ]
  } catch {
    return null
  }
}

const toNormalizedCacheMap = (cacheMap: Map<string, SongCacheEntry>) =>
  new Map(
    [...cacheMap.entries()].map(([filePath, entry]) => [normalizePath(filePath), entry] as const)
  )

/**
 * 写入真实序号。
 *
 * `preloadedCacheMap` 用于复用调用方刚加载过的歌单缓存：`loadSongCache` 是全量同步 SQLite 读 +
 * 逐行 JSON.parse，一次序号整理里重复读两遍会在主进程上白等一份全表加载。调用方若在加载后、
 * 落盘前改过缓存，必须重新传 undefined。
 */
const persistSongListTrackNumberOrder = async (
  listRoot: string,
  finalOrder: string[],
  preloadedCacheMap?: Map<string, SongCacheEntry>
) => {
  if (!isSupportedPlaylistTrackNumberListRoot(listRoot)) {
    return { updated: false, total: 0 }
  }
  const cacheMap =
    preloadedCacheMap ||
    (await LibraryCacheDb.loadSongCache(listRoot)) ||
    new Map<string, SongCacheEntry>()
  const cacheMapByNormalizedPath = toNormalizedCacheMap(cacheMap)
  const nextEntries = new Map<string, SongCacheEntry>()
  for (let index = 0; index < finalOrder.length; index += 1) {
    const filePath = finalOrder[index]
    const resolved = await buildEntryForFile(
      filePath,
      cacheMapByNormalizedPath.get(normalizePath(filePath)),
      index + 1
    )
    if (!resolved) continue
    nextEntries.set(resolved[0], resolved[1])
  }
  const updated = await LibraryCacheDb.replaceSongCache(listRoot, nextEntries)
  return { updated, total: nextEntries.size }
}

export const setSongListTrackNumbersByOrder = async (params: {
  listRoot: string
  orderedFilePaths: string[]
}) => {
  const { listRoot, orderedFilePaths } = params
  if (!isSupportedPlaylistTrackNumberListRoot(listRoot)) {
    return { updated: false, total: 0 }
  }
  const currentFiles = await uniqueExistingFiles(listRoot)
  const currentFileMap = new Map(
    currentFiles.map((filePath) => [normalizePath(filePath), filePath])
  )
  const orderedUnique: string[] = []
  const seen = new Set<string>()
  for (const item of orderedFilePaths || []) {
    const filePath = currentFileMap.get(normalizePath(item))
    if (!filePath) continue
    const key = normalizePath(filePath)
    if (seen.has(key)) continue
    seen.add(key)
    orderedUnique.push(filePath)
  }
  const cacheMap =
    (await LibraryCacheDb.loadSongCache(listRoot)) || new Map<string, SongCacheEntry>()
  const cacheMapByNormalizedPath = toNormalizedCacheMap(cacheMap)
  const existingOrder = resolveExistingOrder(currentFiles, cacheMapByNormalizedPath, listRoot)
  const remaining = existingOrder.filter((filePath) => !seen.has(normalizePath(filePath)))
  const finalOrder = [...orderedUnique, ...remaining]
  const persisted = await persistSongListTrackNumberOrder(listRoot, finalOrder, cacheMap)
  const persistedCache =
    (await LibraryCacheDb.loadSongCache(listRoot)) || new Map<string, SongCacheEntry>()
  const persistedCacheByNormalizedPath = toNormalizedCacheMap(persistedCache)
  const persistedSample = finalOrder.slice(0, 5).map((filePath, index) => {
    const entry = persistedCacheByNormalizedPath.get(normalizePath(filePath))
    return {
      expectedNumber: index + 1,
      persistedNumber: normalizePlaylistTrackNumber(entry?.info?.playlistTrackNumber) || null,
      filePath
    }
  })
  const mismatch = persistedSample.find((item) => item.expectedNumber !== item.persistedNumber)
  if (mismatch) {
    throw new Error('真实序号写入后校验失败')
  }
  return persisted
}

export const appendSongListTrackNumbers = async (params: {
  listRoot: string
  appendedFilePaths: string[]
}) => {
  const { listRoot, appendedFilePaths } = params
  if (!isSupportedPlaylistTrackNumberListRoot(listRoot)) {
    return { updated: false, total: 0 }
  }
  const currentFiles = await uniqueExistingFiles(listRoot)
  const currentFileMap = new Map(
    currentFiles.map((filePath) => [normalizePath(filePath), filePath])
  )
  const appendedUnique: string[] = []
  const appendedSet = new Set<string>()
  for (const item of appendedFilePaths || []) {
    const filePath = currentFileMap.get(normalizePath(item))
    if (!filePath) continue
    const key = normalizePath(filePath)
    if (appendedSet.has(key)) continue
    appendedSet.add(key)
    appendedUnique.push(filePath)
  }
  const cacheMap =
    (await LibraryCacheDb.loadSongCache(listRoot)) || new Map<string, SongCacheEntry>()
  const cacheMapByNormalizedPath = toNormalizedCacheMap(cacheMap)
  const remainingExisting = resolveExistingOrder(
    currentFiles.filter((filePath) => !appendedSet.has(normalizePath(filePath))),
    cacheMapByNormalizedPath,
    listRoot
  )
  return await persistSongListTrackNumberOrder(
    listRoot,
    [...remainingExisting, ...appendedUnique],
    cacheMap
  )
}

export const compactSongListTrackNumbers = async (listRoot: string) => {
  if (!isSupportedPlaylistTrackNumberListRoot(listRoot)) {
    return { updated: false, total: 0 }
  }
  const currentFiles = await uniqueExistingFiles(listRoot)
  const cacheMap =
    (await LibraryCacheDb.loadSongCache(listRoot)) || new Map<string, SongCacheEntry>()
  const cacheMapByNormalizedPath = toNormalizedCacheMap(cacheMap)
  const existingOrder = resolveExistingOrder(currentFiles, cacheMapByNormalizedPath, listRoot)
  return await persistSongListTrackNumberOrder(listRoot, existingOrder, cacheMap)
}

export const compactSongListTrackNumbersByFilePaths = async (filePaths: string[]) => {
  const roots = new Map<string, string>()
  // 一批被删文件通常同属一个歌单目录，而 findSongListRootByPath 每调一次都要沿库树做
  // 若干次同步 SQLite 查询。这里按目录在单次调用内去重，避免对每个文件重复解析。
  const rootByDir = new Map<string, string | null>()
  for (const rawPath of Array.isArray(filePaths) ? filePaths : []) {
    const filePath = String(rawPath || '').trim()
    if (!filePath) continue
    const dir = path.dirname(filePath)
    const dirKey = normalizePath(dir)
    let songListRoot = rootByDir.get(dirKey)
    if (songListRoot === undefined) {
      songListRoot = await findSongListRootByPath(dir)
      rootByDir.set(dirKey, songListRoot)
    }
    if (!songListRoot || !isSupportedPlaylistTrackNumberListRoot(songListRoot)) continue
    roots.set(normalizePath(songListRoot), songListRoot)
  }

  let updated = false
  let total = 0
  for (const songListRoot of roots.values()) {
    const result = await compactSongListTrackNumbers(songListRoot)
    updated = updated || Boolean(result.updated)
    total += Number(result.total || 0)
  }

  return {
    updated,
    total,
    roots: roots.size
  }
}

export { isSupportedPlaylistTrackNumberListRoot }
