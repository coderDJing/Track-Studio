import { createVNode, render } from 'vue'
import globalCallShortcutDialog from './globalCallShortcutDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'

export default (): Promise<'success' | 'cancel'> => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = () => {
      render(null, div)
      div.remove()
      resolve('success')
    }

    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }
    const vnode = createVNode(globalCallShortcutDialog, {
      confirmCallback,
      cancelCallback
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
