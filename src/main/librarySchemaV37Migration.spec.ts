import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSongBeatGridMapV2FromFixedGrid } from '../shared/songBeatGridMapV2'
import {
  migrateLibrarySchemaToV38,
  SONG_TIME_BASIS_REPAIR_SCHEMA_VERSION
} from './librarySchemaV37Migration'

const temporaryDirectories: string[] = []
// 此套件通过 resolveTimeBasisOffsetMs 注入结果，不加载 Electron/ffmpeg 运行时。
vi.mock('./ffmpeg', () => ({
  resolveBundledFfmpegPath: () => {
    throw new Error('unexpected ffmpeg access in schema migration test')
  }
}))

const createV36Database = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-schema-v37-'))
  temporaryDirectories.push(directory)
  const databasePath = path.join(directory, 'FRKB.database.sqlite')
  await fs.mkdir(path.join(directory, 'library', 'sample'), { recursive: true })
  await fs.writeFile(path.join(directory, 'library', 'sample', 'example.mp3'), '')
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(databasePath)
  const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
    bpm: 128,
    firstBeatMs: 52.114,
    downbeatBeatOffset: 0
  })
  db.exec(`
    PRAGMA user_version = 36;
    CREATE TABLE song_cache (list_root TEXT NOT NULL, file_path TEXT NOT NULL, info_json TEXT NOT NULL);
    CREATE TABLE external_analysis_cache (file_path TEXT NOT NULL, info_json TEXT NOT NULL);
  `)
  db.prepare('INSERT INTO song_cache (list_root, file_path, info_json) VALUES (?, ?, ?)').run(
    'library/sample',
    'example.mp3',
    JSON.stringify({ beatGridMap })
  )
  db.close()
  return databasePath
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('v36 or v37 to v38 library schema migration', () => {
  it('restores missing audio time-basis metadata without altering the v2 grid map', async () => {
    const databasePath = await createV36Database()
    const result = await migrateLibrarySchemaToV38(databasePath, {
      backupPath: `${databasePath}.backup`,
      getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
      resolveTimeBasisOffsetMs: async () => 50.114
    })

    expect(result).toMatchObject({
      migrated: true,
      databaseVersion: SONG_TIME_BASIS_REPAIR_SCHEMA_VERSION,
      restoredTimeBases: 1
    })

    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      const info = JSON.parse(
        (db.prepare('SELECT info_json FROM song_cache').get() as { info_json: string }).info_json
      )
      expect(db.pragma('user_version', { simple: true })).toBe(
        SONG_TIME_BASIS_REPAIR_SCHEMA_VERSION
      )
      expect(info.timeBasisOffsetMs).toBe(50.114)
      expect(info.timeBasisOffsetAlgorithmVersion).toBe(1)
      expect(info.beatGridMap.clips[0].anchorSec).toBe(0.052114)
    } finally {
      db.close()
    }
  })
})
