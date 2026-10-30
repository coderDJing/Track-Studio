// Run: pnpm exec vitest run src/renderer/src/components/setPackageImportDialog.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue'
import type { SetPackagePickResult } from '@shared/setPackage'
import SetPackageImportDialog from './setPackageImportDialog.vue'

vi.mock('hotkeys-js', () => ({ default: vi.fn() }))
vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => ({ confirmShow: false }) }))
vi.mock('@renderer/utils/utils', () => ({
  default: { setHotkeysScpoe: vi.fn(), delHotkeysScope: vi.fn() }
}))
vi.mock('@renderer/utils/translate', () => ({
  t: (key: string, values?: Record<string, unknown>) =>
    `${key} ${values ? JSON.stringify(values) : ''}`.trim()
}))
vi.mock('@renderer/composables/useDialogTransition', () => ({
  useDialogTransition: () => ({
    dialogVisible: ref(true),
    closeWithAnimation: (callback: () => void) => callback()
  })
}))
vi.mock('./bubbleBoxTrigger.vue', () => ({
  default: defineComponent({
    props: { title: String },
    setup:
      (_props, { slots }) =>
      () =>
        h('div', slots.default?.())
  })
}))
vi.mock('./singleCheckbox.vue', () => ({
  default: defineComponent({
    props: { modelValue: Boolean },
    emits: ['update:modelValue'],
    setup:
      (props, { emit }) =>
      () =>
        h('input', {
          checked: props.modelValue,
          onClick: () => emit('update:modelValue', !props.modelValue)
        })
  })
}))

class HostNode {
  props: Record<string, unknown> = {}
  children: HostNode[] = []
  parent: HostNode | null = null
  text = ''
  constructor(public type: string) {}
}
const renderer = createRenderer<HostNode, HostNode>({
  createElement: (type) => new HostNode(type),
  createText: (text) => Object.assign(new HostNode('#text'), { text }),
  createComment: () => new HostNode('#comment'),
  setText: (node, text) => {
    node.text = text
  },
  setElementText: (node, text) => {
    node.text = text
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
    const found = find(child, predicate)
    if (found) return found
  }
}
const content = (node: HostNode): string => node.text + node.children.map(content).join('')
const click = async (node: HostNode) => {
  const handler = node.props.onClick as () => unknown
  await handler()
  await nextTick()
}
const selected: Extract<SetPackagePickResult, { ok: true; canceled: false }> = {
  ok: true,
  canceled: false,
  manifestPath: 'C:/exports/Friday Set/Friday Set.frkbset',
  setName: 'Friday Set',
  trackCount: 50,
  appVersion: '1.2.7'
}
let unmount: (() => void) | undefined
afterEach(() => {
  unmount?.()
  vi.unstubAllGlobals()
})
const mount = async () => {
  const invoke = vi.fn<() => Promise<SetPackagePickResult>>().mockResolvedValue(selected)
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  const root = new HostNode('root')
  const confirmCallback = vi.fn()
  const cancelCallback = vi.fn()
  const app = renderer.createApp(SetPackageImportDialog, { confirmCallback, cancelCallback })
  app.directive('dialog-drag', {})
  app.mount(root)
  unmount = () => app.unmount()
  await nextTick()
  const button = (key: string) => {
    const node = find(root, (node) => node.type === 'button' && node.text.includes(key))
    if (!node) throw new Error(`Missing button: ${key}`)
    return node
  }
  const checkbox = find(root, (node) => node.type === 'input')
  if (!checkbox) throw new Error('Missing cleanup checkbox')
  return { root, invoke, button, checkbox, confirmCallback, cancelCallback }
}

describe('SET import dialog', () => {
  it('先展示文件说明，默认保留源文件夹，尚未选文件时不能开始', async () => {
    const dialog = await mount()
    expect(dialog.invoke).not.toHaveBeenCalled()
    expect(content(dialog.root)).toContain('library.setPackageImportHint')
    expect(dialog.checkbox.props.checked).toBe(false)
    expect(dialog.button('library.setPackageStartImport').props.disabled).toBe(true)
    await click(dialog.button('library.setPackageStartImport'))
    expect(dialog.confirmCallback).not.toHaveBeenCalled()
    await click(dialog.button('common.cancel'))
    expect(dialog.cancelCallback).toHaveBeenCalledOnce()
  })

  it('选文件只更新预览，明确开始后才返回导入与删除选项', async () => {
    const dialog = await mount()
    await click(dialog.button('library.setPackageChooseFile'))
    expect(dialog.invoke).toHaveBeenCalledWith('setList:pick-package')
    expect(content(dialog.root)).toContain(selected.manifestPath)
    expect(content(dialog.root)).toContain('Friday Set')
    expect(content(dialog.root)).toContain('50')
    expect(dialog.confirmCallback).not.toHaveBeenCalled()
    expect(dialog.button('library.setPackageStartImport').props.disabled).toBe(false)
    await click(dialog.checkbox)
    await click(dialog.button('library.setPackageStartImport'))
    expect(dialog.confirmCallback).toHaveBeenCalledWith({
      picked: selected,
      deleteSourceAfterImport: true
    })
  })

  it('取消系统文件选择后保留已有选择，可以不删除源文件夹直接导入', async () => {
    const dialog = await mount()
    await click(dialog.button('library.setPackageChooseFile'))
    dialog.invoke.mockResolvedValueOnce({ ok: true, canceled: true })
    await click(dialog.button('library.setPackageChooseFile'))
    await click(dialog.button('library.setPackageStartImport'))
    expect(dialog.confirmCallback).toHaveBeenCalledWith({
      picked: selected,
      deleteSourceAfterImport: false
    })
  })

  it('无效描述文件在弹窗内提示并禁用开始导入', async () => {
    const dialog = await mount()
    await click(dialog.button('library.setPackageChooseFile'))
    dialog.invoke.mockResolvedValueOnce({ ok: false, code: 'MANIFEST_INVALID', message: 'invalid' })
    await click(dialog.button('library.setPackageChooseFile'))
    expect(content(dialog.root)).toContain('library.setPackageInvalidManifest')
    expect(dialog.button('library.setPackageStartImport').props.disabled).toBe(true)
    await click(dialog.button('library.setPackageStartImport'))
    expect(dialog.confirmCallback).not.toHaveBeenCalled()
  })

  it('读取文件时阻止重复选择和提前开始', async () => {
    const dialog = await mount()
    let finish: ((result: SetPackagePickResult) => void) | undefined
    dialog.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const picking = click(dialog.button('library.setPackageChooseFile'))
    await nextTick()
    expect(dialog.button('library.setPackageChooseFile').props.disabled).toBe(true)
    await click(dialog.button('library.setPackageChooseFile'))
    await click(dialog.button('library.setPackageStartImport'))
    expect(dialog.invoke).toHaveBeenCalledOnce()
    expect(dialog.confirmCallback).not.toHaveBeenCalled()
    finish?.(selected)
    await picking
    expect(dialog.button('library.setPackageStartImport').props.disabled).toBe(false)
  })
})
