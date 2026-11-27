import { createVNode, render } from 'vue'
import playerGlobalShortcutDialog from './playerGlobalShortcutDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type { PlayerGlobalShortcutAction } from 'src/types/globals'

export type PlayerGlobalShortcutDialogTarget = PlayerGlobalShortcutAction | 'seekPercentModifier'

export default (target: PlayerGlobalShortcutDialogTarget): Promise<'success' | 'cancel'> => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const cleanup = () => {
      render(null, div)
      div.remove()
    }

    const confirmCallback = () => {
      cleanup()
      resolve('success')
    }

    const cancelCallback = () => {
      cleanup()
      resolve('cancel')
    }

    const isModifierMode = target === 'seekPercentModifier'
    const vnode = createVNode(playerGlobalShortcutDialog, {
      actionKey: isModifierMode ? undefined : target,
      mode: isModifierMode ? 'seekPercentModifier' : 'action',
      confirmCallback,
      cancelCallback
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
