import { createVNode, render } from 'vue'
import CollectionHealthDialog from './CollectionHealthDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'

export default function showCollectionHealthDialog(params: { libraryName: string }) {
  return new Promise<void>((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const cleanup = () => {
      render(null, div)
      div.remove()
    }

    const handleClose = () => {
      cleanup()
      resolve()
    }

    const vnode = createVNode(CollectionHealthDialog, {
      libraryName: params.libraryName,
      onClose: handleClose
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
