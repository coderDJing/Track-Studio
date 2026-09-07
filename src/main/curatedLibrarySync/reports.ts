import type {
  CuratedLibrarySyncConflictItem,
  CuratedLibrarySyncFailureItem
} from '../../shared/curatedLibrarySync'

const MAX_ITEMS = 40

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const CONFLICT_KINDS = new Set([
  'file-move-lost',
  'file-rename-lost',
  'file-content-lost',
  'file-delete-lost',
  'file-undelete-lost',
  'file-order-lost',
  'node-change-lost',
  'node-delete-lost'
])

export const parseConflictItems = (raw: unknown): CuratedLibrarySyncConflictItem[] => {
  if (!Array.isArray(raw)) return []
  const items: CuratedLibrarySyncConflictItem[] = []
  for (const row of raw) {
    if (!isRecord(row)) continue
    const kind = String(row.kind || '')
    const name = String(row.name || '').trim()
    if (!CONFLICT_KINDS.has(kind) || !name) continue
    items.push({
      kind: kind as CuratedLibrarySyncConflictItem['kind'],
      name,
      otherName: String(row.otherName || '').trim() || undefined
    })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

export const parseFailureItems = (raw: unknown): CuratedLibrarySyncFailureItem[] => {
  if (!Array.isArray(raw)) return []
  const items: CuratedLibrarySyncFailureItem[] = []
  for (const row of raw) {
    if (!isRecord(row)) continue
    const direction =
      row.direction === 'download' ? 'download' : row.direction === 'upload' ? 'upload' : ''
    const name = String(row.name || '').trim()
    if (!direction || !name) continue
    items.push({
      direction,
      name,
      errorKey: String(row.errorKey || 'cloudSync.curatedLibrary.errors.failed'),
      atMs: Number(row.atMs) || Date.now(),
      sha256: String(row.sha256 || '').trim() || undefined,
      fileId: String(row.fileId || '').trim() || undefined
    })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

export const mapTransferErrorKey = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error || '')
  const upper = message.toUpperCase()
  if (upper.includes('DISK_FULL') || upper.includes('ENOSPC')) {
    return 'cloudSync.curatedLibrary.errors.diskFull'
  }
  if (upper.includes('QUOTA') || upper.includes('LIMIT')) {
    return 'cloudSync.curatedLibrary.errors.quotaExceeded'
  }
  if (upper.includes('HASH')) return 'cloudSync.curatedLibrary.errors.hashMismatch'
  if (
    upper.includes('FETCH') ||
    upper.includes('ENOTFOUND') ||
    upper.includes('ECONNREFUSED') ||
    upper.includes('ETIMEDOUT') ||
    upper.includes('ABORT')
  ) {
    return 'cloudSync.errors.cannotConnect'
  }
  return 'cloudSync.curatedLibrary.errors.failed'
}

export const mapCuratedSyncError = (message: string): string => {
  const upper = message.toUpperCase()
  if (upper.includes('INVALID_NAME')) return 'cloudSync.curatedLibrary.errors.failed'
  if (upper.includes('PROTOCOL')) return 'cloudSync.curatedLibrary.errors.protocolUnsupported'
  if (upper.includes('FIRST_SNAPSHOT_WAIT')) {
    return 'cloudSync.curatedLibrary.errors.firstSnapshotWait'
  }
  return mapTransferErrorKey(message)
}

export const isFirstSnapshotRace = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || '')
  return message.includes('FIRST_SNAPSHOT_LOCKED') || message.includes('FIRST_SNAPSHOT_EXISTS')
}
