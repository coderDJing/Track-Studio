import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeLibraryDb, initLibraryDb } from '../../libraryDb'
import store from '../../store'
import * as LibraryCacheDb from '../../libraryCacheDb'
import type { ISongInfo } from '../../../types/globals'
import { createSongBeatGridMapV2FromClips } from '../../../shared/songBeatGridMapV2'
import { buildDynamicSuccessOutcome } from './dynamicGridPersistence.testFixtures'
import { songGridEvents } from '../songGridEvents'
import {
  buildDynamicGridExpectedSnapshot,
  persistDynamicGridDefinition
} from './dynamicGridPersistence'
import { createKeyAnalysisPersistence } from './persistence'
import { resolveDynamicGridTimelineDefinition } from './dynamicGridIntegration'
import { normalizePath, type DoneEntry } from './types'

const mockState = vi.hoisted(() => ({ listRoot: '' }))

vi.mock('../cacheMaintenance', () => ({
  findSongListRoot: async () => mockState.listRoot || null
}))

const previousDatabaseDir = store.databaseDir
let temporaryRoot = ''

const createMap = (source: 'analysis' | 'manual', bpm = 120, anchorSec = 0) => {
  const map = createSongBeatGridMapV2FromClips(
    [{ startSec: 0, anchorSec, bpm, downbeatBeatOffset: 0 }],
    source,
    { allowSingleClip: true }
  )
  if (!map) throw new Error('map fixture failed')
  return map
}

const metadata = {
  mode: 'dynamic' as const,
  shape: 'dynamic' as const,
  policyVersion: 'dynamic-test-policy'
}

const buildInfo = (params: {
  map: ReturnType<typeof createMap>
  title?: string
  timeBasisOffsetMs?: number
  beatGridAlgorithmVersion?: number
}): ISongInfo => ({
  filePath: '',
  fileName: 'song.mp3',
  fileFormat: 'MP3',
  cover: null,
  title: params.title ?? 'song',
  artist: 'artist',
  album: undefined,
  duration: '02:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: 'MPEG',
  beatGridMap: params.map,
  beatGridAlgorithmVersion: params.beatGridAlgorithmVersion ?? 1,
  timeBasisOffsetMs: params.timeBasisOffsetMs ?? 120
})

const setupTempDb = async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-dynamic-persist-'))
  await fs.mkdir(path.join(temporaryRoot, 'library'), { recursive: true })
  await fs.mkdir(path.join(temporaryRoot, 'music'), { recursive: true })
  store.databaseDir = temporaryRoot
  expect(initLibraryDb(temporaryRoot)).not.toBeNull()
  mockState.listRoot = temporaryRoot
}

const setupFile = async () => {
  const filePath = path.join(temporaryRoot, 'music', 'song.mp3')
  await fs.writeFile(filePath, 'audio-fixture')
  const stat = await fs.stat(filePath)
  return { filePath, stat: { size: stat.size, mtimeMs: stat.mtimeMs } }
}

beforeEach(async () => {
  await setupTempDb()
})

afterEach(async () => {
  songGridEvents.removeAllListeners('grid-updated')
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  mockState.listRoot = ''
  if (temporaryRoot) {
    await fs.rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = ''
  }
})

const seedSong = async (params: {
  filePath: string
  stat: { size: number; mtimeMs: number }
  info: ISongInfo
}) => {
  const ok = await LibraryCacheDb.upsertSongCacheEntry(mockState.listRoot, params.filePath, {
    size: params.stat.size,
    mtimeMs: params.stat.mtimeMs,
    info: { ...params.info, filePath: params.filePath }
  })
  expect(ok).toBe(true)
}

const loadSongInfo = async (filePath: string) => {
  const entry = await LibraryCacheDb.loadSongCacheEntry(mockState.listRoot, filePath)
  return entry?.info ?? null
}

const listenEvents = () => {
  const events: Array<{ beatGridMap?: unknown }> = []
  const handler = (payload: { beatGridMap?: unknown }) => events.push(payload)
  songGridEvents.on('grid-updated', handler)
  return {
    events,
    stop: () => songGridEvents.off('grid-updated', handler)
  }
}

describe('persistDynamicGridDefinition', () => {
  it('commits map, time basis and mode/policy in one write and observes them in the event', async () => {
    const { filePath, stat } = await setupFile()
    const previousMap = createMap('analysis', 120, 0)
    await seedSong({ filePath, stat, info: buildInfo({ map: previousMap }) })
    const expectedGrid = buildDynamicGridExpectedSnapshot(await loadSongInfo(filePath))
    const nextMap = createMap('analysis', 128, 0.25)
    let observedInfoPromise: Promise<ISongInfo | null> | null = null
    songGridEvents.once('grid-updated', () => {
      observedInfoPromise = loadSongInfo(filePath)
    })

    const result = await persistDynamicGridDefinition({
      filePath,
      expectedAudioIdentity: stat,
      listRoot: mockState.listRoot,
      externalContext: null,
      beatGridMap: nextMap,
      timeBasisOffsetMs: 120,
      beatGridAlgorithmVersion: 1,
      gridMetadata: metadata,
      expectedGrid,
      shouldPersist: () => true
    })

    expect(result).toEqual({ status: 'written' })
    const info = await observedInfoPromise!
    expect(info?.beatGridMap?.signature).toBe(nextMap.signature)
    expect(info?.timeBasisOffsetMs).toBe(120)
    expect(info?.beatGridAnalysisMode).toBe('dynamic')
    expect(info?.beatGridResultShape).toBe('dynamic')
    expect(info?.beatGridPolicyVersion).toBe('dynamic-test-policy')
  })

  it('reads the latest row in the transaction and protects a manual edit after the first read', async () => {
    const { filePath, stat } = await setupFile()
    const initialMap = createMap('analysis', 120, 0)
    await seedSong({ filePath, stat, info: buildInfo({ map: initialMap }) })
    const expectedGrid = buildDynamicGridExpectedSnapshot(await loadSongInfo(filePath))
    const manualMap = createMap('manual', 126, 0.1)
    await seedSong({
      filePath,
      stat,
      info: buildInfo({ map: manualMap, title: 'manual-title' })
    })
    const listener = listenEvents()

    const result = await persistDynamicGridDefinition({
      filePath,
      expectedAudioIdentity: stat,
      listRoot: mockState.listRoot,
      externalContext: null,
      beatGridMap: createMap('analysis', 128, 0.25),
      timeBasisOffsetMs: 120,
      beatGridAlgorithmVersion: 1,
      gridMetadata: metadata,
      expectedGrid,
      shouldPersist: () => true
    })
    listener.stop()

    expect(result).toEqual({ status: 'skipped', reason: 'manual' })
    expect(listener.events).toHaveLength(0)
    const info = await loadSongInfo(filePath)
    expect(info?.beatGridMap?.signature).toBe(manualMap.signature)
    expect(info?.title).toBe('manual-title')
  })

  it('preserves concurrent non-grid fields from the latest row', async () => {
    const { filePath, stat } = await setupFile()
    const initialMap = createMap('analysis', 120, 0)
    await seedSong({
      filePath,
      stat,
      info: buildInfo({ map: initialMap, title: 'old-title' })
    })
    const expectedGrid = buildDynamicGridExpectedSnapshot(await loadSongInfo(filePath))
    await seedSong({
      filePath,
      stat,
      info: buildInfo({ map: initialMap, title: 'new-title' })
    })

    const result = await persistDynamicGridDefinition({
      filePath,
      expectedAudioIdentity: stat,
      listRoot: mockState.listRoot,
      externalContext: null,
      beatGridMap: createMap('analysis', 128, 0.25),
      timeBasisOffsetMs: 120,
      beatGridAlgorithmVersion: 1,
      gridMetadata: metadata,
      expectedGrid,
      shouldPersist: () => true
    })

    expect(result).toEqual({ status: 'written' })
    const info = await loadSongInfo(filePath)
    expect(info?.title).toBe('new-title')
    expect(info?.beatGridAnalysisMode).toBe('dynamic')
  })

  it('writes once and stays idempotent for partial + final', async () => {
    const { filePath, stat } = await setupFile()
    await seedSong({
      filePath,
      stat,
      info: buildInfo({ map: createMap('analysis', 120, 0) })
    })
    const expectedGrid = buildDynamicGridExpectedSnapshot(await loadSongInfo(filePath))
    const nextMap = createMap('analysis', 128, 0.25)
    const listener = listenEvents()
    const params = {
      filePath,
      expectedAudioIdentity: stat,
      listRoot: mockState.listRoot,
      externalContext: null,
      beatGridMap: nextMap,
      timeBasisOffsetMs: 120,
      beatGridAlgorithmVersion: 1,
      gridMetadata: metadata,
      expectedGrid,
      shouldPersist: () => true
    }

    await expect(persistDynamicGridDefinition(params)).resolves.toEqual({ status: 'written' })
    await expect(persistDynamicGridDefinition(params)).resolves.toEqual({ status: 'unchanged' })
    listener.stop()

    expect(listener.events).toHaveLength(1)
    expect((await loadSongInfo(filePath))?.beatGridMap?.signature).toBe(nextMap.signature)
  })

  it('does not broadcast or write when the generation check fails before commit', async () => {
    const { filePath, stat } = await setupFile()
    const initialMap = createMap('analysis', 120, 0)
    await seedSong({ filePath, stat, info: buildInfo({ map: initialMap }) })
    const expectedGrid = buildDynamicGridExpectedSnapshot(await loadSongInfo(filePath))
    const listener = listenEvents()
    let calls = 0

    const result = await persistDynamicGridDefinition({
      filePath,
      expectedAudioIdentity: stat,
      listRoot: mockState.listRoot,
      externalContext: null,
      beatGridMap: createMap('analysis', 128, 0.25),
      timeBasisOffsetMs: 120,
      beatGridAlgorithmVersion: 1,
      gridMetadata: metadata,
      expectedGrid,
      shouldPersist: () => {
        calls += 1
        return calls <= 2
      }
    })
    listener.stop()

    expect(result).toEqual({ status: 'skipped', reason: 'generation' })
    expect(listener.events).toHaveLength(0)
    expect((await loadSongInfo(filePath))?.beatGridMap?.signature).toBe(initialMap.signature)
  })

  it('throws and broadcasts nothing when no storage target or DB write is available', async () => {
    const { filePath, stat } = await setupFile()
    const listener = listenEvents()

    await expect(
      persistDynamicGridDefinition({
        filePath,
        expectedAudioIdentity: stat,
        listRoot: null,
        externalContext: null,
        beatGridMap: createMap('analysis', 128, 0.25),
        timeBasisOffsetMs: 120,
        beatGridAlgorithmVersion: 1,
        gridMetadata: metadata,
        shouldPersist: () => true
      })
    ).rejects.toMatchObject({ code: 'missing-target' })

    store.databaseDir = ''
    await expect(
      persistDynamicGridDefinition({
        filePath,
        expectedAudioIdentity: stat,
        listRoot: mockState.listRoot,
        externalContext: null,
        beatGridMap: createMap('analysis', 128, 0.25),
        timeBasisOffsetMs: 120,
        beatGridAlgorithmVersion: 1,
        gridMetadata: metadata,
        shouldPersist: () => true
      })
    ).rejects.toMatchObject({ code: 'write-failed' })
    listener.stop()
    expect(listener.events).toHaveLength(0)
  })
})

describe('persistDynamicGridDefinition external cache', () => {
  it('writes metadata once and stays idempotent in the external cache', async () => {
    const { filePath, stat } = await setupFile()
    const context: LibraryCacheDb.ExternalAnalysisContext = {
      sourceKind: 'external-playback',
      sourceId: 'dynamic-test',
      rootPath: temporaryRoot,
      relativePath: 'abs:song.mp3',
      filePath
    }
    const initialMap = createMap('analysis', 120, 0)
    await LibraryCacheDb.upsertExternalAnalysisCacheEntry(
      context,
      stat,
      buildInfo({ map: initialMap })
    )
    const base = await LibraryCacheDb.loadExternalAnalysisCacheEntry(context, stat)
    const expectedGrid = buildDynamicGridExpectedSnapshot(base?.info)
    const nextMap = createMap('analysis', 128, 0.25)
    const listener = listenEvents()
    const params = {
      filePath,
      expectedAudioIdentity: stat,
      listRoot: null,
      externalContext: context,
      beatGridMap: nextMap,
      timeBasisOffsetMs: 120,
      beatGridAlgorithmVersion: 1,
      gridMetadata: metadata,
      expectedGrid,
      shouldPersist: () => true
    }

    await expect(persistDynamicGridDefinition(params)).resolves.toEqual({ status: 'written' })
    await expect(persistDynamicGridDefinition(params)).resolves.toEqual({ status: 'unchanged' })
    listener.stop()

    expect(listener.events).toHaveLength(1)
    const info = (await LibraryCacheDb.loadExternalAnalysisCacheEntry(context, stat))?.info
    expect(info?.beatGridMap?.signature).toBe(nextMap.signature)
    expect(info?.beatGridAnalysisMode).toBe('dynamic')
    expect(info?.timeBasisOffsetMs).toBe(120)
  })

  it('protects a manual external grid appearing after the first read', async () => {
    const { filePath, stat } = await setupFile()
    const context: LibraryCacheDb.ExternalAnalysisContext = {
      sourceKind: 'external-playback',
      sourceId: 'dynamic-test',
      rootPath: temporaryRoot,
      relativePath: 'abs:song.mp3',
      filePath
    }
    const initialMap = createMap('analysis', 120, 0)
    await LibraryCacheDb.upsertExternalAnalysisCacheEntry(
      context,
      stat,
      buildInfo({ map: initialMap })
    )
    const base = await LibraryCacheDb.loadExternalAnalysisCacheEntry(context, stat)
    const expectedGrid = buildDynamicGridExpectedSnapshot(base?.info)
    const manualMap = createMap('manual', 126, 0.1)
    await LibraryCacheDb.upsertExternalAnalysisCacheEntry(
      context,
      stat,
      buildInfo({ map: manualMap, title: 'manual-title' })
    )
    const listener = listenEvents()

    const result = await persistDynamicGridDefinition({
      filePath,
      expectedAudioIdentity: stat,
      listRoot: null,
      externalContext: context,
      beatGridMap: createMap('analysis', 128, 0.25),
      timeBasisOffsetMs: 120,
      beatGridAlgorithmVersion: 1,
      gridMetadata: metadata,
      expectedGrid,
      shouldPersist: () => true
    })
    listener.stop()

    expect(result).toEqual({ status: 'skipped', reason: 'manual' })
    expect(listener.events).toHaveLength(0)
    const info = (await LibraryCacheDb.loadExternalAnalysisCacheEntry(context, stat))?.info
    expect(info?.beatGridMap?.signature).toBe(manualMap.signature)
    expect(info?.title).toBe('manual-title')
  })
})

describe('persistBpm dynamic done/event ordering', () => {
  const buildOutcome = () => {
    const map = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0.25, bpm: 128, downbeatBeatOffset: 0 },
        { startSec: 60, anchorSec: 60.25, bpm: 128, downbeatBeatOffset: 0 }
      ],
      'analysis',
      { allowSingleClip: true }
    )
    if (!map) throw new Error('dynamic map fixture failed')
    return buildDynamicSuccessOutcome(map)
  }

  it('sets done and emits only after the single commit succeeds', async () => {
    const { filePath, stat } = await setupFile()
    const outcome = buildOutcome()
    const doneByPath = new Map<string, DoneEntry>()
    const events = new EventEmitter()
    const persistence = createKeyAnalysisPersistence({
      doneByPath,
      events
    })
    const listener = listenEvents()

    await persistence.persistBpm(filePath, 0, undefined, undefined, 120, {
      dynamicGridOutcome: outcome,
      expectedAudioDurationSec: 120,
      expectedAudioIdentity: stat
    })
    listener.stop()

    expect(listener.events).toHaveLength(1)
    expect(doneByPath.get(normalizePath(filePath))).toBeTruthy()
    const definition = resolveDynamicGridTimelineDefinition({
      outcome,
      timeBasisOffsetMs: 120,
      expectedDurationAudioSec: 120
    })
    expect(definition.ok).toBe(true)
    if (definition.ok) {
      expect((await loadSongInfo(filePath))?.beatGridMap?.signature).toBe(
        definition.value.map.signature
      )
    }
  })

  it('keeps done empty and emits nothing when shouldPersist is false', async () => {
    const { filePath, stat } = await setupFile()
    const doneByPath = new Map<string, DoneEntry>()
    const persistence = createKeyAnalysisPersistence({
      doneByPath,
      events: new EventEmitter()
    })
    const listener = listenEvents()

    await persistence.persistBpm(filePath, 0, undefined, undefined, 120, {
      dynamicGridOutcome: buildOutcome(),
      expectedAudioDurationSec: 120,
      expectedAudioIdentity: stat,
      shouldPersist: () => false
    })
    listener.stop()

    expect(listener.events).toHaveLength(0)
    expect(doneByPath.size).toBe(0)
  })

  it('keeps done/event empty when the commit throws', async () => {
    const { filePath, stat } = await setupFile()
    const doneByPath = new Map<string, DoneEntry>()
    const persistence = createKeyAnalysisPersistence({
      doneByPath,
      events: new EventEmitter()
    })
    const listener = listenEvents()
    store.databaseDir = ''

    await expect(
      persistence.persistBpm(filePath, 0, undefined, undefined, 120, {
        dynamicGridOutcome: buildOutcome(),
        expectedAudioDurationSec: 120,
        expectedAudioIdentity: stat
      })
    ).rejects.toMatchObject({ code: 'write-failed' })
    listener.stop()

    expect(listener.events).toHaveLength(0)
    expect(doneByPath.size).toBe(0)
  })
})
