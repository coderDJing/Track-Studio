import { describe, expect, it } from 'vitest'
import { NETEASE_DOWNLOADED_UUID, NETEASE_PLAYLIST_PREFIX } from '@shared/netease'
import {
  isNeteaseStoreCopyOnlySource,
  resolveLibraryTransferActionModeForSongList
} from './libraryTransfer'

describe('isNeteaseStoreCopyOnlySource', () => {
  it('treats the downloaded view as copy-only', () => {
    expect(isNeteaseStoreCopyOnlySource(NETEASE_DOWNLOADED_UUID)).toBe(true)
    expect(resolveLibraryTransferActionModeForSongList(NETEASE_DOWNLOADED_UUID)).toBe('copy')
  })

  it('treats netease playlists as copy-only', () => {
    expect(resolveLibraryTransferActionModeForSongList(`${NETEASE_PLAYLIST_PREFIX}123`)).toBe(
      'copy'
    )
  })

  it('does not treat ordinary lists as copy-only by uuid alone', () => {
    expect(isNeteaseStoreCopyOnlySource('some-playlist-uuid')).toBe(false)
    expect(isNeteaseStoreCopyOnlySource('')).toBe(false)
  })
})
