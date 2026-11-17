import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeLibraryDb } from './libraryDb'
import {
  ensureLibraryTreeBaseline,
  findSongListRootByPath,
  loadLibraryNodes,
  syncLibraryTreeFromDisk
} from './libraryTreeDb'

const temporaryDirectories: string[] = []

const coreDirNames = {
  FilterLibrary: 'FilterLibrary',
  CuratedLibrary: 'CuratedLibrary',
  SetLibrary: 'SetLibrary',
  MixtapeLibrary: 'MixtapeLibrary',
  RecordingLibrary: 'RecordingLibrary',
  RecycleBin: 'RecycleBin'
}

afterEach(async () => {
  closeLibraryDb()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('library tree disk sync', () => {
  it('inserts a new parent before moving an existing child below it', async () => {
    const dbRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-library-tree-'))
    temporaryDirectories.push(dbRoot)
    const filterLibraryPath = path.join(dbRoot, 'library', coreDirNames.FilterLibrary)
    const existingChildPath = path.join(filterLibraryPath, 'existing-child')
    await fs.mkdir(existingChildPath, { recursive: true })

    await syncLibraryTreeFromDisk(dbRoot, { coreDirNames })
    const existingChild = (loadLibraryNodes(dbRoot) || []).find(
      (node) => node.dirName === 'existing-child'
    )
    expect(existingChild).toBeTruthy()

    const newParentPath = path.join(filterLibraryPath, 'new-parent')
    await fs.mkdir(newParentPath, { recursive: true })
    await fs.rename(existingChildPath, path.join(newParentPath, 'existing-child'))

    await expect(syncLibraryTreeFromDisk(dbRoot, { coreDirNames })).resolves.toMatchObject({
      added: 1,
      updated: 1
    })

    const nodes = loadLibraryNodes(dbRoot) || []
    const newParent = nodes.find((node) => node.dirName === 'new-parent')
    const movedChild = nodes.find((node) => node.uuid === existingChild?.uuid)
    expect(newParent).toBeTruthy()
    expect(movedChild?.parentUuid).toBe(newParent?.uuid)
  })
})

describe('library tree core baseline', () => {
  it('adds a missing NeteaseLibrary node to an existing tree and keeps it after disk sync', async () => {
    const dbRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-library-tree-'))
    temporaryDirectories.push(dbRoot)
    const libraryRoot = path.join(dbRoot, 'library')
    for (const name of Object.values(coreDirNames)) {
      await fs.mkdir(path.join(libraryRoot, name), { recursive: true })
    }

    await syncLibraryTreeFromDisk(dbRoot, { coreDirNames })
    expect((loadLibraryNodes(dbRoot) || []).some((node) => node.dirName === 'NeteaseLibrary')).toBe(
      false
    )

    await fs.mkdir(path.join(libraryRoot, 'NeteaseLibrary'), { recursive: true })
    const withNetease = { ...coreDirNames, NeteaseLibrary: 'NeteaseLibrary' }
    await ensureLibraryTreeBaseline(dbRoot, { coreDirNames: withNetease })
    const inserted = (loadLibraryNodes(dbRoot) || []).filter(
      (node) => node.dirName === 'NeteaseLibrary'
    )
    expect(inserted).toHaveLength(1)
    expect(inserted[0].nodeType).toBe('library')

    await expect(
      syncLibraryTreeFromDisk(dbRoot, { coreDirNames: withNetease })
    ).resolves.toMatchObject({
      removed: 0
    })
    const kept = (loadLibraryNodes(dbRoot) || []).filter(
      (node) => node.dirName === 'NeteaseLibrary'
    )
    expect(kept).toHaveLength(1)
    expect(kept[0].uuid).toBe(inserted[0].uuid)
  })
})

describe('findSongListRootByPath for NeteaseLibrary', () => {
  it('uses NeteaseLibrary as the cache root for files under .store', async () => {
    const dbRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-library-tree-'))
    temporaryDirectories.push(dbRoot)
    const libraryRoot = path.join(dbRoot, 'library')
    const neteaseRoot = path.join(libraryRoot, 'NeteaseLibrary')
    const storeDir = path.join(neteaseRoot, '.store')
    for (const name of [...Object.values(coreDirNames), 'NeteaseLibrary']) {
      await fs.mkdir(path.join(libraryRoot, name), { recursive: true })
    }
    await fs.mkdir(storeDir, { recursive: true })

    const withNetease = { ...coreDirNames, NeteaseLibrary: 'NeteaseLibrary' }
    await ensureLibraryTreeBaseline(dbRoot, { coreDirNames: withNetease })

    await expect(findSongListRootByPath(storeDir, dbRoot)).resolves.toBe(neteaseRoot)
    await expect(
      findSongListRootByPath(path.join(storeDir, 'unused-for-root-resolution'), dbRoot)
    ).resolves.toBe(neteaseRoot)
  })

  it('does not treat FilterLibrary itself as a song-list cache root', async () => {
    const dbRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-library-tree-'))
    temporaryDirectories.push(dbRoot)
    const filterRoot = path.join(dbRoot, 'library', coreDirNames.FilterLibrary)
    await fs.mkdir(filterRoot, { recursive: true })
    await syncLibraryTreeFromDisk(dbRoot, { coreDirNames })

    await expect(findSongListRootByPath(filterRoot, dbRoot)).resolves.toBeNull()
  })
})
