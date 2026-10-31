// Run: pnpm exec vitest run src/main/window/mainWindow/mainWindowFilesystemHandlers.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FileSystemOperation } from '../../../shared/fileSystemOperation'

const ipcHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

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
  shell: {},
  dialog: {},
  nativeImage: {},
  Notification: class {}
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('./index', () => ({ default: { instance: null } }))
vi.mock('../updateWindow', () => ({ default: {} }))
vi.mock('../mixtapeWindow', () => ({ isMixtapeWindowOpenByPlaylistId: () => false }))
vi.mock('../../services/globalSongSearch', () => ({ markGlobalSongSearchDirty: () => {} }))
vi.mock('../../services/libraryMerge/runtime', () => ({
  assertLibraryMergeMutationAllowed: () => {}
}))
vi.mock('../../cloudSyncScheduler', () => ({ scheduleCuratedLibrarySyncIfUnderCurated: () => {} }))

import { closeLibraryDb, initLibraryDb } from '../../libraryDb'
import store from '../../store'
import { insertLibraryNode, loadLibraryNodes, syncLibraryTreeFromDisk } from '../../libraryTreeDb'
import { appendSetItems, listSetItemsByPlaylist } from '../../setListDb'
import { listRecycleBinRecords } from '../../recycleBinDb'
import { registerMainWindowFilesystemHandlers } from './mainWindowFilesystemHandlers'

const previousDatabaseDir = store.databaseDir
const previousAudioExt = store.settingConfig.audioExt
let root = ''
let setLibraryUuid = ''

const createSet = async (uuid: string, parentUuid = setLibraryUuid, parentPath = 'SetLibrary') => {
  const rendererPath = `library/${parentPath}/${uuid}`
  await fs.mkdir(path.join(root, rendererPath), { recursive: true })
  insertLibraryNode({ uuid, parentUuid, dirName: uuid, nodeType: 'setList' })
  return rendererPath
}

const writeSong = async (relativePath: string) => {
  const filePath = path.join(root, 'library', relativePath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, 'test audio')
  return filePath
}

const operate = async (operation: FileSystemOperation) => {
  const handler = ipcHandlers.get('operateFileSystemChange')
  if (!handler) throw new Error('filesystem handler missing')
  return handler({}, [operation])
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-set-delete-'))
  store.databaseDir = root
  store.settingConfig.audioExt = ['.mp3']
  await fs.mkdir(path.join(root, 'library', 'SetLibrary'), { recursive: true })
  if (!initLibraryDb(root)) throw new Error('test database did not open')
  await syncLibraryTreeFromDisk(root, {
    coreDirNames: {
      FilterLibrary: 'FilterLibrary',
      CuratedLibrary: 'CuratedLibrary',
      SetLibrary: 'SetLibrary',
      MixtapeLibrary: 'MixtapeLibrary',
      RecordingLibrary: 'RecordingLibrary',
      RecycleBin: 'RecycleBin'
    }
  })
  const setLibrary = loadLibraryNodes()?.find((node) => node.dirName === 'SetLibrary')
  if (!setLibrary) throw new Error('SET library missing')
  setLibraryUuid = setLibrary.uuid
  ipcHandlers.clear()
  registerMainWindowFilesystemHandlers(() => null)
})

afterEach(async () => {
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  store.settingConfig.audioExt = previousAudioExt
  await fs.rm(root, { recursive: true, force: true })
})

describe('deleting SET library nodes', () => {
  it.each([
    { type: 'delete', hasStoredAudio: false },
    { type: 'delete', hasStoredAudio: true },
    { type: 'permanentlyDelete', hasStoredAudio: false }
  ] as const)(
    '$type (stored audio: $hasStoredAudio) recycles orphan custody audio',
    async ({ type, hasStoredAudio }) => {
      const setPath = await createSet('set-a')
      const custodyPath = await writeSong('SetLibrary/__set_custody__/package/orphan.mp3')
      const sourcePath = await writeSong('CuratedLibrary/source.mp3')
      if (hasStoredAudio) await writeSong('SetLibrary/set-a/stored.mp3')
      appendSetItems('set-a', [
        { filePath: custodyPath },
        { filePath: custodyPath },
        { filePath: sourcePath }
      ])

      expect(await operate({ type, path: setPath, uuid: 'set-a', nodeType: 'setList' })).toEqual({
        success: true,
        details: [
          {
            uuid: 'set-a',
            status:
              type === 'permanentlyDelete'
                ? 'permanently_deleted'
                : hasStoredAudio
                  ? 'recycled'
                  : 'removed'
          }
        ]
      })
      expect(loadLibraryNodes()?.some((node) => node.uuid === 'set-a')).toBe(false)
      expect(listSetItemsByPlaylist('set-a')).toEqual([])
      await expect(fs.stat(custodyPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(path.dirname(custodyPath))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await fs.readFile(sourcePath, 'utf8')).toBe('test audio')
      expect(await fs.readFile(path.join(root, 'library/RecycleBin/orphan.mp3'), 'utf8')).toBe(
        'test audio'
      )
      expect(
        listRecycleBinRecords().filter((record) => record.sourceType === 'set_custody_orphan')
      ).toMatchObject([{ filePath: 'RecycleBin/orphan.mp3', sourceType: 'set_custody_orphan' }])
      if (hasStoredAudio) {
        expect(await fs.readFile(path.join(root, 'library/RecycleBin/stored.mp3'), 'utf8')).toBe(
          'test audio'
        )
      }
    }
  )

  it('keeps shared custody audio until the last SET referencing it is deleted', async () => {
    const firstPath = await createSet('set-a')
    const secondPath = await createSet('set-b')
    const custodyPath = await writeSong('SetLibrary/__set_custody__/shared.mp3')
    appendSetItems('set-a', [{ filePath: custodyPath }])
    const [remainingItem] = appendSetItems('set-b', [{ filePath: custodyPath }])

    expect(await operate({ type: 'delete', path: firstPath, uuid: 'set-a' })).toMatchObject({
      success: true
    })
    expect(await fs.readFile(custodyPath, 'utf8')).toBe('test audio')
    expect(listSetItemsByPlaylist('set-b')).toEqual([remainingItem])
    expect(listRecycleBinRecords()).toEqual([])

    expect(await operate({ type: 'delete', path: secondPath, uuid: 'set-b' })).toMatchObject({
      success: true
    })
    await expect(fs.stat(custodyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(listRecycleBinRecords()).toMatchObject([{ filePath: 'RecycleBin/shared.mp3' }])
  })

  it('recycles custody audio shared by SETs inside a deleted folder', async () => {
    const folderPath = 'library/SetLibrary/folder'
    await fs.mkdir(path.join(root, folderPath))
    insertLibraryNode({
      uuid: 'folder',
      parentUuid: setLibraryUuid,
      dirName: 'folder',
      nodeType: 'dir'
    })
    await createSet('set-a', 'folder', 'SetLibrary/folder')
    await createSet('set-b', 'folder', 'SetLibrary/folder')
    const custodyPath = await writeSong('SetLibrary/__set_custody__/shared.mp3')
    appendSetItems('set-a', [{ filePath: custodyPath }])
    appendSetItems('set-b', [{ filePath: custodyPath }])

    expect(
      await operate({ type: 'delete', path: folderPath, uuid: 'folder', nodeType: 'dir' })
    ).toMatchObject({ success: true })
    expect(listSetItemsByPlaylist('set-a')).toEqual([])
    expect(listSetItemsByPlaylist('set-b')).toEqual([])
    await expect(fs.stat(custodyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(listRecycleBinRecords()).toMatchObject([{ filePath: 'RecycleBin/shared.mp3' }])
  })
})
