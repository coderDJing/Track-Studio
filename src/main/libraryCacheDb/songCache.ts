import path = require('path')
import fs = require('fs-extra')
import { getLibraryDb, isSqliteRow } from '../libraryDb'
import { log } from '../log'
import type { ISongInfo } from '../../types/globals'
import { normalizeSongBeatGridMapV2 } from '../../shared/songBeatGridMapV2'
import type { SongCacheEntry } from './types'
import {
  toNumber,
  resolveListRootInput,
  resolveFilePathInput,
  resolveAbsoluteListRoot,
  resolveAbsoluteFilePath,
  normalizeInfoJsonFilePath,
  normalizeRoot,
  stripBeatThisDebugInfo
} from './pathResolvers'
// song_cache 一变，对应歌单的视图快照就可能过期：每个写入函数成功后都把快照标成
// verified_at_ms = 0，后台核对看到哨兵值会重建一次。
// 顺序说明：worker 扫描先 replaceSongCache（标脏），主进程随后写快照（verified_at_ms = now），
// 所以正常扫描不会留下假脏。已知窄窗口：分析写入若正好落在"worker 写缓存"与"主进程存快照"
// 之间，这次标脏会被覆盖，要等下一次写入才重新标脏；renderer 已经通过分析事件拿到实时值，
// 显示不受影响。
import { markPlaylistViewSnapshotContentStale } from './playlistViewSnapshot'
import type { SqliteDatabase } from '../libraryDb'

const migratedSongRoots = new Set<string>()
const looseSongRootCache = new Map<string, string[]>()

type SongCacheDbRow = {
  list_root?: string
  file_path?: string
  size?: unknown
  mtime_ms?: unknown
  info_json?: unknown
}

type SongCacheRootRow = {
  list_root?: string
}

type SongCacheRowHit = {
  row: SongCacheDbRow
  hitListRoot: string
  hitFilePath: string
}

function parseInfoJson(raw: unknown): ISongInfo | null {
  if (raw === undefined || raw === null) return null
  try {
    return JSON.parse(String(raw)) as ISongInfo
  } catch {
    return null
  }
}

function hasKeyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function hasBpmValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function hasSongCacheBeatGridValue(info: ISongInfo | null | undefined): boolean {
  return (
    normalizeSongBeatGridMapV2(info?.beatGridMap, { allowSingleClip: true }) !== null ||
    hasBpmValue(info?.bpm) ||
    info?.beatGridStatus === 'no-bpm'
  )
}

export function normalizeSongCacheInfoForStorage(
  info: ISongInfo,
  absoluteFilePath: string
): ISongInfo {
  const next = { ...info, filePath: absoluteFilePath }
  const beatGridMap = normalizeSongBeatGridMapV2(next.beatGridMap, { allowSingleClip: true })
  if (beatGridMap) {
    delete next.bpm
    delete next.firstBeatMs
    delete next.downbeatBeatOffset
    delete (next as Record<string, unknown>).barBeatOffset
    delete next.beatGridSource
    delete next.beatGridStatus
    next.beatGridMap = beatGridMap
  }
  return next
}

function mergeInfoJson(
  baseRaw: unknown,
  incomingRaw: unknown,
  absFilePath: string
): { json: string; changed: boolean } {
  const base = parseInfoJson(baseRaw)
  const incoming = parseInfoJson(incomingRaw)
  if (!base && !incoming) {
    return { json: normalizeInfoJsonFilePath(baseRaw, absFilePath), changed: false }
  }
  const next: Partial<ISongInfo> = { ...(base || {}) }
  if (incoming) {
    for (const [key, value] of Object.entries(incoming)) {
      if (value !== undefined) {
        Reflect.set(next, key, value)
      }
    }
  }
  const beforeKey = next.key
  const beforeBpm = next.bpm
  const beforeAnalysisOnly = next.analysisOnly
  if (!hasKeyText(next.key) && hasKeyText(base?.key)) next.key = base?.key
  if (!hasKeyText(next.key) && hasKeyText(incoming?.key)) next.key = incoming?.key
  if (!hasBpmValue(next.bpm) && hasBpmValue(base?.bpm)) next.bpm = base?.bpm
  if (!hasBpmValue(next.bpm) && hasBpmValue(incoming?.bpm)) next.bpm = incoming?.bpm
  if (next.analysisOnly && incoming?.analysisOnly === false) {
    next.analysisOnly = false
  }
  if (next.analysisOnly && base?.analysisOnly === false) {
    next.analysisOnly = false
  }
  if (next.analysisOnly === undefined && incoming?.analysisOnly !== undefined) {
    next.analysisOnly = incoming?.analysisOnly
  }
  if (next.analysisOnly === undefined && base?.analysisOnly !== undefined) {
    next.analysisOnly = base?.analysisOnly
  }
  stripBeatThisDebugInfo(next)
  const normalized = normalizeSongCacheInfoForStorage(next as ISongInfo, absFilePath)
  const changed =
    beforeKey !== next.key || beforeBpm !== next.bpm || beforeAnalysisOnly !== next.analysisOnly
  return { json: JSON.stringify(normalized), changed }
}

function toLooseCompareExpr(column: string): string {
  return `REPLACE(LOWER(${column}), '/', '\\\\') = REPLACE(LOWER(?), '/', '\\\\')`
}

function toLooseCompareExprRaw(expr: string): string {
  return `REPLACE(LOWER(${expr}), '/', '\\\\') = REPLACE(LOWER(?), '/', '\\\\')`
}

function getLooseSongCacheRoots(
  db: SqliteDatabase,
  candidates: Array<string | null | undefined>,
  listRootKey: string
): string[] {
  const key = `${listRootKey}::${candidates.filter(Boolean).join('|')}`
  const cached = looseSongRootCache.get(key)
  if (cached) return cached
  const roots: string[] = []
  const seen = new Set<string>()
  const stmt = db.prepare<SongCacheRootRow>(
    `SELECT DISTINCT list_root FROM song_cache WHERE ${toLooseCompareExpr('list_root')} LIMIT 20`
  )
  for (const candidate of candidates) {
    const value = candidate ? String(candidate) : ''
    if (!value) continue
    let rows: SongCacheRootRow[] = []
    try {
      rows = stmt.all(value)
    } catch {
      rows = []
    }
    for (const row of rows) {
      const root = row?.list_root ? String(row.list_root) : ''
      if (!root || seen.has(root)) continue
      seen.add(root)
      roots.push(root)
    }
  }
  looseSongRootCache.set(key, roots)
  return roots
}

function getSongCacheRowLoose(
  db: SqliteDatabase,
  listRootCandidates: string[],
  filePathCandidates: string[]
): SongCacheRowHit | null {
  if (!db || listRootCandidates.length === 0 || filePathCandidates.length === 0) return null
  const stmt = db.prepare<SongCacheDbRow>(
    `SELECT list_root, file_path, size, mtime_ms, info_json FROM song_cache WHERE ${toLooseCompareExpr(
      'list_root'
    )} AND ${toLooseCompareExpr('file_path')} LIMIT 1`
  )
  for (const listRoot of listRootCandidates) {
    for (const filePath of filePathCandidates) {
      let row: SongCacheDbRow | undefined
      try {
        row = stmt.get(listRoot, filePath)
      } catch {
        row = undefined
      }
      if (row && row.info_json !== undefined) {
        return {
          row,
          hitListRoot: String(row.list_root || listRoot),
          hitFilePath: String(row.file_path || filePath)
        }
      }
    }
  }
  return null
}

function getSongCacheRowGlobal(
  db: SqliteDatabase,
  filePathCandidates: string[]
): SongCacheRowHit | null {
  if (!db || filePathCandidates.length === 0) return null
  const stmt = db.prepare<SongCacheDbRow>(
    `SELECT list_root, file_path, size, mtime_ms, info_json FROM song_cache WHERE ${toLooseCompareExpr(
      'file_path'
    )} LIMIT 1`
  )
  for (const filePath of filePathCandidates) {
    let row: SongCacheDbRow | undefined
    try {
      row = stmt.get(filePath)
    } catch {
      row = undefined
    }
    if (row && row.info_json !== undefined) {
      return {
        row,
        hitListRoot: String(row.list_root || ''),
        hitFilePath: String(row.file_path || filePath)
      }
    }
  }
  return null
}

function getSongCacheRowByAbsPath(
  db: SqliteDatabase,
  absPathCandidates: string[]
): SongCacheRowHit | null {
  if (!db || absPathCandidates.length === 0) return null
  try {
    const expr = "CASE WHEN json_valid(info_json) THEN json_extract(info_json, '$.filePath') END"
    const stmt = db.prepare<SongCacheDbRow>(
      `SELECT list_root, file_path, size, mtime_ms, info_json FROM song_cache WHERE ${toLooseCompareExprRaw(
        expr
      )} LIMIT 1`
    )
    for (const absPath of absPathCandidates) {
      let row: SongCacheDbRow | undefined
      try {
        row = stmt.get(absPath)
      } catch {
        row = undefined
      }
      if (row && row.info_json !== undefined) {
        return {
          row,
          hitListRoot: String(row.list_root || ''),
          hitFilePath: String(row.file_path || '')
        }
      }
    }
  } catch {
    return null
  }
  return null
}

export function migrateSongCacheRows(
  db: SqliteDatabase,
  oldListRoot: string,
  newListRootKey: string,
  listRootAbs: string
): number {
  try {
    const rows = db
      .prepare<SongCacheDbRow>(
        'SELECT file_path, size, mtime_ms, info_json FROM song_cache WHERE list_root = ?'
      )
      .all(oldListRoot)
    if (!rows || rows.length === 0) return 0
    const del = db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?')
    const update = db.prepare(
      'UPDATE song_cache SET list_root = ?, file_path = ?, info_json = ? WHERE list_root = ? AND file_path = ?'
    )
    const selectNew = db.prepare<SongCacheDbRow>(
      'SELECT size, mtime_ms, info_json FROM song_cache WHERE list_root = ? AND file_path = ?'
    )
    const updateNew = db.prepare(
      'UPDATE song_cache SET size = ?, mtime_ms = ?, info_json = ? WHERE list_root = ? AND file_path = ?'
    )
    let moved = 0
    const run = db.transaction(() => {
      for (const row of rows) {
        const filePath = row?.file_path ? String(row.file_path) : ''
        if (!filePath) continue
        const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
        if (!resolvedFile) continue
        const newFileKey = resolvedFile.key
        const absFilePath = resolveAbsoluteFilePath(newListRootKey, newFileKey)
        const existing = selectNew.get(newListRootKey, newFileKey)
        if (existing && existing.info_json !== undefined) {
          const merged = mergeInfoJson(existing.info_json, row?.info_json, absFilePath)
          const nextSize = toNumber(existing.size)
          const nextMtime = toNumber(existing.mtime_ms)
          const fallbackSize = toNumber(row.size)
          const fallbackMtime = toNumber(row.mtime_ms)
          updateNew.run(
            nextSize ?? fallbackSize ?? 0,
            nextMtime ?? fallbackMtime ?? 0,
            merged.json,
            newListRootKey,
            newFileKey
          )
          del.run(oldListRoot, filePath)
          moved += 1
          continue
        }
        const infoJson = normalizeInfoJsonFilePath(row?.info_json, absFilePath)
        del.run(newListRootKey, newFileKey)
        const result = update.run(newListRootKey, newFileKey, infoJson, oldListRoot, filePath)
        moved += result?.changes ? Number(result.changes) : 0
      }
    })
    run()
    return moved
  } catch {
    return 0
  }
}

export async function ensureSongCacheMigrated(db: SqliteDatabase, listRoot: string): Promise<void> {
  const resolved = resolveListRootInput(listRoot)
  if (!resolved) return
  const listRootKey = resolved.key
  const listRootAbs = resolved.abs
  if (!listRootKey || migratedSongRoots.has(listRootKey)) return
  migratedSongRoots.add(listRootKey)
  try {
    const countRow = db
      .prepare('SELECT COUNT(1) as count FROM song_cache WHERE list_root = ?')
      .get(listRootKey)
    if (countRow && Number(countRow.count) > 0) return
    if (!listRootAbs) return
    const cacheFile = path.join(listRootAbs, '.songs.cache.json')
    if (!(await fs.pathExists(cacheFile))) return
    const json = await fs.readJSON(cacheFile).catch(() => null)
    const entries = isSqliteRow(json) ? json.entries : null
    if (!isSqliteRow(entries)) return
    const rows: Array<{ filePath: string; size: number; mtimeMs: number; infoJson: string }> = []
    for (const [filePath, entry] of Object.entries(entries)) {
      if (!filePath || !isSqliteRow(entry)) continue
      const size = toNumber(entry.size)
      const mtimeMs = toNumber(entry.mtimeMs)
      const info = entry.info
      if (size === null || mtimeMs === null || !info) continue
      let infoJson = ''
      try {
        const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
        if (!resolvedFile) continue
        const absFilePath = resolveAbsoluteFilePath(listRootKey, resolvedFile.key)
        if (info && typeof info === 'object') {
          ;(info as ISongInfo).filePath = absFilePath
        }
        infoJson = JSON.stringify(info)
        rows.push({
          filePath: resolvedFile.key,
          size,
          mtimeMs,
          infoJson
        })
      } catch {
        continue
      }
    }
    if (!rows.length) return
    const insert = db.prepare(
      'INSERT OR REPLACE INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
    )
    const run = db.transaction((items: typeof rows) => {
      for (const row of items) {
        insert.run(listRootKey, row.filePath, row.size, row.mtimeMs, row.infoJson)
      }
    })
    run(rows)
  } catch (error) {
    log.error('[sqlite] song cache migrate failed', error)
  }
}

export async function loadSongCache(listRoot: string): Promise<Map<string, SongCacheEntry> | null> {
  const db = getLibraryDb()
  if (!db || !listRoot) return null
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return null
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    await ensureSongCacheMigrated(db, listRoot)
    const map = new Map<string, SongCacheEntry>()
    const appendRows = (rowsToUse: SongCacheDbRow[], rootKey: string, legacyRelRoot?: string) => {
      for (const row of rowsToUse || []) {
        if (!row || !row.file_path || row.info_json === undefined) continue
        let info: ISongInfo | null = null
        try {
          info = JSON.parse(String(row.info_json)) as ISongInfo
        } catch {
          info = null
        }
        const size = toNumber(row.size)
        const mtimeMs = toNumber(row.mtime_ms)
        if (!info || size === null || mtimeMs === null) continue
        let absFilePath = resolveAbsoluteFilePath(rootKey, String(row.file_path))
        if (legacyRelRoot) {
          const resolvedLegacy = resolveFilePathInput(legacyRelRoot, String(row.file_path))
          if (resolvedLegacy && resolvedLegacy.isRelativeKey) {
            absFilePath = resolveAbsoluteFilePath(listRootKey, resolvedLegacy.key)
          }
        }
        info.filePath = absFilePath
        map.set(absFilePath, { size, mtimeMs, info })
      }
    }
    const rows = db
      .prepare<SongCacheDbRow>(
        'SELECT file_path, size, mtime_ms, info_json FROM song_cache WHERE list_root = ?'
      )
      .all(listRootKey)
    const legacyRows = legacyListRoot
      ? db
          .prepare<SongCacheDbRow>(
            'SELECT file_path, size, mtime_ms, info_json FROM song_cache WHERE list_root = ?'
          )
          .all(legacyListRoot)
      : []
    const looseRoots =
      rows.length === 0 && legacyRows.length === 0
        ? getLooseSongCacheRoots(db, [listRoot, listRootAbs, listRootKey], listRootKey).filter(
            (root) => root !== listRootKey && root !== legacyListRoot
          )
        : []
    if (looseRoots.length > 0) {
      const extraStmt = db.prepare<SongCacheDbRow>(
        'SELECT file_path, size, mtime_ms, info_json FROM song_cache WHERE list_root = ?'
      )
      for (const root of looseRoots) {
        const extraRows = extraStmt.all(root)
        if (extraRows && extraRows.length > 0) {
          appendRows(extraRows, root, listRootAbs)
          if (resolvedRoot.isRelativeKey && listRootAbs) {
            migrateSongCacheRows(db, root, listRootKey, listRootAbs)
          }
        }
      }
    }
    appendRows(rows, listRootKey)
    if (legacyRows && legacyRows.length > 0 && legacyListRoot && listRootAbs) {
      appendRows(legacyRows, legacyListRoot, legacyListRoot)
      if (resolvedRoot.isRelativeKey) {
        migrateSongCacheRows(db, legacyListRoot, listRootKey, listRootAbs)
      }
    }
    return map
  } catch (error) {
    log.error('[sqlite] song cache load failed', error)
    return null
  }
}

export async function loadSongCacheEntry(
  listRoot: string,
  filePath: string
): Promise<SongCacheEntry | null | undefined> {
  // 注意：虽然此函数是 async，但 better-sqlite3 是同步驱动，所有数据库操作不会 yield 控制权。
  // 唯一的 await 点是 ensureSongCacheMigrated，它通过 migratedSongRoots 去重后几乎立即返回。
  // 因此不存在 TOCTOU 竞态问题。
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return undefined
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return undefined
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return undefined
  const fileKey = resolvedFile.key
  const fileKeyRaw = resolvedFile.keyRaw
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  const legacyFilePath = resolvedFile.legacyAbs
  try {
    await ensureSongCacheMigrated(db, listRoot)
    let row = db
      .prepare(
        'SELECT size, mtime_ms, info_json FROM song_cache WHERE list_root = ? AND file_path = ?'
      )
      .get(listRootKey, fileKey)
    let hitListRoot = listRootKey
    let hitFilePath = fileKey
    let legacyHit = false
    if (!row && fileKeyRaw) {
      row = db
        .prepare(
          'SELECT size, mtime_ms, info_json FROM song_cache WHERE list_root = ? AND file_path = ?'
        )
        .get(listRootKey, fileKeyRaw)
      if (row) {
        hitListRoot = listRootKey
        hitFilePath = fileKeyRaw
        legacyHit = true
      }
    }
    if (!row && legacyListRoot && legacyFilePath) {
      row = db
        .prepare(
          'SELECT size, mtime_ms, info_json FROM song_cache WHERE list_root = ? AND file_path = ?'
        )
        .get(legacyListRoot, legacyFilePath)
      if (row) {
        hitListRoot = legacyListRoot
        hitFilePath = legacyFilePath
        legacyHit = true
      }
    }
    if (!row || row.info_json === undefined) {
      const looseRoots = getLooseSongCacheRoots(
        db,
        [listRoot, listRootAbs, listRootKey],
        listRootKey
      )
      const loose = getSongCacheRowLoose(
        db,
        looseRoots,
        [fileKey, fileKeyRaw, legacyFilePath, filePath].filter(
          (value): value is string => typeof value === 'string' && value.length > 0
        )
      )
      if (loose) {
        row = loose.row
        hitListRoot = loose.hitListRoot
        hitFilePath = loose.hitFilePath
        legacyHit = true
      }
    }
    const currentInfo = parseInfoJson(row?.info_json)
    const needsGlobalMerge =
      !row ||
      row.info_json === undefined ||
      !hasKeyText(currentInfo?.key) ||
      !hasSongCacheBeatGridValue(currentInfo)
    if (needsGlobalMerge) {
      const fileCandidates = [fileKey, fileKeyRaw, legacyFilePath, filePath].filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
      const looseRoots = getLooseSongCacheRoots(
        db,
        [listRoot, listRootAbs, listRootKey],
        listRootKey
      )
      const loose = getSongCacheRowLoose(db, looseRoots, fileCandidates)
      let mergeSource: SongCacheRowHit | null = null
      if (loose && loose.row && loose.row.info_json !== undefined) {
        const looseInfo = parseInfoJson(loose.row.info_json)
        if (hasKeyText(looseInfo?.key) || hasSongCacheBeatGridValue(looseInfo)) {
          if (!(hitListRoot === loose.hitListRoot && hitFilePath === loose.hitFilePath)) {
            mergeSource = loose
          }
        }
      }
      if (!mergeSource) {
        const absCandidates = [
          resolvedFile.abs,
          filePath,
          legacyFilePath,
          resolveAbsoluteFilePath(listRootKey, fileKey)
        ].filter(
          (value): value is string =>
            typeof value === 'string' && value.length > 0 && path.isAbsolute(value)
        )
        if (absCandidates.length > 0) {
          const byAbs = getSongCacheRowByAbsPath(db, absCandidates)
          if (byAbs && byAbs.row && byAbs.row.info_json !== undefined) {
            const byAbsInfo = parseInfoJson(byAbs.row.info_json)
            if (hasKeyText(byAbsInfo?.key) || hasSongCacheBeatGridValue(byAbsInfo)) {
              if (!(hitListRoot === byAbs.hitListRoot && hitFilePath === byAbs.hitFilePath)) {
                mergeSource = byAbs
              }
            }
          }
        }
      }
      if (!mergeSource) {
        const absCandidates = [filePath, legacyFilePath].filter(
          (value): value is string =>
            typeof value === 'string' && value.length > 0 && path.isAbsolute(value)
        )
        if (absCandidates.length > 0) {
          const global = getSongCacheRowGlobal(db, absCandidates)
          if (global && global.row && global.row.info_json !== undefined) {
            const globalInfo = parseInfoJson(global.row.info_json)
            if (hasKeyText(globalInfo?.key) || hasSongCacheBeatGridValue(globalInfo)) {
              if (!(hitListRoot === global.hitListRoot && hitFilePath === global.hitFilePath)) {
                mergeSource = global
              }
            }
          }
        }
      }
      if (mergeSource && mergeSource.row && mergeSource.row.info_json !== undefined) {
        const absFilePath = resolvedFile.abs || resolveAbsoluteFilePath(listRootKey, fileKey)
        const merged = mergeInfoJson(row?.info_json, mergeSource.row.info_json, absFilePath)
        const sameRoot = normalizeRoot(mergeSource.hitListRoot) === normalizeRoot(listRootKey)
        if (row && row.info_json !== undefined) {
          const updateExisting = db.prepare(
            'UPDATE song_cache SET info_json = ? WHERE list_root = ? AND file_path = ?'
          )
          updateExisting.run(merged.json, listRootKey, fileKey)
          row = { ...row, info_json: merged.json }
          if (
            sameRoot &&
            (mergeSource.hitListRoot !== listRootKey || mergeSource.hitFilePath !== fileKey)
          ) {
            try {
              db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?').run(
                mergeSource.hitListRoot,
                mergeSource.hitFilePath
              )
            } catch {}
          }
        } else {
          if (sameRoot) {
            const del = db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?')
            const update = db.prepare(
              'UPDATE song_cache SET list_root = ?, file_path = ?, info_json = ? WHERE list_root = ? AND file_path = ?'
            )
            del.run(listRootKey, fileKey)
            update.run(
              listRootKey,
              fileKey,
              merged.json,
              mergeSource.hitListRoot,
              mergeSource.hitFilePath
            )
            row = { ...mergeSource.row, info_json: merged.json }
            hitListRoot = listRootKey
            hitFilePath = fileKey
            legacyHit = true
          } else {
            const insert = db.prepare(
              'INSERT OR REPLACE INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
            )
            const size = toNumber(mergeSource.row.size) ?? 0
            const mtimeMs = toNumber(mergeSource.row.mtime_ms) ?? 0
            insert.run(listRootKey, fileKey, size, mtimeMs, merged.json)
            row = { ...mergeSource.row, info_json: merged.json }
            hitListRoot = listRootKey
            hitFilePath = fileKey
            legacyHit = false
          }
        }
      }
    }
    if (!row || row.info_json === undefined) {
      return null
    }
    let info: ISongInfo | null = null
    try {
      info = JSON.parse(String(row.info_json)) as ISongInfo
    } catch {
      info = null
    }
    const size = toNumber(row.size)
    const mtimeMs = toNumber(row.mtime_ms)
    if (!info || size === null || mtimeMs === null) return null
    const absFilePath =
      resolvedFile.abs || resolveAbsoluteFilePath(hitListRoot, String(hitFilePath))
    info.filePath = absFilePath
    if (legacyHit && resolvedRoot.isRelativeKey) {
      try {
        const sameRoot = normalizeRoot(hitListRoot) === normalizeRoot(listRootKey)
        const existing = db
          .prepare('SELECT info_json FROM song_cache WHERE list_root = ? AND file_path = ?')
          .get(listRootKey, fileKey)
        if (existing && existing.info_json !== undefined) {
          const merged = mergeInfoJson(existing.info_json, row.info_json, absFilePath)
          db.prepare(
            'UPDATE song_cache SET info_json = ? WHERE list_root = ? AND file_path = ?'
          ).run(merged.json, listRootKey, fileKey)
          if (sameRoot && (hitListRoot !== listRootKey || hitFilePath !== fileKey)) {
            db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?').run(
              hitListRoot,
              hitFilePath
            )
          }
        } else {
          const normalizedInfoJson = normalizeInfoJsonFilePath(row.info_json, absFilePath)
          if (sameRoot) {
            const del = db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?')
            const update = db.prepare(
              'UPDATE song_cache SET list_root = ?, file_path = ?, info_json = ? WHERE list_root = ? AND file_path = ?'
            )
            del.run(listRootKey, fileKey)
            update.run(listRootKey, fileKey, normalizedInfoJson, hitListRoot, hitFilePath)
          } else {
            const insert = db.prepare(
              'INSERT OR REPLACE INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
            )
            insert.run(listRootKey, fileKey, size, mtimeMs, normalizedInfoJson)
          }
        }
      } catch {}
    }
    return { size, mtimeMs, info }
  } catch (error) {
    log.error('[sqlite] song cache entry load failed', error)
    return undefined
  }
}

export async function updateSongCacheKey(
  listRoot: string,
  filePath: string,
  keyText: string,
  keyAnalysisAlgorithmVersion?: number
): Promise<boolean> {
  try {
    const entry = await loadSongCacheEntry(listRoot, filePath)
    if (!entry) return false
    if (
      entry.info.key === keyText &&
      (keyAnalysisAlgorithmVersion === undefined ||
        entry.info.keyAnalysisAlgorithmVersion === keyAnalysisAlgorithmVersion)
    ) {
      return true
    }
    entry.info.key = keyText
    if (keyAnalysisAlgorithmVersion !== undefined) {
      entry.info.keyAnalysisAlgorithmVersion = keyAnalysisAlgorithmVersion
    }
    return await upsertSongCacheEntry(listRoot, filePath, entry)
  } catch (error) {
    log.error('[sqlite] song cache key update failed', error)
    return false
  }
}

/**
 * 清除歌曲的分析数据（Key、节拍网格、能量、段落等），用于重新分析。
 * 保留用户数据：playlistTrackNumber（序号）、addedAtMs（加入时间）、hotCues、memoryCues、mixOrder 等。
 */
export type SongCoreAnalysisClearFields = {
  key?: boolean
  beatGrid?: boolean
  energy?: boolean
  structure?: boolean
}

export function stripSongCoreAnalysisFields(
  info: ISongInfo,
  fields?: SongCoreAnalysisClearFields
): ISongInfo {
  const clearAll = !fields
  const shouldClear = (name: keyof SongCoreAnalysisClearFields) =>
    clearAll || fields?.[name] === true
  const next = { ...info }
  if (shouldClear('key')) {
    delete next.key
    delete next.keyAnalysisAlgorithmVersion
  }
  if (shouldClear('beatGrid')) {
    delete next.bpm
    delete next.firstBeatMs
    delete next.downbeatBeatOffset
    delete (next as Record<string, unknown>).barBeatOffset
    delete next.beatGridSource
    delete next.beatGridStatus
    delete next.beatGridMap
    delete next.beatGridAlgorithmVersion
    delete next.timeBasisOffsetMs
    delete next.timeBasisOffsetAlgorithmVersion
  }
  if (shouldClear('energy')) {
    delete next.energyScore
    delete next.energyAlgorithmVersion
  }
  if (shouldClear('structure')) {
    delete next.songStructure
  }
  return next
}

export async function clearSongCacheAnalysisFields(
  listRoot: string,
  filePath: string,
  fields?: SongCoreAnalysisClearFields
): Promise<boolean> {
  try {
    const entry = await loadSongCacheEntry(listRoot, filePath)
    if (!entry) return false
    entry.info = stripSongCoreAnalysisFields(entry.info, fields)
    return await upsertSongCacheEntry(listRoot, filePath, entry)
  } catch (error) {
    log.error('[sqlite] song cache analysis fields clear failed', error)
    return false
  }
}

export async function replaceSongCache(
  listRoot: string,
  entries: Map<string, SongCacheEntry>
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    const insert = db.prepare(
      'INSERT OR REPLACE INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
    )
    const wipe = db.prepare('DELETE FROM song_cache WHERE list_root = ?')
    const run = db.transaction(() => {
      wipe.run(listRootKey)
      if (legacyListRoot) wipe.run(legacyListRoot)
      for (const [filePath, entry] of entries) {
        const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
        if (!resolvedFile) continue
        const absFilePath = resolveAbsoluteFilePath(listRootKey, resolvedFile.key)
        const infoJson = normalizeInfoJsonFilePath(
          JSON.stringify(normalizeSongCacheInfoForStorage(entry.info, absFilePath)),
          absFilePath
        )
        insert.run(listRootKey, resolvedFile.key, entry.size, entry.mtimeMs, infoJson)
      }
    })
    run()
    markPlaylistViewSnapshotContentStale(listRootKey)
    return true
  } catch (error) {
    log.error('[sqlite] song cache replace failed', error)
    return false
  }
}

export async function upsertSongCacheEntry(
  listRoot: string,
  filePath: string,
  entry: SongCacheEntry,
  oldFilePath?: string
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return false
  const fileKey = resolvedFile.key
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    await ensureSongCacheMigrated(db, listRoot)
    const insert = db.prepare(
      'INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(list_root, file_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, info_json = excluded.info_json'
    )
    const remove = db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?')
    const run = db.transaction(() => {
      if (oldFilePath && oldFilePath !== filePath) {
        const resolvedOldFile = resolveFilePathInput(listRootAbs, oldFilePath)
        if (resolvedOldFile) {
          remove.run(listRootKey, resolvedOldFile.key)
          if (resolvedOldFile.keyRaw) remove.run(listRootKey, resolvedOldFile.keyRaw)
          if (legacyListRoot && resolvedOldFile.legacyAbs) {
            remove.run(legacyListRoot, resolvedOldFile.legacyAbs)
          }
        }
      }
      if (legacyListRoot && resolvedFile.legacyAbs) {
        remove.run(legacyListRoot, resolvedFile.legacyAbs)
      }
      if (resolvedFile.keyRaw) {
        remove.run(listRootKey, resolvedFile.keyRaw)
      }
      const absFilePath = resolveAbsoluteFilePath(listRootKey, fileKey)
      const infoJson = normalizeInfoJsonFilePath(
        JSON.stringify(normalizeSongCacheInfoForStorage(entry.info, absFilePath)),
        absFilePath
      )
      insert.run(listRootKey, fileKey, entry.size, entry.mtimeMs, infoJson)
    })
    run()
    markPlaylistViewSnapshotContentStale(listRootKey)
    return true
  } catch (error) {
    log.error('[sqlite] song cache upsert failed', error)
    return false
  }
}

export async function updateSongCacheTimeBasisOffset(
  listRoot: string,
  filePath: string,
  timeBasisOffsetMs: number,
  algorithmVersion: number
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  const normalizedOffset = Number(timeBasisOffsetMs)
  if (!Number.isFinite(normalizedOffset) || normalizedOffset < 0) return false
  const normalizedAlgorithmVersion = Math.floor(Number(algorithmVersion))
  if (!Number.isFinite(normalizedAlgorithmVersion) || normalizedAlgorithmVersion <= 0) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return false
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  const candidates: Array<{ listRoot: string; filePath: string }> = [
    { listRoot: listRootKey, filePath: resolvedFile.key }
  ]
  if (resolvedFile.keyRaw) {
    candidates.push({ listRoot: listRootKey, filePath: resolvedFile.keyRaw })
  }
  if (legacyListRoot && resolvedFile.legacyAbs) {
    candidates.push({ listRoot: legacyListRoot, filePath: resolvedFile.legacyAbs })
  }
  try {
    await ensureSongCacheMigrated(db, listRoot)
    const update = db.prepare(
      "UPDATE song_cache SET info_json = json_set(info_json, '$.timeBasisOffsetMs', ?, '$.timeBasisOffsetAlgorithmVersion', ?) WHERE list_root = ? AND file_path = ?"
    )
    for (const candidate of candidates) {
      const result = update.run(
        Number(normalizedOffset.toFixed(3)),
        normalizedAlgorithmVersion,
        candidate.listRoot,
        candidate.filePath
      )
      if (Number(result?.changes || 0) > 0) {
        markPlaylistViewSnapshotContentStale(listRootKey)
        return true
      }
    }
    return false
  } catch (error) {
    log.error('[sqlite] song cache time basis update failed', error)
    return false
  }
}

export async function removeSongCacheEntry(listRoot: string, filePath: string): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return false
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    await ensureSongCacheMigrated(db, listRoot)
    db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?').run(
      listRootKey,
      resolvedFile.key
    )
    if (resolvedFile.keyRaw) {
      db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?').run(
        listRootKey,
        resolvedFile.keyRaw
      )
    }
    if (legacyListRoot && resolvedFile.legacyAbs) {
      db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?').run(
        legacyListRoot,
        resolvedFile.legacyAbs
      )
    }
    markPlaylistViewSnapshotContentStale(listRootKey)
    return true
  } catch (error) {
    log.error('[sqlite] song cache delete failed', error)
    return false
  }
}
