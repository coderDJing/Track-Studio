import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSongBeatGridMapV2FromClips } from '../../../shared/songBeatGridMapV2'
import type { DynamicGridOutcome } from '../../../shared/dynamicBeatGridTypes'

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  statSync: vi.fn(),
  writeCount: { value: 0 },
  findSongListRoot: vi.fn(),
  loadSongCacheEntry: vi.fn(),
  upsertSongCacheEntry: vi.fn(),
  loadExternalAnalysisCacheEntry: vi.fn(),
  resolveExternalAnalysisContext: vi.fn(),
  upsertExternalAnalysisCacheEntry: vi.fn(),
  persistSharedSongGridDefinition: vi.fn(),
  emitSongGridUpdated: vi.fn(),
  ensureSongCacheEntry: vi.fn(),
  probeTimeBasisOffsetMs: vi.fn(),
  logError: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  default: { stat: mocks.stat },
  stat: mocks.stat
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, statSync: mocks.statSync }
})

vi.mock('../cacheMaintenance', () => ({
  findSongListRoot: mocks.findSongListRoot
}))

vi.mock('../../libraryCacheDb', () => ({
  loadSongCacheEntry: mocks.loadSongCacheEntry,
  upsertSongCacheEntry: mocks.upsertSongCacheEntry,
  loadExternalAnalysisCacheEntry: mocks.loadExternalAnalysisCacheEntry,
  resolveExternalAnalysisContext: mocks.resolveExternalAnalysisContext,
  upsertExternalAnalysisCacheEntry: mocks.upsertExternalAnalysisCacheEntry
}))

vi.mock('../../libraryCacheDb/pathResolvers', () => ({
  stripBeatThisDebugInfo: <T extends object>(info: T) => info
}))

vi.mock('../songInfoLite', () => ({
  buildLiteSongInfo: (filePath: string) => ({ filePath }),
  applyLiteDefaults: <T extends object>(info: T) => info
}))

vi.mock('../../log', () => ({
  log: { error: mocks.logError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}))

vi.mock('../sharedSongGrid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sharedSongGrid')>()
  return {
    ...actual,
    persistSharedSongGridDefinition: mocks.persistSharedSongGridDefinition
  }
})

vi.mock('../songGridEvents', () => ({
  emitSongGridUpdated: mocks.emitSongGridUpdated,
  emitSongGridBatchUpdated: vi.fn()
}))

vi.mock('./songCacheEntryPersistence', () => ({
  ensureSongCacheEntry: mocks.ensureSongCacheEntry
}))

vi.mock('./energyPersistence', () => ({
  createPersistEnergy: () => vi.fn()
}))

vi.mock('./waveformPersistence', () => ({
  createPersistWaveform: () => vi.fn()
}))

vi.mock('./structurePersistence', () => ({
  createPersistSongStructure: () => vi.fn()
}))

vi.mock('./coverCacheCleanup', () => ({
  removeCoverCacheForMissingTrack: vi.fn()
}))

vi.mock('../../workers/beatThisRuntime', () => ({
  getBeatThisRuntimeAvailabilitySnapshot: () => true
}))

vi.mock('../audioTimeBasisOffset', () => ({
  resolveAudioTimeBasisOffsetMsForFile: mocks.probeTimeBasisOffsetMs,
  resolveAudioFirstBeatTimelineMs: (firstBeatMs: number, offsetMs: number) =>
    Number((Number(firstBeatMs) + Math.max(0, Number(offsetMs) || 0)).toFixed(3))
}))

import { createKeyAnalysisPersistence } from './persistence'
import { normalizePath } from './types'

const FILE_PATH = 'G:\\FRKB_database-A\\library\\FilterLibrary\\dynamic.mp3'
const LIST_ROOT = 'G:\\FRKB_database-A'
const AUDIO_DURATION_SEC = 120

type StoredEntry = { size: number; mtimeMs: number; info: Record<string, unknown> }

const store = new Map<string, StoredEntry>()

const buildDynamicOutcome = (): DynamicGridOutcome => {
  const audioMap = createSongBeatGridMapV2FromClips(
    [
      { startSec: 0, anchorSec: 0.5, bpm: 128, downbeatBeatOffset: 0 },
      { startSec: 60, anchorSec: 60.25, bpm: 130, downbeatBeatOffset: 1 }
    ],
    'analysis',
    { allowSingleClip: true }
  )!
  return {
    status: 'dynamic',
    coordinate: 'audio',
    beatGridMap: audioMap,
    durationAudioSec: AUDIO_DURATION_SEC,
    policyVersion: 'dynamic-grid-test-1',
    metrics: {
      policyVersion: 'dynamic-grid-test-1',
      windowCount: 8,
      okWindowCount: 8,
      noBeatWindowCount: 0,
      scannedDurationAudioSec: AUDIO_DURATION_SEC,
      scannedCoverageRatio: 1,
      noBeatWindowDurationAudioSec: 0,
      beatEvidenceSpanDurationAudioSec: AUDIO_DURATION_SEC,
      beatEvidenceSpanRatio: 1,
      evidenceBeatCount: 400,
      fittedBeatCount: 400,
      runtimeLineCount: 400,
      runtimeMatchedBeatCount: 398,
      runtimeUnmatchedLineCount: 2,
      runtimeUnmatchedEvidenceCount: 2,
      runtimeHeadExtrapolatedLineCount: 0,
      runtimeTailExtrapolatedLineCount: 0,
      runtimeDownbeatMismatchCount: 0,
      runtimeBoundaryMismatchCount: 0,
      excludedBeatCount: 0,
      inferredMissingBeatCount: 0,
      extraBeatCount: 0,
      gapAnomalyCount: 0,
      unexplainedBeatCount: 2,
      unexplainedBeatRatio: 0.005,
      overlapComparisonCount: 40,
      overlapMatchedCount: 40,
      overlapMatchRate: 1,
      overlapResidualP95Ms: 4,
      overlapResidualMaxMs: 9,
      residualP50Ms: 2,
      residualP95Ms: 6,
      residualMaxMs: 12,
      cumulativePhaseDeviationMaxMs: 20,
      seamBoundaryErrorMaxMs: 6,
      tailErrorMs: 8,
      downbeatObservedCount: 100,
      downbeatConflictCount: 0,
      clipCount: 2,
      requestedMinBpm: 70,
      requestedMaxBpm: 180
    }
  }
}

const createPersistence = () => {
  const events = new EventEmitter()
  return {
    events,
    persistence: createKeyAnalysisPersistence({ doneByPath: new Map(), events })
  }
}

const getStoredInfo = () => store.get(normalizePath(FILE_PATH))?.info ?? {}

type MockWriteOptions = {
  shouldPersist?: () => boolean
  decide?: (context: {
    info: StoredEntry['info'] | null
    size: number | null
    mtimeMs: number | null
  }) => { info: StoredEntry['info'] | null; reason?: string }
  result?: { reason?: string }
}

describe('createKeyAnalysisPersistence - persistBpm dynamic branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.clear()
    mocks.writeCount.value = 0
    mocks.stat.mockResolvedValue({ size: 100, mtimeMs: 200 })
    mocks.statSync.mockReturnValue({ size: 100, mtimeMs: 200 })
    mocks.findSongListRoot.mockResolvedValue(LIST_ROOT)
    mocks.resolveExternalAnalysisContext.mockReturnValue(null)
    mocks.probeTimeBasisOffsetMs.mockResolvedValue(0)
    mocks.loadSongCacheEntry.mockImplementation(
      async () => store.get(normalizePath(FILE_PATH)) ?? null
    )
    mocks.upsertSongCacheEntry.mockImplementation(
      async (
        _root: string,
        filePath: string,
        entry: StoredEntry,
        _oldFilePath: string | undefined,
        options?: MockWriteOptions
      ) => {
        if (options?.shouldPersist && !options.shouldPersist()) {
          if (options.result) options.result.reason = 'generation'
          return false
        }
        let info = entry.info
        if (options?.decide) {
          const existing = store.get(normalizePath(filePath))
          const decision = options.decide({
            info: existing?.info ?? null,
            size: existing?.size ?? null,
            mtimeMs: existing?.mtimeMs ?? null
          })
          if (!decision.info) {
            if (options.result) options.result.reason = decision.reason || 'skipped'
            return false
          }
          if (options.shouldPersist && !options.shouldPersist()) {
            if (options.result) options.result.reason = 'generation'
            return false
          }
          info = decision.info
        }
        store.set(normalizePath(filePath), {
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          info
        })
        mocks.writeCount.value += 1
        return true
      }
    )
  })

  it('applies a non-zero time basis exactly once and writes mode/policy metadata', async () => {
    const { persistence } = createPersistence()
    await persistence.persistBpm(FILE_PATH, 0, undefined, undefined, 120, {
      dynamicGridOutcome: buildDynamicOutcome()
    })

    const info = getStoredInfo()
    const map = info.beatGridMap as { clips: Array<{ startSec: number; anchorSec: number }> }
    expect(map.clips).toHaveLength(2)
    expect(map.clips[0].startSec).toBe(0)
    expect(map.clips[0].anchorSec).toBeCloseTo(0.62, 6)
    expect(map.clips[1].startSec).toBeCloseTo(60.12, 6)
    expect(map.clips[1].anchorSec).toBeCloseTo(60.37, 6)
    expect(info.timeBasisOffsetMs).toBe(120)
    expect(info.beatGridAnalysisMode).toBe('dynamic')
    expect(info.beatGridResultShape).toBe('dynamic')
    expect(info.beatGridPolicyVersion).toBe('dynamic-grid-test-1')
    expect(mocks.writeCount.value).toBe(1)
    expect(mocks.ensureSongCacheEntry).not.toHaveBeenCalled()
    expect(mocks.persistSharedSongGridDefinition).not.toHaveBeenCalled()
    expect(mocks.emitSongGridUpdated).toHaveBeenCalledTimes(1)
  })

  it('writes a new definition once and skips the repeat (analyze-done + final)', async () => {
    const { persistence } = createPersistence()
    const outcome = buildDynamicOutcome()
    // 中途 analyze-done 与最终 result 携带同一份完整 outcome。
    await persistence.persistBpm(FILE_PATH, 0, undefined, undefined, 0, {
      dynamicGridOutcome: outcome
    })
    await persistence.persistBpm(FILE_PATH, 0, undefined, undefined, 0, {
      dynamicGridOutcome: outcome
    })

    expect(mocks.ensureSongCacheEntry).not.toHaveBeenCalled()
    expect(mocks.persistSharedSongGridDefinition).not.toHaveBeenCalled()
    expect(mocks.writeCount.value).toBe(1)
    expect(mocks.emitSongGridUpdated).toHaveBeenCalledTimes(1)
    const info = getStoredInfo()
    expect((info.beatGridMap as { clips: unknown[] }).clips).toHaveLength(2)
    expect(info.beatGridAnalysisMode).toBe('dynamic')
  })

  it('rejects a failed dynamic outcome and keeps the previous grid without writing no-bpm', async () => {
    const { persistence } = createPersistence()
    const previous = createSongBeatGridMapV2FromClips(
      [{ startSec: 0, anchorSec: 0, bpm: 124, downbeatBeatOffset: 0 }],
      'analysis',
      { allowSingleClip: true }
    )!
    store.set(normalizePath(FILE_PATH), {
      size: 100,
      mtimeMs: 200,
      info: { filePath: FILE_PATH, beatGridMap: previous }
    })

    await expect(
      persistence.persistBpm(FILE_PATH, 0, undefined, undefined, 0, {
        dynamicGridOutcome: { status: 'unresolved', reason: 'seam-conflict' }
      })
    ).rejects.toThrow(/dynamic-grid unresolved: seam-conflict/)

    const info = getStoredInfo()
    const storedMap = info.beatGridMap as { signature: string }
    expect(storedMap.signature).toBe(previous.signature)
    expect(info.beatGridStatus).toBeUndefined()
    expect(mocks.ensureSongCacheEntry).not.toHaveBeenCalled()
    expect(mocks.upsertSongCacheEntry).not.toHaveBeenCalled()
    expect(mocks.emitSongGridUpdated).not.toHaveBeenCalled()
  })

  it('keeps a manual grid that appeared during analysis instead of the analysed candidate', async () => {
    const { persistence } = createPersistence()
    const manualMap = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0, bpm: 126, downbeatBeatOffset: 0 },
        { startSec: 45, anchorSec: 45.5, bpm: 127, downbeatBeatOffset: 2 }
      ],
      'manual',
      { allowSingleClip: true }
    )!
    store.set(normalizePath(FILE_PATH), {
      size: 100,
      mtimeMs: 200,
      info: { filePath: FILE_PATH, beatGridMap: manualMap }
    })

    await persistence.persistBpm(FILE_PATH, 0, undefined, undefined, 0, {
      dynamicGridOutcome: buildDynamicOutcome()
    })

    const info = getStoredInfo()
    expect((info.beatGridMap as { signature: string }).signature).toBe(manualMap.signature)
    expect((info.beatGridMap as { clips: unknown[] }).clips).toHaveLength(2)
    // 候选结果的模式/policy 元数据不得写到被保护的人工网格上。
    expect(info.beatGridAnalysisMode).toBeUndefined()
    expect(info.beatGridPolicyVersion).toBeUndefined()
    expect(mocks.writeCount.value).toBe(0)
    expect(mocks.ensureSongCacheEntry).not.toHaveBeenCalled()
    expect(mocks.emitSongGridUpdated).not.toHaveBeenCalled()
  })

  it('skips the write when the audio identity changed during analysis', async () => {
    const { persistence } = createPersistence()
    await persistence.persistBpm(FILE_PATH, 0, undefined, undefined, 0, {
      dynamicGridOutcome: buildDynamicOutcome(),
      expectedAudioIdentity: { size: 100, mtimeMs: 199 }
    })

    expect(mocks.ensureSongCacheEntry).not.toHaveBeenCalled()
    expect(mocks.upsertSongCacheEntry).not.toHaveBeenCalled()
    expect(mocks.emitSongGridUpdated).not.toHaveBeenCalled()
  })
})
