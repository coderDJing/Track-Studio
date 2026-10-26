import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openPlaylistViewFast } from './playlistViewSnapshotService'

const mocks = vi.hoisted(() => ({ load: vi.fn(), scan: vi.fn() }))
vi.mock('../window/mainWindow', () => ({ default: { instance: null } }))
vi.mock('./songListScanWorker', () => ({
  onDeferredWaveformAvailability: vi.fn(),
  scanSongListOffMainThread: mocks.scan
}))
vi.mock('../libraryCacheDb/playlistViewSnapshot', () => ({
  loadPlaylistViewSnapshot: mocks.load,
  normalizeSnapshotListRoot: (value: string) => value.replace(/\\/g, '/').toLowerCase(),
  loadPlaylistViewSnapshotMeta: vi.fn(),
  findPlaylistViewSnapshotUuidsByRoot: vi.fn(),
  listPlaylistViewSnapshotVerificationCandidates: vi.fn(),
  savePlaylistViewSnapshot: vi.fn(),
  touchPlaylistViewSnapshotIdentity: vi.fn(),
  touchPlaylistViewSnapshotVerified: vi.fn(),
  updatePlaylistViewSnapshotMissingWaveformFilePaths: vi.fn()
}))

const listRoot = 'E:/FRKB_database/library/FilterLibrary/AI歌曲'
beforeEach(() => {
  vi.useFakeTimers()
  mocks.scan.mockReset()
  mocks.load.mockReturnValue({
    items: Array.from({ length: 1001 }, (_, index) => ({ filePath: `${listRoot}/${index}.wav` })),
    itemCount: 1001,
    listRoot,
    revision: 286,
    identityDigest: 'old-1001-track-digest',
    missingWaveformFilePaths: [],
    verifiedAtMs: 1
  })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('playlist snapshot count conflicts', () => {
  it('rejects a 1001-item snapshot for a known 1916-track directory without duplicating scans', () => {
    const result = openPlaylistViewFast({
      songListUUID: 'conflicting-playlist',
      songListPath: listRoot,
      expectedTrackCount: 1916
    })
    expect(result.hit).toBe(false)
    expect(result.items).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(mocks.scan).not.toHaveBeenCalled()
  })

  it.each([1001, undefined])(
    'keeps the fast path when the count is compatible (%s)',
    (expectedTrackCount) => {
      const result = openPlaylistViewFast({
        songListUUID: `compatible-playlist-${expectedTrackCount}`,
        songListPath: listRoot,
        expectedTrackCount
      })
      expect(result.hit).toBe(true)
      expect(result.items).toHaveLength(1001)
      expect(vi.getTimerCount()).toBe(1)
      expect(mocks.scan).not.toHaveBeenCalled()
    }
  )
})
