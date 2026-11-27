// @vitest-environment ./tests/vueClientEnvironment.ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { HostNode, renderer, flush } from '../../../../../../../tests/vueHost'
import emitter from '@renderer/utils/mitt'
import { icloudState } from '@renderer/utils/icloudLibrary'
import { cancelCloudPlayback } from '@renderer/utils/icloudPlayback'
import { useWaveformPreviewPlayer } from './useWaveformPreviewPlayer'
import type { ISongInfo } from 'src/types/globals'

const invoke = vi.fn()
const runtime = {
  setting: { audioOutputDeviceId: '' },
  songsArea: { songListUUID: 'icloud-music' }
}

vi.mock('@renderer/stores/runtime', () => ({
  useRuntimeStore: () => runtime
}))

const ticket = 'frkb-preview://icloud/?path=Folder%2Ftrack.wav&ticket=resident'
const logical = 'icloud-song:Folder/track.wav'
const cloudSong = {
  filePath: logical,
  fileName: 'track.wav',
  title: 'track',
  icloudOrigin: {
    relativePath: 'Folder/track.wav',
    rootToken: 'root',
    key: logical
  }
} as ISongInfo

type Listener = { fn: () => void; once?: boolean }

class FakeAudio {
  preload = 'auto'
  src = ''
  currentTime = 0
  duration = 100
  paused = true
  ended = false
  muted = false
  volume = 1
  readyState = 2
  style: { display: string } = { display: '' }
  parentNode: { removeChild: (node: FakeAudio) => void } | null = null
  private listeners = new Map<string, Listener[]>()

  addEventListener(type: string, fn: () => void, options?: { once?: boolean }) {
    const list = this.listeners.get(type) || []
    list.push({ fn, once: Boolean(options?.once) })
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, fn: () => void) {
    const list = this.listeners.get(type) || []
    this.listeners.set(
      type,
      list.filter((item) => item.fn !== fn)
    )
  }

  emit(type: string) {
    const list = this.listeners.get(type) || []
    this.listeners.set(
      type,
      list.filter((item) => {
        item.fn()
        return !item.once
      })
    )
  }

  play() {
    this.paused = false
    this.emit('play')
    return Promise.resolve()
  }

  pause() {
    this.paused = true
    this.emit('pause')
  }

  load() {
    this.ended = false
  }

  canPlayType(_mime?: string) {
    return 'probably'
  }

  removeAttribute(name: string) {
    if (name === 'src') this.src = ''
  }

  setSinkId() {
    return Promise.resolve()
  }
}

const createdAudio: FakeAudio[] = []
const Host = defineComponent({
  setup() {
    useWaveformPreviewPlayer()
    return () => null
  }
})

const settle = async () => {
  await flush()
  await Promise.resolve()
  await Promise.resolve()
}

const mountPlayer = async () => {
  const root = new HostNode('root')
  const app = renderer.createApp(Host)
  app.mount(root)
  await settle()
  return {
    audio: () =>
      createdAudio.find((item) => item.parentNode || item.src) ||
      createdAudio[createdAudio.length - 1],
    unmount: () => app.unmount()
  }
}

beforeEach(() => {
  createdAudio.length = 0
  invoke.mockReset()
  runtime.songsArea.songListUUID = 'icloud-music'
  icloudState.value = {
    supported: true,
    visible: true,
    available: true,
    configured: true,
    folder: 'drive',
    rootToken: 'root'
  }
  invoke.mockImplementation(async (channel: string, relative?: string) => {
    if (channel === 'icloud:prepare-play') return { ok: true, value: ticket }
    if (channel === 'icloud:cancel') return { ok: true, value: true }
    throw new Error(`unexpected channel ${channel}:${relative}`)
  })
  vi.stubGlobal('window', {
    electron: { ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }
  })
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'audio') {
        return {
          style: {},
          appendChild() {
            return undefined
          },
          removeChild() {
            return undefined
          }
        }
      }
      const audio = new FakeAudio()
      createdAudio.push(audio)
      return audio
    },
    body: {
      appendChild: (node: FakeAudio) => {
        node.parentNode = {
          removeChild: (item: FakeAudio) => {
            item.parentNode = null
          }
        }
      }
    }
  })
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cancelCloudPlayback()
  icloudState.value = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('plays a resident iCloud preview from the click position through a ticket URL, then progress and stop work', async () => {
  const view = await mountPlayer()
  const states: Array<{ active?: boolean; filePath?: string | null }> = []
  const progress: Array<{ filePath?: string; percent?: number }> = []
  const onState = (payload?: { active?: boolean; filePath?: string | null }) => {
    states.push({ active: payload?.active, filePath: payload?.filePath })
  }
  const onProgress = (payload?: { filePath?: string; percent?: number }) => {
    progress.push({ filePath: payload?.filePath, percent: payload?.percent })
  }
  emitter.on('waveform-preview:state', onState)
  emitter.on('waveform-preview:progress', onProgress)
  try {
    emitter.emit('waveform-preview:play', {
      filePath: logical,
      startPercent: 0.25,
      song: cloudSong
    })
    await settle()
    const audio = view.audio()
    expect(audio).toBeTruthy()
    expect(audio.src).toBe(ticket)
    expect(audio.src).not.toContain('frkb-preview://local/')
    expect(audio.currentTime).toBe(25)
    expect(audio.paused).toBe(false)
    expect(
      invoke.mock.calls
        .filter(([channel]) => channel === 'icloud:prepare-play')
        .map(([, relative]) => relative)
    ).toEqual(['Folder/track.wav'])
    expect(invoke.mock.calls.some(([channel]) => channel === 'mixtape:decode-for-transport')).toBe(
      false
    )
    expect(states.some((item) => item.active && item.filePath === logical)).toBe(true)
    audio.currentTime = 40
    audio.emit('timeupdate')
    expect(progress.some((item) => item.filePath === logical && item.percent === 0.4)).toBe(true)
    emitter.emit('waveform-preview:stop', { reason: 'explicit' })
    await settle()
    expect(audio.paused).toBe(true)
    expect(audio.src).toBe('')
    expect(states.at(-1)).toMatchObject({ active: false, filePath: logical })
  } finally {
    emitter.off('waveform-preview:state', onState)
    emitter.off('waveform-preview:progress', onProgress)
    view.unmount()
  }
})

it('waits for an evicted iCloud song, does not open a local file, and stop cancels the stuck playing state', async () => {
  let finish!: (value: unknown) => void
  invoke.mockImplementation((channel: string) => {
    if (channel === 'icloud:prepare-play') {
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    if (channel === 'icloud:cancel') return Promise.resolve({ ok: true, value: true })
    throw new Error(`unexpected channel ${channel}`)
  })
  const view = await mountPlayer()
  const states: Array<{ active?: boolean; filePath?: string | null }> = []
  const onState = (payload?: { active?: boolean; filePath?: string | null }) => {
    states.push({ active: payload?.active, filePath: payload?.filePath })
  }
  emitter.on('waveform-preview:state', onState)
  try {
    emitter.emit('waveform-preview:play', {
      filePath: logical,
      startPercent: 0.1,
      song: cloudSong
    })
    await settle()
    expect(states.some((item) => item.active && item.filePath === logical)).toBe(true)
    expect(createdAudio.some((audio) => audio.src.includes('frkb-preview://local/'))).toBe(false)
    expect(invoke.mock.calls.some(([channel]) => channel === 'mixtape:decode-for-transport')).toBe(
      false
    )
    emitter.emit('waveform-preview:stop', { reason: 'explicit' })
    await settle()
    expect(states.at(-1)).toMatchObject({ active: false, filePath: logical })
    expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:cancel')).toBe(true)
    finish({ ok: true, value: ticket })
    await settle()
    expect(createdAudio.some((audio) => audio.src === ticket)).toBe(false)
    expect(states.at(-1)?.active).toBe(false)
  } finally {
    emitter.off('waveform-preview:state', onState)
    view.unmount()
  }
})

it('exits the playing UI after a failed prepare and still plays ordinary local previews', async () => {
  invoke.mockResolvedValue({ ok: false, error: 'timeout' })
  const view = await mountPlayer()
  const states: Array<{ active?: boolean; filePath?: string | null }> = []
  const onState = (payload?: { active?: boolean; filePath?: string | null }) => {
    states.push({ active: payload?.active, filePath: payload?.filePath })
  }
  emitter.on('waveform-preview:state', onState)
  try {
    emitter.emit('waveform-preview:play', {
      filePath: logical,
      startPercent: 0,
      song: cloudSong
    })
    await settle()
    expect(states.some((item) => item.active === false && item.filePath === logical)).toBe(true)
    expect(createdAudio.some((audio) => Boolean(audio.src))).toBe(false)
    emitter.emit('waveform-preview:play', {
      filePath: '/Music/local.wav',
      startPercent: 0,
      song: { filePath: '/Music/local.wav', fileName: 'local.wav', title: 'local' } as ISongInfo
    })
    await settle()
    const audio = view.audio()
    expect(audio.src).toBe('frkb-preview://local/?path=' + encodeURIComponent('/Music/local.wav'))
    expect(audio.paused).toBe(false)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'icloud:prepare-play')).toHaveLength(
      1
    )
    emitter.emit('waveform-preview:stop', { reason: 'explicit' })
    await settle()
  } finally {
    emitter.off('waveform-preview:state', onState)
    view.unmount()
  }
})
