import fs from 'node:fs/promises'
import path from 'node:path'
import type { ISongInfo } from '../../types/globals'
import type { SongBeatGridMapV2 } from '../../shared/songBeatGridMapV2'
import * as LibraryCacheDb from '../libraryCacheDb'
import { stripBeatThisDebugInfo } from '../libraryCacheDb/pathResolvers'
import { findSongListRoot } from './cacheMaintenance'
import { applyLiteDefaults, buildLiteSongInfo } from './songInfoLite'
import { normalizeBeatGridAlgorithmVersion } from './beatGridAlgorithmVersion'
import {
  normalizeSongBeatGridMapV2,
  projectSongBeatGridMapV2ToFixedGrid
} from '../../shared/songBeatGridMapV2'
import { shouldAcceptSharedSongGridCache } from './sharedSongGridCachePolicy'

type SharedGridInfo = Pick<
  ISongInfo,
  'beatGridMap' | 'beatGridAlgorithmVersion' | 'timeBasisOffsetMs' | 'externalBeatGridPreference'
>

export type SharedSongGridDefinition = {
  filePath: string
  bpm?: number
  firstBeatMs?: number
  downbeatBeatOffset?: number
  timeBasisOffsetMs?: number
  beatGridSource?: 'manual' | 'analysis' | 'rekordbox' | 'serato' | 'traktor'
  beatGridMap?: SongBeatGridMapV2 | null
  beatGridAlgorithmVersion?: number
  externalBeatGridPreference?: 'frkb-manual'
}

type SharedSongGridCandidate = {
  filePath?: unknown
  beatGridMap?: unknown
  beatGridSource?: unknown
}

export const isCompleteSharedSongGridDefinition = (
  value: SharedSongGridDefinition | null | undefined
): value is SharedSongGridDefinition =>
  !!value && normalizeSongBeatGridMapV2(value.beatGridMap, { allowSingleClip: true }) !== null

export const shouldKeepManualSharedSongGridDefinition = (
  current: SharedSongGridCandidate | null | undefined,
  next: SharedSongGridCandidate | null | undefined
) => {
  if (!current || !next) return false
  const currentBeatGridMapV2 = normalizeSongBeatGridMapV2(current.beatGridMap, {
    allowSingleClip: true
  })
  const nextBeatGridMapV2 = normalizeSongBeatGridMapV2(next.beatGridMap, {
    allowSingleClip: true
  })
  return currentBeatGridMapV2?.source === 'manual' && nextBeatGridMapV2?.source === 'analysis'
}

const extractSharedGridFromInfo = (
  filePath: string,
  info: SharedGridInfo | null | undefined
): SharedSongGridDefinition | null => {
  if (!info) return null
  const beatGridMapV2 = normalizeSongBeatGridMapV2(info.beatGridMap, { allowSingleClip: true })
  const beatGridMapV2Projection = projectSongBeatGridMapV2ToFixedGrid(beatGridMapV2)
  const beatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(info.beatGridAlgorithmVersion)
  const timeBasisOffsetMs = Number(info.timeBasisOffsetMs)
  if (!beatGridMapV2 || !beatGridMapV2Projection) return null
  return {
    filePath,
    bpm: beatGridMapV2Projection.bpm,
    firstBeatMs: beatGridMapV2Projection.firstBeatMs,
    downbeatBeatOffset: beatGridMapV2Projection.downbeatBeatOffset,
    timeBasisOffsetMs:
      Number.isFinite(timeBasisOffsetMs) && timeBasisOffsetMs >= 0
        ? Number(timeBasisOffsetMs.toFixed(3))
        : undefined,
    beatGridSource: beatGridMapV2.source,
    beatGridMap: beatGridMapV2,
    beatGridAlgorithmVersion,
    externalBeatGridPreference: info.externalBeatGridPreference
  }
}

export async function loadSharedSongGridDefinition(
  filePath: string
): Promise<SharedSongGridDefinition | null> {
  const normalizedPath = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalizedPath) return null

  let resolved: SharedSongGridDefinition | null = null
  const songListRoot = await findSongListRoot(path.dirname(normalizedPath))
  if (songListRoot) {
    const entry = await LibraryCacheDb.loadSongCacheEntry(songListRoot, normalizedPath)
    resolved = extractSharedGridFromInfo(normalizedPath, entry?.info || null)
  } else {
    let stat: { size: number; mtimeMs: number } | null = null
    try {
      const fsStat = await fs.stat(normalizedPath)
      stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {}
    const entry = await LibraryCacheDb.loadExternalAnalysisCacheEntryByFilePath(
      normalizedPath,
      stat
    )
    resolved = extractSharedGridFromInfo(normalizedPath, entry?.info || null)
  }

  if (!isCompleteSharedSongGridDefinition(resolved) || !shouldAcceptSharedSongGridCache(resolved)) {
    return null
  }
  return resolved
}

export async function loadSharedSongGridDefinitions(filePaths: string[]) {
  const resultMap = new Map<string, SharedSongGridDefinition>()
  const uniquePaths = Array.from(
    new Set(
      (Array.isArray(filePaths) ? filePaths : [])
        .filter((filePath) => typeof filePath === 'string')
        .map((filePath) => filePath.trim())
        .filter(Boolean)
    )
  )
  if (uniquePaths.length === 0) return resultMap

  const results = await Promise.all(
    uniquePaths.map(
      async (filePath) => [filePath, await loadSharedSongGridDefinition(filePath)] as const
    )
  )
  for (const [filePath, value] of results) {
    if (!isCompleteSharedSongGridDefinition(value)) continue
    resultMap.set(filePath, value)
  }
  return resultMap
}

export async function persistSharedSongGridDefinition(
  input: SharedSongGridDefinition,
  options: { shouldPersist?: () => boolean } = {}
): Promise<SharedSongGridDefinition | null> {
  const shouldPersist = () => options.shouldPersist?.() !== false
  const normalizedPath = typeof input?.filePath === 'string' ? input.filePath.trim() : ''
  if (!normalizedPath || !shouldPersist()) return null

  const hasBeatGridMapInput = Object.prototype.hasOwnProperty.call(input, 'beatGridMap')
  const beatGridMapV2 = normalizeSongBeatGridMapV2(input?.beatGridMap, {
    allowSingleClip: true
  })
  const shouldClearBeatGridMap = hasBeatGridMapInput && input.beatGridMap === null
  if (!beatGridMapV2 && !shouldClearBeatGridMap) return null
  const beatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(
    input?.beatGridAlgorithmVersion
  )
  const timeBasisOffsetMs = Number(input?.timeBasisOffsetMs)
  const normalizedTimeBasisOffsetMs =
    Number.isFinite(timeBasisOffsetMs) && timeBasisOffsetMs >= 0
      ? Number(timeBasisOffsetMs.toFixed(3))
      : undefined

  const buildPersistResult = (info: SharedGridInfo): SharedSongGridDefinition | null => {
    const extracted = extractSharedGridFromInfo(normalizedPath, info)
    if (extracted) return extracted
    return shouldClearBeatGridMap ? { filePath: normalizedPath, beatGridMap: null } : null
  }

  const songListRoot = await findSongListRoot(path.dirname(normalizedPath))
  if (!shouldPersist()) return null
  if (!songListRoot) {
    const externalContext = LibraryCacheDb.resolveExternalAnalysisContext(normalizedPath)
    if (!externalContext) {
      const projection = projectSongBeatGridMapV2ToFixedGrid(beatGridMapV2)
      return {
        filePath: normalizedPath,
        bpm: projection?.bpm,
        firstBeatMs: projection?.firstBeatMs,
        downbeatBeatOffset: projection?.downbeatBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
        beatGridSource: beatGridMapV2?.source,
        beatGridMap: beatGridMapV2 ?? null,
        beatGridAlgorithmVersion
      }
    }
    let stat: { size: number; mtimeMs: number } | null = null
    try {
      const fsStat = await fs.stat(normalizedPath)
      stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {
      return loadSharedSongGridDefinition(normalizedPath)
    }
    const existingEntry = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, stat)
    if (!shouldPersist()) return null
    const nextInfo = existingEntry?.info
      ? { ...existingEntry.info }
      : buildLiteSongInfo(normalizedPath)
    const normalizedInfo = applyLiteDefaults(nextInfo, normalizedPath)
    if (beatGridMapV2) {
      delete normalizedInfo.bpm
      delete normalizedInfo.firstBeatMs
      delete (normalizedInfo as unknown as Record<string, unknown>).barBeatOffset
      delete normalizedInfo.beatGridSource
      delete normalizedInfo.beatGridStatus
      normalizedInfo.beatGridMap = beatGridMapV2
    } else if (shouldClearBeatGridMap) {
      delete normalizedInfo.bpm
      delete normalizedInfo.firstBeatMs
      delete (normalizedInfo as unknown as Record<string, unknown>).barBeatOffset
      delete normalizedInfo.beatGridSource
      delete normalizedInfo.beatGridStatus
      delete normalizedInfo.beatGridMap
    }
    if (normalizedTimeBasisOffsetMs !== undefined) {
      normalizedInfo.timeBasisOffsetMs = normalizedTimeBasisOffsetMs
    }
    if (beatGridAlgorithmVersion !== undefined) {
      normalizedInfo.beatGridAlgorithmVersion = beatGridAlgorithmVersion
    }
    stripBeatThisDebugInfo(normalizedInfo)
    normalizedInfo.analysisOnly = true
    if (!shouldPersist()) return null
    await LibraryCacheDb.upsertExternalAnalysisCacheEntry(externalContext, stat, normalizedInfo)
    return buildPersistResult(normalizedInfo)
  }

  let stat: { size: number; mtimeMs: number } | null = null
  try {
    const fsStat = await fs.stat(normalizedPath)
    stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
  } catch {
    return loadSharedSongGridDefinition(normalizedPath)
  }

  const existingEntry = await LibraryCacheDb.loadSongCacheEntry(songListRoot, normalizedPath)
  if (!shouldPersist()) return null
  const nextInfo = existingEntry?.info
    ? { ...existingEntry.info }
    : buildLiteSongInfo(normalizedPath)
  const normalizedInfo = applyLiteDefaults(nextInfo, normalizedPath)

  if (beatGridMapV2) {
    delete normalizedInfo.bpm
    delete normalizedInfo.firstBeatMs
    delete (normalizedInfo as unknown as Record<string, unknown>).barBeatOffset
    delete normalizedInfo.beatGridSource
    delete normalizedInfo.beatGridStatus
    normalizedInfo.beatGridMap = beatGridMapV2
  } else if (shouldClearBeatGridMap) {
    delete normalizedInfo.bpm
    delete normalizedInfo.firstBeatMs
    delete (normalizedInfo as unknown as Record<string, unknown>).barBeatOffset
    delete normalizedInfo.beatGridSource
    delete normalizedInfo.beatGridStatus
    delete normalizedInfo.beatGridMap
  }
  if (normalizedTimeBasisOffsetMs !== undefined) {
    normalizedInfo.timeBasisOffsetMs = normalizedTimeBasisOffsetMs
  }
  if (beatGridAlgorithmVersion !== undefined) {
    normalizedInfo.beatGridAlgorithmVersion = beatGridAlgorithmVersion
  }
  stripBeatThisDebugInfo(normalizedInfo)

  if (!shouldPersist()) return null
  await LibraryCacheDb.upsertSongCacheEntry(songListRoot, normalizedPath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    info: normalizedInfo
  })

  return buildPersistResult(normalizedInfo)
}
