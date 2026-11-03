// Run: pnpm exec vitest run src/main/setLibrarySync/sync.spec.ts
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
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
  ipcMain: { handle: () => {}, on: () => {} },
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
vi.mock('../curatedLibrarySync/apiClient', () => ({
  downloadBlobFile: vi.fn(() => {
    throw new Error('unexpected download')
  })
}))

import store from '../store'
import { closeLibraryDb, getLibraryDb, initLibraryDb } from '../libraryDb'
import { syncLibraryTreeFromDisk, insertLibraryNode, loadLibraryNodes } from '../libraryTreeDb'
import { appendSetItems, listSetItemsByPlaylist, reorderSetPlaylistItems } from '../setListDb'
import { upsertSongCacheEntry } from '../libraryCacheDb/songCache'
import { loadSetPlaylistSongs } from '../ipc/setListHandlers'
import { emptySetSnapshot, mergeSetSnapshots } from '../../shared/setLibrarySync'
import { scanSetLibrary, type SetLocalScan } from './scan'
import { applySetSnapshot, getSetAsset } from './apply'
import { downloadBlobFile } from '../curatedLibrarySync/apiClient'
import { commitSetTree, recoverSetTreeTransaction } from './treeTransaction'
import { writeSetSyncBase, readSetSyncBase } from './state'
import type { ISongInfo } from '../../types/globals'
import { createPackageWaveformFixture } from '../services/setPackage/waveformTestFixtures'
import { createSongBeatGridMapV2FromFixedGrid } from '../../shared/songBeatGridMapV2'
import {
  upsertUnifiedDisplayWaveformCacheEntry,
  loadUnifiedDisplayWaveformCacheData
} from '../libraryCacheDb/unifiedDisplayWaveformCache'

const originalRoot = store.databaseDir
let temporary: string
const coreDirNames = {
  FilterLibrary: 'FilterLibrary',
  CuratedLibrary: 'CuratedLibrary',
  SetLibrary: 'SetLibrary',
  MixtapeLibrary: 'MixtapeLibrary',
  RecordingLibrary: 'RecordingLibrary',
  RecycleBin: 'RecycleBin'
}
const userKey = '99999999-9999-4999-8999-999999999999'
const signal = () => new AbortController().signal
const open = async (root: string) => {
  closeLibraryDb()
  store.databaseDir = root
  await fs.ensureDir(path.join(root, 'library', 'SetLibrary'))
  if (!initLibraryDb(root)) throw new Error('test DB did not open')
  await syncLibraryTreeFromDisk(root, { coreDirNames })
}
const scan = async () => {
  try {
    return await scanSetLibrary(signal())
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'SET_SYNC_LOCAL_CHANGED') throw error
    return scanSetLibrary(signal())
  }
}
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-set-cloud-'))
})
afterEach(async () => {
  closeLibraryDb()
  store.databaseDir = originalRoot
  await fs.remove(temporary)
  vi.restoreAllMocks()
})

async function buildSource() {
  const root = path.join(temporary, 'A')
  await open(root)
  const setRoot = loadLibraryNodes()!.find((n) => n.dirName === 'SetLibrary')!
  const playlist = randomUUID()
  await fs.ensureDir(path.join(root, 'library', 'SetLibrary', 'Friday'))
  insertLibraryNode({
    uuid: playlist,
    parentUuid: setRoot.uuid,
    dirName: 'Friday',
    nodeType: 'setList',
    order: 1
  })
  const audio = path.join(root, 'library', 'CuratedLibrary', 'track.mp3')
  await fs.outputFile(audio, Buffer.from('test audio bytes'))
  const stat = await fs.stat(audio)
  const song: ISongInfo = {
    filePath: audio,
    fileName: 'track.mp3',
    fileFormat: 'MP3',
    title: 'Track',
    duration: '180',
    artist: undefined,
    album: undefined,
    genre: undefined,
    label: undefined,
    bitrate: undefined,
    container: 'MPEG',
    cover: null,
    hotCues: [{ slot: 0, sec: 5, label: 'Intro' }],
    memoryCues: [],
    beatGridMap:
      createSongBeatGridMapV2FromFixedGrid({
        bpm: 128,
        firstBeatMs: 125,
        downbeatBeatOffset: 0,
        source: 'manual'
      }) || undefined,
    beatGridAlgorithmVersion: 1
  }
  expect(
    await upsertSongCacheEntry(path.dirname(audio), audio, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      info: song
    })
  ).toBe(true)
  expect(
    await upsertUnifiedDisplayWaveformCacheEntry(
      path.dirname(audio),
      audio,
      stat,
      createPackageWaveformFixture(1)
    )
  ).toBe(true)
  const rows = appendSetItems(playlist, [{ filePath: audio }, { filePath: audio }])
  return { root, playlist, audio, rows, scan: await scan() }
}
function shareAssets(source: SetLocalScan, receiver: SetLocalScan) {
  for (const [sha, file] of source.files) receiver.files.set(sha, file)
}

it('moves a complete SET to another library as custody, retains duplicate identities and syncs reorder/deletion back', async () => {
  const a = await buildSource()
  const cloud = { ...a.scan.snapshot, revision: 1 }
  writeSetSyncBase(userKey, cloud)
  await open(path.join(temporary, 'B'))
  const b = await scan()
  shareAssets(a.scan, b)
  await applySetSnapshot(b, cloud, userKey, signal(), () => {})
  const rows = listSetItemsByPlaylist(a.playlist)
  expect(rows.map((r) => r.id)).toEqual(a.rows.map((r) => r.id))
  expect(rows[0].filePath).toContain('__set_custody__')
  expect(rows[0].filePath).toBe(rows[1].filePath)
  expect(await fs.readFile(rows[0].filePath)).toEqual(await fs.readFile(a.audio))
  expect((await loadSetPlaylistSongs(a.playlist)).scanData.map((s) => s.title)).toEqual([
    'Track',
    'Track'
  ])
  const restored = (await loadSetPlaylistSongs(a.playlist)).scanData[0]
  expect(restored.beatGridMap).toBeDefined()
  expect(restored.hotCues).toEqual([{ slot: 0, sec: 5, label: 'Intro' }])
  expect(
    await loadUnifiedDisplayWaveformCacheData(
      path.join(store.databaseDir, 'library', 'SetLibrary', '__set_custody__'),
      rows[0].filePath,
      await fs.stat(rows[0].filePath)
    )
  ).not.toBeNull()
  reorderSetPlaylistItems(a.playlist, [rows[1].id, rows[0].id])
  const changedB = await scan()
  const next = { ...mergeSetSnapshots(cloud, changedB.snapshot, cloud).snapshot, revision: 2 }
  await open(a.root)
  const currentA = await scan()
  shareAssets(changedB, currentA)
  await applySetSnapshot(currentA, next, userKey, signal(), () => {})
  expect(listSetItemsByPlaylist(a.playlist).map((r) => r.id)).toEqual([a.rows[1].id, a.rows[0].id])
  expect(listSetItemsByPlaylist(a.playlist)[0].filePath).toBe(a.audio)
  const beforeDelete = await scan()
  await applySetSnapshot(
    beforeDelete,
    { ...emptySetSnapshot(), revision: 3 },
    userKey,
    signal(),
    () => {}
  )
  expect(listSetItemsByPlaylist(a.playlist)).toEqual([])
  expect(await fs.pathExists(a.audio)).toBe(true)
  expect(readSetSyncBase(userKey).revision).toBe(3)
  await open(path.join(temporary, 'B'))
  const beforeCustodyDelete = await scan()
  const custodyFile = listSetItemsByPlaylist(a.playlist)[0].filePath
  await applySetSnapshot(
    beforeCustodyDelete,
    { ...emptySetSnapshot(), revision: 3 },
    userKey,
    signal(),
    () => {}
  )
  expect(await fs.pathExists(custodyFile)).toBe(false)
  expect(await fs.pathExists(a.audio)).toBe(true)
})

it('rolls back directory moves and metadata together when the database commit fails', async () => {
  const a = await buildSource()
  const target = {
    ...a.scan.snapshot,
    nodes: a.scan.snapshot.nodes.map((n) => ({ ...n, name: 'Renamed' }))
  }
  expect(() =>
    commitSetTree(a.scan, target, () => {
      throw new Error('simulated failure')
    })
  ).toThrow('simulated failure')
  expect(await fs.pathExists(path.join(a.root, 'library', 'SetLibrary', 'Friday'))).toBe(true)
  expect(await fs.pathExists(path.join(a.root, 'library', 'SetLibrary', 'Renamed'))).toBe(false)
  expect(listSetItemsByPlaylist(a.playlist)).toHaveLength(2)
})

it('rejects local edits arriving after download preparation', async () => {
  const a = await buildSource()
  getLibraryDb()!.prepare('UPDATE set_items SET sort_order = sort_order + 1').run()
  await expect(
    applySetSnapshot(a.scan, a.scan.snapshot, userKey, signal(), () => {})
  ).rejects.toThrow('LOCAL_CHANGED')
  expect(listSetItemsByPlaylist(a.playlist).map((r) => r.sortOrder)).toEqual([2, 3])
})

it('recovers an interrupted filesystem operation before a new sync', async () => {
  const a = await buildSource()
  const dir = path.dirname(a.scan.directory)
  const from = path.join(a.root, 'library', 'SetLibrary', 'Friday')
  const to = path.join(dir, 'interrupted')
  await fs.move(from, to)
  await fs.writeJSON(path.join(dir, 'tree-journal.json'), {
    id: randomUUID(),
    actions: [{ kind: 'move', from, to }]
  })
  await recoverSetTreeTransaction()
  expect(await fs.pathExists(from)).toBe(true)
  expect(await fs.pathExists(to)).toBe(false)
})

it('continues a cancelled download instead of rejecting its partial cache file', async () => {
  const payload = Buffer.from('complete verified audio bytes')
  const asset = { sha256: createHash('sha256').update(payload).digest('hex'), size: payload.length }
  const destination = path.join(temporary, asset.sha256)
  await fs.writeFile(destination, payload.subarray(0, 8))
  vi.mocked(downloadBlobFile).mockImplementationOnce(async (params) => {
    expect(await fs.readFile(params.destPath)).toEqual(payload.subarray(0, 8))
    await fs.appendFile(params.destPath, payload.subarray(8))
  })
  await expect(getSetAsset(asset, temporary, new Map(), signal())).resolves.toBe(destination)
  expect(await fs.readFile(destination)).toEqual(payload)
})

it('applies remote Cue edits to the existing relative cache key of a mapped source', async () => {
  const a = await buildSource()
  const original = a.scan.snapshot.items[0]
  const metadata = await fs.readJSON(a.scan.files.get(original.analysis.sha256)!)
  metadata.hotCues = [{ slot: 1, sec: 12, label: 'Remote cue' }]
  metadata.memoryCues = []
  const bytes = Buffer.from(JSON.stringify(metadata))
  const analysis = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
  const file = path.join(a.scan.directory, analysis.sha256)
  await fs.writeFile(file, bytes)
  a.scan.files.set(analysis.sha256, file)
  const target = {
    ...a.scan.snapshot,
    revision: 1,
    items: a.scan.snapshot.items.map((item) => ({ ...item, analysis }))
  }
  await applySetSnapshot(a.scan, target, userKey, signal(), () => {})
  const restored = (await loadSetPlaylistSongs(a.playlist)).scanData
  expect(restored.every((song) => song.hotCues?.[0]?.label === 'Remote cue')).toBe(true)
  expect(restored.every((song) => song.memoryCues?.length === 0)).toBe(true)
  const cache = getLibraryDb()!
    .prepare<{ file_path: string }>('SELECT file_path FROM song_cache')
    .all()
  expect(cache).toEqual([{ file_path: 'track.mp3' }])
})
