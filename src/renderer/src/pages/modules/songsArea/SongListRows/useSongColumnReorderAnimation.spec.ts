import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, markRaw, nextTick, onUpdated, ref } from 'vue'
import type { ISongsAreaColumn } from '../../../../../../types/globals'
import { useSongColumnReorderAnimation } from './useSongColumnReorderAnimation'

type Operation =
  | { kind: 'read'; target: string }
  | { kind: 'animate'; target: string; frames: Keyframe[]; options: KeyframeAnimationOptions }
  | { kind: 'cancel'; target: string }

let operations: Operation[] = []
const mountedApps = new Set<() => void>()

class TestAnimation {
  onfinish: (() => void) | null = null
  cancel: ReturnType<typeof vi.fn>

  constructor(target: string) {
    this.cancel = vi.fn(() => operations.push({ kind: 'cancel', target }))
  }
}

class TestElement {
  text = ''
  props: Record<string, unknown> = {}
  children: TestElement[] = []
  parent: TestElement | null = null
  animations: TestAnimation[] = []

  constructor(public type: string) {
    markRaw(this)
  }

  get label(): string {
    return `${String(this.props['data-row'] ?? '')}:${String(this.props['data-column'] ?? this.type)}`
  }

  private get left(): number {
    if (this.props.class === 'song-row-columns') {
      return 100 - Number(this.parent?.parent?.props['data-scroll-left'] || 0)
    }
    const parent = this.parent
    if (!parent) return 0
    const index = parent.children.indexOf(this)
    const precedingWidth = parent.children
      .slice(0, index)
      .reduce((width, child) => width + Number(child.props['data-width'] || 0), 0)
    return parent.left + precedingWidth
  }

  getBoundingClientRect(): DOMRect {
    operations.push({ kind: 'read', target: this.label })
    const left = this.left
    const width = Number(this.props['data-width'] || 0)
    return {
      x: left,
      y: 0,
      left,
      top: 0,
      right: left + width,
      bottom: 30,
      width,
      height: 30,
      toJSON: () => ({ left, width })
    }
  }

  querySelectorAll(selector: string): TestElement[] {
    const matches: TestElement[] = []
    const visit = (element: TestElement) => {
      for (const child of element.children) {
        if (selector === '.song-row-columns' && child.props.class === 'song-row-columns') {
          matches.push(child)
        }
        visit(child)
      }
    }
    visit(this)
    return matches
  }

  animate(frames: Keyframe[], options: KeyframeAnimationOptions): TestAnimation {
    operations.push({ kind: 'animate', target: this.label, frames, options })
    const animation = new TestAnimation(this.label)
    this.animations.push(animation)
    return animation
  }
}

const renderer = createRenderer<TestElement, TestElement>({
  createElement: (type) => new TestElement(type),
  createText: (text) => Object.assign(new TestElement('#text'), { text }),
  createComment: (text) => Object.assign(new TestElement('#comment'), { text }),
  setText: (element, text) => {
    element.text = text
  },
  setElementText: (element, text) => {
    element.text = text
  },
  patchProp: (element, key, _previous, next) => {
    element.props[key] = next
  },
  parentNode: (element) => element.parent,
  nextSibling: (element) => {
    const siblings = element.parent?.children ?? []
    return siblings[siblings.indexOf(element) + 1] ?? null
  },
  insert: (element, parent, anchor) => {
    if (element.parent) {
      const index = element.parent.children.indexOf(element)
      if (index >= 0) element.parent.children.splice(index, 1)
    }
    element.parent = parent
    const anchorIndex = anchor ? parent.children.indexOf(anchor) : -1
    if (anchorIndex >= 0) parent.children.splice(anchorIndex, 0, element)
    else parent.children.push(element)
  },
  remove: (element) => {
    const siblings = element.parent?.children
    const index = siblings?.indexOf(element) ?? -1
    if (index >= 0) siblings?.splice(index, 1)
    element.parent = null
  }
})

const column = (key: string, width: number): ISongsAreaColumn => ({
  key,
  columnName: key,
  width,
  show: true
})

const mountRows = (theme: string) => {
  const columns = ref([column('a', 40), column('b', 60), column('c', 80)])
  const visibleRows = ref([10, 11])
  const scrollTop = ref(0)
  const scrollLeft = ref(0)
  const contentVersion = ref(0)
  const selectedRow = ref<number | null>(null)
  const root = new TestElement('root')
  let afterUpdate: (() => void) | undefined
  let renders = 0
  const app = renderer.createApp(
    defineComponent({
      setup() {
        const rowsRoot = ref<HTMLElement | null>(null)
        useSongColumnReorderAnimation(rowsRoot, columns)
        onUpdated(() => afterUpdate?.())
        return () => {
          renders += 1
          return h(
            'div',
            { ref: rowsRoot, class: theme, 'data-scroll-left': scrollLeft.value },
            visibleRows.value.map((row) =>
              h('div', { key: row, 'data-scroll-top': scrollTop.value }, [
                h(
                  'div',
                  { class: 'song-row-columns', 'data-row': row },
                  columns.value.map((item) =>
                    h(
                      'div',
                      {
                        key: item.key,
                        'data-row': row,
                        'data-column': item.key,
                        'data-width': item.width,
                        'data-selected': selectedRow.value === row
                      },
                      `${row}:${item.key}:${contentVersion.value}`
                    )
                  )
                )
              ])
            )
          )
        }
      }
    })
  )
  app.mount(root)
  const unmount = () => {
    mountedApps.delete(unmount)
    app.unmount()
  }
  mountedApps.add(unmount)
  return {
    columns,
    visibleRows,
    scrollTop,
    scrollLeft,
    contentVersion,
    selectedRow,
    root,
    unmount,
    setAfterUpdate: (callback: (() => void) | undefined) => {
      afterUpdate = callback
    },
    renders: () => renders,
    cells: () =>
      root.children[0].querySelectorAll('.song-row-columns').flatMap((row) => row.children)
  }
}

const flushUpdates = async () => {
  await nextTick()
  await nextTick()
}

const reorder = (mounted: ReturnType<typeof mountRows>, keys: string[]) => {
  const byKey = new Map(mounted.columns.value.map((item) => [item.key, item]))
  mounted.columns.value = keys.map((key) => {
    const item = byKey.get(key)
    if (!item) throw new Error(`missing test column ${key}`)
    return item
  })
}

beforeEach(() => {
  operations = []
  vi.stubGlobal('HTMLElement', TestElement)
})

afterEach(() => {
  for (const unmount of mountedApps) unmount()
  vi.unstubAllGlobals()
})

describe.each(['theme-light', 'theme-dark'])('column reorder animation in %s', (theme) => {
  it('does no geometry work for scroll, row updates, or unchanged column order', async () => {
    const mounted = mountRows(theme)
    expect(operations).toEqual([])
    mounted.scrollTop.value = 285000
    mounted.scrollLeft.value = 240
    mounted.visibleRows.value = [9500, 9501]
    await flushUpdates()
    mounted.contentVersion.value += 1
    mounted.selectedRow.value = 9501
    mounted.columns.value[0].width += 20
    await flushUpdates()
    mounted.columns.value = mounted.columns.value.map((item) => ({ ...item }))
    await flushUpdates()

    expect(mounted.renders()).toBeGreaterThan(1)
    expect(mounted.root.children[0].props.class).toBe(theme)
    expect(mounted.cells().map((cell) => cell.props['data-row'])).toEqual([
      9500, 9500, 9500, 9501, 9501, 9501
    ])
    expect(operations).toEqual([])
  })

  it('measures only mounted rows, then animates horizontal column moves after all reads', async () => {
    const mounted = mountRows(theme)
    mounted.visibleRows.value = [9500, 9501]
    mounted.scrollLeft.value = 240
    await flushUpdates()
    reorder(mounted, ['c', 'a', 'b'])
    await flushUpdates()

    const reads = operations.filter((operation) => operation.kind === 'read')
    const writes = operations.filter((operation) => operation.kind === 'animate')
    expect(reads).toHaveLength(16)
    expect(reads.every((operation) => /^(9500|9501):/.test(operation.target))).toBe(true)
    expect(writes).toHaveLength(6)
    expect(operations.slice(0, 16).every((operation) => operation.kind === 'read')).toBe(true)
    expect(operations.slice(16).every((operation) => operation.kind === 'animate')).toBe(true)
    for (const operation of writes) {
      const displacement = operation.target.endsWith(':c') ? 100 : -80
      expect(operation.frames).toEqual([
        { transform: `translateX(${displacement}px)` },
        { transform: 'translateX(0)' }
      ])
      expect(operation.options).toEqual({ duration: 150, easing: 'ease' })
    }
  })

  it('skips stale post-render work when another reorder arrives during the same update', async () => {
    const mounted = mountRows(theme)
    mounted.setAfterUpdate(() => {
      mounted.setAfterUpdate(undefined)
      reorder(mounted, ['c', 'a', 'b'])
    })
    reorder(mounted, ['b', 'a', 'c'])
    await flushUpdates()

    expect(operations.filter((operation) => operation.kind === 'read')).toHaveLength(24)
    const writes = operations.filter((operation) => operation.kind === 'animate')
    expect(writes).toHaveLength(6)
    for (const operation of writes) {
      const displacement = operation.target.endsWith(':c')
        ? 100
        : operation.target.endsWith(':a')
          ? -20
          : -120
      expect(operation.frames[0]).toEqual({ transform: `translateX(${displacement}px)` })
    }
  })

  it('cancels active animations on another reorder and on unmount', async () => {
    const mounted = mountRows(theme)
    reorder(mounted, ['c', 'a', 'b'])
    await flushUpdates()
    const previousAnimations = mounted.cells().flatMap((cell) => cell.animations)
    expect(previousAnimations).toHaveLength(6)
    reorder(mounted, ['a', 'b', 'c'])
    await flushUpdates()
    expect(previousAnimations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(
      true
    )
    const activeAnimations = mounted.cells().map((cell) => cell.animations.at(-1))
    mounted.unmount()
    expect(activeAnimations.every((animation) => animation?.cancel.mock.calls.length === 1)).toBe(
      true
    )
  })

  it('does not animate or read again after unmounting with a reorder pending', async () => {
    const mounted = mountRows(theme)
    mounted.setAfterUpdate(() => mounted.unmount())
    reorder(mounted, ['c', 'a', 'b'])
    await flushUpdates()

    expect(operations.filter((operation) => operation.kind === 'read')).toHaveLength(8)
    expect(operations.filter((operation) => operation.kind === 'animate')).toEqual([])
  })

  it('removes finished animations from the cancellation set', async () => {
    const mounted = mountRows(theme)
    reorder(mounted, ['c', 'a', 'b'])
    await flushUpdates()
    const finished = mounted.cells().flatMap((cell) => cell.animations)
    for (const animation of finished) animation.onfinish?.()
    mounted.unmount()
    expect(finished.every((animation) => animation.cancel.mock.calls.length === 0)).toBe(true)
  })
})
