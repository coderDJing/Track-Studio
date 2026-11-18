import fs from 'node:fs/promises'
import type { ISongInfo } from '../../types/globals'
import * as LibraryCacheDb from '../libraryCacheDb'
import { discardStaleAnalysisFields } from '../services/scanSongs'
import { getLocalFilePath } from './library'
import { getNeteaseRootDir } from './paths'
import { parseNeteaseSongIdFromStorePath } from '../../shared/netease'

export const NETEASE_ANALYSIS_INFO_KEYS = [
  'key',
  'keyAnalysisAlgorithmVersion',
  'bpm',
  'firstBeatMs',
  'downbeatBeatOffset',
  'timeBasisOffsetMs',
  'timeBasisOffsetAlgorithmVersion',
  'beatGridSource',
  'beatGridStatus',
  'beatGridMap',
  'beatGridAlgorithmVersion',
  'beatGridAnalysisMode',
  'beatGridResultShape',
  'beatGridPolicyVersion',
  'energyScore',
  'energyAlgorithmVersion',
  'energyAnalysis',
  'energySourceGridSignature',
  'songStructure'
] as const

export type NeteaseAnalysisInfoKey = (typeof NETEASE_ANALYSIS_INFO_KEYS)[number]

export type NeteaseAnalysisHydrationRequest = {
  songId?: string
  filePath?: string
}

export type NeteaseAnalysisHydrationItem = {
  songId: string
  localPath: string
  listRoot: string
  analysis: Partial<Pick<ISongInfo, NeteaseAnalysisInfoKey>> | null
}

type CacheStat = { size: number; mtimeMs: number }

const isCacheStatMatch = (
  entry: { size?: unknown; mtimeMs?: unknown } | null | undefined,
  stat: CacheStat
) =>
  Boolean(
    entry &&
    Number(entry.size) === stat.size &&
    Number.isFinite(Number(entry.mtimeMs)) &&
    Math.abs(Number(entry.mtimeMs) - stat.mtimeMs) <= 1
  )

const resolveRequestSongId = (item: NeteaseAnalysisHydrationRequest, localPath: string) =>
  String(item.songId || '').trim() || parseNeteaseSongIdFromStorePath(localPath) || ''

const resolveRequestLocalPath = (item: NeteaseAnalysisHydrationRequest) => {
  const direct = String(item.filePath || '').trim()
  if (direct) return direct
  const songId = String(item.songId || '').trim()
  return songId ? getLocalFilePath(songId) || '' : ''
}

export const pickNeteaseAnalysisFields = (
  info: ISongInfo | null | undefined
): NeteaseAnalysisHydrationItem['analysis'] => {
  if (!info) return null
  const analysis: Partial<Pick<ISongInfo, NeteaseAnalysisInfoKey>> = {}
  let hasField = false
  for (const key of NETEASE_ANALYSIS_INFO_KEYS) {
    const value = info[key]
    if (value === undefined) continue
    ;(analysis as Record<string, unknown>)[key] = value
    hasField = true
  }
  return hasField ? analysis : null
}

const readLocalStat = async (filePath: string): Promise<CacheStat | null> => {
  try {
    const stat = await fs.stat(filePath)
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

/**
 * 按 `.store` 真实路径从 NeteaseLibrary 的 song_cache 取出分析字段。
 *
 * 只返回 key / BPM / 网格 / 能量 / 结构这些列展示需要的字段，不带 title、filePath。
 * 文件不存在或体积/mtime 对不上时仍返回 localPath 与 listRoot，方便列表行绑定波形根目录，
 * 但不回填分析结果。
 */
export const loadNeteaseAnalysisHydration = async (
  items: NeteaseAnalysisHydrationRequest[]
): Promise<NeteaseAnalysisHydrationItem[]> => {
  const listRoot = getNeteaseRootDir()
  const results: NeteaseAnalysisHydrationItem[] = []
  const seen = new Set<string>()

  for (const item of Array.isArray(items) ? items : []) {
    const localPath = resolveRequestLocalPath(item)
    const songId = resolveRequestSongId(item, localPath)
    if (!localPath || !songId) continue
    const dedupeKey = `${songId}\0${localPath}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    let analysis: NeteaseAnalysisHydrationItem['analysis'] = null
    const stat = await readLocalStat(localPath)
    if (stat && listRoot) {
      try {
        const entry = await LibraryCacheDb.loadSongCacheEntry(listRoot, localPath)
        if (entry && isCacheStatMatch(entry, stat) && entry.info) {
          analysis = pickNeteaseAnalysisFields(
            discardStaleAnalysisFields({ ...entry.info, filePath: localPath })
          )
        }
      } catch {
        analysis = null
      }
    }

    results.push({ songId, localPath, listRoot, analysis })
  }

  return results
}
