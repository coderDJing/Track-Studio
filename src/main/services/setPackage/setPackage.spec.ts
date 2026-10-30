// Run: pnpm exec vitest run src/main/services/setPackage/setPackage.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ISongInfo } from '../../../types/globals'

const ipcHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
const cleanupMocks = vi.hoisted(() => ({ trashItem: vi.fn<() => Promise<void>>() }))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    getPath: () => os.tmpdir(),
    isReady: () => true,
    whenReady: () => Promise.resolve()
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      ipcHandlers.set(channel, handler)
    },
    on: () => {}
  },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  },
  screen: {},
  shell: { trashItem: cleanupMocks.trashItem },
  dialog: {},
  nativeImage: {},
  Notification: class {}
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../window/mainWindow', () => ({ default: { instance: null } }))
vi.mock('../../window/updateWindow', () => ({ default: {} }))
vi.mock('../globalSongSearch', () => ({ markGlobalSongSearchDirty: () => {} }))
vi.mock('../libraryMerge/runtime', () => ({ assertLibraryMergeMutationAllowed: () => {} }))

import { closeLibraryDb, initLibraryDb } from '../../libraryDb'
import store from '../../store'
import { insertLibraryNode, loadLibraryNodes, syncLibraryTreeFromDisk } from '../../libraryTreeDb'
import { appendSetItems, listSetItemsByPlaylist } from '../../setListDb'
import {
  registerSetListHandlers,
  removeSetItemsByPlaylistWithCustodyCleanup
} from '../../ipc/setListHandlers'
import { createSongBeatGridMapV2FromFixedGrid } from '../../../shared/songBeatGridMapV2'
import { exportSetPackage } from './exportSetPackage'
import { importSetPackage } from './importSetPackage'
import { readSetPackageManifest } from './manifest'
import { cleanupImportedPackage } from './cleanupImportedPackage'

const coreDirNames = {
  FilterLibrary: 'FilterLibrary',
  CuratedLibrary: 'CuratedLibrary',
  SetLibrary: 'SetLibrary',
  MixtapeLibrary: 'MixtapeLibrary',
  RecordingLibrary: 'RecordingLibrary',
  RecycleBin: 'RecycleBin'
}

const previousDatabaseDir = store.databaseDir
const tempDirs: string[] = []

const makeTempDir = async (prefix: string) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

// 模拟一台电脑上的音乐库：打开数据库并建好一个空的 SET 歌单。
const openLibrary = async (root: string, setUuid: string, setName: string) => {
  closeLibraryDb()
  store.databaseDir = root
  await fs.mkdir(path.join(root, 'library', 'SetLibrary'), { recursive: true })
  if (!initLibraryDb(root)) throw new Error('test database did not open')
  await syncLibraryTreeFromDisk(root, { coreDirNames })
  const setLibrary = (loadLibraryNodes(root) || []).find((node) => node.dirName === 'SetLibrary')
  if (!setLibrary) throw new Error('SetLibrary node missing')
  await fs.mkdir(path.join(root, 'library', 'SetLibrary', setName))
  insertLibraryNode(
    { uuid: setUuid, parentUuid: setLibrary.uuid, dirName: setName, nodeType: 'setList' },
    root
  )
}

const writeAudio = async (filePath: string, seed: number, size = 4096) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const bytes = Buffer.alloc(size)
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + seed) % 256
  await fs.writeFile(filePath, bytes)
}

const gridMap = (bpm: number, firstBeatMs: number) => {
  const map = createSongBeatGridMapV2FromFixedGrid({
    bpm,
    firstBeatMs,
    downbeatBeatOffset: 1,
    source: 'manual'
  })
  if (!map) throw new Error('grid fixture failed')
  return map
}

const buildSong = (filePath: string, setItemId: string, title: string, bpm: number): ISongInfo =>
  ({
    filePath,
    fileName: path.basename(filePath),
    fileFormat: 'MP3',
    cover: null,
    title,
    artist: 'Artist',
    album: 'Album',
    duration: '06:00',
    genre: 'Techno',
    label: 'Label',
    bitrate: 320000,
    container: 'MPEG',
    key: '8A',
    keyAnalysisAlgorithmVersion: 1,
    beatGridMap: gridMap(bpm, 123.4),
    beatGridAlgorithmVersion: 1,
    timeBasisOffsetMs: 12.5,
    timeBasisOffsetAlgorithmVersion: 1,
    hotCues: [
      { slot: 0, sec: 1.5, label: 'Intro', color: '#ff0000' },
      { slot: 2, sec: 30, label: 'Drop', isLoop: true, loopEndSec: 34 }
    ],
    memoryCues: [{ sec: 64, order: 1, comment: 'Break' }],
    setItemId,
    playlistTrackNumber: 1
  }) as ISongInfo

type ExportFixture = {
  manifestPath: string
  packageDir: string
  exportedSongs: ISongInfo[]
  sourceCreatedAt: number[]
}

const exportFromComputerA = async (): Promise<ExportFixture> => {
  const rootA = await makeTempDir('frkb-set-pkg-a-')
  await openLibrary(rootA, 'set-a', 'Friday Set')
  const trackA = path.join(rootA, 'library', 'FilterLibrary', 'House', 'Same Name.mp3')
  const trackB = path.join(rootA, 'library', 'CuratedLibrary', 'Techno', 'Same Name.mp3')
  await writeAudio(trackA, 1)
  await writeAudio(trackB, 2)
  const items = appendSetItems('set-a', [
    { filePath: trackB, createdAtMs: 1_700_000_000_000 },
    { filePath: trackA, createdAtMs: 1_700_000_000_500 },
    { filePath: trackB, createdAtMs: 1_700_000_001_000 }
  ])
  const songs = [
    buildSong(trackB, items[0].id, 'Track B', 128),
    buildSong(trackA, items[1].id, 'Track A', 132.5),
    buildSong(trackB, items[2].id, 'Track B', 128)
  ]
  const exportParent = await makeTempDir('frkb-set-pkg-out-')
  const summary = await exportSetPackage({
    playlistUuid: 'set-a',
    setName: 'Friday Set',
    // renderer 送来的顺序与数据库顺序无关，导出以数据库顺序为准
    songs: [songs[2], songs[0], songs[1]],
    targetParentDir: exportParent
  })
  expect(summary.trackCount).toBe(3)
  expect(summary.fileCount).toBe(2)
  return {
    manifestPath: summary.manifestPath,
    packageDir: summary.packageDir,
    exportedSongs: songs,
    sourceCreatedAt: items.map((item) => item.createdAtMs)
  }
}

beforeEach(() => {
  ipcHandlers.clear()
  cleanupMocks.trashItem.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('SET package export/import', () => {
  it('restores order, added time, grid and cues on another computer', async () => {
    const fixture = await exportFromComputerA()
    const manifest = await readSetPackageManifest(fixture.manifestPath)
    expect(manifest.files.map((file) => file.path)).toEqual([
      'audio/Same Name.mp3',
      'audio/Same Name (2).mp3'
    ])
    for (const track of manifest.tracks) {
      expect(track.song).not.toHaveProperty('filePath')
      expect(track.song).not.toHaveProperty('setItemId')
    }

    const rootB = await makeTempDir('frkb-set-pkg-b-')
    await openLibrary(rootB, 'set-b', 'Friday Set')
    const result = await importSetPackage({
      manifestPath: fixture.manifestPath,
      playlistUuid: 'set-b'
    })
    expect(result).toEqual({ trackCount: 3, fileCount: 2 })
    expect(cleanupMocks.trashItem).not.toHaveBeenCalled()

    const imported = listSetItemsByPlaylist('set-b')
    expect(imported.map((item) => item.createdAtMs)).toEqual(fixture.sourceCreatedAt)
    const custodyRoot = path.join(rootB, 'library', 'SetLibrary', '__set_custody__')
    for (const item of imported) {
      expect(item.filePath.startsWith(custodyRoot + path.sep)).toBe(true)
      expect(path.basename(item.filePath)).toBe('Same Name.mp3')
    }
    expect(imported[0].filePath).toBe(imported[2].filePath)
    expect(imported[0].filePath).not.toBe(imported[1].filePath)

    registerSetListHandlers()
    const loadItems = ipcHandlers.get('setList:load-items')
    if (!loadItems) throw new Error('load-items handler missing')
    const loaded = (await loadItems({}, 'set-b')) as { scanData: ISongInfo[] }
    expect(loaded.scanData).toHaveLength(3)
    loaded.scanData.forEach((song, index) => {
      const source = fixture.exportedSongs[index]
      expect(song.fileMissing).toBeFalsy()
      expect(song.title).toBe(source.title)
      expect(song.fileName).toBe(source.fileName)
      expect(song.key).toBe(source.key)
      expect(song.beatGridMap).toEqual(source.beatGridMap)
      expect(song.timeBasisOffsetMs).toBe(source.timeBasisOffsetMs)
      expect(song.hotCues).toEqual(source.hotCues)
      expect(song.memoryCues).toEqual(source.memoryCues)
      expect(song.addedAtMs).toBe(fixture.sourceCreatedAt[index])
    })
  })

  it('leaves no empty import folders after the imported SET is cleared', async () => {
    const fixture = await exportFromComputerA()
    const rootB = await makeTempDir('frkb-set-pkg-b-')
    await openLibrary(rootB, 'set-b', 'Friday Set')
    await importSetPackage({ manifestPath: fixture.manifestPath, playlistUuid: 'set-b' })
    const custodyRoot = path.join(rootB, 'library', 'SetLibrary', '__set_custody__')
    expect(await fs.readdir(custodyRoot)).toHaveLength(1)

    expect(await removeSetItemsByPlaylistWithCustodyCleanup('set-b')).toBe(3)
    expect(await fs.readdir(path.join(rootB, 'library', 'RecycleBin'))).toHaveLength(2)
    expect(await fs.readdir(custodyRoot)).toEqual([])
  })

  it('rolls back everything when an audio file in the package is damaged', async () => {
    const fixture = await exportFromComputerA()
    const manifest = await readSetPackageManifest(fixture.manifestPath)
    await writeAudio(path.join(fixture.packageDir, ...manifest.files[0].path.split('/')), 99)

    const rootB = await makeTempDir('frkb-set-pkg-b-')
    await openLibrary(rootB, 'set-b', 'Friday Set')
    await expect(
      importSetPackage({
        manifestPath: fixture.manifestPath,
        playlistUuid: 'set-b',
        deleteSourceAfterImport: true
      })
    ).rejects.toMatchObject({ code: 'PACKAGE_FILE_CORRUPTED' })
    expect(listSetItemsByPlaylist('set-b')).toEqual([])
    const custodyRoot = path.join(rootB, 'library', 'SetLibrary', '__set_custody__')
    const leftovers = await fs.readdir(custodyRoot).catch(() => [])
    expect(leftovers).toEqual([])
    expect(cleanupMocks.trashItem).not.toHaveBeenCalled()
    expect(await fs.stat(fixture.manifestPath)).toBeTruthy()
  })

  it('recycles the source package only after all tracks have been imported', async () => {
    const fixture = await exportFromComputerA()
    await openLibrary(await makeTempDir('frkb-set-pkg-b-'), 'set-b', 'Friday Set')
    cleanupMocks.trashItem.mockImplementationOnce(async () => {
      const imported = listSetItemsByPlaylist('set-b')
      expect(imported).toHaveLength(3)
      for (const item of imported) expect(await fs.stat(item.filePath)).toBeTruthy()
    })
    const result = await importSetPackage({
      manifestPath: fixture.manifestPath,
      playlistUuid: 'set-b',
      deleteSourceAfterImport: true
    })
    expect(cleanupMocks.trashItem).toHaveBeenCalledWith(await fs.realpath(fixture.packageDir))
    expect(result.sourceCleanup).toBe('deleted')
  })

  it('keeps the imported SET when recycling the source fails', async () => {
    const fixture = await exportFromComputerA()
    await openLibrary(await makeTempDir('frkb-set-pkg-b-'), 'set-b', 'Friday Set')
    cleanupMocks.trashItem.mockRejectedValueOnce(new Error('recycle failed'))
    const result = await importSetPackage({
      manifestPath: fixture.manifestPath,
      playlistUuid: 'set-b',
      deleteSourceAfterImport: true
    })
    expect(result).toEqual({ trackCount: 3, fileCount: 2, sourceCleanup: 'failed' })
    expect(listSetItemsByPlaylist('set-b')).toHaveLength(3)
    expect(await fs.stat(fixture.manifestPath)).toBeTruthy()
  })

  it('does not recycle unrelated files mixed into the package folder', async () => {
    const fixture = await exportFromComputerA()
    await fs.writeFile(path.join(fixture.packageDir, 'notes.txt'), 'keep me')
    await openLibrary(await makeTempDir('frkb-set-pkg-b-'), 'set-b', 'Friday Set')
    const result = await importSetPackage({
      manifestPath: fixture.manifestPath,
      playlistUuid: 'set-b',
      deleteSourceAfterImport: true
    })
    expect(result.sourceCleanup).toBe('failed')
    expect(cleanupMocks.trashItem).not.toHaveBeenCalled()
    expect(listSetItemsByPlaylist('set-b')).toHaveLength(3)
    expect(await fs.readFile(path.join(fixture.packageDir, 'notes.txt'), 'utf8')).toBe('keep me')
  })

  it('does not recycle folders that overlap the active music library', async () => {
    const fixture = await exportFromComputerA()
    const manifest = await readSetPackageManifest(fixture.manifestPath)
    for (const libraryRoot of [fixture.packageDir, path.dirname(fixture.packageDir)]) {
      await expect(
        cleanupImportedPackage(fixture.manifestPath, manifest, libraryRoot)
      ).rejects.toThrow('当前音乐库重叠')
    }
    expect(cleanupMocks.trashItem).not.toHaveBeenCalled()
  })

  it('refuses to export when a track file is missing', async () => {
    const rootA = await makeTempDir('frkb-set-pkg-a-')
    await openLibrary(rootA, 'set-a', 'Broken Set')
    const missingPath = path.join(rootA, 'library', 'FilterLibrary', 'Gone.mp3')
    const [item] = appendSetItems('set-a', [{ filePath: missingPath }])
    await expect(
      exportSetPackage({
        playlistUuid: 'set-a',
        setName: 'Broken Set',
        songs: [buildSong(missingPath, item.id, 'Gone', 120)],
        targetParentDir: await makeTempDir('frkb-set-pkg-out-')
      })
    ).rejects.toMatchObject({ code: 'MISSING_FILES', fileNames: ['Gone.mp3'] })
  })

  it('exports a renamed custody file under the name shown in the list', async () => {
    const rootA = await makeTempDir('frkb-set-pkg-a-')
    await openLibrary(rootA, 'set-a', 'Custody Set')
    const custodyPath = path.join(
      rootA,
      'library',
      'SetLibrary',
      '__set_custody__',
      'Shown Name_1a2b3c4d.mp3'
    )
    await writeAudio(custodyPath, 7)
    const [item] = appendSetItems('set-a', [{ filePath: custodyPath }])
    const summary = await exportSetPackage({
      playlistUuid: 'set-a',
      setName: 'Custody Set',
      songs: [{ ...buildSong(custodyPath, item.id, 'Shown', 125), fileName: 'Shown Name.mp3' }],
      targetParentDir: await makeTempDir('frkb-set-pkg-out-')
    })
    const manifest = await readSetPackageManifest(summary.manifestPath)
    expect(manifest.files[0].fileName).toBe('Shown Name.mp3')
    expect(manifest.files[0].path).toBe('audio/Shown Name.mp3')
  })

  it('rejects a package whose track fields have the wrong type', async () => {
    const fixture = await exportFromComputerA()
    const raw = await fs.readFile(fixture.manifestPath, 'utf8')
    const manifest = JSON.parse(raw) as { tracks: Array<{ song: Record<string, unknown> }> }
    manifest.tracks[1].song.bpm = 'fast'
    await fs.writeFile(fixture.manifestPath, JSON.stringify(manifest))
    await expect(readSetPackageManifest(fixture.manifestPath)).rejects.toMatchObject({
      code: 'MANIFEST_INVALID',
      message: 'tracks[1] bpm 非法'
    })
  })
})
