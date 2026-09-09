import { getLibraryDb, isSqliteRow } from './libraryDb'
import { log } from './log'

export type RecycleBinRecord = {
  filePath: string
  deletedAtMs: number
  originalPlaylistPath?: string | null
  originalFileName?: string | null
  sourceType?: string | null
  fileId?: string | null
  contentSha256?: string | null
  contentSize?: number | null
}

const TABLE = 'recycle_bin_records'

const SELECT_COLUMNS = `file_path, deleted_at_ms, original_playlist_path, original_file_name, source_type, file_id, content_sha256, content_size`

const isAbsoluteOnAnySupportedPlatform = (value: string): boolean => {
  const normalized = String(value || '').trim()
  return /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/.test(normalized) || normalized.startsWith('/')
}

export const normalizeRecycleBinStoredPath = (value: string): string => {
  const normalized = String(value || '').trim()
  if (!normalized || isAbsoluteOnAnySupportedPlatform(normalized)) return normalized
  return normalized.replace(/\\/g, '/')
}

export const normalizeRecycleBinRecordPathKey = (
  value: string,
  platform = process.platform
): string => {
  const normalized = String(value || '')
    .trim()
    .replace(/\\/g, '/')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

const getPathLookupCandidates = (value: string): string[] => {
  const raw = String(value || '').trim()
  if (!raw) return []
  const canonical = normalizeRecycleBinStoredPath(raw)
  return Array.from(new Set([raw, canonical, canonical.replace(/\//g, '\\')]))
}

const buildPathLookup = (value: string): { clause: string; params: string[] } => {
  const candidates = getPathLookupCandidates(value)
  const column = process.platform === 'win32' ? 'LOWER(file_path)' : 'file_path'
  const params =
    process.platform === 'win32'
      ? candidates.map((candidate) => candidate.toLowerCase())
      : candidates
  return {
    clause: `${column} IN (${params.map(() => '?').join(', ')})`,
    params
  }
}

function normalizeRecord(row: unknown): RecycleBinRecord | null {
  if (!isSqliteRow(row) || !row.file_path) return null
  const deletedAtMs = Number(row.deleted_at_ms)
  if (!Number.isFinite(deletedAtMs)) return null
  const contentSize = Number(row.content_size)
  return {
    filePath: normalizeRecycleBinStoredPath(String(row.file_path)),
    deletedAtMs,
    originalPlaylistPath: row.original_playlist_path
      ? normalizeRecycleBinStoredPath(String(row.original_playlist_path))
      : null,
    originalFileName: row.original_file_name ? String(row.original_file_name) : null,
    sourceType: row.source_type ? String(row.source_type) : null,
    fileId: row.file_id ? String(row.file_id) : null,
    contentSha256: row.content_sha256 ? String(row.content_sha256) : null,
    contentSize: Number.isFinite(contentSize) && contentSize > 0 ? contentSize : null
  }
}

export function listRecycleBinRecords(): RecycleBinRecord[] {
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db.prepare(`SELECT ${SELECT_COLUMNS} FROM ${TABLE}`).all()
    const byPath = new Map<string, RecycleBinRecord>()
    for (const row of rows || []) {
      const record = normalizeRecord(row)
      if (!record) continue
      const key = normalizeRecycleBinRecordPathKey(record.filePath)
      const previous = byPath.get(key)
      if (!previous || record.deletedAtMs > previous.deletedAtMs) byPath.set(key, record)
    }
    return Array.from(byPath.values())
  } catch (error) {
    log.error('[sqlite] recycle bin list failed', error)
    return []
  }
}

export function getRecycleBinRecord(filePath: string): RecycleBinRecord | null {
  const db = getLibraryDb()
  if (!db || !filePath) return null
  try {
    const lookup = buildPathLookup(filePath)
    if (lookup.params.length === 0) return null
    const row = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE ${lookup.clause} ORDER BY deleted_at_ms DESC LIMIT 1`
      )
      .get(...lookup.params)
    return normalizeRecord(row)
  } catch (error) {
    log.error('[sqlite] recycle bin get failed', error)
    return null
  }
}

export function getRecycleBinRecordByFileId(fileId: string): RecycleBinRecord | null {
  const db = getLibraryDb()
  const normalized = String(fileId || '').trim()
  if (!db || !normalized) return null
  try {
    const row = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE file_id = ? ORDER BY deleted_at_ms DESC LIMIT 1`
      )
      .get(normalized)
    return normalizeRecord(row)
  } catch (error) {
    log.error('[sqlite] recycle bin get by fileId failed', error)
    return null
  }
}

export function upsertRecycleBinRecord(record: RecycleBinRecord): boolean {
  const db = getLibraryDb()
  if (!db || !record?.filePath) return false
  try {
    const canonicalRecord: RecycleBinRecord = {
      ...record,
      filePath: normalizeRecycleBinStoredPath(record.filePath),
      originalPlaylistPath: record.originalPlaylistPath
        ? normalizeRecycleBinStoredPath(record.originalPlaylistPath)
        : null
    }
    if (!canonicalRecord.filePath) return false
    const existing = getRecycleBinRecord(canonicalRecord.filePath)
    const existingMs = existing?.deletedAtMs ?? null
    if (existingMs !== null && existingMs > canonicalRecord.deletedAtMs) {
      return false
    }
    const write = db.transaction(() => {
      const lookup = buildPathLookup(canonicalRecord.filePath)
      if (lookup.params.length > 0) {
        db.prepare(`DELETE FROM ${TABLE} WHERE ${lookup.clause}`).run(...lookup.params)
      }
      // DELETE 使用 Windows 不区分大小写匹配，INSERT 却受 SQLite 主键的字节比较约束。
      // 因此路径仅大小写不同（或 legacy 路径别名）时，旧实现会漏删并触发 UNIQUE(file_path)。
      // 此处以同一个 canonical 路径做查找和写入，再用 ON CONFLICT 作为最终原子兜底。
      db.prepare(
        `INSERT INTO ${TABLE} (
         file_path, deleted_at_ms, original_playlist_path, original_file_name, source_type,
         file_id, content_sha256, content_size
       )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          deleted_at_ms = excluded.deleted_at_ms,
          original_playlist_path = excluded.original_playlist_path,
          original_file_name = excluded.original_file_name,
          source_type = excluded.source_type,
          file_id = COALESCE(excluded.file_id, ${TABLE}.file_id),
          content_sha256 = COALESCE(excluded.content_sha256, ${TABLE}.content_sha256),
          content_size = COALESCE(excluded.content_size, ${TABLE}.content_size)`
      ).run(
        canonicalRecord.filePath,
        canonicalRecord.deletedAtMs,
        canonicalRecord.originalPlaylistPath ?? null,
        canonicalRecord.originalFileName ?? null,
        canonicalRecord.sourceType ?? null,
        canonicalRecord.fileId || existing?.fileId || null,
        canonicalRecord.contentSha256 || existing?.contentSha256 || null,
        canonicalRecord.contentSize ?? existing?.contentSize ?? null
      )
    })
    write()
    return true
  } catch (error) {
    log.error('[sqlite] recycle bin upsert failed', error)
    return false
  }
}

export function deleteRecycleBinRecord(filePath: string): boolean {
  const db = getLibraryDb()
  if (!db || !filePath) return false
  try {
    const lookup = buildPathLookup(filePath)
    if (lookup.params.length === 0) return false
    db.prepare(`DELETE FROM ${TABLE} WHERE ${lookup.clause}`).run(...lookup.params)
    return true
  } catch (error) {
    log.error('[sqlite] recycle bin delete failed', error)
    return false
  }
}

export function deleteRecycleBinRecords(filePaths: string[]): number {
  const db = getLibraryDb()
  if (!db || !Array.isArray(filePaths) || filePaths.length === 0) return 0
  try {
    let deleted = 0
    const run = db.transaction((items: string[]) => {
      for (const fp of items) {
        const lookup = buildPathLookup(fp)
        if (lookup.params.length === 0) continue
        const result = db
          .prepare(`DELETE FROM ${TABLE} WHERE ${lookup.clause}`)
          .run(...lookup.params)
        deleted += Number(result.changes || 0)
      }
    })
    run(filePaths)
    return deleted
  } catch (error) {
    log.error('[sqlite] recycle bin bulk delete failed', error)
    return 0
  }
}
