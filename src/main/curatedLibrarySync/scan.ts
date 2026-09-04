import path from 'node:path'
import fs from 'fs-extra'
import store from '../store'
import { collectFilesWithExtensions } from '../nodeTaskUtils'
import { findLibraryNodeByPath, findSongListRootByPath, loadLibraryNodes } from '../libraryTreeDb'
import { normalizeOrder } from '../libraryTreeDbHelpers'
import * as LibraryCacheDb from '../libraryCacheDb'
import { getRecycleBinRecordByFileId } from '../recycleBinDb'
import { normalizePlaylistTrackNumber } from '../services/playlistTrackNumbers'
import { normalizeAddedAtMs } from '../../shared/songAddedAt'
import { hashFileSha256 } from './hashFile'
import {
  createCuratedSyncFileId,
  listCuratedSyncFiles,
  upsertCuratedSyncFile,
  type CuratedSyncFileRow
} from './identityDb'
import {
  absToCuratedRelative,
  curatedRelativeToAbs,
  findCuratedLibraryNode,
  getCuratedLibraryAbsRoot,
  getLibraryAbsRoot,
  toCloudParentUuid
} from './paths'

export type CuratedLocalFile = CuratedSyncFileRow & {
  absPath: string
}

export type CuratedLocalNode = {
  uuid: string
  parentUuid: string
  name: string
  nodeType: 'dir' | 'songList'
  sortOrder: number | null
  updatedAtMs: number
}

const getAudioExts = (): string[] => {
  const list = store.settingConfig?.audioExt
  if (!Array.isArray(list)) return []
  return list
    .map((item) => {
      const ext = String(item || '')
        .trim()
        .toLowerCase()
      if (!ext) return ''
      return ext.startsWith('.') ? ext : `.${ext}`
    })
    .filter(Boolean)
}

const resolveParentUuid = async (absPath: string, curatedUuid: string): Promise<string> => {
  const dbRoot = String(store.databaseDir || '').trim()
  const listRoot = await findSongListRootByPath(path.dirname(absPath))
  if (listRoot && dbRoot) {
    const mapped = path.relative(dbRoot, listRoot).replace(/\\/g, '/')
    const node = findLibraryNodeByPath(mapped)
    if (node) return node.uuid
  }
  return curatedUuid
}

export const readCacheFields = async (
  absPath: string
): Promise<{ trackNumber: number | null; addedAtMs: number | null }> => {
  try {
    const listRoot = await findSongListRootByPath(path.dirname(absPath))
    if (!listRoot) return { trackNumber: null, addedAtMs: null }
    const entry = await LibraryCacheDb.loadSongCacheEntry(listRoot, absPath)
    return {
      trackNumber: normalizePlaylistTrackNumber(entry?.info?.playlistTrackNumber) ?? null,
      addedAtMs: normalizeAddedAtMs(entry?.info?.addedAtMs) ?? null
    }
  } catch {
    return { trackNumber: null, addedAtMs: null }
  }
}

export const scanCuratedLibraryForSync = async (): Promise<{
  files: CuratedLocalFile[]
  nodes: CuratedLocalNode[]
}> => {
  const curatedRoot = getCuratedLibraryAbsRoot()
  const libraryRoot = getLibraryAbsRoot()
  const curatedNode = findCuratedLibraryNode()
  if (!curatedRoot || !libraryRoot || !curatedNode) {
    return { files: [], nodes: [] }
  }
  const audioExts = getAudioExts()
  const absFiles =
    audioExts.length > 0 ? await collectFilesWithExtensions(curatedRoot, audioExts) : []
  const existingByPath = new Map<string, CuratedSyncFileRow>()
  const existingById = new Map<string, CuratedSyncFileRow>()
  for (const row of listCuratedSyncFiles()) {
    existingById.set(row.fileId, row)
    if (row.location === 'curated' && row.relativePath) {
      existingByPath.set(row.relativePath, row)
    }
  }
  const usedIds = new Set<string>()
  const files: CuratedLocalFile[] = []
  const now = Date.now()

  for (const absPath of absFiles) {
    const relativePath = absToCuratedRelative(absPath)
    if (!relativePath) continue
    let stat: { size: number; mtimeMs: number }
    try {
      const raw = await fs.stat(absPath)
      stat = { size: raw.size, mtimeMs: raw.mtimeMs }
    } catch {
      continue
    }
    const cache = await readCacheFields(absPath)
    const parentUuid = toCloudParentUuid(
      await resolveParentUuid(absPath, curatedNode.uuid),
      curatedNode.uuid
    )
    const fileName = path.basename(absPath)
    const previous = existingByPath.get(relativePath)
    let contentSha256 = previous?.contentSha256 || ''
    if (
      !previous ||
      previous.contentSize !== stat.size ||
      previous.mtimeMs !== stat.mtimeMs ||
      !contentSha256
    ) {
      contentSha256 = await hashFileSha256(absPath)
    }
    let fileId = previous?.fileId || ''
    if (!fileId) {
      const orphan = [...existingById.values()].find(
        (row) =>
          !usedIds.has(row.fileId) &&
          row.contentSha256 === contentSha256 &&
          row.location !== 'curated'
      )
      fileId = orphan?.fileId || createCuratedSyncFileId()
    }
    usedIds.add(fileId)
    const addedAtMs = cache.addedAtMs ?? previous?.addedAtMs ?? now
    const changed =
      !previous ||
      previous.fileId !== fileId ||
      previous.contentSha256 !== contentSha256 ||
      previous.parentUuid !== parentUuid ||
      previous.fileName !== fileName ||
      previous.trackNumber !== cache.trackNumber ||
      previous.addedAtMs !== addedAtMs
    const row: CuratedSyncFileRow = {
      fileId,
      relativePath,
      parentUuid,
      fileName,
      contentSha256,
      contentSize: stat.size,
      mtimeMs: stat.mtimeMs,
      trackNumber: cache.trackNumber,
      addedAtMs,
      updatedAtMs: changed ? now : (previous?.updatedAtMs ?? now),
      location: 'curated',
      locationPath: relativePath
    }
    upsertCuratedSyncFile(row)
    files.push({ ...row, absPath })
  }

  for (const row of existingById.values()) {
    if (usedIds.has(row.fileId) || row.location !== 'curated') continue
    const abs = row.relativePath ? curatedRelativeToAbs(row.relativePath) : null
    if (abs && (await fs.pathExists(abs))) continue
    const recycle = getRecycleBinRecordByFileId(row.fileId)
    upsertCuratedSyncFile({
      ...row,
      location: recycle?.filePath ? 'recycle' : 'missing',
      locationPath: recycle?.filePath || row.locationPath,
      updatedAtMs: now
    })
  }

  const nodes: CuratedLocalNode[] = []
  const allNodes = loadLibraryNodes() || []
  const children = new Map<string, typeof allNodes>()
  for (const node of allNodes) {
    if (!node.parentUuid) continue
    const list = children.get(node.parentUuid) || []
    list.push(node)
    children.set(node.parentUuid, list)
  }
  const stack = [...(children.get(curatedNode.uuid) || [])]
  while (stack.length > 0) {
    const node = stack.shift()
    if (!node) continue
    if (node.nodeType === 'dir' || node.nodeType === 'songList') {
      nodes.push({
        uuid: node.uuid,
        parentUuid: toCloudParentUuid(node.parentUuid || curatedNode.uuid, curatedNode.uuid),
        name: node.dirName,
        nodeType: node.nodeType,
        sortOrder: normalizeOrder(node.order),
        updatedAtMs: now
      })
    }
    const kids = children.get(node.uuid) || []
    stack.push(...kids)
  }

  return { files, nodes }
}
