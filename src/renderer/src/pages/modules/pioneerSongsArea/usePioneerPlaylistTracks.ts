import type { ComputedRef, Ref, ShallowRef } from 'vue'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import {
  getCachedRekordboxPlaylistTracks,
  setCachedRekordboxPlaylistTracks
} from '@renderer/utils/rekordboxLibraryCache'
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
  applyFiltersAndSortingMerged: (tracks: IPioneerPlaylistTrack[]) => Promise<boolean>
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

export const usePioneerPlaylistTracks = (params: UsePioneerPlaylistTracksParams) => {
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

  const fetchPlaylistTracks = async (fetchParams: FetchPlaylistTracksParams) => {
    const requestToken = ++playlistTracksRequestToken
    const {
      sourceCacheKey,
      playlistId,
      sourceKind,
      externalKind,
      rootPath,
      libraryType,
      revision,
      preserveVisible
    } = fetchParams

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

      if (preserveVisible) {
        const refreshedTracks = tracks
        if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
        if (requestToken !== playlistTracksRequestToken) return
        const rawChanged =
          JSON.stringify(params.originalTracks.value) !== JSON.stringify(refreshedTracks)
        if (rawChanged) {
          const visibleChanged = await params.applyFiltersAndSortingMerged(refreshedTracks)
          if (!params.isCurrentPlaylistLoadTarget(sourceCacheKey, playlistId)) return
          if (requestToken !== playlistTracksRequestToken) return
          params.originalTracks.value = refreshedTracks
          if (visibleChanged) {
            const rowKeys = new Set(refreshedTracks.map((track) => track.rowKey))
            const retainedKeys = params.selectedRowKeys.value.filter((key) => rowKeys.has(key))
            if (retainedKeys.length !== params.selectedRowKeys.value.length) {
              params.selectedRowKeys.value = retainedKeys
            }
          }
        }
        setCachedRekordboxPlaylistTracks(
          sourceCacheKey,
          playlistId,
          rawChanged ? refreshedTracks : params.originalTracks.value,
          revision
        )
        return
      }

      params.originalTracks.value = tracks
      displayedSourceCacheKey = sourceCacheKey
      displayedPlaylistId = playlistId
      params.applyFiltersAndSorting('fetch-playlist-tracks-success')
      params.loading.value = false
      setCachedRekordboxPlaylistTracks(sourceCacheKey, playlistId, tracks, revision)
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
        requestToken === playlistTracksRequestToken &&
        params.loading.value
      ) {
        params.loading.value = false
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

    await fetchPlaylistTracks({
      sourceCacheKey,
      playlistId,
      sourceKind,
      externalKind,
      rootPath,
      libraryType,
      revision,
      preserveVisible
    })
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

  return {
    loadPlaylistTracks
  }
}
