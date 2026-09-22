import fs from 'node:fs/promises'
import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { findSongListRoot } from '../cacheMaintenance'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { stripBeatThisDebugInfo } from '../../libraryCacheDb/pathResolvers'
import { buildLiteSongInfo } from '../songInfoLite'
import { log } from '../../log'
import {
  CURRENT_SONG_ENERGY_ALGORITHM_VERSION,
  normalizeSongEnergyScore,
  type SongEnergyAnalysisV5
} from '../../../shared/songEnergy'
import { normalizePath, type DoneEntry } from './types'

type EnsureEnergySongCacheEntry = (
  listRoot: string,
  filePath: string,
  payload: {
    energyScore?: number
    energyAlgorithmVersion?: number
    energyAnalysis?: SongEnergyAnalysisV5
  },
  stat?: { size: number; mtimeMs: number }
) => Promise<void>

type CreateEnergyPersistenceParams = {
  doneByPath: Map<string, DoneEntry>
  events: EventEmitter
  ensureSongCacheEntry: EnsureEnergySongCacheEntry
  cleanupMissingPersistTarget: (normalizedPath: string, filePath: string) => Promise<void>
  isMissingFileError: (error: unknown) => boolean
}

const normalizeEnergyAlgorithmVersion = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.floor(numeric)
}

export const createPersistEnergy = (params: CreateEnergyPersistenceParams) => {
  return async (
    filePath: string,
    energyScore: number,
    energyAlgorithmVersion = CURRENT_SONG_ENERGY_ALGORITHM_VERSION,
    energyAnalysis?: SongEnergyAnalysisV5
  ) => {
    const normalizedPath = normalizePath(filePath)
    const normalizedEnergyScore = normalizeSongEnergyScore(energyScore)
    const normalizedEnergyAlgorithmVersion =
      normalizeEnergyAlgorithmVersion(energyAlgorithmVersion) ??
      CURRENT_SONG_ENERGY_ALGORITHM_VERSION
    if (normalizedEnergyScore === undefined) {
      return
    }
    try {
      const stat = await fs.stat(filePath)
      const existing = params.doneByPath.get(normalizedPath)
      params.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText: existing?.keyText,
        keyAnalysisAlgorithmVersion: existing?.keyAnalysisAlgorithmVersion,
        beatGridAlgorithmVersion: existing?.beatGridAlgorithmVersion,
        beatGridStatus: existing?.beatGridStatus,
        beatGridMap: existing?.beatGridMap,
        energyScore: normalizedEnergyScore,
        energyAlgorithmVersion: normalizedEnergyAlgorithmVersion,
        energyAnalysis,
        songStructure: existing?.songStructure,
        hasWaveform: existing?.hasWaveform
      })

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        await params.ensureSongCacheEntry(
          listRoot,
          filePath,
          {
            energyScore: normalizedEnergyScore,
            energyAlgorithmVersion: normalizedEnergyAlgorithmVersion,
            energyAnalysis
          },
          { size: stat.size, mtimeMs: stat.mtimeMs }
        )
      } else {
        const externalContext = LibraryCacheDb.resolveExternalAnalysisContext(filePath)
        if (externalContext) {
          const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
            size: stat.size,
            mtimeMs: stat.mtimeMs
          })
          await LibraryCacheDb.upsertExternalAnalysisCacheEntry(
            externalContext,
            stat,
            stripBeatThisDebugInfo({
              ...(cached?.info || buildLiteSongInfo(filePath)),
              filePath,
              energyScore: normalizedEnergyScore,
              energyAlgorithmVersion: normalizedEnergyAlgorithmVersion,
              energyAnalysis,
              analysisOnly: true
            })
          )
        }
      }

      params.events.emit('energy-updated', {
        filePath,
        energyScore: normalizedEnergyScore,
        energyAlgorithmVersion: normalizedEnergyAlgorithmVersion,
        energyAnalysis
      })
    } catch (error) {
      if (params.isMissingFileError(error)) {
        await params.cleanupMissingPersistTarget(normalizedPath, filePath)
        return
      }
      const existing = params.doneByPath.get(normalizedPath)
      params.doneByPath.set(normalizedPath, {
        size: 0,
        mtimeMs: 0,
        keyText: existing?.keyText,
        keyAnalysisAlgorithmVersion: existing?.keyAnalysisAlgorithmVersion,
        beatGridAlgorithmVersion: existing?.beatGridAlgorithmVersion,
        beatGridStatus: existing?.beatGridStatus,
        beatGridMap: existing?.beatGridMap,
        energyScore: normalizedEnergyScore,
        energyAlgorithmVersion: normalizedEnergyAlgorithmVersion,
        energyAnalysis,
        songStructure: existing?.songStructure,
        hasWaveform: existing?.hasWaveform
      })
      params.events.emit('energy-updated', {
        filePath,
        energyScore: normalizedEnergyScore,
        energyAlgorithmVersion: normalizedEnergyAlgorithmVersion,
        energyAnalysis
      })
      log.error('[闲时分析] persistEnergy 失败，已写入内存兜底', {
        filePath,
        energyScore: normalizedEnergyScore,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
