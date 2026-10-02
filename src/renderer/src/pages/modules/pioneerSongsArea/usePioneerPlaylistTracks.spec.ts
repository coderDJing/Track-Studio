import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, shallowRef } from 'vue'
import {
  clearRekordboxSourceCache,
  getCachedRekordboxPlaylistTracks,
  setCachedRekordboxPlaylistTracks
} from '@renderer/utils/rekordboxLibraryCache'
import type { IPioneerPlaylistTrack, ISongInfo } from '../../../../../types/globals'

vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => ({}) }))
vi.mock('@renderer/utils/mitt', () => ({ default: { emit: vi.fn() } }))

import { usePioneerPlaylistTracks } from './usePioneerPlaylistTracks'
import { REKORDBOX_COLLECTION_PLAYLIST_ID } from '@shared/djLibraryCollection'

const sourceCacheKey = 'external-library::traktor::revision-test'
const track = (title: string): IPioneerPlaylistTrack =>
  ({
    rowKey: 'track:2:0',
    playlistId: 2,
    playlistName: '4444',
    trackId: 1,
    entryIndex: 0,
    title,
    filePath: 'C:\\Music\\Track.mp3',
    fileName: 'Track.mp3',
    fileFormat: 'MP3',
    duration: '3:00'
  }) as IPioneerPlaylistTrack

describe('DJ playlist track revision cache', () => {
  afterEach(() => {
    clearRekordboxSourceCache(sourceCacheKey)
    clearRekordboxSourceCache('rekordbox-collection-test')
    vi.unstubAllGlobals()
  })

  it('opens a large Rekordbox collection without hydrating every grid or probing audio', async () => {
    const playlistId = REKORDBOX_COLLECTION_PLAYLIST_ID
    const tracks = Array.from({ length: 6810 }, (_, index) => ({
      ...track(`Track ${index}`),
      rowKey: `rekordbox-collection:${index}`,
      playlistId,
      entryIndex: index + 1
    }))
    let revision = 'initial'
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'rekordbox-desktop-library:source-revision') return { revision }
      if (channel === 'rekordbox-desktop-library:load-playlist-tracks-meta') return { tracks }
      throw new Error(`Unexpected bulk hydration: ${channel}`)
    })
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    const originalTracks = shallowRef<IPioneerPlaylistTrack[]>([])
    const applyFiltersAndSorting = vi.fn()
    const applyFiltersAndSortingMerged = vi.fn(async () => true)
    const { loadPlaylistTracks } = usePioneerPlaylistTracks({
      selectedSourceCacheKey: computed(() => 'rekordbox-collection-test'),
      selectedPlaylistId: computed(() => playlistId),
      selectedSourceKind: computed(() => 'desktop'),
      selectedExternalKind: computed(() => null),
      selectedSourceRootPath: computed(() => 'C:\\rekordbox'),
      selectedLibraryType: computed(() => ''),
      originalTracks,
      visibleSongs: ref<ISongInfo[]>([]),
      loading: ref(false),
      selectedRowKeys: ref<string[]>([]),
      applyFiltersAndSorting,
      applyFiltersAndSortingMerged,
      isCurrentPlaylistLoadTarget: () => true,
      emitPioneerSongsAreaLog: vi.fn()
    })
    await loadPlaylistTracks()
    expect(originalTracks.value).toHaveLength(6810)
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'rekordbox-desktop-library:source-revision',
      'rekordbox-desktop-library:load-playlist-tracks-meta'
    ])
    const displayed = originalTracks.value
    revision = 'unrelated-playlist-changed'
    await loadPlaylistTracks()
    expect(originalTracks.value).toBe(displayed)
    expect(applyFiltersAndSorting).toHaveBeenCalledTimes(1)
    expect(applyFiltersAndSortingMerged).not.toHaveBeenCalled()
  })

  it('keeps the same visible list when files are unchanged and reloads after a revision change', async () => {
    let revision = 'initial'
    let returnedTitle = 'Before'
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'external-library:source-revision') return { revision }
      if (channel === 'external-library:load-playlist-tracks') {
        return { tracks: [track(returnedTitle)] }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    setCachedRekordboxPlaylistTracks(sourceCacheKey, 2, [track('Before')], revision)

    const originalTracks = shallowRef<IPioneerPlaylistTrack[]>([])
    const visibleSongs = ref<ISongInfo[]>([])
    const loading = ref(false)
    const selectedRowKeys = ref<string[]>([])
    const applyFiltersAndSorting = vi.fn()
    const applyFiltersAndSortingMerged = vi.fn(async () => true)
    const { loadPlaylistTracks } = usePioneerPlaylistTracks({
      selectedSourceCacheKey: computed(() => sourceCacheKey),
      selectedPlaylistId: computed(() => 2),
      selectedSourceKind: computed(() => ''),
      selectedExternalKind: computed(() => 'traktor'),
      selectedSourceRootPath: computed(() => 'C:\\Traktor\\collection.nml'),
      selectedLibraryType: computed(() => ''),
      originalTracks,
      visibleSongs,
      loading,
      selectedRowKeys,
      applyFiltersAndSorting,
      applyFiltersAndSortingMerged,
      isCurrentPlaylistLoadTarget: (key, playlistId) => key === sourceCacheKey && playlistId === 2,
      emitPioneerSongsAreaLog: vi.fn()
    })

    await loadPlaylistTracks()
    const displayedTracks = originalTracks.value
    expect(displayedTracks[0].title).toBe('Before')
    expect(applyFiltersAndSorting).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledTimes(1)

    await loadPlaylistTracks()
    expect(originalTracks.value).toBe(displayedTracks)
    expect(applyFiltersAndSorting).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledTimes(2)

    revision = 'changed'
    returnedTitle = 'After'
    await loadPlaylistTracks()
    expect(originalTracks.value[0].title).toBe('After')
    expect(applyFiltersAndSorting).toHaveBeenCalledTimes(1)
    expect(applyFiltersAndSortingMerged).toHaveBeenCalledTimes(1)
    expect(getCachedRekordboxPlaylistTracks(sourceCacheKey, 2)?.revision).toBe('changed')

    const unchangedDisplayedTracks = originalTracks.value
    revision = 'other-playlist-changed'
    await loadPlaylistTracks()
    expect(originalTracks.value).toBe(unchangedDisplayedTracks)
    expect(applyFiltersAndSortingMerged).toHaveBeenCalledTimes(1)
    expect(getCachedRekordboxPlaylistTracks(sourceCacheKey, 2)?.revision).toBe(revision)
  })
})
