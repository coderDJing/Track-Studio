// Run: pnpm exec vitest run src/renderer/src/pages/modules/songsArea/composables/useSongsAreaPlaybackMembership.spec.ts
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ISongInfo } from 'src/types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { useHorizontalBrowseDeckSourceState } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckSourceState'
import { useSongsAreaColumns } from './useSongsAreaColumns'
import { useSongsAreaEvents } from './useSongsAreaEvents'

const lifecycle = vi.hoisted(() => ({
  mounted: [] as Array<() => void>,
  unmounted: [] as Array<() => void>
}))

vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  onMounted: (callback: () => void) => lifecycle.mounted.push(callback),
  onUnmounted: (callback: () => void) => lifecycle.unmounted.push(callback)
}))
vi.mock('@renderer/utils/libraryUtils', () => ({
  default: {
    getLibraryTreeByUUID: () => ({ type: 'songList' }),
    findDirPathByUuid: () => 'library/FilterLibrary/test'
  }
}))

const makeSong = (index: number, key = 'Am'): ISongInfo => ({
  filePath: `D:/Music/${index}.mp3`,
  fileName: `${index}.mp3`,
  fileFormat: 'MP3',
  cover: null,
  title: `${index}`,
  artist: undefined,
  album: undefined,
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined,
  playlistTrackNumber: index + 1,
  key
})

const scopes: ReturnType<typeof effectScope>[] = []
const setup = () => {
  const runtime = useRuntimeStore()
  runtime.setting.platform = 'win32'
  runtime.mainWindowBrowseMode = 'horizontal'
  const state = runtime.songsAreaPanels.panes.single
  state.songListUUID = 'playlist'
  const initial = Array.from({ length: 16 }, (_, index) => makeSong(index))
  const original = shallowRef(initial)
  runtime.horizontalBrowseDecks.topSong = initial[0]
  runtime.horizontalBrowseDecks.leaderDeck = 'top'
  const deckSources = useHorizontalBrowseDeckSourceState()
  const scope = effectScope()
  scopes.push(scope)
  const openSongList = vi.fn(async () => {})
  const columns = scope.run(() => {
    const columns = useSongsAreaColumns({
      runtime,
      songsAreaState: state,
      originalSongInfoArr: original,
      shouldPersistToLocalStorage: () => false
    })
    useSongsAreaEvents({
      runtime,
      songsAreaState: state,
      originalSongInfoArr: original,
      applyFiltersAndSorting: columns.applyFiltersAndSorting,
      shouldApplyFiltersAndSortingForSongChange: columns.shouldApplyFiltersAndSortingForSongChange,
      openSongList,
      invalidatePendingSongListLoads: vi.fn(),
      scheduleSweepCovers: vi.fn()
    })
    return columns
  })!
  columns.applyFiltersAndSorting()
  deckSources.setDeckSongListSource('top', {
    sourceSongListUUID: state.songListUUID,
    sourceSongListData: initial
  })
  lifecycle.mounted.splice(0).forEach((mount) => mount())
  return { runtime, state, original, columns, deckSources, openSongList }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null })
  vi.stubGlobal('window', {
    electron: { ipcRenderer: { on: vi.fn(), removeListener: vi.fn() } }
  })
})

afterEach(() => {
  lifecycle.unmounted.splice(0).forEach((unmount) => unmount())
  lifecycle.mounted.length = 0
  scopes.splice(0).forEach((scope) => scope.stop())
  emitter.all.clear()
  vi.unstubAllGlobals()
})

describe('playlist membership is independent of playback queue snapshots', () => {
  it('keeps newly added tracks after toggling compatibility and restoring an older deck queue', async () => {
    const { state, original, columns, deckSources, openSongList } = setup()
    await nextTick()
    const added = [makeSong(16, '2A'), makeSong(17, '2A')]
    original.value = [...original.value, ...added]
    columns.applyFiltersAndSorting()
    expect(state.songInfoArr).toHaveLength(18)

    state.compatibleKeyOnly = true
    await nextTick()
    expect(state.songInfoArr).toHaveLength(16)
    state.compatibleKeyOnly = false
    // Clearing the other deck restores the first deck's pre-addition 16-track snapshot.
    deckSources.clearDeckSongListSource('bottom')
    await nextTick()

    expect(original.value).toHaveLength(18)
    expect(state.songInfoArr).toHaveLength(18)
    expect(state.songInfoArr.slice(-2)).toEqual(added)
    expect(state.totalSongCount).toBe(18)
    expect(openSongList).toHaveBeenCalledTimes(1)
  })

  it('does not remove hidden tracks when a filtered playback queue receives a metadata update', async () => {
    const { runtime, state, original, columns } = setup()
    await nextTick()
    original.value = [...original.value, makeSong(16, '2A'), makeSong(17, '2A')]
    columns.applyFiltersAndSorting()
    state.compatibleKeyOnly = true
    await nextTick()
    columns.handleColumnsUpdate(columns.columnData.value)
    await nextTick()
    expect(runtime.playingData.playingSongListData).toHaveLength(16)

    state.compatibleKeyOnly = false
    runtime.playingData.playingSongListData[0].title = 'Updated title'
    await nextTick()
    expect(original.value).toHaveLength(18)
    expect(state.songInfoArr).toHaveLength(18)
    expect(state.totalSongCount).toBe(18)
  })

  it.each(['songsRemoved', 'songsArea/optimistic-remove'] as const)(
    'still removes a hidden track through the explicit %s event',
    async (event) => {
      const { state, original, columns } = setup()
      await nextTick()
      const hiddenSong = makeSong(16, '2A')
      original.value = [...original.value, hiddenSong]
      columns.applyFiltersAndSorting()
      state.compatibleKeyOnly = true
      await nextTick()
      emitter.emit(event, { listUUID: state.songListUUID, paths: [hiddenSong.filePath] })
      await nextTick()
      state.compatibleKeyOnly = false
      await nextTick()

      expect(original.value).toHaveLength(16)
      expect(state.songInfoArr).toHaveLength(16)
      expect(state.songInfoArr.some((song) => song.filePath === hiddenSong.filePath)).toBe(false)
      expect(state.totalSongCount).toBe(16)
    }
  )
})
