// Run: pnpm exec vitest run src/renderer/src/pages/modules/songsArea/composables/usePlaylistColumnSettings.spec.ts
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IDir, ISongInfo, ISongsAreaColumn } from 'src/types/globals'
import { useRuntimeStore, type SongsAreaPaneKey } from '@renderer/stores/runtime'
import { usePlaylistViewSettingsStore } from '@renderer/stores/playlistViewSettings'
import { diffLibraryTreeExecuteFileOperation } from '@renderer/utils/libraryUtils'
import { useSongsAreaColumns } from './useSongsAreaColumns'

vi.mock('@renderer/components/confirmDialog', () => ({ default: vi.fn() }))

const memory = new Map<string, string>()
const scopes: ReturnType<typeof effectScope>[] = []
const tree = (): IDir => ({
  uuid: 'library-id',
  type: 'root',
  dirName: 'library',
  children: [
    {
      uuid: 'filter-library',
      type: 'library',
      dirName: 'FilterLibrary',
      children: [
        { uuid: 'a', type: 'songList', dirName: 'A' },
        { uuid: 'b', type: 'songList', dirName: 'B' },
        {
          uuid: 'folder',
          type: 'dir',
          dirName: 'folder',
          children: [{ uuid: 'c', type: 'songList', dirName: 'C' }]
        }
      ]
    }
  ]
})
const songs = [
  { filePath: 'one.mp3', title: 'One', bpm: 120, key: 'Am', playlistTrackNumber: 1 },
  { filePath: 'two.mp3', title: 'Two', bpm: 130, key: 'B', playlistTrackNumber: 2 }
] as ISongInfo[]

const mount = (uuid = 'a', pane: SongsAreaPaneKey = 'single') => {
  const runtime = useRuntimeStore()
  const state = runtime.songsAreaPanels.panes[pane]
  state.songListUUID = uuid
  const scope = effectScope()
  scopes.push(scope)
  const columns = scope.run(() =>
    useSongsAreaColumns({
      runtime,
      songsAreaState: state,
      originalSongInfoArr: shallowRef([...songs]),
      shouldPersistToLocalStorage: () => true
    })
  )!
  columns.applyFiltersAndSorting()
  const toggle = (enabled: boolean) =>
    usePlaylistViewSettingsStore().setIndependent(
      runtime.libraryTree.uuid,
      state.songListUUID,
      'default',
      enabled,
      state.compatibleKeyOnly,
      runtime.setting.persistSongFilters
    )
  const update = (key: string, patch: Partial<ISongsAreaColumn>) => {
    columns.handleColumnsUpdate(
      columns.columnData.value.map((column) =>
        column.key === key ? { ...column, ...patch } : column
      )
    )
  }
  const col = (key: string) => columns.columnData.value.find((column) => column.key === key)!
  return { runtime, state, columns, toggle, update, col }
}

beforeEach(() => {
  memory.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key)
  })
  setActivePinia(createPinia())
  useRuntimeStore().libraryTree = tree()
})
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('playlist list settings', () => {
  it('copies the visible shared settings without changing rows, selection or scroll', () => {
    const view = mount()
    view.update('title', { width: 420 })
    view.state.selectedSongFilePath = ['one.mp3']
    view.state.scrollTop = 80
    const rows = view.state.songInfoArr
    const selection = view.state.selectedSongFilePath
    view.toggle(true)
    expect(view.col('title').width).toBe(420)
    expect(view.state.songInfoArr).toBe(rows)
    expect(view.state.selectedSongFilePath).toBe(selection)
    expect(view.state.scrollTop).toBe(80)
    view.toggle(false)
    expect(view.state.songInfoArr).toBe(rows)
    expect(view.state.selectedSongFilePath).toBe(selection)
  })

  it('isolates widths, visibility, ordering, sorting and filters; restores both profiles', async () => {
    const view = mount()
    view.toggle(true)
    view.update('title', { width: 450, filterActive: true, filterValue: 'One' })
    view.columns.handleToggleColumnVisibility('artist')
    view.columns.colMenuClick(view.col('bpm'))
    view.columns.handleColumnsUpdate([...view.columns.columnData.value].reverse())
    const privateColumns = JSON.stringify(view.columns.columnData.value)
    expect(view.state.songInfoArr.map((song) => song.filePath)).toEqual(['one.mp3'])
    expect(memory.has('songColumnData')).toBe(false)
    view.state.songListUUID = 'b'
    await nextTick()
    expect(view.columns.independentSettings.value).toBe(false)
    expect(view.col('title').filterActive).not.toBe(true)
    view.update('title', { width: 600 })
    view.state.songListUUID = 'a'
    await nextTick()
    expect(JSON.stringify(view.columns.columnData.value)).toBe(privateColumns)
    view.toggle(false)
    expect(view.col('title').width).toBe(600)
    expect(view.state.songInfoArr).toHaveLength(2)
    view.toggle(true)
    expect(JSON.stringify(view.columns.columnData.value)).toBe(privateColumns)
    expect(
      JSON.parse(memory.get('songColumnData')!).find((c: ISongsAreaColumn) => c.key === 'title')
        .width
    ).toBe(600)
  })

  it('shares private settings across panes while keeping searches independent', async () => {
    const left = mount('a', 'left')
    const right = mount('a', 'right')
    const other = mount('b', 'single')
    left.toggle(true)
    left.update('title', { width: 490 })
    expect(right.columns.independentSettings.value).toBe(true)
    expect(right.col('title').width).toBe(490)
    expect(other.col('title').width).not.toBe(490)
    left.state.compatibleKeyOnly = true
    await nextTick()
    expect(right.state.compatibleKeyOnly).toBe(true)
    expect(other.state.compatibleKeyOnly).toBe(false)
    right.state.searchQuery = 'Two'
    expect(left.state.searchQuery).toBe('')
    left.toggle(false)
    expect(right.columns.independentSettings.value).toBe(false)
    expect(right.state.searchQuery).toBe('Two')
    left.update('title', { width: 610 })
    expect(right.col('title').width).toBe(610)
    expect(other.col('title').width).toBe(610)
    left.toggle(true)
    expect(right.col('title').width).toBe(490)
  })

  it.each([false, true])(
    'restores persistent settings and obeys remember-filters=%s',
    (persistFilters) => {
      const view = mount()
      view.toggle(true)
      view.update('title', { width: 470, filterActive: true, filterValue: 'One' })
      view.state.compatibleKeyOnly = true
      scopes.splice(0).forEach((scope) => scope.stop())
      setActivePinia(createPinia())
      useRuntimeStore().libraryTree = tree()
      useRuntimeStore().setting.persistSongFilters = persistFilters
      const restored = mount()
      expect(restored.columns.independentSettings.value).toBe(true)
      expect(restored.col('title').width).toBe(470)
      expect(restored.col('title').filterActive === true).toBe(persistFilters)
      expect(restored.state.compatibleKeyOnly).toBe(true)
    }
  )

  it('does not overwrite saved compatibility during a split-pane state copy', async () => {
    const left = mount('a', 'left')
    const right = mount('b', 'right')
    left.toggle(true)
    left.state.compatibleKeyOnly = true
    left.runtime.assignSongsAreaPaneState('right', {
      songListUUID: 'a',
      compatibleKeyOnly: false
    })
    await nextTick()
    expect(left.state.compatibleKeyOnly).toBe(true)
    expect(right.state.compatibleKeyOnly).toBe(true)
    expect(
      usePlaylistViewSettingsStore().getPlaylist('library-id', 'a', false)?.compatibleKeyOnly
    ).toBe(true)
  })

  it('can reset a private profile to the latest shared settings while keeping it independent', () => {
    const view = mount()
    view.update('title', { width: 430 })
    view.toggle(true)
    view.update('title', { width: 560, filterActive: true, filterValue: 'One' })
    view.columns.resetToSharedSettings()
    expect(view.columns.independentSettings.value).toBe(true)
    expect(view.col('title').width).toBe(430)
    expect(view.col('title').filterActive).not.toBe(true)
    expect(view.state.songInfoArr).toHaveLength(2)
  })

  it('keeps settings through rename and move, and isolates different library identities', () => {
    const view = mount()
    view.toggle(true)
    view.update('title', { width: 510 })
    const root = view.runtime.libraryTree
    const source = root.children![0].children!
    const node = source.shift()!
    node.dirName = 'renamed'
    source[1].children!.push(node)
    const store = usePlaylistViewSettingsStore()
    store.pruneDeletedPlaylists(root, false)
    expect(
      store.getPlaylist(root.uuid, 'a', false)?.columns.find((column) => column.key === 'title')
        ?.width
    ).toBe(510)
    expect(store.getPlaylist('another-library', 'a', false)).toBeUndefined()
  })
})

describe('confirmed playlist deletion cleanup', () => {
  const prepare = () => {
    const view = mount('c')
    view.toggle(true)
    view.update('title', { width: 550 })
    view.toggle(false) // 未启用但保留的设置也必须删除。
    view.runtime.oldLibraryTree = structuredClone(tree())
    view.runtime.libraryTree.children![0].children!.pop()
    return view
  }

  it('removes nested disabled profiles only after successful deletion, including disk data', async () => {
    const view = prepare()
    const store = usePlaylistViewSettingsStore()
    expect(store.getPlaylist('library-id', 'c', false)).toBeDefined()
    const invoke = vi.fn().mockResolvedValue({ success: true, details: [] })
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    expect(await diffLibraryTreeExecuteFileOperation()).toBe(true)
    expect(store.getPlaylist('library-id', 'c', false)).toBeUndefined()
    expect(memory.has('playlistViewSettings:v1:library-id')).toBe(false)
    view.columns.persistColumnData()
    expect(store.getPlaylist('library-id', 'c', false)).toBeUndefined()
    expect(memory.has('playlistViewSettings:v1:library-id')).toBe(false)
  })

  it('keeps settings when deletion fails and the confirmed tree still has the playlist', async () => {
    prepare()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'blocked' })
      .mockResolvedValueOnce(tree())
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    expect(await diffLibraryTreeExecuteFileOperation()).toBe(false)
    expect(usePlaylistViewSettingsStore().getPlaylist('library-id', 'c', false)).toBeDefined()
    expect(memory.has('playlistViewSettings:v1:library-id')).toBe(true)
  })

  it('prunes persisted orphan profiles on reload without deleting a different library profile', () => {
    const view = mount()
    view.toggle(true)
    const store = usePlaylistViewSettingsStore()
    store.setIndependent('other-library', 'a', 'default', true, false, false)
    const root = tree()
    root.children![0].children!.shift()
    store.pruneDeletedPlaylists(root, false)
    expect(memory.has('playlistViewSettings:v1:library-id')).toBe(false)
    expect(store.getPlaylist('other-library', 'a', false)).toBeDefined()
  })

  it('removes active profiles and cannot resurrect them from a closing pane', () => {
    const view = mount()
    view.toggle(true)
    view.update('title', { width: 590 })
    const store = usePlaylistViewSettingsStore()
    view.runtime.libraryTree.children![0].children!.shift()
    store.pruneDeletedPlaylists(view.runtime.libraryTree, false)
    view.columns.persistColumnData()
    expect(store.getPlaylist('library-id', 'a', false)).toBeUndefined()
    expect(memory.has('playlistViewSettings:v1:library-id')).toBe(false)
  })

  it('removes all folder descendants while keeping unrelated playlist settings', async () => {
    const view = mount()
    view.toggle(true)
    const store = usePlaylistViewSettingsStore()
    store.setIndependent('library-id', 'c', 'default', true, false, false)
    view.runtime.oldLibraryTree = structuredClone(tree())
    view.runtime.libraryTree.children![0].children!.pop()
    vi.stubGlobal('window', {
      electron: {
        ipcRenderer: { invoke: vi.fn().mockResolvedValue({ success: true, details: [] }) }
      }
    })
    await diffLibraryTreeExecuteFileOperation()
    expect(store.getPlaylist('library-id', 'c', false)).toBeUndefined()
    expect(store.getPlaylist('library-id', 'a', false)).toBeDefined()
    expect(Object.keys(JSON.parse(memory.get('playlistViewSettings:v1:library-id')!))).toEqual([
      'a'
    ])
  })

  it('does not clean a later optimistic deletion when an earlier operation succeeds', async () => {
    const view = mount()
    view.toggle(true)
    const store = usePlaylistViewSettingsStore()
    store.setIndependent('library-id', 'c', 'default', true, false, false)
    view.runtime.oldLibraryTree = structuredClone(tree())
    view.runtime.libraryTree.children![0].children!.shift()
    let finish!: (value: unknown) => void
    const result = new Promise((resolve) => {
      finish = resolve
    })
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke: () => result } } })
    const operation = diffLibraryTreeExecuteFileOperation()
    view.runtime.libraryTree.children![0].children!.pop()
    finish({ success: true, details: [] })
    await operation
    expect(store.getPlaylist('library-id', 'a', false)).toBeUndefined()
    expect(store.getPlaylist('library-id', 'c', false)).toBeDefined()
  })
})
