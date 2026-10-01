// Run: pnpm exec vitest run src/renderer/src/components/settingDialog/CuratedLibrarySyncSettings.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, reactive, ref } from 'vue'
import CuratedLibrarySyncSettings from './CuratedLibrarySyncSettings.vue'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
const runtime = reactive({ setting: { curatedLibrarySyncEnabled: true } })
vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => runtime }))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/utils/analysisRuntimeDownloadUi', () => ({
  formatAnalysisRuntimeBytes: (size: number) => String(size)
}))
vi.mock('@renderer/components/confirmDialog', () => ({ default: vi.fn() }))
vi.mock('@renderer/components/bubbleBoxTrigger.vue', () => ({ default: defineComponent({}) }))
vi.mock('@renderer/composables/runCuratedLibrarySyncUi', () => ({
  runCuratedLibrarySyncUi: vi.fn()
}))
vi.mock('@renderer/composables/useCuratedLibrarySyncStatus', () => ({
  useCuratedLibrarySyncStatus: () => ({
    status: ref({ running: false, phase: 'idle', terminalStatus: 'idle' })
  })
}))
// Reproduce singleCheckbox's change-before-watcher-update event order.
vi.mock('@renderer/components/singleCheckbox.vue', () => ({
  default: defineComponent({
    props: { modelValue: Boolean },
    emits: ['change', 'update:modelValue'],
    setup(props, { emit }) {
      return () =>
        h('checkbox', {
          onChange: () => {
            const value = !props.modelValue
            emit('change', value)
            emit('update:modelValue', value)
          }
        })
    }
  })
}))

type HostNode = {
  type: string
  props: Record<string, unknown>
  children: HostNode[]
  parent: HostNode | null
}
const node = (type: string): HostNode => ({ type, props: {}, children: [], parent: null })
const renderer = createRenderer<HostNode, HostNode>({
  createElement: node,
  createText: () => node('#text'),
  createComment: () => node('#comment'),
  setText: () => {},
  setElementText: () => {},
  patchProp: (target, key, _previous, next) => {
    target.props[key] = next
  },
  parentNode: (target) => target.parent,
  nextSibling: () => null,
  insert: (target, parent) => {
    target.parent = parent
    parent.children.push(target)
  },
  remove: (target) => {
    const siblings = target.parent?.children
    const index = siblings?.indexOf(target) ?? -1
    if (index >= 0) siblings?.splice(index, 1)
  }
})
const findCheckbox = (root: HostNode): HostNode | undefined => {
  if (root.type === 'checkbox') return root
  for (const child of root.children) {
    const match = findCheckbox(child)
    if (match) return match
  }
  return undefined
}
let unmount: (() => void) | undefined
afterEach(() => {
  unmount?.()
  unmount = undefined
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('curated library sync checkbox persistence', () => {
  it.each([true, false])('保存本次勾选值而不是上次的值 (previous=%s)', (previous) => {
    vi.useFakeTimers()
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      setTimeout,
      electron: { ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn() } }
    })
    runtime.setting.curatedLibrarySyncEnabled = previous
    const root = node('root')
    const app = renderer.createApp(CuratedLibrarySyncSettings)
    app.mount(root)
    unmount = () => app.unmount()
    const checkbox = findCheckbox(root)
    const change = checkbox?.props.onChange
    if (typeof change !== 'function') throw new Error('Checkbox change handler missing')
    change()
    expect(mocks.invoke).toHaveBeenCalledWith('setSetting', {
      curatedLibrarySyncEnabled: !previous
    })
    expect(runtime.setting.curatedLibrarySyncEnabled).toBe(!previous)
  })
})
