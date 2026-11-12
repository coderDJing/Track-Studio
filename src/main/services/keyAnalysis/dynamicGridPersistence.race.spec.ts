import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeLibraryDb, initLibraryDb } from '../../libraryDb'
import store from '../../store'
import * as LibraryCacheDb from '../../libraryCacheDb'
import type { ISongInfo } from '../../../types/globals'
import { createSongBeatGridMapV2FromClips } from '../../../shared/songBeatGridMapV2'
import { songGridEvents } from '../songGridEvents'
import {
  buildDynamicGridExpectedSnapshot,
  persistDynamicGridDefinition
} from './dynamicGridPersistence'
import { buildDynamicSuccessOutcome } from './dynamicGridPersistence.testFixtures'
import { createKeyAnalysisPersistence } from './persistence'
import { normalizePath, type DoneEntry } from './types'

const state = vi.hoisted(() => ({
  armed: false,
  triggerAt: 1,
  statCalls: 0,
  filePath: '',
  listRoot: '',
  mode: 'replace' as 'replace' | 'manual-song' | 'manual-external',
  manualMap: null as unknown
}))

vi.mock('../cacheMaintenance', () => ({
  findSongListRoot: async () => state.listRoot || null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const nodeFs = await import('node:fs')
  return {
    ...actual,
    default: {
      ...actual,
      stat: async (target: unknown) => {
        const result = await actual.stat(String(target))
        if (!state.armed || String(target) !== state.filePath) return result
        state.statCalls += 1
        if (state.statCalls !== state.triggerAt) return result
        state.armed = false
        if (state.mode === 'replace') {
          nodeFs.writeFileSync(state.filePath, 'replaced-file-content-longer-than-before')
          return result
        }
        const { getLibraryDb } = await import('../../libraryDb')
        const db = getLibraryDb()
        if (!db) return result
        if (state.mode === 'manual-song') {
          const row = db
            .prepare('SELECT list_root, file_path, info_json FROM song_cache LIMIT 1')
            .get() as { list_root?: string; file_path?: string; info_json?: string } | undefined
          if (row?.info_json && row.list_root && row.file_path) {
            const info = JSON.parse(row.info_json) as Record<string, unknown>
            info.beatGridMap = state.manualMap
            info.title = 'manual-title'
            db.prepare(
              'UPDATE song_cache SET info_json = ? WHERE list_root = ? AND file_path = ?'
            ).run(JSON.stringify(info), row.list_root, row.file_path)
          }
        } else {
          const row = db
            .prepare(
              'SELECT source_kind, source_id, relative_path, info_json FROM external_analysis_cache LIMIT 1'
            )
            .get() as
            | {
                source_kind?: string
                source_id?: string
                relative_path?: string
                info_json?: string
              }
            | undefined
          if (row?.info_json && row.source_kind && row.source_id && row.relative_path) {
            const info = JSON.parse(row.info_json) as Record<string, unknown>
            info.beatGridMap = state.manualMap
            info.title = 'manual-title'
            db.prepare(
              `UPDATE external_analysis_cache SET info_json = ?
               WHERE source_kind = ? AND source_id = ? AND relative_path = ?`
            ).run(JSON.stringify(info), row.source_kind, row.source_id, row.relative_path)
          }
        }
        return result
      }
    }
  }
})

const previousDatabaseDir = store.databaseDir
let temporaryRoot = ''
let filePath = ''
let fileStat = { size: 0, mtimeMs: 0 }

const createMap = (source: 'analysis' | 'manual', bpm = 120, anchorSec = 0) => {
  const map = createSongBeatGridMapV2FromClips(
    [{ startSec: 0, anchorSec, bpm, downbeatBeatOffset: 0 }],
    source,
    { allowSingleClip: true }
  )
  if (!map) throw new Error('map fixture failed')
  return map
}

const buildInfo = (map: ReturnType<typeof createMap>): ISongInfo => ({
  filePath,
  fileName: 'song.mp3',
  fileFormat: 'MP3',
  cover: null,
  title: 'title',
  artist: 'artist',
  album: undefined,
  duration: '02:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: 'MPEG',
  beatGridMap: map,
  beatGridAlgorithmVersion: 1,
  timeBasisOffsetMs: 120
})

const metadata = {
  mode: 'dynamic' as const,
  shape: 'dynamic' as const,
  policyVersion: 'dynamic-test-policy'
}

const seedSong = async (info: ISongInfo) => {
  const ok = await LibraryCacheDb.upsertSongCacheEntry(state.listRoot, filePath, {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    info
  })
  expect(ok).toBe(true)
}

const seedExternal = async (context: LibraryCacheDb.ExternalAnalysisContext, info: ISongInfo) => {
  await LibraryCacheDb.upsertExternalAnalysisCacheEntry(context, fileStat, info)
}

const listenEvents = () => {
  const events: unknown[] = []
  const handler = (payload: unknown) => events.push(payload)
  songGridEvents.on('grid-updated', handler)
  return {
    events,
    stop: () => songGridEvents.off('grid-updated', handler)
  }
}

beforeEach(async () => {
  state.armed = false
  state.triggerAt = 1
  state.statCalls = 0
  state.mode = 'replace'
  state.manualMap = null
  temporaryRoot = path.join(os.tmpdir(), `frkb-dynamic-race-${Date.now()}-${Math.random()}`)
  mkdirSync(path.join(temporaryRoot, 'library'), { recursive: true })
  mkdirSync(path.join(temporaryRoot, 'music'), { recursive: true })
  filePath = path.join(temporaryRoot, 'music', 'song.mp3')
  writeFileSync(filePath, 'original-file')
  const current = statSync(filePath)
  fileStat = { size: current.size, mtimeMs: current.mtimeMs }
  store.databaseDir = temporaryRoot
  expect(initLibraryDb(temporaryRoot)).not.toBeNull()
  state.listRoot = temporaryRoot
  state.filePath = filePath
})

afterEach(async () => {
  songGridEvents.removeAllListeners('grid-updated')
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  state.listRoot = ''
  state.filePath = ''
  if (temporaryRoot) {
    rmSync(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = ''
  }
})

const baseParams = (map: ReturnType<typeof createMap>) => ({
  filePath,
  expectedAudioIdentity: fileStat,
  listRoot: state.listRoot,
  externalContext: null,
  beatGridMap: map,
  timeBasisOffsetMs: 120,
  beatGridAlgorithmVersion: 1,
  gridMetadata: metadata,
  shouldPersist: () => true
})

describe('dynamic grid commit-time file check', () => {
  it('rejects a file replaced during the async stat window for the song cache', async () => {
    const expectedMap = createMap('analysis', 120, 0)
    await seedSong(buildInfo(expectedMap))
    const expectedGrid = buildDynamicGridExpectedSnapshot(
      (await LibraryCacheDb.loadSongCacheEntry(state.listRoot, filePath))?.info
    )
    const listener = listenEvents()
    state.armed = true
    state.triggerAt = 1

    await expect(
      persistDynamicGridDefinition({
        ...baseParams(createMap('analysis', 128, 0.25)),
        expectedGrid
      })
    ).rejects.toMatchObject({ code: 'file-changed' })
    listener.stop()

    expect(listener.events).toHaveLength(0)
    const info = (await LibraryCacheDb.loadSongCacheEntry(state.listRoot, filePath))?.info
    expect(info?.beatGridMap?.signature).toBe(expectedMap.signature)
  })

  it('keeps done/events empty when the file changes after the persistBpm stat', async () => {
    const doneByPath = new Map<string, DoneEntry>()
    const persistence = createKeyAnalysisPersistence({
      doneByPath,
      events: new EventEmitter()
    })
    const map = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0.25, bpm: 128, downbeatBeatOffset: 0 },
        { startSec: 60, anchorSec: 60.25, bpm: 128, downbeatBeatOffset: 0 }
      ],
      'analysis',
      { allowSingleClip: true }
    )
    if (!map) throw new Error('dynamic map fixture failed')
    const outcome = buildDynamicSuccessOutcome(map)
    const listener = listenEvents()
    state.armed = true
    state.triggerAt = 2

    await expect(
      persistence.persistBpm(filePath, 0, undefined, undefined, 120, {
        dynamicGridOutcome: outcome,
        expectedAudioDurationSec: 120,
        expectedAudioIdentity: fileStat
      })
    ).rejects.toMatchObject({ code: 'file-changed' })
    listener.stop()

    expect(doneByPath.size).toBe(0)
    expect(listener.events).toHaveLength(0)
    expect((await LibraryCacheDb.loadSongCacheEntry(state.listRoot, filePath))?.info).toBeFalsy()
  })

  it('rejects a file replaced during the async stat window for the external cache', async () => {
    const context: LibraryCacheDb.ExternalAnalysisContext = {
      sourceKind: 'external-playback',
      sourceId: 'race',
      rootPath: temporaryRoot,
      relativePath: 'abs:song.mp3',
      filePath
    }
    const expectedMap = createMap('analysis', 120, 0)
    await seedExternal(context, buildInfo(expectedMap))
    const base = await LibraryCacheDb.loadExternalAnalysisCacheEntry(context, fileStat)
    const expectedGrid = buildDynamicGridExpectedSnapshot(base?.info)
    const listener = listenEvents()
    state.armed = true
    state.triggerAt = 1

    await expect(
      persistDynamicGridDefinition({
        ...baseParams(createMap('analysis', 128, 0.25)),
        listRoot: null,
        externalContext: context,
        expectedGrid
      })
    ).rejects.toMatchObject({ code: 'file-changed' })
    listener.stop()

    expect(listener.events).toHaveLength(0)
    const info = (await LibraryCacheDb.loadExternalAnalysisCacheEntry(context, fileStat))?.info
    expect(info?.beatGridMap?.signature).toBe(expectedMap.signature)
  })

  it('protects a manual song edit injected just before the transaction reads latest', async () => {
    const expectedMap = createMap('analysis', 120, 0)
    await seedSong(buildInfo(expectedMap))
    const expectedGrid = buildDynamicGridExpectedSnapshot(
      (await LibraryCacheDb.loadSongCacheEntry(state.listRoot, filePath))?.info
    )
    const manualMap = createMap('manual', 126, 0.1)
    const listener = listenEvents()
    state.mode = 'manual-song'
    state.manualMap = manualMap
    state.armed = true
    state.triggerAt = 1

    const result = await persistDynamicGridDefinition({
      ...baseParams(createMap('analysis', 128, 0.25)),
      expectedGrid
    })
    listener.stop()

    expect(result).toEqual({ status: 'skipped', reason: 'manual' })
    expect(listener.events).toHaveLength(0)
    const info = (await LibraryCacheDb.loadSongCacheEntry(state.listRoot, filePath))?.info
    expect(info?.beatGridMap?.signature).toBe(manualMap.signature)
    expect(info?.title).toBe('manual-title')
  })

  it('protects a manual external edit injected just before the transaction reads latest', async () => {
    const context: LibraryCacheDb.ExternalAnalysisContext = {
      sourceKind: 'external-playback',
      sourceId: 'race',
      rootPath: temporaryRoot,
      relativePath: 'abs:song.mp3',
      filePath
    }
    const expectedMap = createMap('analysis', 120, 0)
    await seedExternal(context, buildInfo(expectedMap))
    const base = await LibraryCacheDb.loadExternalAnalysisCacheEntry(context, fileStat)
    const expectedGrid = buildDynamicGridExpectedSnapshot(base?.info)
    const manualMap = createMap('manual', 126, 0.1)
    const listener = listenEvents()
    state.mode = 'manual-external'
    state.manualMap = manualMap
    state.armed = true
    state.triggerAt = 1

    const result = await persistDynamicGridDefinition({
      ...baseParams(createMap('analysis', 128, 0.25)),
      listRoot: null,
      externalContext: context,
      expectedGrid
    })
    listener.stop()

    expect(result).toEqual({ status: 'skipped', reason: 'manual' })
    expect(listener.events).toHaveLength(0)
    const info = (await LibraryCacheDb.loadExternalAnalysisCacheEntry(context, fileStat))?.info
    expect(info?.beatGridMap?.signature).toBe(manualMap.signature)
    expect(info?.title).toBe('manual-title')
  })
})
