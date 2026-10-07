import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, shallowRef } from 'vue'
import { usePioneerUsbPlaylistActions } from './usePioneerUsbPlaylistActions'
import type { IPioneerPlaylistTrack, ISongInfo } from '../../../../../types/globals'

const { invoke, showError, write, dispose } = vi.hoisted(() => ({
  invoke: vi.fn(),
  showError: vi.fn(),
  write: vi.fn(),
  dispose: [] as (() => void)[]
}))
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onUnmounted: (callback: () => void) => dispose.push(callback)
}))
vi.mock('@renderer/utils/rekordboxLibraryCache', () => ({
  clearRekordboxSourceCache: vi.fn(),
  clearRekordboxSourceCachesByKind: vi.fn(),
  setCachedRekordboxSourceTree: vi.fn()
}))
vi.mock('@renderer/utils/pioneerUsbWrite', () => ({
  prepareAndApplyPioneerUsbWrite: write,
  showPioneerUsbWriteError: showError
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))

const fixture = () => {
  const tracks = [1, 2, 3].map(
    (trackId) =>
      ({
        rowKey: `usb:11:${trackId}`,
        trackId,
        filePath: `E:\\Contents\\${trackId}.mp3`
      }) as IPioneerPlaylistTrack
  )
  const songs = tracks.map(
    (track) => ({ filePath: track.filePath, mixtapeItemId: track.rowKey }) as ISongInfo
  )
  type Params = Parameters<typeof usePioneerUsbPlaylistActions>[0]
  const runtime = {
    pioneerDeviceLibrary: { treeNodes: [], selectedPlaylistId: 11 }
  } as unknown as Params['runtime']
  const sourceCacheKey = ref('usb::fixture')
  const refresh = vi.fn().mockResolvedValue(undefined)
  const state = usePioneerUsbPlaylistActions({
    runtime,
    enabled: ref(true),
    originalTracks: shallowRef(tracks),
    selectedRowKeys: ref([tracks[0].rowKey]),
    selectedPlaylistId: ref(11),
    selectedSourceRootPath: ref('E:\\'),
    selectedLibraryType: ref('deviceLibrary'),
    selectedSourceCacheKey: sourceCacheKey,
    selectedPlaylistNode: ref(null),
    refreshPlaylistTracks: refresh
  })
  return { runtime, sourceCacheKey, refresh, songs, ...state }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  invoke.mockResolvedValue({ treeNodes: [{ id: 11, name: 'Fixture', isFolder: false }] })
  write.mockResolvedValue({ deletedTrackCount: 0 })
})
afterEach(() => {
  dispose.splice(0).forEach((callback) => callback())
  vi.unstubAllGlobals()
})

describe('USB actions through the existing playlist interactions', () => {
  it('saves a full drag reorder and refreshes the same open view', async () => {
    const state = fixture()
    await state.reorderUsbTracks(['usb:11:1'], 3, state.songs)
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: {
          kind: 'reorder',
          playlistId: 11,
          trackIds: [2, 3, 1]
        }
      }),
      expect.any(String)
    )
    expect(state.refresh).toHaveBeenCalledOnce()
    expect(state.refresh).toHaveBeenCalledWith({ reuseRuntime: true })
    expect(invoke.mock.calls.some((call) => call[0] === 'pioneer-device-library:load-tree')).toBe(
      false
    )
    expect(state.usbWriting.value).toBe(false)
  })
  it('refuses a filtered or incomplete order', async () => {
    const state = fixture()
    await state.saveUsbOrder(state.songs.slice(1))
    expect(write).not.toHaveBeenCalled()
    expect(showError).toHaveBeenCalledWith(expect.any(Error))
  })
  it('removes only playlist membership for the existing remove action', async () => {
    const state = fixture()
    await state.removeUsbTracks([state.songs[0]])
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: {
          kind: 'remove-from-playlist',
          playlistId: 11,
          trackIds: [1]
        }
      }),
      expect.any(String)
    )
  })
  it('uses real track deletion for the existing delete action', async () => {
    const state = fixture()
    await state.deleteUsbTracks([state.songs[0]])
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: {
          kind: 'delete-tracks',
          trackIds: [1]
        }
      }),
      expect.any(String)
    )
  })
  it('deletes exclusive tracks with a playlist and clears the removed selection', async () => {
    const state = fixture()
    invoke.mockResolvedValue({ treeNodes: [] })
    await state.deleteUsbPlaylist()
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: {
          kind: 'delete-playlist',
          playlistId: 11,
          deleteExclusiveTracks: true
        }
      }),
      expect.any(String)
    )
    expect(state.runtime.pioneerDeviceLibrary.selectedPlaylistId).toBe(0)
    expect(state.refresh).not.toHaveBeenCalled()
  })
  it('leaves the current view untouched when deletion is cancelled', async () => {
    const state = fixture()
    write.mockResolvedValue(null)
    await state.deleteUsbPlaylist()
    expect(invoke).not.toHaveBeenCalled()
    expect(state.refresh).not.toHaveBeenCalled()
  })
  it('does not overwrite a newly selected source after an older write finishes', async () => {
    const state = fixture()
    const nodes = state.runtime.pioneerDeviceLibrary.treeNodes
    write.mockImplementation(async () => {
      state.sourceCacheKey.value = 'usb::other'
      return {}
    })
    await state.deleteUsbPlaylist()
    expect(state.runtime.pioneerDeviceLibrary.treeNodes).toBe(nodes)
    expect(state.refresh).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('pioneer-device-library:load-tree', 'E:\\', 'deviceLibrary')
  })
})
