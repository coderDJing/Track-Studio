export type IcloudResidency = 'local' | 'cloud' | 'unknown'
export interface IcloudState {
  supported: boolean
  visible: boolean
  available: boolean
  configured: boolean
  folder: string
  rootToken?: string
  preferredDirectory?: string
}
export interface IcloudEntry {
  name: string
  relativePath: string
  directory: boolean
  residency: IcloudResidency
  hasChildren?: boolean | 'unknown'
}
export interface IcloudListing {
  directory?: string
  entries: IcloudEntry[]
  total: number
  rootToken?: string
  skippedFolders?: number
}
export interface IcloudFolderListing {
  entries: IcloudEntry[]
  rootToken: string
  directory: string
  missingRoot: boolean
}
export interface IcloudCopyRequest {
  direction: 'to-cloud' | 'to-local'
  paths: string[]
  localPlaylistUuid: string
  cloudDirectory: string
  destinationToken?: string
  rootToken?: string
  requestId?: string
}
export interface IcloudCopyItem {
  source: string
  status: 'copied' | 'skipped' | 'failed'
  destination?: string
  error?: string
  warning?: string
}
export interface IcloudProgress {
  done: number
  total: number
  current: string
}
export type IcloudResult<T> = { ok: true; value: T } | { ok: false; error: string }
export function icloudVisibility(supported: boolean, detected: boolean, configured: boolean) {
  return supported && (detected || configured)
}

// Availability and user presentation preference are separate: hiding is not deletion.
export function isIcloudEntryVisible(state: IcloudState | null, showIcon?: boolean) {
  return state?.visible === true && showIcon !== false
}

export const ICLOUD_DRAG_MIME = 'application/x-frkb-icloud-songs'
export interface IcloudDragPayload {
  version: 1
  rootToken: string
  paths: string[]
}
export interface IcloudDownloadProgress {
  requestId: string
  relative: string
  state: 'waiting' | 'downloading' | 'ready'
  percent?: number
}

/** Only a finite 0–100 value from the system is kept; missing or illegal values are omitted, never invented. */
export function readIcloudDownloadPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)
    return undefined
  return Math.round(value)
}

export function toIcloudDownloadProgressEvent(
  requestId: string,
  relative: string,
  state: IcloudDownloadProgress['state'],
  percent?: number
): IcloudDownloadProgress {
  const safe = readIcloudDownloadPercent(percent)
  return safe == null
    ? { requestId, relative, state }
    : { requestId, relative, state, percent: safe }
}
export function parseIcloudDragPayload(text: string): IcloudDragPayload | null {
  try {
    if (text.length > 1024 * 1024) return null
    const data: unknown = JSON.parse(text)
    if (!data || typeof data !== 'object') return null
    const p = data as Partial<IcloudDragPayload>
    if (
      p.version !== 1 ||
      typeof p.rootToken !== 'string' ||
      !p.rootToken ||
      !Array.isArray(p.paths) ||
      !p.paths.length ||
      p.paths.length > 100000 ||
      p.paths.some(
        (v) =>
          typeof v !== 'string' ||
          !v ||
          v.includes('\0') ||
          v.startsWith('/') ||
          v.split(/[\\/]/).includes('..')
      )
    )
      return null
    return { version: 1, rootToken: p.rootToken, paths: [...new Set(p.paths)] }
  } catch {
    return null
  }
}

export function isIcloudPlaybackUrl(value: string | null | undefined): boolean {
  if (!value?.startsWith('frkb-preview://icloud/')) return false
  try {
    const url = new URL(value)
    return !!url.searchParams.get('ticket') && !!url.searchParams.get('path')
  } catch {
    return false
  }
}

export interface IcloudPicture {
  hash?: string
  format: 'image/png' | 'image/jpeg'
  data: string
}
export interface IcloudSongMetadata {
  picture?: IcloudPicture
  title?: string
  artist?: string
  album?: string
  duration?: string
  bpm?: number
  key?: string
  genre?: string
  label?: string
  bitrate?: number
  container?: string
}
export interface IcloudMetadataItem {
  relativePath: string
  metadata?: IcloudSongMetadata
}
