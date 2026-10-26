import { registerFilePathComparison } from './filePathComparison'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { SqliteDatabase } from './libraryDb'
import { normalizeSongBeatGridMapV2 } from '../shared/songBeatGridMapV2'
import {
  CURRENT_AUDIO_TIME_BASIS_OFFSET_ALGORITHM_VERSION,
  resolveAudioTimeBasisOffsetMsForFile
} from './services/audioTimeBasisOffset'
import {
  getLibrarySchemaMigrationAvailableBytes,
  getLibrarySchemaV36ReserveBytes,
  LibrarySchemaV36MigrationError,
  type LibrarySchemaV36MigrationProgress
} from './librarySchemaV36Migration'

export const SONG_TIME_BASIS_REPAIR_SCHEMA_VERSION = 38

type BackupCapableDatabase = InstanceType<typeof import('better-sqlite3')> & {
  backup: (
    databasePath: string,
    options?: {
      progress: (info: { totalPages: number; remainingPages: number }) => number
    }
  ) => Promise<{ totalPages: number; remainingPages: number }>
}

type CachedGridRow = {
  tableName: 'song_cache' | 'external_analysis_cache'
  rowid: number
  listRoot: string
  filePath: string
  json: string
}

type TimeBasisUpdate = {
  tableName: CachedGridRow['tableName']
  rowid: number
  json: string
}

const getSchemaVersion = (db: InstanceType<typeof import('better-sqlite3')>): number => {
  const version = Number(db.pragma('user_version', { simple: true }))
  return Number.isFinite(version) && version >= 0 ? Math.floor(version) : 0
}

const hasTable = (db: SqliteDatabase, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName)
  )

const loadGridRows = (db: SqliteDatabase, tableName: 'song_cache' | 'external_analysis_cache') => {
  if (!hasTable(db, tableName)) return [] as CachedGridRow[]
  const listRootSelect = tableName === 'song_cache' ? 'list_root' : "''"
  const rows = db
    .prepare(
      `SELECT rowid, ${listRootSelect} as listRoot, file_path as filePath, info_json as json FROM ${tableName}`
    )
    .all() as Omit<CachedGridRow, 'tableName'>[]
  return rows.map((row) => ({ ...row, tableName }))
}

const normalizeTimeBasisOffsetMs = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? Number(numeric.toFixed(3)) : null
}

const buildTimeBasisUpdates = async (
  databaseDirectory: string,
  rows: CachedGridRow[],
  resolveTimeBasisOffsetMs: (filePath: string) => Promise<number>,
  onProgress: (processedRows: number, totalRows: number) => void
) => {
  const updates: TimeBasisUpdate[] = []
  let processedRows = 0
  const totalRows = rows.length
  onProgress(processedRows, totalRows)
  for (const row of rows) {
    try {
      const info = JSON.parse(row.json) as Record<string, unknown>
      const beatGridMap = normalizeSongBeatGridMapV2(info.beatGridMap, { allowSingleClip: true })
      if (beatGridMap) {
        const filePath = String(row.filePath || '').trim()
        const listRoot = String(row.listRoot || '').trim()
        const resolvedFilePath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(databaseDirectory, listRoot, filePath)
        const fileExists = await fs
          .stat(resolvedFilePath)
          .then((stats) => stats.isFile())
          .catch(() => false)
        if (!fileExists) {
          processedRows += 1
          if (processedRows === totalRows || processedRows % 5 === 0) {
            onProgress(processedRows, totalRows)
          }
          continue
        }
        const timeBasisOffsetMs = normalizeTimeBasisOffsetMs(
          await resolveTimeBasisOffsetMs(resolvedFilePath)
        )
        if (timeBasisOffsetMs !== null) {
          updates.push({
            tableName: row.tableName,
            rowid: row.rowid,
            json: JSON.stringify({
              ...info,
              timeBasisOffsetMs,
              timeBasisOffsetAlgorithmVersion: CURRENT_AUDIO_TIME_BASIS_OFFSET_ALGORITHM_VERSION
            })
          })
        }
      }
    } catch {}
    processedRows += 1
    if (processedRows === totalRows || processedRows % 5 === 0) {
      onProgress(processedRows, totalRows)
    }
  }
  return updates
}

export type LibrarySchemaV38MigrationResult = {
  migrated: boolean
  databaseVersion: number
  restoredTimeBases: number
  backupPath?: string
}

export const migrateLibrarySchemaToV38 = async (
  databasePath: string,
  options: {
    getAvailableBytes?: (directory: string) => Promise<number>
    backupPath?: string
    resolveTimeBasisOffsetMs?: (filePath: string) => Promise<number>
    onProgress?: (progress: LibrarySchemaV36MigrationProgress) => void
  } = {}
): Promise<LibrarySchemaV38MigrationResult> => {
  const normalizedPath = String(databasePath || '').trim()
  if (!normalizedPath) throw new Error('音乐库路径不能为空')
  const reportProgress = (
    phase: LibrarySchemaV36MigrationProgress['phase'],
    details: Omit<LibrarySchemaV36MigrationProgress, 'phase' | 'databasePath'> = {}
  ) => options.onProgress?.({ phase, databasePath: normalizedPath, ...details })
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(normalizedPath, { fileMustExist: true }) as BackupCapableDatabase
  registerFilePathComparison(db)
  let backupPath = ''
  let migrationValidated = false
  try {
    reportProgress('checking-version')
    const databaseVersion = getSchemaVersion(db)
    if (databaseVersion !== 36 && databaseVersion !== 37) {
      return { migrated: false, databaseVersion, restoredTimeBases: 0 }
    }

    const directory = path.dirname(normalizedPath)
    reportProgress('checking-space')
    const availableBytes = await (
      options.getAvailableBytes || getLibrarySchemaMigrationAvailableBytes
    )(directory)
    const reserveBytes = getLibrarySchemaV36ReserveBytes(db)
    if (availableBytes < reserveBytes) {
      throw new LibrarySchemaV36MigrationError(
        'INSUFFICIENT_SPACE',
        `磁盘可用空间不足：需要 ${reserveBytes} 字节，当前可用 ${availableBytes} 字节`
      )
    }

    backupPath =
      options.backupPath || path.join(directory, '.frkb-schema-v36-or-v37-to-v38-backup.sqlite')
    reportProgress('creating-backup', { backupPath })
    try {
      await fs.access(backupPath)
      throw new LibrarySchemaV36MigrationError(
        'BACKUP_EXISTS',
        `检测到未处理的迁移备份：${backupPath}`
      )
    } catch (error) {
      if (error instanceof LibrarySchemaV36MigrationError) throw error
    }
    if (typeof db.backup !== 'function') {
      throw new LibrarySchemaV36MigrationError(
        'BACKUP_UNAVAILABLE',
        '当前 SQLite 运行时不支持一致性备份'
      )
    }
    const backupResult = await db.backup(backupPath, {
      progress: ({ totalPages, remainingPages }) => {
        const safeTotalPages = Math.max(0, Math.floor(Number(totalPages) || 0))
        const safeRemainingPages = Math.min(
          safeTotalPages,
          Math.max(0, Math.floor(Number(remainingPages) || 0))
        )
        reportProgress('creating-backup', {
          backupPath,
          processedPages: safeTotalPages - safeRemainingPages,
          totalPages: safeTotalPages
        })
        return 64
      }
    })
    reportProgress('creating-backup', {
      backupPath,
      processedPages: Math.max(0, Math.floor(Number(backupResult.totalPages) || 0)),
      totalPages: Math.max(0, Math.floor(Number(backupResult.totalPages) || 0))
    })

    const rows = [...loadGridRows(db, 'song_cache'), ...loadGridRows(db, 'external_analysis_cache')]
    const updates = await buildTimeBasisUpdates(
      directory,
      rows,
      options.resolveTimeBasisOffsetMs || resolveAudioTimeBasisOffsetMsForFile,
      (processedRows, totalRows) =>
        reportProgress('restoring-time-basis', { backupPath, processedRows, totalRows })
    )
    db.transaction(() => {
      const updateSongCache = db.prepare('UPDATE song_cache SET info_json = ? WHERE rowid = ?')
      const updateExternalCache = db.prepare(
        'UPDATE external_analysis_cache SET info_json = ? WHERE rowid = ?'
      )
      for (const update of updates) {
        const statement = update.tableName === 'song_cache' ? updateSongCache : updateExternalCache
        statement.run(update.json, update.rowid)
      }
      db.pragma(`user_version = ${SONG_TIME_BASIS_REPAIR_SCHEMA_VERSION}`)
    })()
    reportProgress('validating', { backupPath })
    if (getSchemaVersion(db) !== SONG_TIME_BASIS_REPAIR_SCHEMA_VERSION) {
      throw new Error('音乐库版本写入校验失败')
    }
    migrationValidated = true
    reportProgress('complete', { backupPath })
    return {
      migrated: true,
      databaseVersion: SONG_TIME_BASIS_REPAIR_SCHEMA_VERSION,
      restoredTimeBases: updates.length,
      backupPath
    }
  } catch (error) {
    reportProgress('failed', {
      backupPath: backupPath || undefined,
      message: error instanceof Error ? error.message : '音乐库升级失败'
    })
    throw error
  } finally {
    db.close()
    if (backupPath && migrationValidated) {
      await fs.rm(backupPath, { force: true }).catch(() => {})
    }
  }
}
