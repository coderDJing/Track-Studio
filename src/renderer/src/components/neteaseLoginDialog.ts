import { createVNode, render } from 'vue'
import NeteaseLoginDialog from './neteaseLoginDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'

/** 打开网易云扫码登录，resolve(true) 表示登录成功 */
export default (): Promise<boolean> =>
  new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const close = (ok: boolean) => {
      render(null, div)
      div.remove()
      resolve(ok)
    }
    const vnode = createVNode(NeteaseLoginDialog, {
      onSuccess: () => close(true),
      onCancel: () => close(false)
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
