import { promisify } from 'node:util'
import { deflate, inflate } from 'node:zlib'
import {
  UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
  UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION,
  type UnifiedDisplayWaveformDetailData
} from '../../shared/unifiedDisplayWaveform'
import { getLibraryDb, isSqliteRow, type SqliteDatabase } from '../libraryDb'
import { log } from '../log'
import {
  resolveAbsoluteListRoot,
  resolveFilePathInput,
  resolveListRootInput,
  toNumber
} from './pathResolvers'

type UnifiedDisplayWaveformMeta = {
  size: number
  mtimeMs: number
  cacheVersion: number
  parameterVersion: number
  duration: number
  detailRate: number
  overviewRate: number
  frameCount: number
}

type UnifiedDisplayWaveformRow = {
  list_root?: string
  file_path?: string
  size?: unknown
  mtime_ms?: unknown
  cache_version?: unknown
  parameter_version?: unknown
  duration?: unknown
  detail_rate?: unknown
  overview_rate?: unknown
  frame_count?: unknown
  payload?: unknown
}

const TABLE = 'unified_display_waveform_cache'
const MAGIC = 'UDW1'
const deflateAsync = promisify(deflate)
const inflateAsync = promisify(inflate)

const normalizeMeta = (row: unknown): UnifiedDisplayWaveformMeta | null => {
  if (!isSqliteRow(row)) return null
  const size = toNumber(row.size)
  const mtimeMs = toNumber(row.mtime_ms)
  const cacheVersion = toNumber(row.cache_version)
  const parameterVersion = toNumber(row.parameter_version)
  const duration = toNumber(row.duration)
  const detailRate = toNumber(row.detail_rate)
  const overviewRate = toNumber(row.overview_rate)
  const frameCount = toNumber(row.frame_count)
  if (
    size === null ||
    mtimeMs === null ||
    cacheVersion === null ||
    parameterVersion === null ||
    duration === null ||
    detailRate === null ||
    overviewRate === null ||
    frameCount === null
  ) {
    return null
  }
  return {
    size,
    mtimeMs,
    cacheVersion,
    parameterVersion,
    duration,
    detailRate,
    overviewRate,
    frameCount
  }
}

const toBuffer = (value: unknown): Buffer | null => {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return null
}

const writeHeader = async (payload: Buffer, header: Record<string, unknown>) => {
  const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(8)
  prefix.write(MAGIC, 0, 4, 'ascii')
  prefix.writeUInt32LE(headerBuffer.byteLength, 4)
  return await deflateAsync(Buffer.concat([prefix, headerBuffer, payload]))
}

const readPayload = async (compressed: Buffer) => {
  const decoded = await inflateAsync(compressed)
  if (decoded.byteLength < 8 || decoded.subarray(0, 4).toString('ascii') !== MAGIC) return null
  const headerLength = decoded.readUInt32LE(4)
  const payloadStart = 8 + headerLength
  if (headerLength <= 0 || payloadStart > decoded.byteLength) return null
  const header = JSON.parse(decoded.subarray(8, payloadStart).toString('utf8')) as {
    sampleRate?: number
    bodyRateDivisor?: number
    heightLength?: number
    attackLength?: number
    colorIndexLength?: number
    colorLowLength?: number
    colorMidLength?: number
    colorHighLength?: number
    colorRedLength?: number
    colorGreenLength?: number
    colorBlueLength?: number
    bodyLength?: number
    overviewHeightLength?: number
  }
  let offset = payloadStart
  const readBytes = (length: unknown) => {
    const count = Math.max(0, Math.floor(Number(length) || 0))
    if (offset + count > decoded.byteLength) return null
    const result = new Uint8Array(decoded.subarray(offset, offset + count))
    offset += count
    return result
  }
  return { header, readBytes }
}

async function encodeUnifiedDisplayWaveformCacheData(
  data: UnifiedDisplayWaveformDetailData
): Promise<Buffer | null> {
  if (!data || data.version !== UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION) return null
  if (data.parameterVersion !== UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION) return null
  if (!data.height?.length || !data.attack?.length || !data.colorIndex?.length) return null
  if (!data.colorLow?.length || !data.colorMid?.length || !data.colorHigh?.length) return null
  if (!data.colorRed?.length || !data.colorGreen?.length || !data.colorBlue?.length) return null
  if (!data.body?.length || !data.overviewHeight?.length) return null
  const payload = Buffer.concat([
    Buffer.from(data.height),
    Buffer.from(data.attack),
    Buffer.from(data.colorIndex),
    Buffer.from(data.colorLow),
    Buffer.from(data.colorMid),
    Buffer.from(data.colorHigh),
    Buffer.from(data.colorRed),
    Buffer.from(data.colorGreen),
    Buffer.from(data.colorBlue),
    Buffer.from(data.body),
    Buffer.from(data.overviewHeight)
  ])
  return writeHeader(payload, {
    sampleRate: data.sampleRate,
    bodyRateDivisor: data.bodyRateDivisor,
    heightLength: data.height.length,
    attackLength: data.attack.length,
    colorIndexLength: data.colorIndex.length,
    colorLowLength: data.colorLow.length,
    colorMidLength: data.colorMid.length,
    colorHighLength: data.colorHigh.length,
    colorRedLength: data.colorRed.length,
    colorGreenLength: data.colorGreen.length,
    colorBlueLength: data.colorBlue.length,
    bodyLength: data.body.length,
    overviewHeightLength: data.overviewHeight.length
  })
}

async function decodeUnifiedDisplayWaveformCacheData(
  meta: UnifiedDisplayWaveformMeta,
  payload: Buffer
): Promise<UnifiedDisplayWaveformDetailData | null> {
  if (!meta || !payload) return null
  if (
    meta.cacheVersion !== UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION ||
    !Number.isFinite(meta.parameterVersion) ||
    meta.parameterVersion <= 0
  ) {
    return null
  }
  const decoded = await readPayload(payload)
  if (!decoded) return null
  const height = decoded.readBytes(decoded.header.heightLength)
  const attack = decoded.readBytes(decoded.header.attackLength)
  const colorIndex = decoded.readBytes(decoded.header.colorIndexLength)
  const colorLow = decoded.readBytes(decoded.header.colorLowLength)
  const colorMid = decoded.readBytes(decoded.header.colorMidLength)
  const colorHigh = decoded.readBytes(decoded.header.colorHighLength)
  const colorRed = decoded.readBytes(decoded.header.colorRedLength)
  const colorGreen = decoded.readBytes(decoded.header.colorGreenLength)
  const colorBlue = decoded.readBytes(decoded.header.colorBlueLength)
  const body = decoded.readBytes(decoded.header.bodyLength)
  const overviewHeight = decoded.readBytes(decoded.header.overviewHeightLength)
  if (
    !height ||
    !attack ||
    !colorIndex ||
    !colorLow ||
    !colorMid ||
    !colorHigh ||
    !colorRed ||
    !colorGreen ||
    !colorBlue ||
    !body ||
    !overviewHeight
  ) {
    return null
  }
  return {
    version: meta.cacheVersion,
    parameterVersion: meta.parameterVersion,
    duration: meta.duration,
    sampleRate: Math.max(0, Number(decoded.header.sampleRate) || 0),
    detailRate: meta.detailRate,
    overviewRate: meta.overviewRate,
    bodyRateDivisor: Math.max(1, Number(decoded.header.bodyRateDivisor) || 1),
    height,
    attack,
    colorIndex,
    colorLow,
    colorMid,
    colorHigh,
    colorRed,
    colorGreen,
    colorBlue,
    body,
    overviewHeight
  }
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

const loadRow = (
  listRoot: string,
  filePath: string
): { row: UnifiedDisplayWaveformRow; hitListRoot: string; hitFilePath: string } | null => {
  const db = getLibraryDb()
  const keys = resolveCacheKeys(listRoot, filePath)
  if (!db || !keys) return null
  const stmt = db.prepare<UnifiedDisplayWaveformRow>(
    `SELECT list_root, file_path, size, mtime_ms, cache_version, parameter_version, duration,
            detail_rate, overview_rate, frame_count, payload
       FROM ${TABLE} WHERE list_root = ? AND file_path = ? LIMIT 1`
  )
  const candidates: Array<[string, string | undefined]> = [
    [keys.listRootKey, keys.fileKey],
    [keys.listRootKey, keys.fileKeyRaw],
    [keys.legacyListRoot || '', keys.legacyFilePath]
  ]
  for (const [root, file] of candidates) {
    if (!root || !file) continue
    const row = stmt.get(root, file)
    if (row?.payload !== undefined) {
      return { row, hitListRoot: root, hitFilePath: file }
    }
  }
  return null
}

export function migrateUnifiedDisplayWaveformCacheRows(
  db: SqliteDatabase,
  oldListRoot: string,
  newListRootKey: string,
  listRootAbs: string
): number {
  try {
    const rows = db
      .prepare<UnifiedDisplayWaveformRow>(`SELECT file_path FROM ${TABLE} WHERE list_root = ?`)
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

export async function loadUnifiedDisplayWaveformCacheData(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
): Promise<UnifiedDisplayWaveformDetailData | null | undefined> {
  if (!listRoot || !filePath) return undefined
  try {
    const hit = loadRow(listRoot, filePath)
    if (!hit) return null
    const meta = normalizeMeta(hit.row)
    if (
      !meta ||
      meta.size !== stat.size ||
      Math.abs(meta.mtimeMs - stat.mtimeMs) > 1 ||
      meta.cacheVersion !== UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION ||
      !Number.isFinite(meta.parameterVersion) ||
      meta.parameterVersion <= 0
    ) {
      await removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
      return null
    }
    const payload = toBuffer(hit.row.payload)
    if (!payload) {
      await removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
      return null
    }
    const decoded = await decodeUnifiedDisplayWaveformCacheData(meta, payload)
    if (!decoded) {
      await removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
      return null
    }
    return decoded
  } catch (error) {
    log.error('[sqlite] unified display waveform cache load failed', error)
    return undefined
  }
}

export async function upsertUnifiedDisplayWaveformCacheEntry(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number },
  data: UnifiedDisplayWaveformDetailData
): Promise<boolean> {
  const db = getLibraryDb()
  const keys = resolveCacheKeys(listRoot, filePath)
  if (!db || !keys || !data) return false
  const payload = await encodeUnifiedDisplayWaveformCacheData(data)
  if (!payload) return false
  try {
    const upsertMain = db.prepare(
      `INSERT INTO ${TABLE} (
        list_root, file_path, size, mtime_ms, cache_version, parameter_version, duration,
        detail_rate, overview_rate, frame_count, payload, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(list_root, file_path) DO UPDATE SET
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        cache_version = excluded.cache_version,
        parameter_version = excluded.parameter_version,
        duration = excluded.duration,
        detail_rate = excluded.detail_rate,
        overview_rate = excluded.overview_rate,
        frame_count = excluded.frame_count,
        payload = excluded.payload,
        updated_at_ms = excluded.updated_at_ms`
    )
    const deleteMain = db.prepare(`DELETE FROM ${TABLE} WHERE list_root = ? AND file_path = ?`)
    db.transaction(() => {
      upsertMain.run(
        keys.listRootKey,
        keys.fileKey,
        stat.size,
        stat.mtimeMs,
        UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
        UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION,
        data.duration,
        data.detailRate,
        data.overviewRate,
        data.height.length,
        payload,
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
    log.error('[sqlite] unified display waveform cache upsert failed', error)
    return false
  }
}

export async function updateUnifiedDisplayWaveformCacheStat(
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
    log.error('[sqlite] unified display waveform cache stat update failed', error)
    return false
  }
}

export async function moveUnifiedDisplayWaveformCacheEntry(
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
    const payload = toBuffer(hit.row.payload)
    if (!meta || !payload) return false
    db.prepare(
      `INSERT INTO ${TABLE} (
        list_root, file_path, size, mtime_ms, cache_version, parameter_version, duration,
        detail_rate, overview_rate, frame_count, payload, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(list_root, file_path) DO UPDATE SET
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        cache_version = excluded.cache_version,
        parameter_version = excluded.parameter_version,
        duration = excluded.duration,
        detail_rate = excluded.detail_rate,
        overview_rate = excluded.overview_rate,
        frame_count = excluded.frame_count,
        payload = excluded.payload,
        updated_at_ms = excluded.updated_at_ms`
    ).run(
      newKeys.listRootKey,
      newKeys.fileKey,
      stat?.size ?? meta.size,
      stat?.mtimeMs ?? meta.mtimeMs,
      meta.cacheVersion,
      meta.parameterVersion,
      meta.duration,
      meta.detailRate,
      meta.overviewRate,
      meta.frameCount,
      payload,
      Date.now()
    )
    db.prepare(`DELETE FROM ${TABLE} WHERE list_root = ? AND file_path = ?`).run(
      hit.hitListRoot,
      hit.hitFilePath
    )
    return true
  } catch (error) {
    log.error('[sqlite] unified display waveform cache move failed', error)
    return false
  }
}

export async function removeUnifiedDisplayWaveformCacheEntry(
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
    log.error('[sqlite] unified display waveform cache delete failed', error)
    return false
  }
}
