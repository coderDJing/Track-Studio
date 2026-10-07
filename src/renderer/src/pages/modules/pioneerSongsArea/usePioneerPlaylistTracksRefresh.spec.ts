import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, shallowRef, watch } from 'vue'
import { usePioneerPlaylistTracks } from './usePioneerPlaylistTracks'
import { usePioneerSongsProjection } from './usePioneerSongsProjection'
import type {
  IPioneerPlaylistTrack,
  ISongInfo,
  ISongsAreaColumn
} from '../../../../../types/globals'

const { testRuntime, invoke, emit } = vi.hoisted(() => ({
  invoke: vi.fn(),
  emit: vi.fn(),
  testRuntime: {
    setting: { platform: 'win32' },
    playingData: {
      playingSong: null as ISongInfo | null,
      playingSongListUUID: '',
      playingSongListData: [] as ISongInfo[]
    },
    horizontalBrowseDecks: {
      topSong: null as ISongInfo | null,
      bottomSong: null as ISongInfo | null,
      topSongListUUID: '',
      bottomSongListUUID: '',
      topSongListData: [] as ISongInfo[],
      bottomSongListData: [] as ISongInfo[]
    }
  }
}))
vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => testRuntime }))
vi.mock('@renderer/utils/mitt', () => ({ default: { emit } }))

const makeTrack = (trackId: number, entryIndex: number): IPioneerPlaylistTrack => ({
  rowKey: `pioneer:11:${entryIndex}:${trackId}`,
  playlistId: 11,
  playlistName: 'Test playlist',
  trackId,
  entryIndex,
  title: `Track ${trackId}`,
  artist: '',
  album: '',
  label: '',
  genre: '',
  filePath: `E:\\Contents\\${trackId}.mp3`,
  fileName: `${trackId}.mp3`,
  fileFormat: 'mp3',
  container: 'mp3',
  duration: '03:00',
  durationSec: 180,
  fileMissing: false,
  hotCues: [{ slot: 0, sec: trackId, comment: 'Keep me' }],
  memoryCues: [],
  rekordboxGridEntries: [{ timeMs: 10, bpm: 120, beatNumber: 1 }]
})

const fixture = (sourceKind: 'usb' | 'desktop' = 'usb') => {
  const originalTracks = shallowRef<IPioneerPlaylistTrack[]>([])
  const visibleSongs = ref<ISongInfo[]>([])
  const selectedRowKeys = ref<string[]>([])
  const loading = ref(false)
  const selectedPlaylistId = ref(11)
  const selectedSourceCacheKey = computed(() => 'usb::fixture')
  const currentPlaybackListKey = computed(() => `usb:fixture:${selectedPlaylistId.value}`)
  const selectedSourceRootPath = computed(() => 'E:\\')
  const selectedSourceKind = computed(() => sourceKind)
  const selectedExternalKind = computed(() => null)
  const projection = usePioneerSongsProjection({
    originalTracks,
    visibleSongs,
    selectedRowKeys,
    columnData: ref<ISongsAreaColumn[]>([]),
    selectedSourceRootPath,
    selectedSourceKind,
    selectedLibraryType: computed(() => 'deviceLibrary'),
    selectedExternalKind,
    isExternalSource: computed(() => false),
    getKeyDisplayStyle: () => '',
    getCurrentPlaybackListKey: () => currentPlaybackListKey.value,
    getPlayingSongListUUID: () => testRuntime.playingData.playingSongListUUID,
    setPlayingSongListData: (songs) => {
      testRuntime.playingData.playingSongListData = songs
    },
    emitPioneerSongsAreaLog: () => {}
  })
  const loader = usePioneerPlaylistTracks({
    originalTracks,
    visibleSongs,
    selectedRowKeys,
    loading,
    selectedSourceCacheKey,
    currentPlaybackListKey,
    selectedPlaylistId: computed(() => selectedPlaylistId.value),
    selectedSourceRootPath,
    selectedSourceKind,
    selectedExternalKind,
    selectedLibraryType: computed(() => 'deviceLibrary'),
    applyFiltersAndSorting: projection.applyFiltersAndSorting,
    isCurrentPlaylistLoadTarget: (key, id) =>
      key === selectedSourceCacheKey.value && id === selectedPlaylistId.value,
    emitPioneerSongsAreaLog: () => {}
  })
  return {
    ...loader,
    originalTracks,
    visibleSongs,
    selectedRowKeys,
    loading,
    currentPlaybackListKey
  }
}

let diskTracks: IPioneerPlaylistTrack[]
afterEach(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.clearAllMocks()
  testRuntime.playingData.playingSong = null
  testRuntime.playingData.playingSongListUUID = ''
  testRuntime.playingData.playingSongListData = []
  testRuntime.horizontalBrowseDecks.topSong = null
  testRuntime.horizontalBrowseDecks.bottomSong = null
  testRuntime.horizontalBrowseDecks.topSongListUUID = ''
  testRuntime.horizontalBrowseDecks.bottomSongListUUID = ''
  testRuntime.horizontalBrowseDecks.topSongListData = []
  testRuntime.horizontalBrowseDecks.bottomSongListData = []
  diskTracks = [makeTrack(1, 1), makeTrack(2, 2)]
  invoke.mockImplementation(async (channel: string) => ({
    tracks: diskTracks.map((track) =>
      channel.endsWith('load-playlist-tracks-meta')
        ? { ...track, hotCues: undefined, memoryCues: undefined, rekordboxGridEntries: undefined }
        : { ...track }
    )
  }))
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
})

describe('USB playlist refresh', () => {
  it('keeps fresh desktop SQL cue metadata while reusing the loaded ANLZ grid', async () => {
    const state = fixture('desktop')
    invoke.mockImplementation(async (channel: string) =>
      channel.endsWith('source-revision')
        ? { revision: 'desktop-refresh-fixture' }
        : { tracks: diskTracks.map((track) => ({ ...track })) }
    )
    await state.loadPlaylistTracks()
    testRuntime.playingData.playingSongListUUID = state.currentPlaybackListKey.value
    testRuntime.playingData.playingSong = state.visibleSongs.value[0]
    invoke.mockClear()
    const grid = state.originalTracks.value[0].rekordboxGridEntries
    invoke.mockResolvedValue({
      tracks: diskTracks.map((track) => ({
        ...track,
        rekordboxGridEntries: undefined,
        hotCues: [{ slot: 0, sec: 42, comment: 'Fresh SQL cue' }]
      }))
    })
    await state.refreshPlaylistTracks({ reuseRuntime: true })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][0]).toBe('rekordbox-desktop-library:load-playlist-tracks-meta')
    expect(state.originalTracks.value[0].hotCues?.[0].sec).toBe(42)
    expect(testRuntime.playingData.playingSong?.hotCues?.[0].sec).toBe(42)
    expect(state.originalTracks.value[0].rekordboxGridEntries).toBe(grid)
    expect(state.loading.value).toBe(false)
  })
  it('refreshes order and playback identity without rereading unchanged runtime data', async () => {
    const state = fixture()
    await state.loadPlaylistTracks()
    state.selectedRowKeys.value = [diskTracks[0].rowKey]
    testRuntime.playingData.playingSongListUUID = state.currentPlaybackListKey.value
    testRuntime.playingData.playingSong = state.visibleSongs.value[0]
    const previous = state.visibleSongs.value[0]
    diskTracks = [makeTrack(2, 1), makeTrack(1, 2)]
    invoke.mockClear()
    await state.refreshPlaylistTracks({ reuseRuntime: true })
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[0][0]).toMatch(/load-playlist-tracks-meta$/)
    expect(state.visibleSongs.value.map((song) => song.title)).toEqual(['Track 2', 'Track 1'])
    expect(state.visibleSongs.value[1].hotCues).toEqual(previous.hotCues)
    expect(state.selectedRowKeys.value).toEqual([diskTracks[1].rowKey])
    expect(testRuntime.playingData.playingSong?.mixtapeItemId).toBe(diskTracks[1].rowKey)
  })

  it('reads runtime only for newly added members when analysis is unchanged', async () => {
    const state = fixture()
    await state.loadPlaylistTracks()
    const previous = state.visibleSongs.value[0]
    diskTracks.push(makeTrack(3, 3))
    invoke.mockClear()
    await state.refreshPlaylistTracks({ reuseRuntime: true })
    const attach = invoke.mock.calls.find((call) =>
      call[0].endsWith('attach-playlist-tracks-runtime')
    )
    expect(attach?.[2].map((track: IPioneerPlaylistTrack) => track.trackId)).toEqual([3])
    expect(state.visibleSongs.value[0]).toBe(previous)
    expect(state.visibleSongs.value[2].hotCues).toEqual(diskTracks[2].hotCues)
  })

  it('does not discard a pending full runtime refresh when a playlist-only refresh arrives', async () => {
    const state = fixture()
    await state.loadPlaylistTracks()
    let release: (() => void) | undefined
    let reads = 0
    invoke.mockClear()
    invoke.mockImplementation(async (channel: string) => {
      if (channel.endsWith('load-playlist-tracks-meta')) {
        if (++reads === 1)
          await new Promise<void>((resolve) => {
            release = resolve
          })
        return {
          tracks: diskTracks.map((track) => ({
            ...track,
            hotCues: undefined,
            memoryCues: undefined,
            rekordboxGridEntries: undefined
          }))
        }
      }
      return { tracks: diskTracks.map((track) => ({ ...track, hotCues: [{ slot: 0, sec: 99 }] })) }
    })
    const full = state.refreshPlaylistTracks()
    const membership = state.refreshPlaylistTracks({ reuseRuntime: true })
    release?.()
    await Promise.all([full, membership])
    expect(
      invoke.mock.calls.some((call) => call[0].endsWith('attach-playlist-tracks-runtime'))
    ).toBe(true)
    expect(state.visibleSongs.value[0].hotCues?.[0].sec).toBe(99)
  })

  it('keeps row, list and selection references and performs no UI event for an unchanged refresh', async () => {
    const state = fixture()
    await state.loadPlaylistTracks()
    state.selectedRowKeys.value = [diskTracks[0].rowKey]
    const rows = state.visibleSongs.value
    const raw = state.originalTracks.value
    const selection = state.selectedRowKeys.value
    emit.mockClear()
    await state.refreshPlaylistTracks()
    expect(state.visibleSongs.value).toBe(rows)
    expect(state.originalTracks.value).toBe(raw)
    expect(state.selectedRowKeys.value).toBe(selection)
    expect(emit).not.toHaveBeenCalled()
    expect(state.loading.value).toBe(false)
  })

  it('retains cue/grid data and selected/current track when reorder changes entry-based row keys', async () => {
    const state = fixture()
    await state.loadPlaylistTracks()
    state.selectedRowKeys.value = [diskTracks[0].rowKey]
    testRuntime.playingData.playingSongListUUID = state.currentPlaybackListKey.value
    testRuntime.playingData.playingSong = state.visibleSongs.value[0]
    diskTracks = [makeTrack(2, 1), makeTrack(1, 2)]
    const snapshots: Array<{ loading: boolean; cueCount: number; gridCount: number }> = []
    invoke.mockImplementation(async (channel: string) => {
      snapshots.push({
        loading: state.loading.value,
        cueCount:
          state.visibleSongs.value.find((song) => song.filePath.endsWith('1.mp3'))?.hotCues
            ?.length || 0,
        gridCount:
          state.visibleSongs.value.find((song) => song.filePath.endsWith('1.mp3'))
            ?.rekordboxGridEntries?.length || 0
      })
      return {
        tracks: diskTracks.map((track) =>
          channel.endsWith('load-playlist-tracks-meta')
            ? {
                ...track,
                hotCues: undefined,
                memoryCues: undefined,
                rekordboxGridEntries: undefined
              }
            : { ...track }
        )
      }
    })
    await state.refreshPlaylistTracks()
    expect(state.selectedRowKeys.value).toEqual([diskTracks[1].rowKey])
    expect(testRuntime.playingData.playingSong?.mixtapeItemId).toBe(diskTracks[1].rowKey)
    expect(state.visibleSongs.value.map((song) => song.title)).toEqual(['Track 2', 'Track 1'])
    expect(
      snapshots.every(
        (snapshot) => !snapshot.loading && snapshot.cueCount === 1 && snapshot.gridCount === 1
      )
    ).toBe(true)
  })

  it('does not change the playback row identity belonging to a different playlist', async () => {
    const state = fixture()
    await state.loadPlaylistTracks()
    const playing = { ...state.visibleSongs.value[0], mixtapeItemId: 'pioneer:99:1:1' }
    testRuntime.playingData.playingSongListUUID = 'usb:fixture:99'
    testRuntime.playingData.playingSong = playing
    diskTracks = [makeTrack(2, 1), makeTrack(1, 2)]
    await state.refreshPlaylistTracks()
    expect(testRuntime.playingData.playingSong).toBe(playing)
    expect(testRuntime.playingData.playingSong?.mixtapeItemId).toBe('pioneer:99:1:1')
  })

  it('coalesces a newer refresh while a read is pending without displaying the stale result', async () => {
    const state = fixture()
    await state.loadPlaylistTracks()
    const displayedTitles: string[] = []
    const stop = watch(state.visibleSongs, (rows) => displayedTitles.push(rows[0]?.title || ''), {
      flush: 'sync'
    })
    let release: (() => void) | undefined
    let metadataReads = 0
    invoke.mockImplementation(async (channel: string) => {
      if (channel.endsWith('load-playlist-tracks-meta')) {
        metadataReads++
        if (metadataReads === 1) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return { tracks: [{ ...makeTrack(1, 1), title: 'Stale' }, makeTrack(2, 2)] }
        }
      }
      return { tracks: [{ ...makeTrack(1, 1), title: 'Latest' }, makeTrack(2, 2)] }
    })
    const first = state.refreshPlaylistTracks()
    const second = state.refreshPlaylistTracks()
    release?.()
    await Promise.all([first, second])
    stop()
    expect(metadataReads).toBe(2)
    expect(displayedTitles).toEqual(['Latest'])
  })
})
