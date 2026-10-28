import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import { baseParse, compile, NodeTypes, type TemplateChildNode } from '@vue/compiler-dom'
import * as Vue from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { expect, it, vi } from 'vitest'
import { useRuntimeStore, type SongsAreaPaneKey } from '@renderer/stores/runtime'
import { showSongListInPane, exitSongsAreaSplit } from '@renderer/utils/songsAreaSplit'
import { useSongsAreaPaneViews } from './useSongsAreaPaneViews'

vi.mock('@renderer/utils/libraryUtils', () => ({
  default: { getLibraryTreeByUUID: () => ({ type: 'songList' }) }
}))

type HostNode = { parent: HostNode | null; children: HostNode[] }
const node = (): HostNode => ({ parent: null, children: [] })
const remove = (child: HostNode) => {
  if (child.parent) {
    const siblings = child.parent.children
    const index = siblings.indexOf(child)
    if (index >= 0) siblings.splice(index, 1)
  }
  child.parent = null
}
const renderer = Vue.createRenderer<HostNode, HostNode>({
  createElement: node,
  createText: node,
  createComment: node,
  setText: () => {},
  setElementText: () => {},
  patchProp: () => {},
  parentNode: (child) => child.parent,
  nextSibling: (child) => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
  insert: (child, parent, anchor) => {
    remove(child)
    child.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, child)
  },
  remove
})

// Render the actual local-list template so a return to separate v-if layouts fails this test.
const source = readFileSync(new URL('../homePage.vue', import.meta.url), 'utf8')
const template = parse(source).descriptor.template!.content
const findLayout = (children: TemplateChildNode[]): string | undefined => {
  for (const child of children) {
    if (child.type !== NodeTypes.ELEMENT) continue
    if (
      child.props.some(
        (prop) =>
          prop.type === NodeTypes.ATTRIBUTE &&
          prop.name === 'ref' &&
          prop.value?.content === 'splitSongsAreaRef'
      )
    )
      return child.loc.source
    const nested = findLayout(child.children)
    if (nested) return nested
  }
}
const layout = findLayout(baseParse(template).children)!
const render = new Function(
  'Vue',
  compile(layout.replace(/v-else(?:-if="[^"]*")?/, ''), {
    mode: 'function',
    prefixIdentifiers: true
  }).code
)(Vue) as Vue.RenderFunction

it.each(['left', 'right'] as const)(
  'retains the mounted list when opening on %s and closing split',
  async (side) => {
    setActivePinia(createPinia())
    const runtime = useRuntimeStore()
    runtime.songsArea.songListUUID = 'old'
    runtime.songsArea.scrollTop = 280
    const mounted: string[] = []
    const unmounted: string[] = []
    const positions = new Map<string, () => SongsAreaPaneKey>()
    const List = Vue.defineComponent({
      props: { pane: { type: String as Vue.PropType<SongsAreaPaneKey>, required: true } },
      setup(props) {
        const state = runtime.songsAreaPanels.panes[props.pane]
        const uuid = state.songListUUID
        positions.set(uuid, () => props.pane)
        Vue.onMounted(() => mounted.push(uuid))
        Vue.onUnmounted(() => unmounted.push(uuid))
        return () => Vue.h('list')
      }
    })
    const Empty = Vue.defineComponent({ setup: () => () => null })
    const app = renderer.createApp({
      components: { songsArea: List, SongsAreaPaneHeader: Empty, SongsAreaPreviewHost: Empty },
      setup() {
        const split = Vue.computed(() => runtime.songsAreaPanels.splitEnabled)
        return {
          runtime,
          isSongsAreaSplit: split,
          visiblePaneViews: useSongsAreaPaneViews(runtime.songsAreaPanels.panes, split),
          splitSongsAreaStyle: {},
          showSingleSongsAreaHeader: true,
          showEmptyRecycleBinButton: false,
          splitDividerHovered: false,
          isSongsAreaSplitDividerResizing: false,
          isSplitPaneActive: () => false,
          resolveSongsPaneTitle: () => '',
          handleSplitPaneMouseDown: () => {},
          handleSinglePaneClose: () => {},
          handleSplitPaneClose: () => {},
          startSongsAreaSplitResize: () => {}
        }
      },
      render
    })
    app.mount(node())
    const oldState = runtime.songsAreaPanels.panes.single
    showSongListInPane(runtime, side, 'new')
    await Vue.nextTick()
    expect(mounted).toEqual(['old', 'new'])
    expect(unmounted).toEqual([])
    const retainedSide = side === 'left' ? 'right' : 'left'
    expect(positions.get('old')!()).toBe(retainedSide)
    expect(runtime.songsAreaPanels.panes[retainedSide]).toBe(oldState)
    exitSongsAreaSplit(runtime, retainedSide)
    await Vue.nextTick()
    expect(mounted).toEqual(['old', 'new'])
    expect(unmounted).toEqual(['new'])
    expect(positions.get('old')!()).toBe('single')
    expect(runtime.songsArea.scrollTop).toBe(280)
    app.unmount()
  }
)
