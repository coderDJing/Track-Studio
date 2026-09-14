import fs = require('fs-extra')
import os = require('node:os')
import path = require('node:path')
import { afterEach, describe, expect, it } from 'vitest'
import { closeLibraryDb, getLibraryDb } from '../libraryDb'
import store from '../store'
import { transferTrackCoreCache, transferTrackDerivedCaches } from './trackCacheTransfer'

const tempRoots: string[] = []

const normalizeKey = (value: string): string => {
  const normalized = path.normalize(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

afterEach(async () => {
  closeLibraryDb()
  for (const tempRoot of tempRoots.splice(0)) {
    await fs.remove(tempRoot)
  }
})

describe('track cache transfer phases', () => {
  it('moves core analysis before derived cover cache', async () => {
    const previousDatabaseDir = store.databaseDir
    const databaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-cache-transfer-'))
    tempRoots.push(databaseDir)
    store.databaseDir = databaseDir
    try {
      const sourceRoot = path.join(databaseDir, 'library', 'source')
      const targetRoot = path.join(databaseDir, 'library', 'RecycleBin')
      const sourcePath = path.join(sourceRoot, 'track.mp3')
      const targetPath = path.join(targetRoot, 'track.mp3')
      await fs.ensureDir(path.join(sourceRoot, '.frkb_covers'))
      await fs.ensureDir(targetRoot)
      await fs.writeFile(targetPath, Buffer.from('audio'))
      await fs.writeFile(path.join(sourceRoot, '.frkb_covers', 'cover.jpg'), Buffer.from('cover'))
      const targetStat = await fs.stat(targetPath)
      const sourceRootKey = normalizeKey(path.relative(databaseDir, sourceRoot))
      const targetRootKey = normalizeKey(path.relative(databaseDir, targetRoot))
      const fileKey = normalizeKey(path.basename(sourcePath))
      const db = getLibraryDb()
      if (!db) throw new Error('test database unavailable')
      db.prepare(
        `INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        sourceRootKey,
        fileKey,
        targetStat.size,
        targetStat.mtimeMs,
        JSON.stringify({ filePath: sourcePath, fileName: path.basename(sourcePath) })
      )
      db.prepare(
        `INSERT INTO cover_index (list_root, file_path, hash, ext) VALUES (?, ?, ?, ?)`
      ).run(sourceRootKey, fileKey, 'cover', '.jpg')

      const params = {
        fromRoot: sourceRoot,
        toRoot: targetRoot,
        fromPath: sourcePath,
        toPath: targetPath
      }
      const context = await transferTrackCoreCache(params)

      expect(context).not.toBeNull()
      expect(
        db
          .prepare('SELECT 1 FROM song_cache WHERE list_root = ? AND file_path = ?')
          .get(sourceRootKey, fileKey)
      ).toBeUndefined()
      const targetSong = db
        .prepare('SELECT info_json FROM song_cache WHERE list_root = ? AND file_path = ?')
        .get(targetRootKey, fileKey) as { info_json: string }
      expect(normalizeKey(JSON.parse(targetSong.info_json).filePath)).toBe(normalizeKey(targetPath))
      expect(
        db
          .prepare('SELECT 1 FROM cover_index WHERE list_root = ? AND file_path = ?')
          .get(sourceRootKey, fileKey)
      ).toBeDefined()

      await transferTrackDerivedCaches(params, context)

      expect(
        db
          .prepare('SELECT 1 FROM cover_index WHERE list_root = ? AND file_path = ?')
          .get(sourceRootKey, fileKey)
      ).toBeUndefined()
      expect(
        db
          .prepare('SELECT 1 FROM cover_index WHERE list_root = ? AND file_path = ?')
          .get(targetRootKey, fileKey)
      ).toBeDefined()
      expect(await fs.pathExists(path.join(targetRoot, '.frkb_covers', 'cover.jpg'))).toBe(true)
    } finally {
      store.databaseDir = previousDatabaseDir
    }
  })
})
