import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive, ref, shallowRef } from 'vue'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'
import type { SongListWaveformWorkerIncoming } from '@renderer/workers/songListWaveformPreview.types'
import type { WaveformUpdatedHandler } from './waveformPreviewIpcSubscriptions'
import emitter from '@renderer/utils/mitt'
import { useWaveformPreview } from './useWaveformPreview'

const lifecycle = vi.hoisted(() => ({ cleanup: [] as Array<() => void> }))
const subscriptions = vi.hoisted(() => ({ updated: null as WaveformUpdatedHandler | null }))
vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  onBeforeUnmount: (callback: () => void) => lifecycle.cleanup.push(callback)
}))
vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => runtime }))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/workers/songListWaveformPreview.workerClient', () => ({
  createSongListWaveformPreviewWorker: () => worker
}))
vi.mock('./waveformPreviewIpcSubscriptions', () => ({
  subscribeWaveformUpdated: (callback: WaveformUpdatedHandler) => {
    subscriptions.updated = callback
    return () => {
      subscriptions.updated = null
    }
  },
  subscribePioneerPreviewWaveformItem: () => () => {},
  subscribePioneerPreviewWaveformDone: () => () => {}
}))

const runtime = reactive({
  setting: { waveformMode: 'half', themeMode: 'light', accentColor: '#0066cc' },
  pioneerDeviceLibrary: { selectedSourceKind: undefined }
})
const worker = {
  postMessage: vi.fn<(message: SongListWaveformWorkerIncoming) => void>(),
  addEventListener: vi.fn(),
  terminate: vi.fn()
}
const invoke = vi.fn(async (_channel: string, payload: { filePaths: string[] }) => ({
  items: payload.filePaths.map((filePath) => ({ filePath, data: null }))
}))
const rafs = new Map<number, FrameRequestCallback>()
let rafSequence = 0
const scopes: ReturnType<typeof effectScope>[] = []
const pathFor = (index: number) => `C:\\music\\song-${index}.mp3`
const songFor = (index: number): ISongInfo => ({
  filePath: pathFor(index),
  fileName: `song-${index}.mp3`,
  fileFormat: 'mp3',
  cover: null,
  title: undefined,
  artist: undefined,
  album: undefined,
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined
})
const canvas = () =>
  ({
    clientWidth: 200,
    clientHeight: 24,
    transferControlToOffscreen: vi.fn(() => ({}))
  }) as unknown as HTMLCanvasElement
const renders = () =>
  worker.postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === 'render')
const renderedPaths = () => renders().map((message) => message.payload.filePath)

beforeEach(() => {
  vi.useFakeTimers()
  lifecycle.cleanup.length = 0
  worker.postMessage.mockClear()
  invoke.mockClear()
  rafs.clear()
  runtime.setting.waveformMode = 'half'
  runtime.setting.themeMode = 'light'
  runtime.setting.accentColor = '#0066cc'
  vi.stubGlobal('window', { devicePixelRatio: 1.5, electron: { ipcRenderer: { invoke } } })
  vi.stubGlobal('Worker', class {})
  vi.stubGlobal('OffscreenCanvas', class {})
  vi.stubGlobal(
    'HTMLCanvasElement',
    class {
      transferControlToOffscreen() {
        return {}
      }
    }
  )
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (key: string) => (key === '--accent' ? runtime.setting.accentColor : '#ddd')
  }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++rafSequence
    rafs.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => rafs.delete(id))
})
afterEach(() => {
  for (const callback of lifecycle.cleanup) callback()
  for (const scope of scopes.splice(0)) scope.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const flushDraw = async () => {
  await nextTick()
  await nextTick()
  const pending = [...rafs.values()]
  rafs.clear()
  for (const callback of pending) callback(0)
}
const flushLoad = async () => {
  await vi.advanceTimersByTimeAsync(120)
  await flushDraw()
}
const mountWaveforms = (count = 3) => {
  const visibleSongsWithIndex = shallowRef(
    Array.from({ length: count }, (_, idx) => ({ song: songFor(idx), idx }))
  )
  const visibleColumns = ref<ISongsAreaColumn[]>([
    { key: 'waveformPreview', columnName: 'Waveform', show: true, width: 250 }
  ])
  const scope = effectScope()
  scopes.push(scope)
  const preview = scope.run(() =>
    useWaveformPreview({
      visibleSongsWithIndex,
      visibleColumns,
      sourceLibraryName: ref('library'),
      sourceSongListUUID: ref('playlist'),
      sourcePaneKey: ref(''),
      songListRootDir: ref('library/playlist'),
      externalWaveformRootPath: ref(undefined),
      actualVisibleStartIndex: ref(0),
      actualVisibleEndIndex: ref(count)
    })
  )!
  const canvases = new Map(Array.from({ length: count }, (_, idx) => [pathFor(idx), canvas()]))
  for (const [filePath, element] of canvases)
    preview.setWaveformCanvasRef(filePath, filePath, element)
  return { preview, visibleSongsWithIndex, visibleColumns, canvases }
}

describe('list waveform redraw work follows changed surfaces', () => {
  it('redraws only the entering row when a 50-row viewport advances by one', async () => {
    const mounted = mountWaveforms(50)
    await flushDraw()
    await flushLoad()
    worker.postMessage.mockClear()
    mounted.preview.setWaveformCanvasRef(pathFor(0), pathFor(0), null)
    mounted.visibleSongsWithIndex.value = Array.from({ length: 50 }, (_, offset) => ({
      song: songFor(offset + 1),
      idx: offset + 1
    }))
    for (let idx = 1; idx < 50; idx++)
      mounted.preview.setWaveformCanvasRef(
        pathFor(idx),
        pathFor(idx),
        mounted.canvases.get(pathFor(idx))!
      )
    mounted.preview.setWaveformCanvasRef(pathFor(50), pathFor(50), canvas())
    await flushDraw()
    expect(renderedPaths()).toEqual([pathFor(50)])
    await flushLoad()
    expect(invoke.mock.calls.at(-1)?.[1].filePaths).toEqual([pathFor(50)])
    expect(renderedPaths()).toEqual([pathFor(50), pathFor(50)])
  })

  it('does not redraw reused refs or a cached viewport load', async () => {
    const mounted = mountWaveforms()
    await flushLoad()
    worker.postMessage.mockClear()
    for (const [filePath, element] of mounted.canvases)
      mounted.preview.setWaveformCanvasRef(filePath, filePath, element)
    mounted.visibleSongsWithIndex.value = [...mounted.visibleSongsWithIndex.value].reverse()
    await flushDraw()
    await flushLoad()
    expect(renders()).toHaveLength(0)
  })

  it.each(['theme', 'accent', 'width', 'mode'] as const)(
    'still redraws every visible canvas for %s changes',
    async (change) => {
      const mounted = mountWaveforms()
      await flushLoad()
      worker.postMessage.mockClear()
      if (change === 'theme') runtime.setting.themeMode = 'dark'
      if (change === 'accent') runtime.setting.accentColor = '#cc6600'
      if (change === 'width') mounted.visibleColumns.value[0].width = 300
      if (change === 'mode') runtime.setting.waveformMode = 'full'
      await flushDraw()
      expect(renderedPaths()).toEqual([pathFor(0), pathFor(1), pathFor(2)])
      if (change === 'theme')
        expect(renders().every((message) => message.payload.themeVariant === 'dark')).toBe(true)
      if (change === 'mode')
        expect(renders().every((message) => !message.payload.isHalf)).toBe(true)
    }
  )

  it('syncs and redraws a same canvas rebound to another file without retransferring it', async () => {
    const mounted = mountWaveforms()
    await flushLoad()
    worker.postMessage.mockClear()
    const element = mounted.canvases.get(pathFor(0))!
    mounted.preview.setWaveformCanvasRef(pathFor(0), pathFor(1), element)
    await flushDraw()
    expect(new Set(renders().map((message) => message.payload.canvasId))).toEqual(
      new Set([pathFor(0), pathFor(1)])
    )
    expect(
      worker.postMessage.mock.calls.some(
        ([message]) => message.type === 'clearData' && message.payload.filePath === pathFor(1)
      )
    ).toBe(true)
    expect(element.transferControlToOffscreen).toHaveBeenCalledTimes(1)
  })

  it('redraws just the affected canvas after data refresh and preview progress', async () => {
    mountWaveforms()
    await flushLoad()
    worker.postMessage.mockClear()
    subscriptions.updated?.(null, { filePath: pathFor(1) })
    await flushDraw()
    expect(renderedPaths()).toEqual([pathFor(1)])
    worker.postMessage.mockClear()
    emitter.emit('waveform-preview:progress', { filePath: pathFor(2), percent: 0.4 })
    expect(renderedPaths()).toEqual([pathFor(2)])
    expect(renders()[0].payload.playedPercent).toBe(0.4)
  })

  it('redraws the changed timeline duration while preserving unchanged rows and bindings', async () => {
    const mounted = mountWaveforms()
    await flushLoad()
    worker.postMessage.mockClear()
    mounted.visibleSongsWithIndex.value = mounted.visibleSongsWithIndex.value.map((item) =>
      item.idx === 1 ? { ...item, song: { ...item.song, duration: '04:00' } } : item
    )
    for (const [filePath, element] of mounted.canvases)
      mounted.preview.setWaveformCanvasRef(filePath, filePath, element)
    await flushDraw()
    expect(renderedPaths()).toEqual([pathFor(1)])
    expect(renders()[0].payload.durationSec).toBe(240)
  })

  it('preserves a device pixel ratio change when an unchanged canvas ref is refreshed', async () => {
    const mounted = mountWaveforms()
    await flushLoad()
    worker.postMessage.mockClear()
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, writable: true })
    for (const [filePath, element] of mounted.canvases)
      mounted.preview.setWaveformCanvasRef(filePath, filePath, element)
    await flushDraw()
    expect(renderedPaths()).toEqual([pathFor(0), pathFor(1), pathFor(2)])
    expect(renders().every((message) => message.payload.pixelRatio === 2)).toBe(true)
  })
})
