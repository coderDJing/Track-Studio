import { registerFilePathComparison } from './filePathComparison'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  migrateSongBeatGridMapV2Database,
  type SongBeatGridMapV2DatabaseMigrationReport
} from './libraryCacheDb/songBeatGridMapV2DatabaseMigration'

export const SONG_BEAT_GRID_V2_SCHEMA_VERSION = 36

export type LibrarySchemaV36MigrationPhase =
  | 'checking-version'
  | 'checking-space'
  | 'creating-backup'
  | 'converting'
  | 'restoring-time-basis'
  | 'validating'
  | 'complete'
  | 'failed'

export type LibrarySchemaV36MigrationProgress = {
  phase: LibrarySchemaV36MigrationPhase
  databasePath: string
  backupPath?: string
  message?: string
  processedRows?: number
  totalRows?: number
  processedPages?: number
  totalPages?: number
}

const MINIMUM_RESERVE_BYTES = 64 * 1024 * 1024
const MIGRATION_OVERHEAD_BYTES = 16 * 1024 * 1024

type BackupCapableDatabase = InstanceType<typeof import('better-sqlite3')> & {
  backup: (
    databasePath: string,
    options?: {
      progress: (info: { totalPages: number; remainingPages: number }) => number
    }
  ) => Promise<{ totalPages: number; remainingPages: number }>
}

export class LibrarySchemaV36MigrationError extends Error {
  constructor(
    readonly code:
      'CAPACITY_UNAVAILABLE' | 'INSUFFICIENT_SPACE' | 'BACKUP_EXISTS' | 'BACKUP_UNAVAILABLE',
    message: string
  ) {
    super(message)
    this.name = 'LibrarySchemaV36MigrationError'
  }
}

const getSchemaVersion = (db: InstanceType<typeof import('better-sqlite3')>): number => {
  const version = Number(db.pragma('user_version', { simple: true }))
  return Number.isFinite(version) && version >= 0 ? Math.floor(version) : 0
}

export const getLibrarySchemaV36ReserveBytes = (
  db: InstanceType<typeof import('better-sqlite3')>
): number => {
  const pageSize = Number(db.pragma('page_size', { simple: true }))
  const pageCount = Number(db.pragma('page_count', { simple: true }))
  const logicalBytes =
    Number.isFinite(pageSize) && Number.isFinite(pageCount) ? Math.max(0, pageSize * pageCount) : 0
  return Math.max(MINIMUM_RESERVE_BYTES, Math.ceil(logicalBytes * 3 + MIGRATION_OVERHEAD_BYTES))
}

export const getLibrarySchemaMigrationAvailableBytes = async (
  directory: string
): Promise<number> => {
  try {
    const stats = await fs.statfs(directory)
    const availableBytes = Number(stats.bavail) * Number(stats.bsize)
    if (Number.isFinite(availableBytes) && availableBytes >= 0) return availableBytes
  } catch {}
  throw new LibrarySchemaV36MigrationError('CAPACITY_UNAVAILABLE', '无法读取音乐库磁盘可用空间')
}

export type LibrarySchemaV36MigrationResult = {
  migrated: boolean
  databaseVersion: number
  backupPath?: string
  report?: SongBeatGridMapV2DatabaseMigrationReport
}

export const migrateLibrarySchemaV35ToV36 = async (
  databasePath: string,
  options: {
    getAvailableBytes?: (directory: string) => Promise<number>
    backupPath?: string
    onProgress?: (progress: LibrarySchemaV36MigrationProgress) => void
  } = {}
): Promise<LibrarySchemaV36MigrationResult> => {
  const normalizedPath = String(databasePath || '').trim()
  if (!normalizedPath) throw new Error('音乐库路径不能为空')
  const reportProgress = (
    phase: LibrarySchemaV36MigrationPhase,
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
    if (databaseVersion !== 35) return { migrated: false, databaseVersion }

    const directory = path.dirname(normalizedPath)
    const reserveBytes = getLibrarySchemaV36ReserveBytes(db)
    reportProgress('checking-space')
    const availableBytes = await (
      options.getAvailableBytes || getLibrarySchemaMigrationAvailableBytes
    )(directory)
    if (availableBytes < reserveBytes) {
      throw new LibrarySchemaV36MigrationError(
        'INSUFFICIENT_SPACE',
        `磁盘可用空间不足：需要 ${reserveBytes} 字节，当前可用 ${availableBytes} 字节`
      )
    }

    backupPath = options.backupPath || path.join(directory, '.frkb-schema-v35-to-v36-backup.sqlite')
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
          processedPages: Math.max(0, safeTotalPages - safeRemainingPages),
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
    const report = db.transaction(() => {
      const nextReport = migrateSongBeatGridMapV2Database(db, {
        transactional: false,
        onProgress: ({ processedRows, totalRows }) =>
          reportProgress('converting', { backupPath, processedRows, totalRows })
      })
      db.pragma(`user_version = ${SONG_BEAT_GRID_V2_SCHEMA_VERSION}`)
      return nextReport
    })()
    reportProgress('validating', { backupPath })
    if (getSchemaVersion(db) !== SONG_BEAT_GRID_V2_SCHEMA_VERSION) {
      throw new Error('音乐库版本写入校验失败')
    }
    migrationValidated = true
    reportProgress('complete', { backupPath })
    return {
      migrated: true,
      databaseVersion: SONG_BEAT_GRID_V2_SCHEMA_VERSION,
      backupPath,
      report
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
