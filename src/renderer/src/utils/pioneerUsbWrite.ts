import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import emitter from './mitt'
import type {
  PioneerUsbWritePreview,
  PioneerUsbWriteRequest,
  PioneerUsbWriteResponse,
  PioneerUsbWriteSummary
} from '@shared/pioneerUsbWrite'

export const showPioneerUsbWriteError = async (
  error: unknown,
  title = t('pioneerUsb.failureTitle')
) => {
  await confirm({
    title,
    content: [error instanceof Error ? error.message : String(error)],
    confirmShow: false,
    innerWidth: 660,
    innerHeight: 0,
    textAlign: 'left',
    canCopyText: true
  })
}

/** Prepare every edit, but interrupt the normal interaction only for actual deletion. */
export const prepareAndApplyPioneerUsbWrite = async (
  request: PioneerUsbWriteRequest,
  operationLabel: string
): Promise<PioneerUsbWriteSummary | null> => {
  try {
    if (!['delete-tracks', 'delete-playlist'].includes(request.operation.kind)) {
      const response = (await window.electron.ipcRenderer.invoke(
        'pioneer-device-library:write',
        JSON.parse(JSON.stringify(request))
      )) as PioneerUsbWriteResponse
      if (!response.ok) throw new Error(response.error)
      return response.result
    }
    const prepared = (await window.electron.ipcRenderer.invoke(
      'pioneer-device-library:prepare-write',
      JSON.parse(JSON.stringify(request))
    )) as PioneerUsbWriteResponse<PioneerUsbWritePreview>
    if (!prepared.ok) throw new Error(prepared.error)
    const { token, summary } = prepared.result
    const approved = await confirm({
      title: t('common.delete'),
      content: [
        operationLabel,
        t('pioneerUsb.previewDevice', { path: request.rootPath }),
        t('pioneerUsb.previewTracks', { count: summary.deletedTrackCount }),
        t('pioneerUsb.previewShared', { count: summary.preservedSharedFileCount }),
        t('pioneerUsb.deleteWarning'),
        t('pioneerUsb.keepConnected')
      ],
      innerWidth: 700,
      innerHeight: 0,
      textAlign: 'left',
      confirmText: t('common.delete')
    })
    if (approved !== 'confirm') return null
    const applied = (await window.electron.ipcRenderer.invoke(
      'pioneer-device-library:apply-write',
      token
    )) as PioneerUsbWriteResponse
    if (!applied.ok) throw new Error(applied.error)
    if (applied.result.deletedTrackFilePaths?.length)
      emitter.emit('pioneerUsb/tracks-deleted', {
        rootPath: request.rootPath,
        filePaths: applied.result.deletedTrackFilePaths
      })
    return applied.result
  } catch (error) {
    await showPioneerUsbWriteError(error)
    return null
  }
}
