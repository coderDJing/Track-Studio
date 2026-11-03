// Started by FRKB-API/scripts/test-set-library-http.cjs; uses real HTTP, MongoDB and transfers.
import { afterAll, expect, it, vi } from 'vitest'
import fs from 'fs-extra'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    getPath: () => os.tmpdir(),
    isReady: () => true,
    whenReady: () => Promise.resolve()
  },
  session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
  ipcMain: { handle: () => {}, on: () => {} },
  powerMonitor: { on: () => {} },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  },
  screen: {},
  dialog: {},
  nativeImage: {},
  Notification: class {}
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../window/mainWindow', () => ({ default: { instance: null } }))
vi.mock('../window/updateWindow', () => ({ default: {} }))
vi.mock('../services/globalSongSearch', () => ({ markGlobalSongSearchDirty: vi.fn() }))
vi.mock('../services/libraryMerge/runtime', () => ({ assertLibraryMergeMutationAllowed: () => {} }))
vi.mock('../curatedLibrarySync/busyPaths', () => ({ isPathBusyForRemoteMutation: () => false }))
vi.mock('../curatedLibrarySync/applyUiNotify', () => ({ notifyTree: vi.fn() }))
vi.mock('../libraryTreeWatcher', () => ({
  beginLibraryTreeWatcherBulkOperation: () => () => {},
  waitForLibraryTreeWatcherIdle: async () => true,
  notifyLibraryFsChanged: () => {}
}))

import store from '../store'
import { closeLibraryDb, getLibraryDb, initLibraryDb } from '../libraryDb'
import {
  insertLibraryNode,
  loadLibraryNodes,
  removeLibraryNode,
  syncLibraryTreeFromDisk,
  updateLibraryNodeName
} from '../libraryTreeDb'
import {
  appendSetItems,
  listSetItemsByPlaylist,
  removeSetItemsByIds,
  removeSetItemsByPlaylist,
  reorderSetPlaylistItems
} from '../setListDb'
import { upsertSongCacheEntry } from '../libraryCacheDb/songCache'
import {
  upsertUnifiedDisplayWaveformCacheEntry,
  loadUnifiedDisplayWaveformCacheData
} from '../libraryCacheDb/unifiedDisplayWaveformCache'
import { getSetCustodyDirAbs } from '../services/setCustody'
import { loadSetPlaylistSongs } from '../ipc/setListHandlers'
import { createPackageWaveformFixture } from '../services/setPackage/waveformTestFixtures'
import { createSongBeatGridMapV2FromFixedGrid } from '../../shared/songBeatGridMapV2'
import { CURRENT_SONG_ENERGY_ALGORITHM_VERSION } from '../../shared/songEnergy'
import { CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION } from '../../shared/songStructure'
import { setSetLibrarySyncEnabled } from './state'
import { cancelSetLibrarySync, enqueueSetLibrarySync } from './engine'
import { beginBlobUpload, downloadBlobFile, uploadBlobChunk } from '../curatedLibrarySync/apiClient'
import { uploadBlobWithResume } from '../curatedLibrarySync/blobTransfer'
import { setSyncRequest } from './api'
import type { ISongInfo } from '../../types/globals'
import { SET_SYNC_ROOT } from '../../shared/setLibrarySync'

const base = process.env.FRKB_TEST_HTTP_BASE_URL || ''
const enabled = !!base
if (enabled && new URL(base).hostname !== '127.0.0.1')
  throw new Error('HTTP integration must use an isolated localhost server')
const root = process.env.FRKB_TEST_HTTP_ROOT || ''
const checks: string[] = []
const record = (message: string) => {
  checks.push(message.replace(/^PASS: /, ''))
  fs.writeJsonSync(path.join(root, 'http-checks.json'), checks, { spaces: 2 })
}
const userKey = process.env.FRKB_TEST_HTTP_USER_KEY || ''
const apiKey = process.env.FRKB_TEST_HTTP_API_KEY || ''
const original = { databaseDir: store.databaseDir, settingConfig: store.settingConfig }
const signal = () => new AbortController().signal
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const coreDirNames = {
  FilterLibrary: 'FilterLibrary',
  CuratedLibrary: 'CuratedLibrary',
  SetLibrary: 'SetLibrary',
  MixtapeLibrary: 'MixtapeLibrary',
  RecordingLibrary: 'RecordingLibrary',
  RecycleBin: 'RecycleBin'
}
async function open(name: string) {
  closeLibraryDb()
  store.databaseDir = path.join(root, name)
  store.settingConfig = {
    ...original.settingConfig,
    databaseUrl: store.databaseDir,
    cloudSyncUserKey: userKey,
    cloudSyncLastKnownBaseUrl: base,
    audioExt: ['.wav']
  }
  for (const dir of Object.values(coreDirNames))
    await fs.ensureDir(path.join(store.databaseDir, 'library', dir))
  if (!initLibraryDb(store.databaseDir)) throw new Error('isolated client database did not open')
  await syncLibraryTreeFromDisk(store.databaseDir, { coreDirNames })
  setSetLibrarySyncEnabled(true)
}
async function sync(resolution?: 'cloud' | 'local') {
  const result = await enqueueSetLibrarySync(resolution)
  expect(result.error, JSON.stringify(result)).toBe('')
  expect(['success', 'unchanged'], JSON.stringify(result)).toContain(result.result)
  return result
}
async function renameSet(id: string, name: string) {
  const previous = loadLibraryNodes()!.find((n) => n.uuid === id)!
  const parent = path.join(store.databaseDir, 'library', 'SetLibrary')
  await fs.rename(path.join(parent, previous.dirName), path.join(parent, name))
  expect(updateLibraryNodeName(id, name)).toBe(true)
}
function wavBytes(size: number) {
  const data = Buffer.alloc(size + 44)
  data.write('RIFF')
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(48000, 24)
  data.writeUInt32LE(96000, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(size, 40)
  for (let n = 44; n + 1 < data.length; n += 2)
    data.writeInt16LE(Math.round(Math.sin(n / 23) * 20000), n)
  return data
}
async function sourceSong(file: string): Promise<ISongInfo> {
  const grid = createSongBeatGridMapV2FromFixedGrid({
    bpm: 128,
    firstBeatMs: 125,
    downbeatBeatOffset: 0,
    source: 'manual'
  })!
  const song: ISongInfo = {
    filePath: file,
    fileName: path.basename(file),
    fileFormat: 'WAV',
    cover: null,
    title: 'Live HTTP SET',
    artist: 'Test Artist',
    album: 'Test Album',
    duration: '06:00',
    genre: 'Techno',
    label: 'Test Label',
    bitrate: 768000,
    container: 'WAV',
    key: '8A',
    keyAnalysisAlgorithmVersion: 1,
    beatGridMap: grid,
    beatGridAlgorithmVersion: 1,
    energyScore: 7,
    energyAlgorithmVersion: CURRENT_SONG_ENERGY_ALGORITHM_VERSION,
    energyAnalysis: {
      version: 11,
      model: 'musicnn-deam-emomusic-structure-v11',
      sustainedScore: 7,
      averageScore: 6,
      medianScore: 6,
      peakScore: 8,
      rangeScore: 4,
      confidence: 0.9,
      patchCount: 20,
      energyCurve: [{ timeMs: 0, score: 7, role: 'drop' }]
    },
    songStructure: {
      formatVersion: 2,
      algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
      source: 'algorithmic',
      durationSec: 360,
      beatGridSignature: grid.signature,
      sections: [
        {
          startSec: 0,
          endSec: 360,
          startDownbeatOrdinal: 0,
          endDownbeatOrdinal: 192,
          kind: 'groove',
          confidence: 0.8,
          energy: 0.7,
          low: 0.6,
          high: 0.4,
          novelty: 0.2
        }
      ]
    },
    hotCues: [{ slot: 0, sec: 1.5, label: 'Intro' }],
    memoryCues: [{ sec: 64, order: 1, comment: 'Break' }]
  }
  const stat = await fs.stat(file)
  expect(
    await upsertSongCacheEntry(path.dirname(file), file, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      info: song
    })
  ).toBe(true)
  return song
}
afterAll(() => {
  if (enabled) {
    closeLibraryDb()
    store.databaseDir = original.databaseDir
    store.settingConfig = original.settingConfig
  }
})

it.skipIf(!enabled)(
  'runs real client A/B sync, interruption/retry, analysis, conflicts and deletion over HTTP',
  async () => {
    await open('A')
    const resumeFile = process.env.FRKB_TEST_RESUME_FILE!
    const resume = {
      sha256: process.env.FRKB_TEST_RESUME_SHA!,
      size: (await fs.stat(resumeFile)).size,
      scope: 'set' as const
    }
    expect((await beginBlobUpload(resume)).uploadedBytes).toBe(1024 * 1024)
    await uploadBlobWithResume({ ...resume, filePath: resumeFile })
    expect((await beginBlobUpload(resume)).needed).toBe(false)
    const resumeDest = path.join(root, 'resumed-download.bin')
    const resumeBytes = await fs.readFile(resumeFile)
    await fs.writeFile(resumeDest, resumeBytes.subarray(0, 512 * 1024))
    await downloadBlobFile({ ...resume, destPath: resumeDest, expectedSize: resume.size })
    expect(sha(await fs.readFile(resumeDest))).toBe(resume.sha256)
    record('PASS: upload after API restart and actual Range download resume')

    const setRoot = loadLibraryNodes()!.find((n) => n.dirName === 'SetLibrary')!
    const playlist = randomUUID()
    const setDir = path.join(store.databaseDir, 'library', 'SetLibrary', 'Friday')
    await fs.ensureDir(setDir)
    await fs.writeFile(path.join(setDir, '.frkb.uuid'), playlist)
    insertLibraryNode({
      uuid: playlist,
      parentUuid: setRoot.uuid,
      dirName: 'Friday',
      nodeType: 'setList',
      order: 1
    })
    const audio = path.join(store.databaseDir, 'library', 'CuratedLibrary', 'track.wav')
    await fs.writeFile(audio, wavBytes(9 * 1024 * 1024))
    const song = await sourceSong(audio)
    expect(
      await upsertUnifiedDisplayWaveformCacheEntry(
        path.dirname(audio),
        audio,
        await fs.stat(audio),
        createPackageWaveformFixture(7)
      )
    ).toBe(true)
    const rows = appendSetItems(playlist, [{ filePath: audio }, { filePath: audio }])
    const originalSha = sha(await fs.readFile(audio))
    await sync()
    let cloud = await setSyncRequest('pull', {}, signal())
    expect(cloud.items).toHaveLength(2)
    expect(cloud.items[0].audio.sha256).toBe(originalSha)
    expect(cloud.items[0].waveform).not.toBeNull()
    record('PASS: A uploaded real WAV, duplicate rows, full analysis and waveform')

    await open('B')
    await fetch(`${base}/__test/stall-next-download`)
    const interrupted = enqueueSetLibrarySync()
    let stalled = false
    for (let n = 0; n < 100; n++) {
      const state = await (await fetch(`${base}/__test/state`)).json()
      if (state.stalled) {
        stalled = true
        break
      }
      await pause(20)
    }
    expect(stalled).toBe(true)
    await pause(100)
    cancelSetLibrarySync()
    expect((await interrupted).result).toBe('cancelled')
    expect(listSetItemsByPlaylist(playlist)).toEqual([])
    await sync()
    const custodyRows = listSetItemsByPlaylist(playlist)
    expect(custodyRows.map((r) => r.id)).toEqual(rows.map((r) => r.id))
    expect(custodyRows[0].filePath).toBe(custodyRows[1].filePath)
    expect(custodyRows[0].filePath).toContain('__set_custody__')
    expect(sha(await fs.readFile(custodyRows[0].filePath))).toBe(originalSha)
    const restored = (await loadSetPlaylistSongs(playlist)).scanData[0]
    for (const field of [
      'beatGridMap',
      'hotCues',
      'memoryCues',
      'key',
      'energyAnalysis',
      'songStructure'
    ] as const)
      expect(restored[field], field).toEqual(song[field])
    expect(
      await loadUnifiedDisplayWaveformCacheData(
        getSetCustodyDirAbs(),
        custodyRows[0].filePath,
        await fs.stat(custodyRows[0].filePath)
      )
    ).not.toBeNull()
    expect((await sync()).result).toBe('unchanged')
    record(
      'PASS: cancelled B download retried, custody/IDs/analysis/waveforms restored, no-op stays unchanged'
    )

    reorderSetPlaylistItems(playlist, [rows[1].id, rows[0].id])
    await open('A')
    const extra = path.join(path.dirname(audio), 'extra.wav')
    await fs.writeFile(extra, wavBytes(96000))
    await sourceSong(extra)
    const extraRows = appendSetItems(playlist, [{ filePath: extra }])
    await sync()
    await open('B')
    await sync()
    expect(listSetItemsByPlaylist(playlist).map((r) => r.id)).toEqual([
      rows[1].id,
      rows[0].id,
      extraRows[0].id
    ])
    await open('A')
    await sync()
    expect(listSetItemsByPlaylist(playlist)[0].filePath).toBe(audio)
    record('PASS: offline B reorder merged with A addition, original source paths retained')

    await open('B')
    await renameSet(playlist, 'B edit')
    await open('A')
    await renameSet(playlist, 'A edit')
    await sync()
    await open('B')
    const conflict = await enqueueSetLibrarySync()
    expect(conflict.result).toBe('conflicts')
    expect(loadLibraryNodes()!.find((n) => n.uuid === playlist)!.dirName).toBe('B edit')
    await sync('cloud')
    expect(loadLibraryNodes()!.find((n) => n.uuid === playlist)!.dirName).toBe('A edit')
    record('PASS: real concurrent edits pause before applying, explicit cloud choice resolves')

    const bRow = listSetItemsByPlaylist(playlist).find((r) => r.id === rows[0].id)!
    const bSong = (await loadSetPlaylistSongs(playlist)).scanData.find(
      (s) => s.setItemId === rows[0].id
    )!
    const stat = await fs.stat(bRow.filePath)
    const changedSong = {
      ...bSong,
      hotCues: [{ slot: 1, sec: 12, label: 'B cue' }],
      memoryCues: []
    }
    expect(
      await upsertSongCacheEntry(getSetCustodyDirAbs(), bRow.filePath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        info: changedSong
      })
    ).toBe(true)
    await sync()
    await open('A')
    await sync()
    const updated = (await loadSetPlaylistSongs(playlist)).scanData.find(
      (s) => s.setItemId === rows[0].id
    )!
    expect(updated.hotCues).toEqual(changedSong.hotCues)
    expect(updated.memoryCues).toEqual([])
    expect(listSetItemsByPlaylist(playlist).find((r) => r.id === rows[0].id)!.filePath).toBe(audio)
    record('PASS: B Cue changes and cleared Memory Cues propagate back to original mapped source')

    await open('B')
    removeSetItemsByIds([rows[0].id])
    await sync()
    expect(await fs.pathExists(bRow.filePath)).toBe(true)
    await open('A')
    await sync()
    expect(listSetItemsByPlaylist(playlist)).toHaveLength(2)
    await open('B')
    removeSetItemsByPlaylist(playlist)
    removeLibraryNode(playlist)
    await fs.remove(path.join(store.databaseDir, 'library', 'SetLibrary', 'A edit'))
    await sync()
    await open('A')
    await sync()
    expect(listSetItemsByPlaylist(playlist)).toEqual([])
    expect(loadLibraryNodes()!.some((n) => n.uuid === playlist)).toBe(false)
    expect(sha(await fs.readFile(audio))).toBe(originalSha)
    expect(await fs.pathExists(extra)).toBe(true)
    record('PASS: row deletion keeps shared custody, deleting SET preserves original audio')

    cloud = await setSyncRequest('pull', {}, signal())
    expect(cloud.items).toEqual([])
    const headers = { Authorization: `Bearer ${apiKey}` }
    const url = `${base}/frkbapi/v1/set-library-sync/blob/${originalSha}?userKey=${process.env.FRKB_TEST_HTTP_OTHER_KEY}`
    expect((await fetch(url, { headers })).status).toBe(404)
    record('PASS: another authorized user cannot read this user’s audio')

    // A moderate SET has more than 100 blob requests; chunk traffic must not exhaust metadata limits.
    let blocked = 0
    for (let n = 0; n < 110; n++) {
      const response = await fetch(
        `${base}/frkbapi/v1/set-library-sync/blob/${resume.sha256}?userKey=${userKey}`,
        {
          headers: { ...headers, Range: 'bytes=0-0' }
        }
      )
      if (response.status === 429) blocked++
      else expect(response.status).toBe(206)
      await response.arrayBuffer()
    }
    expect(blocked, 'blob traffic exhausted the shared metadata rate limit').toBe(0)
    const current = await setSyncRequest('pull', {}, signal())
    record('PASS: sustained blob requests do not block SET metadata synchronization')
    const post = async (endpoint: string, body: Record<string, unknown>) => {
      const response = await fetch(`${base}/frkbapi/v1/set-library-sync/${endpoint}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, userKey })
      })
      return { status: response.status, body: await response.json() }
    }
    const node = {
      id: randomUUID(),
      parentId: SET_SYNC_ROOT,
      type: 'setList',
      name: 'Race SET',
      order: 1
    }
    const missing = { sha256: 'c'.repeat(64), size: 4 }
    const denied = await post('push', {
      protocolVersion: 1,
      baseRevision: current.revision,
      nodes: [node],
      items: [
        {
          id: randomUUID(),
          playlistId: node.id,
          order: 1,
          createdAtMs: 1,
          fileName: 'missing.wav',
          audio: missing,
          analysis: missing,
          waveform: null
        }
      ]
    })
    expect(denied.status).toBe(409)
    expect(denied.body.error).toBe('SET_SYNC_BLOB_NOT_READY')
    expect((await setSyncRequest('pull', {}, signal())).revision).toBe(current.revision)
    record('PASS: incomplete resources cannot publish a snapshot or advance its revision')
    const commit = { protocolVersion: 1, baseRevision: current.revision, nodes: [node], items: [] }
    const race = await Promise.all([
      post('push', commit),
      post('push', {
        ...commit,
        nodes: [{ ...node, name: 'Other concurrent version' }]
      })
    ])
    expect(race.map((r) => r.status).sort()).toEqual([200, 409])
    expect((await setSyncRequest('pull', {}, signal())).revision).toBe(current.revision + 1)
    record('PASS: concurrent HTTP commits accept one revision and reject the stale writer')
    const bad = { sha256: 'd'.repeat(64), size: 4 }
    expect((await post('blob/begin', bad)).status).toBe(200)
    await expect(
      uploadBlobChunk({ ...bad, scope: 'set', offset: 0, chunk: Buffer.from('bad!') })
    ).rejects.toThrow('HASH_MISMATCH')
    expect(
      (
        await fetch(`${base}/frkbapi/v1/set-library-sync/blob/${bad.sha256}?userKey=${userKey}`, {
          headers
        })
      ).status
    ).toBe(404)
    record('PASS: corrupt audio is rejected by SHA-256 and never becomes downloadable')
    expect(getLibraryDb()).not.toBeNull()
  },
  120000
)
