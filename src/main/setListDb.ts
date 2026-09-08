import { v4 as uuidV4 } from 'uuid'
import path = require('path')
import { getLibraryDb, isSqliteRow } from './libraryDb'
import { log } from './log'

const TABLE = 'set_items'
const IN_CLAUSE_CHUNK_SIZE = 300

export type SetItemRecord = {
  id: string
  playlistUuid: string
  filePath: string
  sortOrder: number
  originPlaylistUuid?: string | null
  originPathSnapshot?: string | null
  analysisJson?: string | null
  createdAtMs: number
}

type SetAppendItem = {
  filePath: string
  originPlaylistUuid?: string | null
  originPathSnapshot?: string | null
  analysis?: Record<string, unknown> | null
}

function toRecord(row: unknown): SetItemRecord | null {
  if (!isSqliteRow(row) || !row.id || !row.playlist_uuid || !row.file_path) return null
  return {
    id: String(row.id),
    playlistUuid: String(row.playlist_uuid),
    filePath: String(row.file_path),
    sortOrder: Number(row.sort_order) || 0,
    originPlaylistUuid: row.origin_playlist_uuid ? String(row.origin_playlist_uuid) : null,
    originPathSnapshot: row.origin_path_snapshot ? String(row.origin_path_snapshot) : null,
    analysisJson: row.analysis_json ? String(row.analysis_json) : null,
    createdAtMs: Number(row.created_at_ms) || 0
  }
}

function stringifyAnalysisJson(analysis: unknown): string | null {
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return null
  try {
    return JSON.stringify(analysis)
  } catch {
    return null
  }
}

function resolveFilePathWhereClause(): string {
  return process.platform === 'win32' ? 'LOWER(file_path) = LOWER(?)' : 'file_path = ?'
}

function buildFilePathLookupCandidates(filePath: string): string[] {
  const normalizedPath = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalizedPath) return []

  const candidates = [
    normalizedPath,
    path.normalize(normalizedPath),
    normalizedPath.replace(/\//g, '\\'),
    normalizedPath.replace(/\\/g, '/')
  ]
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate
    if (!candidate || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function listSetItemsByPlaylist(playlistUuid: string): SetItemRecord[] {
  if (!playlistUuid) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT id, playlist_uuid, file_path, sort_order, origin_playlist_uuid, origin_path_snapshot, analysis_json, created_at_ms
         FROM ${TABLE}
         WHERE playlist_uuid = ?
         ORDER BY sort_order ASC, created_at_ms ASC, id ASC`
      )
      .all(playlistUuid)
    return rows.map(toRecord).filter(Boolean) as SetItemRecord[]
  } catch (error) {
    log.error('[sqlite] set list items failed', error)
    return []
  }
}

export function listSetItemsByIds(ids: string[]): SetItemRecord[] {
  const normalizedIds = Array.isArray(ids)
    ? ids
        .filter((id) => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean)
    : []
  if (normalizedIds.length === 0) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const stmt = db.prepare(
      `SELECT id, playlist_uuid, file_path, sort_order, origin_playlist_uuid, origin_path_snapshot, analysis_json, created_at_ms
       FROM ${TABLE}
       WHERE id = ?`
    )
    const seen = new Set<string>()
    const result: SetItemRecord[] = []
    for (const id of normalizedIds) {
      if (seen.has(id)) continue
      seen.add(id)
      const record = toRecord(stmt.get(id))
      if (record) result.push(record)
    }
    return result
  } catch (error) {
    log.error('[sqlite] set list items by ids failed', error)
    return []
  }
}

export function appendSetItems(playlistUuid: string, items: SetAppendItem[]): SetItemRecord[] {
  const normalizedItems = Array.isArray(items)
    ? items.filter((item) => item && typeof item.filePath === 'string' && item.filePath.length > 0)
    : []
  if (!playlistUuid || normalizedItems.length === 0) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const maxRow = db
      .prepare(`SELECT MAX(sort_order) AS max_order FROM ${TABLE} WHERE playlist_uuid = ?`)
      .get(playlistUuid)
    let currentOrder = Number(maxRow?.max_order || 0)
    const now = Date.now()
    const inserted: SetItemRecord[] = []
    const insert = db.prepare(
      `INSERT INTO ${TABLE} (id, playlist_uuid, file_path, sort_order, origin_playlist_uuid, origin_path_snapshot, analysis_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const tx = db.transaction(() => {
      for (const item of normalizedItems) {
        currentOrder += 1
        const id = uuidV4()
        const analysisJson = stringifyAnalysisJson(item.analysis)
        insert.run(
          id,
          playlistUuid,
          item.filePath,
          currentOrder,
          item.originPlaylistUuid || null,
          item.originPathSnapshot || null,
          analysisJson,
          now
        )
        inserted.push({
          id,
          playlistUuid,
          filePath: item.filePath,
          sortOrder: currentOrder,
          originPlaylistUuid: item.originPlaylistUuid || null,
          originPathSnapshot: item.originPathSnapshot || null,
          analysisJson,
          createdAtMs: now
        })
      }
    })
    tx()
    return inserted
  } catch (error) {
    log.error('[sqlite] set append items failed', error)
    return []
  }
}

export function removeSetItemsByPlaylist(playlistUuid: string): number {
  if (!playlistUuid) return 0
  const db = getLibraryDb()
  if (!db) return 0
  try {
    const info = db.prepare(`DELETE FROM ${TABLE} WHERE playlist_uuid = ?`).run(playlistUuid)
    return Number(info?.changes || 0)
  } catch (error) {
    log.error('[sqlite] set remove items by playlist failed', error)
    return 0
  }
}

export function removeSetItemsByIds(ids: string[]): number {
  const normalizedIds = Array.isArray(ids)
    ? ids
        .filter((id) => typeof id === 'string')
        .map((id) => String(id).trim())
        .filter(Boolean)
    : []
  if (normalizedIds.length === 0) return 0
  const db = getLibraryDb()
  if (!db) return 0
  try {
    let removed = 0
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`)
    const tx = db.transaction(() => {
      for (let offset = 0; offset < normalizedIds.length; offset += IN_CLAUSE_CHUNK_SIZE) {
        const chunk = normalizedIds.slice(offset, offset + IN_CLAUSE_CHUNK_SIZE)
        for (const id of chunk) {
          const info = del.run(id)
          removed += Number(info?.changes || 0)
        }
      }
    })
    tx()
    return removed
  } catch (error) {
    log.error('[sqlite] set remove items by ids failed', error)
    return 0
  }
}

export function updateSetItemFilePath(id: string, filePath: string): boolean {
  if (!id || !filePath) return false
  const db = getLibraryDb()
  if (!db) return false
  try {
    const info = db.prepare(`UPDATE ${TABLE} SET file_path = ? WHERE id = ?`).run(filePath, id)
    return Number(info?.changes || 0) > 0
  } catch (error) {
    log.error('[sqlite] set update item file path failed', error)
    return false
  }
}

export function updateSetItemFilePathReferences(oldFilePath: string, newFilePath: string): number {
  if (!oldFilePath || !newFilePath || oldFilePath === newFilePath) return 0
  const items = findSetItemsByFilePath(oldFilePath)
  if (items.length === 0) return 0
  let updated = 0
  const seen = new Set<string>()
  for (const item of items) {
    if (!item.id || seen.has(item.id)) continue
    seen.add(item.id)
    if (updateSetItemFilePath(item.id, newFilePath)) {
      updated++
    }
  }
  return updated
}

export function updateSetItemAnalysisSnapshot(
  id: string,
  analysis: Record<string, unknown> | null
): boolean {
  if (!id) return false
  const db = getLibraryDb()
  if (!db) return false
  try {
    const analysisJson = stringifyAnalysisJson(analysis)
    const info = db
      .prepare(`UPDATE ${TABLE} SET analysis_json = ? WHERE id = ?`)
      .run(analysisJson, id)
    return Number(info?.changes || 0) > 0
  } catch (error) {
    log.error('[sqlite] set update item analysis failed', error)
    return false
  }
}

export function reorderSetPlaylistItems(playlistUuid: string, orderedIds: string[]): boolean {
  const normalizedIds = Array.isArray(orderedIds)
    ? orderedIds
        .filter((id) => typeof id === 'string')
        .map((id) => String(id).trim())
        .filter(Boolean)
    : []
  if (!playlistUuid || normalizedIds.length === 0) return false
  const db = getLibraryDb()
  if (!db) return false
  try {
    const rows = db
      .prepare(
        `SELECT id FROM ${TABLE} WHERE playlist_uuid = ? ORDER BY sort_order ASC, created_at_ms ASC, id ASC`
      )
      .all(playlistUuid) as Array<{ id: string }>
    const existingIds = rows.map((row) => String(row.id))
    const orderedSet = new Set(normalizedIds)
    const finalIds = [
      ...normalizedIds.filter((id) => existingIds.includes(id)),
      ...existingIds.filter((id) => !orderedSet.has(id))
    ]
    const update = db.prepare(`UPDATE ${TABLE} SET sort_order = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      finalIds.forEach((id, idx) => {
        update.run(idx + 1, id)
      })
    })
    tx()
    return true
  } catch (error) {
    log.error('[sqlite] set reorder items failed', error)
    return false
  }
}

export function findSetItemsByFilePath(filePath: string): SetItemRecord[] {
  const lookupCandidates = buildFilePathLookupCandidates(filePath)
  if (lookupCandidates.length === 0) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const whereClause = resolveFilePathWhereClause()
    const stmt = db.prepare(
      `SELECT id, playlist_uuid, file_path, sort_order, origin_playlist_uuid, origin_path_snapshot, analysis_json, created_at_ms
       FROM ${TABLE}
       WHERE ${whereClause}
       ORDER BY sort_order ASC, created_at_ms ASC, id ASC`
    )
    const seen = new Set<string>()
    const result: SetItemRecord[] = []
    for (const candidate of lookupCandidates) {
      const rows = stmt.all(candidate)
      for (const row of rows) {
        const record = toRecord(row)
        if (!record || seen.has(record.id)) continue
        seen.add(record.id)
        result.push(record)
      }
    }
    return result
  } catch (error) {
    log.error('[sqlite] set find items by file path failed', error)
    return []
  }
}

export function findSetItemsByFilePaths(filePaths: string[]): SetItemRecord[] {
  const lookupCandidates = Array.from(
    new Set(
      (Array.isArray(filePaths) ? filePaths : [])
        .flatMap((filePath) => buildFilePathLookupCandidates(filePath))
        .map((candidate) => (process.platform === 'win32' ? candidate.toLowerCase() : candidate))
    )
  )
  if (lookupCandidates.length === 0) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows: unknown[] = []
    const chunkSize = 250
    for (let offset = 0; offset < lookupCandidates.length; offset += chunkSize) {
      const chunk = lookupCandidates.slice(offset, offset + chunkSize)
      const placeholders = chunk.map(() => '?').join(', ')
      const filePathExpression = process.platform === 'win32' ? 'LOWER(file_path)' : 'file_path'
      rows.push(
        ...db
          .prepare(
            `SELECT id, playlist_uuid, file_path, sort_order, origin_playlist_uuid, origin_path_snapshot, analysis_json, created_at_ms
             FROM ${TABLE}
             WHERE ${filePathExpression} IN (${placeholders})`
          )
          .all(...chunk)
      )
    }
    const seen = new Set<string>()
    return rows
      .map(toRecord)
      .filter((record): record is SetItemRecord => {
        if (!record || seen.has(record.id)) return false
        seen.add(record.id)
        return true
      })
      .sort(
        (left, right) =>
          left.sortOrder - right.sortOrder ||
          left.createdAtMs - right.createdAtMs ||
          left.id.localeCompare(right.id)
      )
  } catch (error) {
    log.error('[sqlite] set find items by file paths failed', error)
    return []
  }
}

export function countSetItemsByPlaylist(playlistUuid: string): number {
  if (!playlistUuid) return 0
  const db = getLibraryDb()
  if (!db) return 0
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE playlist_uuid = ?`)
      .get(playlistUuid) as { cnt: number } | undefined
    return Number(row?.cnt || 0)
  } catch (error) {
    log.error('[sqlite] set count items failed', error)
    return 0
  }
}

/** 一次查出多个 set 歌单的条目数，避免逐个歌单往返 */
export function countSetItemsByPlaylists(playlistUuids: string[]): Record<string, number> {
  const result: Record<string, number> = {}
  const uuids = [...new Set(playlistUuids.filter((uuid) => !!uuid))]
  if (!uuids.length) return result
  for (const uuid of uuids) result[uuid] = 0
  const db = getLibraryDb()
  if (!db) return result
  try {
    for (let index = 0; index < uuids.length; index += IN_CLAUSE_CHUNK_SIZE) {
      const chunk = uuids.slice(index, index + IN_CLAUSE_CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT playlist_uuid, COUNT(*) AS cnt FROM ${TABLE} WHERE playlist_uuid IN (${placeholders}) GROUP BY playlist_uuid`
        )
        .all(...chunk)
      for (const row of rows) {
        if (!isSqliteRow(row) || !row.playlist_uuid) continue
        result[String(row.playlist_uuid)] = Number(row.cnt) || 0
      }
    }
    return result
  } catch (error) {
    log.error('[sqlite] set count items batch failed', error)
    return result
  }
}

export function normalizeSetItemOrder(playlistUuid: string): void {
  if (!playlistUuid) return
  const db = getLibraryDb()
  if (!db) return
  try {
    const rows = db
      .prepare<{
        id: string
      }>(
        `SELECT id FROM ${TABLE} WHERE playlist_uuid = ? ORDER BY sort_order ASC, created_at_ms ASC, id ASC`
      )
      .all(playlistUuid)
    if (!rows || rows.length === 0) return
    const update = db.prepare(`UPDATE ${TABLE} SET sort_order = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      rows.forEach((row, idx) => {
        update.run(idx + 1, row.id)
      })
    })
    tx()
  } catch (error) {
    log.error('[sqlite] set normalize order failed', error)
  }
}
