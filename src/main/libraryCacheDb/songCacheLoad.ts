import { getLibraryDb } from '../libraryDb'
import type { SqliteDatabase } from '../libraryDb'
import { log } from '../log'
import { readSongCacheOffMainThread } from '../services/songCacheReadWorker'
import type { SongCacheDbRow } from './songCacheRead'
import type { ISongInfo } from '../../types/globals'
import type { SongCacheEntry } from './types'
import {
  toNumber,
  resolveListRootInput,
  resolveFilePathInput,
  resolveAbsoluteListRoot,
  resolveAbsoluteFilePath
} from './pathResolvers'

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
  try {
    await helpers.ensureMigrated(db, listRoot)
    // 主进程只做路径映射；可能等待磁盘/锁的全量 SELECT 在只读 worker 中执行。
    const map = await (async () => {
      const loaded = new Map<string, SongCacheEntry>()
      const appendRows = (rowsToUse: SongCacheDbRow[], rootKey: string, legacyRelRoot?: string) => {
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
      }
      const [rows, legacyRows = []] = await readSongCacheOffMainThread(
        db,
        legacyListRoot ? [listRootKey, legacyListRoot] : [listRootKey]
      )
      // await 期间允许用户切库，不能把旧库结果按新库根目录映射或迁移。
      if (getLibraryDb() !== db) return null
      const looseRoots =
        rows.length === 0 && legacyRows.length === 0
          ? helpers
              .findLooseRoots(db, [listRoot, listRootAbs, listRootKey], listRootKey)
              .filter((root) => root !== listRootKey && root !== legacyListRoot)
          : []
      if (looseRoots.length > 0) {
        const extraBatches = await readSongCacheOffMainThread(db, looseRoots)
        if (getLibraryDb() !== db) return null
        for (const [index, root] of looseRoots.entries()) {
          const extraRows = extraBatches[index]
          if (extraRows && extraRows.length > 0) {
            appendRows(extraRows, root, listRootAbs)
            if (resolvedRoot.isRelativeKey && listRootAbs) {
              helpers.migrateRows(db, root, listRootKey, listRootAbs)
            }
          }
        }
      }
      appendRows(rows, listRootKey)
      if (legacyRows && legacyRows.length > 0 && legacyListRoot && listRootAbs) {
        appendRows(legacyRows, legacyListRoot, legacyListRoot)
        if (resolvedRoot.isRelativeKey) {
          helpers.migrateRows(db, legacyListRoot, listRootKey, listRootAbs)
        }
      }
      return loaded
    })()
    return map
  } catch (error) {
    log.error('[sqlite] song cache load failed', error)
    return null
  }
}
