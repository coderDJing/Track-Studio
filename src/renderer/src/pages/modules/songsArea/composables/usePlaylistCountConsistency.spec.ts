import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref, shallowRef } from 'vue'
import type { IDir, ISongInfo } from '../../../../../../types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { libraryTreeTrackCountMap } from '@renderer/utils/libraryTreeSort'
import { useLibraryTrackCount } from '@renderer/components/libraryItem/useLibraryTrackCount'
import { useSongsLoader } from './useSongsLoader'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), dispose: [] as Array<() => void> }))

vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  onMounted: vi.fn(),
  onUnmounted: (dispose: () => void) => mocks.dispose.push(dispose)
}))
vi.mock('@renderer/utils/libraryUtils', () => ({
  default: {
    findDirPathByUuid: () => 'library/FilterLibrary/AI歌曲',
    getLibraryTreeByUUID: () => ({ type: 'songList' })
  }
}))
vi.mock('@renderer/utils/libraryTreeSort', async () => {
  const { reactive } = await import('vue')
  const counts = reactive<Record<string, number>>({})
  return {
    libraryTreeTrackCountMap: counts,
    setLibraryTreeTrackCount: (uuid: string, count: number) => {
      counts[uuid] = count
    }
  }
})
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/composables/mixtape/mixtapeSnapshotSongMapper', () => ({
  mapMixtapeSnapshotToSongInfo: vi.fn()
}))

const UUID = 'ai-playlist'
const scopes: ReturnType<typeof effectScope>[] = []
const songs = (count: number): ISongInfo[] =>
  Array.from({ length: count }, (_, index) => ({
    filePath: `E:/FRKB_database/library/FilterLibrary/AI歌曲/${index}.wav`,
    fileName: `${index}.wav`,
    fileFormat: 'WAV',
    cover: null,
    title: `${index}`,
    artist: undefined,
    album: undefined,
    duration: '03:00',
    genre: undefined,
    label: undefined,
    bitrate: undefined,
    container: 'WAVE'
  }))

beforeEach(() => {
  vi.useFakeTimers()
  mocks.invoke.mockReset()
  setActivePinia(createPinia())
  for (const key of Object.keys(libraryTreeTrackCountMap)) delete libraryTreeTrackCountMap[key]
  const frame = (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  }
  vi.stubGlobal('requestAnimationFrame', frame)
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: frame,
    electron: { ipcRenderer: { invoke: mocks.invoke, on: () => () => {}, send: vi.fn() } }
  })
})

afterEach(() => {
  for (const dispose of mocks.dispose.splice(0)) dispose()
  for (const scope of scopes.splice(0)) scope.stop()
  emitter.all.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const mount = () => {
  const runtime = useRuntimeStore()
  runtime.setting.platform = 'win32'
  runtime.setting.showPlaylistTrackCount = true
  runtime.songsArea.songListUUID = UUID
  const original = shallowRef<ISongInfo[]>([])
  const appliedCounts: number[] = []
  const scope = effectScope()
  scopes.push(scope)
  const hooks = scope.run(() => ({
    badge: useLibraryTrackCount({
      runtime,
      props: { uuid: UUID },
      dirDataRef: ref<IDir>({ uuid: UUID, dirName: 'AI歌曲', type: 'songList' })
    }),
    loader: useSongsLoader({
      runtime,
      songsAreaState: runtime.songsArea,
      originalSongInfoArr: original,
      applyFiltersAndSorting: () => {
        runtime.songsArea.songInfoArr = original.value
        runtime.songsArea.totalSongCount = original.value.length
        appliedCounts.push(original.value.length)
      }
    })
  }))!
  return { runtime, original, appliedCounts, ...hooks }
}

describe('playlist snapshot and disk count consistency', () => {
  it('does not replace a 1916-track badge with a 1001-row displayed snapshot', async () => {
    libraryTreeTrackCountMap[UUID] = 1916
    mocks.invoke.mockResolvedValue(1916)
    const { runtime, badge } = mount()
    runtime.songsArea.totalSongCount = 1001
    emitter.emit('playlistContentChanged', { uuids: [UUID] })
    expect(badge.trackCount.value).toBe(1916)
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.invoke).toHaveBeenCalledWith(
      'getSongListTrackCount',
      'library/FilterLibrary/AI歌曲'
    )
    expect(badge.trackCount.value).toBe(1916)
  })

  it('rejects the conflicting snapshot and displays the complete verified scan once', async () => {
    libraryTreeTrackCountMap[UUID] = 1916
    const complete = songs(1916)
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'playlist:fast-open') return { hit: true, revision: 286, items: songs(1001) }
      if (channel === 'song-search:playlist-fast-load') return { hit: false }
      if (channel === 'scanSongList') return { songListUUID: UUID, scanData: complete }
      if (channel === 'getSongListTrackCount') return 1916
      return {}
    })
    const { loader, original, appliedCounts, badge } = mount()
    await loader.openSongList()
    await vi.advanceTimersByTimeAsync(200)
    expect(original.value).toHaveLength(1916)
    expect(appliedCounts).toEqual([1916])
    expect(badge.trackCount.value).toBe(1916)
    expect(mocks.invoke).toHaveBeenCalledWith('playlist:fast-open', {
      songListUUID: UUID,
      songListPath: 'library/FilterLibrary/AI歌曲',
      expectedTrackCount: 1916
    })
    expect(mocks.invoke).toHaveBeenCalledWith(
      'scanSongList',
      expect.any(String),
      UUID,
      expect.any(Object)
    )
  })

  it('accepts a real lower disk count instead of keeping the largest historical value', async () => {
    libraryTreeTrackCountMap[UUID] = 1916
    mocks.invoke.mockResolvedValue(1001)
    const { runtime, badge } = mount()
    runtime.songsArea.totalSongCount = 1916
    emitter.emit('playlistContentChanged', { uuids: [UUID] })
    await vi.advanceTimersByTimeAsync(200)
    expect(badge.trackCount.value).toBe(1001)
  })

  it('keeps the fast snapshot path when the known count agrees', async () => {
    libraryTreeTrackCountMap[UUID] = 1916
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'playlist:fast-open') return { hit: true, revision: 1, items: songs(1916) }
      if (channel === 'getSongListTrackCount') return 1916
      return {}
    })
    const { loader, original } = mount()
    await loader.openSongList()
    expect(original.value).toHaveLength(1916)
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).not.toContain('scanSongList')
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).not.toContain(
      'song-search:playlist-fast-load'
    )
  })
})
