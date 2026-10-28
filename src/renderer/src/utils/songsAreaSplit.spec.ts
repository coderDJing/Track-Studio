import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import type { IDir, ISongInfo } from 'src/types/globals'
import { exitSongsAreaSplit, getSongsAreaOppositePane, showSongListInPane } from './songsAreaSplit'

vi.mock('@renderer/utils/libraryUtils', () => ({
  default: { getLibraryTreeByUUID: vi.fn() }
}))

const nodes: IDir[] = [
  { uuid: 'songs', type: 'songList', dirName: 'Songs' },
  { uuid: 'set', type: 'setList', dirName: 'Set' },
  { uuid: 'mixtape', type: 'mixtapeList', dirName: 'Mixtape' },
  { uuid: 'new', type: 'songList', dirName: 'New songs' },
  { uuid: 'folder', type: 'dir', dirName: 'Folder' }
]

const setupCurrentPlaylist = (uuid: string) => {
  const runtime = useRuntimeStore()
  const song = { filePath: 'current.mp3', title: 'Current song' } as ISongInfo
  runtime.assignSongsAreaPaneState('single', {
    songListUUID: uuid,
    songInfoArr: [song],
    totalSongCount: 1,
    selectedSongFilePath: [song.filePath],
    searchQuery: 'Current',
    compatibleKeyOnly: true,
    missingWaveformFilePaths: [song.filePath],
    scrollTop: 240,
    scrollLeft: 80
  })
  runtime.playingData.playingSongListUUID = uuid
  runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
  runtime.playingData.playingSong = song
  return runtime
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(libraryUtils.getLibraryTreeByUUID).mockImplementation(
    (uuid) => nodes.find((node) => node.uuid === uuid) || null
  )
})

describe('entering playlist split view', () => {
  for (const pane of ['left', 'right'] as const) {
    it.each(['songs', 'set', 'mixtape'])(
      `keeps the current %s playlist opposite a new playlist on the ${pane}`,
      (uuid) => {
        const runtime = setupCurrentPlaylist(uuid)
        const single = runtime.songsAreaPanels.panes.single
        const currentSong = single.songInfoArr[0]
        const otherPane = getSongsAreaOppositePane(pane)

        showSongListInPane(runtime, pane, 'new')

        const preserved = runtime.songsAreaPanels.panes[otherPane]
        expect(runtime.songsAreaPanels.splitEnabled).toBe(true)
        expect(runtime.songsAreaPanels.activePane).toBe(pane)
        expect(runtime.songsArea).toBe(runtime.songsAreaPanels.panes[pane])
        expect(runtime.songsArea.songListUUID).toBe('new')
        expect(runtime.songsArea.songInfoArr).toEqual([])
        expect(preserved).toBe(single)
        expect(preserved.songInfoArr).toBe(single.songInfoArr)
        expect(preserved.songInfoArr[0]).toBe(currentSong)
        expect(runtime.playingData.playingSongListData).toBe(preserved.songInfoArr)
        expect(runtime.playingData.playingSong?.filePath).toBe(currentSong.filePath)

        exitSongsAreaSplit(runtime, otherPane)
        expect(runtime.songsAreaPanels.panes.single).toBe(single)
        expect(runtime.songsAreaPanels.splitEnabled).toBe(false)
        expect(runtime.songsArea.songListUUID).toBe(uuid)
        expect(runtime.songsArea.scrollTop).toBe(240)
        expect(runtime.songsArea.selectedSongFilePath).toEqual(['current.mp3'])
      }
    )
  }

  it('only replaces the requested pane when split view is already enabled', () => {
    const runtime = setupCurrentPlaylist('songs')
    showSongListInPane(runtime, 'left', 'set')
    const preservedSongs = runtime.songsAreaPanels.panes.right.songInfoArr

    showSongListInPane(runtime, 'left', 'new')

    expect(runtime.songsAreaPanels.panes.left.songListUUID).toBe('new')
    expect(runtime.songsAreaPanels.panes.right.songListUUID).toBe('songs')
    expect(runtime.songsAreaPanels.panes.right.songInfoArr).toBe(preservedSongs)
  })

  it.each(['left', 'right'] as const)(
    'keeps the live view on %s when opening the same playlist',
    (pane) => {
      const runtime = setupCurrentPlaylist('songs')
      const single = runtime.songsAreaPanels.panes.single
      showSongListInPane(runtime, pane, 'songs')
      expect(runtime.songsAreaPanels.panes[pane]).toBe(single)
      expect(runtime.songsAreaPanels.panes[getSongsAreaOppositePane(pane)]).not.toBe(single)
      exitSongsAreaSplit(runtime, pane)
      expect(runtime.songsAreaPanels.panes.single).toBe(single)
      showSongListInPane(runtime, getSongsAreaOppositePane(pane), 'new')
      expect(runtime.songsAreaPanels.panes[pane]).toBe(single)
      expect(new Set(Object.values(runtime.songsAreaPanels.panes)).size).toBe(3)
    }
  )

  it.each(['', 'folder', 'missing'])('does not preserve an invalid playlist: %s', (uuid) => {
    const runtime = setupCurrentPlaylist(uuid)
    runtime.assignSongsAreaPaneState('right', { songListUUID: 'set' })

    showSongListInPane(runtime, 'left', 'new')

    expect(runtime.songsAreaPanels.panes.left.songListUUID).toBe('new')
    expect(runtime.songsAreaPanels.panes.right.songListUUID).toBe('')
    expect(runtime.songsAreaPanels.panes.right.songInfoArr).toEqual([])
  })
})
