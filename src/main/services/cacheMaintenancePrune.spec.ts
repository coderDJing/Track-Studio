// Run: pnpm exec vitest run src/main/services/cacheMaintenancePrune.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeLibraryDb, getLibraryDb, initLibraryDb } from '../libraryDb'
import * as LibraryCacheDb from '../libraryCacheDb'
import type { LibraryNodeRow } from '../libraryTreeDb'
import store from '../store'
import { createSongBeatGridMapV2FromFixedGrid } from '../../shared/songBeatGridMapV2'
import { buildLiteSongInfo } from './songInfoLite'
import { findSongListRoot, pruneOrphanedSongListCaches } from './cacheMaintenance'
import { loadSharedSongGridDefinition } from './sharedSongGrid'
import { parseSnapshot } from '../../renderer/src/composables/mixtape/mixtapeTrackSnapshot'
import { buildMixtapeBpmTargets } from '../../renderer/src/composables/mixtape/mixtapeBpmAnalysis'

const mocks = vi.hoisted(() => ({
  nodes: [] as LibraryNodeRow[]
}))

vi.mock('../libraryTreeDb', () => ({
  loadLibraryNodes: () => mocks.nodes,
  findSongListRootByPath: () => null
}))

const previousDatabaseDir = store.databaseDir
let root = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-custody-prune-'))
  await fs.mkdir(path.join(root, 'library'))
  store.databaseDir = root
  expect(initLibraryDb(root)).not.toBeNull()
  mocks.nodes = [
    { uuid: 'root', parentUuid: null, dirName: 'library', nodeType: 'root', order: 0 },
    { uuid: 'sets', parentUuid: 'root', dirName: 'SetLibrary', nodeType: 'library', order: 0 },
    { uuid: 'set', parentUuid: 'sets', dirName: 'MySet', nodeType: 'setList', order: 0 }
  ]
})

afterEach(async () => {
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  await fs.rm(root, { recursive: true, force: true })
})

const seedTrackCache = async (listRoot: string, filePath: string) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, Buffer.from('audio'))
  const stat = await fs.stat(filePath)
  const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
    bpm: 129,
    firstBeatMs: 234679.03,
    downbeatBeatOffset: 2,
    source: 'manual'
  })
  if (!beatGridMap) throw new Error('grid fixture failed')
  expect(
    await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      info: { ...buildLiteSongInfo(filePath), beatGridMap }
    })
  ).toBe(true)
  const db = getLibraryDb()
  if (!db) throw new Error('test database unavailable')
  const normalizeKey = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value
  db.prepare(
    `INSERT INTO unified_display_waveform_cache (
      list_root, file_path, size, mtime_ms, cache_version, parameter_version, duration,
      detail_rate, overview_rate, frame_count, payload, updated_at_ms
    ) VALUES (?, ?, ?, ?, 1, 1, 300, 100, 10, 1, ?, 1)`
  ).run(
    normalizeKey(path.relative(root, listRoot)),
    normalizeKey(path.relative(listRoot, filePath)),
    stat.size,
    stat.mtimeMs,
    Buffer.from('waveform')
  )
  return beatGridMap
}

describe('orphan cache pruning with SET custody', () => {
  it('keeps custody grids and waveforms usable by Mixtape while removing deleted playlist caches', async () => {
    const custodyRoot = path.join(root, 'library', 'SetLibrary', '__set_custody__')
    const filePath = path.join(custodyRoot, 'imported-set', 'track.mp3')
    const beatGridMap = await seedTrackCache(custodyRoot, filePath)
    const deletedRoot = path.join(root, 'library', 'FilterLibrary', 'Deleted')
    await seedTrackCache(deletedRoot, path.join(deletedRoot, 'old.mp3'))

    expect(await findSongListRoot(path.dirname(filePath))).toBe(custodyRoot)
    const removed = await pruneOrphanedSongListCaches(root)
    expect(removed.songCacheRemoved).toBe(1)
    expect(removed.unifiedDisplayWaveformCacheRemoved).toBe(1)
    // 再次读取库树也不能删掉托管缓存，否则每次重开工程都会重新分析。
    expect((await pruneOrphanedSongListCaches(root)).songCacheRemoved).toBe(0)
    const canonicalGrid = await loadSharedSongGridDefinition(filePath)
    expect(canonicalGrid?.beatGridMap).toEqual(beatGridMap)
    const track = parseSnapshot(
      { id: 'mix-track', filePath, mixOrder: 1, canonicalGrid: canonicalGrid ?? undefined },
      0,
      'Unknown'
    )
    expect(buildMixtapeBpmTargets([track])).toEqual([])
    expect(
      getLibraryDb()?.prepare('SELECT COUNT(*) AS count FROM unified_display_waveform_cache').get()
    ).toEqual({ count: 1 })
  })

  it('still removes custody caches when the library tree is empty', async () => {
    const custodyRoot = path.join(root, 'library', 'SetLibrary', '__set_custody__')
    await seedTrackCache(custodyRoot, path.join(custodyRoot, 'track.mp3'))
    mocks.nodes = []
    const removed = await pruneOrphanedSongListCaches(root)
    expect(removed.songCacheRemoved).toBe(1)
    expect(removed.unifiedDisplayWaveformCacheRemoved).toBe(1)
  })
})
