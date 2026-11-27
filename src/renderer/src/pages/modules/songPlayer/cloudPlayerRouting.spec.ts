// @vitest-environment ./tests/vueClientEnvironment.ts
import { afterEach, it, expect, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { renderer, HostNode, flush } from '../../../../../../tests/vueHost'
import { icloudOpen } from '@renderer/utils/icloudLibrary'
import {
  activeCloudListContext,
  guardPlayerActions,
  isCloudSong
} from '@renderer/utils/activeSongListContext'
import { usePlayerHotkeys } from './usePlayerHotkeys'
import PlayerSurface from './PlayerSurface.vue'
import type { ISongInfo } from 'src/types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'
const bus = vi.hoisted(() => ({ listeners: new Set<(event: KeyboardEvent) => void>() }))
vi.mock('hotkeys-js', () => ({
  default: Object.assign(
    (
      keys: string,
      _scope: string,
      callback: (event: KeyboardEvent, handler: { key: string }) => void
    ) => {
      bus.listeners.add((event) => {
        if (
          keys
            .split(',')
            .map((s) => s.trim())
            .includes(event.key.toLowerCase())
        )
          callback(event, { key: event.key.toLowerCase() })
      })
    },
    { unbind: () => {} }
  )
}))
vi.mock('@renderer/utils/mitt', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }))
afterEach(() => {
  icloudOpen.value = false
  activeCloudListContext.value = null
  bus.listeners.clear()
  vi.restoreAllMocks()
})
it('mounted player and global window events use active cloud capabilities instead of old local mutation actions', async () => {
  const local = vi.fn(),
    copy = vi.fn<(target: string) => Promise<void>>(async () => {}),
    toggle = vi.fn()
  const song = { filePath: '/temporary-local-fixture.wav', title: 'local' } as ISongInfo
  const runtime = {
    playingData: { playingSong: song, playingSongListUUID: 'old-local' },
    focusArea: 'songsArea',
    libraryAreaSelected: 'FilterLibrary',
    mainWindowBrowseMode: 'browser',
    selectSongListDialogShow: false
  } as unknown as ReturnType<typeof useRuntimeStore>
  const actions = guardPlayerActions(runtime, {
    play: vi.fn(),
    pause: vi.fn(),
    togglePlayPause: toggle,
    delSong: local,
    delAllAbove: local,
    moveToListLibrary: local,
    moveToLikeLibrary: local,
    moveToSetLibrary: local,
    moveToMixtapeLibrary: local,
    exportTrack: local,
    handleMoveSong: local,
    fastForward: vi.fn(),
    fastBackward: vi.fn(),
    nextSong: vi.fn(),
    previousSong: vi.fn(),
    seekToPercent: vi.fn(),
    volumeUp: vi.fn(),
    volumeDown: vi.fn()
  })
  const state = {
    waveformShow: ref(true),
    selectSongListDialogShow: ref(false),
    confirmShow: ref(false),
    songsAreaSelectedCount: ref(0),
    activeMenuUUID: ref(''),
    hotkeysEnabled: ref(true)
  }
  const root = new HostNode('root')
  const app = renderer.createApp(
    defineComponent({
      setup() {
        usePlayerHotkeys(actions, state, runtime)
        return () =>
          h(PlayerSurface, { visible: state.waveformShow.value }, () =>
            h('button', { onClick: actions.togglePlayPause }, 'Pause')
          )
      }
    })
  )
  app.mount(root)
  const events = new EventTarget()
  const listener = (event: Event) => {
    for (const handler of bus.listeners) handler(event as KeyboardEvent)
  }
  events.addEventListener('keydown', listener)
  const press = (key: string) => {
    const event = new Event('keydown', { cancelable: true })
    Object.defineProperty(event, 'key', { value: key })
    events.dispatchEvent(event)
  }
  try {
    icloudOpen.value = true
    activeCloudListContext.value = { copy }
    for (const key of ['Delete', 'q', 'e']) press(key)
    await flush()
    expect(local).not.toHaveBeenCalled()
    expect(copy.mock.calls.map((args) => args[0])).toEqual(['FilterLibrary', 'CuratedLibrary'])
    for (const action of [
      actions.delSong,
      actions.delAllAbove,
      actions.moveToSetLibrary,
      actions.moveToMixtapeLibrary,
      actions.exportTrack,
      actions.handleMoveSong
    ])
      action()
    expect(local).not.toHaveBeenCalled()
    runtime.playingData.playingSong = {
      ...song,
      filePath: 'frkb-preview://icloud/ticket',
      icloudOrigin: { relativePath: 'track.wav', rootToken: 'root', key: 'icloud-song:track.wav' }
    }
    expect(isCloudSong(runtime.playingData.playingSong)).toBe(true)
    press('space')
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(root.children[0].style.display).not.toBe('none')
    icloudOpen.value = false
    actions.delSong()
    expect(local).not.toHaveBeenCalled()
    runtime.playingData.playingSong = song
    press('Delete')
    expect(local).toHaveBeenCalledTimes(1)
  } finally {
    events.removeEventListener('keydown', listener)
    app.unmount()
  }
})
