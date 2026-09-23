import type { IMenu } from '../../../types/globals'
import { normalizeSpotifySearchQuery } from '@shared/spotifySearch'

export type MusicSearchProvider = 'netease' | 'spotify'
export type MusicSearchMode = 'titleArtist' | 'title' | 'artist' | 'album'

type MusicSearchTrack = {
  title?: string | null
  artist?: string | null
  album?: string | null
}

type MusicSearchResolution = {
  provider: MusicSearchProvider
  query: string
  emptyMessageKey: string
}

const SEARCH_MENU_NAMES: Record<
  MusicSearchProvider,
  { root: string; modes: Record<MusicSearchMode, string> }
> = {
  netease: {
    root: 'tracks.neteaseSearch',
    modes: {
      titleArtist: 'tracks.neteaseSearchTitleArtist',
      title: 'tracks.neteaseSearchTitle',
      artist: 'tracks.neteaseSearchArtist',
      album: 'tracks.neteaseSearchAlbum'
    }
  },
  spotify: {
    root: 'tracks.spotifySearch',
    modes: {
      titleArtist: 'tracks.spotifySearchTitleArtist',
      title: 'tracks.spotifySearchTitle',
      artist: 'tracks.spotifySearchArtist',
      album: 'tracks.spotifySearchAlbum'
    }
  }
}

const EMPTY_MESSAGE_KEYS: Record<MusicSearchMode, string> = {
  titleArtist: 'tracks.musicSearchTitleArtistEmpty',
  title: 'tracks.musicSearchTitleEmpty',
  artist: 'tracks.musicSearchArtistEmpty',
  album: 'tracks.musicSearchAlbumEmpty'
}

const MENU_ACTIONS: Record<string, { provider: MusicSearchProvider; mode: MusicSearchMode }> =
  Object.fromEntries(
    (
      Object.entries(SEARCH_MENU_NAMES) as Array<
        [MusicSearchProvider, (typeof SEARCH_MENU_NAMES)[MusicSearchProvider]]
      >
    ).flatMap(([provider, names]) =>
      (Object.entries(names.modes) as Array<[MusicSearchMode, string]>).map(([mode, menuName]) => [
        menuName,
        { provider, mode }
      ])
    )
  )

export const normalizeMusicSearchText = (value: string | undefined | null): string =>
  normalizeSpotifySearchQuery(value)

export const buildMusicSearchQuery = (...values: Array<string | undefined | null>): string =>
  values.map(normalizeMusicSearchText).filter(Boolean).join(' ')

export const resolveMusicSearch = (
  provider: MusicSearchProvider,
  mode: MusicSearchMode,
  track: MusicSearchTrack
): MusicSearchResolution => {
  const title = normalizeMusicSearchText(track.title)
  const artist = normalizeMusicSearchText(track.artist)
  const album = normalizeMusicSearchText(track.album)
  const query =
    mode === 'titleArtist'
      ? buildMusicSearchQuery(title, artist)
      : mode === 'title'
        ? title
        : mode === 'artist'
          ? artist
          : album
  return { provider, query, emptyMessageKey: EMPTY_MESSAGE_KEYS[mode] }
}

export const resolveMusicSearchMenuAction = (
  menuName: string,
  track: MusicSearchTrack
): MusicSearchResolution | null => {
  const action = MENU_ACTIONS[menuName]
  return action ? resolveMusicSearch(action.provider, action.mode, track) : null
}

export const createMusicSearchMenuItems = (): IMenu[] =>
  (
    Object.entries(SEARCH_MENU_NAMES) as Array<
      [MusicSearchProvider, (typeof SEARCH_MENU_NAMES)[MusicSearchProvider]]
    >
  ).map(([, names]) => ({
    menuName: names.root,
    children: [
      { menuName: names.modes.titleArtist },
      { menuName: names.modes.title },
      { menuName: names.modes.artist },
      { menuName: names.modes.album }
    ]
  }))

const isSuccessfulOpenResult = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false
  return (value as Record<string, unknown>).success === true
}

export const openMusicSearch = async (
  provider: MusicSearchProvider,
  rawQuery: string
): Promise<boolean> => {
  const query = normalizeMusicSearchText(rawQuery)
  if (!query) return false
  if (provider === 'netease') {
    const url = `https://music.163.com/#/search/m/?s=${encodeURIComponent(query)}&type=1`
    window.electron.ipcRenderer.send('openLocalBrowser', url)
    return true
  }

  try {
    const result: unknown = await window.electron.ipcRenderer.invoke('spotify:search', query)
    return isSuccessfulOpenResult(result)
  } catch (error) {
    console.error('[spotify-search] failed to request Spotify search', error)
    return false
  }
}

export const getMusicSearchOpenFailedMessageKey = (provider: MusicSearchProvider): string =>
  provider === 'spotify' ? 'tracks.spotifySearchOpenFailed' : 'tracks.neteaseSearchOpenFailed'
