import fs from 'node:fs/promises'
import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { findSongListRoot } from '../cacheMaintenance'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { stripBeatThisDebugInfo } from '../../libraryCacheDb/pathResolvers'
import { buildLiteSongInfo } from '../songInfoLite'
import { log } from '../../log'
import {
  hasCurrentSongStructureAnalysis,
  normalizeSongStructureAnalysis,
  type SongStructureAnalysis
} from '../../../shared/songStructure'
import { loadSharedSongGridDefinition } from '../sharedSongGrid'
import { normalizePath, type DoneEntry } from './types'
import {
  normalizeSongBeatGridMapV2,
  type SongBeatGridMapV2
} from '../../../shared/songBeatGridMapV2'
import { CURRENT_BEAT_GRID_ALGORITHM_VERSION } from '../beatGridAlgorithmVersion'

type EnsureStructureSongCacheEntry = (
  listRoot: string,
  filePath: string,
  payload: {
    songStructure?: SongStructureAnalysis | null
  },
  stat?: { size: number; mtimeMs: number },
  options?: {
    shouldPersist?: () => boolean
    validateBeforeWrite?: () => boolean | Promise<boolean>
  }
) => Promise<void>

type CreateStructurePersistenceParams = {
  doneByPath: Map<string, DoneEntry>
  events: EventEmitter
  ensureSongCacheEntry: EnsureStructureSongCacheEntry
  cleanupMissingPersistTarget: (normalizedPath: string, filePath: string) => Promise<void>
  isMissingFileError: (error: unknown) => boolean
}

export const createPersistSongStructure = (params: CreateStructurePersistenceParams) => {
  return async (
    filePath: string,
    songStructure: SongStructureAnalysis | null | undefined,
    options: { shouldPersist?: () => boolean; beatGridMap?: SongBeatGridMapV2 } = {}
  ) => {
    const shouldPersist = () => options.shouldPersist?.() !== false
    const normalizedPath = normalizePath(filePath)
    const normalizedSongStructure = normalizeSongStructureAnalysis(songStructure)
    if (!normalizedSongStructure || !shouldPersist()) return
    const structureSignature = JSON.stringify(normalizedSongStructure)
    const matchesPersistedStructure = (value: unknown) =>
      JSON.stringify(normalizeSongStructureAnalysis(value)) === structureSignature
    const resultBeatGridMap = normalizeSongBeatGridMapV2(options.beatGridMap, {
      allowSingleClip: true
    })
    const loadCurrentGridValidation = async () => {
      if (!shouldPersist()) return { currentGrid: null, valid: false }
      const currentGrid = await loadSharedSongGridDefinition(filePath)
      if (!shouldPersist()) return { currentGrid, valid: false }
      const validationGrid =
        currentGrid ?? (resultBeatGridMap ? { filePath, beatGridMap: resultBeatGridMap } : null)
      if (!validationGrid) return { currentGrid, valid: false }
      return {
        currentGrid: validationGrid,
        valid: hasCurrentSongStructureAnalysis({
          ...validationGrid,
          songStructure: normalizedSongStructure
        })
      }
    }
    const isCurrentGridCandidate = async () => (await loadCurrentGridValidation()).valid
    try {
      const initialGridValidation = await loadCurrentGridValidation()
      if (!initialGridValidation.valid) {
        if (shouldPersist()) {
          log.error('[闲时分析] 段落结果网格校验失败，已拒绝写入', {
            filePath,
            structureGrid: {
              formatVersion: normalizedSongStructure.formatVersion,
              algorithmVersion: normalizedSongStructure.algorithmVersion,
              beatGridSignature: normalizedSongStructure.beatGridSignature
            },
            currentGrid: initialGridValidation.currentGrid
          })
        }
        return
      }
      const stat = await fs.stat(filePath)
      if (!shouldPersist()) return
      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (!shouldPersist()) return
      let persistedStructureConfirmed = false
      if (listRoot) {
        await params.ensureSongCacheEntry(
          listRoot,
          filePath,
          {
            songStructure: normalizedSongStructure,
            ...(resultBeatGridMap
              ? {
                  beatGridMap: resultBeatGridMap,
                  beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION
                }
              : {})
          },
          { size: stat.size, mtimeMs: stat.mtimeMs },
          { shouldPersist, validateBeforeWrite: isCurrentGridCandidate }
        )
        const persistedEntry = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
        persistedStructureConfirmed = matchesPersistedStructure(persistedEntry?.info?.songStructure)
      } else {
        const externalContext = LibraryCacheDb.resolveExternalAnalysisContext(filePath)
        if (externalContext) {
          const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
            size: stat.size,
            mtimeMs: stat.mtimeMs
          })
          if (!(await isCurrentGridCandidate())) return
          await LibraryCacheDb.upsertExternalAnalysisCacheEntry(
            externalContext,
            stat,
            stripBeatThisDebugInfo({
              ...(cached?.info || buildLiteSongInfo(filePath)),
              filePath,
              ...(resultBeatGridMap
                ? {
                    beatGridMap: resultBeatGridMap,
                    beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION
                  }
                : {}),
              songStructure: normalizedSongStructure,
              analysisOnly: true
            })
          )
          const persistedEntry = await LibraryCacheDb.loadExternalAnalysisCacheEntry(
            externalContext,
            { size: stat.size, mtimeMs: stat.mtimeMs }
          )
          persistedStructureConfirmed = matchesPersistedStructure(
            persistedEntry?.info?.songStructure
          )
        }
      }

      if (!persistedStructureConfirmed) return
      const currentGrid = await loadSharedSongGridDefinition(filePath)
      if (
        !currentGrid ||
        !hasCurrentSongStructureAnalysis({
          ...currentGrid,
          songStructure: normalizedSongStructure
        })
      ) {
        return
      }
      const existing = params.doneByPath.get(normalizedPath)
      params.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText: existing?.keyText,
        keyAnalysisAlgorithmVersion: existing?.keyAnalysisAlgorithmVersion,
        beatGridAlgorithmVersion: existing?.beatGridAlgorithmVersion,
        beatGridStatus: existing?.beatGridStatus,
        beatGridMap: existing?.beatGridMap,
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
        songStructure: normalizedSongStructure,
        hasWaveform: existing?.hasWaveform
      })
      params.events.emit('structure-updated', {
        filePath,
        songStructure: normalizedSongStructure
      })
    } catch (error) {
      if (params.isMissingFileError(error)) {
        await params.cleanupMissingPersistTarget(normalizedPath, filePath)
        return
      }
      if (!shouldPersist()) return
      log.error('[闲时分析] persistSongStructure 失败，已拒绝未确认结果', {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
