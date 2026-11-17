import { downloadTrack, getTrackMeta } from './library'
import type { NeteaseLevel } from './client'

export type NeteaseDownloadProgressPayload = {
  id: string
  titleKey?: string
  now?: number
  total?: number
  isInitial?: boolean
  dismiss?: boolean
}

export type NeteaseEnsureDownloadedResult = {
  items: Array<{ songId: string; filePath: string; title: string; artist: string }>
  failed: Array<{ songId: string; error: string }>
}

const inflightEnsureDownloads = new Map<string, Promise<NeteaseEnsureDownloadedResult>>()

const uniqueSongIds = (songIds: string[]): string[] => {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const raw of songIds) {
    const id = String(raw || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

const uniqueSortedSongIds = (songIds: string[]): string[] => [...uniqueSongIds(songIds)].sort()

/** 同一批曲目共用一条进度条，避免连点时叠出多条。 */
export const stableNeteaseDownloadProgressId = (songIds: string[]): string => {
  const ids = uniqueSortedSongIds(songIds)
  if (ids.length === 0) return 'netease_download_empty'
  if (ids.length === 1) return `netease_download_${ids[0]}`
  return `netease_download_batch_${ids.join('_')}`
}

const ensureDownloadKey = (songIds: string[], level: NeteaseLevel): string =>
  `${level}:${uniqueSortedSongIds(songIds).join(',')}`

/**
 * 只做「确保已下载」，不复制。
 *
 * SET 库与混音库各自有自己的保管方式（SET 走 custody 复制、混音走 vault 复制），
 * 由渲染层接着调用它们已有的追加接口——这里不重复实现第三套搬运逻辑。
 *
 * 同一音质、同一批 songId 的并发请求会共用同一次下载和同一条进度条；
 * 真正写 `.store` 的 `downloadTrack` 本身也会按 songId 合并。
 */
export async function ensureTracksDownloaded(
  songIds: string[],
  level: NeteaseLevel,
  progressId?: string,
  sendProgress?: (payload: NeteaseDownloadProgressPayload) => void
): Promise<NeteaseEnsureDownloadedResult> {
  const ids = uniqueSongIds(songIds)
  const key = ensureDownloadKey(ids, level)
  const existing = inflightEnsureDownloads.get(key)
  if (existing) return await existing
  const task = ensureTracksDownloadedInner(ids, level, progressId, sendProgress).finally(() => {
    inflightEnsureDownloads.delete(key)
  })
  inflightEnsureDownloads.set(key, task)
  return await task
}

async function ensureTracksDownloadedInner(
  songIds: string[],
  level: NeteaseLevel,
  progressId: string | undefined,
  sendProgress: ((payload: NeteaseDownloadProgressPayload) => void) | undefined
): Promise<NeteaseEnsureDownloadedResult> {
  const id = progressId || stableNeteaseDownloadProgressId(songIds)
  const progress = sendProgress || (() => {})
  const items: NeteaseEnsureDownloadedResult['items'] = []
  const failed: NeteaseEnsureDownloadedResult['failed'] = []

  progress({ id, titleKey: 'netease.downloadingTracks', now: 0, total: songIds.length })
  for (let index = 0; index < songIds.length; index += 1) {
    const songId = songIds[index]
    try {
      const outcome = await downloadTrack(songId, level)
      const meta = getTrackMeta(songId)
      items.push({
        songId,
        filePath: outcome.filePath,
        title: meta?.title || '',
        artist: meta?.artist || ''
      })
    } catch (error) {
      failed.push({ songId, error: error instanceof Error ? error.message : String(error) })
    }
    progress({
      id,
      titleKey: 'netease.downloadingTracks',
      now: index + 1,
      total: songIds.length
    })
  }
  progress({ id, dismiss: true })
  return { items, failed }
}

/** 仅测试使用 */
export const resetEnsureTracksDownloadedForTests = (): void => {
  inflightEnsureDownloads.clear()
}
