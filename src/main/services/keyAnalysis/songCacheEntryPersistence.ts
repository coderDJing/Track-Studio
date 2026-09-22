import fs from 'node:fs/promises'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { stripBeatThisDebugInfo } from '../../libraryCacheDb/pathResolvers'
import { applyLiteDefaults, buildLiteSongInfo } from '../songInfoLite'
import type { ISongInfo } from '../../../types/globals'
import type { SongBeatGridMapV2 } from '../../../shared/songBeatGridMapV2'
import {
  CURRENT_SONG_ENERGY_ALGORITHM_VERSION,
  type SongEnergyAnalysisV5
} from '../../../shared/songEnergy'
import {
  normalizeSongStructureAnalysis,
  type SongStructureAnalysis
} from '../../../shared/songStructure'

export type EnsureSongCacheEntryPayload = {
  keyText?: string
  keyAnalysisAlgorithmVersion?: number
  beatGridAlgorithmVersion?: number | null
  beatGridStatus?: ISongInfo['beatGridStatus']
  beatGridMap?: SongBeatGridMapV2 | null
  energyScore?: number
  energyAlgorithmVersion?: number
  energyAnalysis?: SongEnergyAnalysisV5
  songStructure?: SongStructureAnalysis | null
}

export const ensureSongCacheEntry = async (
  listRoot: string,
  filePath: string,
  payload: EnsureSongCacheEntryPayload,
  stat?: { size: number; mtimeMs: number },
  options: {
    shouldPersist?: () => boolean
    validateBeforeWrite?: () => boolean | Promise<boolean>
  } = {}
) => {
  const shouldPersist = () => options.shouldPersist?.() !== false
  if (!listRoot || !filePath || !shouldPersist()) return
  let fileStat = stat
  if (!fileStat) {
    try {
      const fsStat = await fs.stat(filePath)
      fileStat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {
      return
    }
  }
  let entry = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
  if (!shouldPersist()) return
  let info: ISongInfo
  if (entry && entry.info) {
    info = { ...entry.info }
  } else {
    info = buildLiteSongInfo(filePath)
  }
  info = applyLiteDefaults(info, filePath)
  stripBeatThisDebugInfo(info)
  const markAnalysisOnly = !entry || Boolean(entry.info?.analysisOnly)
  if (markAnalysisOnly) {
    info.analysisOnly = true
  }
  if (payload.keyText) {
    info.key = payload.keyText
  }
  if (payload.keyAnalysisAlgorithmVersion !== undefined) {
    info.keyAnalysisAlgorithmVersion = payload.keyAnalysisAlgorithmVersion
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'beatGridAlgorithmVersion')) {
    if (payload.beatGridAlgorithmVersion === null) {
      delete info.beatGridAlgorithmVersion
    } else {
      info.beatGridAlgorithmVersion = payload.beatGridAlgorithmVersion
    }
  }
  if (payload.beatGridStatus !== undefined) {
    info.beatGridStatus = payload.beatGridStatus
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'beatGridMap')) {
    if (payload.beatGridMap) {
      delete info.bpm
      delete info.firstBeatMs
      delete (info as unknown as Record<string, unknown>).barBeatOffset
      delete info.beatGridSource
      delete info.beatGridStatus
      info.beatGridMap = payload.beatGridMap
    } else {
      delete info.beatGridMap
    }
  }
  if (payload.energyScore !== undefined) {
    info.energyScore = payload.energyScore
    info.energyAlgorithmVersion =
      payload.energyAlgorithmVersion ?? CURRENT_SONG_ENERGY_ALGORITHM_VERSION
    info.energyAnalysis = payload.energyAnalysis
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'songStructure')) {
    const songStructure = normalizeSongStructureAnalysis(payload.songStructure)
    if (songStructure) {
      info.songStructure = songStructure
    } else {
      delete info.songStructure
    }
  }
  const validation = options.validateBeforeWrite?.()
  if (validation instanceof Promise ? !(await validation) : validation === false) return
  if (!shouldPersist()) return
  await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    info
  })
}
