// Run: pnpm exec vitest run src/renderer/src/pages/modules/songsArea/composables/useKeyboardSelection.routing.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { KeyHandler, HotkeysEvent } from 'hotkeys-js'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { useKeyboardSelection } from './useKeyboardSelection'
import type { ISongInfo } from 'src/types/globals'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, KeyHandler>() }))
vi.mock('hotkeys-js', () => ({
  default: Object.assign(
    (keys: string, _scope: string, callback: KeyHandler) => handlers.set(keys, callback),
    { unbind: (keys: string) => handlers.delete(keys) }
  )
}))
vi.mock('@renderer/components/confirmDialog', () => ({ default: vi.fn() }))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/utils/libraryUtils', () => ({ default: { getLibraryTreeByUUID: () => null } }))

const renderer = createRenderer<object, object>({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  insert: () => {},
  remove: () => {},
  setText: () => {},
  setElementText: () => {},
  patchProp: () => {},
  parentNode: () => null,
  nextSibling: () => null
})
const press = (keys: string) => handlers.get(keys)?.({} as KeyboardEvent, {} as HotkeysEvent)

beforeEach(() => {
  setActivePinia(createPinia())
  handlers.clear()
})

describe('keyboard ownership across local and DJ panes', () => {
  it.each([false, true])(
    'routes shortcuts to the active pane with DJ mounted first=%s',
    async (djFirst) => {
      const runtime = useRuntimeStore()
      runtime.songsAreaPanels.splitEnabled = true
      runtime.focusArea = 'songsArea'
      const left = runtime.songsAreaPanels.panes.left
      const right = runtime.songsAreaPanels.panes.right
      left.songListUUID = 'local'
      left.songInfoArr = [{ filePath: 'local.mp3' } as ISongInfo]
      right.songListUUID = 'usb:drive:11'
      right.songInfoArr = [{ filePath: 'usb.mp3', mixtapeItemId: 'usb-row' } as ISongInfo]
      const deleteUsb = vi.fn(async () => {})
      const showUsb = ref(true)
      const local = defineComponent({
        setup() {
          useKeyboardSelection({ runtime, songsAreaState: left, externalViewportHeight: ref(200) })
          return () => null
        }
      })
      const usb = defineComponent({
        setup() {
          useKeyboardSelection({
            runtime,
            songsAreaState: right,
            externalViewportHeight: ref(200),
            readOnly: true,
            onDeleteSelection: deleteUsb
          })
          return () => null
        }
      })
      const app = renderer.createApp({
        render: () =>
          h(
            'div',
            djFirst
              ? [showUsb.value ? h(usb) : null, h(local)]
              : [h(local), showUsb.value ? h(usb) : null]
          )
      })
      app.mount({})
      try {
        runtime.setSongsAreaActivePane('right')
        press('ctrl+a, command+a')
        expect(right.selectedSongFilePath).toEqual(['usb-row'])
        expect(left.selectedSongFilePath).toEqual([])
        press('delete')
        expect(deleteUsb).toHaveBeenCalledOnce()
        runtime.setSongsAreaActivePane('left')
        showUsb.value = false
        await nextTick()
        press('ctrl+a, command+a')
        expect(left.selectedSongFilePath).toEqual(['local.mp3'])
        expect(deleteUsb).toHaveBeenCalledOnce()
      } finally {
        app.unmount()
      }
      expect(handlers.size).toBe(0)
    }
  )
})
