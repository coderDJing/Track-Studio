import { afterEach, describe, expect, it, vi } from 'vitest'
import emitter from '@renderer/utils/mitt'
import { usePioneerUsbPlaybackDeletion } from './usePioneerUsbPlaybackDeletion'
import type { ISongInfo } from 'src/types/globals'
const { dispose } = vi.hoisted(() => ({ dispose: [] as (() => void)[] }))
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onUnmounted: (callback: () => void) => dispose.push(callback)
}))
vi.mock('@renderer/utils/pioneerUsbWrite', () => ({
  prepareAndApplyPioneerUsbWrite: vi.fn(),
  showPioneerUsbWriteError: vi.fn()
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
const fixture = () => {
  const songs = [7, 8, 9].map(
    (trackId) =>
      ({
        filePath: `D:\\Contents\\${trackId}.mp3`,
        externalSourceKind: 'usb',
        pioneerUsbSource: { rootPath: 'D:\\', libraryType: 'oneLibrary', trackId }
      }) as ISongInfo
  )
  type Params = Parameters<typeof usePioneerUsbPlaybackDeletion>[0]
  const runtime = {
    playingData: {
      playingSong: songs[0],
      playingSongListData: [...songs],
      playingSongListUUID: 'usb:D:11'
    },
    horizontalBrowseDecks: {
      topSong: songs[0],
      bottomSong: songs[1],
      topSongListData: [...songs],
      bottomSongListData: [...songs]
    }
  } as unknown as Params['runtime']
  return { runtime, songs }
}
const deleted = () =>
  emitter.emit('pioneerUsb/tracks-deleted', {
    rootPath: 'D:\\',
    filePaths: ['D:\\Contents\\7.mp3', 'D:\\Contents\\8.mp3']
  })
afterEach(() => dispose.splice(0).forEach((callback) => callback()))
describe('confirmed USB deletions update loaded players', () => {
  it('chooses a surviving song after batch deletion rather than another deleted song', () => {
    const state = fixture()
    const onMainDeleted = vi.fn()
    usePioneerUsbPlaybackDeletion({ runtime: state.runtime, onMainDeleted })
    deleted()
    expect(onMainDeleted).toHaveBeenCalledExactlyOnceWith({
      listUUID: 'usb:D:11',
      nextList: [state.songs[2]],
      nextSong: state.songs[2]
    })
  })
  it('ejects deleted songs from both decks and removes their stale playlist entries', () => {
    const state = fixture()
    const onDeckDeleted = vi.fn().mockResolvedValue(undefined)
    usePioneerUsbPlaybackDeletion({ runtime: state.runtime, onDeckDeleted })
    deleted()
    expect(onDeckDeleted.mock.calls.map((call) => call[0])).toEqual(['top', 'bottom'])
    expect(state.runtime.horizontalBrowseDecks.topSongListData).toEqual([state.songs[2]])
    expect(state.runtime.horizontalBrowseDecks.bottomSongListData).toEqual([state.songs[2]])
  })
  it('leaves the manual player delete action in charge of its own transition', () => {
    const state = fixture()
    const onMainDeleted = vi.fn()
    usePioneerUsbPlaybackDeletion({ runtime: state.runtime, onMainDeleted, skipMain: () => true })
    deleted()
    expect(onMainDeleted).not.toHaveBeenCalled()
  })
  it('does not touch a loaded song from a different USB drive', () => {
    const state = fixture()
    state.songs[0].pioneerUsbSource!.rootPath = 'F:\\'
    const onMainDeleted = vi.fn()
    usePioneerUsbPlaybackDeletion({ runtime: state.runtime, onMainDeleted })
    deleted()
    expect(onMainDeleted).not.toHaveBeenCalled()
    expect(state.runtime.playingData.playingSongListData).toEqual([state.songs[0], state.songs[2]])
  })
})
