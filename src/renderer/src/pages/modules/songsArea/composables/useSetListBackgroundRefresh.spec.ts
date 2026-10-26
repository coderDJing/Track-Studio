// Run: pnpm exec vitest run src/renderer/src/pages/modules/songsArea/composables/useSetListBackgroundRefresh.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, shallowRef } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { useSongsLoader } from './useSongsLoader'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), dispose: [] as Array<() => void> }))
vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  onUnmounted: (dispose: () => void) => mocks.dispose.push(dispose)
}))
vi.mock('@renderer/utils/libraryUtils', () => ({
  default: { getLibraryTreeByUUID: () => ({ type: 'setList' }) }
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))

const UUID = 'set-playlist'
const scopes: ReturnType<typeof effectScope>[] = []
const song = (id: string, filePath = `D:/Music/${id}.mp3`): ISongInfo => ({
  setItemId: id,
  filePath,
  fileName: `${id}.mp3`,
  fileFormat: 'MP3',
  cover: null,
  title: id,
  artist: undefined,
  album: undefined,
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type LoadResult = { songListUUID: string; scanData: ISongInfo[] }
const changed = (uuid = UUID) => emitter.emit('setList/itemsChanged', { uuids: [uuid] })
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue({})
  setActivePinia(createPinia())
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
  mocks.dispose.splice(0).forEach((dispose) => dispose())
  scopes.splice(0).forEach((scope) => scope.stop())
  emitter.all.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const setup = (initial = [song('one')]) => {
  const runtime = useRuntimeStore()
  runtime.setting.platform = 'win32'
  const state = runtime.songsArea
  state.songListUUID = UUID
  state.songInfoArr = initial
  const original = shallowRef<ISongInfo[]>([])
  const apply = vi.fn(() => {
    state.songInfoArr = original.value
    state.totalSongCount = original.value.length
  })
  const scope = effectScope()
  scopes.push(scope)
  const loader = scope.run(() =>
    useSongsLoader({
      runtime,
      songsAreaState: state,
      originalSongInfoArr: original,
      applyFiltersAndSorting: apply
    })
  )!
  return { runtime, state, original, apply, loader }
}

describe('set membership background refresh', () => {
  it('merges a slow append without loading or replacing existing rows and view state', async () => {
    const { runtime, state, original, apply, loader } = setup()
    const oldRow = original.value[0]
    state.scrollTop = 420
    state.selectedSongFilePath = ['one']
    runtime.playingData.playingSongListUUID = UUID
    runtime.playingData.playingSong = oldRow
    const renderCount = loader.renderCount.value
    const response = deferred<LoadResult>()
    mocks.invoke.mockImplementation((channel: string) =>
      channel === 'setList:load-items' ? response.promise : Promise.resolve({})
    )
    changed()
    await vi.advanceTimersByTimeAsync(500)
    expect(loader.loadingShow.value).toBe(false)
    expect(loader.isRequesting.value).toBe(false)
    expect(original.value[0]).toBe(oldRow)
    response.resolve({ songListUUID: UUID, scanData: [{ ...oldRow }, song('two')] })
    await flush()
    expect(original.value).toHaveLength(2)
    expect(original.value[0]).toBe(oldRow)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(state.scrollTop).toBe(420)
    expect(state.selectedSongFilePath).toEqual(['one'])
    expect(runtime.playingData.playingSong?.setItemId).toBe('one')
    expect(loader.renderCount.value).toBe(renderCount)
    expect(loader.loadingShow.value).toBe(false)
  })

  it('does no UI work for unchanged content and keeps duplicate files as separate set entries', async () => {
    const { state, original, apply } = setup([song('one'), song('two', 'D:/Music/one.mp3')])
    const oldList = original.value
    const visibleList = state.songInfoArr
    const selection = state.selectedSongFilePath
    mocks.invoke.mockResolvedValue({
      songListUUID: UUID,
      scanData: oldList.map((item) => ({ ...item }))
    })
    changed()
    await flush()
    expect(original.value).toBe(oldList)
    expect(state.songInfoArr).toBe(visibleList)
    expect(state.selectedSongFilePath).toBe(selection)
    expect(apply).not.toHaveBeenCalled()
  })

  it('coalesces notifications and discards an old in-flight result when a newer change arrives', async () => {
    const { original, apply } = setup()
    const first = deferred<LoadResult>()
    const second = deferred<LoadResult>()
    mocks.invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    changed()
    changed()
    changed('another-set')
    await flush()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    changed()
    changed()
    await flush()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    first.resolve({ songListUUID: UUID, scanData: [song('stale')] })
    await flush()
    expect(apply).not.toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
    second.resolve({ songListUUID: UUID, scanData: [song('one'), song('latest')] })
    await flush()
    expect(original.value.map((item) => item.setItemId)).toEqual(['one', 'latest'])
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('ignores a response from before navigating away and back to the same UUID', async () => {
    const { state, original, apply } = setup()
    const before = original.value
    const response = deferred<LoadResult>()
    mocks.invoke.mockReturnValue(response.promise)
    changed()
    await flush()
    state.songListUUID = 'another-set'
    state.songListUUID = UUID
    response.resolve({ songListUUID: UUID, scanData: [song('stale')] })
    await flush()
    expect(original.value).toBe(before)
    expect(apply).not.toHaveBeenCalled()
  })

  it('defers a change during initial opening until the foreground request settles', async () => {
    const { original, loader } = setup([])
    const opened = deferred<LoadResult>()
    let loads = 0
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel !== 'setList:load-items') return Promise.resolve({})
      loads += 1
      return loads === 1
        ? opened.promise
        : Promise.resolve({
            songListUUID: UUID,
            scanData: [song('one'), song('two')]
          })
    })
    const opening = loader.openSongList()
    changed()
    await flush()
    expect(loads).toBe(1)
    opened.resolve({ songListUUID: UUID, scanData: [song('one')] })
    await opening
    await flush()
    expect(loads).toBe(2)
    expect(original.value.map((item) => item.setItemId)).toEqual(['one', 'two'])
    expect(loader.loadingShow.value).toBe(false)
  })

  it('does not apply an in-flight result after unmount', async () => {
    const { original, apply } = setup()
    const before = original.value
    const response = deferred<LoadResult>()
    mocks.invoke.mockReturnValue(response.promise)
    changed()
    await flush()
    mocks.dispose.splice(0).forEach((dispose) => dispose())
    response.resolve({ songListUUID: UUID, scanData: [song('two')] })
    await flush()
    changed()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(original.value).toBe(before)
    expect(apply).not.toHaveBeenCalled()
  })
})
