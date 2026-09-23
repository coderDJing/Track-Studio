import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import ExternalLibraryTargetDialog from './externalLibraryTargetDialog.vue'
import type {
  ExternalLibraryKind,
  ExternalLibraryPlaylistWriteTarget
} from '@shared/externalLibrary'

export type ExternalLibraryTargetDialogResult =
  | 'cancel'
  | { target: ExternalLibraryPlaylistWriteTarget }

export default (params: {
  kind: ExternalLibraryKind
  sourcePath: string
  dialogTitle: string
  defaultPlaylistName: string
  trackCount?: number
}): Promise<ExternalLibraryTargetDialogResult> =>
  new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const close = (result: ExternalLibraryTargetDialogResult) => {
      render(null, div)
      div.remove()
      resolve(result)
    }
    const vnode = createVNode(ExternalLibraryTargetDialog, {
      ...params,
      confirmCallback: (payload: { target: ExternalLibraryPlaylistWriteTarget }) => close(payload),
      cancelCallback: () => close('cancel')
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
