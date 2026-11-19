// Run: pnpm exec vitest run src/shared/netease.spec.ts
import { describe, expect, it } from 'vitest'
import {
  buildNeteasePendingPath,
  isNeteasePendingPath,
  parseNeteasePendingSongId,
  parseNeteaseSongId,
  parseNeteaseSongIdFromStorePath,
  collectNeteaseSongPathAliases,
  neteaseSongMatchesPath,
  isNeteasePreviewUrl,
  canEditNeteasePlaylistTracks,
  createNeteaseOpenPlaylistRemovalPayload,
  isNeteaseLibraryIconVisible,
  NETEASE_PLAYLIST_PREFIX,
  buildNeteasePreviewUrl
} from './netease'

describe('netease pending path', () => {
  it('用没有斜杠的占位路径表示待下载的 SET 条目，避免被当成磁盘路径', () => {
    expect(buildNeteasePendingPath('1901371647')).toBe('netease-pending:1901371647')
    expect(isNeteasePendingPath('netease-pending:1901371647')).toBe(true)
    expect(parseNeteasePendingSongId('netease-pending:1901371647')).toBe('1901371647')
    expect(isNeteasePendingPath('frkb-preview://?netease=1901371647')).toBe(false)
    expect(isNeteasePreviewUrl('netease-pending:1901371647')).toBe(false)
    expect(parseNeteaseSongId('netease-pending:1901371647')).toBeNull()
    expect(parseNeteasePendingSongId('')).toBeNull()
  })
})

describe('netease preview url', () => {
  it('new URLs include a host, and old host-less URLs still parse', () => {
    expect(isNeteasePreviewUrl('frkb-preview://netease/?netease=1901371647')).toBe(true)
    expect(isNeteasePreviewUrl('frkb-preview://?netease=1901371647')).toBe(true)
    expect(parseNeteaseSongId('frkb-preview://netease/?netease=1901371647')).toBe('1901371647')
    expect(parseNeteaseSongId('frkb-preview://?netease=1901371647')).toBe('1901371647')
    expect(isNeteasePreviewUrl('frkb-preview://local/?path=D%3A%2Fmusic%2Fa.wav')).toBe(false)
  })
})

describe('canEditNeteasePlaylistTracks', () => {
  it('only allows liked and created playlists', () => {
    expect(canEditNeteasePlaylistTracks('liked')).toBe(true)
    expect(canEditNeteasePlaylistTracks('created')).toBe(true)
    expect(canEditNeteasePlaylistTracks('subscribed')).toBe(false)
    expect(canEditNeteasePlaylistTracks('album')).toBe(false)
    expect(canEditNeteasePlaylistTracks('')).toBe(false)
    expect(canEditNeteasePlaylistTracks(undefined)).toBe(false)
  })
})

describe('createNeteaseOpenPlaylistRemovalPayload', () => {
  it('uses playlist uuid and the same preview URLs as the open song list rows', () => {
    const payload = createNeteaseOpenPlaylistRemovalPayload('123456', [
      '1901371647',
      ' 1901371647 ',
      '',
      '99'
    ])
    expect(payload.listUUID).toBe(`${NETEASE_PLAYLIST_PREFIX}123456`)
    expect(payload.paths).toEqual([
      buildNeteasePreviewUrl('1901371647'),
      buildNeteasePreviewUrl('99')
    ])
    expect(payload.paths[0]).toBe('frkb-preview://netease/?netease=1901371647')
  })

  it('returns no paths when there are no song ids', () => {
    expect(createNeteaseOpenPlaylistRemovalPayload('123456', [])).toEqual({
      listUUID: `${NETEASE_PLAYLIST_PREFIX}123456`,
      paths: []
    })
  })
})

describe('isNeteaseLibraryIconVisible', () => {
  it('treats a missing setting as visible so older configs keep the icon', () => {
    expect(isNeteaseLibraryIconVisible(undefined)).toBe(true)
    expect(isNeteaseLibraryIconVisible({})).toBe(true)
    expect(isNeteaseLibraryIconVisible({ showNeteaseLibraryIcon: true })).toBe(true)
    expect(isNeteaseLibraryIconVisible({ showNeteaseLibraryIcon: false })).toBe(false)
  })
})

describe('parseNeteaseSongIdFromStorePath', () => {
  it('reads the song id from a NeteaseLibrary .store path on either slash style', () => {
    expect(
      parseNeteaseSongIdFromStorePath('E:/lib/library/NeteaseLibrary/.store/1901371647.flac')
    ).toBe('1901371647')
    expect(
      parseNeteaseSongIdFromStorePath('E:\\lib\\library\\NeteaseLibrary\\.store\\1901371647.flac')
    ).toBe('1901371647')
    expect(parseNeteaseSongIdFromStorePath('.store/99.mp3')).toBe('99')
    expect(
      parseNeteaseSongIdFromStorePath('E:/lib/library/NeteaseLibrary/.preview-cache/1.flac')
    ).toBeNull()
    expect(
      parseNeteaseSongIdFromStorePath('E:/lib/library/NeteaseLibrary/.store/../escape.flac')
    ).toBeNull()
  })
})

describe('neteaseSongMatchesPath', () => {
  const preview = buildNeteasePreviewUrl('1901371647')
  const localPath = 'E:/lib/library/NeteaseLibrary/.store/1901371647.flac'
  const song = { filePath: preview, neteaseSongId: '1901371647', neteaseLocalPath: localPath }

  it('matches preview URL, .store path, and song id even when only one alias is present', () => {
    expect(neteaseSongMatchesPath(song, preview)).toBe(true)
    expect(neteaseSongMatchesPath(song, localPath)).toBe(true)
    expect(
      neteaseSongMatchesPath({ filePath: preview, neteaseSongId: '1901371647' }, localPath)
    ).toBe(true)
    expect(neteaseSongMatchesPath(song, buildNeteasePreviewUrl('99'))).toBe(false)
    expect(collectNeteaseSongPathAliases(song)).toEqual(
      expect.arrayContaining([preview, localPath])
    )
  })
})
