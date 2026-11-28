import { ipcMain } from 'electron'
import { isMixtapeStemQueueBusy } from '../services/mixtapeStemQueue'

const loadDemucsUltraModelDownload = () => import('../services/demucsUltraModelDownload')

export function registerDemucsModelHandlers() {
  ipcMain.handle('demucs-model:get-ultra-status', async () => {
    const { getDemucsUltraModelDownloadInfo } = await loadDemucsUltraModelDownload()
    return await getDemucsUltraModelDownloadInfo()
  })

  ipcMain.handle('demucs-model:download-ultra', async () => {
    const {
      downloadDemucsUltraModel,
      getDemucsUltraModelDownloadInfo,
      getDemucsUltraModelDownloadState
    } = await loadDemucsUltraModelDownload()
    const started = await downloadDemucsUltraModel()
    return {
      started,
      state: getDemucsUltraModelDownloadState(),
      info: await getDemucsUltraModelDownloadInfo()
    }
  })

  ipcMain.handle('demucs-model:remove-ultra', async () => {
    const {
      getDemucsUltraModelDownloadInfo,
      isDemucsUltraModelDownloadBusy,
      removeDemucsUltraModel
    } = await loadDemucsUltraModelDownload()
    if (isDemucsUltraModelDownloadBusy() || isMixtapeStemQueueBusy()) {
      return { removedModel: false, removedDownloadCache: false, busy: true }
    }
    const result = await removeDemucsUltraModel()
    return {
      ...result,
      info: await getDemucsUltraModelDownloadInfo()
    }
  })
}
