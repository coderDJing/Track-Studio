import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type { RekordboxDesktopWriteAvailability } from '@shared/rekordboxDesktopPlaylist'

type WriteAvailabilityBlockContext = 'write' | 'create' | 'move' | 'edit'

const probeWriteAvailability = async (): Promise<RekordboxDesktopWriteAvailability | null> => {
  try {
    return (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'probe-write')
    )) as RekordboxDesktopWriteAvailability
  } catch {
    return null
  }
}

const buildBlockedContent = (
  status: RekordboxDesktopWriteAvailability | null,
  context: WriteAvailabilityBlockContext
) => {
  const content: string[] = []
  if (!status) {
    content.push(t('rekordboxDesktop.writeCheckUnknown'))
  } else if (status.status === 'busy') {
    content.push(t('rekordboxDesktop.writeCheckBusy'))
  } else if (status.status === 'unavailable') {
    content.push(t('rekordboxDesktop.writeCheckUnavailable'))
  } else {
    const message = String(status.errorMessage || '').trim()
    if (message) {
      content.push(t('rekordboxDesktop.writeCheckUnknownWithReason', { message }))
    } else {
      content.push(t('rekordboxDesktop.writeCheckUnknown'))
    }
  }

  if (context === 'create') {
    content.push(t('rekordboxDesktop.writeCheckCreateHint'))
  } else if (context === 'move') {
    content.push(t('rekordboxDesktop.writeCheckMoveHint'))
  } else if (context === 'edit') {
    content.push(t('rekordboxDesktop.writeCheckEditHint'))
  } else {
    content.push(t('rekordboxDesktop.writeCheckWriteHint'))
  }

  return content
}

export const ensureRekordboxDesktopWriteAvailable = async (
  context: WriteAvailabilityBlockContext
) => {
  const status = await probeWriteAvailability()
  if (status?.writable) return true

  if (status?.status === 'busy' && (status.rekordboxPid ?? 0) > 0) {
    const result = await confirm({
      title: t('rekordboxDesktop.liveWriteTitle'),
      content: [t('rekordboxDesktop.liveWriteWarning'), t('rekordboxDesktop.liveWriteRefresh')],
      confirmText: t('rekordboxDesktop.liveWriteContinue')
    })
    return result === 'confirm'
  }

  await confirm({
    title: t('rekordboxDesktop.writeCheckBlockedTitle'),
    content: buildBlockedContent(status, context),
    confirmShow: false,
    innerHeight: 0
  })
  return false
}
