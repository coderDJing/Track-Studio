// 官网上运行应用真实组件时的 IPC 替身。
// 组件会通过 window.electron.ipcRenderer 向主进程要封面、波形缓存等数据；官网没有主进程，
// 这里按通道名返回演示数据，其余通道返回 null（组件本身都已处理“没有数据”的情况）。
// 只在浏览器端安装，SSR 阶段组件不会发 IPC。
import type { UnifiedDisplayWaveformDetailData } from '@shared/unifiedDisplayWaveform'
import { buildWaveformSurfaceCacheDataFromUnifiedDisplay } from '@shared/waveformSurfaceCache'

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>
type Listener = (...args: unknown[]) => void

const handlers = new Map<string, InvokeHandler>()
const listeners = new Map<string, Set<Listener>>()

export const registerDemoIpcHandler = (channel: string, handler: InvokeHandler) => {
  handlers.set(channel, handler)
}

export const emitDemoIpcEvent = (channel: string, ...args: unknown[]) => {
  listeners.get(channel)?.forEach((listener) => listener({}, ...args))
}

type DemoIpcRenderer = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: Listener) => () => void
  once: (channel: string, listener: Listener) => void
  removeListener: (channel: string, listener: Listener) => void
  removeAllListeners: (channel: string) => void
}

declare global {
  interface Window {
    electron?: { ipcRenderer: DemoIpcRenderer }
  }
}

export const installDemoIpc = () => {
  if (typeof window === 'undefined' || window.electron) return
  const ipcRenderer: DemoIpcRenderer = {
    invoke: async (channel, ...args) => {
      const handler = handlers.get(channel)
      return handler ? handler(...args) : null
    },
    send: () => {},
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(channel, set)
      return () => set.delete(listener)
    },
    once: (channel, listener) => {
      const wrapped: Listener = (...args) => {
        listeners.get(channel)?.delete(wrapped)
        listener(...args)
      }
      ipcRenderer.on(channel, wrapped)
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener)
    },
    removeAllListeners: (channel) => {
      listeners.delete(channel)
    }
  }
  window.electron = { ipcRenderer }
}

// 应用用 Electron 注册的 frkb-preview:// 协议让 <audio> 和 fetch 读本地音频；浏览器不认这个协议，会在控制台报错。
// 官网演示没有真实音频，把这类地址改指向一段静音 WAV（只在浏览器端，拦截 src 写入与 fetch）。
export const installDemoAudioScheme = () => {
  if (typeof window === 'undefined') return
  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
  if (!descriptor?.set || !descriptor.get) return
  const silentUrl = `${import.meta.env.BASE_URL}assets/demo-audio/silence.wav`
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: descriptor.get,
    set(value: string) {
      const next = String(value || '').startsWith('frkb-preview://') ? silentUrl : value
      descriptor.set?.call(this, next)
    }
  })
  // Mixtape 预解码用 fetch 读 frkb-preview:// 地址，同样改指向静音 WAV
  const nativeFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return nativeFetch(url.startsWith('frkb-preview://') ? silentUrl : input, init)
  }
  const setAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name: string, value: string) {
    if (
      this instanceof HTMLMediaElement &&
      name === 'src' &&
      String(value).startsWith('frkb-preview://')
    ) {
      return setAttribute.call(this, name, silentUrl)
    }
    return setAttribute.call(this, name, value)
  }
}

// 演示曲目的 unified display 波形，按 filePath 登记。
// 两个波形缓存通道与主进程返回同样的结构：详情走 unified display，概览由应用自己的
// buildWaveformSurfaceCacheDataFromUnifiedDisplay 生成 globalOverview。
const unifiedByPath = new Map<string, UnifiedDisplayWaveformDetailData>()
export const registerDemoUnifiedWaveform = (
  filePath: string,
  data: UnifiedDisplayWaveformDetailData
) => {
  unifiedByPath.set(filePath, data)
}

const readFilePath = (payload: unknown) =>
  payload && typeof payload === 'object' && 'filePath' in payload
    ? String((payload as { filePath?: unknown }).filePath || '')
    : ''

registerDemoIpcHandler('unified-display-waveform-cache:load', (payload) => {
  const data = unifiedByPath.get(readFilePath(payload))
  return data ? { status: 'ready', data } : { status: 'missing', data: null }
})

// 歌曲列表的波形预览列：一次取一批，返回 listPreview 表面数据。
// 列表曲目只登记了 listPreview（生成脚本直接产出），双轨曲目从 unified display 现算
const listPreviewByPath = new Map<string, unknown>()
export const registerDemoListPreview = (filePath: string, data: unknown) => {
  listPreviewByPath.set(filePath, data)
}

registerDemoIpcHandler('waveform-list-preview-cache:batch', (payload) => {
  const filePaths =
    payload && typeof payload === 'object' && 'filePaths' in payload
      ? (payload as { filePaths?: unknown }).filePaths
      : null
  const items = (Array.isArray(filePaths) ? filePaths : []).map((value) => {
    const filePath = String(value)
    const listPreview = listPreviewByPath.get(filePath)
    if (listPreview) return { filePath, data: listPreview }
    const unified = unifiedByPath.get(filePath)
    const surface = unified ? buildWaveformSurfaceCacheDataFromUnifiedDisplay(unified) : null
    return { filePath, data: surface?.listPreview ?? null }
  })
  return { items }
})

// Mixtape 时间线：一次取一批完整 unified display 波形
registerDemoIpcHandler('unified-display-waveform-cache:batch', (payload) => {
  const filePaths =
    payload && typeof payload === 'object' && 'filePaths' in payload
      ? (payload as { filePaths?: unknown }).filePaths
      : null
  const items = (Array.isArray(filePaths) ? filePaths : []).map((value) => {
    const filePath = String(value)
    return { filePath, data: unifiedByPath.get(filePath) ?? null }
  })
  return { items }
})

registerDemoIpcHandler('waveform-global-overview-cache:load', (payload) => {
  const data = unifiedByPath.get(readFilePath(payload))
  const surface = data ? buildWaveformSurfaceCacheDataFromUnifiedDisplay(data) : null
  return surface
    ? { status: 'ready', data: surface.globalOverview }
    : { status: 'missing', data: null }
})

// 外部曲库来源栏使用应用的 librarySelectArea，提供三个 DJ 曲库的演示来源。
registerDemoIpcHandler('pioneer-device-library:list-removable-drives', () => [
  {
    id: 'demo-usb',
    name: 'PIONEER',
    path: 'E:/',
    volumeName: 'PIONEER',
    fileSystem: 'FAT32',
    isUsb: true,
    isPioneerDeviceLibrary: true,
    supportedLibraryTypes: ['deviceLibrary', 'oneLibrary']
  }
])
registerDemoIpcHandler('rekordbox-desktop-library:probe', () => ({
  available: true,
  sourceKey: 'demo-rekordbox-desktop',
  sourceRootPath: 'D:/Music/Rekordbox'
}))
registerDemoIpcHandler('external-library:probe', () => [
  {
    kind: 'serato',
    available: true,
    sourceKey: 'demo-serato',
    sourcePath: 'D:/Music/_Serato_',
    displayName: 'Serato'
  },
  {
    kind: 'traktor',
    available: true,
    sourceKey: 'demo-traktor',
    sourcePath: 'D:/Music/Native Instruments/Traktor/collection.nml',
    displayName: 'Traktor'
  }
])
registerDemoIpcHandler('pioneer-device-library:load-tree', () => ({ treeNodes: [] }))
registerDemoIpcHandler('rekordbox-desktop-library:load-tree', () => ({ treeNodes: [] }))
registerDemoIpcHandler('external-library:load-tree', () => ({ treeNodes: [] }))
