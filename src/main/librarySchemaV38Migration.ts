import { registerFilePathComparison } from './filePathComparison'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { SqliteDatabase } from './libraryDb'

export const REKORDBOX_EXTERNAL_CACHE_CLEANUP_SCHEMA_VERSION = 39

type BackupCapableDatabase = InstanceType<typeof import('better-sqlite3')> & {
  backup: (databasePath: string) => Promise<unknown>
}

const getSchemaVersion = (db: SqliteDatabase): number => {
  const version = Number(db.pragma('user_version', { simple: true }))
  return Number.isFinite(version) && version >= 0 ? Math.floor(version) : 0
}

const hasTable = (db: SqliteDatabase, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName)
  )

const countRows = (db: SqliteDatabase, sql: string): number => {
  const row = db.prepare(sql).get() as { count?: unknown } | undefined
  const count = Number(row?.count)
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0
}

const assertDatabaseQuickCheck = (db: SqliteDatabase, label: string): void => {
  const result = String(db.pragma('quick_check(1)', { simple: true }) || '')
  if (result.toLowerCase() !== 'ok') {
    throw new Error(`${label} SQLite 完整性校验失败：${result || 'unknown result'}`)
  }
}

type BackupInspection = {
  exists: boolean
  valid: boolean
  error?: string
}

const hasPath = async (filePath: string): Promise<boolean> => {
  try {
    await fs.stat(filePath)
    return true
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return false
    throw error
  }
}

const inspectBackupQuickCheck = (
  Database: typeof import('better-sqlite3'),
  backupPath: string
): Promise<BackupInspection> => {
  return (async () => {
    if (!(await hasPath(backupPath))) return { exists: false, valid: false }
    try {
      const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true })
      registerFilePathComparison(backupDb)
      try {
        assertDatabaseQuickCheck(backupDb, '迁移备份')
        return { exists: true, valid: true }
      } finally {
        backupDb.close()
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'ENOENT') return { exists: false, valid: false }
      return {
        exists: true,
        valid: false,
        error: error instanceof Error ? error.message : String(error || 'unknown error')
      }
    }
  })()
}

const removeInterruptedBackupArtifacts = async (backupPath: string): Promise<void> => {
  await Promise.all([
    fs.rm(backupPath, { force: true }),
    fs.rm(`${backupPath}-journal`, { force: true })
  ])
}

const prepareV38ToV39Backup = async (params: {
  db: BackupCapableDatabase
  Database: typeof import('better-sqlite3')
  backupPath: string
}): Promise<{ recoveredInterruptedBackup: boolean; discardedInvalidBackupArtifacts: boolean }> => {
  const { db, Database, backupPath } = params
  const replacementPath = `${backupPath}.recovery-next`
  const existingBackup = await inspectBackupQuickCheck(Database, backupPath)
  const replacementBackup = await inspectBackupQuickCheck(Database, replacementPath)
  const replacementJournalExists = await hasPath(`${replacementPath}-journal`)
  const hasInterruptedArtifacts =
    existingBackup.exists || replacementBackup.exists || replacementJournalExists
  if (!hasInterruptedArtifacts) {
    await db.backup(backupPath)
    return { recoveredInterruptedBackup: false, discardedInvalidBackupArtifacts: false }
  }

  // 主库仍为 V38 时，清理和版本写入所在事务必然没有提交。仅在主库完整时继续；
  // 无效的 backup / recovery-next 只可能是被中断的备份副本，不是用户数据源。
  assertDatabaseQuickCheck(db, '当前 V38 主库')
  let discardedInvalidBackupArtifacts = false
  if (existingBackup.exists && !existingBackup.valid) {
    await removeInterruptedBackupArtifacts(backupPath)
    discardedInvalidBackupArtifacts = true
  }
  if ((replacementBackup.exists && !replacementBackup.valid) || replacementJournalExists) {
    await removeInterruptedBackupArtifacts(replacementPath)
    discardedInvalidBackupArtifacts = true
  }

  const usableReplacement = await inspectBackupQuickCheck(Database, replacementPath)
  if (!usableReplacement.valid) {
    await db.backup(replacementPath)
    const createdReplacement = await inspectBackupQuickCheck(Database, replacementPath)
    if (!createdReplacement.valid) {
      throw new Error(`新的 V38 迁移备份校验失败：${createdReplacement.error || 'unknown error'}`)
    }
  }
  // 有效旧备份始终保留到新的替代备份已通过校验；之后才原子接管标准备份路径。
  await fs.rm(backupPath, { force: true })
  await fs.rename(replacementPath, backupPath)
  return { recoveredInterruptedBackup: true, discardedInvalidBackupArtifacts }
}

export type RekordboxExternalCacheCleanupResult = {
  migrated: boolean
  databaseVersion: number
  removedExternalAnalysisRows: number
  removedExternalDeviceRows: number
  removedPreviewWaveformRows: number
  backupPath?: string
  recoveredInterruptedBackup?: boolean
  discardedInvalidBackupArtifacts?: boolean
}

export const migrateLibrarySchemaV38ToV39 = async (
  databasePath: string,
  options: { backupPath?: string } = {}
): Promise<RekordboxExternalCacheCleanupResult> => {
  const normalizedPath = String(databasePath || '').trim()
  if (!normalizedPath) throw new Error('音乐库路径不能为空')

  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(normalizedPath, { fileMustExist: true }) as BackupCapableDatabase
  registerFilePathComparison(db)
  let backupPath = ''
  let migrationValidated = false
  let recoveredInterruptedBackup = false
  let discardedInvalidBackupArtifacts = false
  try {
    const databaseVersion = getSchemaVersion(db)
    if (databaseVersion !== 38) {
      return {
        migrated: false,
        databaseVersion,
        removedExternalAnalysisRows: 0,
        removedExternalDeviceRows: 0,
        removedPreviewWaveformRows: 0
      }
    }
    if (typeof db.backup !== 'function') {
      throw new Error('当前 SQLite 运行时不支持一致性备份')
    }

    backupPath =
      options.backupPath ||
      path.join(path.dirname(normalizedPath), '.frkb-schema-v38-to-v39-backup.sqlite')
    const backupPreparation = await prepareV38ToV39Backup({ db, Database, backupPath })
    recoveredInterruptedBackup = backupPreparation.recoveredInterruptedBackup
    discardedInvalidBackupArtifacts = backupPreparation.discardedInvalidBackupArtifacts

    const removedExternalAnalysisRows = hasTable(db, 'external_analysis_cache')
      ? countRows(
          db,
          "SELECT COUNT(*) AS count FROM external_analysis_cache WHERE source_kind IN ('rekordbox-usb', 'rekordbox-desktop')"
        )
      : 0
    const removedExternalDeviceRows = hasTable(db, 'external_analysis_devices')
      ? countRows(
          db,
          "SELECT COUNT(*) AS count FROM external_analysis_devices WHERE source_kind IN ('rekordbox-usb', 'rekordbox-desktop')"
        )
      : 0
    const removedPreviewWaveformRows = hasTable(db, 'pioneer_preview_waveform_cache')
      ? countRows(db, 'SELECT COUNT(*) AS count FROM pioneer_preview_waveform_cache')
      : 0

    db.transaction(() => {
      if (hasTable(db, 'external_analysis_cache')) {
        db.prepare(
          "DELETE FROM external_analysis_cache WHERE source_kind IN ('rekordbox-usb', 'rekordbox-desktop')"
        ).run()
      }
      if (hasTable(db, 'external_analysis_devices')) {
        db.prepare(
          "DELETE FROM external_analysis_devices WHERE source_kind IN ('rekordbox-usb', 'rekordbox-desktop')"
        ).run()
      }
      if (hasTable(db, 'pioneer_preview_waveform_cache')) {
        db.prepare('DELETE FROM pioneer_preview_waveform_cache').run()
      }
      const remainingExternalAnalysisRows = hasTable(db, 'external_analysis_cache')
        ? countRows(
            db,
            "SELECT COUNT(*) AS count FROM external_analysis_cache WHERE source_kind IN ('rekordbox-usb', 'rekordbox-desktop')"
          )
        : 0
      const remainingExternalDeviceRows = hasTable(db, 'external_analysis_devices')
        ? countRows(
            db,
            "SELECT COUNT(*) AS count FROM external_analysis_devices WHERE source_kind IN ('rekordbox-usb', 'rekordbox-desktop')"
          )
        : 0
      const remainingPreviewWaveformRows = hasTable(db, 'pioneer_preview_waveform_cache')
        ? countRows(db, 'SELECT COUNT(*) AS count FROM pioneer_preview_waveform_cache')
        : 0
      if (
        remainingExternalAnalysisRows > 0 ||
        remainingExternalDeviceRows > 0 ||
        remainingPreviewWaveformRows > 0
      ) {
        throw new Error('Rekordbox 外部缓存清理后校验未归零')
      }
      db.pragma(`user_version = ${REKORDBOX_EXTERNAL_CACHE_CLEANUP_SCHEMA_VERSION}`)
    })()

    if (getSchemaVersion(db) !== REKORDBOX_EXTERNAL_CACHE_CLEANUP_SCHEMA_VERSION) {
      throw new Error('Rekordbox 外部缓存清理版本写入校验失败')
    }
    migrationValidated = true
    return {
      migrated: true,
      databaseVersion: REKORDBOX_EXTERNAL_CACHE_CLEANUP_SCHEMA_VERSION,
      removedExternalAnalysisRows,
      removedExternalDeviceRows,
      removedPreviewWaveformRows,
      backupPath,
      recoveredInterruptedBackup,
      discardedInvalidBackupArtifacts
    }
  } finally {
    db.close()
    if (backupPath && migrationValidated) {
      await fs.rm(backupPath, { force: true }).catch(() => {})
    }
  }
}
