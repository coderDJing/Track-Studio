import { t } from '@renderer/utils/translate'

type PioneerDriveEjectFailure = {
  code?: 'INVALID_PATH' | 'EJECT_COMMAND_FAILED' | 'EJECT_TIMEOUT' | 'UNSUPPORTED_PLATFORM'
  detail?: string
}

export const buildPioneerDriveEjectErrorContent = (result?: PioneerDriveEjectFailure): string[] => {
  if (result?.code === 'INVALID_PATH') {
    return [t('library.ejectUsbDriveInvalidPath')]
  }

  const content = [t('library.ejectUsbDriveFailed')]
  const detail = String(result?.detail || '').trim()
  if (detail) {
    content.push(detail)
  }
  if (result?.code === 'EJECT_TIMEOUT' || result?.code === 'EJECT_COMMAND_FAILED') {
    content.push(t('library.ejectUsbDriveFailedHint'))
  }
  return content
}
