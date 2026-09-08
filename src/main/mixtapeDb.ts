import { v4 as uuidV4 } from 'uuid'
import { getLibraryDb, isSqliteRow } from './libraryDb'
import { log } from './log'
import {
  DEFAULT_MIXTAPE_STEM_PROFILE,
  normalizeMixtapeStemProfile,
  type MixtapeStemProfile
} from '../shared/mixtapeStemProfiles'
import { FIXED_MIXTAPE_STEM_MODE } from '../shared/mixtapeStemMode'
import { areSongHotCuesEqual, normalizeSongHotCues } from '../shared/hotCues'
import { areSongMemoryCuesEqual, normalizeSongMemoryCues } from '../shared/memoryCues'
import type { ISongHotCue, ISongMemoryCue } from '../types/globals'
import type { SqliteDatabase } from './libraryDb'
import { stripMixtapeGridCopies } from './services/mixtapeAnalysisInfo'

const TABLE = 'mixtape_items'
const PROJECT_TABLE = 'mixtape_projects'
const IN_CLAUSE_CHUNK_SIZE = 300 // SQLite SQLITE_MAX_VARIABLE_NUMBER 默认为 999，留安全余量

export type MixtapeMixMode = 'eq' | 'stem'
export type MixtapeStemMode = typeof FIXED_MIXTAPE_STEM_MODE
export type { MixtapeStemProfile }

const DEFAULT_MIXTAPE_MIX_MODE: MixtapeMixMode = 'stem'
const DEFAULT_PROJECT_STEM_PROFILE: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE

function normalizeMixtapeMixMode(value: unknown): MixtapeMixMode {
  return value === 'eq' ? 'eq' : 'stem'
}

type MixtapeProjectStemConfig = {
  mixMode: MixtapeMixMode
  stemProfile: MixtapeStemProfile
}

export type MixtapeItemRecord = {
  id: string
  playlistUuid: string
  filePath: string
  mixOrder: number
  originPlaylistUuid?: string | null
  originPathSnapshot?: string | null
  infoJson?: string | null
  createdAtMs: number
}

function compareMixtapeItemRecordOrder(a: MixtapeItemRecord, b: MixtapeItemRecord): number {
  const mixOrderDiff = a.mixOrder - b.mixOrder
  if (mixOrderDiff !== 0) return mixOrderDiff
  const createdAtDiff = a.createdAtMs - b.createdAtMs
  if (createdAtDiff !== 0) return createdAtDiff
  return a.id.localeCompare(b.id)
}

type MixtapeAppendItem = {
  filePath: string
  originPlaylistUuid?: string | null
  originPathSnapshot?: string | null
  info?: Record<string, unknown> | null
}

type MixtapeFilePathUpdate = {
  id: string
  filePath: string
}

function normalizeUniqueStrings(values: unknown[]): string[] {
  if (!Array.isArray(values)) return []
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === 'string')
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  )
}

type MixtapeItemInfoJson = Record<string, unknown>

function parseMixtapeItemInfoJson(raw: unknown): MixtapeItemInfoJson {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return isSqliteRow(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function toRecord(row: unknown): MixtapeItemRecord | null {
  if (!isSqliteRow(row) || !row.id || !row.playlist_uuid || !row.file_path) return null
  return {
    id: String(row.id),
    playlistUuid: String(row.playlist_uuid),
    filePath: String(row.file_path),
    mixOrder: Number(row.mix_order) || 0,
    originPlaylistUuid: row.origin_playlist_uuid ? String(row.origin_playlist_uuid) : null,
    originPathSnapshot: row.origin_path_snapshot ? String(row.origin_path_snapshot) : null,
    infoJson: row.info_json ? String(row.info_json) : null,
    createdAtMs: Number(row.created_at_ms) || 0
  }
}

function resolveFilePathWhereClause(): string {
  return process.platform === 'win32' ? 'LOWER(file_path) = LOWER(?)' : 'file_path = ?'
}

// 在已有事务中执行重排序（不开新事务）
function normalizeMixtapeOrderInTx(db: SqliteDatabase, playlistUuid: string) {
  const rows = db
    .prepare<{
      id: string
    }>(
      `SELECT id FROM ${TABLE} WHERE playlist_uuid = ? ORDER BY mix_order ASC, created_at_ms ASC, id ASC`
    )
    .all(playlistUuid)
  if (!rows || rows.length === 0) return
  const update = db.prepare(`UPDATE ${TABLE} SET mix_order = ? WHERE id = ?`)
  rows.forEach((row, idx) => {
    update.run(idx + 1, row.id)
  })
}

export function getMixtapeProjectMixMode(playlistUuid: string): MixtapeMixMode {
  return getMixtapeProjectStemConfig(playlistUuid).mixMode
}

export function getMixtapeProjectStemConfig(playlistUuid: string): MixtapeProjectStemConfig {
  const normalizedPlaylistUuid = typeof playlistUuid === 'string' ? playlistUuid.trim() : ''
  if (!normalizedPlaylistUuid) {
    return {
      mixMode: DEFAULT_MIXTAPE_MIX_MODE,
      stemProfile: DEFAULT_PROJECT_STEM_PROFILE
    }
  }
  const db = getLibraryDb()
  if (!db) {
    return {
      mixMode: DEFAULT_MIXTAPE_MIX_MODE,
      stemProfile: DEFAULT_PROJECT_STEM_PROFILE
    }
  }
  try {
    const row = db
      .prepare(
        `SELECT mix_mode, stem_mode, stem_profile
         FROM ${PROJECT_TABLE}
         WHERE playlist_uuid = ?`
      )
      .get(normalizedPlaylistUuid)
    return {
      mixMode: normalizeMixtapeMixMode(row?.mix_mode),
      stemProfile: normalizeMixtapeStemProfile(row?.stem_profile, DEFAULT_PROJECT_STEM_PROFILE)
    }
  } catch (error) {
    log.error('[sqlite] mixtape project stem config get failed', error)
    return {
      mixMode: DEFAULT_MIXTAPE_MIX_MODE,
      stemProfile: DEFAULT_PROJECT_STEM_PROFILE
    }
  }
}

export function upsertMixtapeProjectMixMode(
  playlistUuid: string,
  mixMode: MixtapeMixMode
): { updated: number; mixMode: MixtapeMixMode } {
  const normalizedPlaylistUuid = typeof playlistUuid === 'string' ? playlistUuid.trim() : ''
  const normalizedMixMode = normalizeMixtapeMixMode(mixMode)
  if (!normalizedPlaylistUuid) {
    return { updated: 0, mixMode: normalizedMixMode }
  }
  const db = getLibraryDb()
  if (!db) return { updated: 0, mixMode: normalizedMixMode }
  try {
    const current = getMixtapeProjectStemConfig(normalizedPlaylistUuid)
    const now = Date.now()
    const info = db
      .prepare(
        `INSERT INTO ${PROJECT_TABLE} (
           playlist_uuid,
           mix_mode,
           stem_profile,
           created_at_ms,
           updated_at_ms
         )
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(playlist_uuid) DO UPDATE SET
           mix_mode = excluded.mix_mode,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(normalizedPlaylistUuid, normalizedMixMode, current.stemProfile, now, now)
    return {
      updated: Number(info?.changes || 0),
      mixMode: normalizedMixMode
    }
  } catch (error) {
    log.error('[sqlite] mixtape project mix mode upsert failed', error)
    return {
      updated: 0,
      mixMode: normalizedMixMode
    }
  }
}

export function upsertMixtapeProjectStemProfile(
  playlistUuid: string,
  profile?: MixtapeStemProfile
): {
  updated: number
  stemProfile: MixtapeStemProfile
} {
  const normalizedPlaylistUuid = typeof playlistUuid === 'string' ? playlistUuid.trim() : ''
  const normalizedStemProfile = normalizeMixtapeStemProfile(profile, DEFAULT_PROJECT_STEM_PROFILE)
  if (!normalizedPlaylistUuid) {
    return {
      updated: 0,
      stemProfile: normalizedStemProfile
    }
  }
  const db = getLibraryDb()
  if (!db) {
    return {
      updated: 0,
      stemProfile: normalizedStemProfile
    }
  }
  try {
    const current = getMixtapeProjectStemConfig(normalizedPlaylistUuid)
    const now = Date.now()
    const info = db
      .prepare(
        `INSERT INTO ${PROJECT_TABLE} (
           playlist_uuid,
           mix_mode,
           stem_profile,
           created_at_ms,
           updated_at_ms
         )
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(playlist_uuid) DO UPDATE SET
           stem_profile = excluded.stem_profile,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(normalizedPlaylistUuid, current.mixMode, normalizedStemProfile, now, now)
    return {
      updated: Number(info?.changes || 0),
      stemProfile: normalizedStemProfile
    }
  } catch (error) {
    log.error('[sqlite] mixtape project stem profile upsert failed', error)
    return {
      updated: 0,
      stemProfile: normalizedStemProfile
    }
  }
}

export function listMixtapeItems(playlistUuid: string): MixtapeItemRecord[] {
  if (!playlistUuid) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT id, playlist_uuid, file_path, mix_order, origin_playlist_uuid, origin_path_snapshot, info_json, created_at_ms
         FROM ${TABLE}
         WHERE playlist_uuid = ?
         ORDER BY mix_order ASC, created_at_ms ASC, id ASC`
      )
      .all(playlistUuid)
    return rows.map(toRecord).filter(Boolean) as MixtapeItemRecord[]
  } catch (error) {
    log.error('[sqlite] mixtape list failed', error)
    return []
  }
}

export function appendMixtapeItems(
  playlistUuid: string,
  items: MixtapeAppendItem[]
): { inserted: number } {
  const normalizedItems = Array.isArray(items)
    ? items.filter((item) => item && typeof item.filePath === 'string' && item.filePath.length > 0)
    : []
  if (!playlistUuid || normalizedItems.length === 0) return { inserted: 0 }
  const db = getLibraryDb()
  if (!db) return { inserted: 0 }
  try {
    const maxRow = db
      .prepare(`SELECT MAX(mix_order) AS max_order FROM ${TABLE} WHERE playlist_uuid = ?`)
      .get(playlistUuid)
    let currentOrder = Number(maxRow?.max_order || 0)
    const insert = db.prepare(
      `INSERT INTO ${TABLE} (id, playlist_uuid, file_path, mix_order, origin_playlist_uuid, origin_path_snapshot, info_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const now = Date.now()
    const tx = db.transaction(() => {
      for (const item of normalizedItems) {
        currentOrder += 1
        const info = item.info ? { ...item.info } : null
        if (info) stripMixtapeGridCopies(info)
        const infoJson = info ? JSON.stringify(info) : null
        insert.run(
          uuidV4(),
          playlistUuid,
          item.filePath,
          currentOrder,
          item.originPlaylistUuid || null,
          item.originPathSnapshot || null,
          infoJson,
          now
        )
      }
    })
    tx()
    return { inserted: normalizedItems.length }
  } catch (error) {
    log.error('[sqlite] mixtape append failed', error)
    return { inserted: 0 }
  }
}

export function removeMixtapeItemsByFilePath(
  playlistUuid: string,
  filePaths: string[]
): { removed: number } {
  const normalizedPaths = normalizeUniqueStrings(filePaths)
  if (!playlistUuid || normalizedPaths.length === 0) return { removed: 0 }
  const db = getLibraryDb()
  if (!db) return { removed: 0 }
  try {
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE playlist_uuid = ? AND file_path = ?`)
    let removed = 0
    const tx = db.transaction(() => {
      for (const filePath of normalizedPaths) {
        const info = del.run(playlistUuid, filePath)
        removed += Number(info?.changes || 0)
      }
      if (removed > 0) {
        normalizeMixtapeOrderInTx(db, playlistUuid)
      }
    })
    tx()
    return { removed }
  } catch (error) {
    log.error('[sqlite] mixtape remove failed', error)
    return { removed: 0 }
  }
}

export function removeMixtapeItemsById(
  playlistUuid: string,
  itemIds: string[]
): { removed: number } {
  const normalizedIds = normalizeUniqueStrings(itemIds)
  if (!playlistUuid || normalizedIds.length === 0) return { removed: 0 }
  const db = getLibraryDb()
  if (!db) return { removed: 0 }
  try {
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE playlist_uuid = ? AND id = ?`)
    let removed = 0
    const tx = db.transaction(() => {
      for (const id of normalizedIds) {
        const info = del.run(playlistUuid, id)
        removed += Number(info?.changes || 0)
      }
      if (removed > 0) {
        normalizeMixtapeOrderInTx(db, playlistUuid)
      }
    })
    tx()
    return { removed }
  } catch (error) {
    log.error('[sqlite] mixtape remove by id failed', error)
    return { removed: 0 }
  }
}

export function reorderMixtapeItems(
  playlistUuid: string,
  orderedIds: string[]
): { updated: number } {
  const normalizedIds = Array.isArray(orderedIds)
    ? orderedIds
        .filter((id) => typeof id === 'string')
        .map((id) => String(id).trim())
        .filter(Boolean)
    : []
  if (!playlistUuid || normalizedIds.length === 0) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }
  try {
    const rows = db
      .prepare(
        `SELECT id FROM ${TABLE} WHERE playlist_uuid = ? ORDER BY mix_order ASC, created_at_ms ASC, id ASC`
      )
      .all(playlistUuid)
    const existingIds: string[] = rows.map((row: { id: string | number }) => String(row.id))
    const orderedSet = new Set(normalizedIds)
    const finalIds = [
      ...normalizedIds.filter((id) => existingIds.includes(id)),
      ...existingIds.filter((id) => !orderedSet.has(id))
    ]
    const update = db.prepare(`UPDATE ${TABLE} SET mix_order = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      finalIds.forEach((id, idx) => {
        update.run(idx + 1, id)
      })
    })
    tx()
    return { updated: finalIds.length }
  } catch (error) {
    log.error('[sqlite] mixtape reorder failed', error)
    return { updated: 0 }
  }
}

export function listMixtapeFilePathsByPlaylist(playlistUuid: string): string[] {
  if (!playlistUuid) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(`SELECT file_path FROM ${TABLE} WHERE playlist_uuid = ?`)
      .all(playlistUuid)
    return normalizeUniqueStrings(rows.map((row: { file_path: string }) => row.file_path))
  } catch (error) {
    log.error('[sqlite] mixtape list file paths failed', error)
    return []
  }
}

export function listMixtapeFilePathsByItemIds(playlistUuid: string, itemIds: string[]): string[] {
  const normalizedIds = normalizeUniqueStrings(itemIds)
  if (!playlistUuid || normalizedIds.length === 0) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const results: string[] = []
    for (let offset = 0; offset < normalizedIds.length; offset += IN_CLAUSE_CHUNK_SIZE) {
      const chunk = normalizedIds.slice(offset, offset + IN_CLAUSE_CHUNK_SIZE)
      if (chunk.length === 0) continue
      const placeholders = chunk.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT file_path FROM ${TABLE} WHERE playlist_uuid = ? AND id IN (${placeholders})`
        )
        .all(playlistUuid, ...chunk)
      results.push(...rows.map((row: { file_path: string }) => row.file_path))
    }
    return normalizeUniqueStrings(results)
  } catch (error) {
    log.error('[sqlite] mixtape list file paths by id failed', error)
    return []
  }
}

export function listMixtapeItemsByItemIds(
  playlistUuid: string,
  itemIds: string[]
): MixtapeItemRecord[] {
  const normalizedIds = normalizeUniqueStrings(itemIds)
  if (!playlistUuid || normalizedIds.length === 0) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const results: MixtapeItemRecord[] = []
    for (let offset = 0; offset < normalizedIds.length; offset += IN_CLAUSE_CHUNK_SIZE) {
      const chunk = normalizedIds.slice(offset, offset + IN_CLAUSE_CHUNK_SIZE)
      if (chunk.length === 0) continue
      const placeholders = chunk.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT id, playlist_uuid, file_path, mix_order, origin_playlist_uuid, origin_path_snapshot, info_json, created_at_ms
           FROM ${TABLE}
           WHERE playlist_uuid = ? AND id IN (${placeholders})
           ORDER BY mix_order ASC, created_at_ms ASC, id ASC`
        )
        .all(playlistUuid, ...chunk)
      results.push(...(rows.map(toRecord).filter(Boolean) as MixtapeItemRecord[]))
    }
    return results.sort(compareMixtapeItemRecordOrder)
  } catch (error) {
    log.error('[sqlite] mixtape list by ids failed', error)
    return []
  }
}

export function listMixtapeFilePathsInUse(filePaths: string[]): string[] {
  const normalizedPaths = normalizeUniqueStrings(filePaths)
  if (normalizedPaths.length === 0) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const results: string[] = []
    for (let offset = 0; offset < normalizedPaths.length; offset += IN_CLAUSE_CHUNK_SIZE) {
      const chunk = normalizedPaths.slice(offset, offset + IN_CLAUSE_CHUNK_SIZE)
      if (chunk.length === 0) continue
      const placeholders = chunk.map(() => '?').join(',')
      const caseInsensitive = process.platform === 'win32'
      const filePathExpression = caseInsensitive ? 'LOWER(file_path)' : 'file_path'
      const queryPaths = caseInsensitive ? chunk.map((filePath) => filePath.toLowerCase()) : chunk
      const rows = db
        .prepare(
          `SELECT DISTINCT file_path FROM ${TABLE} WHERE ${filePathExpression} IN (${placeholders})`
        )
        .all(...queryPaths)
      results.push(...rows.map((row: { file_path: string }) => row.file_path))
    }
    return normalizeUniqueStrings(results)
  } catch (error) {
    log.error('[sqlite] mixtape list file paths in use failed', error)
    return []
  }
}

export function listMixtapeItemsByFilePath(filePath: string): MixtapeItemRecord[] {
  const normalizedPath = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalizedPath) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const whereClause = resolveFilePathWhereClause()
    const rows = db
      .prepare(
        `SELECT id, playlist_uuid, file_path, mix_order, origin_playlist_uuid, origin_path_snapshot, info_json, created_at_ms
         FROM ${TABLE}
         WHERE ${whereClause}
         ORDER BY mix_order ASC, created_at_ms ASC, id ASC`
      )
      .all(normalizedPath)
    return rows.map(toRecord).filter(Boolean) as MixtapeItemRecord[]
  } catch (error) {
    log.error('[sqlite] mixtape list by file path failed', error)
    return []
  }
}

export function replaceMixtapeFilePath(
  oldFilePath: string,
  newFilePath: string
): { updated: number; playlistUuids: string[]; itemIds: string[] } {
  const sourcePath = typeof oldFilePath === 'string' ? oldFilePath.trim() : ''
  const targetPath = typeof newFilePath === 'string' ? newFilePath.trim() : ''
  if (!sourcePath || !targetPath || sourcePath === targetPath) {
    return { updated: 0, playlistUuids: [], itemIds: [] }
  }
  const db = getLibraryDb()
  if (!db) return { updated: 0, playlistUuids: [], itemIds: [] }
  try {
    const whereClause = resolveFilePathWhereClause()
    const rows = db
      .prepare(`SELECT id, playlist_uuid FROM ${TABLE} WHERE ${whereClause}`)
      .all(sourcePath) as Array<{ id: string; playlist_uuid: string }>
    if (!rows.length) {
      return { updated: 0, playlistUuids: [], itemIds: [] }
    }
    const update = db.prepare(`UPDATE ${TABLE} SET file_path = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      for (const row of rows) {
        update.run(targetPath, row.id)
      }
    })
    tx()
    return {
      updated: rows.length,
      playlistUuids: Array.from(new Set(rows.map((row) => String(row.playlist_uuid)))),
      itemIds: rows.map((row) => String(row.id))
    }
  } catch (error) {
    log.error('[sqlite] mixtape file path replace failed', error)
    return { updated: 0, playlistUuids: [], itemIds: [] }
  }
}

export function updateMixtapeItemFilePathsById(entries: MixtapeFilePathUpdate[]): {
  updated: number
  playlistUuids: string[]
} {
  const normalizedEntries = Array.isArray(entries)
    ? entries
        .filter((item) => item && typeof item.id === 'string' && typeof item.filePath === 'string')
        .map((item) => ({
          id: String(item.id).trim(),
          filePath: String(item.filePath).trim()
        }))
        .filter((item) => item.id && item.filePath)
    : []
  if (!normalizedEntries.length) return { updated: 0, playlistUuids: [] }
  const db = getLibraryDb()
  if (!db) return { updated: 0, playlistUuids: [] }
  try {
    const allIds = normalizedEntries.map((item) => item.id)
    const rows: Array<{ id: string; playlist_uuid: string }> = []
    for (let offset = 0; offset < allIds.length; offset += IN_CLAUSE_CHUNK_SIZE) {
      const chunk = allIds.slice(offset, offset + IN_CLAUSE_CHUNK_SIZE)
      if (chunk.length === 0) continue
      const placeholders = chunk.map(() => '?').join(',')
      const chunkRows = db
        .prepare(`SELECT id, playlist_uuid FROM ${TABLE} WHERE id IN (${placeholders})`)
        .all(...chunk) as Array<{ id: string; playlist_uuid: string }>
      rows.push(...chunkRows)
    }
    if (!rows.length) return { updated: 0, playlistUuids: [] }
    const existingIds = new Set(rows.map((row) => String(row.id)))
    const playlistUuids = Array.from(new Set(rows.map((row) => String(row.playlist_uuid))))
    const update = db.prepare(`UPDATE ${TABLE} SET file_path = ? WHERE id = ?`)
    let updated = 0
    const tx = db.transaction(() => {
      for (const item of normalizedEntries) {
        if (!existingIds.has(item.id)) continue
        const info = update.run(item.filePath, item.id)
        updated += Number(info?.changes || 0)
      }
    })
    tx()
    return { updated, playlistUuids }
  } catch (error) {
    log.error('[sqlite] mixtape update file paths by id failed', error)
    return { updated: 0, playlistUuids: [] }
  }
}

export function clearMixtapeItemGridCopiesByFilePath(entries: Array<{ filePath: string }>): {
  updated: number
} {
  if (!Array.isArray(entries) || entries.length === 0) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }

  const filePaths = new Set<string>()
  for (const item of entries) {
    const filePath = typeof item?.filePath === 'string' ? item.filePath.trim() : ''
    if (!filePath) continue
    filePaths.add(filePath)
  }
  if (!filePaths.size) return { updated: 0 }

  try {
    let updated = 0
    const updateStmt = db.prepare(`UPDATE ${TABLE} SET info_json = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      const CHUNK_SIZE = 300
      const paths = Array.from(filePaths)
      for (let offset = 0; offset < paths.length; offset += CHUNK_SIZE) {
        const chunk = paths.slice(offset, offset + CHUNK_SIZE)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db
          .prepare(
            `SELECT id, file_path, info_json FROM ${TABLE} WHERE file_path IN (${placeholders})`
          )
          .all(...chunk) as Array<{ id: string; file_path: string; info_json?: string | null }>
        for (const row of rows) {
          const filePath = typeof row?.file_path === 'string' ? row.file_path.trim() : ''
          if (!filePaths.has(filePath)) continue
          const info = parseMixtapeItemInfoJson(row?.info_json)
          const removedGridCopy = stripMixtapeGridCopies(info)
          if (removedGridCopy) {
            updateStmt.run(JSON.stringify(info), row.id)
            updated += 1
          }
        }
      }
    })
    tx()
    return { updated }
  } catch (error) {
    log.error('[sqlite] mixtape grid upsert failed', error)
    return { updated: 0 }
  }
}

export function upsertMixtapeItemHotCuesByFilePath(
  entries: Array<{ filePath: string; hotCues?: ISongHotCue[] }>
): { updated: number } {
  if (!Array.isArray(entries) || entries.length === 0) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }

  const hotCuesByFilePath = new Map<string, ISongHotCue[]>()
  for (const item of entries) {
    const filePath = typeof item?.filePath === 'string' ? item.filePath.trim() : ''
    if (!filePath) continue
    hotCuesByFilePath.set(filePath, normalizeSongHotCues(item?.hotCues))
  }
  const filePaths = Array.from(hotCuesByFilePath.keys())
  if (!filePaths.length) return { updated: 0 }

  try {
    let updated = 0
    const updateStmt = db.prepare(`UPDATE ${TABLE} SET info_json = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      const CHUNK_SIZE = 300
      for (let offset = 0; offset < filePaths.length; offset += CHUNK_SIZE) {
        const chunk = filePaths.slice(offset, offset + CHUNK_SIZE)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db
          .prepare(
            `SELECT id, file_path, info_json FROM ${TABLE} WHERE file_path IN (${placeholders})`
          )
          .all(...chunk) as Array<{ id: string; file_path: string; info_json?: string | null }>
        for (const row of rows) {
          const filePath = typeof row?.file_path === 'string' ? row.file_path.trim() : ''
          const nextHotCues = hotCuesByFilePath.get(filePath)
          if (!nextHotCues) continue
          const info = parseMixtapeItemInfoJson(row?.info_json)
          if (areSongHotCuesEqual(info.hotCues, nextHotCues)) continue
          info.hotCues = nextHotCues
          updateStmt.run(JSON.stringify(info), row.id)
          updated += 1
        }
      }
    })
    tx()
    return { updated }
  } catch (error) {
    log.error('[sqlite] mixtape hot cue upsert failed', error)
    return { updated: 0 }
  }
}

export function upsertMixtapeItemMemoryCuesByFilePath(
  entries: Array<{ filePath: string; memoryCues?: ISongMemoryCue[] }>
): { updated: number } {
  if (!Array.isArray(entries) || entries.length === 0) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }

  const memoryCuesByFilePath = new Map<string, ISongMemoryCue[]>()
  for (const item of entries) {
    const filePath = typeof item?.filePath === 'string' ? item.filePath.trim() : ''
    if (!filePath) continue
    memoryCuesByFilePath.set(filePath, normalizeSongMemoryCues(item?.memoryCues))
  }
  const filePaths = Array.from(memoryCuesByFilePath.keys())
  if (!filePaths.length) return { updated: 0 }

  try {
    let updated = 0
    const updateStmt = db.prepare(`UPDATE ${TABLE} SET info_json = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      const CHUNK_SIZE = 300
      for (let offset = 0; offset < filePaths.length; offset += CHUNK_SIZE) {
        const chunk = filePaths.slice(offset, offset + CHUNK_SIZE)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db
          .prepare(
            `SELECT id, file_path, info_json FROM ${TABLE} WHERE file_path IN (${placeholders})`
          )
          .all(...chunk) as Array<{ id: string; file_path: string; info_json?: string | null }>
        for (const row of rows) {
          const filePath = typeof row?.file_path === 'string' ? row.file_path.trim() : ''
          const nextMemoryCues = memoryCuesByFilePath.get(filePath)
          if (!nextMemoryCues) continue
          const info = parseMixtapeItemInfoJson(row?.info_json)
          if (areSongMemoryCuesEqual(info.memoryCues, nextMemoryCues)) continue
          info.memoryCues = nextMemoryCues
          updateStmt.run(JSON.stringify(info), row.id)
          updated += 1
        }
      }
    })
    tx()
    return { updated }
  } catch (error) {
    log.error('[sqlite] mixtape memory cue upsert failed', error)
    return { updated: 0 }
  }
}

export type { MixtapeMixEnvelopeParam } from './mixtapeDbInfoJson'
export {
  upsertMixtapeItemMixEnvelopeById,
  upsertMixtapeItemGainEnvelopeById,
  upsertMixtapeItemLoopSegmentsById,
  upsertMixtapeItemVolumeMuteSegmentsById,
  upsertMixtapeItemStartSecById
} from './mixtapeDbInfoJson'

export function removeMixtapeItemsByPlaylist(playlistUuid: string): { removed: number } {
  if (!playlistUuid) return { removed: 0 }
  const db = getLibraryDb()
  if (!db) return { removed: 0 }
  try {
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE playlist_uuid = ?`)
    const info = del.run(playlistUuid)
    return { removed: Number(info?.changes || 0) }
  } catch (error) {
    log.error('[sqlite] mixtape remove by playlist failed', error)
    return { removed: 0 }
  }
}
