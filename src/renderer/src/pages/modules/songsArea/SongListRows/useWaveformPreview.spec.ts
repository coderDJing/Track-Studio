import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive, ref, shallowRef } from 'vue'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'
import type { SongListWaveformWorkerIncoming } from '@renderer/workers/songListWaveformPreview.types'
import type { WaveformListPreviewData } from '@shared/waveformSurfaceCache'
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
type PreviewResponse = { items: Array<{ filePath: string; data: WaveformListPreviewData | null }> }
const missingResponse = (filePaths: string[]): PreviewResponse => ({
  items: filePaths.map((filePath) => ({ filePath, data: null }))
})
const invoke = vi.fn(
  async (_channel: string, payload: { filePaths: string[] }): Promise<PreviewResponse> => ({
    items: payload.filePaths.map((filePath) => ({ filePath, data: null }))
  })
)
const readyPreview: WaveformListPreviewData = {
  version: 1,
  parameterVersion: 1,
  surfaceKind: 'listPreview',
  duration: 180,
  sampleRate: 44100,
  detailRate: 1,
  overviewRate: 1,
  bodyRateDivisor: 1,
  colorRateDivisor: 1,
  detailPeakTop: new Uint8Array([128]),
  detailPeakBottom: new Uint8Array([128]),
  detailBody: new Uint8Array([64]),
  colorIndex: new Uint8Array([3]),
  colorLow: new Uint8Array([128]),
  colorMid: new Uint8Array([128]),
  colorHigh: new Uint8Array([128]),
  colorRed: new Uint8Array([128]),
  colorGreen: new Uint8Array([128]),
  colorBlue: new Uint8Array([128]),
  overviewTop: new Uint8Array([128]),
  overviewBottom: new Uint8Array([128])
}
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
  invoke.mockReset()
  invoke.mockImplementation(async (_channel, payload) => missingResponse(payload.filePaths))
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
  it('reloads cached missing rows analyzed after they scroll out of view', async () => {
    const mounted = mountWaveforms()
    await flushLoad()
    expect(mounted.preview.getWaveformPlaceholderText(pathFor(0))).toBe(
      'tracks.waveformPreviewUnavailable'
    )
    mounted.preview.setWaveformCanvasRef(pathFor(0), pathFor(0), null)
    mounted.visibleSongsWithIndex.value = [{ song: songFor(3), idx: 3 }]
    await flushLoad()
    invoke.mockClear()
    worker.postMessage.mockClear()
    // The completion notification can use a different path spelling than the row cache.
    subscriptions.updated?.(null, { filePath: pathFor(0).replace(/\\/g, '/').toUpperCase() })
    await flushLoad()
    expect(invoke).not.toHaveBeenCalled()
    expect(renders()).toHaveLength(0)
    invoke.mockResolvedValue({ items: [{ filePath: pathFor(0), data: readyPreview }] })
    mounted.visibleSongsWithIndex.value = [{ song: songFor(0), idx: 0 }]
    mounted.preview.setWaveformCanvasRef(pathFor(0), pathFor(0), canvas())
    await flushLoad()
    expect(invoke.mock.calls.at(-1)?.[1].filePaths).toEqual([pathFor(0)])
    expect(mounted.preview.getWaveformPlaceholderText(pathFor(0))).toBe('')
    expect(worker.postMessage.mock.calls.some(([message]) => message.type === 'setData')).toBe(true)
  })

  it.each(['hidden-column', 'unmounted-canvas'] as const)(
    'invalidates a missing preview when analysis completes with %s',
    async (state) => {
      const mounted = mountWaveforms(1)
      await flushLoad()
      const columns = mounted.visibleColumns.value
      if (state === 'hidden-column') mounted.visibleColumns.value = []
      mounted.preview.setWaveformCanvasRef(pathFor(0), pathFor(0), null)
      await flushDraw()
      invoke.mockClear()
      subscriptions.updated?.(null, { filePath: pathFor(0) })
      await flushLoad()
      expect(invoke).not.toHaveBeenCalled()
      invoke.mockResolvedValue({ items: [{ filePath: pathFor(0), data: readyPreview }] })
      mounted.visibleColumns.value = columns
      mounted.preview.setWaveformCanvasRef(pathFor(0), pathFor(0), canvas())
      await flushLoad()
      expect(invoke.mock.calls.at(-1)?.[1].filePaths).toEqual([pathFor(0)])
      expect(mounted.preview.getWaveformPlaceholderText(pathFor(0))).toBe('')
    }
  )

  it('rejects an old missing response after an offscreen completion notification', async () => {
    let resolveOld: ((response: PreviewResponse) => void) | undefined
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    const mounted = mountWaveforms(1)
    await flushLoad()
    mounted.preview.setWaveformCanvasRef(pathFor(0), pathFor(0), null)
    mounted.visibleSongsWithIndex.value = []
    await flushDraw()
    subscriptions.updated?.(null, { filePath: pathFor(0) })
    resolveOld?.(missingResponse([pathFor(0)]))
    await flushLoad()
    invoke.mockResolvedValue({ items: [{ filePath: pathFor(0), data: readyPreview }] })
    mounted.visibleSongsWithIndex.value = [{ song: songFor(0), idx: 0 }]
    mounted.preview.setWaveformCanvasRef(pathFor(0), pathFor(0), canvas())
    await flushLoad()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(mounted.preview.getWaveformPlaceholderText(pathFor(0))).toBe('')
  })

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
    await flushLoad()
    expect(renderedPaths()).toEqual([pathFor(1)])
    worker.postMessage.mockClear()
    emitter.emit('waveform-preview:progress', { filePath: pathFor(2), percent: 0.4 })
    expect(renderedPaths()).toEqual([pathFor(2)])
    expect(renders()[0].payload.playedPercent).toBe(0.4)
  })

  it('clears the previous row highlight when preview switches songs without stopping', async () => {
    const mounted = mountWaveforms()
    await flushLoad()
    const relayPlayToState = (payload: unknown) => {
      const filePath =
        payload && typeof payload === 'object' && 'filePath' in payload
          ? String((payload as { filePath?: unknown }).filePath || '')
          : ''
      emitter.emit('waveform-preview:state', { filePath, active: true })
    }
    emitter.on('waveform-preview:play', relayPlayToState)
    try {
      mounted.preview.requestWaveformPreview(songFor(0), 0)
      emitter.emit('waveform-preview:progress', { filePath: pathFor(0), percent: 0.4 })
      worker.postMessage.mockClear()
      mounted.preview.requestWaveformPreview(songFor(1), 0.15)
      expect(
        renders().map((message) => [message.payload.filePath, message.payload.playedPercent])
      ).toEqual([
        [pathFor(0), 0],
        [pathFor(1), 0.15]
      ])
    } finally {
      emitter.off('waveform-preview:play', relayPlayToState)
    }
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
