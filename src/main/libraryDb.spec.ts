import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import fsExtra from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import {
  assertExistingDatabaseSchemaSupported,
  closeLibraryDb,
  DatabaseSchemaVersionError,
  getLibraryDbPath,
  getLibraryDb,
  initLibraryDb,
  MAX_SUPPORTED_DATABASE_SCHEMA_VERSION
} from './libraryDb'
import store from './store'
import { registerFilePathComparison } from './filePathComparison'

const temporaryRoots: string[] = []
const previousDatabaseDir = store.databaseDir

const createTemporaryRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-library-db-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe('library database initialization', () => {
  it('reuses the open connection without probing the disk on every cache access', async () => {
    const root = await createTemporaryRoot()
    await fs.mkdir(path.join(root, 'library'))
    store.databaseDir = root
    const instance = initLibraryDb(root)
    expect(instance).not.toBeNull()
    const probe = vi.spyOn(fsExtra, 'pathExistsSync').mockImplementation(() => {
      throw new Error('synchronous filesystem probe on the database hot path')
    })
    for (let index = 0; index < 1000; index++) {
      expect(getLibraryDb()).toBe(instance)
    }
    expect(probe).not.toHaveBeenCalled()
  })

  it('checks the filesystem again after explicitly closing a connection', async () => {
    const root = await createTemporaryRoot()
    await fs.mkdir(path.join(root, 'library'))
    const first = initLibraryDb(root)
    expect(first).not.toBeNull()
    closeLibraryDb()
    const probe = vi.spyOn(fsExtra, 'pathExistsSync')
    const second = initLibraryDb(root)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(probe).toHaveBeenCalledWith(root)
    expect(probe).toHaveBeenCalledWith(path.join(root, 'library'))
  })

  it('does not reuse the previous connection when switching to a missing library', async () => {
    const root = await createTemporaryRoot()
    await fs.mkdir(path.join(root, 'library'))
    const first = initLibraryDb(root)
    const missingRoot = path.join(root, 'missing-library')
    expect(first).not.toBeNull()
    expect(initLibraryDb(missingRoot)).toBeNull()
    await expect(fs.access(missingRoot)).rejects.toThrow()
    expect(initLibraryDb(root)).toBe(first)
  })

  it('does not recreate a deleted library root while probing the saved path', async () => {
    const parent = await createTemporaryRoot()
    const deletedLibraryRoot = path.join(parent, 'deleted-library')

    expect(initLibraryDb(deletedLibraryRoot)).toBeNull()
    await expect(fs.access(deletedLibraryRoot)).rejects.toThrow()
  })

  it('does not create SQLite when the library directory is missing', async () => {
    const root = await createTemporaryRoot()

    expect(initLibraryDb(root)).toBeNull()
    await expect(fs.access(getLibraryDbPath(root))).rejects.toThrow()
  })

  it('rejects a database created by a newer FRKB before opening it for writes', async () => {
    const root = await createTemporaryRoot()
    await fs.mkdir(path.join(root, 'library'))
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const databasePath = getLibraryDbPath(root)
    const instance = new Database(databasePath)
    instance.pragma(`user_version = ${MAX_SUPPORTED_DATABASE_SCHEMA_VERSION + 1}`)
    instance.close()

    expect(() => assertExistingDatabaseSchemaSupported(databasePath)).toThrow(
      DatabaseSchemaVersionError
    )
    expect(() => initLibraryDb(root)).toThrow(DatabaseSchemaVersionError)
  })

  it('upgrades legacy cache indexes atomically with the schema guard and preserves cached data', async () => {
    const root = await createTemporaryRoot()
    await fs.mkdir(path.join(root, 'library'))
    expect(initLibraryDb(root)).not.toBeNull()
    closeLibraryDb()
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const legacy = new Database(getLibraryDbPath(root))
    registerFilePathComparison(legacy)
    legacy.exec(`
      PRAGMA user_version = 40;
      DROP INDEX idx_song_cache_file_normalized;
      DROP INDEX idx_song_cache_root_file_normalized;
      DROP INDEX idx_song_cache_info_file_path_normalized;
      CREATE INDEX idx_song_cache_file_normalized ON song_cache(REPLACE(LOWER(file_path), '/', '\\'));
      INSERT INTO song_cache VALUES ('library/music', 'Ä Track.mp3', 1, 2, '{}');
    `)
    legacy.close()
    const instance = initLibraryDb(root)
    expect(instance).not.toBeNull()
    expect(instance?.pragma('user_version', { simple: true })).toBe(41)
    expect(instance?.prepare('SELECT file_path FROM song_cache').get()).toMatchObject({
      file_path: 'Ä Track.mp3'
    })
    expect(
      instance
        ?.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_song_cache_file_normalized'")
        .get()
    ).toMatchObject({ sql: expect.stringContaining('frkb_file_path_key_mode') })
    closeLibraryDb()
    expect(assertExistingDatabaseSchemaSupported(getLibraryDbPath(root))).toBe(41)
    expect(initLibraryDb(root)).not.toBeNull()
  })
})
