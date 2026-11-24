import fs = require('fs-extra')
import path = require('path')
import { log } from '../log'
import { getLibraryDb, type SqliteDatabase } from '../libraryDb'
import {
  resolveAbsoluteListRoot,
  resolveFilePathInput,
  resolveListRootInput
} from '../libraryCacheDb/pathResolvers'
import { upsertSongCacheEntry } from '../libraryCacheDb/songCache'
import type { ISongInfo } from '../../types/globals'
import {
  assertDemoAnalysisSeedVersions,
  type DemoAnalysisSeedVersions
} from './demoAnalysisSeedVersions'

type SqliteDatabaseCtor = typeof import('better-sqlite3')

const SEED_DB_NAME = 'demo-analysis-seed.sqlite'

const WAVEFORM_SURFACE_ARRAY_COUNT = 12

type SeedSongCacheRow = {
  list_root?: unknown
  file_path?: unknown
  info_json?: unknown
}

type SeedWaveformSurfaceRow = {
  list_root?: unknown
  file_path?: unknown
  duration?: unknown
  sample_rate?: unknown
  list_preview_frame_count?: unknown
  global_overview_frame_count?: unknown
  list_preview_payload?: unknown
  global_overview_payload?: unknown
}

type SeedUnifiedDisplayRow = {
  list_root?: unknown
  file_path?: unknown
  duration?: unknown
  detail_rate?: unknown
  overview_rate?: unknown
  frame_count?: unknown
  payload?: unknown
}

type SeedTarget = {
  listRoot: string
  filePath: string
  listRootKey: string
  fileKey: string
  size: number
  mtimeMs: number
}

const toText = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value)

const toFiniteNumber = (value: unknown): number | null => {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

const toBuffer = (value: unknown): Buffer | null => {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return null
}

const resolveSeedDbPath = (): string => {
  const packedPath = path.join(__dirname, '../../resources/demoAnalysis', SEED_DB_NAME)
  const unpackedPath = packedPath.replace('app.asar', 'app.asar.unpacked')
  if (fs.pathExistsSync(unpackedPath)) return unpackedPath
  return packedPath
}

const readSeedVersions = (seedDb: SqliteDatabase): DemoAnalysisSeedVersions | null => {
  try {
    return assertDemoAnalysisSeedVersions((key) => {
      const row = seedDb
        .prepare<{ value?: unknown }>('SELECT value FROM demo_seed_meta WHERE key = ?')
        .get(key)
      return row?.value === undefined || row.value === null ? null : String(row.value)
    })
  } catch {
    return null
  }
}

// seed 内部统一用 posix 相对路径，落库前换回当前系统分隔符。
const toNativeRelativePath = (raw: unknown): string | null => {
  const text = toText(raw)
  if (!text) return null
  const posixText = text.replace(/\\/g, '/')
  if (posixText.startsWith('/') || /^[A-Za-z]:\//.test(posixText)) return null
  return posixText.replace(/\//g, path.sep)
}

const resolveSeedTarget = (
  dirPath: string,
  rawListRoot: unknown,
  rawFilePath: unknown,
  stats: Map<string, { size: number; mtimeMs: number }>
): SeedTarget | null => {
  const listRoot = toNativeRelativePath(rawListRoot)
  const filePath = toNativeRelativePath(rawFilePath)
  if (!listRoot || !filePath) return null
  if (!listRoot.toLowerCase().split(path.sep).includes('library')) return null
  const absFilePath = path.join(dirPath, listRoot, filePath)
  let stat = stats.get(absFilePath)
  if (!stat) {
    let fileStat: fs.Stats
    try {
      fileStat = fs.statSync(absFilePath)
    } catch {
      return null
    }
    if (!fileStat.isFile()) return null
    stat = { size: fileStat.size, mtimeMs: fileStat.mtimeMs }
    stats.set(absFilePath, stat)
  }
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return null
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(resolvedRoot.key)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return null
  if (resolvedFile.key.split(path.sep).some((segment) => segment === '..')) return null
  return {
    listRoot,
    filePath,
    listRootKey: resolvedRoot.key,
    fileKey: resolvedFile.key,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  }
}

const createSeedWriters = (db: SqliteDatabase) => {
  const insertWaveformSurface = db.prepare(
    `INSERT INTO waveform_surface_cache (
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
  const insertUnifiedDisplay = db.prepare(
    `INSERT INTO unified_display_waveform_cache (
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
  return { insertWaveformSurface, insertUnifiedDisplay }
}

const writeWaveformSurfaceRow = (
  writer: ReturnType<typeof createSeedWriters>['insertWaveformSurface'],
  target: SeedTarget,
  row: SeedWaveformSurfaceRow,
  versions: DemoAnalysisSeedVersions
): boolean => {
  const duration = toFiniteNumber(row.duration)
  const sampleRate = toFiniteNumber(row.sample_rate)
  const listPreviewFrameCount = toFiniteNumber(row.list_preview_frame_count)
  const globalOverviewFrameCount = toFiniteNumber(row.global_overview_frame_count)
  const listPreviewPayload = toBuffer(row.list_preview_payload)
  const globalOverviewPayload = toBuffer(row.global_overview_payload)
  if (
    duration === null ||
    duration <= 0 ||
    sampleRate === null ||
    sampleRate <= 0 ||
    !listPreviewFrameCount ||
    !globalOverviewFrameCount ||
    !listPreviewPayload ||
    !globalOverviewPayload
  ) {
    return false
  }
  if (
    listPreviewPayload.byteLength < listPreviewFrameCount * WAVEFORM_SURFACE_ARRAY_COUNT ||
    globalOverviewPayload.byteLength < globalOverviewFrameCount * WAVEFORM_SURFACE_ARRAY_COUNT
  ) {
    return false
  }
  writer.run(
    target.listRootKey,
    target.fileKey,
    target.size,
    target.mtimeMs,
    versions.waveformSurfaceCacheVersion,
    versions.waveformListPreviewParameterVersion,
    versions.waveformGlobalOverviewParameterVersion,
    duration,
    sampleRate,
    listPreviewFrameCount,
    globalOverviewFrameCount,
    listPreviewPayload,
    globalOverviewPayload,
    Date.now()
  )
  return true
}

const writeUnifiedDisplayRow = (
  writer: ReturnType<typeof createSeedWriters>['insertUnifiedDisplay'],
  target: SeedTarget,
  row: SeedUnifiedDisplayRow,
  versions: DemoAnalysisSeedVersions
): boolean => {
  const duration = toFiniteNumber(row.duration)
  const detailRate = toFiniteNumber(row.detail_rate)
  const overviewRate = toFiniteNumber(row.overview_rate)
  const frameCount = toFiniteNumber(row.frame_count)
  const payload = toBuffer(row.payload)
  if (
    duration === null ||
    duration <= 0 ||
    !detailRate ||
    !overviewRate ||
    !frameCount ||
    !payload ||
    payload.byteLength === 0
  ) {
    return false
  }
  writer.run(
    target.listRootKey,
    target.fileKey,
    target.size,
    target.mtimeMs,
    versions.unifiedDisplayWaveformCacheVersion,
    versions.unifiedDisplayWaveformParameterVersion,
    duration,
    detailRate,
    overviewRate,
    frameCount,
    payload,
    Date.now()
  )
  return true
}

/**
 * 把随包示例分析结果写入刚创建的示例库缓存。
 * 版本不一致或 seed 文件缺失时整批跳过，保持“要么全都有、要么都没有”，
 * 避免出现只有 BPM/Key 却没有波形的半成品状态。
 */
export async function seedDemoAnalysis(dirPath: string): Promise<void> {
  const seedPath = resolveSeedDbPath()
  if (!fs.pathExistsSync(seedPath)) return
  let seedDb: SqliteDatabase | null = null
  try {
    const Database = require('better-sqlite3') as SqliteDatabaseCtor
    seedDb = new Database(seedPath, { readonly: true, fileMustExist: true })
    const versions = readSeedVersions(seedDb)
    if (!versions) {
      log.error('[demo-seed] 示例分析缓存版本与当前算法版本不一致，已跳过预置')
      return
    }
    const targetDb = getLibraryDb()
    if (!targetDb) return
    const songRows = seedDb
      .prepare<SeedSongCacheRow>('SELECT list_root, file_path, info_json FROM demo_song_cache')
      .all()
    const surfaceRows = seedDb
      .prepare<SeedWaveformSurfaceRow>(
        `SELECT list_root, file_path, duration, sample_rate,
                list_preview_frame_count, global_overview_frame_count,
                list_preview_payload, global_overview_payload
           FROM demo_waveform_surface_cache`
      )
      .all()
    const unifiedRows = seedDb
      .prepare<SeedUnifiedDisplayRow>(
        `SELECT list_root, file_path, duration, detail_rate, overview_rate, frame_count, payload
           FROM demo_unified_display_waveform_cache`
      )
      .all()
    if (songRows.length === 0 || surfaceRows.length === 0 || unifiedRows.length === 0) return

    const seedWriters = createSeedWriters(targetDb)
    const stats = new Map<string, { size: number; mtimeMs: number }>()
    let songCount = 0
    let waveformCount = 0
    for (const row of songRows) {
      const target = resolveSeedTarget(dirPath, row.list_root, row.file_path, stats)
      if (!target) continue
      let info: ISongInfo | null = null
      try {
        info = JSON.parse(toText(row.info_json)) as ISongInfo
      } catch {
        info = null
      }
      if (!info) continue
      const written = await upsertSongCacheEntry(target.listRoot, target.filePath, {
        size: target.size,
        mtimeMs: target.mtimeMs,
        info
      })
      if (written) songCount += 1
    }
    for (const row of surfaceRows) {
      const target = resolveSeedTarget(dirPath, row.list_root, row.file_path, stats)
      if (!target) continue
      if (writeWaveformSurfaceRow(seedWriters.insertWaveformSurface, target, row, versions)) {
        waveformCount += 1
      }
    }
    for (const row of unifiedRows) {
      const target = resolveSeedTarget(dirPath, row.list_root, row.file_path, stats)
      if (!target) continue
      if (writeUnifiedDisplayRow(seedWriters.insertUnifiedDisplay, target, row, versions)) {
        waveformCount += 1
      }
    }
    if (
      songCount !== songRows.length ||
      waveformCount !== surfaceRows.length + unifiedRows.length
    ) {
      log.error(
        `[demo-seed] 示例分析缓存写入不完整：song ${songCount}/${songRows.length}，waveform ${waveformCount}/${surfaceRows.length + unifiedRows.length}`
      )
    }
  } catch (error) {
    log.error('[demo-seed] 示例分析缓存预置失败', error)
  } finally {
    if (seedDb) {
      try {
        seedDb.close()
      } catch {}
    }
  }
}
