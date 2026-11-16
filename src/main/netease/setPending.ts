/**
 * 网易云曲目拖进 / 加入 SET：还没有本地文件时，先以「待下载」条目入单，
 * 再在后台下载到 `.store/`，完成后把 SET 引用改成真实路径。
 *
 * SET 的 `file_path` 必须有值，但又不能指向一个还不存在的文件（否则加载时会变成红线）。
 * 所以用 `netease-pending:<songId>` 这种不含斜杠的占位路径，加载 SET 时单独认出来。
 */
import { log } from '../log'
import store from '../store'
import {
  appendSetItems,
  findSetItemsByFilePath,
  updateSetItemAnalysisSnapshot,
  updateSetItemFilePath,
  type SetItemRecord
} from '../setListDb'
import type { NeteaseLevel } from './client'
import { downloadTrack, getLocalFileOutcome, getTrackMeta } from './library'
import { isSafeSongId } from './paths'
import {
  buildNeteasePendingPath,
  isNeteasePendingPath,
  parseNeteasePendingSongId
} from '../../shared/netease'

export type NeteaseSetAppendItem = {
  songId: string
  title?: string
  artist?: string
  album?: string
  duration?: string
  durationMs?: number
  analysis?: Record<string, unknown> | null
  originPlaylistUuid?: string | null
  originPathSnapshot?: string | null
}

export type NeteaseSetPendingPayload = {
  playlistUuids: string[]
  songId: string
  status: 'pending' | 'ready' | 'failed'
  filePath?: string
  error?: string
}

type PendingNotifier = (payload: NeteaseSetPendingPayload) => void

let notifyPending: PendingNotifier = () => {}

export function setNeteaseSetPendingNotifier(notifier: PendingNotifier): void {
  notifyPending = notifier || (() => {})
}

const inflightPending = new Map<string, Promise<{ filePath?: string; error?: string }>>()

function normalizeLevel(value: unknown): NeteaseLevel {
  if (value === 'jymaster' || value === 'lossless' || value === 'exhigh' || value === 'standard') {
    return value
  }
  return 'lossless'
}

function currentLevel(): NeteaseLevel {
  return normalizeLevel(store.settingConfig?.neteaseLevel)
}

function parseAnalysis(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw))
    return { ...(raw as Record<string, unknown>) }
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) }
    }
  } catch {}
  return {}
}

function buildPendingAnalysis(
  item: NeteaseSetAppendItem,
  status: 'pending' | 'failed',
  error?: string
): Record<string, unknown> {
  const analysis = parseAnalysis(item.analysis)
  const meta = getTrackMeta(item.songId)
  analysis.neteaseSongId = item.songId
  analysis.neteasePendingDownload = true
  analysis.neteasePendingStatus = status
  if (error) analysis.neteasePendingError = error
  else delete analysis.neteasePendingError
  if (item.title || meta?.title) analysis.title = item.title || meta?.title || ''
  if (item.artist || meta?.artist) analysis.artist = item.artist || meta?.artist || ''
  if (item.album || meta?.album) analysis.album = item.album || meta?.album || ''
  if (item.duration) analysis.duration = item.duration
  if (item.durationMs && Number(item.durationMs) > 0)
    analysis.durationMs = Math.floor(item.durationMs)
  return analysis
}

function findPendingItems(songId: string): SetItemRecord[] {
  return findSetItemsByFilePath(buildNeteasePendingPath(songId))
}

function notifyItems(
  items: SetItemRecord[],
  payload: Omit<NeteaseSetPendingPayload, 'playlistUuids'>
): void {
  const playlistUuids = [...new Set(items.map((item) => item.playlistUuid).filter(Boolean))]
  if (playlistUuids.length === 0) return
  notifyPending({ ...payload, playlistUuids })
}

function markItemsFailed(songId: string, error: string): void {
  const items = findPendingItems(songId)
  for (const item of items) {
    const analysis = parseAnalysis(item.analysisJson)
    analysis.neteaseSongId = songId
    analysis.neteasePendingDownload = true
    analysis.neteasePendingStatus = 'failed'
    analysis.neteasePendingError = error
    updateSetItemAnalysisSnapshot(item.id, analysis)
  }
  notifyItems(items, { songId, status: 'failed', error })
}

function markItemsReady(songId: string, filePath: string): void {
  const items = findPendingItems(songId)
  for (const item of items) {
    updateSetItemFilePath(item.id, filePath)
    const analysis = parseAnalysis(item.analysisJson)
    delete analysis.neteasePendingDownload
    delete analysis.neteasePendingStatus
    delete analysis.neteasePendingError
    updateSetItemAnalysisSnapshot(item.id, Object.keys(analysis).length > 0 ? analysis : null)
  }
  notifyItems(items, { songId, status: 'ready', filePath })
}

/**
 * 下载一首并兑现所有指向它的待下载 SET 条目。
 * 失败时条目留在 SET 里，只把状态改成失败，不会删掉，也不会把 file_path 改成一个不存在的文件。
 */
export async function fulfillPendingSetSong(
  songId: string
): Promise<{ filePath?: string; error?: string }> {
  const id = String(songId || '').trim()
  if (!isSafeSongId(id)) return { error: '非法的网易云曲目 id' }
  const existing = inflightPending.get(id)
  if (existing) return await existing

  const task = (async () => {
    try {
      const outcome = await downloadTrack(id, currentLevel())
      markItemsReady(id, outcome.filePath)
      return { filePath: outcome.filePath }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      markItemsFailed(id, message)
      return { error: message }
    }
  })().finally(() => {
    inflightPending.delete(id)
  })

  inflightPending.set(id, task)
  return await task
}

export function schedulePendingSetDownloads(songIds: string[]): void {
  for (const songId of songIds) {
    const id = String(songId || '').trim()
    if (!isSafeSongId(id)) continue
    if (inflightPending.has(id)) continue
    void fulfillPendingSetSong(id)
  }
}

export async function appendNeteaseTracksToSet(
  playlistUuid: string,
  items: NeteaseSetAppendItem[]
): Promise<{
  pendingSongIds: string[]
  readyCount: number
  pendingCount: number
}> {
  const uuid = String(playlistUuid || '').trim()
  const source = Array.isArray(items) ? items : []
  const readyItems: Array<{
    filePath: string
    originPlaylistUuid?: string | null
    originPathSnapshot?: string | null
    analysis?: Record<string, unknown> | null
  }> = []
  const pendingItems: Array<{
    filePath: string
    originPlaylistUuid?: string | null
    originPathSnapshot?: string | null
    analysis?: Record<string, unknown> | null
  }> = []
  const pendingSongIds: string[] = []

  for (const item of source) {
    const songId = String(item?.songId || '').trim()
    if (!isSafeSongId(songId)) continue
    const existing = await getLocalFileOutcome(songId)
    if (existing) {
      readyItems.push({
        filePath: existing.filePath,
        originPlaylistUuid: item.originPlaylistUuid,
        originPathSnapshot: item.originPathSnapshot,
        analysis: parseAnalysis(item.analysis)
      })
      continue
    }
    pendingSongIds.push(songId)
    pendingItems.push({
      filePath: buildNeteasePendingPath(songId),
      originPlaylistUuid: item.originPlaylistUuid,
      originPathSnapshot: item.originPathSnapshot,
      analysis: buildPendingAnalysis(item, 'pending')
    })
  }

  if (readyItems.length > 0) appendSetItems(uuid, readyItems)
  if (pendingItems.length > 0) appendSetItems(uuid, pendingItems)

  // 入单已经完成，下载放到后台，不要卡住拖拽 / 「加入 SET」
  schedulePendingSetDownloads(pendingSongIds)
  return {
    pendingSongIds,
    readyCount: readyItems.length,
    pendingCount: pendingItems.length
  }
}

/** 给 SET 加载用：占位路径不是磁盘文件，不能走 stat / 扫描 */
export function isNeteasePendingSetItem(filePath: string | undefined | null): boolean {
  return isNeteasePendingPath(filePath)
}

export function getPendingSetSongId(filePath: string): string | null {
  return parseNeteasePendingSongId(filePath)
}
