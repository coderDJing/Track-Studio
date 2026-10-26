import { getLibraryDb } from './libraryDb'
import { isSqliteRow } from './libraryDb'
import { log } from './log'
import type { MixtapeStemMode } from './mixtapeDb'
import { normalizeMixtapeStemMode } from '../shared/mixtapeStemMode'

const ITEM_TABLE = 'mixtape_items'
const STEM_ASSET_TABLE = 'library_stem_assets'
const LEGACY_STEM_ASSET_TABLE = 'mixtape_stem_assets'
const STEM_WAVEFORM_CACHE_TABLE = 'mixtape_stem_waveform_cache'

export type MixtapeStemStatus = 'idle' | 'pending' | 'running' | 'ready' | 'failed'

export type MixtapeStemSummary = Record<MixtapeStemStatus, number>

type MixtapeStemAssetRecord = {
  libraryRoot: string
  sourceSignature: string
  filePath: string
  stemMode: MixtapeStemMode
  model: string
  status: MixtapeStemStatus
  vocalPath?: string | null
  instPath?: string | null
  bassPath?: string | null
  drumsPath?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  createdAtMs: number
  updatedAtMs: number
}

type MixtapeStemAssetUpsertInput = {
  libraryRoot: string
  sourceSignature: string
  filePath: string
  stemMode: MixtapeStemMode
  model: string
  status: MixtapeStemStatus
  vocalPath?: string | null
  instPath?: string | null
  bassPath?: string | null
  drumsPath?: string | null
  errorCode?: string | null
  errorMessage?: string | null
}

type MixtapeItemStemStatePatch = {
  itemId: string
  stemStatus?: MixtapeStemStatus
  stemError?: string | null
  stemReadyAt?: number | null
  stemModel?: string | null
  stemVersion?: string | null
  stemVocalPath?: string | null
  stemInstPath?: string | null
  stemBassPath?: string | null
  stemDrumsPath?: string | null
}

type MixtapeTrackStemStatusRecord = {
  itemId: string
  filePath: string
  stemStatus: MixtapeStemStatus
  stemError?: string | null
  stemReadyAt?: number | null
  stemModel?: string | null
  stemVersion?: string | null
}

const DEFAULT_STEM_SUMMARY: MixtapeStemSummary = {
  idle: 0,
  pending: 0,
  running: 0,
  ready: 0,
  failed: 0
}

const normalizeStemStatus = (
  value: unknown,
  fallback: MixtapeStemStatus = 'pending'
): MixtapeStemStatus => {
  if (
    value === 'idle' ||
    value === 'pending' ||
    value === 'running' ||
    value === 'ready' ||
    value === 'failed'
  ) {
    return value
  }
  return fallback
}

const normalizeText = (value: unknown, maxLen = 800): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen)
}

const normalizeFilePath = (value: unknown) => normalizeText(value, 4000)
const normalizeSourceSignature = (value: unknown) => normalizeText(value, 160)

const normalizeTimestampMs = (value: unknown): number | null => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Math.floor(numeric)
}

type MixtapeStemInfoJson = Record<string, unknown>

const parseInfoJson = (raw: unknown): MixtapeStemInfoJson => {
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (isSqliteRow(parsed)) return parsed
    return {}
  } catch {
    return {}
  }
}

const toAssetRecord = (row: unknown): MixtapeStemAssetRecord | null => {
  if (!isSqliteRow(row)) return null
  const libraryRoot = normalizeText(row?.library_root, 2000)
  const sourceSignature = normalizeSourceSignature(row?.source_signature)
  const filePath = normalizeFilePath(row?.file_path)
  const model = normalizeText(row?.model, 128)
  if (!libraryRoot || !sourceSignature || !filePath || !model) return null
  return {
    libraryRoot,
    sourceSignature,
    filePath,
    stemMode: normalizeMixtapeStemMode(row?.stem_mode),
    model,
    status: normalizeStemStatus(row?.status, 'pending'),
    vocalPath: normalizeFilePath(row?.vocal_path) || null,
    instPath: normalizeFilePath(row?.inst_path) || null,
    bassPath: normalizeFilePath(row?.bass_path) || null,
    drumsPath: normalizeFilePath(row?.drums_path) || null,
    errorCode: normalizeText(row?.error_code, 80) || null,
    errorMessage: normalizeText(row?.error_message, 2000) || null,
    createdAtMs: Math.max(0, Number(row?.created_at_ms) || 0),
    updatedAtMs: Math.max(0, Number(row?.updated_at_ms) || 0)
  }
}

export const resolveMixtapeStemStatusFromInfo = (infoJson: unknown): MixtapeStemStatus => {
  const info = parseInfoJson(infoJson)
  // 兼容历史数据：缺少状态字段默认视为 ready，避免老工程被导出门禁拦截
  if (!Object.prototype.hasOwnProperty.call(info, 'stemStatus')) return 'ready'
  return normalizeStemStatus(info.stemStatus, 'ready')
}

export function upsertMixtapeStemAsset(input: MixtapeStemAssetUpsertInput): { updated: number } {
  const libraryRoot = normalizeText(input?.libraryRoot, 2000)
  const sourceSignature = normalizeSourceSignature(input?.sourceSignature)
  const filePath = normalizeFilePath(input?.filePath)
  const stemMode = normalizeMixtapeStemMode(input?.stemMode)
  const model = normalizeText(input?.model, 128)
  const status = normalizeStemStatus(input?.status, 'pending')
  if (!libraryRoot || !sourceSignature || !filePath || !model) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }
  const now = Date.now()
  try {
    const info = db
      .prepare(
        `INSERT INTO ${STEM_ASSET_TABLE} (
          library_root, source_signature, file_path, stem_mode, model, status,
          vocal_path, inst_path, bass_path, drums_path,
          error_code, error_message, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(library_root, source_signature, stem_mode, model) DO UPDATE SET
          file_path = excluded.file_path,
          status = excluded.status,
          vocal_path = excluded.vocal_path,
          inst_path = excluded.inst_path,
          bass_path = excluded.bass_path,
          drums_path = excluded.drums_path,
          error_code = excluded.error_code,
          error_message = excluded.error_message,
          updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        libraryRoot,
        sourceSignature,
        filePath,
        stemMode,
        model,
        status,
        normalizeFilePath(input?.vocalPath) || null,
        normalizeFilePath(input?.instPath) || null,
        normalizeFilePath(input?.bassPath) || null,
        normalizeFilePath(input?.drumsPath) || null,
        normalizeText(input?.errorCode, 80) || null,
        normalizeText(input?.errorMessage, 2000) || null,
        now,
        now
      )
    return { updated: Number(info?.changes || 0) }
  } catch (error) {
    log.error('[sqlite] mixtape stem asset upsert failed', {
      libraryRoot,
      sourceSignature,
      filePath,
      stemMode,
      model,
      error
    })
    return { updated: 0 }
  }
}

export function getMixtapeStemAsset(params: {
  libraryRoot: string
  sourceSignature: string
  stemMode: MixtapeStemMode
  model: string
}): MixtapeStemAssetRecord | null {
  const libraryRoot = normalizeText(params?.libraryRoot, 2000)
  const sourceSignature = normalizeSourceSignature(params?.sourceSignature)
  const stemMode = normalizeMixtapeStemMode(params?.stemMode)
  const model = normalizeText(params?.model, 128)
  if (!libraryRoot || !sourceSignature || !model) return null
  const db = getLibraryDb()
  if (!db) return null
  try {
    const row = db
      .prepare(
        `SELECT library_root, source_signature, file_path, stem_mode, model, status,
                vocal_path, inst_path, bass_path, drums_path,
                error_code, error_message, created_at_ms, updated_at_ms
         FROM ${STEM_ASSET_TABLE}
         WHERE library_root = ? AND source_signature = ? AND stem_mode = ? AND model = ?`
      )
      .get(libraryRoot, sourceSignature, stemMode, model)
    return toAssetRecord(row)
  } catch (error) {
    log.error('[sqlite] mixtape stem asset get failed', {
      libraryRoot,
      sourceSignature,
      stemMode,
      model,
      error
    })
    return null
  }
}

export function replaceMixtapeStemAssetFilePath(params: {
  libraryRoot: string
  oldFilePath: string
  newFilePath: string
}): { updated: number } {
  const libraryRoot = normalizeText(params?.libraryRoot, 2000)
  const oldFilePath = normalizeFilePath(params?.oldFilePath)
  const newFilePath = normalizeFilePath(params?.newFilePath)
  if (!libraryRoot || !oldFilePath || !newFilePath || oldFilePath === newFilePath) {
    return { updated: 0 }
  }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }
  try {
    const info = db
      .prepare(
        `UPDATE ${STEM_ASSET_TABLE}
         SET file_path = ?, updated_at_ms = ?
         WHERE frkb_file_path_key(library_root) = frkb_file_path_key(?) AND frkb_file_path_key(file_path) = frkb_file_path_key(?)`
      )
      .run(newFilePath, Date.now(), libraryRoot, oldFilePath)
    return { updated: Number(info?.changes || 0) }
  } catch (error) {
    log.error('[sqlite] mixtape stem asset file path replace failed', {
      libraryRoot,
      oldFilePath,
      newFilePath,
      error
    })
    return { updated: 0 }
  }
}

export function removeMixtapeStemAssetsByFilePath(params: {
  libraryRoot: string
  filePath: string
}): MixtapeStemAssetRecord[] {
  const libraryRoot = normalizeText(params?.libraryRoot, 2000)
  const filePath = normalizeFilePath(params?.filePath)
  if (!libraryRoot || !filePath) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT library_root, source_signature, file_path, stem_mode, model, status,
                vocal_path, inst_path, bass_path, drums_path,
                error_code, error_message, created_at_ms, updated_at_ms
         FROM ${STEM_ASSET_TABLE}
         WHERE frkb_file_path_key(library_root) = frkb_file_path_key(?) AND frkb_file_path_key(file_path) = frkb_file_path_key(?)`
      )
      .all(libraryRoot, filePath)
    const records = rows.map(toAssetRecord).filter(Boolean) as MixtapeStemAssetRecord[]
    if (!records.length) return []
    db.prepare(
      `DELETE FROM ${STEM_ASSET_TABLE} WHERE frkb_file_path_key(library_root) = frkb_file_path_key(?) AND frkb_file_path_key(file_path) = frkb_file_path_key(?)`
    ).run(libraryRoot, filePath)
    return records
  } catch (error) {
    log.error('[sqlite] mixtape stem asset delete by file path failed', {
      libraryRoot,
      filePath,
      error
    })
    return []
  }
}

export function upsertMixtapeItemStemStateById(entries: MixtapeItemStemStatePatch[]): {
  updated: number
} {
  if (!Array.isArray(entries) || entries.length === 0) return { updated: 0 }
  const patchById = new Map<string, MixtapeItemStemStatePatch>()
  for (const item of entries) {
    const itemId = normalizeText(item?.itemId, 80)
    if (!itemId) continue
    patchById.set(itemId, item)
  }
  const itemIds = Array.from(patchById.keys())
  if (!itemIds.length) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }
  try {
    let updated = 0
    const updateStmt = db.prepare(`UPDATE ${ITEM_TABLE} SET info_json = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      const CHUNK_SIZE = 300
      for (let offset = 0; offset < itemIds.length; offset += CHUNK_SIZE) {
        const chunk = itemIds.slice(offset, offset + CHUNK_SIZE)
        if (!chunk.length) continue
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db
          .prepare(`SELECT id, info_json FROM ${ITEM_TABLE} WHERE id IN (${placeholders})`)
          .all(...chunk) as Array<{ id: string; info_json?: string | null }>
        for (const row of rows) {
          const itemId = normalizeText(row?.id, 80)
          if (!itemId) continue
          const patch = patchById.get(itemId)
          if (!patch) continue
          const info = parseInfoJson(row?.info_json)
          let changed = false

          if (typeof patch?.stemStatus === 'string') {
            const nextStemStatus = normalizeStemStatus(patch.stemStatus, 'pending')
            if (info.stemStatus !== nextStemStatus) {
              info.stemStatus = nextStemStatus
              changed = true
            }
          }

          if (Object.prototype.hasOwnProperty.call(patch, 'stemError')) {
            const nextStemError = normalizeText(patch.stemError, 1200)
            if (nextStemError) {
              if (info.stemError !== nextStemError) {
                info.stemError = nextStemError
                changed = true
              }
            } else if (Object.prototype.hasOwnProperty.call(info, 'stemError')) {
              delete info.stemError
              changed = true
            }
          }

          if (Object.prototype.hasOwnProperty.call(patch, 'stemReadyAt')) {
            const nextStemReadyAt = normalizeTimestampMs(patch.stemReadyAt)
            if (nextStemReadyAt !== null) {
              if (Number(info.stemReadyAt) !== nextStemReadyAt) {
                info.stemReadyAt = nextStemReadyAt
                changed = true
              }
            } else if (Object.prototype.hasOwnProperty.call(info, 'stemReadyAt')) {
              delete info.stemReadyAt
              changed = true
            }
          }

          if (Object.prototype.hasOwnProperty.call(patch, 'stemModel')) {
            const nextStemModel = normalizeText(patch.stemModel, 128)
            if (nextStemModel) {
              if (info.stemModel !== nextStemModel) {
                info.stemModel = nextStemModel
                changed = true
              }
            } else if (Object.prototype.hasOwnProperty.call(info, 'stemModel')) {
              delete info.stemModel
              changed = true
            }
          }

          if (Object.prototype.hasOwnProperty.call(patch, 'stemVersion')) {
            const nextStemVersion = normalizeText(patch.stemVersion, 128)
            if (nextStemVersion) {
              if (info.stemVersion !== nextStemVersion) {
                info.stemVersion = nextStemVersion
                changed = true
              }
            } else if (Object.prototype.hasOwnProperty.call(info, 'stemVersion')) {
              delete info.stemVersion
              changed = true
            }
          }

          if (Object.prototype.hasOwnProperty.call(patch, 'stemVocalPath')) {
            const nextPath = normalizeFilePath(patch.stemVocalPath)
            if (nextPath) {
              if (info.stemVocalPath !== nextPath) {
                info.stemVocalPath = nextPath
                changed = true
              }
            } else if (Object.prototype.hasOwnProperty.call(info, 'stemVocalPath')) {
              delete info.stemVocalPath
              changed = true
            }
          }

          if (Object.prototype.hasOwnProperty.call(patch, 'stemInstPath')) {
            const nextPath = normalizeFilePath(patch.stemInstPath)
            if (nextPath) {
              if (info.stemInstPath !== nextPath) {
                info.stemInstPath = nextPath
                changed = true
              }
            } else if (Object.prototype.hasOwnProperty.call(info, 'stemInstPath')) {
              delete info.stemInstPath
              changed = true
            }
          }

          if (Object.prototype.hasOwnProperty.call(patch, 'stemBassPath')) {
            const nextPath = normalizeFilePath(patch.stemBassPath)
            if (nextPath) {
              if (info.stemBassPath !== nextPath) {
                info.stemBassPath = nextPath
                changed = true
              }
            } else if (Object.prototype.hasOwnProperty.call(info, 'stemBassPath')) {
              delete info.stemBassPath
              changed = true
            }
          }

          if (Object.prototype.hasOwnProperty.call(patch, 'stemDrumsPath')) {
            const nextPath = normalizeFilePath(patch.stemDrumsPath)
            if (nextPath) {
              if (info.stemDrumsPath !== nextPath) {
                info.stemDrumsPath = nextPath
                changed = true
              }
            } else if (Object.prototype.hasOwnProperty.call(info, 'stemDrumsPath')) {
              delete info.stemDrumsPath
              changed = true
            }
          }

          if (!changed) continue
          info.stemUpdatedAt = Date.now()
          updateStmt.run(JSON.stringify(info), itemId)
          updated += 1
        }
      }
    })
    tx()
    return { updated }
  } catch (error) {
    log.error('[sqlite] mixtape item stem state upsert failed', error)
    return { updated: 0 }
  }
}

export function resetMixtapeStemSessionState(): {
  assetsDeleted: number
  itemsReset: number
} {
  const db = getLibraryDb()
  if (!db) return { assetsDeleted: 0, itemsReset: 0 }
  try {
    return db.transaction(() => {
      const assetsDeleted =
        Number(db.prepare(`DELETE FROM ${STEM_ASSET_TABLE}`).run().changes || 0) +
        Number(db.prepare(`DELETE FROM ${LEGACY_STEM_ASSET_TABLE}`).run().changes || 0)
      db.prepare(`DELETE FROM ${STEM_WAVEFORM_CACHE_TABLE}`).run()
      const rows = db
        .prepare(
          `SELECT i.id, i.info_json
           FROM ${ITEM_TABLE} i
           INNER JOIN mixtape_projects p ON p.playlist_uuid = i.playlist_uuid
           WHERE p.mix_mode = 'stem'`
        )
        .all() as Array<{ id?: string | null; info_json?: string | null }>
      const updateStmt = db.prepare(`UPDATE ${ITEM_TABLE} SET info_json = ? WHERE id = ?`)
      const now = Date.now()
      let itemsReset = 0
      for (const row of rows) {
        const itemId = normalizeText(row?.id, 80)
        if (!itemId) continue
        const info = parseInfoJson(row?.info_json)
        info.stemStatus = 'idle'
        delete info.stemError
        delete info.stemReadyAt
        delete info.stemModel
        delete info.stemVersion
        delete info.stemVocalPath
        delete info.stemInstPath
        delete info.stemBassPath
        delete info.stemDrumsPath
        info.stemUpdatedAt = now
        updateStmt.run(JSON.stringify(info), itemId)
        itemsReset += 1
      }
      return { assetsDeleted, itemsReset }
    })()
  } catch (error) {
    log.error('[sqlite] reset mixtape stem session state failed', { error })
    return { assetsDeleted: 0, itemsReset: 0 }
  }
}

export function listMixtapeTrackStemStatusByPlaylist(
  playlistUuid: string
): MixtapeTrackStemStatusRecord[] {
  const normalizedPlaylistUuid = normalizeText(playlistUuid, 80)
  if (!normalizedPlaylistUuid) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(`SELECT id, file_path, info_json FROM ${ITEM_TABLE} WHERE playlist_uuid = ?`)
      .all(normalizedPlaylistUuid) as Array<{
      id: string
      file_path: string
      info_json?: string | null
    }>
    return rows.map((row) => {
      const info = parseInfoJson(row?.info_json)
      const stemReadyAt = normalizeTimestampMs(info?.stemReadyAt)
      const stemModel = normalizeText(info?.stemModel, 128)
      const stemVersion = normalizeText(info?.stemVersion, 128)
      const stemError = normalizeText(info?.stemError, 1200)
      return {
        itemId: normalizeText(row?.id, 80),
        filePath: normalizeFilePath(row?.file_path),
        stemStatus: resolveMixtapeStemStatusFromInfo(row?.info_json),
        stemError: stemError || null,
        stemReadyAt: stemReadyAt ?? null,
        stemModel: stemModel || null,
        stemVersion: stemVersion || null
      }
    })
  } catch (error) {
    log.error('[sqlite] mixtape stem status list failed', {
      playlistUuid: normalizedPlaylistUuid,
      error
    })
    return []
  }
}

export function summarizeMixtapeStemStatusByPlaylist(playlistUuid: string): MixtapeStemSummary {
  const normalizedPlaylistUuid = normalizeText(playlistUuid, 80)
  const summary: MixtapeStemSummary = { ...DEFAULT_STEM_SUMMARY }
  if (!normalizedPlaylistUuid) return summary
  const db = getLibraryDb()
  if (!db) return summary
  try {
    const rows = db
      .prepare(`SELECT info_json FROM ${ITEM_TABLE} WHERE playlist_uuid = ?`)
      .all(normalizedPlaylistUuid) as Array<{ info_json?: string | null }>
    for (const row of rows) {
      const status = resolveMixtapeStemStatusFromInfo(row?.info_json)
      summary[status] += 1
    }
    return summary
  } catch (error) {
    log.error('[sqlite] mixtape stem summary failed', {
      playlistUuid: normalizedPlaylistUuid,
      error
    })
    return summary
  }
}
