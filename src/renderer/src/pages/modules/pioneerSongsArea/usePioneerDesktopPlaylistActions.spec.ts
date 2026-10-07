import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { usePioneerDesktopPlaylistActions } from './usePioneerDesktopPlaylistActions'
import type { ISongInfo } from '../../../../../types/globals'
import type { ExternalLibraryKind } from '@shared/externalLibrary'

const { invoke, checkWrite, confirm, clearCache } = vi.hoisted(() => ({
  invoke: vi.fn(),
  checkWrite: vi.fn(),
  confirm: vi.fn(),
  clearCache: vi.fn()
}))
vi.mock('@renderer/utils/rekordboxDesktopWriteAvailability', () => ({
  ensureRekordboxDesktopWriteAvailable: checkWrite
}))
vi.mock('@renderer/components/confirmDialog', () => ({ default: confirm }))
vi.mock('@renderer/utils/rekordboxLibraryCache', () => ({ clearRekordboxSourceCache: clearCache }))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))

const fixture = () => {
  type Params = Parameters<typeof usePioneerDesktopPlaylistActions>[0]
  const songs = [1, 2].map(
    (id) => ({ mixtapeItemId: String(id), filePath: `${id}.mp3` }) as ISongInfo
  )
  const runtime = {
    pioneerDeviceLibrary: { treeNodes: [] },
    playingData: { playingSongListUUID: 'desktop:11', playingSongListData: songs }
  } as unknown as Params['runtime']
  const playlistId = ref(11)
  const sourceKey = ref('desktop')
  const externalKind = ref<ExternalLibraryKind | null>(null)
  const refresh = vi.fn().mockResolvedValue(undefined)
  const visibleSongs = ref(songs)
  const actions = usePioneerDesktopPlaylistActions({
    runtime,
    selectedPlaylistId: playlistId,
    selectedExternalKind: externalKind,
    selectedSourceRootPath: ref('C:\\rekordbox'),
    selectedSourceCacheKey: sourceKey,
    currentPlaybackListKey: ref('desktop:11'),
    visibleSongs,
    refreshPlaylistTracks: refresh
  })
  return { ...actions, runtime, playlistId, sourceKey, externalKind, refresh, visibleSongs }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  checkWrite.mockResolvedValue(true)
  confirm.mockResolvedValue('confirm')
  invoke.mockResolvedValue({ ok: true, summary: {} })
})
afterEach(() => vi.unstubAllGlobals())

describe('desktop playlist mutation refresh', () => {
  it('reorders in place and reuses unchanged analysis without resetting the selection', async () => {
    const state = fixture()
    const visible = state.visibleSongs.value
    await state.reorderTracksInDesktopPlaylist(['1'], 2, true)
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'rekordbox-desktop-library:reorder-playlist-tracks',
      { playlistId: 11, rowKeys: ['1'], targetIndex: 2 }
    )
    expect(state.refresh).toHaveBeenCalledExactlyOnceWith({ reuseRuntime: true })
    expect(state.visibleSongs.value).toBe(visible)
    expect(state.playlistMutationPending.value).toBe(false)
  })

  it('removes members and renumbers using the same in-place refresh', async () => {
    const state = fixture()
    await state.removeTracksFromDesktopPlaylist([state.visibleSongs.value[0]], true)
    await state.renumberTracksInDesktopPlaylist([...state.visibleSongs.value].reverse(), true)
    expect(state.refresh).toHaveBeenCalledTimes(2)
    expect(state.refresh.mock.calls.every(([options]) => options.reuseRuntime === true)).toBe(true)
  })

  it('does not touch the newly selected playlist while a write is pending', async () => {
    const state = fixture()
    invoke.mockImplementation(async () => {
      state.playlistId.value = 12
      return { ok: true }
    })
    await state.reorderTracksInDesktopPlaylist(['1'], 2, true)
    expect(clearCache).toHaveBeenCalledWith('desktop')
    expect(state.refresh).not.toHaveBeenCalled()
  })

  it('does not refresh after a blocked or failed write', async () => {
    const state = fixture()
    checkWrite.mockResolvedValueOnce(false)
    await state.reorderTracksInDesktopPlaylist(['1'], 2, true)
    expect(invoke).not.toHaveBeenCalled()
    invoke.mockResolvedValue({ ok: false, summary: { errorMessage: 'Locked' } })
    await state.reorderTracksInDesktopPlaylist(['1'], 2, true)
    expect(state.refresh).not.toHaveBeenCalled()
  })

  it('keeps external library runtime reads enabled', async () => {
    const state = fixture()
    state.externalKind.value = 'serato'
    await state.reorderTracksInDesktopPlaylist(['1'], 2, true)
    expect(state.refresh).toHaveBeenCalledWith({ reuseRuntime: false })
    expect(checkWrite).not.toHaveBeenCalled()
  })
})
