import type { ISongInfo } from 'src/types/globals'
import { isIcloudPlaybackUrl } from '@shared/icloudLibrary'
import { isIcloudWaveformPath } from './icloudWaveformPreview'
import { prepareCloudPlayback } from './icloudPlayback'

export function isIcloudWaveformPreviewSource(song?: ISongInfo | null, filePath?: string) {
  const path = String(filePath || song?.filePath || '').trim()
  return Boolean(song?.icloudOrigin) || isIcloudWaveformPath(path)
}

/** Never wrap a logical iCloud key as a local preview URL. */
export function toSafePreviewUrl(filePath: string) {
  const raw = (filePath || '').trim()
  if (!raw) return ''
  if (raw.startsWith('frkb-preview://')) {
    if (raw.startsWith('frkb-preview://icloud/') && !isIcloudPlaybackUrl(raw)) return ''
    return raw
  }
  if (isIcloudWaveformPath(raw) || raw.startsWith('icloud-song:')) return ''
  return `frkb-preview://local/?path=${encodeURIComponent(raw)}`
}

export function shouldSkipPcmWaveformPreview(filePath: string) {
  const raw = (filePath || '').trim()
  return isIcloudPlaybackUrl(raw) || isIcloudWaveformPath(raw) || raw.startsWith('icloud-song:')
}

/** Resident tracks return a ticket immediately; evicted tracks wait on the existing prepare-play path. */
export async function resolveWaveformPreviewPlayUrl(
  song: ISongInfo | undefined,
  filePath: string
): Promise<string | null> {
  const path = (filePath || song?.filePath || '').trim()
  if (!path) return null
  if (isIcloudPlaybackUrl(path)) return path
  if (!isIcloudWaveformPreviewSource(song, path)) return path
  if (!song?.icloudOrigin) return null
  const ready = await prepareCloudPlayback(song)
  const url = ready?.filePath?.trim() || ''
  return isIcloudPlaybackUrl(url) ? url : null
}
