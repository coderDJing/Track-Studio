import { getLibraryDb } from '../libraryDb'
import type { SqliteDatabase } from '../libraryDb'
import { log } from '../log'
import { isPackagedRcBuild } from '../services/rcDiagnostics'
import { runTracedSync } from '../services/mainProcessActivityTraceState'
import type { ISongInfo } from '../../types/globals'
import type { SongCacheEntry } from './types'
import {
  toNumber,
  resolveListRootInput,
  resolveFilePathInput,
  resolveAbsoluteListRoot,
  resolveAbsoluteFilePath
} from './pathResolvers'

type SongCacheDbRow = {
  file_path?: string
  size?: unknown
  mtime_ms?: unknown
  info_json?: unknown
}

type SongCacheLoadHelpers = {
  ensureMigrated: (db: SqliteDatabase, listRoot: string) => Promise<void>
  findLooseRoots: (
    db: SqliteDatabase,
    candidates: Array<string | null | undefined>,
    listRootKey: string
  ) => string[]
  migrateRows: (
    db: SqliteDatabase,
    oldListRoot: string,
    newListRootKey: string,
    listRootAbs: string
  ) => number
}

const SLOW_SONG_CACHE_LOAD_MS = 500

/**
 * 全量 song_cache 读取。RC 只在超过阈值时记录阶段耗时、根目录和行数；
 * 确认慢加载根因并连续验证不再超阈值后，删除下面的诊断日志。
 */
export async function loadSongCacheWithHelpers(
  listRoot: string,
  helpers: SongCacheLoadHelpers
): Promise<Map<string, SongCacheEntry> | null> {
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
  const startedAt = performance.now()
  let migrationMs = 0
  let selectMs = 0
  let appendMs = 0
  let looseRootsMs = 0
  let legacyMigrationMs = 0
  let selectedRows = 0
  let legacyRowsCount = 0
  let looseRootCount = 0
  try {
    const migrationStartedAt = performance.now()
    await helpers.ensureMigrated(db, listRoot)
    migrationMs = performance.now() - migrationStartedAt
    // 迁移 await 后的 SQLite 读取与 JSON.parse 都是同步操作，保留主线程活动埋点。
    const syncStartedAt = performance.now()
    const map = runTracedSync('sqlite:song-cache-load', () => {
      const loaded = new Map<string, SongCacheEntry>()
      const appendRows = (rowsToUse: SongCacheDbRow[], rootKey: string, legacyRelRoot?: string) => {
        const appendStartedAt = performance.now()
        try {
          for (const row of rowsToUse) {
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
            loaded.set(absFilePath, { size, mtimeMs, info })
          }
        } finally {
          appendMs += performance.now() - appendStartedAt
        }
      }
      const selectStartedAt = performance.now()
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
      selectMs = performance.now() - selectStartedAt
      selectedRows = rows.length
      legacyRowsCount = legacyRows.length
      const looseStartedAt = performance.now()
      const appendBeforeLoose = appendMs
      const looseRoots =
        rows.length === 0 && legacyRows.length === 0
          ? helpers
              .findLooseRoots(db, [listRoot, listRootAbs, listRootKey], listRootKey)
              .filter((root) => root !== listRootKey && root !== legacyListRoot)
          : []
      looseRootCount = looseRoots.length
      if (looseRoots.length > 0) {
        const extraStmt = db.prepare<SongCacheDbRow>(
          'SELECT file_path, size, mtime_ms, info_json FROM song_cache WHERE list_root = ?'
        )
        for (const root of looseRoots) {
          const extraRows = extraStmt.all(root)
          if (extraRows && extraRows.length > 0) {
            appendRows(extraRows, root, listRootAbs)
            if (resolvedRoot.isRelativeKey && listRootAbs) {
              helpers.migrateRows(db, root, listRootKey, listRootAbs)
            }
          }
        }
      }
      looseRootsMs = Math.max(
        0,
        performance.now() - looseStartedAt - (appendMs - appendBeforeLoose)
      )
      appendRows(rows, listRootKey)
      if (legacyRows && legacyRows.length > 0 && legacyListRoot && listRootAbs) {
        appendRows(legacyRows, legacyListRoot, legacyListRoot)
        if (resolvedRoot.isRelativeKey) {
          const legacyMigrationStartedAt = performance.now()
          helpers.migrateRows(db, legacyListRoot, listRootKey, listRootAbs)
          legacyMigrationMs = performance.now() - legacyMigrationStartedAt
        }
      }
      return loaded
    })
    const syncMs = performance.now() - syncStartedAt
    const elapsedMs = performance.now() - startedAt
    if (elapsedMs >= SLOW_SONG_CACHE_LOAD_MS && process.type === 'browser' && isPackagedRcBuild()) {
      log.warn('[sqlite] slow song cache load', {
        listRoot: listRootKey,
        elapsedMs: Math.round(elapsedMs),
        migrationMs: Math.round(migrationMs),
        syncMs: Math.round(syncMs),
        selectMs: Math.round(selectMs),
        appendMs: Math.round(appendMs),
        looseRootsMs: Math.round(looseRootsMs),
        legacyMigrationMs: Math.round(legacyMigrationMs),
        selectedRows,
        legacyRows: legacyRowsCount,
        looseRoots: looseRootCount,
        entries: map.size
      })
    }
    return map
  } catch (error) {
    log.error('[sqlite] song cache load failed', error)
    return null
  }
}
