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

  it('moves display waveform by retargeting the sqlite row', async () => {
    const previousDatabaseDir = store.databaseDir
    const databaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-cache-transfer-waveform-'))
    tempRoots.push(databaseDir)
    store.databaseDir = databaseDir
    try {
      const sourceRoot = path.join(databaseDir, 'library', 'source')
      const targetRoot = path.join(databaseDir, 'library', 'target')
      const sourcePath = path.join(sourceRoot, 'track.mp3')
      const targetPath = path.join(targetRoot, 'track.mp3')
      await fs.ensureDir(sourceRoot)
      await fs.ensureDir(targetRoot)
      await fs.writeFile(targetPath, Buffer.from('audio'))
      const targetStat = await fs.stat(targetPath)
      const sourceRootKey = normalizeKey(path.relative(databaseDir, sourceRoot))
      const targetRootKey = normalizeKey(path.relative(databaseDir, targetRoot))
      const fileKey = normalizeKey(path.basename(sourcePath))
      const payload = Buffer.from('display-waveform-payload')
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
      const insertWaveform = db.prepare(
        `INSERT INTO unified_display_waveform_cache (
          list_root, file_path, size, mtime_ms, cache_version, parameter_version, duration,
          detail_rate, overview_rate, frame_count, payload, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      insertWaveform.run(
        sourceRootKey,
        fileKey,
        targetStat.size,
        targetStat.mtimeMs,
        1,
        3,
        120,
        100,
        10,
        4,
        payload,
        1
      )
      insertWaveform.run(
        sourceRootKey,
        'stale.mp3',
        targetStat.size,
        targetStat.mtimeMs,
        99,
        3,
        120,
        100,
        10,
        4,
        Buffer.from('stale-payload'),
        1
      )

      const params = {
        fromRoot: sourceRoot,
        toRoot: targetRoot,
        fromPath: sourcePath,
        toPath: targetPath
      }
      const context = await transferTrackCoreCache(params)
      await transferTrackDerivedCaches(params, context)

      const selectWaveform = db.prepare(
        `SELECT payload FROM unified_display_waveform_cache WHERE list_root = ? AND file_path = ?`
      )
      const moved = selectWaveform.get(targetRootKey, fileKey) as { payload: Buffer } | undefined
      expect(moved).toBeDefined()
      expect(Buffer.from(moved?.payload || []).equals(payload)).toBe(true)
      expect(selectWaveform.get(sourceRootKey, fileKey)).toBeUndefined()

      const stalePath = path.join(sourceRoot, 'stale.mp3')
      const staleTargetPath = path.join(targetRoot, 'stale.mp3')
      await fs.writeFile(staleTargetPath, Buffer.from('audio'))
      db.prepare(
        `INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        sourceRootKey,
        'stale.mp3',
        targetStat.size,
        targetStat.mtimeMs,
        JSON.stringify({ filePath: stalePath, fileName: 'stale.mp3' })
      )
      const staleContext = await transferTrackCoreCache({
        fromRoot: sourceRoot,
        toRoot: targetRoot,
        fromPath: stalePath,
        toPath: staleTargetPath
      })
      await transferTrackDerivedCaches(
        {
          fromRoot: sourceRoot,
          toRoot: targetRoot,
          fromPath: stalePath,
          toPath: staleTargetPath
        },
        staleContext
      )
      expect(selectWaveform.get(sourceRootKey, 'stale.mp3')).toBeUndefined()
      expect(selectWaveform.get(targetRootKey, 'stale.mp3')).toBeUndefined()
    } finally {
      store.databaseDir = previousDatabaseDir
    }
  })
})
