// Run: pnpm exec vitest run src/renderer/src/utils/djPlaylist.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useRuntimeStore } from '../stores/runtime'
import libraryUtils from './libraryUtils'
import { openDjPlaylist, syncDjPlaylistTree } from './djPlaylist'
import { exitSongsAreaSplit, showSongListInPane } from './songsAreaSplit'
import { usePioneerPaneSource } from '../pages/modules/pioneerSongsArea/usePioneerPaneSource'
import type { ISongInfo } from 'src/types/globals'

vi.mock('./libraryUtils', () => ({ default: { getLibraryTreeByUUID: vi.fn() } }))
vi.mock('./translate', () => ({ t: (key: string) => key }))

const setup = () => {
  const runtime = useRuntimeStore()
  Object.assign(runtime.pioneerDeviceLibrary, {
    selectedSourceKey: 'usb-A',
    selectedSourceRootPath: 'E:/',
    selectedSourceName: 'USB A',
    selectedSourceKind: 'usb',
    selectedLibraryType: 'oneLibrary',
    treeNodes: [{ id: 11, name: 'A', isFolder: false, parentId: 0, sortOrder: 0, children: [] }]
  })
  return runtime
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(libraryUtils.getLibraryTreeByUUID).mockImplementation((uuid) =>
    uuid === 'local' ? { uuid, dirName: 'SET', type: 'setList' } : null
  )
})

describe('DJ playlists in shared song panes', () => {
  it('updates tree labels only for panes belonging to that source without refreshing their rows', () => {
    const runtime = setup()
    openDjPlaylist(runtime, 11)
    const first = runtime.songsArea
    Object.assign(runtime.pioneerDeviceLibrary, {
      selectedSourceKey: 'usb-B',
      selectedSourceRootPath: 'F:/'
    })
    openDjPlaylist(runtime, 11, 'right')
    const second = runtime.songsAreaPanels.panes.right
    const rows = first.songInfoArr
    const secondTree = second.djPlaylist!.browser.treeNodes
    runtime.pioneerDeviceLibrary.selectedSourceKey = 'usb-A'
    runtime.pioneerDeviceLibrary.treeNodes = [
      { ...runtime.pioneerDeviceLibrary.treeNodes[0], name: 'Renamed' }
    ]
    syncDjPlaylistTree(runtime)
    expect(first.djPlaylist!.browser.treeNodes[0].name).toBe('Renamed')
    expect(first.songInfoArr).toBe(rows)
    expect(second.djPlaylist!.browser.treeNodes).toBe(secondTree)
  })
  it('retains the current local view when opening a USB playlist in the other pane', () => {
    const runtime = setup()
    runtime.songsArea.songListUUID = 'local'
    runtime.songsArea.searchQuery = 'keep search'
    runtime.songsArea.scrollTop = 120
    const local = runtime.songsArea
    openDjPlaylist(runtime, 11, 'right')
    expect(runtime.songsAreaPanels.panes.left).toBe(local)
    expect(local.searchQuery).toBe('keep search')
    expect(local.scrollTop).toBe(120)
    expect(runtime.songsAreaPanels.panes.right.djPlaylist?.browser.selectedPlaylistId).toBe(11)
    exitSongsAreaSplit(runtime, 'right')
    expect(runtime.songsArea.djPlaylist?.browser.selectedSourceKey).toBe('usb-A')
  })

  it('keeps two device sources independent from the current sidebar source', () => {
    const runtime = setup()
    openDjPlaylist(runtime, 11)
    const leftSource = runtime.songsArea
    leftSource.searchQuery = 'left query'
    Object.assign(runtime.pioneerDeviceLibrary, {
      selectedSourceKey: 'usb-B',
      selectedSourceRootPath: 'F:/',
      selectedSourceName: 'USB B'
    })
    openDjPlaylist(runtime, 11, 'right')
    const left = usePioneerPaneSource(runtime.songsAreaPanels.panes.left)
    const right = usePioneerPaneSource(runtime.songsAreaPanels.panes.right)
    expect(left.selectedSourceRootPath.value).toBe('E:/')
    expect(right.selectedSourceRootPath.value).toBe('F:/')
    expect(runtime.songsAreaPanels.panes.left.searchQuery).toBe('left query')
    expect(runtime.songsAreaPanels.panes.right.searchQuery).toBe('')
    showSongListInPane(runtime, 'right', 'local')
    expect(runtime.songsAreaPanels.panes.right.djPlaylist).toBeUndefined()
    expect(left.selectedSourceRootPath.value).toBe('E:/')
  })

  it('does no list assignment when reselecting the same USB playlist', () => {
    const runtime = setup()
    openDjPlaylist(runtime, 11)
    runtime.songsArea.songInfoArr = [{ filePath: 'E:/a.mp3' } as ISongInfo]
    runtime.songsArea.selectedSongFilePath = ['row-1']
    const rows = runtime.songsArea.songInfoArr
    const selection = runtime.songsArea.selectedSongFilePath
    openDjPlaylist(runtime, 11)
    expect(runtime.songsArea.songInfoArr).toBe(rows)
    expect(runtime.songsArea.selectedSongFilePath).toBe(selection)
  })
})
