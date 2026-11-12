import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSongBeatGridMapV2FromClips } from '../../../shared/songBeatGridMapV2'

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  findSongListRoot: vi.fn(),
  loadSongCacheEntry: vi.fn(),
  upsertExternalAnalysisCacheEntry: vi.fn(),
  loadExternalAnalysisCacheEntry: vi.fn(),
  resolveExternalAnalysisContext: vi.fn(),
  loadSharedSongGridDefinition: vi.fn(),
  ensureSongCacheEntry: vi.fn(),
  logError: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  default: { stat: mocks.stat },
  stat: mocks.stat
}))

vi.mock('../cacheMaintenance', () => ({ findSongListRoot: mocks.findSongListRoot }))

vi.mock('../../libraryCacheDb', () => ({
  loadSongCacheEntry: mocks.loadSongCacheEntry,
  upsertExternalAnalysisCacheEntry: mocks.upsertExternalAnalysisCacheEntry,
  loadExternalAnalysisCacheEntry: mocks.loadExternalAnalysisCacheEntry,
  resolveExternalAnalysisContext: mocks.resolveExternalAnalysisContext
}))

vi.mock('../../libraryCacheDb/pathResolvers', () => ({
  stripBeatThisDebugInfo: <T extends object>(info: T) => info
}))

vi.mock('../songInfoLite', () => ({
  buildLiteSongInfo: (filePath: string) => ({ filePath })
}))

vi.mock('../../log', () => ({
  log: { error: mocks.logError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}))

vi.mock('../sharedSongGrid', () => ({
  loadSharedSongGridDefinition: mocks.loadSharedSongGridDefinition
}))

import { createPersistEnergy } from './energyPersistence'
import { normalizePath } from './types'

const FILE_PATH = 'G:\\FRKB_database-A\\library\\FilterLibrary\\energy.mp3'
const LIST_ROOT = 'G:\\FRKB_database-A'

const buildMap = (bpmList: number[], source: 'analysis' | 'manual' = 'analysis') =>
  createSongBeatGridMapV2FromClips(
    bpmList.map((bpm, index) => ({
      startSec: index === 0 ? 0 : index * 60,
      anchorSec: index * 60,
      bpm,
      downbeatBeatOffset: 0
    })),
    source,
    { allowSingleClip: true }
  )!

type StoredEntry = { size: number; mtimeMs: number; info: Record<string, unknown> }
const store = new Map<string, StoredEntry>()

const createPersistence = (events = new EventEmitter()) => {
  const updates: unknown[] = []
  events.on('energy-updated', (payload) => updates.push(payload))
  const persistEnergy = createPersistEnergy({
    doneByPath: new Map(),
    events,
    ensureSongCacheEntry: mocks.ensureSongCacheEntry,
    cleanupMissingPersistTarget: vi.fn(),
    isMissingFileError: () => false
  })
  return { persistEnergy, updates }
}

describe('createPersistEnergy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.clear()
    mocks.stat.mockResolvedValue({ size: 100, mtimeMs: 200 })
    mocks.findSongListRoot.mockResolvedValue(LIST_ROOT)
    mocks.resolveExternalAnalysisContext.mockReturnValue(null)
    mocks.loadSongCacheEntry.mockImplementation(
      async () => store.get(normalizePath(FILE_PATH)) ?? null
    )
    mocks.ensureSongCacheEntry.mockImplementation(
      async (
        _root: string,
        filePath: string,
        payload: Record<string, unknown>,
        _stat: unknown,
        options?: { validateBeforeWrite?: () => boolean | Promise<boolean> }
      ) => {
        const validation = options?.validateBeforeWrite?.()
        if (validation instanceof Promise ? !(await validation) : validation === false) return
        const existing = store.get(normalizePath(filePath))
        const info = { ...(existing?.info ?? {}) }
        info.energyScore = payload.energyScore
        info.energyAlgorithmVersion = payload.energyAlgorithmVersion
        info.energyAnalysis = payload.energyAnalysis
        if (payload.energySourceGridSignature) {
          info.energySourceGridSignature = payload.energySourceGridSignature
        }
        store.set(normalizePath(filePath), { size: 100, mtimeMs: 200, info })
      }
    )
  })

  it('rejects energy computed for a grid that was replaced by a manual revision', async () => {
    const candidate = buildMap([128, 130])
    const manual = buildMap([126], 'manual')
    mocks.loadSharedSongGridDefinition.mockResolvedValue({
      filePath: FILE_PATH,
      beatGridMap: manual
    })
    const { persistEnergy, updates } = createPersistence()

    await persistEnergy(FILE_PATH, 66, 11, undefined, {
      sourceGridSignature: candidate.signature
    })

    expect(store.size).toBe(0)
    expect(mocks.ensureSongCacheEntry).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
    expect(mocks.logError).toHaveBeenCalled()
  })

  it('persists the source grid signature and stays idempotent', async () => {
    const map = buildMap([128, 132])
    mocks.loadSharedSongGridDefinition.mockResolvedValue({
      filePath: FILE_PATH,
      beatGridMap: map
    })
    const { persistEnergy, updates } = createPersistence()

    const analysis = {
      version: 11 as const,
      model: 'musicnn-deam-emomusic-structure-v11' as const,
      sustainedScore: 66,
      averageScore: 60,
      medianScore: 61,
      peakScore: 80,
      rangeScore: 20,
      confidence: 70,
      patchCount: 12
    }
    await persistEnergy(FILE_PATH, 66, 11, analysis, { sourceGridSignature: map.signature })
    await persistEnergy(FILE_PATH, 66, 11, analysis, { sourceGridSignature: map.signature })

    expect(mocks.ensureSongCacheEntry).toHaveBeenCalledTimes(1)
    expect(store.get(normalizePath(FILE_PATH))?.info.energySourceGridSignature).toBe(map.signature)
    expect(updates).toHaveLength(1)
  })

  it('re-checks the source grid right before writing', async () => {
    const map = buildMap([128, 132])
    const replacement = buildMap([120], 'manual')
    mocks.loadSharedSongGridDefinition
      .mockResolvedValueOnce({ filePath: FILE_PATH, beatGridMap: map })
      .mockResolvedValue({ filePath: FILE_PATH, beatGridMap: replacement })
    const { persistEnergy, updates } = createPersistence()

    await persistEnergy(FILE_PATH, 55, 11, undefined, { sourceGridSignature: map.signature })

    expect(store.size).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('does not broadcast when the persisted signature cannot be confirmed', async () => {
    const map = buildMap([128, 132])
    mocks.loadSharedSongGridDefinition.mockResolvedValue({
      filePath: FILE_PATH,
      beatGridMap: map
    })
    // 模拟写库层吞掉签名，读回仍无签名。
    mocks.ensureSongCacheEntry.mockImplementation(async () => {})
    const { persistEnergy, updates } = createPersistence()

    await persistEnergy(FILE_PATH, 55, 11, undefined, { sourceGridSignature: map.signature })

    expect(updates).toHaveLength(0)
    expect(mocks.logError).toHaveBeenCalled()
  })

  it('skips the write when the audio identity changed during analysis', async () => {
    const map = buildMap([128, 132])
    mocks.loadSharedSongGridDefinition.mockResolvedValue({
      filePath: FILE_PATH,
      beatGridMap: map
    })
    const { persistEnergy, updates } = createPersistence()

    await persistEnergy(FILE_PATH, 55, 11, undefined, {
      sourceGridSignature: map.signature,
      expectedAudioIdentity: { size: 100, mtimeMs: 199 }
    })

    expect(mocks.ensureSongCacheEntry).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
    expect(mocks.logError).toHaveBeenCalled()
  })
})
