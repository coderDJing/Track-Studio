import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ISongInfo } from '../../../types/globals'
import { createSongBeatGridMapV2FromFixedGrid } from '../../../shared/songBeatGridMapV2'
import { prepareExternalPlaybackPlaylistAnalysis } from './playlistAnalysis'

const mocked = vi.hoisted(() => ({
  cached: new Map<string, { info: Partial<ISongInfo>; hasWaveform: boolean }>(),
  enqueue: vi.fn(),
  upsert: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  default: { stat: vi.fn(async () => ({ size: 1024, mtimeMs: 1000 })) }
}))
vi.mock('../keyAnalysisQueue', () => ({ enqueueKeyAnalysisList: mocked.enqueue }))
vi.mock('../cacheMaintenance', () => ({ findSongListRoot: vi.fn(async () => null) }))
vi.mock('../songInfoLite', () => ({
  applyLiteDefaults: (info: unknown) => info,
  buildLiteSongInfo: (filePath: string) => ({ filePath })
}))
vi.mock('../../libraryCacheDb', () => ({
  touchExternalAnalysisDevice: vi.fn(),
  pruneStaleExternalAnalysisDevices: vi.fn(),
  pruneStaleExternalAnalysisCacheEntries: vi.fn(),
  registerExternalAnalysisContext: (context: { filePath: string }) => context,
  loadExternalAnalysisCacheEntry: async (context: { filePath: string }) =>
    mocked.cached.get(context.filePath),
  touchExternalAnalysisCacheEntrySeen: vi.fn(),
  upsertExternalAnalysisCacheEntry: mocked.upsert
}))

const createGrid = () => {
  const grid = createSongBeatGridMapV2FromFixedGrid({
    bpm: 128,
    firstBeatMs: 125,
    downbeatBeatOffset: 0,
    source: 'analysis'
  })
  if (!grid) throw new Error('grid fixture creation failed')
  return grid
}

beforeEach(() => {
  mocked.cached.clear()
  mocked.enqueue.mockClear()
  mocked.upsert.mockClear()
})

describe('external playback playlist analysis completeness', () => {
  it('counts three analyzed no-BPM songs without energy or structure as complete', async () => {
    const filePaths = Array.from({ length: 3 }, (_, index) => `C:/music/no-bpm-${index}.mp3`)
    for (const filePath of filePaths) {
      mocked.cached.set(filePath, {
        info: { filePath, key: '8A', beatGridStatus: 'no-bpm' },
        hasWaveform: true
      })
    }

    const result = await prepareExternalPlaybackPlaylistAnalysis({
      tracks: filePaths.map((filePath) => ({ filePath }))
    })

    expect(result.completeFilePaths).toEqual(filePaths)
    expect(result.queuedFilePaths).toEqual([])
    expect(result.registered).toBe(3)
    expect(mocked.enqueue).not.toHaveBeenCalled()
    expect(mocked.upsert).not.toHaveBeenCalled()
  })

  it('still queues missing independent results and requires energy for usable grids', async () => {
    const cases: Array<{
      filePath: string
      info: Partial<ISongInfo>
      hasWaveform: boolean
    }> = [
      {
        filePath: 'C:/music/no-bpm-missing-key.mp3',
        info: { beatGridStatus: 'no-bpm' },
        hasWaveform: true
      },
      {
        filePath: 'C:/music/no-bpm-missing-waveform.mp3',
        info: { key: '8A', beatGridStatus: 'no-bpm' },
        hasWaveform: false
      },
      {
        filePath: 'C:/music/grid-missing-energy.mp3',
        info: { key: '8A', beatGridMap: createGrid() },
        hasWaveform: true
      },
      {
        filePath: 'C:/music/grid-with-stray-no-bpm.mp3',
        info: { key: '8A', beatGridMap: createGrid(), beatGridStatus: 'no-bpm' },
        hasWaveform: true
      },
      {
        filePath: 'C:/music/missing-beat-grid.mp3',
        info: { key: '8A', energyScore: 70 },
        hasWaveform: true
      },
      {
        filePath: 'C:/music/complete-grid.mp3',
        info: { key: '8A', beatGridMap: createGrid(), energyScore: 70 },
        hasWaveform: true
      }
    ]
    for (const item of cases) {
      mocked.cached.set(item.filePath, {
        info: { ...item.info, filePath: item.filePath },
        hasWaveform: item.hasWaveform
      })
    }

    const result = await prepareExternalPlaybackPlaylistAnalysis({
      tracks: cases.map(({ filePath }) => ({ filePath }))
    })

    const pendingFilePaths = cases.slice(0, -1).map(({ filePath }) => filePath)
    expect(result.completeFilePaths).toEqual(['C:/music/complete-grid.mp3'])
    expect(result.queuedFilePaths).toEqual(pendingFilePaths)
    expect(mocked.enqueue).toHaveBeenCalledOnce()
    expect(mocked.enqueue).toHaveBeenCalledWith(pendingFilePaths, 'low', {
      source: 'foreground',
      preemptible: true,
      category: 'visible'
    })
  })
})
