import path from 'node:path'
import store from '../store'
import mainWindow from '../window/mainWindow'
import { getLibrary } from '../utils'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import { RECYCLE_BIN_UUID } from '../../shared/recycleBin'
import {
  CURATED_LIBRARY_SYNC_PLAYLISTS_CHANGED_CHANNEL,
  CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID,
  type CuratedLibrarySyncListFileChange,
  type CuratedLibrarySyncPlaylistsChangedPayload
} from '../../shared/curatedLibrarySync'
import { findCuratedLibraryNode } from './paths'
import type { CuratedLocalFile, CuratedLocalNode } from './scan'

export const notifyTree = async (): Promise<void> => {
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  try {
    const tree = await getLibrary({ skipSync: true })
    win.webContents.send('library-tree-updated', tree)
  } catch {}
}

const toLocalPlaylistUuid = (cloudParent: string): string => {
  const curated = findCuratedLibraryNode()
  const parent = String(cloudParent || '').trim()
  if (!parent || parent === CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID) {
    return curated?.uuid || ''
  }
  return parent
}

const toLibraryPath = (absPath: string): string => {
  const dbRoot = String(store.databaseDir || '').trim()
  if (!dbRoot || !absPath) return ''
  const rel = path.relative(dbRoot, absPath).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''
  return rel
}

const toListFileChange = (file: CuratedLocalFile): CuratedLibrarySyncListFileChange | null => {
  const listUUID = toLocalPlaylistUuid(file.parentUuid)
  const libraryPath = toLibraryPath(file.absPath)
  if (!listUUID || !file.absPath || !libraryPath) return null
  return {
    listUUID,
    absPath: file.absPath,
    libraryPath,
    trackNumber: file.trackNumber,
    addedAtMs: file.addedAtMs
  }
}

const collectPlaylistFileChanges = (
  before: { files: CuratedLocalFile[]; nodes: CuratedLocalNode[] },
  after: { files: CuratedLocalFile[]; nodes: CuratedLocalNode[] }
): CuratedLibrarySyncPlaylistsChangedPayload => {
  const uuids = new Set<string>()
  const removed: CuratedLibrarySyncListFileChange[] = []
  const added: CuratedLibrarySyncListFileChange[] = []
  const updated: CuratedLibrarySyncListFileChange[] = []
  const pushChange = (target: CuratedLibrarySyncListFileChange[], file: CuratedLocalFile) => {
    const change = toListFileChange(file)
    if (!change) return
    target.push(change)
    uuids.add(change.listUUID)
  }
  const beforeFiles = new Map(before.files.map((file) => [file.fileId, file]))
  const afterFiles = new Map(after.files.map((file) => [file.fileId, file]))
  let recycled = false
  for (const [fileId, file] of beforeFiles) {
    const next = afterFiles.get(fileId)
    if (!next) {
      pushChange(removed, file)
      recycled = true
      continue
    }
    if (next.parentUuid !== file.parentUuid || next.fileName !== file.fileName) {
      pushChange(removed, file)
      pushChange(added, next)
      continue
    }
    if (next.trackNumber !== file.trackNumber || next.addedAtMs !== file.addedAtMs) {
      pushChange(updated, next)
    }
  }
  for (const [fileId, file] of afterFiles) {
    if (!beforeFiles.has(fileId)) pushChange(added, file)
  }
  const afterNodeIds = new Set(after.nodes.map((node) => node.uuid))
  for (const node of before.nodes) {
    if (afterNodeIds.has(node.uuid)) continue
    uuids.add(node.uuid)
    const parent = toLocalPlaylistUuid(node.parentUuid)
    if (parent) uuids.add(parent)
  }
  const beforeNodeIds = new Set(before.nodes.map((node) => node.uuid))
  for (const node of after.nodes) {
    if (beforeNodeIds.has(node.uuid)) continue
    uuids.add(node.uuid)
    const parent = toLocalPlaylistUuid(node.parentUuid)
    if (parent) uuids.add(parent)
  }
  if (recycled) uuids.add(RECYCLE_BIN_UUID)
  return { uuids: [...uuids], removed, added, updated }
}

const notifyPlaylistsChanged = (payload: CuratedLibrarySyncPlaylistsChangedPayload) => {
  if (
    payload.uuids.length === 0 &&
    payload.removed.length === 0 &&
    payload.added.length === 0 &&
    payload.updated.length === 0
  ) {
    return
  }
  markGlobalSongSearchDirty('curated-library-sync', { songListUUIDs: payload.uuids })
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  win.webContents.send(CURATED_LIBRARY_SYNC_PLAYLISTS_CHANGED_CHANNEL, payload)
}

let applyFlushAdded: CuratedLibrarySyncListFileChange[] = []
let applyFlushedAbs = new Set<string>()
let applyFlushAt = 0

export const resetApplyUiFlush = (): void => {
  applyFlushAdded = []
  applyFlushedAbs = new Set()
  applyFlushAt = 0
}

const flushApplyUi = async (force = false): Promise<void> => {
  if (!force && applyFlushAdded.length < 8 && Date.now() - applyFlushAt < 2000) return
  applyFlushAt = Date.now()
  const added = applyFlushAdded
  applyFlushAdded = []
  await notifyTree()
  if (added.length === 0) return
  notifyPlaylistsChanged({
    uuids: [...new Set(added.map((item) => item.listUUID))],
    added,
    removed: [],
    updated: []
  })
}

export const finishApplyUi = async (
  before: { files: CuratedLocalFile[]; nodes: CuratedLocalNode[] },
  after: { files: CuratedLocalFile[]; nodes: CuratedLocalNode[] }
): Promise<void> => {
  await flushApplyUi(true)
  const payload = collectPlaylistFileChanges(before, after)
  payload.added = payload.added.filter((item) => !applyFlushedAbs.has(item.absPath))
  notifyPlaylistsChanged(payload)
}

export const queueImportedApplyUi = (item: {
  parentUuid: string
  absPath: string
  trackNumber: number | null
  addedAtMs: number | null
}): void => {
  const listUUID = toLocalPlaylistUuid(item.parentUuid)
  const libraryPath = toLibraryPath(item.absPath)
  if (!listUUID || !libraryPath) return
  applyFlushedAbs.add(item.absPath)
  applyFlushAdded.push({
    listUUID,
    absPath: item.absPath,
    libraryPath,
    trackNumber: item.trackNumber,
    addedAtMs: item.addedAtMs
  })
  void flushApplyUi()
}
