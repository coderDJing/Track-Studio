import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import type { CuratedLibrarySyncLocation } from '../../shared/curatedLibrarySync'
import { absToCuratedRelative, absToLibraryRelative, detectCuratedFileLocation } from './paths'

export type CuratedSyncFileRow = {
  fileId: string
  relativePath: string
  parentUuid: string
  fileName: string
  contentSha256: string
  contentSize: number
  mtimeMs: number | null
  trackNumber: number | null
  addedAtMs: number | null
  updatedAtMs: number
  location: CuratedLibrarySyncLocation
  locationPath: string | null
}

const TABLE = 'curated_sync_files'

const isLocation = (value: unknown): value is CuratedLibrarySyncLocation =>
  value === 'curated' || value === 'recycle' || value === 'custody' || value === 'missing'

const toRow = (raw: Record<string, unknown> | undefined | null): CuratedSyncFileRow | null => {
  if (!raw || typeof raw.file_id !== 'string' || !raw.file_id.trim()) return null
  return {
    fileId: raw.file_id.trim(),
    relativePath: typeof raw.relative_path === 'string' ? raw.relative_path : '',
    parentUuid: typeof raw.parent_uuid === 'string' ? raw.parent_uuid : '',
    fileName: typeof raw.file_name === 'string' ? raw.file_name : '',
    contentSha256: typeof raw.content_sha256 === 'string' ? raw.content_sha256 : '',
    contentSize: Number(raw.content_size) || 0,
    mtimeMs: raw.mtime_ms == null ? null : Number(raw.mtime_ms),
    trackNumber: raw.track_number == null ? null : Number(raw.track_number),
    addedAtMs: raw.added_at_ms == null ? null : Number(raw.added_at_ms),
    updatedAtMs: Number(raw.updated_at_ms) || 0,
    location: isLocation(raw.location) ? raw.location : 'curated',
    locationPath: typeof raw.location_path === 'string' ? raw.location_path : null
  }
}

export const listCuratedSyncFiles = (): CuratedSyncFileRow[] => {
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db.prepare(`SELECT * FROM ${TABLE}`).all() as Array<Record<string, unknown>>
    return rows.map((row) => toRow(row)).filter((row): row is CuratedSyncFileRow => !!row)
  } catch (error) {
    log.error('[curated-sync] list identity failed', error)
    return []
  }
}

export const getCuratedSyncFileById = (fileId: string): CuratedSyncFileRow | null => {
  const db = getLibraryDb()
  const normalized = String(fileId || '').trim()
  if (!db || !normalized) return null
  try {
    const row = db.prepare(`SELECT * FROM ${TABLE} WHERE file_id = ? LIMIT 1`).get(normalized) as
      | Record<string, unknown>
      | undefined
    return toRow(row)
  } catch (error) {
    log.error('[curated-sync] get identity failed', error)
    return null
  }
}

export const getCuratedSyncFileByRelativePath = (
  relativePath: string
): CuratedSyncFileRow | null => {
  const db = getLibraryDb()
  const posix = String(relativePath || '').replace(/\\/g, '/')
  if (!db || !posix) return null
  try {
    const row = db
      .prepare(`SELECT * FROM ${TABLE} WHERE relative_path = ? AND location = 'curated' LIMIT 1`)
      .get(posix) as Record<string, unknown> | undefined
    return toRow(row)
  } catch (error) {
    log.error('[curated-sync] get identity by path failed', error)
    return null
  }
}

export const findCuratedSyncFileByAbsPath = (absPath: string): CuratedSyncFileRow | null => {
  const curatedRel = absToCuratedRelative(absPath)
  if (curatedRel) {
    const byRel = getCuratedSyncFileByRelativePath(curatedRel)
    if (byRel) return byRel
  }
  const libraryRel = absToLibraryRelative(absPath)
  const db = getLibraryDb()
  if (!db || !libraryRel) return null
  try {
    const row = db
      .prepare(`SELECT * FROM ${TABLE} WHERE location_path = ? LIMIT 1`)
      .get(libraryRel) as Record<string, unknown> | undefined
    return toRow(row)
  } catch {
    return null
  }
}

export const upsertCuratedSyncFile = (row: CuratedSyncFileRow): boolean => {
  const db = getLibraryDb()
  if (!db || !row.fileId) return false
  try {
    db.prepare(
      `INSERT INTO ${TABLE} (
         file_id, relative_path, parent_uuid, file_name, content_sha256, content_size,
         mtime_ms, track_number, added_at_ms, updated_at_ms, location, location_path
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         relative_path = excluded.relative_path,
         parent_uuid = excluded.parent_uuid,
         file_name = excluded.file_name,
         content_sha256 = excluded.content_sha256,
         content_size = excluded.content_size,
         mtime_ms = excluded.mtime_ms,
         track_number = excluded.track_number,
         added_at_ms = excluded.added_at_ms,
         updated_at_ms = excluded.updated_at_ms,
         location = excluded.location,
         location_path = excluded.location_path`
    ).run(
      row.fileId,
      row.relativePath,
      row.parentUuid,
      row.fileName,
      row.contentSha256,
      row.contentSize,
      row.mtimeMs,
      row.trackNumber,
      row.addedAtMs,
      row.updatedAtMs,
      row.location,
      row.locationPath
    )
    return true
  } catch (error) {
    log.error('[curated-sync] upsert identity failed', error)
    return false
  }
}

export const replaceCuratedSyncFileId = (fromFileId: string, toFileId: string): boolean => {
  const db = getLibraryDb()
  const from = String(fromFileId || '').trim()
  const to = String(toFileId || '').trim()
  if (!db || !from || !to || from === to) return false
  try {
    const existing = getCuratedSyncFileById(to)
    if (existing) return false
    db.prepare(`UPDATE ${TABLE} SET file_id = ? WHERE file_id = ?`).run(to, from)
    return true
  } catch (error) {
    log.error('[curated-sync] replace fileId failed', error)
    return false
  }
}

export const deleteCuratedSyncFile = (fileId: string): boolean => {
  const db = getLibraryDb()
  const normalized = String(fileId || '').trim()
  if (!db || !normalized) return false
  try {
    db.prepare(`DELETE FROM ${TABLE} WHERE file_id = ?`).run(normalized)
    return true
  } catch (error) {
    log.error('[curated-sync] delete identity failed', error)
    return false
  }
}

export const createCuratedSyncFileId = (): string => randomUUID()

export const notifyCuratedFilePathChanged = (fromAbs: string, toAbs: string): void => {
  const row = findCuratedSyncFileByAbsPath(fromAbs)
  if (!row) return
  const detected = detectCuratedFileLocation(toAbs)
  const next: CuratedSyncFileRow = {
    ...row,
    location: detected.location,
    locationPath: detected.locationPath,
    updatedAtMs: Date.now()
  }
  if (detected.location === 'curated') {
    next.relativePath = absToCuratedRelative(toAbs) || row.relativePath
    next.fileName = toAbs.split(/[/\\]/).pop() || row.fileName
  }
  upsertCuratedSyncFile(next)
}

export const notifyCuratedDirectoryPathChanged = (fromAbs: string, toAbs: string): void => {
  const db = getLibraryDb()
  const fromCuratedRel = absToCuratedRelative(fromAbs)
  const toCuratedRel = absToCuratedRelative(toAbs)
  const fromLibraryRel = absToLibraryRelative(fromAbs)
  const toLibraryRel = absToLibraryRelative(toAbs)
  if (!db || !fromLibraryRel || !toLibraryRel || fromLibraryRel === toLibraryRel) return
  try {
    const rows = db.prepare(`SELECT * FROM ${TABLE}`).all() as Array<Record<string, unknown>>
    const update = db.prepare(
      `UPDATE ${TABLE} SET relative_path = ?, location = ?, location_path = ?, updated_at_ms = ? WHERE file_id = ?`
    )
    const tx = db.transaction(() => {
      for (const raw of rows) {
        const row = toRow(raw)
        if (!row) continue
        const currentLibraryRel: string | null =
          row.location === 'curated' && row.relativePath
            ? fromCuratedRel &&
              (row.relativePath === fromCuratedRel ||
                row.relativePath.startsWith(`${fromCuratedRel}/`))
              ? `${fromLibraryRel}${row.relativePath.slice(fromCuratedRel.length)}`
              : null
            : row.locationPath
        if (
          !currentLibraryRel ||
          (currentLibraryRel !== fromLibraryRel &&
            !currentLibraryRel.startsWith(`${fromLibraryRel}/`))
        ) {
          continue
        }
        const suffix = currentLibraryRel.slice(fromLibraryRel.length).replace(/^[/\\]+/, '')
        const nextLibraryRel = suffix
          ? `${toLibraryRel.replace(/\/$/, '')}/${suffix.replace(/\\/g, '/')}`
          : toLibraryRel
        const nextAbs = suffix ? path.join(toAbs, ...suffix.split('/')) : toAbs
        const detected = detectCuratedFileLocation(nextAbs)
        const nextCuratedRel =
          detected.location === 'curated' && toCuratedRel
            ? `${toCuratedRel}${currentLibraryRel.slice(fromLibraryRel.length)}`
            : ''
        update.run(
          nextCuratedRel,
          detected.location,
          detected.locationPath || nextLibraryRel,
          Date.now(),
          row.fileId
        )
      }
    })
    tx()
  } catch (error) {
    log.error('[curated-sync] directory identity migration failed', error)
  }
}
