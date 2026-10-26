// Run: pnpm exec vitest run src/renderer/src/components/rightClickMenu.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, nextTick, reactive } from 'vue'
import type { IMenu } from '../../../types/globals'
import RightClickMenu from './rightClickMenu.vue'

const mocks = vi.hoisted(() => ({ handlers: new Map<string, () => unknown>() }))
vi.mock('hotkeys-js', () => ({
  default: (keys: string, _scope: string, callback: () => unknown) => {
    for (const key of keys.split(',')) mocks.handlers.set(key, callback)
  }
}))
vi.mock('@renderer/stores/runtime', () => ({
  useRuntimeStore: () => reactive({ activeMenuUUID: '' })
}))
vi.mock('@renderer/utils/utils', () => ({
  default: { setHotkeysScpoe: vi.fn(), delHotkeysScope: vi.fn() }
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('./bubbleBox.vue', () => ({ default: {} }))
vi.mock('vue', async (importOriginal) => {
  const vue = await importOriginal<typeof import('vue')>()
  return {
    ...vue,
    Transition: vue.defineComponent({
      inheritAttrs: false,
      emits: ['afterLeave'],
      setup:
        (_props, { slots }) =>
        () =>
          slots.default?.()
    })
  }
})

class HostNode {
  props: Record<string, unknown> = {}
  children: HostNode[] = []
  parent: HostNode | null = null
  offsetWidth = 220
  offsetHeight = 120
  constructor(public type: string) {}
  getBoundingClientRect() {
    return { left: 8, top: 43, right: 228, bottom: 163, width: 220, height: 120 }
  }
  scrollIntoView() {}
}
const body = new HostNode('body')
const renderer = createRenderer<HostNode, HostNode>({
  createElement: (type) => new HostNode(type),
  createText: () => new HostNode('#text'),
  createComment: () => new HostNode('#comment'),
  setText: () => {},
  setElementText: (node, text) => {
    node.props.text = text
  },
  patchProp: (node, key, _previous, value) => {
    node.props[key] = value
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => {
    const siblings = node.parent?.children || []
    return siblings[siblings.indexOf(node) + 1] || null
  },
  insert: (node, parent, anchor) => {
    const old = node.parent?.children
    if (old) old.splice(old.indexOf(node), 1)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
  },
  remove: (node) => {
    const siblings = node.parent?.children
    if (siblings) siblings.splice(siblings.indexOf(node), 1)
  },
  querySelector: () => body
})
const find = (root: HostNode, className: string): HostNode[] => [
  ...(String(root.props.class || '')
    .split(' ')
    .includes(className)
    ? [root]
    : []),
  ...root.children.flatMap((child) => find(child, className))
]
let unmount: (() => void) | undefined
afterEach(() => {
  unmount?.()
  unmount = undefined
  body.children = []
  mocks.handlers.clear()
  vi.unstubAllGlobals()
})

describe.each(['plain', 'reactive'] as const)('context menu with %s items', (kind) => {
  const mount = async () => {
    vi.stubGlobal('HTMLElement', HostNode)
    vi.stubGlobal('window', {
      innerWidth: 1260,
      innerHeight: 650,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    const items: IMenu[][] = [
      [
        {
          menuName: 'Parent',
          children: [
            { menuName: 'Child 1' },
            { menuName: 'Disabled', disabled: true },
            { menuName: 'Child 2' }
          ]
        },
        { menuName: 'Last' }
      ]
    ]
    const root = new HostNode('root')
    const app = renderer.createApp(RightClickMenu, {
      menuArr: kind === 'reactive' ? reactive(items) : items,
      clickEvent: { clientX: 8, clientY: 43 },
      confirmCallback: vi.fn(),
      cancelCallback: vi.fn()
    })
    app.mount(root)
    unmount = () => app.unmount()
    await nextTick()
    return root
  }

  it('opens a child panel on hover and keeps it open over a child', async () => {
    const root = await mount()
    const parent = find(root, 'menuButton')[0]
    const hoverParent = parent.props.onMouseover as (event: { stopPropagation: () => void }) => void
    hoverParent({ stopPropagation() {} })
    await nextTick()
    expect(find(body, 'submenuButton')).toHaveLength(3)
    const child = find(body, 'submenuButton')[2]
    const hoverChild = child.props.onMouseover as (event: { stopPropagation: () => void }) => void
    hoverChild({ stopPropagation() {} })
    await nextTick()
    expect(find(body, 'submenuButton')).toHaveLength(3)
    expect(find(body, 'menuButtonOver')).toEqual([child])
  })

  it('advances into children, skips disabled items and reverses with W/S', async () => {
    const root = await mount()
    mocks.handlers.get('s')?.()
    await nextTick()
    expect(find(root, 'menuButtonOver')).toHaveLength(1)
    for (const expected of ['Child 1', 'Child 2']) {
      mocks.handlers.get('s')?.()
      await nextTick()
      const selected = find(body, 'menuButtonOver')[0]
      expect(selected?.children[0]?.props.text).toBe(expected)
    }
    mocks.handlers.get('w')?.()
    await nextTick()
    expect(find(body, 'menuButtonOver')[0]?.children[0]?.props.text).toBe('Child 1')
    mocks.handlers.get('Enter')?.()
    await nextTick()
    expect(find(root, 'menuButton')).toHaveLength(0)
    expect(find(body, 'submenuButton')).toHaveLength(0)
  })
})
