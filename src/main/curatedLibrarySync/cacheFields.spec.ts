import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findSongListRootByPath: vi.fn(),
  loadSongCache: vi.fn(),
  loadSongCacheEntry: vi.fn()
}))

vi.mock('../libraryTreeDb', () => ({
  findSongListRootByPath: mocks.findSongListRootByPath
}))

vi.mock('../libraryCacheDb', () => ({
  loadSongCache: mocks.loadSongCache,
  loadSongCacheEntry: mocks.loadSongCacheEntry
}))

import { readCacheFieldsBatch } from './cacheFields'

describe('readCacheFieldsBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('同一歌单只整批读取一次缓存', async () => {
    const listRoot = path.resolve('test-library', 'list-a')
    const first = path.join(listRoot, 'a.mp3')
    const second = path.join(listRoot, 'b.mp3')
    mocks.findSongListRootByPath.mockResolvedValue(listRoot)
    mocks.loadSongCache.mockResolvedValue(
      new Map([
        [
          first,
          {
            size: 1,
            mtimeMs: 1,
            info: { filePath: first, playlistTrackNumber: 2, addedAtMs: 10 }
          }
        ],
        [
          second,
          {
            size: 1,
            mtimeMs: 1,
            info: { filePath: second, playlistTrackNumber: 1, addedAtMs: 20 }
          }
        ]
      ])
    )

    const result = await readCacheFieldsBatch([first, second])

    expect(mocks.findSongListRootByPath).toHaveBeenCalledTimes(1)
    expect(mocks.loadSongCache).toHaveBeenCalledTimes(1)
    expect(mocks.loadSongCacheEntry).not.toHaveBeenCalled()
    expect(result.get(first)).toEqual({ trackNumber: 2, addedAtMs: 10 })
    expect(result.get(second)).toEqual({ trackNumber: 1, addedAtMs: 20 })
  })
})
