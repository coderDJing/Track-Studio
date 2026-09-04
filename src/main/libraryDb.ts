import path = require('path')
import fs = require('fs-extra')
import store from './store'
import { log } from './log'
import {
  assertRegisteredLibraryMetadataKey,
  LibraryMetadataContractError
} from '../shared/libraryMetadataContracts'
import {
  assertLibraryMergeParticipantCoverage,
  LibraryMergeParticipantContractError
} from './services/libraryMerge/participants'
import { applyLibraryDbSchema } from './libraryDbSchema'
import { runTracedSync } from './services/mainProcessActivityTraceState'

const DB_FILE_NAME = 'FRKB.database.sqlite'
const SCHEMA_VERSION = 39
export const MAX_SUPPORTED_DATABASE_SCHEMA_VERSION = 40

type SqliteDatabaseCtor = typeof import('better-sqlite3')

export type SqliteDatabase = InstanceType<SqliteDatabaseCtor>
type SqliteRow = Record<string, unknown>

export class DatabaseSchemaVersionError extends Error {
  readonly databasePath: string
  readonly databaseVersion: number
  readonly maximumSupportedVersion: number

  constructor(databasePath: string, databaseVersion: number, maximumSupportedVersion: number) {
    super(
      `音乐库版本 ${databaseVersion} 高于当前软件支持上限 ${maximumSupportedVersion}：${databasePath}`
    )
    this.name = 'DatabaseSchemaVersionError'
    this.databasePath = databasePath
    this.databaseVersion = databaseVersion
    this.maximumSupportedVersion = maximumSupportedVersion
  }
}

export class DatabaseSchemaMigrationRequiredError extends Error {
  constructor(
    readonly databasePath: string,
    readonly databaseVersion: number
  ) {
    super(`音乐库需要先完成受保护升级：${databasePath}（当前版本 ${databaseVersion}）`)
    this.name = 'DatabaseSchemaMigrationRequiredError'
  }
}

export const isDatabaseSchemaVersionError = (error: unknown): error is DatabaseSchemaVersionError =>
  error instanceof DatabaseSchemaVersionError

const isDatabaseSchemaMigrationRequiredError = (
  error: unknown
): error is DatabaseSchemaMigrationRequiredError =>
  error instanceof DatabaseSchemaMigrationRequiredError

export function isSqliteRow(value: unknown): value is SqliteRow {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

let db: SqliteDatabase | null = null
let dbRoot: string | null = null

const isConfiguredDevDatabase = (dirPath: string): boolean => {
  if (process.env.FRKB_APP_PACKAGED === '1') return false
  const configured = String(process.env.FRKB_DEV_DATABASE_URL || '').trim()
  if (!configured || !dirPath) return false
  const current = path.resolve(dirPath)
  const expected = path.resolve(configured)
  return process.platform === 'win32'
    ? current.toLocaleLowerCase() === expected.toLocaleLowerCase()
    : current === expected
}

function assertStoredMetadataContracts(dbInstance: SqliteDatabase): void {
  const rows = dbInstance.prepare('SELECT key FROM meta ORDER BY key ASC').all() as Array<{
    key?: unknown
  }>
  for (const row of rows) {
    assertRegisteredLibraryMetadataKey(typeof row.key === 'string' ? row.key : '')
  }
}

const readDatabaseSchemaVersion = (dbInstance: SqliteDatabase): number => {
  const value = Number(dbInstance.pragma('user_version', { simple: true }))
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

const assertSupportedDatabaseSchemaVersion = (dbPath: string, userVersion: number): void => {
  if (userVersion > MAX_SUPPORTED_DATABASE_SCHEMA_VERSION) {
    throw new DatabaseSchemaVersionError(dbPath, userVersion, MAX_SUPPORTED_DATABASE_SCHEMA_VERSION)
  }
}

// 只读预检必须发生在任何 WAL、迁移或业务查询之前。
export function assertExistingDatabaseSchemaSupported(dbPath: string): number {
  const normalizedPath = String(dbPath || '').trim()
  if (!normalizedPath) throw new Error('音乐库路径不能为空')
  const Database = require('better-sqlite3') as SqliteDatabaseCtor
  const instance = new Database(normalizedPath, { readonly: true, fileMustExist: true })
  try {
    const userVersion = readDatabaseSchemaVersion(instance)
    assertSupportedDatabaseSchemaVersion(normalizedPath, userVersion)
    return userVersion
  } finally {
    instance.close()
  }
}

function createDatabase(dbPath: string): SqliteDatabase {
  const Database = require('better-sqlite3') as SqliteDatabaseCtor
  const instance = new Database(dbPath)
  const userVersion = readDatabaseSchemaVersion(instance)
  try {
    assertSupportedDatabaseSchemaVersion(dbPath, userVersion)
    if (userVersion > 0 && userVersion < SCHEMA_VERSION) {
      throw new DatabaseSchemaMigrationRequiredError(dbPath, userVersion)
    }
  } catch (error) {
    instance.close()
    throw error
  }
  applyLibraryDbSchema(instance, userVersion)
  if (userVersion < SCHEMA_VERSION) {
    instance.pragma('user_version = ' + SCHEMA_VERSION)
  }
  try {
    assertLibraryMergeParticipantCoverage(instance)
    if (isConfiguredDevDatabase(path.dirname(dbPath))) {
      assertStoredMetadataContracts(instance)
    }
  } catch (error) {
    try {
      instance.close()
    } catch {}
    throw error
  }
  return instance
}

export function getLibraryDbPath(dirPath: string): string {
  return path.join(dirPath, DB_FILE_NAME)
}

const checkpointWal = (instance: SqliteDatabase): void => {
  runTracedSync('sqlite:wal_checkpoint', () => {
    instance.pragma('wal_checkpoint(TRUNCATE)')
  })
}

// 用于不会成为当前活动库的隔离数据库副本。它复用正式 schema 迁移，但不会读写
// store、切换全局连接或影响正在使用的库。
export function migrateStandaloneLibraryDb(dbPath: string): void {
  const normalizedPath = String(dbPath || '').trim()
  if (!normalizedPath) throw new Error('音乐库快照路径不能为空')
  const instance = runTracedSync('sqlite:createDatabase', () => createDatabase(normalizedPath))
  try {
    checkpointWal(instance)
  } finally {
    instance.close()
  }
}

export function initLibraryDb(dirPath: string): SqliteDatabase | null {
  if (!dirPath) return null
  // 打开既有库不能产生任何文件。启动时设置里可能仍保留一个已被手动删除的库路径；
  // 若在这里补建根目录或 SQLite，后续启动检查就会把丢失的库误判为可修复的空库。
  const libraryDirPath = path.join(dirPath, 'library')
  if (!fs.pathExistsSync(dirPath) || !fs.pathExistsSync(libraryDirPath)) return null
  if (db && dbRoot === dirPath) return db
  try {
    closeLibraryDb()
    db = runTracedSync('sqlite:createDatabase', () => createDatabase(getLibraryDbPath(dirPath)))
    dbRoot = dirPath
    return db
  } catch (error) {
    db = null
    dbRoot = dirPath
    log.error('[sqlite] init failed', error)
    if (
      isDatabaseSchemaVersionError(error) ||
      isDatabaseSchemaMigrationRequiredError(error) ||
      (isConfiguredDevDatabase(dirPath) &&
        (error instanceof LibraryMergeParticipantContractError ||
          error instanceof LibraryMetadataContractError))
    ) {
      throw error
    }
    return null
  }
}

// 注意：初始化失败后，每次调用都会重试（包括完整的迁移流程）。
// 这是故意的设计：用户修复问题后能立即恢复，无需等待重试间隔。
export function getLibraryDb(): SqliteDatabase | null {
  const dir = store.databaseDir || store.settingConfig?.databaseUrl || ''
  if (!dir) return null
  return initLibraryDb(dir)
}

export function closeLibraryDb(): void {
  if (db) {
    try {
      checkpointWal(db)
    } catch {}
    try {
      db.close()
    } catch {}
  }
  db = null
  dbRoot = null
}

export function getMetaValue(dbInstance: SqliteDatabase, key: string): string | null {
  try {
    const row = dbInstance
      .prepare<{ value?: string }>('SELECT value FROM meta WHERE key = ?')
      .get(key)
    return row ? String(row.value) : null
  } catch {
    return null
  }
}

export function setMetaValue(dbInstance: SqliteDatabase, key: string, value: string): void {
  const normalizedKey = String(key || '').trim()
  try {
    assertRegisteredLibraryMetadataKey(normalizedKey)
  } catch (error) {
    log.error('[sqlite] unregistered metadata key', error)
    throw error
  }
  try {
    dbInstance
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(normalizedKey, value)
  } catch {}
}
