// Run: pnpm exec vitest run src/main/netease/importAnalysisTransfer.spec.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'node:path'

const findSongListRoot = vi.fn()
const transferTrackCaches = vi.fn()
const logWarn = vi.fn()

vi.mock('../log', () => ({
  log: { warn: (...args: unknown[]) => logWarn(...args), error: vi.fn(), info: vi.fn() }
}))

vi.mock('../services/cacheMaintenance', () => ({
  findSongListRoot: (...args: unknown[]) => findSongListRoot(...args),
  transferTrackCaches: (...args: unknown[]) => transferTrackCaches(...args)
}))

import { transferCopiedTrackAnalysisCaches } from './importAnalysisTransfer'

describe('transferCopiedTrackAnalysisCaches', () => {
  beforeEach(() => {
    findSongListRoot.mockReset()
    transferTrackCaches.mockReset()
    logWarn.mockReset()
    findSongListRoot.mockImplementation(async (dir: string) => dir)
    transferTrackCaches.mockResolvedValue(undefined)
  })

  it('copies analysis caches with mode copy for each successful pair', async () => {
    const sourcePath = path.join('library', 'NeteaseLibrary', '.store', '1.flac')
    const destPath = path.join('library', 'FilterLibrary', 'List', 'Artist - Title.flac')
    const result = await transferCopiedTrackAnalysisCaches([
      { sourcePath, destPath },
      { sourcePath: '', destPath }
    ])
    expect(result).toEqual({ attempted: 1, failed: 0 })
    expect(transferTrackCaches).toHaveBeenCalledTimes(1)
    expect(transferTrackCaches).toHaveBeenCalledWith({
      fromRoot: path.dirname(sourcePath),
      toRoot: path.dirname(destPath),
      fromPath: sourcePath,
      toPath: destPath,
      mode: 'copy'
    })
  })

  it('skips a pair and continues when transfer throws', async () => {
    transferTrackCaches.mockRejectedValueOnce(new Error('stat mismatch'))
    transferTrackCaches.mockResolvedValueOnce(undefined)
    const result = await transferCopiedTrackAnalysisCaches([
      { sourcePath: 'a.flac', destPath: 'b.flac' },
      { sourcePath: 'c.flac', destPath: 'd.flac' }
    ])
    expect(result).toEqual({ attempted: 2, failed: 1 })
    expect(transferTrackCaches).toHaveBeenCalledTimes(2)
    expect(logWarn).toHaveBeenCalled()
  })
})
