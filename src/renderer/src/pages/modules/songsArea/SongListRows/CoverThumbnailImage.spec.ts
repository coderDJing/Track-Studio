import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import CoverThumbnailImage from './CoverThumbnailImage.vue'
import { useCoverThumbnails } from './useCoverThumbnails'

vi.mock('./coverDisplayWorkerClient', () => ({
  createCoverDisplayWorkerClient: () => ({ dispose: vi.fn(), resize: vi.fn() })
}))

type HostNode = {
  type: string
  text: string
  props: Record<string, unknown>
  children: HostNode[]
  parent: HostNode | null
}
const node = (type: string, text = ''): HostNode => ({
  type,
  text,
  props: {},
  children: [],
  parent: null
})
const renderer = createRenderer<HostNode, HostNode>({
  createElement: (type) => node(type),
  createText: (text) => node('#text', text),
  createComment: (text) => node('#comment', text),
  setText: (target, text) => {
    target.text = text
  },
  setElementText: (target, text) => {
    target.text = text
  },
  patchProp: (target, key, _previous, next) => {
    target.props[key] = next
  },
  parentNode: (target) => target.parent,
  nextSibling: (target) => {
    const siblings = target.parent?.children ?? []
    return siblings[siblings.indexOf(target) + 1] ?? null
  },
  insert: (target, parent, anchor) => {
    if (target.parent) {
      const previousIndex = target.parent.children.indexOf(target)
      if (previousIndex >= 0) target.parent.children.splice(previousIndex, 1)
    }
    target.parent = parent
    const anchorIndex = anchor ? parent.children.indexOf(anchor) : -1
    if (anchorIndex >= 0) parent.children.splice(anchorIndex, 0, target)
    else parent.children.push(target)
  },
  remove: (target) => {
    const siblings = target.parent?.children
    const index = siblings?.indexOf(target) ?? -1
    if (index >= 0) siblings?.splice(index, 1)
    target.parent = null
  }
})

type CoverResponse = { dataUrl: string } | null
const pending = new Map<string, (response: CoverResponse) => void>()
let unmount: (() => void) | undefined
const firstPath = 'C:\\music\\first.mp3'
const secondPath = 'C:\\music\\second.mp3'

beforeEach(() => {
  pending.clear()
  vi.stubGlobal('window', {
    electron: {
      ipcRenderer: {
        send: vi.fn(),
        invoke: vi.fn((channel: string, filePath: string) => {
          if (channel !== 'getSongCoverThumb') return Promise.resolve(null)
          return new Promise<CoverResponse>((resolve) => pending.set(filePath, resolve))
        })
      }
    }
  })
})
afterEach(() => {
  unmount?.()
  unmount = undefined
  vi.unstubAllGlobals()
})

const mountCovers = () => {
  let listRenders = 0
  let cache: ReturnType<typeof useCoverThumbnails> | undefined
  const sessionIdentity = ref('playlist-1')
  const root = node('root')
  const songs = ref([firstPath, secondPath].map((filePath) => ({ filePath }) as ISongInfo))
  const app = renderer.createApp(
    defineComponent({
      setup() {
        const covers = useCoverThumbnails({
          songs,
          visibleSongsWithIndex: ref(songs.value.map((song, idx) => ({ song, idx }))),
          startIndex: ref(0),
          endIndex: ref(2),
          actualStartIndex: ref(0),
          actualEndIndex: ref(2),
          visibleCount: ref(2),
          sessionIdentity,
          platform: ref('win32')
        })
        cache = covers
        return () => {
          listRenders += 1
          return h(
            'div',
            songs.value.map((song) =>
              h(CoverThumbnailImage, {
                key: song.filePath,
                filePath: song.filePath,
                getCoverUrl: covers.getCoverUrl,
                onError: () => covers.onImgError(song.filePath)
              })
            )
          )
        }
      }
    })
  )
  app.mount(root)
  unmount = () => app.unmount()
  if (!cache) throw new Error('cover cache not mounted')
  return { root, cache, sessionIdentity, listRenders: () => listRenders }
}

describe('song cover updates stay inside the corresponding cell', () => {
  it('updates a completed cover without rerendering the list or replacing another cell', async () => {
    const mounted = mountCovers()
    const list = mounted.root.children[0]
    const otherCell = list.children[1]
    pending.get(firstPath)?.({ dataUrl: 'data:image/png;base64,first' })
    await nextTick()
    await nextTick()

    expect(list.children[0].type).toBe('img')
    expect(list.children[0].props.src).toBe('data:image/png;base64,first')
    expect(list.children[1]).toBe(otherCell)
    expect(otherCell.type).toBe('div')
    expect(mounted.listRenders()).toBe(1)
    expect(mounted.cache.getCoverUrl('c:/MUSIC/FIRST.mp3')).toBe('data:image/png;base64,first')
  })

  it('shows the skeleton on image error without rerendering sibling rows', async () => {
    const mounted = mountCovers()
    pending.get(firstPath)?.({ dataUrl: 'data:image/png;base64,first' })
    pending.get(secondPath)?.({ dataUrl: 'data:image/png;base64,second' })
    await nextTick()
    await nextTick()
    const list = mounted.root.children[0]
    const otherCell = list.children[1]
    const errorHandler = list.children[0].props.onError
    if (typeof errorHandler !== 'function') throw new Error('missing image error handler')
    errorHandler()
    await nextTick()

    expect(list.children[0].type).toBe('div')
    expect(list.children[0].props.class).toBe('cover-skeleton')
    expect(list.children[1]).toBe(otherCell)
    expect(mounted.listRenders()).toBe(1)
  })

  it('ignores cover responses from an obsolete playlist session', async () => {
    const mounted = mountCovers()
    const obsoleteResponse = pending.get(firstPath)
    mounted.sessionIdentity.value = 'playlist-2'
    await nextTick()
    obsoleteResponse?.({ dataUrl: 'data:image/png;base64,obsolete' })
    await nextTick()
    await nextTick()
    expect(mounted.root.children[0].children[0].type).toBe('div')
    expect(mounted.cache.getCoverUrl(firstPath)).toBeUndefined()
    expect(mounted.listRenders()).toBe(1)
    pending.get(firstPath)?.({ dataUrl: 'data:image/png;base64,current' })
    await nextTick()
    await nextTick()
    expect(mounted.root.children[0].children[0].props.src).toBe('data:image/png;base64,current')
  })
})
