// Run: pnpm exec vitest run src/renderer/src/components/trackReanalysisDialog.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue'
import { DEFAULT_TRACK_REANALYSIS_SELECTION } from '@shared/trackReanalysisSelection'
import TrackReanalysisDialog from './trackReanalysisDialog.vue'

vi.mock('hotkeys-js', () => ({ default: vi.fn() }))
vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => ({ confirmShow: false }) }))
vi.mock('@renderer/utils/utils', () => ({
  default: { setHotkeysScpoe: vi.fn(), delHotkeysScope: vi.fn() }
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/utils/analysisBpmRangeUi', () => ({ buildAnalysisBpmRangeOptions: () => [] }))
vi.mock('@renderer/composables/useDialogTransition', () => ({
  useDialogTransition: () => ({
    dialogVisible: ref(true),
    closeWithAnimation: (callback: () => void) => callback()
  })
}))
vi.mock('./BaseSelect.vue', () => ({ default: defineComponent(() => () => h('select')) }))
vi.mock('./bubbleBoxTrigger.vue', () => ({
  default: defineComponent({
    setup:
      (_props, { slots }) =>
      () =>
        h('div', slots.default?.())
  })
}))
vi.mock('./singleCheckbox.vue', () => ({
  default: defineComponent({
    props: { id: String, modelValue: Boolean, disabled: Boolean },
    emits: ['update:modelValue'],
    setup:
      (props, { emit }) =>
      () =>
        h('button', {
          id: props.id,
          checked: props.modelValue,
          disabled: props.disabled,
          onClick: () => {
            if (!props.disabled) emit('update:modelValue', !props.modelValue)
          }
        })
  })
}))

class HostNode {
  props: Record<string, unknown> = {}
  children: HostNode[] = []
  parent: HostNode | null = null
  constructor(public type: string) {}
}
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
  }
})
const find = (node: HostNode, predicate: (node: HostNode) => boolean): HostNode | undefined => {
  if (predicate(node)) return node
  for (const child of node.children) {
    const result = find(child, predicate)
    if (result) return result
  }
}
let unmount: (() => void) | undefined
afterEach(() => {
  unmount?.()
})

const mount = async (canSelectStructureAlone: boolean) => {
  const root = new HostNode('root')
  const confirmCallback = vi.fn()
  const cancelCallback = vi.fn()
  const app = renderer.createApp(TrackReanalysisDialog, {
    count: 50,
    initialSelection: { ...DEFAULT_TRACK_REANALYSIS_SELECTION },
    canSelectStructureAlone,
    confirmCallback,
    cancelCallback
  })
  app.directive('dialog-drag', {})
  app.mount(root)
  unmount = () => app.unmount()
  await nextTick()
  const checkbox = (name: string) => {
    const node = find(root, (node) => node.props.id === `reanalysis-option-${name}`)
    if (!node) throw new Error(`Missing checkbox: ${name}`)
    return node
  }
  const click = async (node: HostNode | undefined) => {
    if (!node) throw new Error('Missing button')
    ;(node.props.onClick as () => void)()
    await nextTick()
  }
  const button = (text: string) => find(root, (node) => String(node.props.text).includes(text))
  return { checkbox, click, button, confirmCallback, cancelCallback }
}

describe.each([true, false])('track reanalysis dialog with existing grid: %s', (hasGrid) => {
  it('取消 Key 和波形后仍能取消弹窗', async () => {
    const dialog = await mount(hasGrid)
    await dialog.click(dialog.checkbox('key'))
    await dialog.click(dialog.checkbox('waveform'))
    expect(dialog.checkbox('key').props.checked).toBe(false)
    expect(dialog.checkbox('waveform').props.checked).toBe(false)
    await dialog.click(dialog.button('common.cancel'))
    expect(dialog.cancelCallback).toHaveBeenCalledOnce()
    expect(dialog.confirmCallback).not.toHaveBeenCalled()
  })

  it('连续切换所有选项后仍能开始分析，依赖网格正确锁定和解锁', async () => {
    const dialog = await mount(hasGrid)
    await dialog.click(dialog.checkbox('key'))
    await dialog.click(dialog.checkbox('waveform'))
    await dialog.click(dialog.checkbox('energy'))
    expect(dialog.checkbox('beat-grid').props.disabled).toBe(!hasGrid)
    await dialog.click(dialog.checkbox('structure'))
    expect(dialog.checkbox('beat-grid').props.disabled).toBe(false)
    await dialog.click(dialog.checkbox('beat-grid'))
    expect(dialog.checkbox('beat-grid').props.checked).toBe(false)
    expect(dialog.button('tracks.analysisStart')?.props.onClick).toBeUndefined()
    await dialog.click(dialog.checkbox('structure'))
    expect(dialog.checkbox('beat-grid').props.checked).toBe(!hasGrid)
    await dialog.click(dialog.checkbox('energy'))
    expect(dialog.checkbox('beat-grid').props.checked).toBe(true)
    expect(dialog.checkbox('beat-grid').props.disabled).toBe(true)
    await dialog.click(dialog.button('tracks.analysisStart'))
    expect(dialog.confirmCallback).toHaveBeenCalledWith({
      selection: { key: false, waveform: false, energy: true, structure: true, beatGrid: true },
      analysisBpmRangeId: expect.any(String)
    })
  })
})
