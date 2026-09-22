import fs from 'node:fs/promises'
import path from 'node:path'
import { findSongListRoot } from '../cacheMaintenance'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { buildLiteSongInfo } from '../songInfoLite'
import { log } from '../../log'
import type { MixxxWaveformData } from '../../waveformCodec'
import type { UnifiedDisplayWaveformDetailData } from '../../../shared/unifiedDisplayWaveform'
import { buildWaveformSurfaceCacheDataFromUnifiedDisplay } from '../../../shared/waveformSurfaceCache'
import { normalizePath, type DoneEntry } from './types'
import type { EnsureSongCacheEntryPayload } from './songCacheEntryPersistence'

type EnsureWaveformSongCacheEntry = (
  listRoot: string,
  filePath: string,
  payload: EnsureSongCacheEntryPayload,
  stat?: { size: number; mtimeMs: number }
) => Promise<void>

type CreateWaveformPersistenceParams = {
  doneByPath: Map<string, DoneEntry>
  ensureSongCacheEntry: EnsureWaveformSongCacheEntry
  cleanupMissingPersistTarget: (normalizedPath: string, filePath: string) => Promise<void>
  isMissingFileError: (error: unknown) => boolean
}

export const createPersistWaveform = (params: CreateWaveformPersistenceParams) => {
  return async (
    filePath: string,
    waveformData: MixxxWaveformData,
    unifiedDisplayWaveformData?: UnifiedDisplayWaveformDetailData | null
  ) => {
    const normalizedPath = normalizePath(filePath)
    try {
      const stat = await fs.stat(filePath)
      const existing = params.doneByPath.get(normalizedPath)
      const listRoot = await findSongListRoot(path.dirname(filePath))
      const surfaceData = buildWaveformSurfaceCacheDataFromUnifiedDisplay(
        unifiedDisplayWaveformData
      )
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
        energyAnalysis: existing?.energyAnalysis,
        songStructure: existing?.songStructure,
        hasWaveform: listRoot ? Boolean(surfaceData) : true
      })

      if (listRoot) {
        const cached = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
        if (!cached) {
          await params.ensureSongCacheEntry(
            listRoot,
            filePath,
            {},
            { size: stat.size, mtimeMs: stat.mtimeMs }
          )
        }
        await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
        await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
        if (unifiedDisplayWaveformData && surfaceData) {
          await LibraryCacheDb.upsertUnifiedDisplayWaveformCacheEntry(
            listRoot,
            filePath,
            { size: stat.size, mtimeMs: stat.mtimeMs },
            unifiedDisplayWaveformData
          )
          await LibraryCacheDb.upsertWaveformSurfaceCacheEntry(
            listRoot,
            filePath,
            { size: stat.size, mtimeMs: stat.mtimeMs },
            surfaceData
          )
          await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(listRoot, filePath)
          await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
        } else {
          await LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
          await LibraryCacheDb.removeWaveformSurfaceCacheEntry(listRoot, filePath)
        }
      } else {
        const externalContext = LibraryCacheDb.resolveExternalAnalysisContext(filePath)
        if (externalContext) {
          const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
            size: stat.size,
            mtimeMs: stat.mtimeMs
          })
          if (!cached) {
            await LibraryCacheDb.upsertExternalAnalysisCacheEntry(externalContext, stat, {
              ...buildLiteSongInfo(filePath),
              filePath,
              analysisOnly: true
            })
          }
          await LibraryCacheDb.upsertExternalAnalysisWaveformCacheEntry(
            externalContext,
            { size: stat.size, mtimeMs: stat.mtimeMs },
            waveformData
          )
        }
      }
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
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
        energyAnalysis: existing?.energyAnalysis,
        songStructure: existing?.songStructure,
        hasWaveform: true
      })
      log.error('[闲时分析] persistWaveform 失败，已写入内存兜底', {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
