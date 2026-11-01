// Run: pnpm exec vitest run src/main/ipc/mixtapeOriginReconcile.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
vi.mock('../services/globalSongSearch', () => ({ markGlobalSongSearchDirty: () => {} }))
vi.mock('../services/libraryMerge/runtime', () => ({
  assertLibraryMergeMutationAllowed: () => {}
}))

import { closeLibraryDb, initLibraryDb } from '../libraryDb'
import store from '../store'
import { insertLibraryNode, loadLibraryNodes, syncLibraryTreeFromDisk } from '../libraryTreeDb'
import { appendSetItems, removeSetItemsByIds } from '../setListDb'
import { appendMixtapeItems, listMixtapeItems } from '../mixtapeDb'
import { reconcileMixtapeMissingFiles } from './mixtapeHandlers.shared'

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

afterEach(async () => {
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

// 建好一个 SET 歌单（含一首托管相对路径曲目）和一个 EQ mixtape 歌单。
const setupLibrary = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-mixtape-origin-'))
  tempDirs.push(root)
  store.databaseDir = root
  await fs.mkdir(path.join(root, 'library', 'SetLibrary'), { recursive: true })
  await fs.mkdir(path.join(root, 'library', 'MixtapeLibrary'), { recursive: true })
  if (!initLibraryDb(root)) throw new Error('test database did not open')
  await syncLibraryTreeFromDisk(root, { coreDirNames })
  const nodes = loadLibraryNodes(root) || []
  const setLibrary = nodes.find((node) => node.dirName === 'SetLibrary')
  const mixtapeLibrary = nodes.find((node) => node.dirName === 'MixtapeLibrary')
  if (!setLibrary || !mixtapeLibrary) throw new Error('core library node missing')
  await fs.mkdir(path.join(root, 'library', 'SetLibrary', 'MySet'))
  await fs.mkdir(path.join(root, 'library', 'MixtapeLibrary', 'MyMix'))
  insertLibraryNode(
    { uuid: 'set-a', parentUuid: setLibrary.uuid, dirName: 'MySet', nodeType: 'setList' },
    root
  )
  insertLibraryNode(
    { uuid: 'mix-a', parentUuid: mixtapeLibrary.uuid, dirName: 'MyMix', nodeType: 'mixtapeList' },
    root
  )
  const relativePath = path.join('SetLibrary', '__set_custody__', 'track.mp3')
  const absPath = path.join(root, 'library', relativePath)
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, Buffer.alloc(1024, 7))
  const [setItem] = appendSetItems('set-a', [{ filePath: relativePath }])
  appendMixtapeItems('mix-a', [{ filePath: absPath, originPlaylistUuid: 'set-a', info: null }])
  return { setItem }
}

describe('reconcileMixtapeMissingFiles with SET origin', () => {
  it('keeps tracks whose origin SET playlist still contains them', async () => {
    await setupLibrary()
    const { items, recovery } = await reconcileMixtapeMissingFiles('mix-a')
    expect(items).toHaveLength(1)
    expect(recovery.removedPaths).toEqual([])
    expect(listMixtapeItems('mix-a')).toHaveLength(1)
  })

  it('removes tracks that were removed from the origin SET playlist', async () => {
    const { setItem } = await setupLibrary()
    removeSetItemsByIds([setItem.id])
    const { items } = await reconcileMixtapeMissingFiles('mix-a')
    expect(items).toHaveLength(0)
  })
})
