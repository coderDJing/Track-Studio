import { onMounted, onUnmounted } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'

export function useSetLibrarySyncEvents(): void {
  let notice = ''
  const changed = (_event: unknown, payload: unknown) => {
    if (
      payload &&
      typeof payload === 'object' &&
      'uuids' in payload &&
      Array.isArray(payload.uuids)
    ) {
      emitter.emit('setList/itemsChanged', {
        uuids: payload.uuids.filter((v): v is string => typeof v === 'string')
      })
    }
  }
  const status = async (_event: unknown, payload: unknown) => {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('result' in payload) ||
      payload.result !== 'conflicts' ||
      !('running' in payload) ||
      payload.running ||
      !('conflicts' in payload)
    )
      return
    const signature = JSON.stringify(payload.conflicts)
    if (notice === signature) return
    notice = signature
    await confirm({
      title: t('cloudSync.setLibrary.conflicts'),
      content: [t('cloudSync.setLibrary.notice')],
      confirmShow: false
    })
  }
  onMounted(() => {
    window.electron.ipcRenderer.on('setLibrarySync/status', status)
    window.electron.ipcRenderer.on('setLibrarySync/itemsChanged', changed)
  })
  onUnmounted(() => {
    window.electron.ipcRenderer.removeListener('setLibrarySync/status', status)
    window.electron.ipcRenderer.removeListener('setLibrarySync/itemsChanged', changed)
  })
}
