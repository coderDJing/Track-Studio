import { registerFilePathComparison } from './filePathComparison'
import type { SqliteDatabase } from './libraryDb'
import {
  applyCuratedLibrarySyncSchema,
  CURATED_LIBRARY_SYNC_SCHEMA_VERSION
} from './curatedLibrarySync/schema'

export { CURATED_LIBRARY_SYNC_SCHEMA_VERSION }

const getSchemaVersion = (db: SqliteDatabase): number => {
  const version = Number(db.pragma('user_version', { simple: true }))
  return Number.isFinite(version) && version >= 0 ? Math.floor(version) : 0
}

export type CuratedLibrarySyncSchemaMigrationResult = {
  migrated: boolean
  databaseVersion: number
}

export const migrateLibrarySchemaV39ToV40 = async (
  databasePath: string
): Promise<CuratedLibrarySyncSchemaMigrationResult> => {
  const normalizedPath = String(databasePath || '').trim()
  if (!normalizedPath) throw new Error('音乐库路径不能为空')

  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(normalizedPath, { fileMustExist: true })
  registerFilePathComparison(db)
  try {
    const databaseVersion = getSchemaVersion(db)
    if (databaseVersion !== 39) {
      return { migrated: false, databaseVersion }
    }
    db.transaction(() => {
      applyCuratedLibrarySyncSchema(db)
      db.pragma(`user_version = ${CURATED_LIBRARY_SYNC_SCHEMA_VERSION}`)
    })()
    const nextVersion = getSchemaVersion(db)
    if (nextVersion !== CURATED_LIBRARY_SYNC_SCHEMA_VERSION) {
      throw new Error(
        `精选库同步 schema 升级后版本异常：期望 ${CURATED_LIBRARY_SYNC_SCHEMA_VERSION}，实际 ${nextVersion}`
      )
    }
    return { migrated: true, databaseVersion: nextVersion }
  } finally {
    db.close()
  }
}
