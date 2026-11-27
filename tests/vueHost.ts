import { createRenderer, nextTick } from 'vue'
import { vi } from 'vitest'
export class HostNode {
  style = {
    setProperty: (name: string, value: string) => {
      ;(this.style as unknown as Record<string, string>)[name] = value
    },
    getPropertyValue: (name: string) =>
      (this.style as unknown as Record<string, string>)[name] || '',
    removeProperty: (name: string) => {
      const old = (this.style as unknown as Record<string, string>)[name]
      delete (this.style as unknown as Record<string, string>)[name]
      return old || ''
    }
  } as unknown as CSSStyleDeclaration

  props: Record<string, unknown> = {}
  children: HostNode[] = []
  parent: HostNode | null = null
  constructor(public type: string) {}
  scrollTop = 0
  scrollLeft = 0
  clientHeight = 300
  clientWidth = 900
  get dataset() {
    return Object.fromEntries(
      Object.entries(this.props)
        .filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [
          key.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
          value
        ])
    ) as Record<string, string>
  }
  getBoundingClientRect() {
    return {
      top: 0,
      left: 0,
      right: 900,
      bottom: 30,
      width: 900,
      height: 30,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }
  }
  closest(selector: string): HostNode | null {
    const match = selector.split(',').some((part) => {
      part = part.trim()
      return part.startsWith('.')
        ? String(this.props.class || '')
            .split(' ')
            .includes(part.slice(1))
        : this.type === part
    })
    return match ? this : this.parent?.closest(selector) || null
  }
  querySelectorAll() {
    return []
  }
  querySelector() {
    return null
  }
  get classList() {
    return {
      add: () => {},
      remove: () => {},
      contains: (name: string) => String(this.props.class || '').includes(name)
    }
  }
  get tagName() {
    return this.type.toUpperCase()
  }
  get options() {
    return this.children.filter((node) => node.type === 'option')
  }
  get value() {
    return this.props.value
  }
  set value(value: unknown) {
    this.props.value = value
  }
  getRootNode() {
    return { activeElement: null }
  }
  private listeners = new Map<string, Set<(event: unknown) => unknown>>()
  addEventListener = vi.fn((type: string, handler: (event: unknown) => unknown) => {
    const list = this.listeners.get(type) || new Set()
    list.add(handler)
    this.listeners.set(type, list)
  })
  removeEventListener = vi.fn((type: string, handler: (event: unknown) => unknown) => {
    this.listeners.get(type)?.delete(handler)
  })
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this })
  }

  removeAttribute(name: string) {
    delete this.props[name]
  }
  getAttribute(name: string) {
    return this.props[name]
  }
  select = vi.fn()
  focus = vi.fn()
  pause = vi.fn()
  contains() {
    return false
  }
}
export const teleportBody = new HostNode('body')
export const renderer = createRenderer<HostNode, HostNode>({
  querySelector: () => teleportBody,
  createElement: (type) => new HostNode(type),
  createText: (text) => {
    const node = new HostNode('#text')
    node.props.text = text
    return node
  },
  createComment: () => new HostNode('#comment'),
  setText: (node, text) => {
    node.props.text = text
  },
  setElementText: (node, text) => {
    node.props.text = text
  },
  patchProp: (node, key, _old, value) => {
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
  }
})
export const nodes = (node: HostNode): HostNode[] => [node, ...node.children.flatMap(nodes)]
export const text = (node: HostNode): string =>
  String(node.props.text || '') + node.children.map(text).join('')
export const flush = async () => {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
    await nextTick()
  }
}
