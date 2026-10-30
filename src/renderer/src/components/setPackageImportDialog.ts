import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type { SetPackageImportDialogResult } from '@shared/setPackage'
import SetPackageImportDialog from './setPackageImportDialog.vue'

export default () =>
  new Promise<SetPackageImportDialogResult | null>((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const close = (value: SetPackageImportDialogResult | null) => {
      render(null, container)
      container.remove()
      resolve(value)
    }
    const vnode = createVNode(SetPackageImportDialog, {
      confirmCallback: (value: SetPackageImportDialogResult) => close(value),
      cancelCallback: () => close(null)
    })
    attachAppContext(vnode)
    render(vnode, container)
  })
