import { registerFilePathComparison } from '../../filePathComparison'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertDistinctLibraryMergeRoots, buildLibraryMergePlan } from './plan'
import { createUpgradedSourceSchemaSnapshot } from './sourceSchemaSnapshot'
import type {
  LibraryMergeDuplicatePlaylistPolicy,
  LibraryMergePlanSummary,
  LibraryMergeScope
} from './types'

type SqliteDatabase = InstanceType<typeof import('better-sqlite3')>

const DB_FILE_NAME = 'FRKB.database.sqlite'
const PREFLIGHT_WORK_DIR_NAME = '.frkb-merge-preflight'

const getDatabaseCtor = (): typeof import('better-sqlite3') =>
  require('better-sqlite3') as typeof import('better-sqlite3')

const closeDb = (db: SqliteDatabase | null): void => {
  try {
    db?.close()
  } catch {}
}

export async function inspectLibraryMergeSource(params: {
  sourceRoot: string
  targetRoot: string
  appVersion?: string
  scope?: LibraryMergeScope
  duplicatePlaylistPolicy?: LibraryMergeDuplicatePlaylistPolicy
}): Promise<LibraryMergePlanSummary> {
  const scope: LibraryMergeScope = params.scope === 'curated' ? 'curated' : 'full'
  const sourceRoot = path.resolve(params.sourceRoot)
  const targetRoot = path.resolve(params.targetRoot)
  await assertDistinctLibraryMergeRoots(sourceRoot, targetRoot)
  const Database = getDatabaseCtor()
  let sourceDb: SqliteDatabase | null = new Database(path.join(sourceRoot, DB_FILE_NAME), {
    readonly: true,
    fileMustExist: true
  })
  registerFilePathComparison(sourceDb)
  // Inspect is read-only planning: open the live target library without write intent so
  // concurrent app readers are less likely to contend while integrity checks run.
  const targetDb = new Database(path.join(targetRoot, DB_FILE_NAME), {
    readonly: true,
    fileMustExist: true
  })
  registerFilePathComparison(targetDb)
  const workspaceDir = path.join(targetRoot, PREFLIGHT_WORK_DIR_NAME, randomUUID())
  targetDb.pragma('foreign_keys = ON')
  targetDb.pragma('busy_timeout = 5000')
  try {
    sourceDb.pragma('busy_timeout = 5000')
    sourceDb.exec('BEGIN')
    const snapshot = await createUpgradedSourceSchemaSnapshot({
      sourceDb,
      targetDb,
      targetRoot,
      workspaceDir
    })
    if (snapshot) {
      closeDb(sourceDb)
      sourceDb = new Database(snapshot.databasePath, { readonly: true, fileMustExist: true })
      registerFilePathComparison(sourceDb)
      sourceDb.pragma('busy_timeout = 5000')
      sourceDb.exec('BEGIN')
    }
    const plan = await buildLibraryMergePlan({
      sourceRoot,
      targetRoot,
      sourceDb,
      targetDb,
      appVersion: params.appVersion,
      scope,
      duplicatePlaylistPolicy: params.duplicatePlaylistPolicy,
      sourceSchemaSnapshotBytes: snapshot?.reserveBytes,
      availableBytesBeforeSourceSnapshot: snapshot?.availableBytesBeforeSnapshot
    })
    return plan.summary
  } finally {
    closeDb(sourceDb)
    closeDb(targetDb)
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {})
    await fs.rmdir(path.join(targetRoot, PREFLIGHT_WORK_DIR_NAME)).catch(() => {})
  }
}
