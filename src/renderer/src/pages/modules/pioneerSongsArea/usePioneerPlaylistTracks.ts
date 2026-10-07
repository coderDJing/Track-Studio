import type { ComputedRef, Ref, ShallowRef } from 'vue'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import {
  getCachedRekordboxPlaylistTracks,
  setCachedRekordboxPlaylistTracks
} from '@renderer/utils/rekordboxLibraryCache'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import {
  createSongListItemComparator,
  type SongListItemComparator
} from '@shared/songListItemCompare'
import type { ExternalLibraryKind } from '@shared/externalLibrary'
import type {
  IPioneerPlaylistTrack,
  IRekordboxSourceKind,
  ISongInfo
} from '../../../../../types/globals'

type UsePioneerPlaylistTracksParams = {
  selectedSourceCacheKey: ComputedRef<string>
  currentPlaybackListKey?: ComputedRef<string>
  selectedPlaylistId: ComputedRef<number>
  selectedSourceKind: ComputedRef<IRekordboxSourceKind | ''>
  selectedExternalKind: ComputedRef<ExternalLibraryKind | null>
  selectedSourceRootPath: ComputedRef<string>
  selectedLibraryType: ComputedRef<string>
  originalTracks: ShallowRef<IPioneerPlaylistTrack[]>
  visibleSongs: Ref<ISongInfo[]>
  loading: Ref<boolean>
  selectedRowKeys: Ref<string[]>
  applyFiltersAndSorting: (reason?: string) => void | Promise<void>
  applyFiltersAndSortingMerged?: (tracks: IPioneerPlaylistTrack[]) => Promise<boolean>
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
  revision?: string
  preserveVisible?: boolean
}

const normalizePath = (value: unknown) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

const mergeRuntimeTrack = (
  current: IPioneerPlaylistTrack,
  next: IPioneerPlaylistTrack
): IPioneerPlaylistTrack => {
  const merged = {
    ...current,
    bpm: next.bpm ?? current.bpm,
    rekordboxGridEntries: next.rekordboxGridEntries ?? current.rekordboxGridEntries,
    beatGridMap: next.beatGridMap ?? current.beatGridMap,
    timeBasisOffsetMs: next.timeBasisOffsetMs ?? current.timeBasisOffsetMs,
    hotCues: next.hotCues ?? current.hotCues,
    memoryCues: next.memoryCues ?? current.memoryCues,
    fileMissing: next.fileMissing ?? current.fileMissing
  }
  return JSON.stringify(current) === JSON.stringify(merged) ? current : merged
}

const mergeRuntimeTracks = (
  currentTracks: IPioneerPlaylistTrack[],
  runtimeTracks: IPioneerPlaylistTrack[]
) => {
  if (!runtimeTracks.length) return currentTracks
  const runtimeByRowKey = new Map(
    runtimeTracks.map((track) => [String(track.rowKey || '').trim(), track] as const)
  )
  const merged = currentTracks.map((track) => {
    const next = runtimeByRowKey.get(String(track.rowKey || '').trim())
    return next ? mergeRuntimeTrack(track, next) : track
  })
  return merged.every((track, index) => track === currentTracks[index]) ? currentTracks : merged
}

const patchSongInfoRuntime = (
  song: ISongInfo,
  track: IPioneerPlaylistTrack,
  updateIdentity = false
): ISongInfo => ({
  ...song,
  mixtapeItemId: updateIdentity ? track.rowKey : song.mixtapeItemId,
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

const patchSongListRuntime = (
  songs: ISongInfo[],
  runtimeTracks: IPioneerPlaylistTrack[],
  comparator: SongListItemComparator,
  updateIdentity = false
) => {
  if (!songs.length || !runtimeTracks.length) return songs
  const { runtimeByRowKey, runtimeByFilePath } = buildRuntimeLookups(runtimeTracks)
  let touched = false
  const nextSongs = songs.map((song) => {
    const track = matchRuntimeTrack(song, runtimeByRowKey, runtimeByFilePath)
    if (!track) return song
    const patched = patchSongInfoRuntime(song, track, updateIdentity)
    if (comparator.isEquivalentSongInfo(song, patched)) return song
    touched = true
    return patched
  })
  return touched ? nextSongs : songs
}

export const usePioneerPlaylistTracks = (params: UsePioneerPlaylistTracksParams) => {
  const runtime = useRuntimeStore()
  let playlistTracksRequestToken = 0
  let displayedSourceCacheKey = ''
  let displayedPlaylistId = 0
  let loadInFlight: Promise<void> | null = null
  let loadAgain = false

  const readSourceRevision = async (
    sourceKind: IRekordboxSourceKind,
    externalKind: ExternalLibraryKind | null,
    rootPath: string
  ): Promise<string | undefined> => {
    if (!externalKind && sourceKind !== 'desktop') return undefined
    const result = (
      externalKind
        ? await window.electron.ipcRenderer.invoke('external-library:source-revision', {
            kind: externalKind,
            path: rootPath
          })
        : await window.electron.ipcRenderer.invoke(
            buildRekordboxSourceChannel('desktop', 'source-revision')
          )
    ) as { revision?: string }
    const revision = String(result?.revision || '')
    if (!revision) throw new Error('DJ 曲库文件版本为空。')
    return revision
  }

  let refreshRequested = false

  const applyRuntimeTracks = async (
    runtimeTracks: IPioneerPlaylistTrack[],
    metadataChanged = false
  ) => {
    const playbackListKey = params.currentPlaybackListKey?.value || ''
    const merged = mergeRuntimeTracks(params.originalTracks.value, runtimeTracks)
    const { runtimeByRowKey, runtimeByFilePath } = buildRuntimeLookups(runtimeTracks)
    const identityChanged = [
      ...(runtime.playingData.playingSongListUUID === playbackListKey
        ? [runtime.playingData.playingSong]
        : []),
      ...(runtime.horizontalBrowseDecks.topSongListUUID === playbackListKey
        ? [runtime.horizontalBrowseDecks.topSong, ...runtime.horizontalBrowseDecks.topSongListData]
        : []),
      ...(runtime.horizontalBrowseDecks.bottomSongListUUID === playbackListKey
        ? [
            runtime.horizontalBrowseDecks.bottomSong,
            ...runtime.horizontalBrowseDecks.bottomSongListData
          ]
        : [])
    ].some((song) => {
      if (!song?.externalSourceKind) return false
      const track = matchRuntimeTrack(song, runtimeByRowKey, runtimeByFilePath)
      return track && song.mixtapeItemId !== track.rowKey
    })
    const tracksChanged = merged !== params.originalTracks.value
    // Desktop SQL cues may already have changed in the metadata merge; update loaded
    // decks as well even when the reused runtime grid itself did not change.
    if (!tracksChanged && !identityChanged && !metadataChanged) return
    if (tracksChanged) {
      params.originalTracks.value = merged
      await params.applyFiltersAndSorting('fetch-playlist-tracks-runtime')
      if (playbackListKey !== (params.currentPlaybackListKey?.value || '')) return
    }
    const comparator = createSongListItemComparator({
      caseInsensitiveFileName: runtime.setting.platform === 'win32',
      caseInsensitiveFilePath: runtime.setting.platform === 'win32'
    })
    const patchSong = (song: ISongInfo, track: IPioneerPlaylistTrack, updateIdentity: boolean) => {
      const next = patchSongInfoRuntime(song, track, updateIdentity)
      return comparator.isEquivalentSongInfo(song, next) ? song : next
    }
    const playingSong = runtime.playingData.playingSong
    if (playingSong) {
      const matched = matchRuntimeTrack(playingSong, runtimeByRowKey, runtimeByFilePath)
      if (matched) {
        const next = patchSong(
          playingSong,
          matched,
          runtime.playingData.playingSongListUUID === playbackListKey
        )
        if (next !== playingSong) runtime.playingData.playingSong = next
      }
    }
    const playingSongListData = patchSongListRuntime(
      runtime.playingData.playingSongListData,
      runtimeTracks,
      comparator,
      runtime.playingData.playingSongListUUID === playbackListKey
    )
    if (playingSongListData !== runtime.playingData.playingSongListData)
      runtime.playingData.playingSongListData = playingSongListData
    const topSong = runtime.horizontalBrowseDecks.topSong
    if (topSong) {
      const matched = matchRuntimeTrack(topSong, runtimeByRowKey, runtimeByFilePath)
      if (matched) {
        const next = patchSong(
          topSong,
          matched,
          runtime.horizontalBrowseDecks.topSongListUUID === playbackListKey
        )
        if (next !== topSong) runtime.horizontalBrowseDecks.topSong = next
      }
    }
    const bottomSong = runtime.horizontalBrowseDecks.bottomSong
    if (bottomSong) {
      const matched = matchRuntimeTrack(bottomSong, runtimeByRowKey, runtimeByFilePath)
      if (matched) {
        const next = patchSong(
          bottomSong,
          matched,
          runtime.horizontalBrowseDecks.bottomSongListUUID === playbackListKey
        )
        if (next !== bottomSong) runtime.horizontalBrowseDecks.bottomSong = next
      }
    }
    const topSongListData = patchSongListRuntime(
      runtime.horizontalBrowseDecks.topSongListData,
      runtimeTracks,
      comparator,
      runtime.horizontalBrowseDecks.topSongListUUID === playbackListKey
    )
    if (topSongListData !== runtime.horizontalBrowseDecks.topSongListData)
      runtime.horizontalBrowseDecks.topSongListData = topSongListData
    const bottomSongListData = patchSongListRuntime(
      runtime.horizontalBrowseDecks.bottomSongListData,
      runtimeTracks,
      comparator,
      runtime.horizontalBrowseDecks.bottomSongListUUID === playbackListKey
    )
    if (bottomSongListData !== runtime.horizontalBrowseDecks.bottomSongListData)
      runtime.horizontalBrowseDecks.bottomSongListData = bottomSongListData

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
    if (tracksChanged && gridPayloads.length) {
      emitter.emit('horizontalBrowse/shared-grid-batch-updated', gridPayloads)
    }
  }

  const fetchPlaylistTracks = async (
    fetchParams: FetchPlaylistTracksParams,
    preserveView = false,
    reuseRuntime = false,
    hydrateRuntime = true
  ) => {
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
      const previousById = new Map(
        params.originalTracks.value.map((track) => [track.trackId, track])
      )
      // A committed playlist-only edit cannot alter ANLZ. Metadata still comes from disk;
      // only unchanged, fully loaded runtime records can avoid a second analysis read.
      const runtimeTracksNeeded =
        preserveView && reuseRuntime
          ? tracks.filter((track) => {
              const previous = previousById.get(track.trackId)
              return (
                !previous ||
                normalizePath(previous.filePath) !== normalizePath(track.filePath) ||
                normalizePath(previous.analyzePath) !== normalizePath(track.analyzePath) ||
                !Array.isArray(previous.hotCues) ||
                !Array.isArray(previous.memoryCues) ||
                !Array.isArray(previous.rekordboxGridEntries)
              )
            })
          : tracks
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
      if (preserveView && refreshRequested) return

      const selectedTrackIds = preserveView
        ? new Set(
            params.originalTracks.value
              .filter((track) => params.selectedRowKeys.value.includes(track.rowKey))
              .map((track) => track.trackId)
          )
        : null
      let tracksChanged = !preserveView
      if (preserveView) {
        const previousByKey = new Map(
          params.originalTracks.value.map((track) => [track.rowKey, track])
        )
        const nextTracks = tracks.map((track) => {
          const previous = previousByKey.get(track.rowKey) || previousById.get(track.trackId)
          // Keep runtime data until the runtime pass below, avoiding a transient cue/grid reset.
          if (!previous) return track
          // Desktop Cue records are fresh SQL metadata, unlike USB cues from ANLZ.
          const previousRuntime =
            sourceKind === 'desktop'
              ? { ...previous, hotCues: track.hotCues, memoryCues: track.memoryCues }
              : previous
          return mergeRuntimeTrack(track, previousRuntime)
        })
        if (JSON.stringify(params.originalTracks.value) !== JSON.stringify(nextTracks)) {
          tracksChanged = true
          params.originalTracks.value = nextTracks.map((track) => {
            const previous = previousByKey.get(track.rowKey)
            return previous && JSON.stringify(previous) === JSON.stringify(track) ? previous : track
          })
        }
      } else {
        params.originalTracks.value = tracks
      }
      if (tracksChanged) {
        if (
          preserveView &&
          fetchParams.revision !== undefined &&
          params.applyFiltersAndSortingMerged
        ) {
          await params.applyFiltersAndSortingMerged(params.originalTracks.value)
        } else {
          await params.applyFiltersAndSorting('fetch-playlist-tracks-success')
        }
      }
      if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
      if (requestToken !== playlistTracksRequestToken) return
      if (selectedTrackIds) {
        const nextKeys = params.originalTracks.value
          .filter((track) => selectedTrackIds.has(track.trackId))
          .map((track) => track.rowKey)
        if (JSON.stringify(nextKeys) !== JSON.stringify(params.selectedRowKeys.value))
          params.selectedRowKeys.value = nextKeys
      }
      if (params.loading.value) params.loading.value = false

      displayedSourceCacheKey = sourceCacheKey
      displayedPlaylistId = playlistId
      setCachedRekordboxPlaylistTracks(
        sourceCacheKey,
        playlistId,
        params.originalTracks.value,
        fetchParams.revision
      )
      if (!hydrateRuntime || !tracks.length || externalKind) return
      if (!runtimeTracksNeeded.length) {
        await applyRuntimeTracks(params.originalTracks.value, tracksChanged)
        return
      }

      try {
        const runtimeResult = (
          sourceKind === 'desktop'
            ? await window.electron.ipcRenderer.invoke(
                buildRekordboxSourceChannel('desktop', 'attach-playlist-tracks-runtime'),
                runtimeTracksNeeded
              )
            : await window.electron.ipcRenderer.invoke(
                buildRekordboxSourceChannel('usb', 'attach-playlist-tracks-runtime'),
                rootPath,
                runtimeTracksNeeded
              )
        ) as { tracks?: IPioneerPlaylistTrack[] }
        if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
        if (requestToken !== playlistTracksRequestToken) return
        if (preserveView && refreshRequested) return

        const runtimeTracks = Array.isArray(runtimeResult?.tracks) ? runtimeResult.tracks : []
        await applyRuntimeTracks(runtimeTracks, tracksChanged)
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
        if (preserveView) throw runtimeError
      }
    } catch (error) {
      if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
      if (requestToken !== playlistTracksRequestToken) return

      console.error('[pioneerSongsArea] load playlist tracks failed', error)
      params.emitPioneerSongsAreaLog('fetch-playlist-tracks-failed', {
        requestToken,
        error
      })
      if (preserveView) throw error
      if (!params.originalTracks.value.length) {
        params.originalTracks.value = []
        params.visibleSongs.value = []
      }
    } finally {
      if (
        params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId) &&
        requestToken === playlistTracksRequestToken
      ) {
        if (params.loading.value) params.loading.value = false
      }
    }
  }

  const performLoadPlaylistTracks = async () => {
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
      displayedSourceCacheKey = ''
      displayedPlaylistId = 0
      params.emitPioneerSongsAreaLog('load-playlist-tracks-reset-empty-selection', {
        sourceCacheKey,
        rootPath,
        playlistId
      })
      return
    }

    const preserveVisible =
      displayedSourceCacheKey === sourceCacheKey && displayedPlaylistId === playlistId
    params.emitPioneerSongsAreaLog('load-playlist-tracks-enter', {
      sourceCacheKey
    })
    let revision: string | undefined
    try {
      revision = await readSourceRevision(sourceKind, externalKind, rootPath)
    } catch (error) {
      console.error('[pioneerSongsArea] read DJ library revision failed', error)
      if (!preserveVisible && params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) {
        params.originalTracks.value = []
        params.visibleSongs.value = []
        params.selectedRowKeys.value = []
        displayedSourceCacheKey = ''
        displayedPlaylistId = 0
      }
      return
    }
    if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
    const cached = revision ? getCachedRekordboxPlaylistTracks(sourceCacheKey, playlistId) : null
    if (cached && cached.revision === revision) {
      if (preserveVisible) return
      params.selectedRowKeys.value = []
      params.originalTracks.value = cached.tracks
      displayedSourceCacheKey = sourceCacheKey
      displayedPlaylistId = playlistId
      params.applyFiltersAndSorting('cached-playlist-tracks')
      params.loading.value = false
      return
    }
    if (!preserveVisible) {
      params.selectedRowKeys.value = []
      params.loading.value = true
      params.originalTracks.value = []
      params.visibleSongs.value = []
      displayedSourceCacheKey = ''
      displayedPlaylistId = 0
    }

    await fetchPlaylistTracks(
      {
        sourceCacheKey,
        playlistId,
        sourceKind,
        externalKind,
        rootPath,
        libraryType,
        revision,
        preserveVisible
      },
      preserveVisible,
      true,
      sourceKind === 'usb' && !externalKind
    )
  }

  const loadPlaylistTracks = async () => {
    if (loadInFlight) {
      loadAgain = true
      return loadInFlight
    }
    const operation = (async () => {
      do {
        loadAgain = false
        await performLoadPlaylistTracks()
      } while (loadAgain)
    })()
    loadInFlight = operation
    try {
      await operation
    } finally {
      loadInFlight = null
    }
  }

  let refreshRunning: Promise<void> | null = null
  let refreshReuseRuntime = false
  let activeRefreshReuseRuntime = true
  const refreshPlaylistTracks = async (options?: { reuseRuntime?: boolean }): Promise<void> => {
    refreshReuseRuntime =
      options?.reuseRuntime === true &&
      (!refreshRequested || refreshReuseRuntime) &&
      (!refreshRunning || activeRefreshReuseRuntime)
    refreshRequested = true
    if (refreshRunning) return refreshRunning
    refreshRunning = (async () => {
      while (refreshRequested) {
        const reuseRuntime = refreshReuseRuntime
        activeRefreshReuseRuntime = reuseRuntime
        refreshRequested = false
        const rootPath = params.selectedSourceRootPath.value
        const playlistId = params.selectedPlaylistId.value
        const sourceCacheKey = params.selectedSourceCacheKey.value
        if (!rootPath || !playlistId || !sourceCacheKey) return
        await fetchPlaylistTracks(
          {
            rootPath,
            playlistId,
            sourceCacheKey,
            sourceKind: params.selectedSourceKind.value || 'usb',
            externalKind: params.selectedExternalKind.value,
            libraryType: params.selectedLibraryType.value
          },
          true,
          reuseRuntime
        )
      }
    })()
    try {
      await refreshRunning
    } finally {
      refreshRunning = null
    }
  }

  return {
    loadPlaylistTracks,
    refreshPlaylistTracks
  }
}
