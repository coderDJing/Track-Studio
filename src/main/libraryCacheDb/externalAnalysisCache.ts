import path = require('path')
import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import {
  decodeMixxxWaveformData,
  encodeMixxxWaveformData,
  MIXXX_WAVEFORM_CACHE_VERSION,
  type MixxxWaveformData
} from '../waveformCodec'
import type { ISongInfo } from '../../types/globals'
import { stripBeatThisDebugInfo } from './pathResolvers'

const EXTERNAL_ANALYSIS_DEVICE_TABLE = 'external_analysis_devices'
const EXTERNAL_ANALYSIS_CACHE_TABLE = 'external_analysis_cache'
const EXTERNAL_ANALYSIS_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000

export type ExternalAnalysisSourceKind = 'rekordbox-usb' | 'rekordbox-desktop' | 'external-playback'

export type ExternalAnalysisContext = {
  sourceKind: ExternalAnalysisSourceKind
  sourceId: string
  rootPath: string
  relativePath: string
  filePath: string
}

export type ExternalAnalysisActiveEntry = Pick<ExternalAnalysisContext, 'relativePath' | 'filePath'>

const rowToWaveformData = (row: ExternalAnalysisCacheRow | undefined | null) => {
  if (!row) return null
  const version = toNumber(row.waveform_version)
  const sampleRate = toNumber(row.waveform_sample_rate)
  const step = toNumber(row.waveform_step)
  const duration = toNumber(row.waveform_duration)
  const frames = toNumber(row.waveform_frames)
  const payload = row.waveform_data
  if (
    version !== MIXXX_WAVEFORM_CACHE_VERSION ||
    sampleRate === null ||
    step === null ||
    duration === null ||
    frames === null ||
    frames <= 0 ||
    !Buffer.isBuffer(payload)
  ) {
    return null
  }
  return decodeMixxxWaveformData({ sampleRate, step, duration, frames }, payload)
}

export type ExternalAnalysisCacheEntry = {
  sourceKind: ExternalAnalysisSourceKind
  sourceId: string
  relativePath: string
  filePath: string
  size: number
  mtimeMs: number
  info: ISongInfo
  hasWaveform: boolean
  lastSeenAtMs: number
  updatedAtMs: number
}

type ExternalAnalysisCacheRow = {
  source_kind?: unknown
  source_id?: unknown
  relative_path?: unknown
  file_path?: unknown
  size?: unknown
  mtime_ms?: unknown
  info_json?: unknown
  waveform_version?: unknown
  waveform_sample_rate?: unknown
  waveform_step?: unknown
  waveform_duration?: unknown
  waveform_frames?: unknown
  waveform_data?: unknown
  last_seen_at_ms?: unknown
  updated_at_ms?: unknown
}

const registeredContextByPath = new Map<string, ExternalAnalysisContext>()

const normalizePathKey = (value: unknown) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const normalized = path.resolve(raw)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const normalizeRelativePathKey = (value: unknown) => {
  const raw = String(value || '')
    .trim()
    .replace(/^[/\\]+/, '')
  if (!raw) return ''
  const normalized = path.normalize(raw).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const normalizeSourceId = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()

const normalizeSourceKind = (value: unknown): ExternalAnalysisSourceKind | '' =>
  value === 'rekordbox-usb' || value === 'rekordbox-desktop' || value === 'external-playback'
    ? value
    : ''

const toExternalSongSourceKind = (value: ExternalAnalysisSourceKind) =>
  value === 'rekordbox-desktop' ? 'desktop' : value === 'rekordbox-usb' ? 'usb' : null

const toNumber = (value: unknown): number | null => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const parseInfoJson = (value: unknown): ISongInfo | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value) as ISongInfo
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const isSameStat = (
  entry: { size: number; mtimeMs: number } | null | undefined,
  stat: { size: number; mtimeMs: number } | null | undefined
) =>
  !!entry &&
  !!stat &&
  entry.size === stat.size &&
  Math.abs(Number(entry.mtimeMs) - Number(stat.mtimeMs)) < 1

const normalizeContext = (
  context: Partial<ExternalAnalysisContext> | null | undefined
): ExternalAnalysisContext | null => {
  const sourceKind = normalizeSourceKind(context?.sourceKind)
  const sourceId = normalizeSourceId(context?.sourceId)
  const rootPath = String(context?.rootPath || '').trim()
  const relativePath = normalizeRelativePathKey(context?.relativePath)
  const filePath = String(context?.filePath || '').trim()
  if (!sourceKind || !sourceId || !relativePath || !filePath) return null
  return {
    sourceKind,
    sourceId,
    rootPath,
    relativePath,
    filePath
  }
}

const rowToEntry = (row: ExternalAnalysisCacheRow | undefined | null) => {
  if (!row) return null
  const sourceKind = normalizeSourceKind(row.source_kind)
  const sourceId = normalizeSourceId(row.source_id)
  const relativePath = normalizeRelativePathKey(row.relative_path)
  const filePath = String(row.file_path || '').trim()
  const size = toNumber(row.size)
  const mtimeMs = toNumber(row.mtime_ms)
  const info = parseInfoJson(row.info_json)
  const lastSeenAtMs = toNumber(row.last_seen_at_ms) || 0
  const updatedAtMs = toNumber(row.updated_at_ms) || 0
  if (!sourceKind || !sourceId || !relativePath || !filePath || size === null || mtimeMs === null) {
    return null
  }
  if (!info) return null
  return {
    sourceKind,
    sourceId,
    relativePath,
    filePath,
    size,
    mtimeMs,
    info: {
      ...info,
      filePath
    },
    hasWaveform:
      toNumber(row.waveform_version) === MIXXX_WAVEFORM_CACHE_VERSION &&
      toNumber(row.waveform_frames) !== null &&
      Number(row.waveform_frames) > 0 &&
      row.waveform_data !== undefined &&
      row.waveform_data !== null,
    lastSeenAtMs,
    updatedAtMs
  } satisfies ExternalAnalysisCacheEntry
}

export function registerExternalAnalysisContext(
  context: Partial<ExternalAnalysisContext> | null | undefined
): ExternalAnalysisContext | null {
  const normalized = normalizeContext(context)
  if (!normalized) return null
  const pathKey = normalizePathKey(normalized.filePath)
  if (pathKey) {
    registeredContextByPath.set(pathKey, normalized)
  }
  return normalized
}

export function resolveExternalAnalysisContext(filePath: string): ExternalAnalysisContext | null {
  const pathKey = normalizePathKey(filePath)
  if (!pathKey) return null
  return registeredContextByPath.get(pathKey) || null
}

export function unregisterExternalAnalysisContexts(filePaths: string[] | string) {
  const list = Array.isArray(filePaths) ? filePaths : [filePaths]
  for (const filePath of list) {
    const key = normalizePathKey(filePath)
    if (key) registeredContextByPath.delete(key)
  }
}

export async function touchExternalAnalysisDevice(
  sourceKind: ExternalAnalysisSourceKind,
  sourceId: string,
  rootPath: string
) {
  const db = getLibraryDb()
  const normalizedKind = normalizeSourceKind(sourceKind)
  const normalizedId = normalizeSourceId(sourceId)
  if (!db || !normalizedKind || !normalizedId) return false
  try {
    const now = Date.now()
    db.prepare(
      `INSERT INTO ${EXTERNAL_ANALYSIS_DEVICE_TABLE}
       (source_kind, source_id, root_path, last_seen_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_kind, source_id) DO UPDATE SET
         root_path = excluded.root_path,
         last_seen_at_ms = excluded.last_seen_at_ms,
         updated_at_ms = excluded.updated_at_ms`
    ).run(normalizedKind, normalizedId, String(rootPath || '').trim() || null, now, now)
    return true
  } catch (error) {
    log.error('[sqlite] external analysis device touch failed', error)
    return false
  }
}

export async function pruneStaleExternalAnalysisDevices(now = Date.now()) {
  const db = getLibraryDb()
  if (!db) return 0
  try {
    const cutoff = now - EXTERNAL_ANALYSIS_CACHE_TTL_MS
    const rows = db
      .prepare<{ source_kind?: unknown; source_id?: unknown }>(
        `SELECT source_kind, source_id
         FROM ${EXTERNAL_ANALYSIS_DEVICE_TABLE}
         WHERE last_seen_at_ms < ?`
      )
      .all(cutoff)
    if (!rows.length) return 0
    const deleteCache = db.prepare(
      `DELETE FROM ${EXTERNAL_ANALYSIS_CACHE_TABLE} WHERE source_kind = ? AND source_id = ?`
    )
    const deleteDevice = db.prepare(
      `DELETE FROM ${EXTERNAL_ANALYSIS_DEVICE_TABLE} WHERE source_kind = ? AND source_id = ?`
    )
    const run = db.transaction(() => {
      for (const row of rows) {
        const kind = normalizeSourceKind(row.source_kind)
        const id = normalizeSourceId(row.source_id)
        if (!kind || !id) continue
        deleteCache.run(kind, id)
        deleteDevice.run(kind, id)
      }
    })
    run()
    return rows.length
  } catch (error) {
    log.error('[sqlite] external analysis stale device prune failed', error)
    return 0
  }
}

export async function pruneStaleExternalAnalysisCacheEntries(
  sourceKind: ExternalAnalysisSourceKind,
  sourceId: string,
  now = Date.now()
) {
  const db = getLibraryDb()
  const normalizedKind = normalizeSourceKind(sourceKind)
  const normalizedId = normalizeSourceId(sourceId)
  if (!db || !normalizedKind || !normalizedId) return 0
  try {
    const cutoff = now - EXTERNAL_ANALYSIS_CACHE_TTL_MS
    const rows = db
      .prepare<{ file_path?: unknown }>(
        `SELECT file_path
         FROM ${EXTERNAL_ANALYSIS_CACHE_TABLE}
         WHERE source_kind = ? AND source_id = ? AND last_seen_at_ms < ?`
      )
      .all(normalizedKind, normalizedId, cutoff)
    if (!rows.length) return 0
    db.prepare(
      `DELETE FROM ${EXTERNAL_ANALYSIS_CACHE_TABLE}
       WHERE source_kind = ? AND source_id = ? AND last_seen_at_ms < ?`
    ).run(normalizedKind, normalizedId, cutoff)
    unregisterExternalAnalysisContexts(
      rows.map((row) => String(row.file_path || '').trim()).filter(Boolean)
    )
    return rows.length
  } catch (error) {
    log.error('[sqlite] external analysis stale cache prune failed', error)
    return 0
  }
}

export async function reconcileExternalAnalysisCacheEntries(
  sourceKind: ExternalAnalysisSourceKind,
  sourceId: string,
  activeEntries: ExternalAnalysisActiveEntry[],
  now = Date.now()
) {
  const db = getLibraryDb()
  const normalizedKind = normalizeSourceKind(sourceKind)
  const normalizedId = normalizeSourceId(sourceId)
  if (!db || !normalizedKind || !normalizedId) return 0

  const activeByRelativePath = new Map<string, string>()
  for (const entry of activeEntries) {
    const relativePath = normalizeRelativePathKey(entry?.relativePath)
    const filePath = String(entry?.filePath || '').trim()
    if (relativePath && filePath) activeByRelativePath.set(relativePath, filePath)
  }

  try {
    const rows = db
      .prepare<{ relative_path?: unknown; file_path?: unknown }>(
        `SELECT relative_path, file_path
         FROM ${EXTERNAL_ANALYSIS_CACHE_TABLE}
         WHERE source_kind = ? AND source_id = ?`
      )
      .all(normalizedKind, normalizedId)
    const updateSeen = db.prepare(
      `UPDATE ${EXTERNAL_ANALYSIS_CACHE_TABLE}
       SET file_path = ?, last_seen_at_ms = ?
       WHERE source_kind = ? AND source_id = ? AND relative_path = ?`
    )
    const removeEntry = db.prepare(
      `DELETE FROM ${EXTERNAL_ANALYSIS_CACHE_TABLE}
       WHERE source_kind = ? AND source_id = ? AND relative_path = ?`
    )
    const removedFilePaths: string[] = []
    const run = db.transaction(() => {
      for (const row of rows) {
        const relativePath = normalizeRelativePathKey(row.relative_path)
        const activeFilePath = activeByRelativePath.get(relativePath)
        if (activeFilePath) {
          updateSeen.run(activeFilePath, now, normalizedKind, normalizedId, relativePath)
          continue
        }
        removeEntry.run(normalizedKind, normalizedId, relativePath)
        const filePath = String(row.file_path || '').trim()
        if (filePath) removedFilePaths.push(filePath)
      }
    })
    run()

    const activeRelativePaths = new Set(activeByRelativePath.keys())
    for (const [pathKey, context] of registeredContextByPath) {
      if (
        context.sourceKind === normalizedKind &&
        normalizeSourceId(context.sourceId) === normalizedId &&
        !activeRelativePaths.has(normalizeRelativePathKey(context.relativePath))
      ) {
        registeredContextByPath.delete(pathKey)
      }
    }
    return removedFilePaths.length
  } catch (error) {
    log.error('[sqlite] external analysis cache reconcile failed', error)
    return 0
  }
}

export async function loadExternalAnalysisCacheEntry(
  context: Partial<ExternalAnalysisContext> | null | undefined,
  stat?: { size: number; mtimeMs: number } | null
): Promise<ExternalAnalysisCacheEntry | null | undefined> {
  const db = getLibraryDb()
  const normalized = normalizeContext(context)
  if (!db || !normalized) return undefined
  try {
    const row = db
      .prepare<ExternalAnalysisCacheRow>(
        `SELECT source_kind, source_id, relative_path, file_path, size, mtime_ms, info_json,
                waveform_version, waveform_sample_rate, waveform_step, waveform_duration,
                waveform_frames, waveform_data, last_seen_at_ms, updated_at_ms
         FROM ${EXTERNAL_ANALYSIS_CACHE_TABLE}
         WHERE source_kind = ? AND source_id = ? AND relative_path = ?`
      )
      .get(normalized.sourceKind, normalized.sourceId, normalized.relativePath)
    const entry = rowToEntry(row)
    if (!entry) return null
    if (stat && !isSameStat(entry, stat)) {
      await removeExternalAnalysisCacheEntry(normalized)
      return null
    }
    return {
      ...entry,
      filePath: normalized.filePath,
      info: {
        ...entry.info,
        filePath: normalized.filePath
      }
    }
  } catch (error) {
    log.error('[sqlite] external analysis cache load failed', error)
    return undefined
  }
}

export async function loadExternalAnalysisCacheEntryByFilePath(
  filePath: string,
  stat?: { size: number; mtimeMs: number } | null
): Promise<ExternalAnalysisCacheEntry | null | undefined> {
  const context = resolveExternalAnalysisContext(filePath)
  if (context) {
    return loadExternalAnalysisCacheEntry(context, stat)
  }

  const db = getLibraryDb()
  const normalizedFilePath = String(filePath || '').trim()
  if (!db || !normalizedFilePath) return undefined
  try {
    const row = db
      .prepare<ExternalAnalysisCacheRow>(
        `SELECT source_kind, source_id, relative_path, file_path, size, mtime_ms, info_json,
                waveform_version, waveform_sample_rate, waveform_step, waveform_duration,
                waveform_frames, waveform_data, last_seen_at_ms, updated_at_ms
         FROM ${EXTERNAL_ANALYSIS_CACHE_TABLE}
         WHERE file_path = ?
         ORDER BY updated_at_ms DESC
         LIMIT 1`
      )
      .get(normalizedFilePath)
    const entry = rowToEntry(row)
    if (!entry) return null
    if (stat && !isSameStat(entry, stat)) return null
    registerExternalAnalysisContext({
      sourceKind: entry.sourceKind,
      sourceId: entry.sourceId,
      rootPath: '',
      relativePath: entry.relativePath,
      filePath: normalizedFilePath
    })
    return {
      ...entry,
      filePath: normalizedFilePath,
      info: {
        ...entry.info,
        filePath: normalizedFilePath
      }
    }
  } catch (error) {
    log.error('[sqlite] external analysis cache load by file failed', error)
    return undefined
  }
}

export async function loadExternalAnalysisWaveformCacheDataByFilePath(
  filePath: string,
  stat?: { size: number; mtimeMs: number } | null
): Promise<MixxxWaveformData | null | undefined> {
  const db = getLibraryDb()
  const normalizedFilePath = String(filePath || '').trim()
  if (!db || !normalizedFilePath) return undefined
  try {
    const context = resolveExternalAnalysisContext(normalizedFilePath)
    const row = context
      ? db
          .prepare<ExternalAnalysisCacheRow>(
            `SELECT size, mtime_ms, waveform_version, waveform_sample_rate, waveform_step,
                    waveform_duration, waveform_frames, waveform_data
             FROM ${EXTERNAL_ANALYSIS_CACHE_TABLE}
             WHERE source_kind = ? AND source_id = ? AND relative_path = ?`
          )
          .get(context.sourceKind, context.sourceId, context.relativePath)
      : db
          .prepare<ExternalAnalysisCacheRow>(
            `SELECT size, mtime_ms, waveform_version, waveform_sample_rate, waveform_step,
                    waveform_duration, waveform_frames, waveform_data
             FROM ${EXTERNAL_ANALYSIS_CACHE_TABLE}
             WHERE file_path = ?
             ORDER BY updated_at_ms DESC
             LIMIT 1`
          )
          .get(normalizedFilePath)
    if (!row) return null
    const entryStat = { size: toNumber(row.size) || 0, mtimeMs: toNumber(row.mtime_ms) || 0 }
    if (stat && !isSameStat(entryStat, stat)) return null
    return rowToWaveformData(row)
  } catch (error) {
    log.error('[sqlite] external analysis waveform cache load failed', error)
    return undefined
  }
}

export async function touchExternalAnalysisCacheEntrySeen(
  context: Partial<ExternalAnalysisContext> | null | undefined,
  now = Date.now()
) {
  const db = getLibraryDb()
  const normalized = normalizeContext(context)
  if (!db || !normalized) return false
  try {
    const result = db
      .prepare(
        `UPDATE ${EXTERNAL_ANALYSIS_CACHE_TABLE}
       SET file_path = ?,
           last_seen_at_ms = ?
       WHERE source_kind = ? AND source_id = ? AND relative_path = ?`
      )
      .run(
        normalized.filePath,
        now,
        normalized.sourceKind,
        normalized.sourceId,
        normalized.relativePath
      )
    await touchExternalAnalysisDevice(
      normalized.sourceKind,
      normalized.sourceId,
      normalized.rootPath
    )
    return Number(result.changes || 0) > 0
  } catch (error) {
    log.error('[sqlite] external analysis cache seen touch failed', error)
    return false
  }
}

export async function upsertExternalAnalysisCacheEntry(
  context: Partial<ExternalAnalysisContext> | null | undefined,
  stat: { size: number; mtimeMs: number },
  info: ISongInfo
) {
  const db = getLibraryDb()
  const normalized = normalizeContext(context)
  if (!db || !normalized) return false
  if (!Number.isFinite(stat?.size) || !Number.isFinite(stat?.mtimeMs)) return false
  try {
    const now = Date.now()
    const externalSourceKind =
      info.externalSourceKind || toExternalSongSourceKind(normalized.sourceKind)
    const normalizedInfo = {
      ...info,
      filePath: normalized.filePath
    }
    if (externalSourceKind) {
      normalizedInfo.externalSourceKind = externalSourceKind
    }
    stripBeatThisDebugInfo(normalizedInfo)
    db.prepare(
      `INSERT INTO ${EXTERNAL_ANALYSIS_CACHE_TABLE}
       (source_kind, source_id, relative_path, file_path, size, mtime_ms, info_json,
        last_seen_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_kind, source_id, relative_path) DO UPDATE SET
         file_path = excluded.file_path,
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         info_json = excluded.info_json,
         last_seen_at_ms = CASE
           WHEN last_seen_at_ms IS NULL OR last_seen_at_ms <= 0
           THEN excluded.last_seen_at_ms
           ELSE last_seen_at_ms
         END,
         updated_at_ms = excluded.updated_at_ms`
    ).run(
      normalized.sourceKind,
      normalized.sourceId,
      normalized.relativePath,
      normalized.filePath,
      stat.size,
      stat.mtimeMs,
      JSON.stringify(normalizedInfo),
      now,
      now
    )
    await touchExternalAnalysisDevice(
      normalized.sourceKind,
      normalized.sourceId,
      normalized.rootPath
    )
    return true
  } catch (error) {
    log.error('[sqlite] external analysis cache upsert failed', error)
    return false
  }
}

export async function upsertExternalAnalysisWaveformCacheEntry(
  context: Partial<ExternalAnalysisContext> | null | undefined,
  stat: { size: number; mtimeMs: number },
  data: MixxxWaveformData
) {
  const db = getLibraryDb()
  const normalized = normalizeContext(context)
  if (!db || !normalized) return false
  if (!Number.isFinite(stat?.size) || !Number.isFinite(stat?.mtimeMs)) return false
  if (!Number.isFinite(data?.sampleRate) || data.sampleRate <= 0) return false
  if (!Number.isFinite(data?.step) || data.step <= 0) return false
  if (!Number.isFinite(data?.duration) || data.duration <= 0) return false
  const encoded = encodeMixxxWaveformData(data)
  if (!encoded) return false
  try {
    const existing = await loadExternalAnalysisCacheEntry(normalized, stat)
    const info =
      existing?.info ||
      ({
        filePath: normalized.filePath,
        fileName: path.basename(normalized.filePath),
        fileFormat: path.extname(normalized.filePath).replace(/^\./, '').toUpperCase(),
        cover: null,
        title: path.basename(normalized.filePath, path.extname(normalized.filePath)),
        artist: undefined,
        album: undefined,
        duration: '',
        genre: undefined,
        label: undefined,
        bitrate: undefined,
        container: path.extname(normalized.filePath).replace(/^\./, '').toUpperCase() || undefined,
        analysisOnly: true
      } satisfies ISongInfo)
    await upsertExternalAnalysisCacheEntry(normalized, stat, info)
    const now = Date.now()
    db.prepare(
      `UPDATE ${EXTERNAL_ANALYSIS_CACHE_TABLE}
       SET waveform_version = ?,
           waveform_sample_rate = ?,
           waveform_step = ?,
           waveform_duration = ?,
           waveform_frames = ?,
           waveform_data = ?,
           updated_at_ms = ?
       WHERE source_kind = ? AND source_id = ? AND relative_path = ?`
    ).run(
      MIXXX_WAVEFORM_CACHE_VERSION,
      data.sampleRate,
      data.step,
      data.duration,
      encoded.frames,
      encoded.payload,
      now,
      normalized.sourceKind,
      normalized.sourceId,
      normalized.relativePath
    )
    return true
  } catch (error) {
    log.error('[sqlite] external analysis waveform cache upsert failed', error)
    return false
  }
}

export async function removeExternalAnalysisCacheEntry(
  context: Partial<ExternalAnalysisContext> | null | undefined
) {
  const db = getLibraryDb()
  const normalized = normalizeContext(context)
  if (!db || !normalized) return false
  try {
    db.prepare(
      `DELETE FROM ${EXTERNAL_ANALYSIS_CACHE_TABLE}
       WHERE source_kind = ? AND source_id = ? AND relative_path = ?`
    ).run(normalized.sourceKind, normalized.sourceId, normalized.relativePath)
    unregisterExternalAnalysisContexts(normalized.filePath)
    return true
  } catch (error) {
    log.error('[sqlite] external analysis cache delete failed', error)
    return false
  }
}
