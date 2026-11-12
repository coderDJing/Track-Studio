import fs from 'node:fs/promises'
import { statSync } from 'node:fs'
import path from 'node:path'
import type { ISongInfo } from '../../../types/globals'
import type { SongBeatGridMapV2 } from '../../../shared/songBeatGridMapV2'
import { normalizeSongBeatGridMapV2 } from '../../../shared/songBeatGridMapV2'
import type { DynamicGridOutcome } from '../../../shared/dynamicBeatGridTypes'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { stripBeatThisDebugInfo } from '../../libraryCacheDb/pathResolvers'
import { findSongListRoot } from '../cacheMaintenance'
import { applyLiteDefaults, buildLiteSongInfo } from '../songInfoLite'
import { shouldKeepManualSharedSongGridDefinition } from '../sharedSongGrid'
import { emitSongGridUpdated } from '../songGridEvents'
import {
  CURRENT_BEAT_GRID_ALGORITHM_VERSION,
  normalizeBeatGridAlgorithmVersion
} from '../beatGridAlgorithmVersion'
import { resolveAudioTimeBasisOffsetMsForFile } from '../audioTimeBasisOffset'
import {
  applyGridAnalysisMetadata,
  isSameGridAnalysisMetadata,
  readGridAnalysisMetadata,
  type GridAnalysisMetadata
} from './gridAnalysisMetadata'
import {
  buildDynamicGridFailureDetail,
  isDynamicGridSuccessOutcome,
  resolveDynamicGridTimelineDefinition
} from './dynamicGridIntegration'
import { buildDoneEntry } from './doneEntry'
import type { DoneEntry } from './types'

export const DYNAMIC_GRID_TIME_BASIS_TOLERANCE_MS = 0.001

export type DynamicGridPersistenceErrorCode = 'missing-target' | 'file-changed' | 'write-failed'

export class DynamicGridPersistenceError extends Error {
  readonly code: DynamicGridPersistenceErrorCode

  constructor(code: DynamicGridPersistenceErrorCode, message: string) {
    super(message)
    this.name = 'DynamicGridPersistenceError'
    this.code = code
  }
}

export type DynamicGridExpectedSnapshot = {
  gridSignature: string | null
  timeBasisOffsetMs: number | undefined
  beatGridAlgorithmVersion: number | undefined
  metadata: GridAnalysisMetadata
}

export type DynamicGridPersistenceResult =
  | { status: 'written' }
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: 'manual' | 'stale' | 'generation' }

type DynamicGridDecision = { info: ISongInfo | null; reason?: string }

const normalizeTimeBasisOffsetMs = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return undefined
  return Number(numeric.toFixed(3))
}

const readGridSignature = (info: ISongInfo | null | undefined) =>
  normalizeSongBeatGridMapV2(info?.beatGridMap, { allowSingleClip: true })?.signature ?? null

export const buildDynamicGridExpectedSnapshot = (
  info: ISongInfo | null | undefined
): DynamicGridExpectedSnapshot => ({
  gridSignature: readGridSignature(info),
  timeBasisOffsetMs: normalizeTimeBasisOffsetMs(info?.timeBasisOffsetMs),
  beatGridAlgorithmVersion: normalizeBeatGridAlgorithmVersion(info?.beatGridAlgorithmVersion),
  metadata: readGridAnalysisMetadata(info)
})

const isSameDesiredGrid = (params: {
  info: ISongInfo
  map: SongBeatGridMapV2
  timeBasisOffsetMs: number
  beatGridAlgorithmVersion: number
  gridMetadata: GridAnalysisMetadata
}) => {
  const { info, map, timeBasisOffsetMs, beatGridAlgorithmVersion, gridMetadata } = params
  const existingMap = normalizeSongBeatGridMapV2(info.beatGridMap, { allowSingleClip: true })
  return (
    existingMap?.signature === map.signature &&
    normalizeBeatGridAlgorithmVersion(info.beatGridAlgorithmVersion) === beatGridAlgorithmVersion &&
    normalizeTimeBasisOffsetMs(info.timeBasisOffsetMs) === timeBasisOffsetMs &&
    isSameGridAnalysisMetadata(readGridAnalysisMetadata(info), gridMetadata)
  )
}

const isSameExpectedGrid = (params: {
  info: ISongInfo | null
  expected: DynamicGridExpectedSnapshot
}) => {
  const { info, expected } = params
  if (!info) {
    return (
      expected.gridSignature === null &&
      expected.timeBasisOffsetMs === undefined &&
      expected.beatGridAlgorithmVersion === undefined &&
      isSameGridAnalysisMetadata(expected.metadata, {})
    )
  }
  return (
    readGridSignature(info) === expected.gridSignature &&
    normalizeTimeBasisOffsetMs(info.timeBasisOffsetMs) === expected.timeBasisOffsetMs &&
    normalizeBeatGridAlgorithmVersion(info.beatGridAlgorithmVersion) ===
      expected.beatGridAlgorithmVersion &&
    isSameGridAnalysisMetadata(readGridAnalysisMetadata(info), expected.metadata)
  )
}

export type PersistDynamicGridDefinitionParams = {
  filePath: string
  expectedAudioIdentity: { size: number; mtimeMs: number }
  listRoot: string | null
  externalContext: LibraryCacheDb.ExternalAnalysisContext | null
  beatGridMap: SongBeatGridMapV2
  timeBasisOffsetMs: number
  beatGridAlgorithmVersion: number
  gridMetadata: GridAnalysisMetadata
  expectedGrid?: DynamicGridExpectedSnapshot
  shouldPersist: () => boolean
}

/**
 * Dynamic 网格的唯一提交点：map + timeBasis + mode/shape/policy 在同一次
 * SQLite 事务里写入；人工/代次/CAS 检查也在该事务内读取最新 row。
 * 只有提交成功才广播 grid-updated。
 */
export const persistDynamicGridDefinition = async (
  params: PersistDynamicGridDefinitionParams
): Promise<DynamicGridPersistenceResult> => {
  const {
    filePath,
    expectedAudioIdentity,
    listRoot,
    externalContext,
    beatGridMap,
    timeBasisOffsetMs,
    beatGridAlgorithmVersion,
    gridMetadata,
    expectedGrid,
    shouldPersist
  } = params
  if (!listRoot && !externalContext) {
    throw new DynamicGridPersistenceError(
      'missing-target',
      'dynamic grid has no song cache or external cache target'
    )
  }
  if (!shouldPersist()) return { status: 'skipped', reason: 'generation' }

  let stat: { size: number; mtimeMs: number }
  try {
    const fsStat = await fs.stat(filePath)
    stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
  } catch (error) {
    throw new DynamicGridPersistenceError(
      'file-changed',
      `dynamic grid source file is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (
    expectedAudioIdentity.size !== stat.size ||
    Math.abs(expectedAudioIdentity.mtimeMs - stat.mtimeMs) >= 1
  ) {
    throw new DynamicGridPersistenceError(
      'file-changed',
      'audio file changed before dynamic grid commit'
    )
  }
  if (!shouldPersist()) return { status: 'skipped', reason: 'generation' }

  const buildNextInfo = (latest: ISongInfo | null, forceAnalysisOnly: boolean): ISongInfo => {
    const next = applyLiteDefaults(latest ? { ...latest } : buildLiteSongInfo(filePath), filePath)
    if (forceAnalysisOnly || !latest || Boolean(latest.analysisOnly)) {
      next.analysisOnly = true
    }
    delete next.bpm
    delete next.firstBeatMs
    delete next.downbeatBeatOffset
    delete (next as unknown as Record<string, unknown>).barBeatOffset
    delete next.beatGridSource
    delete next.beatGridStatus
    next.beatGridMap = beatGridMap
    next.beatGridAlgorithmVersion = beatGridAlgorithmVersion
    next.timeBasisOffsetMs = timeBasisOffsetMs
    applyGridAnalysisMetadata(next, gridMetadata)
    stripBeatThisDebugInfo(next)
    return next
  }

  const decide = (latest: ISongInfo | null, forceAnalysisOnly: boolean): DynamicGridDecision => {
    if (!shouldPersist()) return { info: null, reason: 'generation' }
    try {
      const current = statSync(filePath)
      if (
        current.size !== expectedAudioIdentity.size ||
        Math.abs(current.mtimeMs - expectedAudioIdentity.mtimeMs) >= 1
      ) {
        return { info: null, reason: 'file-changed' }
      }
    } catch {
      return { info: null, reason: 'file-changed' }
    }
    if (
      latest &&
      shouldKeepManualSharedSongGridDefinition(latest, {
        filePath,
        beatGridSource: 'analysis',
        beatGridMap
      })
    ) {
      return { info: null, reason: 'manual' }
    }
    if (
      latest &&
      isSameDesiredGrid({
        info: latest,
        map: beatGridMap,
        timeBasisOffsetMs,
        beatGridAlgorithmVersion,
        gridMetadata
      })
    ) {
      return { info: null, reason: 'unchanged' }
    }
    if (expectedGrid && !isSameExpectedGrid({ info: latest, expected: expectedGrid })) {
      return { info: null, reason: 'stale' }
    }
    if (!shouldPersist()) return { info: null, reason: 'generation' }
    return { info: buildNextInfo(latest, forceAnalysisOnly) }
  }

  const result: { reason?: string } = {}
  const fallbackInfo = buildNextInfo(null, Boolean(externalContext))
  let written = false
  if (listRoot) {
    written = await LibraryCacheDb.upsertSongCacheEntry(
      listRoot,
      filePath,
      {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        info: fallbackInfo
      },
      undefined,
      {
        shouldPersist,
        decide: (context) => decide(context.info, false),
        result
      }
    )
  } else if (externalContext) {
    written = await LibraryCacheDb.upsertExternalAnalysisCacheEntry(
      externalContext,
      stat,
      fallbackInfo,
      {
        shouldPersist,
        decide: (context) => decide(context.info, true),
        result
      }
    )
  }

  if (written) {
    emitSongGridUpdated({
      filePath,
      beatGridMap,
      beatGridAlgorithmVersion,
      timeBasisOffsetMs
    })
    return { status: 'written' }
  }
  if (result.reason === 'file-changed') {
    throw new DynamicGridPersistenceError(
      'file-changed',
      'audio file changed during dynamic grid commit'
    )
  }
  if (result.reason === 'unchanged') return { status: 'unchanged' }
  if (result.reason === 'manual' || result.reason === 'stale' || result.reason === 'generation') {
    return { status: 'skipped', reason: result.reason }
  }
  throw new DynamicGridPersistenceError('write-failed', 'dynamic grid cache write did not commit')
}

export type PersistDynamicGridOutcomeParams = {
  filePath: string
  stat: { size: number; mtimeMs: number }
  outcome: DynamicGridOutcome
  expectedAudioDurationSec?: number
  timeBasisOffsetMs?: number
  shouldPersist: () => boolean
  existingDone?: DoneEntry
}

export type PersistDynamicGridOutcomeResult =
  | { status: 'written'; doneEntry: DoneEntry }
  | { status: 'unchanged'; doneEntry: DoneEntry }
  | { status: 'skipped'; reason: 'manual' | 'stale' | 'generation' }

export const persistDynamicGridOutcome = async (
  params: PersistDynamicGridOutcomeParams
): Promise<PersistDynamicGridOutcomeResult> => {
  const { filePath, stat, outcome, shouldPersist } = params
  if (!isDynamicGridSuccessOutcome(outcome)) {
    throw new Error(buildDynamicGridFailureDetail(outcome))
  }
  let timeBasisOffsetMs = normalizeTimeBasisOffsetMs(params.timeBasisOffsetMs)
  if (timeBasisOffsetMs === undefined) {
    timeBasisOffsetMs = normalizeTimeBasisOffsetMs(
      await resolveAudioTimeBasisOffsetMsForFile(filePath)
    )
    if (!shouldPersist()) return { status: 'skipped', reason: 'generation' }
  }
  if (timeBasisOffsetMs === undefined) {
    throw new Error('missing audio time basis offset for dynamic grid')
  }
  const definition = resolveDynamicGridTimelineDefinition({
    outcome,
    timeBasisOffsetMs,
    expectedDurationAudioSec: params.expectedAudioDurationSec
  })
  if (!definition.ok) {
    throw new Error(`dynamic grid rejected: ${definition.reason}`)
  }
  const listRoot = await findSongListRoot(path.dirname(filePath))
  if (!shouldPersist()) return { status: 'skipped', reason: 'generation' }
  const externalContext = listRoot ? null : LibraryCacheDb.resolveExternalAnalysisContext(filePath)
  const baseEntry = listRoot
    ? await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
    : externalContext
      ? await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
          size: stat.size,
          mtimeMs: stat.mtimeMs
        })
      : null
  if (!shouldPersist()) return { status: 'skipped', reason: 'generation' }
  if (!listRoot && !externalContext) {
    throw new DynamicGridPersistenceError(
      'missing-target',
      'dynamic grid has no song cache or external cache target'
    )
  }
  const commit = await persistDynamicGridDefinition({
    filePath,
    expectedAudioIdentity: { size: stat.size, mtimeMs: stat.mtimeMs },
    listRoot,
    externalContext,
    beatGridMap: definition.value.map,
    timeBasisOffsetMs,
    beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION,
    gridMetadata: {
      mode: 'dynamic',
      shape: outcome.status,
      policyVersion: outcome.policyVersion
    },
    expectedGrid: buildDynamicGridExpectedSnapshot(baseEntry?.info),
    shouldPersist
  })
  if (commit.status === 'written' || commit.status === 'unchanged') {
    return {
      status: commit.status,
      doneEntry: buildDoneEntry({
        existing: params.existingDone,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        beatGridMap: definition.value.map,
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION
      })
    }
  }
  return commit
}
