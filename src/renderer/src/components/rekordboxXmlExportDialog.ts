import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import rekordboxXmlExportDialog from './rekordboxXmlExportDialog.vue'
import type { RekordboxXmlExportMode } from '@shared/rekordboxXmlExport'

type RekordboxXmlExportDialogResult =
  | 'cancel'
  | {
      targetRootDir: string
      exportDirName: string
      xmlFileName: string
      xmlPlaylistName: string
      mode: RekordboxXmlExportMode
    }

export default (params: {
  dialogTitle: string
  defaultExportDirName: string
  defaultXmlFileName: string
  defaultXmlPlaylistName: string
  lockMode?: RekordboxXmlExportMode
}): Promise<RekordboxXmlExportDialogResult> => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = (payload: Exclude<RekordboxXmlExportDialogResult, 'cancel'>) => {
      render(null, div)
      div.remove()
      resolve(payload)
    }

    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }

    const vnode = createVNode(rekordboxXmlExportDialog, {
      ...params,
      confirmCallback,
      cancelCallback
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
