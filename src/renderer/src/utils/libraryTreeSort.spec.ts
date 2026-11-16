import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IDir } from 'src/types/globals'

const COUNT_STORAGE_KEY = 'libraryTreeTrackCounts'

const createLocalStorageStub = () => {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear()
  }
}

const invoke = vi.fn()

const installGlobals = (seededCounts?: Record<string, number>) => {
  const localStorage = createLocalStorageStub()
  if (seededCounts) {
    localStorage.setItem(COUNT_STORAGE_KEY, JSON.stringify(seededCounts))
  }
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  return localStorage
}

const loadModule = async () => {
  vi.resetModules()
  vi.doMock('@renderer/utils/libraryUtils', () => ({
    default: { findDirPathByUuid: (uuid: string) => `library/${uuid}` }
  }))
  return import('./libraryTreeSort')
}

const playlist = (uuid: string, dirName: string): IDir =>
  ({ uuid, dirName, type: 'songList', children: [] }) as IDir

const library = (children: IDir[]): IDir =>
  ({ uuid: 'library-root', dirName: 'FilterLibrary', type: 'library', children }) as IDir

describe('libraryTreeSort track counts', () => {
  beforeEach(() => {
    invoke.mockReset()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('seeds counts from localStorage so count sorting is correct on the first frame', async () => {
    installGlobals({ a: 2, b: 10 })
    const mod = await loadModule()
    const root = library([playlist('a', 'Alpha'), playlist('b', 'Bravo')])

    expect(mod.hasCompleteLibraryTreeTrackCounts(root)).toBe(true)
    expect(
      mod.sortLibraryTreeChildren(root.children, 'countDesc').map((item) => item.uuid)
    ).toEqual(['b', 'a'])
  })

  it('reports incomplete counts when a playlist has never been counted', async () => {
    installGlobals({ a: 2 })
    const mod = await loadModule()
    const root = library([playlist('a', 'Alpha'), playlist('b', 'Bravo')])

    expect(mod.hasCompleteLibraryTreeTrackCounts(root)).toBe(false)
  })

  it('prefetches every playlist in one batch call and bumps the version once', async () => {
    installGlobals()
    const mod = await loadModule()
    const root = library([playlist('a', 'Alpha'), playlist('b', 'Bravo'), playlist('c', 'Charlie')])
    invoke.mockResolvedValue({ a: 5, b: 1, c: 9 })

    const versionBefore = mod.libraryTreeTrackCountVersion.value
    await mod.prefetchLibraryTreeTrackCounts(root)

    const batchCalls = invoke.mock.calls.filter(
      ([channel]) => channel === 'playlist:batchTrackCount'
    )
    expect(batchCalls).toHaveLength(1)
    expect(batchCalls[0][1]).toEqual({
      songLists: [
        { uuid: 'a', songListPath: 'library/a' },
        { uuid: 'b', songListPath: 'library/b' },
        { uuid: 'c', songListPath: 'library/c' }
      ]
    })
    // 三个歌单的数量整批落地，只应触发一次重排
    expect(mod.libraryTreeTrackCountVersion.value).toBe(versionBefore + 1)
    expect(mod.sortLibraryTreeChildren(root.children, 'countAsc').map((item) => item.uuid)).toEqual(
      ['b', 'a', 'c']
    )
  })

  it('splits songList and setList counting into one batch call each', async () => {
    installGlobals()
    const mod = await loadModule()
    const setNode = { uuid: 's1', dirName: 'Set', type: 'setList', children: [] } as IDir
    const root = library([playlist('a', 'Alpha'), setNode])
    invoke.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'setList:batchCount' ? { s1: 4 } : { a: 7 })
    )

    await mod.prefetchLibraryTreeTrackCounts(root)

    expect(invoke.mock.calls.map(([channel]) => channel).sort()).toEqual([
      'playlist:batchTrackCount',
      'setList:batchCount'
    ])
    expect(invoke.mock.calls.find(([channel]) => channel === 'setList:batchCount')?.[1]).toEqual([
      's1'
    ])
    expect(mod.libraryTreeTrackCountMap.a).toBe(7)
    expect(mod.libraryTreeTrackCountMap.s1).toBe(4)
  })

  it('coalesces a concurrent prefetch for the same library into a single follow-up run', async () => {
    installGlobals()
    const mod = await loadModule()
    const root = library([playlist('a', 'Alpha')])
    invoke.mockResolvedValue({ a: 3 })

    const first = mod.prefetchLibraryTreeTrackCounts(root)
    const second = mod.prefetchLibraryTreeTrackCounts(root)
    expect(second).toBe(first)
    await first

    // 第一轮 + 被合并的重跑一轮，而不是两轮并发
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'playlist:batchTrackCount')
    ).toHaveLength(2)
  })

  it('drops counts for playlists that no longer exist and persists the rest', async () => {
    const localStorage = installGlobals({ a: 2, stale: 99 })
    const mod = await loadModule()
    vi.useFakeTimers()

    mod.pruneLibraryTreeTrackCounts(library([playlist('a', 'Alpha')]))
    expect(mod.libraryTreeTrackCountMap.stale).toBeUndefined()
    expect(mod.libraryTreeTrackCountMap.a).toBe(2)

    vi.advanceTimersByTime(1100)
    expect(JSON.parse(localStorage.getItem(COUNT_STORAGE_KEY) || '{}')).toEqual({ a: 2 })
  })

  it('keeps unnamed pending playlists first and ignores them in the completeness check', async () => {
    installGlobals({ a: 2 })
    const mod = await loadModule()
    const pending = playlist('pending', '')
    const root = library([playlist('a', 'Alpha'), pending])

    expect(mod.hasCompleteLibraryTreeTrackCounts(root)).toBe(true)
    expect(
      mod.sortLibraryTreeChildren(root.children, 'countDesc').map((item) => item.uuid)
    ).toEqual(['pending', 'a'])
  })

  it('does not batch-count an unnamed pending playlist through its parent directory', async () => {
    installGlobals()
    const mod = await loadModule()
    const pending = playlist('pending', '')
    const root = library([playlist('a', 'Alpha'), pending])
    invoke.mockResolvedValue({ a: 2 })

    await mod.prefetchLibraryTreeTrackCounts(root)

    expect(invoke).toHaveBeenCalledWith('playlist:batchTrackCount', {
      songLists: [{ uuid: 'a', songListPath: 'library/a' }]
    })
    expect(mod.libraryTreeTrackCountMap.pending).toBeUndefined()
  })

  it('takes the count a virtual node carries instead of scanning a directory it does not have', async () => {
    installGlobals()
    const mod = await loadModule()
    // 网易云歌单这类节点：dirName 只是显示名，盘上没有对应目录
    const virtual = {
      uuid: 'netease:pl:1',
      dirName: '我喜欢的音乐',
      type: 'songList',
      children: [],
      trackCount: 12
    } as IDir
    const root = library([virtual, playlist('a', 'Alpha')])
    invoke.mockResolvedValue({ a: 2 })

    await mod.prefetchLibraryTreeTrackCounts(root)

    // 只有真实目录的歌单进统计，虚拟节点绝不送去扫盘
    expect(invoke).toHaveBeenCalledWith('playlist:batchTrackCount', {
      songLists: [{ uuid: 'a', songListPath: 'library/a' }]
    })
    expect(mod.libraryTreeTrackCountMap['netease:pl:1']).toBe(12)
    expect(mod.getLibraryTreeNodeTrackCount(virtual)).toBe(12)
    expect(mod.hasCompleteLibraryTreeTrackCounts(root)).toBe(true)
  })

  it('builds the shared sort menu with a check mark on the current rule', async () => {
    installGlobals()
    const mod = await loadModule()
    const menu = mod.buildLibraryTreeSortMenuArr('nameAsc')
    expect(menu[0]?.[0]).toEqual({ menuName: 'playlist.sortMenuManual', shortcutKey: undefined })
    expect(menu[1]?.[0]).toEqual({ menuName: 'playlist.sortMenuNameAsc', shortcutKey: '✓' })
    expect(mod.resolveLibraryTreeSortRuleFromMenuName('playlist.sortMenuCountDesc')).toBe(
      'countDesc'
    )
    expect(mod.resolveLibraryTreeSortRuleFromMenuName('unknown')).toBeNull()
  })
})
