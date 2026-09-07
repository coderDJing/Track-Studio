import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeLibraryDb, initLibraryDb } from '../libraryDb'
import store from '../store'
import type { ISongInfo } from '../../types/globals'
import {
  deletePlaylistViewSnapshotsUnderRoot,
  loadPlaylistViewSnapshotMeta,
  prunePlaylistViewSnapshots,
  savePlaylistViewSnapshot
} from './playlistViewSnapshot'

const temporaryRoots: string[] = []
const previousDatabaseDir = store.databaseDir

const createLibraryRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-playlist-snapshot-'))
  temporaryRoots.push(root)
  await fs.mkdir(path.join(root, 'library'), { recursive: true })
  store.databaseDir = root
  expect(initLibraryDb(root)).not.toBeNull()
  return root
}

const saveSnapshot = (songListUUID: string, listRoot: string): void => {
  const revision = savePlaylistViewSnapshot({
    songListUUID,
    listRoot,
    identityDigest: 'test',
    items: [] as ISongInfo[]
  })
  expect(revision).not.toBeNull()
}

afterEach(async () => {
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe('playlist view snapshot path invalidation', () => {
  it('delete under root removes nested playlists but not sibling prefixes', async () => {
    const root = await createLibraryRoot()
    const parent = path.join(root, 'library', 'Folder')
    const sibling = path.join(root, 'library', 'Folder2')
    saveSnapshot('nested', path.join(parent, 'Playlist'))
    saveSnapshot('parent-self', parent)
    saveSnapshot('sibling', path.join(sibling, 'Playlist'))

    expect(deletePlaylistViewSnapshotsUnderRoot(parent)).toBe(2)
    expect(loadPlaylistViewSnapshotMeta('nested')).toBeNull()
    expect(loadPlaylistViewSnapshotMeta('parent-self')).toBeNull()
    expect(loadPlaylistViewSnapshotMeta('sibling')?.songListUUID).toBe('sibling')
  })

  it('prune drops missing uuids and path-drifted song lists, keeps matching and non-songList rows', async () => {
    const root = await createLibraryRoot()
    const keepPath = path.join(root, 'library', 'Keep')
    const oldPath = path.join(root, 'library', 'OldName')
    const newPath = path.join(root, 'library', 'NewName')
    const otherPath = path.join(root, 'library', 'Other')
    saveSnapshot('keep', keepPath)
    saveSnapshot('moved', oldPath)
    saveSnapshot('gone', otherPath)
    saveSnapshot('dir-node', otherPath)

    expect(
      prunePlaylistViewSnapshots(
        ['keep', 'moved', 'dir-node'],
        new Map([
          ['keep', keepPath],
          ['moved', newPath]
        ])
      )
    ).toBe(2)

    expect(loadPlaylistViewSnapshotMeta('keep')?.songListUUID).toBe('keep')
    expect(loadPlaylistViewSnapshotMeta('moved')).toBeNull()
    expect(loadPlaylistViewSnapshotMeta('gone')).toBeNull()
    expect(loadPlaylistViewSnapshotMeta('dir-node')?.songListUUID).toBe('dir-node')
  })
})
