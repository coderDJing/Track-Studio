// Run: pnpm exec vitest run src/renderer/src/pages/modules/songPlayer/bindBrowserPlayerEvents.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { bindBrowserPlayerEvents } from './bindBrowserPlayerEvents'
import { WebAudioPlayer } from './webAudioPlayer'
import type { ISongInfo } from 'src/types/globals'

const mocks = vi.hoisted(() => ({ listeners: new Map<string, unknown>() }))
vi.mock('./webAudioPlayer', () => ({
  WebAudioPlayer: class {
    on(event: string, listener: unknown) {
      mocks.listeners.set(event, listener)
    }
    off(event: string) {
      mocks.listeners.delete(event)
    }
    getCurrentTime() {
      return 12
    }
  }
}))
afterEach(() => {
  vi.unstubAllGlobals()
  mocks.listeners.clear()
})

it.each([
  { platform: 'Win32', original: 'G:\\Music\\Track.mp3', alias: 'g:/music/track.mp3', pauses: 0 },
  {
    platform: 'MacIntel',
    original: '/Volumes/Music/Track.mp3',
    alias: '/Volumes/Music/track.mp3',
    pauses: 1
  }
])(
  '$platform foreground activity follows physical identity during a path update',
  ({ platform, original, alias, pauses }) => {
    setActivePinia(createPinia())
    vi.stubGlobal('navigator', { platform })
    const send = vi.fn()
    vi.stubGlobal('window', { electron: { ipcRenderer: { send } } })
    const runtime = useRuntimeStore()
    runtime.playingData.playingSong = { filePath: original } as ISongInfo
    const previousTime = vi.fn()
    const cleanup = bindBrowserPlayerEvents({
      player: new WebAudioPlayer(),
      runtime,
      playerCurrentSeconds: ref(0),
      playerWaveformRenderRevision: ref(0),
      ignoreNextEmptyError: ref(false),
      setPreviousTime: previousTime,
      setManualSeekActive: vi.fn(),
      nextSong: vi.fn(),
      scheduleManualSeekReset: vi.fn(),
      clearManualSeekTimer: vi.fn(),
      handlePlaybackRangeTimeUpdate: vi.fn(),
      updateParentWaveformWidth: vi.fn(),
      scheduleAdjacentMetadataPreload: vi.fn(),
      isIgnorablePlayerEmptySourceError: () => false,
      isIgnorablePlayerInterruptionError: () => false,
      handleSongLoadError: vi.fn(async () => {})
    })
    const play = mocks.listeners.get('play')
    if (typeof play !== 'function') throw new Error('play handler missing')
    play()
    runtime.playingData.playingSong = { filePath: alias } as ISongInfo
    play()
    expect(send.mock.calls.filter(([, payload]) => payload.state === 'pause')).toHaveLength(pauses)
    expect(previousTime).toHaveBeenLastCalledWith(12)
    expect(runtime.playerReady).toBe(true)
    cleanup()
    expect(mocks.listeners.size).toBe(0)
  }
)
