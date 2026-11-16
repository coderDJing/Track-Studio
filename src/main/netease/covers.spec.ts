import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isNeteaseRemoteCoverPath,
  resolveNeteaseCoverSongId,
  songIdFromStoreFilePath,
  toParametrizedCoverUrl
} from './coverHelpers'

describe('netease cover helpers', () => {
  it('recognizes preview and pending paths as remote-cover sources', () => {
    expect(isNeteaseRemoteCoverPath('frkb-preview://netease/?netease=1901371647')).toBe(true)
    expect(isNeteaseRemoteCoverPath('frkb-preview://?netease=1901371647')).toBe(true)
    expect(isNeteaseRemoteCoverPath('netease-pending:1901371647')).toBe(true)
    expect(isNeteaseRemoteCoverPath('D:/music/local.flac')).toBe(false)
  })

  it('parses song ids from preview, pending, and store file names', () => {
    expect(resolveNeteaseCoverSongId('frkb-preview://netease/?netease=1901371647')).toBe(
      '1901371647'
    )
    expect(resolveNeteaseCoverSongId('frkb-preview://?netease=1901371647')).toBe('1901371647')
    expect(resolveNeteaseCoverSongId('netease-pending:1901371647')).toBe('1901371647')
    const storeDir = path.resolve('E:/lib/library/NeteaseLibrary/.store')
    expect(songIdFromStoreFilePath(path.join(storeDir, '1901371647.flac'), storeDir)).toBe(
      '1901371647'
    )
    expect(songIdFromStoreFilePath(path.join(storeDir, '../escape.flac'), storeDir)).toBeNull()
    expect(resolveNeteaseCoverSongId('D:/music/local.flac')).toBeNull()
  })

  it('adds a thumbnail size param to http cover urls', () => {
    expect(toParametrizedCoverUrl('https://p1.music.126.net/abc.jpg', 400)).toBe(
      'https://p1.music.126.net/abc.jpg?param=400y400'
    )
    expect(toParametrizedCoverUrl('not-a-url', 400)).toBe('not-a-url')
  })
})
