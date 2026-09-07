import path = require('path')
import fs = require('fs-extra')
import { ISongInfo } from '../../types/globals'
import { mapRendererPathToFsPath, operateHiddenFile } from '../utils'
import store from '../store'
import * as LibraryCacheDb from '../libraryCacheDb'
import { findSongListRootByPath, loadLibraryNodes } from '../libraryTreeDb'
import type { LibraryNodeRow } from '../libraryTreeDb'
import {
  getLibraryRootAbs,
  isUnderPath,
  removeLibraryStemAssetFiles
} from './libraryStemAssetStorage'
import {
  removeMixtapeStemAssetsByFilePath,
  replaceMixtapeStemAssetFilePath
} from '../mixtapeStemDb'
import { cancelKeyAnalysisForPaths } from './keyAnalysisQueue'
import { getCoreFsDirName } from '../coreLibraries'
import { resolveCanonicalSongBeatGridV2 } from '../../shared/songAnalysisCompleteness'
import type { TrackReanalysisPlan } from '../../shared/trackReanalysisSelection'

const SET_CUSTODY_DIR_NAME = '__set_custody__'

type CacheFileStat = {
  size: number
  mtimeMs: number
}

type TrackCacheTransferMode = 'move' | 'copy'

const normalizePath = (value: string): string => {
  if (!value) return ''
  let normalized = path.resolve(value)
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }
  return normalized
}

const isCacheStatMatch = (
  entry: { size?: unknown; mtimeMs?: unknown } | null | undefined,
  stat: CacheFileStat
) =>
  Boolean(
    entry &&
    Number(entry.size) === stat.size &&
    Number.isFinite(Number(entry.mtimeMs)) &&
    Math.abs(Number(entry.mtimeMs) - stat.mtimeMs) <= 1
  )

async function findSongListRoot(startDir: string): Promise<string | null> {
  if (!startDir) return null
  const rootDir = store.databaseDir
  if (rootDir) {
    const recycleRoot = path.join(rootDir, mapRendererPathToFsPath('library/RecycleBin'))
    const recordingRoot = path.join(rootDir, mapRendererPathToFsPath('library/RecordingLibrary'))
    const setCustodyRoot = path.join(
      rootDir,
      'library',
      getCoreFsDirName('SetLibrary'),
      SET_CUSTODY_DIR_NAME
    )
    const normalizedStart = normalizePath(startDir)
    const normalizedRecycle = normalizePath(recycleRoot)
    const normalizedRecording = normalizePath(recordingRoot)
    const normalizedSetCustody = normalizePath(setCustodyRoot)
    if (
      normalizedStart &&
      normalizedRecycle &&
      (normalizedStart === normalizedRecycle ||
        normalizedStart.startsWith(normalizedRecycle + path.sep))
    ) {
      return recycleRoot
    }
    if (
      normalizedStart &&
      normalizedRecording &&
      (normalizedStart === normalizedRecording ||
        normalizedStart.startsWith(normalizedRecording + path.sep))
    ) {
      return recordingRoot
    }
    if (
      normalizedStart &&
      normalizedSetCustody &&
      (normalizedStart === normalizedSetCustody ||
        normalizedStart.startsWith(normalizedSetCustody + path.sep))
    ) {
      return setCustodyRoot
    }
  }
  return await findSongListRootByPath(startDir)
}

async function findMixtapeCacheRoot(startDir: string): Promise<string | null> {
  const songListRoot = await findSongListRoot(startDir)
  if (songListRoot) return songListRoot
  const libraryRoot = getLibraryRootAbs()
  if (libraryRoot && isUnderPath(libraryRoot, startDir)) {
    return libraryRoot
  }
  return null
}

function normalizeSongInfoForCache(info: ISongInfo): ISongInfo {
  const baseName = path.basename(info.filePath)
  const ext = path.extname(info.filePath)
  const normalizedExt = ext ? ext.slice(1).toUpperCase() : ''
  return {
    ...info,
    fileName: info.fileName && info.fileName.trim() !== '' ? info.fileName : baseName,
    fileFormat:
      info.fileFormat && info.fileFormat.trim() !== ''
        ? info.fileFormat
        : normalizedExt || info.fileFormat
  }
}

function buildNodePathMap(nodes: LibraryNodeRow[], root: LibraryNodeRow): Map<string, string> {
  const childrenMap = new Map<string, LibraryNodeRow[]>()
  for (const row of nodes) {
    if (!row.parentUuid) continue
    const list = childrenMap.get(row.parentUuid)
    if (list) {
      list.push(row)
    } else {
      childrenMap.set(row.parentUuid, [row])
    }
  }
  const pathByUuid = new Map<string, string>()
  pathByUuid.set(root.uuid, root.dirName)
  const queue: LibraryNodeRow[] = [root]
  for (let i = 0; i < queue.length; i += 1) {
    const parent = queue[i]
    const parentPath = pathByUuid.get(parent.uuid)
    if (!parentPath) continue
    const children = childrenMap.get(parent.uuid) || []
    for (const child of children) {
      const childPath = path.join(parentPath, child.dirName)
      if (!pathByUuid.has(child.uuid)) {
        pathByUuid.set(child.uuid, childPath)
        queue.push(child)
      }
    }
  }
  return pathByUuid
}

export async function updateSongCacheEntry(
  filePath: string,
  info: ISongInfo,
  oldFilePath?: string
) {
  try {
    const songListRoot = await findSongListRoot(path.dirname(filePath))
    if (!songListRoot) return
    const stat = await fs.stat(filePath)
    const normalizedInfo = normalizeSongInfoForCache(info)

    // Preserve existing bpm and key if not provided in new info
    // These are computed by audio analysis and should not be lost during metadata updates
    const lookupPath = oldFilePath || filePath
    const existingEntry = await LibraryCacheDb.loadSongCacheEntry(songListRoot, lookupPath)
    if (existingEntry?.info) {
      if (normalizedInfo.bpm === undefined && existingEntry.info.bpm !== undefined) {
        normalizedInfo.bpm = existingEntry.info.bpm
      }
      if (normalizedInfo.key === undefined && existingEntry.info.key !== undefined) {
        normalizedInfo.key = existingEntry.info.key
      }
    }

    await LibraryCacheDb.upsertSongCacheEntry(
      songListRoot,
      filePath,
      {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        info: normalizedInfo
      },
      oldFilePath
    )

    // Update waveform cache stat to match new file stat after metadata update
    // This prevents cache invalidation when FFmpeg rewrites the file
    await LibraryCacheDb.updateWaveformCacheStat(songListRoot, filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })
    await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(songListRoot, filePath)
    await LibraryCacheDb.updateUnifiedDisplayWaveformCacheStat(songListRoot, filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })
    await LibraryCacheDb.updateWaveformSurfaceCacheStat(songListRoot, filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })

    if (oldFilePath && oldFilePath !== filePath) {
      await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(songListRoot, oldFilePath)
      await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(songListRoot, filePath)
      await LibraryCacheDb.removeWaveformCacheEntry(songListRoot, oldFilePath)
      await LibraryCacheDb.removeWaveformCacheEntry(songListRoot, filePath)
      await LibraryCacheDb.moveUnifiedDisplayWaveformCacheEntry(
        songListRoot,
        oldFilePath,
        filePath,
        {
          size: stat.size,
          mtimeMs: stat.mtimeMs
        }
      )
      await LibraryCacheDb.moveWaveformSurfaceCacheEntry(songListRoot, oldFilePath, filePath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs
      })
    }
  } catch {}
}

export async function transferTrackCaches(params: {
  fromRoot: string | null
  toRoot: string | null
  fromPath: string
  toPath: string
  fromStat?: CacheFileStat | null
  toStat?: CacheFileStat | null
  mode?: TrackCacheTransferMode
}): Promise<void> {
  const { fromRoot, toRoot, fromPath, toPath } = params
  if (!fromPath || !toPath) return
  if (normalizePath(fromPath) === normalizePath(toPath)) return
  const removeSource = params.mode !== 'copy'

  if (removeSource) {
    const libraryRoot = getLibraryRootAbs()
    try {
      if (libraryRoot) {
        replaceMixtapeStemAssetFilePath({
          libraryRoot,
          oldFilePath: fromPath,
          newFilePath: toPath
        })
      }
    } catch {}
  }

  if (!fromRoot || !toRoot) return
  if (
    normalizePath(fromRoot) === normalizePath(toRoot) &&
    normalizePath(fromPath) === normalizePath(toPath)
  ) {
    return
  }

  let toStat: CacheFileStat | null = params.toStat || null
  if (!toStat) {
    try {
      const fsStat = await fs.stat(toPath)
      toStat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {
      return
    }
  }
  let fromStat: CacheFileStat | null = params.fromStat || null
  if (!fromStat && !removeSource) {
    try {
      const fsStat = await fs.stat(fromPath)
      fromStat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {}
  }
  if (!fromStat) {
    fromStat = toStat
  }
  if (!fromStat || !toStat) return

  try {
    const cacheEntry = await LibraryCacheDb.loadSongCacheEntry(fromRoot, fromPath)
    if (cacheEntry && toStat && isCacheStatMatch(cacheEntry, fromStat)) {
      const nextInfo = { ...cacheEntry.info, filePath: toPath }
      const updated = await LibraryCacheDb.upsertSongCacheEntry(toRoot, toPath, {
        size: toStat.size,
        mtimeMs: toStat.mtimeMs,
        info: nextInfo
      })
      if (updated && removeSource) {
        await LibraryCacheDb.removeSongCacheEntry(fromRoot, fromPath)
      }
    }
  } catch {}

  try {
    const unified = await LibraryCacheDb.loadUnifiedDisplayWaveformCacheData(
      fromRoot,
      fromPath,
      fromStat
    )
    if (unified) {
      const updated = await LibraryCacheDb.upsertUnifiedDisplayWaveformCacheEntry(
        toRoot,
        toPath,
        toStat,
        unified
      )
      if (updated) {
        if (removeSource) {
          await LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(fromRoot, fromPath)
          await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(fromRoot, fromPath)
        }
        await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(toRoot, toPath)
      }
    }
  } catch {}
  try {
    const listPreview = await LibraryCacheDb.loadWaveformListPreviewCacheData(
      fromRoot,
      fromPath,
      fromStat
    )
    const globalOverview = await LibraryCacheDb.loadWaveformGlobalOverviewCacheData(
      fromRoot,
      fromPath,
      fromStat
    )
    if (listPreview && globalOverview) {
      const updated = await LibraryCacheDb.upsertWaveformSurfaceCacheEntry(toRoot, toPath, toStat, {
        listPreview,
        globalOverview
      })
      if (updated && removeSource) {
        await LibraryCacheDb.removeWaveformSurfaceCacheEntry(fromRoot, fromPath)
      }
    }
  } catch {}
  if (removeSource) {
    await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(fromRoot, fromPath)
    await LibraryCacheDb.removeWaveformCacheEntry(fromRoot, fromPath)
  }
  await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(toRoot, toPath)
  await LibraryCacheDb.removeWaveformCacheEntry(toRoot, toPath)

  try {
    const cover = await LibraryCacheDb.loadCoverIndexEntry(fromRoot, fromPath)
    if (!cover) return
    const ext = cover.ext || '.jpg'
    const fromCoversDir = path.join(fromRoot, '.frkb_covers')
    const toCoversDir = path.join(toRoot, '.frkb_covers')
    const fromCoverPath = path.join(fromCoversDir, `${cover.hash}${ext}`)
    const toCoverPath = path.join(toCoversDir, `${cover.hash}${ext}`)
    if (normalizePath(fromCoverPath) !== normalizePath(toCoverPath)) {
      await fs.ensureDir(toCoversDir)
      await operateHiddenFile(toCoversDir, async () => {})
      try {
        if ((await fs.pathExists(fromCoverPath)) && !(await fs.pathExists(toCoverPath))) {
          await fs.copy(fromCoverPath, toCoverPath)
          await operateHiddenFile(toCoverPath, async () => {})
        }
      } catch {}
    }
    const saved = await LibraryCacheDb.upsertCoverIndexEntry(toRoot, toPath, cover.hash, ext)
    if (saved && removeSource) {
      const removed = await LibraryCacheDb.removeCoverIndexEntry(fromRoot, fromPath)
      if (removed) {
        const remaining = await LibraryCacheDb.countCoverIndexByHash(fromRoot, removed.hash)
        if (remaining === 0) {
          const staleCoverPath = path.join(fromCoversDir, `${removed.hash}${removed.ext || '.jpg'}`)
          try {
            if (await fs.pathExists(staleCoverPath)) {
              await fs.remove(staleCoverPath)
            }
          } catch {}
        }
      }
    }
  } catch {}
}

export async function purgeCoverCacheForTrack(filePath: string, oldFilePath?: string) {
  try {
    const songListRoot = await findSongListRoot(path.dirname(filePath))
    if (!songListRoot) return
    const coversDir = path.join(songListRoot, '.frkb_covers')
    const targets = [filePath]
    if (oldFilePath && oldFilePath !== filePath) targets.push(oldFilePath)
    for (const target of targets) {
      const removed = await LibraryCacheDb.removeCoverIndexEntry(songListRoot, target)
      if (removed === undefined) return
      if (!removed) continue
      const remaining = await LibraryCacheDb.countCoverIndexByHash(songListRoot, removed.hash)
      if (remaining === 0) {
        const coverPath = path.join(coversDir, `${removed.hash}${removed.ext || '.jpg'}`)
        try {
          if (await fs.pathExists(coverPath)) await fs.remove(coverPath)
        } catch {}
      }
    }
  } catch {}
}

export type TrackCoreAnalysisClearResult =
  | {
      status: 'cleared'
      filePath: string
      listRoot: string
    }
  | {
      status: 'skipped'
      filePath: string
      reason:
        | 'invalid-path'
        | 'unsupported-location'
        | 'missing-song-cache'
        | 'clear-failed'
        | 'nothing-to-clear'
    }

/**
 * 用户主动重新分析时，只清理勾选的核心项。
 * 封面、Stem、Mixtape 独立波形、Cue 和元数据必须保留。
 * 单独重算段落时，只有这首歌已经有可用网格才会清段落。
 */
export async function clearTrackCoreAnalysisForReanalysis(
  filePath: string,
  plan?: TrackReanalysisPlan
): Promise<TrackCoreAnalysisClearResult> {
  const normalizedFilePath = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalizedFilePath) {
    return { status: 'skipped', filePath: normalizedFilePath, reason: 'invalid-path' }
  }

  const listRoot = await findSongListRoot(path.dirname(normalizedFilePath))
  if (!listRoot) {
    return {
      status: 'skipped',
      filePath: normalizedFilePath,
      reason: 'unsupported-location'
    }
  }

  const existing = await LibraryCacheDb.loadSongCacheEntry(listRoot, normalizedFilePath)
  if (!existing) {
    return {
      status: 'skipped',
      filePath: normalizedFilePath,
      reason: 'missing-song-cache'
    }
  }

  const clearKey = plan ? plan.key === true : true
  const clearBeatGrid = plan ? plan.beatGrid === true : true
  const clearEnergy = plan ? plan.energy === true : true
  const clearWaveform = plan ? plan.waveform === true : true
  const requestStructure = plan ? plan.structure === true : true
  let cacheMatchesFile = false
  try {
    const stat = await fs.stat(normalizedFilePath)
    cacheMatchesFile = isCacheStatMatch(existing, { size: stat.size, mtimeMs: stat.mtimeMs })
  } catch {
    cacheMatchesFile = false
  }
  const hasExistingGrid =
    cacheMatchesFile && resolveCanonicalSongBeatGridV2(existing.info).kind === 'grid'
  const clearStructure = requestStructure && (clearBeatGrid || hasExistingGrid)
  const hasSongClear = clearKey || clearBeatGrid || clearEnergy || clearStructure
  if (!hasSongClear && !clearWaveform) {
    return {
      status: 'skipped',
      filePath: normalizedFilePath,
      reason: 'nothing-to-clear'
    }
  }

  await cancelKeyAnalysisForPaths(normalizedFilePath)

  if (hasSongClear) {
    const analysisFieldsCleared = await LibraryCacheDb.clearSongCacheAnalysisFields(
      listRoot,
      normalizedFilePath,
      {
        key: clearKey,
        beatGrid: clearBeatGrid,
        energy: clearEnergy,
        structure: clearStructure
      }
    )
    if (!analysisFieldsCleared) {
      return {
        status: 'skipped',
        filePath: normalizedFilePath,
        reason: 'clear-failed'
      }
    }
  }

  if (clearWaveform) {
    await Promise.all([
      LibraryCacheDb.removeWaveformCacheEntry(listRoot, normalizedFilePath),
      LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, normalizedFilePath),
      LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(listRoot, normalizedFilePath),
      LibraryCacheDb.removeWaveformSurfaceCacheEntry(listRoot, normalizedFilePath)
    ])
  }

  return { status: 'cleared', filePath: normalizedFilePath, listRoot }
}

/**
 * 文件永久删除/孤儿清理使用的破坏性清理，会移除封面和 Stem 等资产。
 * 用户主动重新分析必须调用 clearTrackCoreAnalysisForReanalysis，禁止复用本函数。
 */
export async function clearTrackCache(filePath: string) {
  try {
    const cacheRoot = await findMixtapeCacheRoot(path.dirname(filePath))
    if (cacheRoot) {
      // 只清除分析相关字段，保留 playlistTrackNumber、addedAtMs 等用户数据
      await LibraryCacheDb.clearSongCacheAnalysisFields(cacheRoot, filePath)
      await LibraryCacheDb.removeWaveformCacheEntry(cacheRoot, filePath)
      await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(cacheRoot, filePath)
      await LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(cacheRoot, filePath)
      await LibraryCacheDb.removeWaveformSurfaceCacheEntry(cacheRoot, filePath)
      await LibraryCacheDb.removeMixtapeWaveformCacheEntry(cacheRoot, filePath)
      await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(cacheRoot, filePath)
      await LibraryCacheDb.removeMixtapeStemWaveformCacheByFilePath(cacheRoot, filePath)
    }

    const libraryRoot = getLibraryRootAbs()
    if (libraryRoot && isUnderPath(libraryRoot, filePath)) {
      const removedAssets = removeMixtapeStemAssetsByFilePath({
        libraryRoot,
        filePath
      })
      if (removedAssets.length > 0) {
        await removeLibraryStemAssetFiles(
          removedAssets.flatMap((item) => [
            item.vocalPath,
            item.instPath,
            item.bassPath,
            item.drumsPath
          ])
        )
      }
    }

    await purgeCoverCacheForTrack(filePath)

    await cancelKeyAnalysisForPaths(filePath)
  } catch {}
}

export async function pruneOrphanedSongListCaches(dbRoot?: string): Promise<{
  songCacheRemoved: number
  coverIndexRemoved: number
  waveformCacheRemoved: number
  compactVisualWaveformCacheRemoved: number
  unifiedDisplayWaveformCacheRemoved: number
  waveformSurfaceCacheRemoved: number
  mixtapeWaveformCacheRemoved: number
  mixtapeRawWaveformCacheRemoved: number
  mixtapeStemWaveformCacheRemoved: number
}> {
  try {
    const rootDir = dbRoot || store.databaseDir
    if (!rootDir) {
      return {
        songCacheRemoved: 0,
        coverIndexRemoved: 0,
        waveformCacheRemoved: 0,
        compactVisualWaveformCacheRemoved: 0,
        unifiedDisplayWaveformCacheRemoved: 0,
        waveformSurfaceCacheRemoved: 0,
        mixtapeWaveformCacheRemoved: 0,
        mixtapeRawWaveformCacheRemoved: 0,
        mixtapeStemWaveformCacheRemoved: 0
      }
    }
    const pruneAllLibraryCaches = async () => {
      // 已确认库树为空时，所有现存歌单快照都无法证明仍对应当前树，必须一并清掉。
      LibraryCacheDb.prunePlaylistViewSnapshots(new Set())
      return await LibraryCacheDb.pruneCachesByRoots(new Set())
    }
    const nodes = loadLibraryNodes(rootDir) || []
    if (nodes.length === 0) {
      return await pruneAllLibraryCaches()
    }
    const root = nodes.find((row) => row.parentUuid === null && row.nodeType === 'root')
    if (!root) {
      return await pruneAllLibraryCaches()
    }
    const pathByUuid = buildNodePathMap(nodes, root)
    const keepRoots = new Set<string>()
    const keepUuids = new Set<string>()
    const currentListRootsByUuid = new Map<string, string>()
    for (const row of nodes) {
      if (row.uuid) keepUuids.add(String(row.uuid))
      if (row.nodeType !== 'songList') continue
      const rel = pathByUuid.get(row.uuid)
      if (!rel) continue
      const abs = path.join(rootDir, rel)
      keepRoots.add(abs)
      currentListRootsByUuid.set(String(row.uuid), abs)
    }
    keepRoots.add(path.join(rootDir, mapRendererPathToFsPath('library/RecycleBin')))
    keepRoots.add(path.join(rootDir, mapRendererPathToFsPath('library/RecordingLibrary')))
    // 歌单没了就把视图快照一起清掉，否则 UUID 万一被复用会读到上一张歌单的内容。
    // 这里保留所有节点类型的 uuid（不只 songList），避免误删别的节点将来用到的行。
    // 歌单还在但路径已经变了（磁盘改名、云同步搬家）时，list_root / items_json
    // 都是旧绝对路径，必须按当前树路径丢掉，不能只看 uuid 还在就留下。
    LibraryCacheDb.prunePlaylistViewSnapshots(keepUuids, currentListRootsByUuid)
    return await LibraryCacheDb.pruneCachesByRoots(keepRoots)
  } catch {
    return {
      songCacheRemoved: 0,
      coverIndexRemoved: 0,
      waveformCacheRemoved: 0,
      compactVisualWaveformCacheRemoved: 0,
      unifiedDisplayWaveformCacheRemoved: 0,
      waveformSurfaceCacheRemoved: 0,
      mixtapeWaveformCacheRemoved: 0,
      mixtapeRawWaveformCacheRemoved: 0,
      mixtapeStemWaveformCacheRemoved: 0
    }
  }
}

export { findSongListRoot, findMixtapeCacheRoot }
