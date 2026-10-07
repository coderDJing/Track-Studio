import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { usePioneerUsbPlaylistDrop } from './usePioneerUsbPlaylistDrop'
import type { IPioneerPlaylistTreeNode, ISongInfo } from 'src/types/globals'
const { write } = vi.hoisted(() => ({ write: vi.fn() }))
vi.mock('@renderer/utils/pioneerUsbWrite', () => ({
  prepareAndApplyPioneerUsbWrite: write,
  showPioneerUsbWriteError: vi.fn()
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
const fixture = () => {
  type Params = Parameters<typeof usePioneerUsbPlaylistDrop>[0]
  const songs = [7, 8].map(
    (trackId) =>
      ({
        filePath: `D:\\Contents\\${trackId}.mp3`,
        mixtapeItemId: `usb:11:${trackId}`,
        externalSourceKind: 'usb',
        pioneerUsbSource: { rootPath: 'D:\\', libraryType: 'oneLibrary', trackId }
      }) as ISongInfo
  )
  const runtime = {
    songDragActive: true,
    draggingSongFilePaths: songs.map((song) => song.filePath),
    dragSourceMixtapeItemIds: songs.map((song) => song.mixtapeItemId!),
    playingData: { playingSongListData: songs }
  } as unknown as Params['runtime']
  return {
    runtime,
    songs,
    ...usePioneerUsbPlaylistDrop({
      runtime,
      enabled: ref(true),
      rootPath: ref('D:\\'),
      libraryType: ref('oneLibrary')
    })
  }
}
const node = { id: 12, name: 'Target', isFolder: false } as IPioneerPlaylistTreeNode
const event = { dataTransfer: { dropEffect: 'none' } } as DragEvent
beforeEach(() => {
  vi.resetAllMocks()
  write.mockResolvedValue({ deletedTrackCount: 0 })
})
describe('dragging existing USB songs into another playlist', () => {
  it('adds membership without removing or copying source tracks', async () => {
    const state = fixture()
    const original = [...state.runtime.playingData.playingSongListData]
    expect(state.dragOver(event, node)).toBe(true)
    expect(event.dataTransfer?.dropEffect).toBe('copy')
    await state.drop(event, node)
    expect(write).toHaveBeenCalledExactlyOnceWith(
      {
        rootPath: 'D:\\',
        libraryType: 'oneLibrary',
        operation: { kind: 'add-to-playlist', playlistId: 12, trackIds: [7, 8] }
      },
      'Target'
    )
    expect(state.runtime.playingData.playingSongListData).toEqual(original)
  })
  it.each(['different-drive', 'new-audio', 'other-library', 'folder'])(
    'rejects a %s drop without writing',
    async (invalid) => {
      const state = fixture()
      if (invalid === 'different-drive') state.songs[0].pioneerUsbSource!.rootPath = 'F:\\'
      if (invalid === 'new-audio') state.songs[0].pioneerUsbSource = undefined
      if (invalid === 'other-library')
        state.songs[0].pioneerUsbSource!.libraryType = 'deviceLibrary'
      await state.drop(event, invalid === 'folder' ? { ...node, isFolder: true } : node)
      expect(write).not.toHaveBeenCalled()
      expect(state.pending.value).toBe(false)
    }
  )
})
