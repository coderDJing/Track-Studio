import { useRuntimeStore } from '@renderer/stores/runtime'
import type { ISongInfo } from 'src/types/globals'
import emitter from '@renderer/utils/mitt'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import {
  isCurrentRendererWindowsPathPlatform,
  normalizeFilePathForComparison
} from '@shared/filePathComparison'

type ExternalPlaylistMode = 'replace' | 'append'

const normalizePath = (path: string | null | undefined): string =>
  normalizeFilePathForComparison(path, isCurrentRendererWindowsPathPlatform())

const dedupeSongs = (songs: ISongInfo[]): ISongInfo[] => {
  const map = new Map<string, ISongInfo>()
  for (const item of songs) {
    if (!item || typeof item.filePath !== 'string') continue
    const key = normalizePath(item.filePath)
    if (!key) continue
    if (!map.has(key)) {
      map.set(key, { ...item })
    }
  }
  return Array.from(map.values())
}

const refreshSongsAreaIfActive = (mode: ExternalPlaylistMode, songs: ISongInfo[]) => {
  const runtime = useRuntimeStore()
  if (runtime.songsArea.songListUUID === EXTERNAL_PLAYLIST_UUID) {
    runtime.songsArea.selectedSongFilePath.length = 0
    emitter.emit('external-playlist/refresh', {
      mode,
      songs
    })
  } else {
    runtime.songsArea.songListUUID = EXTERNAL_PLAYLIST_UUID
  }
}

const syncPlayingQueueIfNeeded = (songs: ISongInfo[]) => {
  const runtime = useRuntimeStore()
  if (runtime.playingData.playingSongListUUID !== EXTERNAL_PLAYLIST_UUID) return
  runtime.playingData.playingSongListData = songs
  const current = runtime.playingData.playingSong
  if (!current) return
  const exists = songs.some(
    (song) => normalizePath(song.filePath) === normalizePath(current.filePath)
  )
  if (!exists) {
    runtime.playingData.playingSong = songs[0] ?? null
  }
}

const applyExternalSongs = (mode: ExternalPlaylistMode, songs: ISongInfo[]) => {
  const runtime = useRuntimeStore()
  const nextSongs = dedupeSongs(songs)
  runtime.externalPlaylist.songs = nextSongs

  if (nextSongs.length === 0) {
    const currentSelection = runtime.libraryAreaSelected as string
    if (currentSelection === 'ExternalPlaylist') {
      runtime.libraryAreaSelected = runtime.externalPlaylist.lastLibrarySelection || 'FilterLibrary'
      if (runtime.songsArea.songListUUID === EXTERNAL_PLAYLIST_UUID) {
        runtime.songsArea.songListUUID = ''
        runtime.songsArea.songInfoArr = []
        runtime.songsArea.totalSongCount = 0
        runtime.songsArea.selectedSongFilePath.length = 0
      }
    }
    return
  }

  const currentSelection = runtime.libraryAreaSelected as string
  if (currentSelection !== 'ExternalPlaylist') {
    runtime.externalPlaylist.lastLibrarySelection =
      currentSelection === 'FilterLibrary' ||
      currentSelection === 'CuratedLibrary' ||
      currentSelection === 'MixtapeLibrary' ||
      currentSelection === 'RecycleBin' ||
      currentSelection === 'RecordingLibrary'
        ? (currentSelection as typeof runtime.externalPlaylist.lastLibrarySelection)
        : 'FilterLibrary'
    runtime.libraryAreaSelected = 'ExternalPlaylist'
  }

  refreshSongsAreaIfActive(mode, nextSongs)
  syncPlayingQueueIfNeeded(nextSongs)
}

const invokeScan = async (paths: string[]): Promise<ISongInfo[]> => {
  const uniquePaths = Array.from(
    new Set(
      paths
        .filter((p) => typeof p === 'string' && p.trim().length)
        .map((p) => p.replace(/^"+|"+$/g, ''))
    )
  )
  if (uniquePaths.length === 0) return []
  try {
    const result = await window.electron.ipcRenderer.invoke('externalPlaylist:scan', uniquePaths)
    const scanData = Array.isArray(result?.scanData) ? (result.scanData as ISongInfo[]) : []
    return dedupeSongs(scanData)
  } catch (error) {
    console.error('[externalPlaylist] failed to scan external files', error)
    return []
  }
}

export const replaceExternalPlaylistFromPaths = async (paths: string[]): Promise<ISongInfo[]> => {
  const songs = await invokeScan(paths)
  applyExternalSongs('replace', songs)
  return songs
}

export const appendExternalPlaylistFromPaths = async (paths: string[]): Promise<ISongInfo[]> => {
  const runtime = useRuntimeStore()
  const songs = await invokeScan(paths)
  if (songs.length === 0) return []
  const merged = [...runtime.externalPlaylist.songs, ...songs]
  applyExternalSongs(runtime.externalPlaylist.songs.length ? 'append' : 'replace', merged)
  return songs
}
