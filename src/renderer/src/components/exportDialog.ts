import { createVNode, render } from 'vue'
import exportDialog from './exportDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'

export default ({
  title,
  forceCopyOnly = false,
  allowSetOrderFileNames = false
}: {
  title: string
  forceCopyOnly?: boolean
  allowSetOrderFileNames?: boolean
}): Promise<
  | 'cancel'
  | {
      folderPathVal: string
      deleteSongsAfterExport: boolean
      useSetOrderFileNames: boolean
    }
> => {
  return new Promise((resolve, _reject) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = (data: {
      folderPathVal: string
      deleteSongsAfterExport: boolean
      useSetOrderFileNames: boolean
    }) => {
      render(null, div)
      div.remove()
      resolve(data)
    }

    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }
    const vnode = createVNode(exportDialog, {
      title,
      forceCopyOnly,
      allowSetOrderFileNames,
      confirmCallback,
      cancelCallback
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
