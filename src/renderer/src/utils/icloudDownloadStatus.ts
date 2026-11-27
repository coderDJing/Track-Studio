import { readIcloudDownloadPercent, type IcloudDownloadProgress } from '@shared/icloudLibrary'
import type { CloudPlaybackState } from './icloudPlayback'

export function mergeIcloudDownloadProgress(
  current: CloudPlaybackState | undefined,
  data: IcloudDownloadProgress,
  transferRequestId?: string
): CloudPlaybackState | undefined {
  if (current?.requestId !== data.requestId && data.requestId !== transferRequestId) return current
  if (current?.state === 'failed' && current.error === 'cancelled') return current
  const percent = data.state === 'downloading' ? readIcloudDownloadPercent(data.percent) : undefined
  return {
    ...current,
    state: data.state,
    requestId: data.requestId,
    ...(percent == null ? { percent: undefined } : { percent })
  }
}

export function icloudDownloadStatusLabel(
  t: (key: string, values?: Record<string, unknown>) => string,
  row?: Pick<CloudPlaybackState, 'state' | 'percent' | 'error'> | CloudPlaybackState | null,
  residency?: string
) {
  if (row?.state === 'failed') return t(`icloud.errors.${row.error || 'failed'}`)
  if (row?.state === 'waiting') return t('icloud.waiting')
  if (row?.state === 'downloading') {
    const percent = readIcloudDownloadPercent(row.percent)
    return percent != null ? t('icloud.downloadingPercent', { percent }) : t('icloud.downloading')
  }
  return t(`icloud.residency.${residency || 'unknown'}`)
}
