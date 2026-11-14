import { createVNode, render } from 'vue'
import ReleaseNotesDialog from './releaseNotesDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type { AppUpdateChannel } from '@shared/appUpdate'
import type { ReleaseNotesRangePayload } from '@shared/releaseNotes'

export type ReleaseNotesDialogPayload = {
  version: string
  releaseDate: string
  channel: AppUpdateChannel
  releaseNotes: ReleaseNotesRangePayload | null
  loading?: boolean
}

export default (payload: ReleaseNotesDialogPayload) =>
  new Promise<void>((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const onClose = () => {
      render(null, div)
      div.remove()
      resolve()
    }

    const vnode = createVNode(ReleaseNotesDialog, { ...payload, onClose })
    attachAppContext(vnode)
    render(vnode, div)
  })
