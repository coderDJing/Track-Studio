import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  CURRENT_SONG_STRUCTURE_FORMAT_VERSION,
  type SongStructureAnalysis
} from '../../../shared/songStructure'
import { createSongBeatGridMapV2FromFixedGrid } from '../../../shared/songBeatGridMapV2'

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  findSongListRoot: vi.fn(),
  loadSongCacheEntry: vi.fn(),
  loadExternalAnalysisCacheEntry: vi.fn(),
  resolveExternalAnalysisContext: vi.fn(),
  upsertExternalAnalysisCacheEntry: vi.fn(),
  loadSharedSongGridDefinition: vi.fn(),
  logError: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  default: { stat: mocks.stat },
  stat: mocks.stat
}))

vi.mock('../cacheMaintenance', () => ({
  findSongListRoot: mocks.findSongListRoot
}))

vi.mock('../../libraryCacheDb', () => ({
  loadSongCacheEntry: mocks.loadSongCacheEntry,
  loadExternalAnalysisCacheEntry: mocks.loadExternalAnalysisCacheEntry,
  resolveExternalAnalysisContext: mocks.resolveExternalAnalysisContext,
  upsertExternalAnalysisCacheEntry: mocks.upsertExternalAnalysisCacheEntry
}))

vi.mock('../sharedSongGrid', () => ({
  loadSharedSongGridDefinition: mocks.loadSharedSongGridDefinition
}))

vi.mock('../../log', () => ({
  log: { error: mocks.logError }
}))

import { normalizePath } from './types'
import { createPersistSongStructure } from './structurePersistence'

const FILE_PATH = 'G:\\FRKB_database-A\\library\\FilterLibrary\\test.mp3'
const LIST_ROOT = 'G:\\FRKB_database-A'
const BEAT_GRID_MAP = createSongBeatGridMapV2FromFixedGrid({
  bpm: 128,
  firstBeatMs: 0,
  downbeatBeatOffset: 0,
  source: 'manual'
})!

const createStructure = (): SongStructureAnalysis => ({
  formatVersion: CURRENT_SONG_STRUCTURE_FORMAT_VERSION,
  algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  source: 'algorithmic',
  durationSec: 64,
  beatGridSignature: BEAT_GRID_MAP.signature,
  sections: [
    {
      startSec: 0,
      endSec: 64,
      startDownbeatOrdinal: 0,
      endDownbeatOrdinal: 32,
      kind: 'groove',
      confidence: 0.8,
      energy: 0.7,
      low: 0.7,
      high: 0.5,
      novelty: 0.2
    }
  ]
})

describe('createPersistSongStructure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stat.mockResolvedValue({ size: 100, mtimeMs: 200 })
    mocks.findSongListRoot.mockResolvedValue(LIST_ROOT)
    mocks.resolveExternalAnalysisContext.mockReturnValue(null)
    mocks.loadSharedSongGridDefinition.mockResolvedValue({
      filePath: FILE_PATH,
      beatGridMap: BEAT_GRID_MAP
    })
  })

  it('写库成功后即使任务被接管，也会广播当前网格对应的持久化结果', async () => {
    const structure = createStructure()
    let ownsJob = true
    let persistedStructure: SongStructureAnalysis | undefined
    const ensureSongCacheEntry = vi.fn(async (_root, _filePath, payload) => {
      persistedStructure = payload.songStructure ?? undefined
      ownsJob = false
    })
    mocks.loadSongCacheEntry.mockImplementation(async () => ({
      info: { songStructure: persistedStructure }
    }))
    const events = new EventEmitter()
    const updated: unknown[] = []
    events.on('structure-updated', (payload) => updated.push(payload))
    const doneByPath = new Map()
    const persistSongStructure = createPersistSongStructure({
      doneByPath,
      events,
      ensureSongCacheEntry,
      cleanupMissingPersistTarget: vi.fn(),
      isMissingFileError: () => false
    })

    await persistSongStructure(FILE_PATH, structure, { shouldPersist: () => ownsJob })

    expect(updated).toEqual([{ filePath: FILE_PATH, songStructure: structure }])
    expect(doneByPath.get(normalizePath(FILE_PATH))?.songStructure).toEqual(structure)
  })

  it('任务被接管且目标结果未真正写入时不会误广播', async () => {
    const structure = createStructure()
    let ownsJob = true
    const ensureSongCacheEntry = vi.fn(async () => {
      ownsJob = false
    })
    mocks.loadSongCacheEntry.mockResolvedValue({
      info: { songStructure: { ...structure, algorithmVersion: structure.algorithmVersion - 1 } }
    })
    const events = new EventEmitter()
    const updated: unknown[] = []
    events.on('structure-updated', (payload) => updated.push(payload))
    const persistSongStructure = createPersistSongStructure({
      doneByPath: new Map(),
      events,
      ensureSongCacheEntry,
      cleanupMissingPersistTarget: vi.fn(),
      isMissingFileError: () => false
    })

    await persistSongStructure(FILE_PATH, structure, { shouldPersist: () => ownsJob })

    expect(updated).toEqual([])
  })

  it('共享网格暂时不可读时将 worker 使用的网格与段落结果原子写入', async () => {
    const structure = createStructure()
    mocks.loadSharedSongGridDefinition
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ filePath: FILE_PATH, beatGridMap: BEAT_GRID_MAP })
    let persistedStructure: SongStructureAnalysis | undefined
    const ensureSongCacheEntry = vi.fn(async (_root, _filePath, payload) => {
      persistedStructure = payload.songStructure ?? undefined
    })
    mocks.loadSongCacheEntry.mockImplementation(async () => ({
      info: { songStructure: persistedStructure }
    }))
    const events = new EventEmitter()
    const updated: unknown[] = []
    events.on('structure-updated', (payload) => updated.push(payload))
    const persistSongStructure = createPersistSongStructure({
      doneByPath: new Map(),
      events,
      ensureSongCacheEntry,
      cleanupMissingPersistTarget: vi.fn(),
      isMissingFileError: () => false
    })

    await persistSongStructure(FILE_PATH, structure, { beatGridMap: BEAT_GRID_MAP })

    expect(ensureSongCacheEntry).toHaveBeenCalledWith(
      LIST_ROOT,
      FILE_PATH,
      expect.objectContaining({
        beatGridMap: BEAT_GRID_MAP,
        songStructure: structure
      }),
      expect.anything(),
      expect.anything()
    )
    expect(updated).toEqual([{ filePath: FILE_PATH, songStructure: structure }])
  })
})
