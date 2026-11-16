import path from 'node:path'
import {
  isNeteasePendingPath,
  isNeteasePreviewUrl,
  parseNeteasePendingSongId,
  parseNeteaseSongId
} from '../../shared/netease'

const SONG_ID_PATTERN = /^[1-9]\d{0,19}$/

const isSafeSongId = (songId: unknown): boolean => SONG_ID_PATTERN.test(String(songId ?? '').trim())

export function isNeteaseRemoteCoverPath(filePath: string | undefined | null): boolean {
  return isNeteasePreviewUrl(filePath) || isNeteasePendingPath(filePath)
}

export function toParametrizedCoverUrl(coverUrl: string, size = 400): string {
  try {
    const url = new URL(coverUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return coverUrl
    url.searchParams.set('param', `${size}y${size}`)
    return url.toString()
  } catch {
    return coverUrl
  }
}

export function songIdFromStoreFilePath(filePath: string, storeDir: string): string | null {
  const root = path.resolve(storeDir)
  const resolved = path.resolve(String(filePath || ''))
  const left = process.platform === 'win32' ? root.toLowerCase() : root
  const right = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  if (right !== left && !right.startsWith(left + path.sep)) return null
  const base = path.basename(resolved)
  const dot = base.lastIndexOf('.')
  const id = dot > 0 ? base.slice(0, dot) : base
  return isSafeSongId(id) ? id : null
}

export function resolveNeteaseCoverSongId(filePath: string, storeDir?: string): string | null {
  const raw = String(filePath || '').trim()
  if (!raw) return null
  const fromPreview = parseNeteaseSongId(raw)
  if (fromPreview && isSafeSongId(fromPreview)) return fromPreview
  const fromPending = parseNeteasePendingSongId(raw)
  if (fromPending && isSafeSongId(fromPending)) return fromPending
  if (!storeDir) return null
  return songIdFromStoreFilePath(raw, storeDir)
}
