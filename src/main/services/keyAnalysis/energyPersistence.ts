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
  normalizeSongEnergyAnalysis,
  normalizeSongEnergyScore,
  type SongEnergyAnalysisV5
} from '../../../shared/songEnergy'
import { loadSharedSongGridDefinition } from '../sharedSongGrid'
import {
  normalizeEnergySourceGridSignature,
  readEnergySourceGridSignature
} from './energyCachePolicy'
import { isSameAudioIdentity, normalizeAudioIdentity } from './persistGuard'
import { normalizePath, type DoneEntry } from './types'

type EnergySongCachePayload = {
  energyScore?: number
  energyAlgorithmVersion?: number
  energyAnalysis?: SongEnergyAnalysisV5
  energySourceGridSignature?: string
}

type EnsureEnergySongCacheEntry = (
  listRoot: string,
  filePath: string,
  payload: EnergySongCachePayload,
  stat?: { size: number; mtimeMs: number },
  options?: {
    shouldPersist?: () => boolean
    validateBeforeWrite?: () => boolean | Promise<boolean>
  }
) => Promise<void>

type CreateEnergyPersistenceParams = {
  doneByPath: Map<string, DoneEntry>
  events: EventEmitter
  ensureSongCacheEntry: EnsureEnergySongCacheEntry
  cleanupMissingPersistTarget: (normalizedPath: string, filePath: string) => Promise<void>
  isMissingFileError: (error: unknown) => boolean
}

export type PersistEnergyOptions = {
  shouldPersist?: () => boolean
  /** 计算能量时使用的有效网格签名；提供后会拒绝与当前网格不一致的晚到结果。 */
  sourceGridSignature?: string
  /** 入队时记录的音频身份；提交前文件被替换则拒绝写入。 */
  expectedAudioIdentity?: { size: number; mtimeMs: number }
}

const normalizeEnergyAlgorithmVersion = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.floor(numeric)
}

const buildEnergySnapshot = (params: {
  energyScore: number
  energyAlgorithmVersion: number
  energyAnalysis?: SongEnergyAnalysisV5
}) =>
  JSON.stringify([params.energyScore, params.energyAlgorithmVersion, params.energyAnalysis ?? null])

export const createPersistEnergy = (params: CreateEnergyPersistenceParams) => {
  return async (
    filePath: string,
    energyScore: number,
    energyAlgorithmVersion = CURRENT_SONG_ENERGY_ALGORITHM_VERSION,
    energyAnalysis?: SongEnergyAnalysisV5,
    options: PersistEnergyOptions = {}
  ) => {
    const shouldPersist = () => options.shouldPersist?.() !== false
    const normalizedPath = normalizePath(filePath)
    const normalizedEnergyScore = normalizeSongEnergyScore(energyScore)
    const normalizedEnergyAlgorithmVersion =
      normalizeEnergyAlgorithmVersion(energyAlgorithmVersion) ??
      CURRENT_SONG_ENERGY_ALGORITHM_VERSION
    const sourceGridSignature = normalizeEnergySourceGridSignature(options.sourceGridSignature)
    if (normalizedEnergyScore === undefined || !shouldPersist()) {
      return
    }
    try {
      const stat = await fs.stat(filePath)
      if (!shouldPersist()) return
      const expectedAudioIdentity = normalizeAudioIdentity(options.expectedAudioIdentity)
      if (
        expectedAudioIdentity &&
        !isSameAudioIdentity(expectedAudioIdentity, { size: stat.size, mtimeMs: stat.mtimeMs })
      ) {
        log.error('[闲时分析] 音频文件已变化，已拒绝写入能量结果', { filePath })
        return
      }

      // 源签名必须在写入前一刻再次核对，不能只依赖一次 snapshot。
      const isSourceGridCurrent = async () => {
        if (!sourceGridSignature) return true
        const currentGrid = await loadSharedSongGridDefinition(filePath)
        return currentGrid?.beatGridMap?.signature === sourceGridSignature
      }
      const isSourceGridSignaturePersisted = (info: unknown) =>
        readEnergySourceGridSignature(info) === sourceGridSignature
      if (!(await isSourceGridCurrent())) {
        log.error('[闲时分析] 能量结果与当前有效网格不一致，已拒绝写入', {
          filePath,
          sourceGridSignature
        })
        return
      }

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (!shouldPersist()) return
      const externalContext = listRoot
        ? null
        : LibraryCacheDb.resolveExternalAnalysisContext(filePath)
      const existingEntry = listRoot
        ? await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
        : externalContext
          ? await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
              size: stat.size,
              mtimeMs: stat.mtimeMs
            })
          : null
      if (!shouldPersist()) return
      const existingInfo = existingEntry?.info
      if (
        existingInfo &&
        buildEnergySnapshot({
          energyScore: normalizeSongEnergyScore(existingInfo.energyScore) ?? -1,
          energyAlgorithmVersion:
            normalizeEnergyAlgorithmVersion(existingInfo.energyAlgorithmVersion) ?? -1,
          energyAnalysis: normalizeSongEnergyAnalysis(existingInfo.energyAnalysis)
        }) ===
          buildEnergySnapshot({
            energyScore: normalizedEnergyScore,
            energyAlgorithmVersion: normalizedEnergyAlgorithmVersion,
            energyAnalysis: normalizeSongEnergyAnalysis(energyAnalysis)
          }) &&
        readEnergySourceGridSignature(existingInfo) === sourceGridSignature
      ) {
        // 幂等：同一结果重复到达时不重复写库，也不发空更新。
        return
      }

      let persisted = false
      if (listRoot) {
        await params.ensureSongCacheEntry(
          listRoot,
          filePath,
          {
            energyScore: normalizedEnergyScore,
            energyAlgorithmVersion: normalizedEnergyAlgorithmVersion,
            energyAnalysis,
            energySourceGridSignature: sourceGridSignature
          },
          { size: stat.size, mtimeMs: stat.mtimeMs },
          { shouldPersist, validateBeforeWrite: isSourceGridCurrent }
        )
        const after = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
        persisted = Boolean(after?.info) && isSourceGridSignaturePersisted(after?.info)
      } else if (externalContext) {
        const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
          size: stat.size,
          mtimeMs: stat.mtimeMs
        })
        const nextInfo = stripBeatThisDebugInfo({
          ...(cached?.info || buildLiteSongInfo(filePath)),
          filePath,
          energyScore: normalizedEnergyScore,
          energyAlgorithmVersion: normalizedEnergyAlgorithmVersion,
          energyAnalysis,
          analysisOnly: true
        })
        if (sourceGridSignature) {
          nextInfo.energySourceGridSignature = sourceGridSignature
        } else {
          delete nextInfo.energySourceGridSignature
        }
        if (!(await isSourceGridCurrent())) return
        if (!shouldPersist()) return
        await LibraryCacheDb.upsertExternalAnalysisCacheEntry(externalContext, stat, nextInfo)
        const after = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
          size: stat.size,
          mtimeMs: stat.mtimeMs
        })
        persisted = Boolean(after?.info) && isSourceGridSignaturePersisted(after?.info)
      } else {
        return
      }
      if (!persisted) {
        log.error('[闲时分析] 能量结果未确认写入，已拒绝广播', { filePath, sourceGridSignature })
        return
      }
      if (!(await isSourceGridCurrent())) return
      if (!shouldPersist()) return

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
        energySourceGridSignature: sourceGridSignature,
        songStructure: existing?.songStructure,
        hasWaveform: existing?.hasWaveform
      })

      params.events.emit('energy-updated', {
        filePath,
        energyScore: normalizedEnergyScore,
        energyAlgorithmVersion: normalizedEnergyAlgorithmVersion,
        energyAnalysis,
        sourceGridSignature
      })
    } catch (error) {
      if (!shouldPersist()) return
      if (params.isMissingFileError(error)) {
        await params.cleanupMissingPersistTarget(normalizedPath, filePath)
        return
      }
      // 写库失败不发布成功事件，也不写内存兜底：旧结果继续代表磁盘事实。
      log.error('[闲时分析] persistEnergy 失败，已拒绝发布未落盘结果', {
        filePath,
        energyScore: normalizedEnergyScore,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
