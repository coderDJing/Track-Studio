import {
  WAVEFORM_GLOBAL_OVERVIEW_RATE,
  WAVEFORM_GLOBAL_OVERVIEW_PARAMETER_VERSION,
  WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION,
  WAVEFORM_SURFACE_CACHE_VERSION,
  type WaveformGlobalOverviewData,
  type WaveformListPreviewData,
  type WaveformSurfaceCacheData,
  type WaveformSurfaceData,
  type WaveformSurfaceKind
} from '../../shared/waveformSurfaceCache'
import { getLibraryDb, isSqliteRow, type SqliteDatabase } from '../libraryDb'
import { log } from '../log'
import {
  resolveAbsoluteListRoot,
  resolveFilePathInput,
  resolveListRootInput,
  toNumber
} from './pathResolvers'

type WaveformSurfaceMeta = {
  size: number
  mtimeMs: number
  cacheVersion: number
  listPreviewParameterVersion: number
  globalOverviewParameterVersion: number
  duration: number
  sampleRate: number
  listPreviewFrameCount: number
  globalOverviewFrameCount: number
}

type WaveformSurfaceRow = {
  list_root?: string
  file_path?: string
  size?: unknown
  mtime_ms?: unknown
  cache_version?: unknown
  list_preview_parameter_version?: unknown
  global_overview_parameter_version?: unknown
  duration?: unknown
  sample_rate?: unknown
  list_preview_frame_count?: unknown
  global_overview_frame_count?: unknown
  list_preview_payload?: unknown
  global_overview_payload?: unknown
  list_preview_payload_bytes?: unknown
  global_overview_payload_bytes?: unknown
}

const TABLE = 'waveform_surface_cache'
const SURFACE_ARRAY_COUNT = 12

const normalizeMeta = (row: unknown): WaveformSurfaceMeta | null => {
  if (!isSqliteRow(row)) return null
  const size = toNumber(row.size)
  const mtimeMs = toNumber(row.mtime_ms)
  const cacheVersion = toNumber(row.cache_version)
  const listPreviewParameterVersion = toNumber(row.list_preview_parameter_version)
  const globalOverviewParameterVersion = toNumber(row.global_overview_parameter_version)
  const duration = toNumber(row.duration)
  const sampleRate = toNumber(row.sample_rate)
  const listPreviewFrameCount = toNumber(row.list_preview_frame_count)
  const globalOverviewFrameCount = toNumber(row.global_overview_frame_count)
  if (
    size === null ||
    mtimeMs === null ||
    cacheVersion === null ||
    listPreviewParameterVersion === null ||
    globalOverviewParameterVersion === null ||
    duration === null ||
    sampleRate === null ||
    listPreviewFrameCount === null ||
    globalOverviewFrameCount === null
  ) {
    return null
  }
  return {
    size,
    mtimeMs,
    cacheVersion,
    listPreviewParameterVersion,
    globalOverviewParameterVersion,
    duration,
    sampleRate,
    listPreviewFrameCount,
    globalOverviewFrameCount
  }
}

const toBuffer = (value: unknown): Buffer | null => {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return null
}

const getSurfaceParameterVersion = (kind: WaveformSurfaceKind) =>
  kind === 'listPreview'
    ? WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION
    : WAVEFORM_GLOBAL_OVERVIEW_PARAMETER_VERSION

const getSurfaceFrameCount = (meta: WaveformSurfaceMeta, kind: WaveformSurfaceKind) =>
  kind === 'listPreview' ? meta.listPreviewFrameCount : meta.globalOverviewFrameCount

const getSurfacePayload = (row: WaveformSurfaceRow, kind: WaveformSurfaceKind) =>
  toBuffer(kind === 'listPreview' ? row.list_preview_payload : row.global_overview_payload)

const getSurfacePayloadByteLength = (row: WaveformSurfaceRow, kind: WaveformSurfaceKind) => {
  const payload = getSurfacePayload(row, kind)
  if (payload) return payload.byteLength
  const value =
    kind === 'listPreview' ? row.list_preview_payload_bytes : row.global_overview_payload_bytes
  return toNumber(value) ?? 0
}

const getSurfaceArrays = (data: WaveformSurfaceData): Uint8Array[] => [
  data.detailPeakTop,
  data.detailPeakBottom,
  data.detailBody,
  data.colorIndex,
  data.colorLow,
  data.colorMid,
  data.colorHigh,
  data.colorRed,
  data.colorGreen,
  data.colorBlue,
  data.overviewTop,
  data.overviewBottom
]

function encodeWaveformSurfacePayload(data: WaveformSurfaceData): Buffer | null {
  if (!data || data.version !== WAVEFORM_SURFACE_CACHE_VERSION) return null
  if (data.parameterVersion !== getSurfaceParameterVersion(data.surfaceKind)) return null
  const arrays = getSurfaceArrays(data)
  const frameCount = arrays.reduce((min, value) => Math.min(min, value?.length || 0), Infinity)
  if (!Number.isFinite(frameCount) || frameCount <= 0) return null
  if (arrays.some((value) => !value?.length || value.length !== frameCount)) return null
  return Buffer.concat(arrays.map((value) => Buffer.from(value)))
}

function decodeWaveformSurfacePayload(
  meta: WaveformSurfaceMeta,
  kind: WaveformSurfaceKind,
  payload: Buffer
): WaveformSurfaceData | null {
  if (!meta || !payload) return null
  if (
    meta.cacheVersion !== WAVEFORM_SURFACE_CACHE_VERSION ||
    !Number.isFinite(meta.listPreviewParameterVersion) ||
    meta.listPreviewParameterVersion <= 0 ||
    !Number.isFinite(meta.globalOverviewParameterVersion) ||
    meta.globalOverviewParameterVersion <= 0
  ) {
    return null
  }
  const frameCount = getSurfaceFrameCount(meta, kind)
  if (!frameCount || payload.byteLength < frameCount * SURFACE_ARRAY_COUNT) return null
  let offset = 0
  const readBytes = () => {
    const result = new Uint8Array(payload.subarray(offset, offset + frameCount))
    offset += frameCount
    return result
  }
  const detailRate = frameCount / Math.max(0.0001, meta.duration)
  const base = {
    version: WAVEFORM_SURFACE_CACHE_VERSION,
    parameterVersion:
      kind === 'listPreview'
        ? meta.listPreviewParameterVersion
        : meta.globalOverviewParameterVersion,
    duration: meta.duration,
    sampleRate: meta.sampleRate,
    detailRate,
    overviewRate: kind === 'globalOverview' ? WAVEFORM_GLOBAL_OVERVIEW_RATE : detailRate,
    bodyRateDivisor: 1,
    colorRateDivisor: 1,
    detailPeakTop: readBytes(),
    detailPeakBottom: readBytes(),
    detailBody: readBytes(),
    colorIndex: readBytes(),
    colorLow: readBytes(),
    colorMid: readBytes(),
    colorHigh: readBytes(),
    colorRed: readBytes(),
    colorGreen: readBytes(),
    colorBlue: readBytes(),
    overviewTop: readBytes(),
    overviewBottom: readBytes()
  }
  if (kind === 'listPreview') {
    return { ...base, surfaceKind: 'listPreview' } satisfies WaveformListPreviewData
  }
  return { ...base, surfaceKind: 'globalOverview' } satisfies WaveformGlobalOverviewData
}

const resolveCacheKeys = (listRoot: string, filePath: string) => {
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return null
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return null
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  return {
    listRootKey,
    fileKey: resolvedFile.key,
    fileKeyRaw: resolvedFile.keyRaw,
    legacyListRoot,
    legacyFilePath: resolvedFile.legacyAbs
  }
}

const resolveCacheCandidates = (listRoot: string, filePath: string) => {
  const keys = resolveCacheKeys(listRoot, filePath)
  if (!keys) return null
  return [
    [keys.listRootKey, keys.fileKey],
    [keys.listRootKey, keys.fileKeyRaw],
    [keys.legacyListRoot || '', keys.legacyFilePath]
  ] satisfies Array<[string, string | undefined]>
}

const loadRow = (
  listRoot: string,
  filePath: string
): { row: WaveformSurfaceRow; hitListRoot: string; hitFilePath: string } | null => {
  const db = getLibraryDb()
  const candidates = resolveCacheCandidates(listRoot, filePath)
  if (!db || !candidates) return null
  const stmt = db.prepare<WaveformSurfaceRow>(
    `SELECT list_root, file_path, size, mtime_ms, cache_version,
            list_preview_parameter_version, global_overview_parameter_version,
            duration, sample_rate, list_preview_frame_count, global_overview_frame_count,
            list_preview_payload, global_overview_payload
       FROM ${TABLE} WHERE list_root = ? AND file_path = ? LIMIT 1`
  )
  for (const [root, file] of candidates) {
    if (!root || !file) continue
    const row = stmt.get(root, file)
    if (row?.list_preview_payload !== undefined || row?.global_overview_payload !== undefined) {
      return { row, hitListRoot: root, hitFilePath: file }
    }
  }
  return null
}

const loadMetaRow = (listRoot: string, filePath: string): WaveformSurfaceRow | null => {
  const db = getLibraryDb()
  const candidates = resolveCacheCandidates(listRoot, filePath)
  if (!db || !candidates) return null
  const stmt = db.prepare<WaveformSurfaceRow>(
    `SELECT size, mtime_ms, cache_version,
            list_preview_parameter_version, global_overview_parameter_version,
            duration, sample_rate, list_preview_frame_count, global_overview_frame_count,
            length(list_preview_payload) AS list_preview_payload_bytes,
            length(global_overview_payload) AS global_overview_payload_bytes
       FROM ${TABLE} WHERE list_root = ? AND file_path = ? LIMIT 1`
  )
  for (const [root, file] of candidates) {
    if (!root || !file) continue
    const row = stmt.get(root, file)
    if (row?.size !== undefined) return row
  }
  return null
}

const loadSurfacePayloadRow = (
  listRoot: string,
  filePath: string,
  kind: WaveformSurfaceKind
): WaveformSurfaceRow | null => {
  const db = getLibraryDb()
  const candidates = resolveCacheCandidates(listRoot, filePath)
  if (!db || !candidates) return null
  const payloadSelect =
    kind === 'listPreview'
      ? `list_preview_payload,
         length(global_overview_payload) AS global_overview_payload_bytes`
      : `length(list_preview_payload) AS list_preview_payload_bytes,
         global_overview_payload`
  const stmt = db.prepare<WaveformSurfaceRow>(
    `SELECT size, mtime_ms, cache_version,
            list_preview_parameter_version, global_overview_parameter_version,
            duration, sample_rate, list_preview_frame_count, global_overview_frame_count,
            ${payloadSelect}
       FROM ${TABLE} WHERE list_root = ? AND file_path = ? LIMIT 1`
  )
  for (const [root, file] of candidates) {
    if (!root || !file) continue
    const row = stmt.get(root, file)
    if (row?.size !== undefined) return row
  }
  return null
}

export function migrateWaveformSurfaceCacheRows(
  db: SqliteDatabase,
  oldListRoot: string,
  newListRootKey: string,
  listRootAbs: string
): number {
  try {
    const rows = db
      .prepare<WaveformSurfaceRow>(`SELECT file_path FROM ${TABLE} WHERE list_root = ?`)
      .all(oldListRoot)
    if (!rows || rows.length === 0) return 0
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE list_root = ? AND file_path = ?`)
    const update = db.prepare(
      `UPDATE ${TABLE} SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?`
    )
    let moved = 0
    const run = db.transaction(() => {
      for (const row of rows) {
        const filePath = row?.file_path ? String(row.file_path) : ''
        if (!filePath) continue
        const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
        if (!resolvedFile) continue
        del.run(newListRootKey, resolvedFile.key)
        const result = update.run(newListRootKey, resolvedFile.key, oldListRoot, filePath)
        moved += result?.changes ? Number(result.changes) : 0
      }
    })
    run()
    return moved
  } catch {
    return 0
  }
}

const isMetaMatch = (meta: WaveformSurfaceMeta | null, stat: { size: number; mtimeMs: number }) =>
  Boolean(
    meta &&
    meta.size === stat.size &&
    Math.abs(meta.mtimeMs - stat.mtimeMs) <= 1 &&
    meta.cacheVersion === WAVEFORM_SURFACE_CACHE_VERSION &&
    Number.isFinite(meta.listPreviewParameterVersion) &&
    meta.listPreviewParameterVersion > 0 &&
    Number.isFinite(meta.globalOverviewParameterVersion) &&
    meta.globalOverviewParameterVersion > 0 &&
    meta.duration > 0 &&
    meta.sampleRate > 0 &&
    meta.listPreviewFrameCount > 0 &&
    meta.globalOverviewFrameCount > 0
  )

const hasValidPayloads = (row: WaveformSurfaceRow, meta: WaveformSurfaceMeta) => {
  const listPayloadBytes = getSurfacePayloadByteLength(row, 'listPreview')
  const globalPayloadBytes = getSurfacePayloadByteLength(row, 'globalOverview')
  return Boolean(
    listPayloadBytes >= meta.listPreviewFrameCount * SURFACE_ARRAY_COUNT &&
    globalPayloadBytes >= meta.globalOverviewFrameCount * SURFACE_ARRAY_COUNT
  )
}

async function loadWaveformSurfaceByKind(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number },
  kind: 'listPreview'
): Promise<WaveformListPreviewData | null | undefined>
async function loadWaveformSurfaceByKind(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number },
  kind: 'globalOverview'
): Promise<WaveformGlobalOverviewData | null | undefined>
async function loadWaveformSurfaceByKind(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number },
  kind: WaveformSurfaceKind
): Promise<WaveformSurfaceData | null | undefined> {
  if (!listRoot || !filePath) return undefined
  try {
    const row = loadSurfacePayloadRow(listRoot, filePath, kind)
    if (!row) return null
    const meta = normalizeMeta(row)
    if (!isMetaMatch(meta, stat)) {
      await removeWaveformSurfaceCacheEntry(listRoot, filePath)
      return null
    }
    const payload = getSurfacePayload(row, kind)
    if (!payload || !hasValidPayloads(row, meta!)) {
      await removeWaveformSurfaceCacheEntry(listRoot, filePath)
      return null
    }
    const decoded = decodeWaveformSurfacePayload(meta!, kind, payload)
    if (!decoded) {
      await removeWaveformSurfaceCacheEntry(listRoot, filePath)
      return null
    }
    return decoded
  } catch (error) {
    log.error('[sqlite] waveform surface cache load failed', error)
    return undefined
  }
}

export const loadWaveformListPreviewCacheData = (
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
) => loadWaveformSurfaceByKind(listRoot, filePath, stat, 'listPreview')

export const loadWaveformGlobalOverviewCacheData = (
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
) => loadWaveformSurfaceByKind(listRoot, filePath, stat, 'globalOverview')

export async function hasWaveformSurfaceCacheEntryByMeta(
  listRoot: string,
  filePath: string,
  size: number,
  mtimeMs: number
): Promise<boolean> {
  if (!listRoot || !filePath) return false
  try {
    const row = loadMetaRow(listRoot, filePath)
    if (!row) return false
    const meta = normalizeMeta(row)
    if (!isMetaMatch(meta, { size, mtimeMs }) || !hasValidPayloads(row, meta!)) {
      await removeWaveformSurfaceCacheEntry(listRoot, filePath)
      return false
    }
    return true
  } catch (error) {
    log.error('[sqlite] waveform surface cache check failed', error)
    return false
  }
}

export function loadWaveformSurfaceAvailabilityByMeta(
  listRoot: string,
  entries: Array<{ filePath: string; size: number; mtimeMs: number }>
): Map<string, boolean> {
  const result = new Map<string, boolean>()
  const db = getLibraryDb()
  if (!db || !listRoot || !Array.isArray(entries) || entries.length === 0) return result

  const filesByRoot = new Map<string, Set<string>>()
  for (const entry of entries) {
    const candidates = resolveCacheCandidates(listRoot, String(entry?.filePath || '').trim())
    if (!candidates) continue
    for (const [root, file] of candidates) {
      if (!root || !file) continue
      const files = filesByRoot.get(root)
      if (files) files.add(file)
      else filesByRoot.set(root, new Set([file]))
    }
  }

  const rowByRootFile = new Map<string, WaveformSurfaceRow>()
  const maxFilesPerQuery = 400
  for (const [root, fileSet] of filesByRoot) {
    const files = [...fileSet]
    for (let offset = 0; offset < files.length; offset += maxFilesPerQuery) {
      const chunk = files.slice(offset, offset + maxFilesPerQuery)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = db
        .prepare<WaveformSurfaceRow>(
          `SELECT list_root, file_path, size, mtime_ms, cache_version,
                  list_preview_parameter_version, global_overview_parameter_version,
                  duration, sample_rate, list_preview_frame_count, global_overview_frame_count,
                  length(list_preview_payload) AS list_preview_payload_bytes,
                  length(global_overview_payload) AS global_overview_payload_bytes
             FROM ${TABLE} WHERE list_root = ? AND file_path IN (${placeholders})`
        )
        .all(root, ...chunk)
      for (const row of rows) {
        const cachedFilePath = String(row?.file_path || '').trim()
        if (!cachedFilePath) continue
        rowByRootFile.set(`${root}\0${cachedFilePath}`, row)
      }
    }
  }

  for (const entry of entries) {
    const filePath = String(entry?.filePath || '').trim()
    if (!filePath) continue
    const candidates = resolveCacheCandidates(listRoot, filePath)
    let available = false
    if (candidates) {
      for (const [root, file] of candidates) {
        if (!root || !file) continue
        const row = rowByRootFile.get(`${root}\0${file}`)
        if (!row) continue
        const meta = normalizeMeta(row)
        available = Boolean(
          isMetaMatch(meta, { size: entry.size, mtimeMs: entry.mtimeMs }) &&
          hasValidPayloads(row, meta!)
        )
        break
      }
    }
    result.set(filePath, available)
  }
  return result
}

export async function upsertWaveformSurfaceCacheEntry(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number },
  data: WaveformSurfaceCacheData
): Promise<boolean> {
  const db = getLibraryDb()
  const keys = resolveCacheKeys(listRoot, filePath)
  if (!db || !keys || !data) return false
  const listPreviewPayload = encodeWaveformSurfacePayload(data.listPreview)
  const globalOverviewPayload = encodeWaveformSurfacePayload(data.globalOverview)
  if (!listPreviewPayload || !globalOverviewPayload) return false
  try {
    const upsertMain = db.prepare(
      `INSERT INTO ${TABLE} (
        list_root, file_path, size, mtime_ms, cache_version,
        list_preview_parameter_version, global_overview_parameter_version,
        duration, sample_rate, list_preview_frame_count, global_overview_frame_count,
        list_preview_payload, global_overview_payload, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(list_root, file_path) DO UPDATE SET
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        cache_version = excluded.cache_version,
        list_preview_parameter_version = excluded.list_preview_parameter_version,
        global_overview_parameter_version = excluded.global_overview_parameter_version,
        duration = excluded.duration,
        sample_rate = excluded.sample_rate,
        list_preview_frame_count = excluded.list_preview_frame_count,
        global_overview_frame_count = excluded.global_overview_frame_count,
        list_preview_payload = excluded.list_preview_payload,
        global_overview_payload = excluded.global_overview_payload,
        updated_at_ms = excluded.updated_at_ms`
    )
    const deleteMain = db.prepare(`DELETE FROM ${TABLE} WHERE list_root = ? AND file_path = ?`)
    db.transaction(() => {
      upsertMain.run(
        keys.listRootKey,
        keys.fileKey,
        stat.size,
        stat.mtimeMs,
        WAVEFORM_SURFACE_CACHE_VERSION,
        WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION,
        WAVEFORM_GLOBAL_OVERVIEW_PARAMETER_VERSION,
        data.globalOverview.duration,
        data.globalOverview.sampleRate,
        data.listPreview.detailPeakTop.length,
        data.globalOverview.detailPeakTop.length,
        listPreviewPayload,
        globalOverviewPayload,
        Date.now()
      )
      if (keys.fileKeyRaw && keys.fileKeyRaw !== keys.fileKey) {
        deleteMain.run(keys.listRootKey, keys.fileKeyRaw)
      }
      if (keys.legacyListRoot && keys.legacyFilePath) {
        deleteMain.run(keys.legacyListRoot, keys.legacyFilePath)
      }
    })()
    return true
  } catch (error) {
    log.error('[sqlite] waveform surface cache upsert failed', error)
    return false
  }
}

export async function updateWaveformSurfaceCacheStat(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
): Promise<boolean> {
  const db = getLibraryDb()
  const keys = resolveCacheKeys(listRoot, filePath)
  if (!db || !keys) return false
  try {
    const update = db.prepare(
      `UPDATE ${TABLE} SET size = ?, mtime_ms = ? WHERE list_root = ? AND file_path = ?`
    )
    update.run(stat.size, stat.mtimeMs, keys.listRootKey, keys.fileKey)
    if (keys.fileKeyRaw) update.run(stat.size, stat.mtimeMs, keys.listRootKey, keys.fileKeyRaw)
    if (keys.legacyListRoot && keys.legacyFilePath) {
      update.run(stat.size, stat.mtimeMs, keys.legacyListRoot, keys.legacyFilePath)
    }
    return true
  } catch (error) {
    log.error('[sqlite] waveform surface cache stat update failed', error)
    return false
  }
}

export async function moveWaveformSurfaceCacheEntry(
  listRoot: string,
  oldFilePath: string,
  newFilePath: string,
  stat?: { size: number; mtimeMs: number }
): Promise<boolean> {
  const db = getLibraryDb()
  const oldKeys = resolveCacheKeys(listRoot, oldFilePath)
  const newKeys = resolveCacheKeys(listRoot, newFilePath)
  if (!db || !oldKeys || !newKeys || oldFilePath === newFilePath) return false
  try {
    const hit = loadRow(listRoot, oldFilePath)
    if (!hit) return false
    const meta = normalizeMeta(hit.row)
    const listPreviewPayload = toBuffer(hit.row.list_preview_payload)
    const globalOverviewPayload = toBuffer(hit.row.global_overview_payload)
    if (!meta || !listPreviewPayload || !globalOverviewPayload) return false
    db.prepare(
      `INSERT INTO ${TABLE} (
        list_root, file_path, size, mtime_ms, cache_version,
        list_preview_parameter_version, global_overview_parameter_version,
        duration, sample_rate, list_preview_frame_count, global_overview_frame_count,
        list_preview_payload, global_overview_payload, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(list_root, file_path) DO UPDATE SET
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        cache_version = excluded.cache_version,
        list_preview_parameter_version = excluded.list_preview_parameter_version,
        global_overview_parameter_version = excluded.global_overview_parameter_version,
        duration = excluded.duration,
        sample_rate = excluded.sample_rate,
        list_preview_frame_count = excluded.list_preview_frame_count,
        global_overview_frame_count = excluded.global_overview_frame_count,
        list_preview_payload = excluded.list_preview_payload,
        global_overview_payload = excluded.global_overview_payload,
        updated_at_ms = excluded.updated_at_ms`
    ).run(
      newKeys.listRootKey,
      newKeys.fileKey,
      stat?.size ?? meta.size,
      stat?.mtimeMs ?? meta.mtimeMs,
      meta.cacheVersion,
      meta.listPreviewParameterVersion,
      meta.globalOverviewParameterVersion,
      meta.duration,
      meta.sampleRate,
      meta.listPreviewFrameCount,
      meta.globalOverviewFrameCount,
      listPreviewPayload,
      globalOverviewPayload,
      Date.now()
    )
    db.prepare(`DELETE FROM ${TABLE} WHERE list_root = ? AND file_path = ?`).run(
      hit.hitListRoot,
      hit.hitFilePath
    )
    return true
  } catch (error) {
    log.error('[sqlite] waveform surface cache move failed', error)
    return false
  }
}

export async function removeWaveformSurfaceCacheEntry(
  listRoot: string,
  filePath: string
): Promise<boolean> {
  const db = getLibraryDb()
  const keys = resolveCacheKeys(listRoot, filePath)
  if (!db || !keys) return false
  try {
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE list_root = ? AND file_path = ?`)
    del.run(keys.listRootKey, keys.fileKey)
    if (keys.fileKeyRaw) {
      del.run(keys.listRootKey, keys.fileKeyRaw)
    }
    if (keys.legacyListRoot && keys.legacyFilePath) {
      del.run(keys.legacyListRoot, keys.legacyFilePath)
    }
    return true
  } catch (error) {
    log.error('[sqlite] waveform surface cache delete failed', error)
    return false
  }
}
