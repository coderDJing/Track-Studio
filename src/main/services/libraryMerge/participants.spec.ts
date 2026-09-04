import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeLibraryDb, initLibraryDb, migrateStandaloneLibraryDb } from '../../libraryDb'
import {
  assertLibraryMergeParticipantCoverage,
  LibraryMergeParticipantContractError
} from './participants'
import { LibraryMetadataContractError } from '../../../shared/libraryMetadataContracts'

type SqliteDatabase = InstanceType<typeof import('better-sqlite3')>

const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const temporaryRoots: string[] = []

const createTemporaryDatabasePath = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-library-merge-contract-'))
  temporaryRoots.push(root)
  // 真实库根一定带 library/ 子目录，initLibraryDb 会先确认它存在才肯打开库（afddeffb
  // 「防止已删除库被自动重建」）。夹具不建这个目录，下面两个 fail-fast 用例就会在契约
  // 校验之前拿到 null，永远测不到它们要测的东西。
  await fs.mkdir(path.join(root, 'library'), { recursive: true })
  return path.join(root, 'FRKB.database.sqlite')
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe('library merge participant contracts', () => {
  it('covers every table created by the current library schema', async () => {
    const databasePath = await createTemporaryDatabasePath()
    migrateStandaloneLibraryDb(databasePath)
    const db: SqliteDatabase = new Database(databasePath, { fileMustExist: true })
    try {
      expect(() => assertLibraryMergeParticipantCoverage(db)).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('rejects a table that has no declared merge strategy', async () => {
    const databasePath = await createTemporaryDatabasePath()
    const db: SqliteDatabase = new Database(databasePath)
    try {
      db.exec('CREATE TABLE future_feature_records (id TEXT PRIMARY KEY)')
      expect(() => assertLibraryMergeParticipantCoverage(db)).toThrow(
        '数据库表未声明合并策略：future_feature_records'
      )
    } finally {
      db.close()
    }
  })

  it('fails fast when a configured development library has an unregistered table', async () => {
    const databasePath = await createTemporaryDatabasePath()
    const root = path.dirname(databasePath)
    const db: SqliteDatabase = new Database(databasePath)
    try {
      db.exec('CREATE TABLE future_feature_records (id TEXT PRIMARY KEY)')
    } finally {
      db.close()
    }
    const previousConfiguredRoot = process.env.FRKB_DEV_DATABASE_URL
    const previousPackagedFlag = process.env.FRKB_APP_PACKAGED
    process.env.FRKB_DEV_DATABASE_URL = root
    process.env.FRKB_APP_PACKAGED = '0'
    try {
      expect(() => initLibraryDb(root)).toThrow(LibraryMergeParticipantContractError)
    } finally {
      closeLibraryDb()
      if (previousConfiguredRoot === undefined) delete process.env.FRKB_DEV_DATABASE_URL
      else process.env.FRKB_DEV_DATABASE_URL = previousConfiguredRoot
      if (previousPackagedFlag === undefined) delete process.env.FRKB_APP_PACKAGED
      else process.env.FRKB_APP_PACKAGED = previousPackagedFlag
    }
  })

  it('fails fast when a configured development library already has an unregistered meta key', async () => {
    const databasePath = await createTemporaryDatabasePath()
    migrateStandaloneLibraryDb(databasePath)
    const root = path.dirname(databasePath)
    const db: SqliteDatabase = new Database(databasePath)
    try {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('future_feature_state_v1', '{}')
    } finally {
      db.close()
    }
    const previousConfiguredRoot = process.env.FRKB_DEV_DATABASE_URL
    const previousPackagedFlag = process.env.FRKB_APP_PACKAGED
    process.env.FRKB_DEV_DATABASE_URL = root
    process.env.FRKB_APP_PACKAGED = '0'
    try {
      expect(() => initLibraryDb(root)).toThrow(LibraryMetadataContractError)
    } finally {
      closeLibraryDb()
      if (previousConfiguredRoot === undefined) delete process.env.FRKB_DEV_DATABASE_URL
      else process.env.FRKB_DEV_DATABASE_URL = previousConfiguredRoot
      if (previousPackagedFlag === undefined) delete process.env.FRKB_APP_PACKAGED
      else process.env.FRKB_APP_PACKAGED = previousPackagedFlag
    }
  })
})
