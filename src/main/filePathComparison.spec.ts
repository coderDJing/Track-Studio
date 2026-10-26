// Run: pnpm exec vitest run src/main/filePathComparison.spec.ts
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mainFilePathKey, registerFilePathComparison } from './filePathComparison'
import {
  listMixtapeItemsByFilePath,
  listMixtapeFilePathsInUse,
  upsertMixtapeItemHotCuesByFilePath,
  upsertMixtapeItemMemoryCuesByFilePath,
  clearMixtapeItemGridCopiesByFilePath,
  removeMixtapeItemsByFilePath
} from './mixtapeDb'
import { findSetItemsByFilePath, findSetItemsByFilePaths } from './setListDb'

const state = vi.hoisted(() => ({ platform: 'win32', db: null as unknown }))
vi.mock('./libraryDb', () => ({
  getLibraryDb: () => state.db,
  isSqliteRow: (value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
}))
vi.mock('./log', () => ({
  log: {
    error: (...args: unknown[]) => {
      throw new Error(JSON.stringify(args))
    }
  }
}))
vi.mock('./filePathComparison', async (original) => {
  const actual = await original<typeof import('./filePathComparison')>()
  return {
    ...actual,
    mainFilePathKey: (value: string) => actual.mainFilePathKey(value, state.platform)
  }
})
let connection: DatabaseSync
beforeEach(() => {
  connection = new DatabaseSync(':memory:')
  connection.exec(`
    CREATE TABLE mixtape_items (id TEXT PRIMARY KEY, playlist_uuid TEXT, file_path TEXT,
      mix_order INTEGER, origin_playlist_uuid TEXT, origin_path_snapshot TEXT, info_json TEXT, created_at_ms INTEGER);
    CREATE TABLE set_items (id TEXT PRIMARY KEY, playlist_uuid TEXT, file_path TEXT,
      sort_order INTEGER, origin_playlist_uuid TEXT, origin_path_snapshot TEXT, analysis_json TEXT, created_at_ms INTEGER);
  `)
  state.db = {
    prepare: (sql: string) => connection.prepare(sql),
    transaction: (operation: () => unknown) => () => {
      connection.exec('BEGIN')
      try {
        const result = operation()
        connection.exec('COMMIT')
        return result
      } catch (error) {
        connection.exec('ROLLBACK')
        throw error
      }
    }
  }
})
afterEach(() => connection.close())

describe.each([
  { platform: 'win32', stored: 'G:\\音乐\\Ä Track.mp3', query: 'g:/音乐/ä track.mp3' },
  { platform: 'darwin', stored: '/Volumes/音乐/Track.mp3', query: '/Volumes/音乐/Track.mp3' }
])('$platform SQLite path matching', ({ platform, stored, query }) => {
  beforeEach(() => {
    state.platform = platform
    registerFilePathComparison(
      {
        function: (name, options, callback) => {
          connection.function(name, options, callback)
        }
      },
      platform
    )
    connection
      .prepare('INSERT INTO mixtape_items VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)')
      .run('mix-1', 'mix', stored, 1, JSON.stringify({ bpm: 128, hotCues: [], memoryCues: [] }), 1)
    connection
      .prepare('INSERT INTO set_items VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)')
      .run('set-1', 'set', stored, 1, 1)
  })

  it('finds persisted set and mixtape references across path spellings without rewriting paths', () => {
    expect(listMixtapeItemsByFilePath(query).map((item) => item.filePath)).toEqual([stored])
    expect(listMixtapeFilePathsInUse([query])).toEqual([stored])
    expect(findSetItemsByFilePath(query).map((item) => item.id)).toEqual(['set-1'])
    expect(findSetItemsByFilePaths([query]).map((item) => item.id)).toEqual(['set-1'])
  })

  it('writes hot cues, memory cues and grid cleanup to the actual persisted mixtape row', () => {
    expect(
      upsertMixtapeItemHotCuesByFilePath([{ filePath: query, hotCues: [{ slot: 1, sec: 2 }] }])
        .updated
    ).toBe(1)
    expect(
      upsertMixtapeItemMemoryCuesByFilePath([{ filePath: query, memoryCues: [{ sec: 3 }] }]).updated
    ).toBe(1)
    expect(clearMixtapeItemGridCopiesByFilePath([{ filePath: query }]).updated).toBe(1)
    const info = JSON.parse(
      String(connection.prepare('SELECT info_json FROM mixtape_items').get()?.info_json)
    )
    expect(info.hotCues).toEqual([expect.objectContaining({ slot: 1, sec: 2 })])
    expect(info.memoryCues).toEqual([expect.objectContaining({ sec: 3 })])
    expect(info.bpm).toBeUndefined()
    expect(connection.prepare('SELECT file_path FROM mixtape_items').get()?.file_path).toBe(stored)
  })

  it('removes by file identity while preserving other files', () => {
    expect(removeMixtapeItemsByFilePath('mix', [query]).removed).toBe(1)
    expect(connection.prepare('SELECT COUNT(*) AS count FROM mixtape_items').get()?.count).toBe(0)
  })

  it('keeps macOS case-sensitive files separate and Windows aliases equal', () => {
    const alternate = stored.replace('Track', 'track')
    expect(mainFilePathKey(stored, platform) === mainFilePathKey(alternate, platform)).toBe(
      platform === 'win32'
    )
    if (platform === 'darwin') {
      expect(listMixtapeItemsByFilePath(alternate)).toEqual([])
      expect(findSetItemsByFilePaths([alternate])).toEqual([])
      expect(removeMixtapeItemsByFilePath('mix', [alternate]).removed).toBe(0)
    }
  })
})
