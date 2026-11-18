import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ISongInfo } from '../../types/globals'

const mocks = vi.hoisted(() => ({
  getLocalFilePath: vi.fn(),
  getNeteaseRootDir: vi.fn(),
  loadSongCacheEntry: vi.fn(),
  discardStaleAnalysisFields: vi.fn(),
  stat: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  default: { stat: mocks.stat },
  stat: mocks.stat
}))

vi.mock('./library', () => ({
  getLocalFilePath: mocks.getLocalFilePath
}))

vi.mock('./paths', () => ({
  getNeteaseRootDir: mocks.getNeteaseRootDir
}))

vi.mock('../libraryCacheDb', () => ({
  loadSongCacheEntry: mocks.loadSongCacheEntry
}))

vi.mock('../services/scanSongs', () => ({
  discardStaleAnalysisFields: mocks.discardStaleAnalysisFields
}))

import { loadNeteaseAnalysisHydration, pickNeteaseAnalysisFields } from './analysisHydration'

const LIST_ROOT = 'E:/lib/library/NeteaseLibrary'
const LOCAL_PATH = 'E:/lib/library/NeteaseLibrary/.store/1901371647.flac'

const cachedInfo = {
  filePath: LOCAL_PATH,
  title: 'should not leak',
  artist: 'leak artist',
  key: '8A',
  bpm: 128,
  beatGridMap: { signature: 'grid-1' },
  energyScore: 7,
  songStructure: { version: 1 }
} as unknown as ISongInfo

describe('loadNeteaseAnalysisHydration', () => {
  beforeEach(() => {
    mocks.getLocalFilePath.mockReset()
    mocks.getNeteaseRootDir.mockReset().mockReturnValue(LIST_ROOT)
    mocks.loadSongCacheEntry.mockReset()
    mocks.discardStaleAnalysisFields.mockReset().mockImplementation((info: ISongInfo) => {
      const next = { ...info }
      delete (next as { bpm?: number }).bpm
      return next
    })
    mocks.stat.mockReset().mockResolvedValue({ size: 1000, mtimeMs: 50 })
  })

  it('returns analysis fields from the NeteaseLibrary cache and never copies title or filePath', async () => {
    mocks.loadSongCacheEntry.mockResolvedValue({
      size: 1000,
      mtimeMs: 50,
      info: cachedInfo
    })

    const items = await loadNeteaseAnalysisHydration([
      { songId: '1901371647', filePath: LOCAL_PATH }
    ])

    expect(items).toHaveLength(1)
    expect(items[0]?.songId).toBe('1901371647')
    expect(items[0]?.localPath).toBe(LOCAL_PATH)
    expect(items[0]?.listRoot).toBe(LIST_ROOT)
    expect(items[0]?.analysis).toMatchObject({
      key: '8A',
      beatGridMap: { signature: 'grid-1' },
      energyScore: 7
    })
    expect(items[0]?.analysis).not.toHaveProperty('filePath')
    expect(items[0]?.analysis).not.toHaveProperty('title')
    expect(items[0]?.analysis).not.toHaveProperty('artist')
    expect(items[0]?.analysis).not.toHaveProperty('bpm')
    expect(mocks.loadSongCacheEntry).toHaveBeenCalledWith(LIST_ROOT, LOCAL_PATH)
  })

  it('resolves a missing filePath through getLocalFilePath', async () => {
    mocks.getLocalFilePath.mockReturnValue(LOCAL_PATH)
    mocks.loadSongCacheEntry.mockResolvedValue({
      size: 1000,
      mtimeMs: 50,
      info: cachedInfo
    })

    const items = await loadNeteaseAnalysisHydration([{ songId: '1901371647' }])
    expect(mocks.getLocalFilePath).toHaveBeenCalledWith('1901371647')
    expect(items[0]?.analysis).toMatchObject({ key: '8A' })
  })

  it('returns localPath and listRoot but no analysis when the file has changed', async () => {
    mocks.loadSongCacheEntry.mockResolvedValue({
      size: 2000,
      mtimeMs: 99,
      info: cachedInfo
    })

    const items = await loadNeteaseAnalysisHydration([
      { songId: '1901371647', filePath: LOCAL_PATH }
    ])
    expect(items[0]).toEqual({
      songId: '1901371647',
      localPath: LOCAL_PATH,
      listRoot: LIST_ROOT,
      analysis: null
    })
  })

  it('skips tracks that have no local file', async () => {
    mocks.getLocalFilePath.mockReturnValue(null)
    await expect(loadNeteaseAnalysisHydration([{ songId: '1901371647' }])).resolves.toEqual([])
    expect(mocks.loadSongCacheEntry).not.toHaveBeenCalled()
  })
})

describe('pickNeteaseAnalysisFields', () => {
  it('returns null when no analysis fields are present', () => {
    expect(
      pickNeteaseAnalysisFields({
        filePath: LOCAL_PATH,
        title: 'Only metadata'
      } as ISongInfo)
    ).toBeNull()
  })
})
