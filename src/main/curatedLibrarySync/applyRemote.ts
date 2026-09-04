import path from 'node:path'
import fs from 'fs-extra'
import os from 'node:os'
import store from '../store'
import {
  findLibraryNodeByPath,
  insertLibraryNode,
  loadLibraryNodes,
  moveLibraryNode,
  removeLibraryNode,
  updateLibraryNodeName,
  updateLibraryNodeOrder
} from '../libraryTreeDb'
import { normalizeOrder, writeUuidMarker } from '../libraryTreeDbHelpers'
import { protectSetReferencedFilesForDeletion } from '../ipc/setListHandlers'
import { getRecycleBinRecordByFileId, type RecycleBinRecord } from '../recycleBinDb'
import { moveFileToRecycleBin, restoreRecycleBinFile } from '../recycleBinService'
import { stampPlaylistSongsAddedAt } from '../services/playlistAddedAt'
import { setSongListTrackNumbersByOrder } from '../services/playlistTrackNumbers'
import { runPlaybackAwareBackgroundFileIo } from '../services/playbackForegroundActivity'
import { downloadBlobFile } from './apiClient'
import { isPathBusyForRemoteMutation } from './busyPaths'
import {
  relocateLibraryAudioFile,
  relocateLibraryDirectoryFiles,
  rememberImportedCuratedTracks
} from './localMutations'
import {
  getCuratedSyncFileById,
  upsertCuratedSyncFile,
  replaceCuratedSyncFileId,
  type CuratedSyncFileRow
} from './identityDb'
import {
  canonicalizeCloudParentUuid,
  curatedRelativeToAbs,
  findCuratedLibraryNode,
  getCuratedLibraryAbsRoot,
  getLibraryAbsRoot,
  getNodeAbsPath,
  isPathInside,
  libraryRelativeToAbs,
  resolveCloudParentAbs,
  resolveCloudParentToLocalUuid,
  toCloudParentUuid
} from './paths'
import {
  listPendingDeletedCuratedNodeIds,
  logCuratedDeleteTrace,
  purgePendingDeletedCuratedNodeShells,
  removeLocalPendingCuratedNodeShell
} from './pendingDeletedNodes'
import type {
  CuratedLibrarySyncCloudFile,
  CuratedLibrarySyncCloudNode,
  CuratedLibrarySyncSnapshot
} from '../../shared/curatedLibrarySync'
import type { CuratedLocalFile, CuratedLocalNode } from './scan'
import {
  asOptionalPositiveInt,
  localFilePendingSinceLast,
  localNodePendingSinceLast
} from './pendingLocal'

export type DeferredRemoteOp = {
  type: 'deleteFile' | 'moveFile' | 'deleteNode'
  fileId?: string
  nodeUuid?: string
  parentUuid?: string
  fileName?: string
  sha256?: string
}

export type ApplyRemoteContext = {
  signal: AbortSignal
  isBusy?: (absPath: string) => boolean
  onTransferFailure?: (payload: {
    direction: 'download'
    name: string
    sha256: string
    fileId: string
    error: unknown
  }) => void
}

export type ApplyRemoteOptions = {
  extras: 'keep' | 'delete'
  adoptIds: boolean
  applyTombstones?: boolean
  knownFileIds?: Set<string> | null
  knownNodeIds?: Set<string> | null
  pendingDeletedNodeIds?: Set<string> | null
  /** 增量对账：本机相对上次快照的改动先推云，落地不要用旧快照盖掉。冲突落地必须关掉。 */
  preservePendingLocal?: boolean
  lastAppliedNodes?: Map<string, CuratedLibrarySyncCloudNode> | null
  lastAppliedFiles?: Map<string, CuratedLibrarySyncCloudFile> | null
}

const isEnospc = (error: unknown): boolean => {
  const code = String((error as { code?: unknown } | null)?.code || '').toUpperCase()
  return code === 'ENOSPC' || /no space/i.test(String((error as Error)?.message || ''))
}

const assertNotCancelled = (signal: AbortSignal) => {
  if (signal.aborted) {
    const error = new Error('CURATED_SYNC_CANCELLED')
    error.name = 'AbortError'
    throw error
  }
}

const mappedLibraryPath = (absPath: string): string => {
  const dbRoot = String(store.databaseDir || '').trim()
  return path.relative(dbRoot, absPath).replace(/\\/g, '/')
}

const absToRel = (root: string, absPath: string): string =>
  path.relative(root, absPath).replace(/\\/g, '/')

const isBusyPath = (absPath: string, ctx: ApplyRemoteContext): boolean =>
  isPathBusyForRemoteMutation(absPath) || !!ctx.isBusy?.(absPath)

type CloudParentScope = {
  curatedUuid: string
  snapshotNodeIds: Set<string>
}

const localParentUuidOf = (cloudParentUuid: string, scope: CloudParentScope): string =>
  resolveCloudParentToLocalUuid(cloudParentUuid, scope.curatedUuid, scope.snapshotNodeIds)

const localParentAbsOf = (cloudParentUuid: string, scope: CloudParentScope): string | null =>
  resolveCloudParentAbs(cloudParentUuid, scope.curatedUuid, scope.snapshotNodeIds)

const canonicalParentUuidOf = (cloudParentUuid: string, scope: CloudParentScope): string =>
  canonicalizeCloudParentUuid(cloudParentUuid, scope.curatedUuid, scope.snapshotNodeIds)

const adoptNodeUuid = (localUuid: string, cloudUuid: string): void => {
  if (!localUuid || !cloudUuid || localUuid === cloudUuid) return
  const nodes = loadLibraryNodes() || []
  if (nodes.some((node) => node.uuid === cloudUuid)) return
  const local = nodes.find((node) => node.uuid === localUuid)
  if (!local) return
  removeLibraryNode(localUuid)
  insertLibraryNode({
    uuid: cloudUuid,
    parentUuid: local.parentUuid,
    dirName: local.dirName,
    nodeType: local.nodeType,
    order: local.order
  })
  for (const child of nodes) {
    if (child.parentUuid !== localUuid) continue
    moveLibraryNode(child.uuid, cloudUuid, child.dirName)
  }
  const abs = getNodeAbsPath(cloudUuid)
  if (abs) void writeUuidMarker(abs, cloudUuid)
}

const shouldPreservePendingLocal = (options: ApplyRemoteOptions): boolean =>
  options.preservePendingLocal === true && options.adoptIds !== true && options.extras === 'keep'

const liveLocalNodeFromRow = (
  existing: {
    uuid: string
    parentUuid: string | null
    dirName: string
    nodeType: string
    order: number | null
  },
  curatedUuid: string
): CuratedLocalNode | null => {
  if (existing.nodeType !== 'dir' && existing.nodeType !== 'songList') return null
  return {
    uuid: existing.uuid,
    parentUuid: toCloudParentUuid(existing.parentUuid || curatedUuid, curatedUuid),
    name: existing.dirName,
    nodeType: existing.nodeType,
    sortOrder: normalizeOrder(existing.order),
    updatedAtMs: 0
  }
}

const ensureCloudNodeLocal = async (
  node: CuratedLibrarySyncCloudNode,
  scope: CloudParentScope,
  options: ApplyRemoteOptions
): Promise<string | null> => {
  if (listPendingDeletedCuratedNodeIds().has(node.uuid)) {
    logCuratedDeleteTrace('ensure-aborted-pending', { uuid: node.uuid, name: node.name })
    return null
  }
  const existing = (loadLibraryNodes() || []).find((item) => item.uuid === node.uuid)
  const parentUuid = localParentUuidOf(node.parentUuid, scope)
  const parentAbs = localParentAbsOf(node.parentUuid, scope)
  if (!parentAbs) return null
  const destAbs = path.join(parentAbs, node.name)
  if (existing) {
    const lastNode = options.lastAppliedNodes?.get(node.uuid)
    const live = liveLocalNodeFromRow(existing, scope.curatedUuid)
    const lastNodeIds = new Set(options.lastAppliedNodes?.keys() || [])
    if (
      shouldPreservePendingLocal(options) &&
      live &&
      localNodePendingSinceLast(live, lastNode, scope.curatedUuid, lastNodeIds)
    ) {
      const currentAbs = getNodeAbsPath(node.uuid)
      logCuratedDeleteTrace('apply-skip-pending-node-meta', {
        uuid: node.uuid,
        name: existing.dirName,
        localOrder: live.sortOrder,
        cloudOrder: node.sortOrder
      })
      if (currentAbs) await writeUuidMarker(currentAbs, node.uuid)
      return currentAbs
    }
    const currentAbs = getNodeAbsPath(node.uuid)
    if (currentAbs && path.normalize(currentAbs) !== path.normalize(destAbs)) {
      await fs.ensureDir(path.dirname(destAbs))
      if (await fs.pathExists(currentAbs)) {
        await relocateLibraryDirectoryFiles(currentAbs, destAbs)
      }
      moveLibraryNode(node.uuid, parentUuid, node.name)
    } else if (existing.dirName !== node.name) {
      updateLibraryNodeName(node.uuid, node.name)
    }
    updateLibraryNodeOrder(node.uuid, node.sortOrder)
    await writeUuidMarker(destAbs, node.uuid)
    return destAbs
  }
  const mapped = mappedLibraryPath(destAbs)
  const collision = findLibraryNodeByPath(mapped)
  if (collision && collision.uuid !== node.uuid) {
    adoptNodeUuid(collision.uuid, node.uuid)
    updateLibraryNodeOrder(node.uuid, node.sortOrder)
    await writeUuidMarker(destAbs, node.uuid)
    return destAbs
  }
  await fs.ensureDir(destAbs)
  insertLibraryNode({
    uuid: node.uuid,
    parentUuid,
    dirName: node.name,
    nodeType: node.nodeType,
    order: node.sortOrder
  })
  await writeUuidMarker(destAbs, node.uuid)
  return destAbs
}

const restoreFromRecycle = async (
  record: RecycleBinRecord,
  destDir: string,
  fileName: string
): Promise<string | null> => {
  const restored = await restoreRecycleBinFile(record.filePath)
  if (restored.status !== 'restored' || !restored.destPath) return null
  if (
    path.dirname(restored.destPath) === destDir &&
    path.basename(restored.destPath) === fileName
  ) {
    return restored.destPath
  }
  const dest = path.join(destDir, fileName)
  return await relocateLibraryAudioFile({
    sourceAbs: restored.destPath,
    destAbs: dest,
    mode: 'move'
  })
}

const findCustodyFile = async (file: CuratedLibrarySyncCloudFile): Promise<string | null> => {
  const identity = getCuratedSyncFileById(file.fileId)
  if (identity?.location === 'custody' && identity.locationPath) {
    const abs = libraryRelativeToAbs(identity.locationPath)
    if (abs && (await fs.pathExists(abs))) return abs
  }
  return null
}

const importCloudFile = async (
  file: CuratedLibrarySyncCloudFile,
  ctx: ApplyRemoteContext,
  scope: CloudParentScope
): Promise<string | null> => {
  assertNotCancelled(ctx.signal)
  const destDir = localParentAbsOf(file.parentUuid, scope)
  if (!destDir) return null
  await fs.ensureDir(destDir)
  const destPath = path.join(destDir, file.fileName)
  const recycle = getRecycleBinRecordByFileId(file.fileId)
  if (recycle) {
    const restored = await restoreFromRecycle(recycle, destDir, file.fileName)
    if (restored) return restored
  }
  const custody = await findCustodyFile(file)
  if (custody) {
    return await relocateLibraryAudioFile({
      sourceAbs: custody,
      destAbs: destPath,
      mode: 'move'
    })
  }
  const tempPath = path.join(
    os.tmpdir(),
    'frkb-curated-sync',
    `${file.fileId}-${file.sha256.slice(0, 8)}`
  )
  await fs.ensureDir(path.dirname(tempPath))
  await runPlaybackAwareBackgroundFileIo(
    'curated-library-sync:download-blob',
    { filePath: destPath },
    () =>
      downloadBlobFile({
        sha256: file.sha256,
        destPath: tempPath,
        expectedSize: file.size,
        signal: ctx.signal
      })
  )
  const finalPath = await relocateLibraryAudioFile({
    sourceAbs: tempPath,
    destAbs: destPath,
    mode: 'move'
  })
  await stampPlaylistSongsAddedAt({
    listRoot: destDir,
    filePaths: [finalPath],
    addedAtMs: file.addedAtMs ?? undefined
  })
  rememberImportedCuratedTracks([finalPath])
  return finalPath
}

const tryImportCloudFile = async (
  file: CuratedLibrarySyncCloudFile,
  ctx: ApplyRemoteContext,
  scope: CloudParentScope
): Promise<string | null> => {
  try {
    return await importCloudFile(file, ctx, scope)
  } catch (error) {
    if (isEnospc(error)) throw error
    if ((error as { name?: string })?.name === 'AbortError') throw error
    ctx.onTransferFailure?.({
      direction: 'download',
      name: file.fileName,
      sha256: file.sha256,
      fileId: file.fileId,
      error
    })
    return null
  }
}

const persistImportedIdentity = (
  file: CuratedLibrarySyncCloudFile,
  absPath: string,
  relativePath: string,
  scope: CloudParentScope
) => {
  const existing = getCuratedSyncFileById(file.fileId)
  const row: CuratedSyncFileRow = {
    fileId: file.fileId,
    relativePath,
    parentUuid: canonicalParentUuidOf(file.parentUuid, scope),
    fileName: path.basename(absPath),
    contentSha256: file.sha256,
    contentSize: file.size,
    mtimeMs: Date.now(),
    trackNumber: file.trackNumber,
    addedAtMs: file.addedAtMs,
    updatedAtMs: file.updatedAtMs,
    location: 'curated',
    locationPath: relativePath
  }
  if (existing && existing.fileId !== file.fileId) {
    replaceCuratedSyncFileId(existing.fileId, file.fileId)
  }
  upsertCuratedSyncFile(row)
}

const persistMatchedCloudFile = async (
  file: CuratedLibrarySyncCloudFile,
  absPath: string,
  destDir: string,
  curatedRoot: string,
  scope: CloudParentScope,
  previousAddedAtMs: number | null
) => {
  persistImportedIdentity(file, absPath, absToRel(curatedRoot, absPath), scope)
  const cloudAdded = file.addedAtMs
  if (cloudAdded == null || !Number.isFinite(cloudAdded) || cloudAdded === previousAddedAtMs) {
    return
  }
  await stampPlaylistSongsAddedAt({
    listRoot: destDir,
    filePaths: [absPath],
    addedAtMs: cloudAdded
  })
}

const deleteLocalFile = async (absPath: string, ctx: ApplyRemoteContext): Promise<boolean> => {
  if (isBusyPath(absPath, ctx)) return false
  const setProtection = await protectSetReferencedFilesForDeletion([absPath])
  if (setProtection.protectedFiles.some((item) => item.filePath === absPath && item.success)) {
    return true
  }
  const result = await moveFileToRecycleBin(absPath)
  return result.status === 'moved' || result.status === 'skipped'
}

const resolveLocalAbsForFileId = (
  fileId: string,
  localById: Map<string, CuratedLocalFile>
): string | null => {
  const localFile = localById.get(fileId)
  if (localFile?.absPath) return localFile.absPath
  const identity = getCuratedSyncFileById(fileId)
  if (identity?.location === 'curated' && identity.relativePath) {
    return curatedRelativeToAbs(identity.relativePath)
  }
  return null
}

/** 同步开跑后用户才删歌单：options 里的 Set 可能是旧的，必须并上此刻库里的待删名单。 */
export const livePendingDeletedNodeIds = (options?: ApplyRemoteOptions): Set<string> => {
  const live = listPendingDeletedCuratedNodeIds()
  const passed = options?.pendingDeletedNodeIds
  if (!passed || passed.size === 0) return live
  if (live.size === 0) return passed
  const merged = new Set(passed)
  for (const id of live) merged.add(id)
  return merged
}

export const shouldSkipRestoringCloudFile = (
  file: CuratedLibrarySyncCloudFile,
  options: ApplyRemoteOptions
): boolean => {
  if (options.extras === 'delete' || options.adoptIds) return false
  if (livePendingDeletedNodeIds(options).has(file.parentUuid)) return true
  const identity = getCuratedSyncFileById(file.fileId)
  const abs =
    identity?.location === 'curated' && identity.relativePath
      ? curatedRelativeToAbs(identity.relativePath)
      : null
  let onDisk = false
  try {
    onDisk = !!abs && fs.pathExistsSync(abs)
  } catch {
    onDisk = false
  }
  const locallyRemoved = !!identity && (identity.location !== 'curated' || !onDisk)
  if (locallyRemoved) return true
  return !identity && !!options.knownFileIds?.has(file.fileId)
}

export const shouldSkipRecreatingCloudNode = (
  nodeUuid: string,
  options: ApplyRemoteOptions
): boolean => {
  if (options.extras === 'delete' || options.adoptIds) return false
  if (livePendingDeletedNodeIds(options).has(nodeUuid)) return true
  if (options.knownNodeIds == null) return false
  return options.knownNodeIds.has(nodeUuid)
}

/** 用户刚删的，或本机扫描没有且上一份快照里有过：不要 mkdir 回来。 */
export const shouldSkipRecreatingLocallyMissingCloudNode = (
  nodeUuid: string,
  localNodeIds: Set<string>,
  options: ApplyRemoteOptions
): boolean => {
  if (livePendingDeletedNodeIds(options).has(nodeUuid)) return true
  return !localNodeIds.has(nodeUuid) && shouldSkipRecreatingCloudNode(nodeUuid, options)
}

export const collectUnappliedCloudIds = (
  snapshot: CuratedLibrarySyncSnapshot,
  local: { files: CuratedLocalFile[]; nodes: CuratedLocalNode[] },
  options: ApplyRemoteOptions
): { files: Set<string>; nodes: Set<string> } => {
  const localFileIds = new Set(local.files.map((file) => file.fileId))
  const localNodeIds = new Set(local.nodes.map((node) => node.uuid))
  return {
    files: new Set(
      snapshot.files
        .filter((file) => {
          if (localFileIds.has(file.fileId)) return false
          if (shouldSkipRestoringCloudFile(file, options)) return false
          // 上一轮已经落到本机、现在扫描不到：用户删了，不要当成落地失败而保留云端
          if (options.knownFileIds?.has(file.fileId)) return false
          return true
        })
        .map((file) => file.fileId)
    ),
    nodes: new Set(
      snapshot.nodes
        .filter(
          (node) =>
            !localNodeIds.has(node.uuid) &&
            !shouldSkipRecreatingLocallyMissingCloudNode(node.uuid, localNodeIds, options)
        )
        .map((node) => node.uuid)
    )
  }
}

const sortNodesParentsFirst = (nodes: CuratedLibrarySyncCloudNode[]) => {
  const remaining = [...nodes]
  const ordered: CuratedLibrarySyncCloudNode[] = []
  const seen = new Set<string>()
  while (remaining.length > 0) {
    const nextIndex = remaining.findIndex(
      (node) =>
        seen.has(node.parentUuid) || !remaining.some((item) => item.uuid === node.parentUuid)
    )
    const index = nextIndex >= 0 ? nextIndex : 0
    const [node] = remaining.splice(index, 1)
    if (!node) break
    ordered.push(node)
    seen.add(node.uuid)
  }
  return ordered
}

const applyTrackNumbers = async (files: CuratedLibrarySyncCloudFile[], scope: CloudParentScope) => {
  const grouped = new Map<string, CuratedLibrarySyncCloudFile[]>()
  for (const file of files) {
    const parentUuid = localParentUuidOf(file.parentUuid, scope)
    const list = grouped.get(parentUuid) || []
    list.push(file)
    grouped.set(parentUuid, list)
  }
  for (const [parentUuid, group] of grouped) {
    const listRoot =
      parentUuid === scope.curatedUuid ? getCuratedLibraryAbsRoot() : getNodeAbsPath(parentUuid)
    if (!listRoot) continue
    const ordered = [...group].sort((left, right) => {
      const leftNum = Number(left.trackNumber) || Number.MAX_SAFE_INTEGER
      const rightNum = Number(right.trackNumber) || Number.MAX_SAFE_INTEGER
      if (leftNum !== rightNum) return leftNum - rightNum
      return left.fileName.localeCompare(right.fileName)
    })
    const absPaths: string[] = []
    for (const file of ordered) {
      const identity = getCuratedSyncFileById(file.fileId)
      const abs =
        (identity?.relativePath && curatedRelativeToAbs(identity.relativePath)) ||
        path.join(listRoot, file.fileName)
      if (await fs.pathExists(abs)) absPaths.push(abs)
    }
    if (absPaths.length > 0) {
      await setSongListTrackNumbersByOrder({ listRoot, orderedFilePaths: absPaths })
    }
  }
}

const applyFileTombstones = async (
  snapshot: CuratedLibrarySyncSnapshot,
  localById: Map<string, CuratedLocalFile>,
  curatedRoot: string,
  ctx: ApplyRemoteContext,
  options: ApplyRemoteOptions
): Promise<DeferredRemoteOp[]> => {
  const deferred: DeferredRemoteOp[] = []
  const cloudFileIds = new Set(snapshot.files.map((file) => file.fileId))
  for (const tombstone of snapshot.tombstones) {
    if (tombstone.kind !== 'file' || cloudFileIds.has(tombstone.id)) continue
    assertNotCancelled(ctx.signal)
    const abs = resolveLocalAbsForFileId(tombstone.id, localById)
    if (!abs || !isPathInside(abs, curatedRoot) || !(await fs.pathExists(abs))) continue
    // 上次本机快照里没有这首：多半是回收站恢复，不要先搬回垃圾桶。
    // 上次有过：对端删了，本机还留着，必须落地墓碑。禁止用扫描写成 now 的 updatedAtMs 跳过。
    if (options.knownFileIds && !options.knownFileIds.has(tombstone.id)) {
      logCuratedDeleteTrace('tombstone-skip-restored-file', { fileId: tombstone.id })
      continue
    }
    if (isBusyPath(abs, ctx)) {
      deferred.push({ type: 'deleteFile', fileId: tombstone.id })
      continue
    }
    logCuratedDeleteTrace('tombstone-remove-file', { fileId: tombstone.id, abs })
    await deleteLocalFile(abs, ctx)
  }
  return deferred
}

const audioExtSet = (): Set<string> => {
  const list = store.settingConfig?.audioExt
  const result = new Set<string>()
  if (!Array.isArray(list)) return result
  for (const raw of list) {
    const ext = String(raw || '')
      .trim()
      .toLowerCase()
    if (!ext) continue
    result.add(ext.startsWith('.') ? ext : `.${ext}`)
  }
  return result
}

const dirHasAudioFiles = async (dirPath: string, audioExts: Set<string>): Promise<boolean> => {
  const items = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => [])
  for (const item of items) {
    const full = path.join(dirPath, item.name)
    if (item.isFile()) {
      if (audioExts.has(path.extname(item.name).toLowerCase())) return true
    } else if (item.isDirectory() && (await dirHasAudioFiles(full, audioExts))) {
      return true
    }
  }
  return false
}

const applyNodeTombstones = async (
  snapshot: CuratedLibrarySyncSnapshot,
  curatedRoot: string,
  ctx: ApplyRemoteContext
): Promise<DeferredRemoteOp[]> => {
  const deferred: DeferredRemoteOp[] = []
  const cloudNodeIds = new Set(snapshot.nodes.map((node) => node.uuid))
  const audioExts = audioExtSet()
  const tombstoned = snapshot.tombstones
    .filter((item) => item.kind === 'node' && !cloudNodeIds.has(item.id))
    .map((item) => item.id)
  const withDepth = tombstoned
    .map((uuid) => {
      const abs = getNodeAbsPath(uuid)
      return { uuid, abs, depth: abs ? abs.split(/[/\\]/).length : 0 }
    })
    .sort((left, right) => right.depth - left.depth)
  for (const item of withDepth) {
    assertNotCancelled(ctx.signal)
    if (!item.abs || !isPathInside(item.abs, curatedRoot) || !(await fs.pathExists(item.abs))) {
      const nodes = loadLibraryNodes() || []
      if (nodes.some((node) => node.uuid === item.uuid)) removeLibraryNode(item.uuid)
      continue
    }
    // 本机删空歌单只看有没有音频；封面等残留不能挡住墓碑，否则对端会 upsert 把歌单救回云端。
    if (await dirHasAudioFiles(item.abs, audioExts)) {
      logCuratedDeleteTrace('tombstone-defer-has-audio', { uuid: item.uuid, abs: item.abs })
      deferred.push({ type: 'deleteNode', nodeUuid: item.uuid })
      continue
    }
    logCuratedDeleteTrace('tombstone-remove-node', { uuid: item.uuid, abs: item.abs })
    await fs.remove(item.abs)
    removeLibraryNode(item.uuid)
  }
  return deferred
}

export const applyRemoteSnapshot = async (
  snapshot: CuratedLibrarySyncSnapshot,
  local: { files: CuratedLocalFile[]; nodes: CuratedLocalNode[] },
  options: ApplyRemoteOptions,
  ctx: ApplyRemoteContext
): Promise<{ deferred: DeferredRemoteOp[]; diskFull: boolean }> => {
  const deferred: DeferredRemoteOp[] = []
  const curated = findCuratedLibraryNode()
  const curatedRoot = getCuratedLibraryAbsRoot()
  const libraryRoot = getLibraryAbsRoot()
  if (!curated || !curatedRoot || !libraryRoot) return { deferred, diskFull: false }
  const scope: CloudParentScope = {
    curatedUuid: curated.uuid,
    snapshotNodeIds: new Set(snapshot.nodes.map((node) => node.uuid))
  }

  try {
    const orderedNodes = sortNodesParentsFirst(
      snapshot.nodes.filter((node) => node.parentUuid && node.uuid)
    )
    const localNodeIds = new Set(local.nodes.map((node) => node.uuid))
    for (const node of orderedNodes) {
      assertNotCancelled(ctx.signal)
      const pendingDeleted = livePendingDeletedNodeIds(options)
      if (shouldSkipRecreatingLocallyMissingCloudNode(node.uuid, localNodeIds, options)) {
        if (pendingDeleted.has(node.uuid)) {
          logCuratedDeleteTrace('apply-skip-pending-node', {
            uuid: node.uuid,
            name: node.name,
            staleLocalScanStillHadIt: localNodeIds.has(node.uuid)
          })
          await removeLocalPendingCuratedNodeShell(node.uuid, curatedRoot)
        }
        continue
      }
      const existedInScan = localNodeIds.has(node.uuid)
      await ensureCloudNodeLocal(node, scope, options)
      if (!existedInScan) {
        logCuratedDeleteTrace('apply-ensure-missing-node', {
          uuid: node.uuid,
          name: node.name,
          pending: pendingDeleted.has(node.uuid)
        })
      }
    }
    await purgePendingDeletedCuratedNodeShells()

    const cloudFileIds = new Set(snapshot.files.map((file) => file.fileId))
    const localById = new Map(local.files.map((file) => [file.fileId, file]))
    const localByHash = new Map<string, CuratedLocalFile[]>()
    for (const file of local.files) {
      const list = localByHash.get(file.contentSha256) || []
      list.push(file)
      localByHash.set(file.contentSha256, list)
    }

    for (const file of snapshot.files) {
      assertNotCancelled(ctx.signal)
      const localFile = localById.get(file.fileId)
      let matched = localFile
      if (!matched && options.adoptIds) {
        const hashMatches = localByHash.get(file.sha256) || []
        matched = hashMatches.find((item) => item.fileName === file.fileName) || hashMatches[0]
        if (matched && matched.fileId !== file.fileId) {
          replaceCuratedSyncFileId(matched.fileId, file.fileId)
          matched = { ...matched, fileId: file.fileId }
        }
      }
      const destDir = localParentAbsOf(file.parentUuid, scope)
      if (!destDir) continue
      if (matched) {
        const lastFile = options.lastAppliedFiles?.get(file.fileId)
        const lastNodeIds = new Set(options.lastAppliedNodes?.keys() || [])
        if (
          shouldPreservePendingLocal(options) &&
          localFilePendingSinceLast(matched, lastFile, scope.curatedUuid, lastNodeIds)
        ) {
          logCuratedDeleteTrace('apply-skip-pending-file-meta', {
            fileId: file.fileId,
            fileName: matched.fileName
          })
          continue
        }
        const destPath = path.join(destDir, file.fileName)
        if (isBusyPath(matched.absPath, ctx)) {
          deferred.push({
            type: 'moveFile',
            fileId: file.fileId,
            parentUuid: file.parentUuid,
            fileName: file.fileName,
            sha256: file.sha256
          })
          continue
        }
        if (matched.contentSha256 !== file.sha256) {
          const imported = await tryImportCloudFile(file, ctx, scope)
          if (imported) {
            await moveFileToRecycleBin(matched.absPath)
            persistImportedIdentity(
              file,
              imported,
              path.posix.join(
                path.relative(curatedRoot, destDir).replace(/\\/g, '/'),
                path.basename(imported)
              ),
              scope
            )
          }
          continue
        }
        if (path.normalize(matched.absPath) !== path.normalize(destPath)) {
          const moved = await relocateLibraryAudioFile({
            sourceAbs: matched.absPath,
            destAbs: destPath,
            mode: 'move'
          })
          await persistMatchedCloudFile(file, moved, destDir, curatedRoot, scope, matched.addedAtMs)
        } else {
          await persistMatchedCloudFile(
            file,
            matched.absPath,
            destDir,
            curatedRoot,
            scope,
            matched.addedAtMs
          )
        }
        continue
      }
      if (shouldSkipRestoringCloudFile(file, options)) continue
      const imported = await tryImportCloudFile(file, ctx, scope)
      if (imported) persistImportedIdentity(file, imported, absToRel(curatedRoot, imported), scope)
    }

    if (options.applyTombstones !== false) {
      deferred.push(...(await applyFileTombstones(snapshot, localById, curatedRoot, ctx, options)))
      deferred.push(...(await applyNodeTombstones(snapshot, curatedRoot, ctx)))
    }

    if (options.extras === 'delete') {
      const extraFiles = local.files.filter((localFile) => !cloudFileIds.has(localFile.fileId))
      for (const localFile of extraFiles) {
        assertNotCancelled(ctx.signal)
        if (isBusyPath(localFile.absPath, ctx)) {
          deferred.push({ type: 'deleteFile', fileId: localFile.fileId })
          continue
        }
        await deleteLocalFile(localFile.absPath, ctx)
      }
      const cloudNodeIds = new Set(snapshot.nodes.map((node) => node.uuid))
      const localNodes = [...local.nodes].reverse()
      const audioExts = audioExtSet()
      for (const node of localNodes) {
        if (cloudNodeIds.has(node.uuid)) continue
        const abs = getNodeAbsPath(node.uuid)
        if (!abs || !isPathInside(abs, curatedRoot)) continue
        if (await dirHasAudioFiles(abs, audioExts)) continue
        await fs.remove(abs)
        removeLibraryNode(node.uuid)
      }
    }

    const skipTrackParents = new Set<string>()
    if (shouldPreservePendingLocal(options)) {
      const lastNodeIds = new Set(options.lastAppliedNodes?.keys() || [])
      for (const localFile of local.files) {
        const lastFile = options.lastAppliedFiles?.get(localFile.fileId)
        if (!lastFile) continue
        if (
          asOptionalPositiveInt(lastFile.trackNumber) !==
            asOptionalPositiveInt(localFile.trackNumber) ||
          asOptionalPositiveInt(lastFile.addedAtMs) !== asOptionalPositiveInt(localFile.addedAtMs)
        ) {
          skipTrackParents.add(localFile.parentUuid)
          skipTrackParents.add(localParentUuidOf(localFile.parentUuid, scope))
        }
      }
    }
    await applyTrackNumbers(
      snapshot.files.filter((file) => {
        if (skipTrackParents.size === 0) return true
        return (
          !skipTrackParents.has(file.parentUuid) &&
          !skipTrackParents.has(localParentUuidOf(file.parentUuid, scope))
        )
      }),
      scope
    )
    return { deferred, diskFull: false }
  } catch (error) {
    if (isEnospc(error)) return { deferred, diskFull: true }
    throw error
  }
}

export const retryDeferredRemoteOps = async (
  ops: DeferredRemoteOp[],
  snapshot: CuratedLibrarySyncSnapshot,
  ctx: ApplyRemoteContext
): Promise<DeferredRemoteOp[]> => {
  const remaining: DeferredRemoteOp[] = []
  const cloudFiles = new Map(snapshot.files.map((file) => [file.fileId, file]))
  const cloudNodes = new Set(snapshot.nodes.map((node) => node.uuid))
  const tombstonedFiles = new Set(
    snapshot.tombstones.filter((item) => item.kind === 'file').map((item) => item.id)
  )
  const tombstonedNodes = new Set(
    snapshot.tombstones.filter((item) => item.kind === 'node').map((item) => item.id)
  )
  const localById = new Map<string, CuratedLocalFile>()
  const curatedRoot = getCuratedLibraryAbsRoot()
  const curated = findCuratedLibraryNode()
  const scope: CloudParentScope | null = curated
    ? {
        curatedUuid: curated.uuid,
        snapshotNodeIds: new Set(snapshot.nodes.map((node) => node.uuid))
      }
    : null
  for (const op of ops) {
    assertNotCancelled(ctx.signal)
    if (op.type === 'deleteFile') {
      const fileId = String(op.fileId || '').trim()
      if (!fileId) continue
      if (!tombstonedFiles.has(fileId) && cloudFiles.has(fileId)) continue
      const abs = resolveLocalAbsForFileId(fileId, localById)
      if (!abs || !(await fs.pathExists(abs))) continue
      if (isBusyPath(abs, ctx)) {
        remaining.push(op)
        continue
      }
      await deleteLocalFile(abs, ctx)
      continue
    }
    if (op.type === 'deleteNode') {
      const uuid = String(op.nodeUuid || '').trim()
      if (!uuid) continue
      if (!tombstonedNodes.has(uuid) && cloudNodes.has(uuid)) continue
      if (!curatedRoot) continue
      const extra = await applyNodeTombstones(
        {
          ...snapshot,
          tombstones: snapshot.tombstones.filter((item) => item.kind === 'node' && item.id === uuid)
        },
        curatedRoot,
        ctx
      )
      remaining.push(...extra)
      continue
    }
    const fileId = String(op.fileId || '').trim()
    const cloud = cloudFiles.get(fileId)
    if (!cloud) continue
    const identity = getCuratedSyncFileById(fileId)
    const abs = identity?.relativePath ? curatedRelativeToAbs(identity.relativePath) : null
    if (!abs || !(await fs.pathExists(abs))) continue
    if (isBusyPath(abs, ctx)) {
      remaining.push(op)
      continue
    }
    const destDir = scope
      ? localParentAbsOf(cloud.parentUuid, scope)
      : getNodeAbsPath(cloud.parentUuid)
    if (!destDir) continue
    const destPath = path.join(destDir, cloud.fileName)
    await relocateLibraryAudioFile({
      sourceAbs: abs,
      destAbs: destPath,
      mode: 'move'
    })
  }
  return remaining
}

export const buildCloudEntitiesFromLocal = (local: {
  files: CuratedLocalFile[]
  nodes: CuratedLocalNode[]
}): { nodes: CuratedLibrarySyncCloudNode[]; files: CuratedLibrarySyncCloudFile[] } => {
  const now = Date.now()
  return {
    nodes: local.nodes.map((node) => ({
      uuid: node.uuid,
      parentUuid: node.parentUuid,
      name: node.name,
      nodeType: node.nodeType,
      sortOrder: node.sortOrder,
      updatedAtMs: node.updatedAtMs || now
    })),
    files: local.files.map((file) => ({
      fileId: file.fileId,
      parentUuid: file.parentUuid,
      fileName: file.fileName,
      sha256: file.contentSha256,
      size: file.contentSize,
      trackNumber: file.trackNumber,
      addedAtMs: file.addedAtMs,
      updatedAtMs: file.updatedAtMs || now
    }))
  }
}

export const diffLocalAgainstSnapshot = (
  local: { files: CuratedLocalFile[]; nodes: CuratedLocalNode[] },
  snapshot: CuratedLibrarySyncSnapshot
) => {
  const cloudFiles = new Map(snapshot.files.map((file) => [file.fileId, file]))
  const cloudNodes = new Map(snapshot.nodes.map((node) => [node.uuid, node]))
  const tombstoneFiles = new Map(
    snapshot.tombstones
      .filter((item) => item.kind === 'file')
      .map((item) => [item.id, item] as const)
  )
  const tombstoneNodes = new Set(
    snapshot.tombstones.filter((item) => item.kind === 'node').map((item) => item.id)
  )
  const localFileIds = new Set(local.files.map((file) => file.fileId))
  const localNodeIds = new Set(local.nodes.map((node) => node.uuid))
  return {
    cloudFiles,
    cloudNodes,
    tombstoneFiles,
    tombstoneNodes,
    localFileIds,
    localNodeIds
  }
}
