import emitter from './mitt'
import { toIpcCloneablePayload } from './ipcCloneablePayload'
import { t } from './translate'
import type { SetCustodyAppendPayload } from '@shared/setCustody'

export async function appendExternalSongsToSet(payload: SetCustodyAppendPayload) {
  await window.electron.ipcRenderer.invoke(
    'setList:append-custody-items',
    toIpcCloneablePayload(payload)
  )
  emitter.emit('playlistContentChanged', { uuids: [payload.playlistUuid] })
  emitter.emit('setList/itemsChanged', { uuids: [payload.playlistUuid] })
  emitter.emit('songsArea/clipboardHint', { message: t('library.addToSet') })
}
