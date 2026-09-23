import type { ComputedRef, Ref, ShallowRef } from 'vue'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import type { ExternalLibraryKind } from '@shared/externalLibrary'
import type {
  IPioneerPlaylistTrack,
  IRekordboxSourceKind,
  ISongInfo
} from '../../../../../types/globals'

type UsePioneerPlaylistTracksParams = {
  selectedSourceCacheKey: ComputedRef<string>
  selectedPlaylistId: ComputedRef<number>
  selectedSourceKind: ComputedRef<IRekordboxSourceKind | ''>
  selectedExternalKind: ComputedRef<ExternalLibraryKind | null>
  selectedSourceRootPath: ComputedRef<string>
  selectedLibraryType: ComputedRef<string>
  originalTracks: ShallowRef<IPioneerPlaylistTrack[]>
  visibleSongs: Ref<ISongInfo[]>
  loading: Ref<boolean>
  selectedRowKeys: Ref<string[]>
  applyFiltersAndSorting: (reason?: string) => void
  isCurrentPlaylistLoadTarget: (sourceCacheKey: string, playlistId: number) => boolean
  emitPioneerSongsAreaLog: (event: string, payload?: Record<string, unknown>) => void
}

type FetchPlaylistTracksParams = {
  sourceCacheKey: string
  playlistId: number
  sourceKind: IRekordboxSourceKind
  externalKind: ExternalLibraryKind | null
  rootPath: string
  libraryType: string
}

const normalizePath = (value: unknown) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

const mergeRuntimeTrack = (
  current: IPioneerPlaylistTrack,
  next: IPioneerPlaylistTrack
): IPioneerPlaylistTrack => ({
  ...current,
  bpm: next.bpm ?? current.bpm,
  rekordboxGridEntries: next.rekordboxGridEntries ?? current.rekordboxGridEntries,
  beatGridMap: next.beatGridMap ?? current.beatGridMap,
  timeBasisOffsetMs: next.timeBasisOffsetMs ?? current.timeBasisOffsetMs,
  hotCues: next.hotCues ?? current.hotCues,
  memoryCues: next.memoryCues ?? current.memoryCues,
  fileMissing: next.fileMissing === true
})

const mergeRuntimeTracks = (
  currentTracks: IPioneerPlaylistTrack[],
  runtimeTracks: IPioneerPlaylistTrack[]
) => {
  if (!runtimeTracks.length) return currentTracks
  const runtimeByRowKey = new Map(
    runtimeTracks.map((track) => [String(track.rowKey || '').trim(), track] as const)
  )
  return currentTracks.map((track) => {
    const next = runtimeByRowKey.get(String(track.rowKey || '').trim())
    return next ? mergeRuntimeTrack(track, next) : track
  })
}

const patchSongInfoRuntime = (song: ISongInfo, track: IPioneerPlaylistTrack): ISongInfo => ({
  ...song,
  bpm: track.bpm ?? song.bpm,
  beatGridMap: track.beatGridMap ?? song.beatGridMap,
  rekordboxGridEntries: track.rekordboxGridEntries
    ? track.rekordboxGridEntries.map((entry) => ({ ...entry }))
    : song.rekordboxGridEntries,
  beatGridSource: track.beatGridMap ? 'rekordbox' : song.beatGridSource,
  timeBasisOffsetMs: track.timeBasisOffsetMs ?? song.timeBasisOffsetMs,
  hotCues: Array.isArray(track.hotCues) ? track.hotCues.map((cue) => ({ ...cue })) : song.hotCues,
  memoryCues: Array.isArray(track.memoryCues)
    ? track.memoryCues.map((cue) => ({ ...cue }))
    : song.memoryCues,
  fileMissing: track.fileMissing === true ? true : song.fileMissing
})

const matchRuntimeTrack = (
  song: ISongInfo,
  runtimeByRowKey: Map<string, IPioneerPlaylistTrack>,
  runtimeByFilePath: Map<string, IPioneerPlaylistTrack>
) => {
  const rowKey = String(song.mixtapeItemId || '').trim()
  if (rowKey) {
    const matched = runtimeByRowKey.get(rowKey)
    if (matched) return matched
  }
  const filePath = normalizePath(song.filePath)
  return filePath ? runtimeByFilePath.get(filePath) : undefined
}

const buildRuntimeLookups = (runtimeTracks: IPioneerPlaylistTrack[]) => {
  const runtimeByRowKey = new Map<string, IPioneerPlaylistTrack>()
  const runtimeByFilePath = new Map<string, IPioneerPlaylistTrack>()
  for (const track of runtimeTracks) {
    const rowKey = String(track.rowKey || '').trim()
    if (rowKey) runtimeByRowKey.set(rowKey, track)
    const filePath = normalizePath(track.filePath)
    if (filePath) runtimeByFilePath.set(filePath, track)
  }
  return { runtimeByRowKey, runtimeByFilePath }
}

const patchSongListRuntime = (songs: ISongInfo[], runtimeTracks: IPioneerPlaylistTrack[]) => {
  if (!songs.length || !runtimeTracks.length) return songs
  const { runtimeByRowKey, runtimeByFilePath } = buildRuntimeLookups(runtimeTracks)
  let touched = false
  const nextSongs = songs.map((song) => {
    const track = matchRuntimeTrack(song, runtimeByRowKey, runtimeByFilePath)
    if (!track) return song
    touched = true
    return patchSongInfoRuntime(song, track)
  })
  return touched ? nextSongs : songs
}

export const usePioneerPlaylistTracks = (params: UsePioneerPlaylistTracksParams) => {
  const runtime = useRuntimeStore()
  let playlistTracksRequestToken = 0

  const applyRuntimeTracks = (runtimeTracks: IPioneerPlaylistTrack[]) => {
    params.originalTracks.value = mergeRuntimeTracks(params.originalTracks.value, runtimeTracks)
    params.applyFiltersAndSorting('fetch-playlist-tracks-runtime')

    const { runtimeByRowKey, runtimeByFilePath } = buildRuntimeLookups(runtimeTracks)
    const playingSong = runtime.playingData.playingSong
    if (playingSong) {
      const matched = matchRuntimeTrack(playingSong, runtimeByRowKey, runtimeByFilePath)
      if (matched) {
        runtime.playingData.playingSong = patchSongInfoRuntime(playingSong, matched)
      }
    }
    runtime.playingData.playingSongListData = patchSongListRuntime(
      runtime.playingData.playingSongListData,
      runtimeTracks
    )
    const topSong = runtime.horizontalBrowseDecks.topSong
    if (topSong) {
      const matched = matchRuntimeTrack(topSong, runtimeByRowKey, runtimeByFilePath)
      if (matched) {
        runtime.horizontalBrowseDecks.topSong = patchSongInfoRuntime(topSong, matched)
      }
    }
    const bottomSong = runtime.horizontalBrowseDecks.bottomSong
    if (bottomSong) {
      const matched = matchRuntimeTrack(bottomSong, runtimeByRowKey, runtimeByFilePath)
      if (matched) {
        runtime.horizontalBrowseDecks.bottomSong = patchSongInfoRuntime(bottomSong, matched)
      }
    }
    runtime.horizontalBrowseDecks.topSongListData = patchSongListRuntime(
      runtime.horizontalBrowseDecks.topSongListData,
      runtimeTracks
    )
    runtime.horizontalBrowseDecks.bottomSongListData = patchSongListRuntime(
      runtime.horizontalBrowseDecks.bottomSongListData,
      runtimeTracks
    )

    const gridPayloads = runtimeTracks
      .filter((track) => track.beatGridMap || Number.isFinite(Number(track.timeBasisOffsetMs)))
      .map((track) => ({
        filePath: track.filePath,
        beatGridMap: track.beatGridMap,
        timeBasisOffsetMs: track.timeBasisOffsetMs,
        rekordboxGridEntries: track.rekordboxGridEntries,
        hotCues: track.hotCues,
        memoryCues: track.memoryCues,
        bpm: track.bpm,
        fileMissing: track.fileMissing
      }))
    if (gridPayloads.length) {
      emitter.emit('horizontalBrowse/shared-grid-batch-updated', gridPayloads)
    }
  }

  const fetchPlaylistTracks = async (fetchParams: FetchPlaylistTracksParams) => {
    const requestToken = ++playlistTracksRequestToken
    const { sourceCacheKey, playlistId, sourceKind, externalKind, rootPath, libraryType } =
      fetchParams

    try {
      params.emitPioneerSongsAreaLog('fetch-playlist-tracks-start', {
        requestToken,
        sourceCacheKey
      })
      const result = (
        externalKind
          ? await window.electron.ipcRenderer.invoke('external-library:load-playlist-tracks', {
              kind: externalKind,
              path: rootPath,
              playlistId
            })
          : sourceKind === 'desktop'
            ? await window.electron.ipcRenderer.invoke(
                buildRekordboxSourceChannel('desktop', 'load-playlist-tracks-meta'),
                playlistId
              )
            : await window.electron.ipcRenderer.invoke(
                buildRekordboxSourceChannel('usb', 'load-playlist-tracks-meta'),
                rootPath,
                playlistId,
                libraryType
              )
      ) as { tracks?: IPioneerPlaylistTrack[] }
      const tracks = Array.isArray(result?.tracks) ? result.tracks : []
      params.emitPioneerSongsAreaLog('fetch-playlist-tracks-success', {
        requestToken,
        returnedTrackCount: tracks.length,
        firstTracks: tracks.slice(0, 5).map((track: IPioneerPlaylistTrack) => ({
          rowKey: track.rowKey,
          title: track.title,
          filePath: track.filePath
        }))
      })

      if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
      if (requestToken !== playlistTracksRequestToken) return

      params.originalTracks.value = tracks
      params.applyFiltersAndSorting('fetch-playlist-tracks-success')
      params.loading.value = false

      if (!tracks.length || externalKind) return

      try {
        const runtimeResult = (
          sourceKind === 'desktop'
            ? await window.electron.ipcRenderer.invoke(
                buildRekordboxSourceChannel('desktop', 'attach-playlist-tracks-runtime'),
                tracks
              )
            : await window.electron.ipcRenderer.invoke(
                buildRekordboxSourceChannel('usb', 'attach-playlist-tracks-runtime'),
                rootPath,
                tracks
              )
        ) as { tracks?: IPioneerPlaylistTrack[] }
        if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
        if (requestToken !== playlistTracksRequestToken) return

        const runtimeTracks = Array.isArray(runtimeResult?.tracks) ? runtimeResult.tracks : []
        applyRuntimeTracks(runtimeTracks)
        params.emitPioneerSongsAreaLog('fetch-playlist-tracks-runtime-success', {
          requestToken,
          runtimeTrackCount: runtimeTracks.length
        })
      } catch (runtimeError) {
        if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
        if (requestToken !== playlistTracksRequestToken) return
        console.error('[pioneerSongsArea] attach playlist runtime failed', runtimeError)
        params.emitPioneerSongsAreaLog('fetch-playlist-tracks-runtime-failed', {
          requestToken,
          error: runtimeError
        })
      }
    } catch (error) {
      if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
      if (requestToken !== playlistTracksRequestToken) return

      console.error('[pioneerSongsArea] load playlist tracks failed', error)
      params.emitPioneerSongsAreaLog('fetch-playlist-tracks-failed', {
        requestToken,
        error
      })
      if (!params.originalTracks.value.length) {
        params.originalTracks.value = []
        params.visibleSongs.value = []
      }
    } finally {
      if (
        params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId) &&
        requestToken === playlistTracksRequestToken
      ) {
        params.loading.value = false
      }
    }
  }

  const loadPlaylistTracks = async () => {
    const sourceCacheKey = params.selectedSourceCacheKey.value
    const playlistId = params.selectedPlaylistId.value
    const sourceKind = params.selectedSourceKind.value || 'usb'
    const externalKind = params.selectedExternalKind.value
    const rootPath = params.selectedSourceRootPath.value
    const libraryType = params.selectedLibraryType.value

    if (!rootPath || !playlistId || !sourceCacheKey) {
      playlistTracksRequestToken += 1
      params.loading.value = false
      params.originalTracks.value = []
      params.visibleSongs.value = []
      params.selectedRowKeys.value = []
      params.emitPioneerSongsAreaLog('load-playlist-tracks-reset-empty-selection', {
        sourceCacheKey,
        rootPath,
        playlistId
      })
      return
    }

    params.selectedRowKeys.value = []
    params.emitPioneerSongsAreaLog('load-playlist-tracks-enter', {
      sourceCacheKey
    })
    params.loading.value = true
    params.originalTracks.value = []
    params.visibleSongs.value = []

    await fetchPlaylistTracks({
      sourceCacheKey,
      playlistId,
      sourceKind,
      externalKind,
      rootPath,
      libraryType
    })
  }

  return {
    loadPlaylistTracks
  }
}
