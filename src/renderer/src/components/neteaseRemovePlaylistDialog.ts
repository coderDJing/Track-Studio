import { createVNode, render } from 'vue'
import NeteaseRemovePlaylistDialog from './neteaseRemovePlaylistDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'

export type NeteaseRemovePlaylistDialogResult =
  { confirmed: false } | { confirmed: true; alsoDeleteLocal: boolean; remember: boolean }

export default (options: {
  title: string
  count: number
  downloadedCount: number
  headingKey?: string
  messageKey?: string
  downloadedCountKey?: string
}): Promise<NeteaseRemovePlaylistDialogResult> => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const close = (result: NeteaseRemovePlaylistDialogResult) => {
      render(null, div)
      div.remove()
      resolve(result)
    }

    const vnode = createVNode(NeteaseRemovePlaylistDialog, {
      title: options.title,
      count: options.count,
      downloadedCount: options.downloadedCount,
      headingKey: options.headingKey,
      messageKey: options.messageKey,
      downloadedCountKey: options.downloadedCountKey,
      confirmCallback: (payload: { alsoDeleteLocal: boolean; remember: boolean }) => {
        close({
          confirmed: true,
          alsoDeleteLocal: payload.alsoDeleteLocal,
          remember: payload.remember
        })
      },
      cancelCallback: () => {
        close({ confirmed: false })
      }
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
