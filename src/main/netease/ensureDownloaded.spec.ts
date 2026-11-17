// Run: pnpm exec vitest run src/main/netease/ensureDownloaded.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  downloadTrack: vi.fn(),
  getTrackMeta: vi.fn()
}))

vi.mock('./library', () => ({
  downloadTrack: mocks.downloadTrack,
  getTrackMeta: mocks.getTrackMeta
}))

import {
  ensureTracksDownloaded,
  resetEnsureTracksDownloadedForTests,
  stableNeteaseDownloadProgressId
} from './ensureDownloaded'

describe('stableNeteaseDownloadProgressId', () => {
  it('uses a stable per-song id, independent of order or duplicates', () => {
    expect(stableNeteaseDownloadProgressId(['2079830421'])).toBe('netease_download_2079830421')
    expect(stableNeteaseDownloadProgressId(['b', 'a', 'b'])).toBe('netease_download_batch_a_b')
  })
})

describe('ensureTracksDownloaded', () => {
  beforeEach(() => {
    resetEnsureTracksDownloadedForTests()
    mocks.downloadTrack.mockReset()
    mocks.getTrackMeta.mockReset()
    mocks.getTrackMeta.mockImplementation((songId: string) => ({
      title: `title-${songId}`,
      artist: `artist-${songId}`
    }))
  })

  afterEach(() => {
    resetEnsureTracksDownloadedForTests()
  })

  it('coalesces concurrent downloads of the same songs onto one progress bar', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.downloadTrack.mockImplementation(async (songId: string) => {
      await gate
      return { filePath: `E:/store/${songId}.flac` }
    })

    const progress: Array<Record<string, unknown>> = []
    const sendProgress = (payload: Record<string, unknown>) => {
      progress.push({ ...payload })
    }

    const first = ensureTracksDownloaded(['2079830421'], 'lossless', undefined, sendProgress)
    const second = ensureTracksDownloaded(['2079830421'], 'lossless', undefined, sendProgress)
    expect(mocks.downloadTrack).toHaveBeenCalledTimes(1)

    release?.()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(firstResult.items).toEqual([
      {
        songId: '2079830421',
        filePath: 'E:/store/2079830421.flac',
        title: 'title-2079830421',
        artist: 'artist-2079830421'
      }
    ])
    expect(mocks.downloadTrack).toHaveBeenCalledTimes(1)

    const ids = new Set(progress.map((item) => item.id))
    expect([...ids]).toEqual(['netease_download_2079830421'])
    expect(progress.filter((item) => item.dismiss === true)).toHaveLength(1)
  })

  it('keeps the first-seen song order in the result', async () => {
    mocks.downloadTrack.mockImplementation(async (songId: string) => ({
      filePath: `E:/store/${songId}.flac`
    }))
    const result = await ensureTracksDownloaded(['2', '1', '2'], 'lossless')
    expect(result.items.map((item) => item.songId)).toEqual(['2', '1'])
  })

  it('keeps separate progress bars for different song batches', async () => {
    mocks.downloadTrack.mockImplementation(async (songId: string) => ({
      filePath: `E:/store/${songId}.flac`
    }))
    const progress: Array<Record<string, unknown>> = []
    await Promise.all([
      ensureTracksDownloaded(['1'], 'lossless', undefined, (payload) =>
        progress.push({ ...payload })
      ),
      ensureTracksDownloaded(['2'], 'lossless', undefined, (payload) =>
        progress.push({ ...payload })
      )
    ])
    expect(mocks.downloadTrack).toHaveBeenCalledTimes(2)
    expect(new Set(progress.map((item) => item.id))).toEqual(
      new Set(['netease_download_1', 'netease_download_2'])
    )
  })
})
