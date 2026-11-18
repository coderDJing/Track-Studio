import type { ISongInfo } from 'src/types/globals'
import { t } from '@renderer/utils/translate'

export type NeteaseDownloadStatus = 'downloaded' | 'pending' | 'failed' | ''

/** 失败优先于进行中，避免一行同时出现两种标记。 */
export const getNeteaseDownloadStatus = (
  song: Pick<ISongInfo, 'neteaseDownloaded' | 'neteasePendingDownload' | 'neteasePendingStatus'>
): NeteaseDownloadStatus => {
  if (song.neteasePendingStatus === 'failed') return 'failed'
  if (song.neteasePendingDownload) return 'pending'
  if (song.neteaseDownloaded) return 'downloaded'
  return ''
}

const STATUS_RANK: Record<Exclude<NeteaseDownloadStatus, ''>, number> = {
  failed: 0,
  pending: 1,
  downloaded: 2
}

export const getNeteaseDownloadStatusRank = (
  song: Pick<ISongInfo, 'neteaseDownloaded' | 'neteasePendingDownload' | 'neteasePendingStatus'>
): number | null => {
  const status = getNeteaseDownloadStatus(song)
  if (!status) return null
  return STATUS_RANK[status]
}

export const getNeteaseDownloadStatusLabel = (
  song: Pick<ISongInfo, 'neteaseDownloaded' | 'neteasePendingDownload' | 'neteasePendingStatus'>
): string => {
  const status = getNeteaseDownloadStatus(song)
  if (status === 'downloaded') return t('netease.downloadedBadge')
  if (status === 'pending') return t('netease.setPendingBadge')
  if (status === 'failed') return t('netease.setPendingFailedBadge')
  return ''
}
