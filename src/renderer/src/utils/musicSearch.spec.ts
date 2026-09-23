import { describe, expect, it } from 'vitest'
import {
  buildMusicSearchQuery,
  createMusicSearchMenuItems,
  resolveMusicSearch,
  resolveMusicSearchMenuAction
} from './musicSearch'

describe('music search actions', () => {
  it('creates matching NetEase and Spotify menu trees', () => {
    const menus = createMusicSearchMenuItems()
    expect(menus.map((item) => item.menuName)).toEqual([
      'tracks.neteaseSearch',
      'tracks.spotifySearch'
    ])
    expect(menus[1]?.children?.map((item) => item.menuName)).toEqual([
      'tracks.spotifySearchTitleArtist',
      'tracks.spotifySearchTitle',
      'tracks.spotifySearchArtist',
      'tracks.spotifySearchAlbum'
    ])
  })

  it('builds a normalized title and artist query for Spotify', () => {
    expect(buildMusicSearchQuery('  Get   Lucky ', ' Daft Punk ')).toBe('Get Lucky Daft Punk')
    expect(
      resolveMusicSearchMenuAction('tracks.spotifySearchTitleArtist', {
        title: ' Get Lucky ',
        artist: 'Daft Punk'
      })
    ).toEqual({
      provider: 'spotify',
      query: 'Get Lucky Daft Punk',
      emptyMessageKey: 'tracks.musicSearchTitleArtistEmpty'
    })
  })

  it('returns the matching empty-field hint', () => {
    expect(resolveMusicSearch('spotify', 'album', { album: '  ' })).toEqual({
      provider: 'spotify',
      query: '',
      emptyMessageKey: 'tracks.musicSearchAlbumEmpty'
    })
  })
})
