import path = require('node:path')
import fs = require('fs-extra')
import * as LibraryCacheDb from '../libraryCacheDb'
import { log } from '../log'
import { replaceMixtapeStemAssetFilePath } from '../mixtapeStemDb'
import store from '../store'
import { operateHiddenFile } from './hiddenFileOperation'
import { isPackagedRcMainProcess } from './rcDiagnosticEnvironment'
import { createStageDiagnostics } from './stageDiagnostics'

export type CacheFileStat = {
  size: number
  mtimeMs: number
}

export type TrackCacheTransferMode = 'move' | 'copy'

export type TrackCacheTransferParams = {
  fromRoot: string | null
  toRoot: string | null
  fromPath: string
  toPath: string
  fromStat?: CacheFileStat | null
  toStat?: CacheFileStat | null
  mode?: TrackCacheTransferMode
}

export type TrackCacheTransferContext = {
  fromStat: CacheFileStat
  toStat: CacheFileStat
  waveformLoadStat: CacheFileStat
  removeSource: boolean
}

const normalizePath = (value: string): string => {
  if (!value) return ''
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const getLibraryRootAbs = (): string | null => {
  if (!store.databaseDir) return null
  return path.join(store.databaseDir, 'library')
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

export async function transferTrackCoreCache(
  params: TrackCacheTransferParams
): Promise<TrackCacheTransferContext | null> {
  const { fromRoot, toRoot, fromPath, toPath } = params
  if (!fromPath || !toPath) return null
  if (normalizePath(fromPath) === normalizePath(toPath)) return null
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

  if (!fromRoot || !toRoot) return null
  if (
    normalizePath(fromRoot) === normalizePath(toRoot) &&
    normalizePath(fromPath) === normalizePath(toPath)
  ) {
    return null
  }

  let toStat: CacheFileStat | null = params.toStat || null
  if (!toStat) {
    try {
      const fsStat = await fs.stat(toPath)
      toStat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {
      return null
    }
  }
  let fromStat: CacheFileStat | null = params.fromStat || null
  if (!fromStat && !removeSource) {
    try {
      const fsStat = await fs.stat(fromPath)
      fromStat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {}
  }
  if (!fromStat) fromStat = toStat

  const cacheEntry = await LibraryCacheDb.loadSongCacheEntry(fromRoot, fromPath).catch(() => null)
  const cacheSize = cacheEntry ? Number(cacheEntry.size) : NaN
  const cacheMtime = cacheEntry ? Number(cacheEntry.mtimeMs) : NaN
  const sizeMatches = !!cacheEntry && Number.isFinite(cacheSize) && cacheSize === toStat.size
  // A move preserves file identity, but Windows or antivirus software can change mtime.
  const reuseCache = removeSource
    ? sizeMatches
    : !!(cacheEntry && isCacheStatMatch(cacheEntry, fromStat))
  const waveformLoadStat =
    reuseCache && Number.isFinite(cacheMtime) ? { size: cacheSize, mtimeMs: cacheMtime } : fromStat

  try {
    if (cacheEntry && reuseCache) {
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
  } catch (error) {
    log.error('[cache] 移动曲目时分析结果迁移失败', { fromPath, toPath, error })
  }

  return { fromStat, toStat, waveformLoadStat, removeSource }
}

export async function transferTrackDerivedCaches(
  params: TrackCacheTransferParams,
  preparedContext?: TrackCacheTransferContext | null
): Promise<void> {
  const { fromRoot, toRoot, fromPath, toPath } = params
  if (!fromRoot || !toRoot || !fromPath || !toPath) return
  if (normalizePath(fromPath) === normalizePath(toPath)) return
  const context = preparedContext || (await transferTrackCoreCache(params))
  if (!context) return
  const { toStat, waveformLoadStat, removeSource } = context
  const diagnostics = createStageDiagnostics(
    'track-cache-transfer-perf',
    {
      fileName: path.basename(fromPath),
      mode: params.mode || 'move'
    },
    1000
  )

  try {
    const unified = await diagnostics.measure('read-display-waveform', () =>
      LibraryCacheDb.loadUnifiedDisplayWaveformCacheData(fromRoot, fromPath, waveformLoadStat)
    )
    if (unified) {
      const updated = await diagnostics.measure('write-display-waveform', () =>
        LibraryCacheDb.upsertUnifiedDisplayWaveformCacheEntry(toRoot, toPath, toStat, unified)
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
    const listPreview = await diagnostics.measure('read-list-waveform', () =>
      LibraryCacheDb.loadWaveformListPreviewCacheData(fromRoot, fromPath, waveformLoadStat)
    )
    const globalOverview = await diagnostics.measure('read-overview-waveform', () =>
      LibraryCacheDb.loadWaveformGlobalOverviewCacheData(fromRoot, fromPath, waveformLoadStat)
    )
    if (listPreview && globalOverview) {
      const updated = await diagnostics.measure('write-waveform-surfaces', () =>
        LibraryCacheDb.upsertWaveformSurfaceCacheEntry(toRoot, toPath, toStat, {
          listPreview,
          globalOverview
        })
      )
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
            if (await fs.pathExists(staleCoverPath)) await fs.remove(staleCoverPath)
          } catch {}
        }
      }
    }
  } catch {}
}

export async function transferTrackCaches(params: TrackCacheTransferParams): Promise<void> {
  const startedAt = performance.now()
  let coreMs = 0
  let derivedMs = 0
  let outcome: 'completed' | 'skipped' | 'threw' = 'threw'
  try {
    const coreStartedAt = performance.now()
    let context: TrackCacheTransferContext | null = null
    try {
      context = await transferTrackCoreCache(params)
    } finally {
      coreMs = performance.now() - coreStartedAt
    }
    if (!context) {
      outcome = 'skipped'
      return
    }
    const derivedStartedAt = performance.now()
    try {
      await transferTrackDerivedCaches(params, context)
    } finally {
      derivedMs = performance.now() - derivedStartedAt
    }
    outcome = 'completed'
  } finally {
    const elapsedMs = performance.now() - startedAt
    // RC 阈值诊断：确认迁移卡在哪一阶段且不再出现慢记录后删除。
    if (elapsedMs >= 2000 && isPackagedRcMainProcess()) {
      log.warn('[track-cache-transfer] slow transfer', {
        fileName: path.basename(params.fromPath),
        fromRoot: params.fromRoot,
        toRoot: params.toRoot,
        mode: params.mode || 'move',
        outcome,
        elapsedMs: Math.round(elapsedMs),
        coreMs: Math.round(coreMs),
        derivedMs: Math.round(derivedMs)
      })
    }
  }
}
