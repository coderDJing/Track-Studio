import path from 'node:path'
import { powerMonitor } from 'electron'
import store from '../store'
import { log } from '../log'
import mainWindow from '../window/mainWindow'
import { isLibraryMergeActive } from '../services/libraryMerge'
import { isLibraryRelocateActive, hasLibraryRelocateJournalSync } from '../services/libraryRelocate'
import { beginLibraryTreeWatcherBulkOperation } from '../libraryTreeWatcher'
import { getLibrary } from '../utils'
import { runPlaybackAwareBackgroundFileIo } from '../services/playbackForegroundActivity'
import { is } from '@electron-toolkit/utils'
import { resolveDevCloudSyncUserKey } from '../../shared/cloudSyncDevUserKey'
import {
  getCuratedLibrarySyncLastAppliedRevision,
  isCuratedLibrarySyncEnabled,
  readCuratedLibrarySyncDeferredOps,
  readCuratedLibrarySyncLastCloudIds,
  writeCuratedLibrarySyncDeferredOps,
  writeCuratedLibrarySyncLastCloudIds,
  readCuratedLibrarySyncLastSnapshot,
  writeCuratedLibrarySyncLastSnapshot,
  writeCuratedLibrarySyncConflicts,
  writeCuratedLibrarySyncFailures,
  writeCuratedLibrarySyncQuotaCache,
  setCuratedLibrarySyncLastAppliedRevision,
  forgetCuratedLibrarySyncJoinState
} from '../librarySettingsDb'
import { getPendingCuratedLibraryJoinPrompt } from './joinPrompt'
import {
  CURATED_LIBRARY_SYNC_PLAYLISTS_CHANGED_CHANNEL,
  CURATED_LIBRARY_SYNC_PROGRESS_ID,
  CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID,
  type CuratedLibrarySyncConflictItem,
  type CuratedLibrarySyncFailureItem,
  type CuratedLibrarySyncJoinMode,
  type CuratedLibrarySyncListFileChange,
  type CuratedLibrarySyncOp,
  type CuratedLibrarySyncPlaylistsChangedPayload,
  type CuratedLibrarySyncSnapshot,
  type CuratedLibrarySyncStartPayload,
  type CuratedLibrarySyncStartResult,
  type CuratedLibrarySyncTrigger
} from '../../shared/curatedLibrarySync'
import { RECYCLE_BIN_UUID } from '../../shared/recycleBin'
import {
  beginBlobUpload,
  beginFirstCuratedSnapshot,
  commitFirstCuratedSnapshot,
  fetchCuratedLibraryStatus,
  pullCuratedSnapshot,
  pushCuratedOps,
  replaceCuratedSnapshot
} from './apiClient'
import { uploadBlobWithResume } from './blobTransfer'
import { collectDroppedOps } from './conflictDiff'
import { mapTransferErrorKey } from './reports'
import { parseCuratedLibrarySnapshot, mergeCuratedLibrarySnapshot } from './snapshotMerge'
import {
  applyRemoteSnapshot,
  buildCloudEntitiesFromLocal,
  collectUnappliedCloudIds,
  diffLocalAgainstSnapshot,
  retryDeferredRemoteOps,
  type ApplyRemoteContext,
  type ApplyRemoteOptions,
  type DeferredRemoteOp
} from './applyRemote'
import { scanCuratedLibraryForSync, type CuratedLocalFile, type CuratedLocalNode } from './scan'
import { findCuratedLibraryNode, sameCloudParentUuid } from './paths'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import {
  listPendingDeletedCuratedNodeIds,
  logCuratedDeleteTrace,
  prunePendingDeletedCuratedNodes,
  purgePendingDeletedCuratedNodeShells
} from './pendingDeletedNodes'
import {
  asOptionalNumber,
  asOptionalPositiveInt,
  localFilePendingSinceLast,
  localNodePendingSinceLast,
  sameSortOrder
} from './pendingLocal'

let running = false
let cancelRequested = false
let abortController: AbortController | null = null
let suspendPaused = false
let resumeWaiters: Array<() => void> = []
let powerMonitorBound = false
let sessionFailures: CuratedLibrarySyncFailureItem[] = []
let sessionConflicts: CuratedLibrarySyncConflictItem[] = []
let sessionAttemptedTransfers = false
let sessionCompletedWork = false

const bindPowerMonitor = () => {
  if (powerMonitorBound) return
  powerMonitorBound = true
  powerMonitor.on('suspend', () => {
    suspendPaused = true
    abortController?.abort()
  })
  powerMonitor.on('resume', () => {
    suspendPaused = false
    for (const waiter of resumeWaiters) waiter()
    resumeWaiters = []
  })
}

const waitIfSuspended = async () => {
  if (!suspendPaused) return
  await new Promise<void>((resolve) => {
    resumeWaiters.push(resolve)
  })
}

const recordFailure = (item: Omit<CuratedLibrarySyncFailureItem, 'atMs'> & { atMs?: number }) => {
  sessionFailures.push({
    ...item,
    atMs: item.atMs || Date.now()
  })
}

const cacheQuotaFromStatus = (status: {
  blobBytes: number
  quotaBytes?: number
  fileCount: number
  revision: number
  snapshotReady: boolean
}) => {
  writeCuratedLibrarySyncQuotaCache({
    quotaUsedBytes: status.blobBytes,
    quotaBytes: Number(status.quotaBytes) || 0,
    fileCount: status.fileCount,
    revision: status.revision,
    snapshotReady: status.snapshotReady
  })
}

const emitSyncNotice = () => {
  if (sessionConflicts.length === 0 && sessionFailures.length === 0) return
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  win.webContents.send('curatedLibrarySync/notice', {
    kind: sessionConflicts.length > 0 ? 'conflicts' : 'failures',
    conflictCount: sessionConflicts.length,
    failureCount: sessionFailures.length
  })
}

const persistSessionReports = (keepPrevious: boolean) => {
  if (!keepPrevious) {
    writeCuratedLibrarySyncConflicts(sessionConflicts)
    writeCuratedLibrarySyncFailures(sessionFailures)
    return
  }
  if (sessionConflicts.length > 0) writeCuratedLibrarySyncConflicts(sessionConflicts)
  if (sessionFailures.length > 0) writeCuratedLibrarySyncFailures(sessionFailures)
}

const dismissProgress = () => {
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  win.webContents.send('progressSet', {
    id: CURATED_LIBRARY_SYNC_PROGRESS_ID,
    dismiss: true
  })
}

const notifyTree = async () => {
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

const throwIfCancelled = () => {
  if (cancelRequested) {
    const error = new Error('CURATED_SYNC_CANCELLED')
    error.name = 'AbortError'
    throw error
  }
}

const toDeferred = (value: unknown): DeferredRemoteOp[] => {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is DeferredRemoteOp => {
    if (!item || typeof item !== 'object') return false
    const type = (item as DeferredRemoteOp).type
    return type === 'deleteFile' || type === 'moveFile' || type === 'deleteNode'
  })
}

const uploadMissingBlobs = async (files: CuratedLocalFile[]): Promise<Set<string>> => {
  const seen = new Set<string>()
  const failed = new Set<string>()
  let index = 0
  sessionAttemptedTransfers = true
  for (const file of files) {
    throwIfCancelled()
    await waitIfSuspended()
    if (seen.has(file.contentSha256)) continue
    seen.add(file.contentSha256)
    index += 1
    try {
      const begin = await beginBlobUpload({ sha256: file.contentSha256, size: file.contentSize })
      if (!begin.needed) continue
      abortController = new AbortController()
      try {
        await runPlaybackAwareBackgroundFileIo(
          'curated-library-sync:upload-blob',
          { filePath: file.absPath },
          () =>
            uploadBlobWithResume({
              sha256: file.contentSha256,
              filePath: file.absPath,
              size: file.contentSize,
              signal: abortController?.signal,
              onSuspendWait: waitIfSuspended,
              throwIfCancelled
            })
        )
      } catch (error) {
        if (suspendPaused) {
          await waitIfSuspended()
          abortController = new AbortController()
          await uploadBlobWithResume({
            sha256: file.contentSha256,
            filePath: file.absPath,
            size: file.contentSize,
            signal: abortController.signal,
            onSuspendWait: waitIfSuspended,
            throwIfCancelled
          })
          continue
        }
        throw error
      }
    } catch (error) {
      if (cancelRequested || (error as { name?: string })?.name === 'AbortError') throw error
      failed.add(file.contentSha256)
      recordFailure({
        direction: 'upload',
        name: file.fileName,
        sha256: file.contentSha256,
        fileId: file.fileId,
        errorKey: mapTransferErrorKey(error)
      })
    }
  }
  return failed
}

const omitFailedBlobOps = (
  ops: CuratedLibrarySyncOp[],
  failedSha: Set<string>
): CuratedLibrarySyncOp[] => {
  if (failedSha.size === 0) return ops
  return ops.filter((op) => {
    if (op.type !== 'upsertFile' && op.type !== 'undeleteFile') return true
    return !failedSha.has(op.file.sha256)
  })
}

const rememberPushConflicts = (
  ops: CuratedLibrarySyncOp[],
  winning: CuratedLibrarySyncSnapshot
) => {
  const dropped = collectDroppedOps(ops, winning)
  if (dropped.length > 0) sessionConflicts = dropped
}

const buildPushOps = (
  local: Awaited<ReturnType<typeof scanCuratedLibraryForSync>>,
  snapshot: Awaited<ReturnType<typeof pullCuratedSnapshot>>,
  retainCloudIds?: { files: Set<string>; nodes: Set<string> }
): CuratedLibrarySyncOp[] => {
  const diff = diffLocalAgainstSnapshot(local, snapshot)
  const ops: CuratedLibrarySyncOp[] = []
  const now = Date.now()
  // Date.now() 是 Unix 毫秒（UTC），同一 userKey 跨时区可比；设备时钟不准时听服务端 revision。
  const curated = findCuratedLibraryNode()
  const snapshotNodeIds = new Set(snapshot.nodes.map((node) => node.uuid))
  const lastSnapshot = loadCachedSnapshot()
  const lastNodeById = new Map((lastSnapshot?.nodes || []).map((node) => [node.uuid, node]))
  const lastFileById = new Map((lastSnapshot?.files || []).map((file) => [file.fileId, file]))
  const lastKnownFileIds = new Set<string>([
    ...lastFileById.keys(),
    ...(readCuratedLibrarySyncLastCloudIds()?.files || [])
  ])
  const lastNodeIds = new Set(lastNodeById.keys())
  const parentChanged = (cloudParent: string, localParent: string): boolean => {
    if (!curated) return cloudParent !== localParent
    return !sameCloudParentUuid(cloudParent, localParent, curated.uuid, snapshotNodeIds)
  }
  const pendingDeleted = listPendingDeletedCuratedNodeIds()
  for (const node of local.nodes) {
    if (pendingDeleted.has(node.uuid)) continue
    // 墓碑赢：扫描会把 updatedAtMs 写成 now，不能靠时间戳判断「本机更新」。
    if (diff.tombstoneNodes.has(node.uuid) && !diff.cloudNodes.has(node.uuid)) {
      logCuratedDeleteTrace('skip-upsert-tombstoned-node', { uuid: node.uuid, name: node.name })
      continue
    }
    const cloud = diff.cloudNodes.get(node.uuid)
    const lastNode = lastNodeById.get(node.uuid)
    const localUnchangedSinceLast =
      !!lastNode &&
      localNodePendingSinceLast(node, lastNode, curated?.uuid || null, lastNodeIds) === false
    // 本机相对上次快照没改，云端却不同：那是对端改的。禁止用 now() 把过期本地写回去。
    if (cloud && localUnchangedSinceLast) continue
    if (
      !cloud ||
      cloud.name !== node.name ||
      parentChanged(cloud.parentUuid, node.parentUuid) ||
      sameSortOrder(cloud.sortOrder, node.sortOrder) === false ||
      cloud.nodeType !== node.nodeType
    ) {
      ops.push({
        type: 'upsertNode',
        node: {
          uuid: node.uuid,
          parentUuid: node.parentUuid,
          name: node.name,
          nodeType: node.nodeType,
          sortOrder: asOptionalNumber(node.sortOrder),
          updatedAtMs: now
        }
      })
    }
  }
  for (const file of local.files) {
    if (pendingDeleted.has(file.parentUuid)) continue
    if (diff.tombstoneFiles.has(file.fileId) && !diff.cloudFiles.has(file.fileId)) continue
    const cloud = diff.cloudFiles.get(file.fileId)
    const lastFile = lastFileById.get(file.fileId)
    const localUnchangedSinceLast =
      !!lastFile &&
      localFilePendingSinceLast(file, lastFile, curated?.uuid || null, lastNodeIds) === false
    if (cloud && localUnchangedSinceLast) continue
    if (
      !cloud ||
      parentChanged(cloud.parentUuid, file.parentUuid) ||
      cloud.fileName !== file.fileName ||
      cloud.sha256 !== file.contentSha256 ||
      asOptionalPositiveInt(cloud.trackNumber) !== asOptionalPositiveInt(file.trackNumber) ||
      asOptionalPositiveInt(cloud.addedAtMs) !== asOptionalPositiveInt(file.addedAtMs)
    ) {
      ops.push({
        type: 'upsertFile',
        file: {
          fileId: file.fileId,
          parentUuid: file.parentUuid,
          fileName: file.fileName,
          sha256: file.contentSha256,
          size: file.contentSize,
          trackNumber: asOptionalPositiveInt(file.trackNumber),
          addedAtMs: asOptionalPositiveInt(file.addedAtMs),
          updatedAtMs: now
        }
      })
    }
  }
  for (const [fileId] of diff.cloudFiles) {
    if (!diff.localFileIds.has(fileId) && !retainCloudIds?.files.has(fileId)) {
      ops.push({ type: 'deleteFile', fileId, updatedAtMs: now })
    }
  }
  for (const [uuid] of diff.cloudNodes) {
    if (
      pendingDeleted.has(uuid) ||
      (!diff.localNodeIds.has(uuid) && !retainCloudIds?.nodes.has(uuid))
    ) {
      ops.push({ type: 'deleteNode', uuid, updatedAtMs: now })
    }
  }
  for (const file of local.files) {
    if (pendingDeleted.has(file.parentUuid)) continue
    const tombstone = diff.tombstoneFiles.get(file.fileId)
    if (!tombstone) continue
    if (diff.cloudFiles.has(file.fileId)) continue
    // 上次同步还在本机/云快照里：这是过期副本，不是回收站恢复。
    if (lastKnownFileIds.has(file.fileId)) {
      logCuratedDeleteTrace('skip-undelete-stale-file', { fileId: file.fileId })
      continue
    }
    if (file.updatedAtMs <= tombstone.deletedAtMs) continue
    ops.push({
      type: 'undeleteFile',
      file: {
        fileId: file.fileId,
        parentUuid: file.parentUuid,
        fileName: file.fileName,
        sha256: file.contentSha256,
        size: file.contentSize,
        trackNumber: asOptionalPositiveInt(file.trackNumber),
        addedAtMs: asOptionalPositiveInt(file.addedAtMs),
        updatedAtMs: now
      }
    })
  }
  return ops
}

const persistAppliedSnapshot = (
  snapshot: CuratedLibrarySyncSnapshot,
  local?: { files: Array<{ fileId: string }>; nodes: Array<{ uuid: string }> }
) => {
  const pending = listPendingDeletedCuratedNodeIds()
  const rawLocalNodeIds = local
    ? local.nodes.map((node) => node.uuid)
    : snapshot.nodes.map((node) => node.uuid)
  setCuratedLibrarySyncLastAppliedRevision(snapshot.revision)
  writeCuratedLibrarySyncLastCloudIds({
    files: local
      ? local.files.map((file) => file.fileId)
      : snapshot.files.map((file) => file.fileId),
    nodes: rawLocalNodeIds.filter((uuid) => !pending.has(uuid)),
    materialized: true
  })
  writeCuratedLibrarySyncLastSnapshot({
    protocolVersion: snapshot.protocolVersion,
    revision: snapshot.revision,
    snapshotReady: snapshot.snapshotReady,
    full: true,
    nodes: snapshot.nodes,
    files: snapshot.files,
    tombstones: snapshot.tombstones
  })
  prunePendingDeletedCuratedNodes(
    new Set(snapshot.nodes.map((node) => node.uuid)),
    new Set(rawLocalNodeIds)
  )
}

const loadCachedSnapshot = () => parseCuratedLibrarySnapshot(readCuratedLibrarySyncLastSnapshot())

const pullMergedSnapshot = async (sinceRevision?: number | null) => {
  const cached = loadCachedSnapshot()
  const useDiff = cached != null && Number(sinceRevision) > 0
  const pulled = await pullCuratedSnapshot(useDiff ? sinceRevision : null)
  if (pulled.full === false && !cached) {
    const full = await pullCuratedSnapshot(null)
    return mergeCuratedLibrarySnapshot(null, full)
  }
  return mergeCuratedLibrarySnapshot(cached, pulled)
}

const waitForFirstSnapshotUnlock = async (): Promise<
  Awaited<ReturnType<typeof fetchCuratedLibraryStatus>>
> => {
  const deadline = Date.now() + 2 * 60 * 60 * 1000
  while (true) {
    throwIfCancelled()
    await waitIfSuspended()
    const status = await fetchCuratedLibraryStatus()
    if (status.snapshotReady || !status.firstSnapshotLocked) return status
    if (Date.now() >= deadline) {
      throw new Error('CURATED_SYNC_FIRST_SNAPSHOT_WAIT_TIMEOUT')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 3000))
  }
}

const applyCtx = (): ApplyRemoteContext => ({
  signal: abortController?.signal || new AbortController().signal,
  onTransferFailure: (payload) => {
    sessionAttemptedTransfers = true
    recordFailure({
      direction: payload.direction,
      name: payload.name,
      sha256: payload.sha256,
      fileId: payload.fileId,
      errorKey: mapTransferErrorKey(payload.error)
    })
  }
})

const runJoin = async (
  mode: CuratedLibrarySyncJoinMode
): Promise<CuratedLibrarySyncStartResult> => {
  sessionCompletedWork = true
  const local = await scanCuratedLibraryForSync()
  const snapshot = await pullMergedSnapshot(null)
  if (mode === 'local-wins') {
    const failedSha = await uploadMissingBlobs(local.files)
    const entities = buildCloudEntitiesFromLocal({
      ...local,
      files: local.files.filter((file) => !failedSha.has(file.contentSha256))
    })
    const next = await replaceCuratedSnapshot(entities)
    persistAppliedSnapshot(next, {
      files: local.files.filter((file) => !failedSha.has(file.contentSha256)),
      nodes: local.nodes
    })
    writeCuratedLibrarySyncDeferredOps([])
    return { status: 'success' }
  }
  const extras = mode === 'cloud-wins' ? 'delete' : 'keep'
  const release = beginLibraryTreeWatcherBulkOperation()
  let latest = local
  try {
    const applied = await applyRemoteSnapshot(
      snapshot,
      local,
      {
        extras,
        adoptIds: true,
        applyTombstones: mode !== 'merge',
        knownFileIds: null,
        knownNodeIds: null
      },
      applyCtx()
    )
    latest = await scanCuratedLibraryForSync()
    if (applied.diskFull) return { status: 'disk_full' }
    writeCuratedLibrarySyncDeferredOps(applied.deferred)
    const after = latest
    if (mode === 'merge') {
      const failedSha = await uploadMissingBlobs(after.files)
      const retain = collectUnappliedCloudIds(snapshot, after, {
        extras: 'keep',
        adoptIds: true,
        applyTombstones: false,
        knownFileIds: null,
        knownNodeIds: null
      })
      const ops = omitFailedBlobOps(buildPushOps(after, snapshot, retain), failedSha)
      if (ops.length > 0) {
        const pushed = await pushCuratedOps({ baseRevision: snapshot.revision, ops })
        if (!pushed.ok) {
          rememberPushConflicts(ops, pushed.snapshot)
          const conflictApplied = await applyRemoteSnapshot(
            pushed.snapshot,
            after,
            {
              extras: 'keep',
              adoptIds: true,
              applyTombstones: false,
              knownFileIds: null,
              knownNodeIds: null
            },
            applyCtx()
          )
          writeCuratedLibrarySyncDeferredOps([...applied.deferred, ...conflictApplied.deferred])
          latest = await scanCuratedLibraryForSync()
          persistAppliedSnapshot(pushed.snapshot, latest)
        } else {
          persistAppliedSnapshot(pushed.snapshot, after)
        }
      } else {
        persistAppliedSnapshot(snapshot, after)
      }
    } else {
      persistAppliedSnapshot(snapshot, after)
    }
  } finally {
    release()
    await notifyTree()
    notifyPlaylistsChanged(collectPlaylistFileChanges(local, latest))
  }
  return { status: 'success' }
}

const incrementalApplyOptions = (): ApplyRemoteOptions => {
  const lastIds = readCuratedLibrarySyncLastCloudIds()
  const cached = loadCachedSnapshot()
  const trustMaterialized = lastIds?.materialized === true
  const knownNodeIds = new Set<string>()
  if (cached) {
    for (const node of cached.nodes) knownNodeIds.add(node.uuid)
    for (const tombstone of cached.tombstones) {
      if (tombstone.kind === 'node') knownNodeIds.add(tombstone.id)
    }
  }
  if (trustMaterialized && lastIds) {
    for (const uuid of lastIds.nodes) knownNodeIds.add(uuid)
  }
  const pendingDeletedNodeIds = listPendingDeletedCuratedNodeIds()
  return {
    extras: 'keep' as const,
    adoptIds: false,
    applyTombstones: true,
    knownFileIds: trustMaterialized && lastIds ? new Set(lastIds.files) : null,
    // 快照节点 ∪ 上次本机落地节点。只信其中一份时，删歌单容易被当成云端新建。
    knownNodeIds:
      cached || trustMaterialized || pendingDeletedNodeIds.size > 0 ? knownNodeIds : null,
    pendingDeletedNodeIds,
    preservePendingLocal: true,
    lastAppliedNodes: cached ? new Map(cached.nodes.map((node) => [node.uuid, node])) : null,
    lastAppliedFiles: cached ? new Map(cached.files.map((file) => [file.fileId, file])) : null
  }
}

const isDeletionOp = (op: CuratedLibrarySyncOp): boolean =>
  op.type === 'deleteNode' || op.type === 'deleteFile'

const summarizePushOps = (phase: string, ops: CuratedLibrarySyncOp[]): void => {
  const pending = [...listPendingDeletedCuratedNodeIds()]
  const deleteNodes = ops.filter((op) => op.type === 'deleteNode').map((op) => op.uuid)
  const upsertNodeOps = ops.filter((op) => op.type === 'upsertNode')
  const upsertNodes = upsertNodeOps.map((op) => op.node.uuid)
  if (pending.length === 0 && deleteNodes.length === 0 && upsertNodes.length === 0) return
  logCuratedDeleteTrace('push-ops', {
    phase,
    pending,
    deleteNode: deleteNodes,
    upsertNodeIds: upsertNodes,
    upsertNodeOrders: upsertNodeOps.map((op) => ({
      uuid: op.node.uuid,
      sortOrder: op.node.sortOrder
    })),
    deleteFile: ops.filter((op) => op.type === 'deleteFile').length,
    upsertNode: upsertNodes.length,
    upsertFile: ops.filter((op) => op.type === 'upsertFile').length
  })
}

const runIncremental = async (): Promise<CuratedLibrarySyncStartResult> => {
  sessionCompletedWork = true
  const local = await scanCuratedLibraryForSync()
  let snapshot = await pullMergedSnapshot(getCuratedLibrarySyncLastAppliedRevision())
  const release = beginLibraryTreeWatcherBulkOperation()
  let latest = local
  try {
    const deferred = toDeferred(readCuratedLibrarySyncDeferredOps())
    const applyOptions = incrementalApplyOptions()
    const remainingDeferred = await retryDeferredRemoteOps(deferred, snapshot, applyCtx())
    const retainBefore = collectUnappliedCloudIds(snapshot, local, applyOptions)
    const deletionOps = omitFailedBlobOps(
      buildPushOps(local, snapshot, retainBefore),
      new Set()
    ).filter(isDeletionOp)
    summarizePushOps('incremental-deletes', deletionOps)
    if (deletionOps.length > 0) {
      const pushedDeletes = await pushCuratedOps({
        baseRevision: snapshot.revision,
        ops: deletionOps
      })
      logCuratedDeleteTrace('push-deletes-result', {
        ok: pushedDeletes.ok,
        baseRevision: snapshot.revision,
        nextRevision: pushedDeletes.snapshot.revision,
        stillOnCloud: deletionOps
          .filter((op) => op.type === 'deleteNode')
          .map((op) => op.uuid)
          .filter((uuid) => pushedDeletes.snapshot.nodes.some((node) => node.uuid === uuid)),
        tombstoneIds: pushedDeletes.snapshot.tombstones
          .filter((item) => item.kind === 'node')
          .map((item) => item.id)
      })
      if (pushedDeletes.ok) {
        snapshot = pushedDeletes.snapshot
      } else {
        rememberPushConflicts(deletionOps, pushedDeletes.snapshot)
        snapshot = pushedDeletes.snapshot
      }
    }
    const applied = await applyRemoteSnapshot(snapshot, local, applyOptions, applyCtx())
    await purgePendingDeletedCuratedNodeShells()
    latest = await scanCuratedLibraryForSync()
    if (applied.diskFull) return { status: 'disk_full' }
    remainingDeferred.push(...applied.deferred)
    writeCuratedLibrarySyncDeferredOps(remainingDeferred)
    const after = latest
    const failedSha = await uploadMissingBlobs(after.files)
    const retain = collectUnappliedCloudIds(snapshot, after, applyOptions)
    const ops = omitFailedBlobOps(buildPushOps(after, snapshot, retain), failedSha)
    summarizePushOps('incremental-remaining', ops)
    if (ops.length === 0) {
      persistAppliedSnapshot(snapshot, after)
      writeCuratedLibrarySyncDeferredOps(remainingDeferred)
      return { status: 'success' }
    }
    const pushed = await pushCuratedOps({ baseRevision: snapshot.revision, ops })
    if (!pushed.ok) {
      rememberPushConflicts(ops, pushed.snapshot)
      const conflictApplied = await applyRemoteSnapshot(
        pushed.snapshot,
        after,
        { ...applyOptions, preservePendingLocal: false },
        applyCtx()
      )
      writeCuratedLibrarySyncDeferredOps([...remainingDeferred, ...conflictApplied.deferred])
      await purgePendingDeletedCuratedNodeShells()
      latest = await scanCuratedLibraryForSync()
      persistAppliedSnapshot(pushed.snapshot, latest)
      return { status: 'success' }
    }
    persistAppliedSnapshot(pushed.snapshot, after)
    writeCuratedLibrarySyncDeferredOps(remainingDeferred)
    return { status: 'success' }
  } finally {
    release()
    await notifyTree()
    notifyPlaylistsChanged(collectPlaylistFileChanges(local, latest))
  }
}

const mapCuratedError = (message: string): string => {
  const upper = message.toUpperCase()
  if (upper.includes('DISK_FULL') || upper.includes('ENOSPC')) {
    return 'cloudSync.curatedLibrary.errors.diskFull'
  }
  if (upper.includes('QUOTA') || upper.includes('LIMIT')) {
    return 'cloudSync.curatedLibrary.errors.quotaExceeded'
  }
  if (upper.includes('HASH')) return 'cloudSync.curatedLibrary.errors.hashMismatch'
  if (upper.includes('CANNOTCONNECT') || upper.includes('FETCH')) {
    return 'cloudSync.errors.cannotConnect'
  }
  if (upper.includes('PROTOCOL')) return 'cloudSync.curatedLibrary.errors.protocolUnsupported'
  if (upper.includes('FIRST_SNAPSHOT_WAIT')) {
    return 'cloudSync.curatedLibrary.errors.firstSnapshotWait'
  }
  return 'cloudSync.curatedLibrary.errors.failed'
}

const isFirstSnapshotRace = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || '')
  return message.includes('FIRST_SNAPSHOT_LOCKED') || message.includes('FIRST_SNAPSHOT_EXISTS')
}

const runFirstSnapshotUpload = async (): Promise<CuratedLibrarySyncStartResult> => {
  sessionCompletedWork = true
  const local = await scanCuratedLibraryForSync()
  const failedSha = await uploadMissingBlobs(local.files)
  const session = await beginFirstCuratedSnapshot()
  const entities = buildCloudEntitiesFromLocal({
    ...local,
    files: local.files.filter((file) => !failedSha.has(file.contentSha256))
  })
  const committed = await commitFirstCuratedSnapshot({
    sessionId: session.sessionId,
    ...entities
  })
  persistAppliedSnapshot(committed, {
    files: local.files.filter((file) => !failedSha.has(file.contentSha256)),
    nodes: local.nodes
  })
  writeCuratedLibrarySyncDeferredOps([])
  return { status: 'success' }
}

export const isCuratedLibrarySyncRunning = (): boolean => running

export const cancelCuratedLibrarySync = async (): Promise<{ ok: true }> => {
  cancelRequested = true
  abortController?.abort()
  return { ok: true }
}

export const runCuratedLibrarySync = async (
  payload: CuratedLibrarySyncStartPayload = {}
): Promise<CuratedLibrarySyncStartResult> => {
  const trigger: CuratedLibrarySyncTrigger =
    payload.trigger === 'scheduled'
      ? 'scheduled'
      : payload.trigger === 'realtime'
        ? 'realtime'
        : 'manual'
  if (running) return { status: 'already_running' }
  if (!isCuratedLibrarySyncEnabled()) return { status: 'not_enabled' }
  if (
    !resolveDevCloudSyncUserKey(String(store.settingConfig?.cloudSyncUserKey || '').trim(), is.dev)
  ) {
    return { status: 'not_configured' }
  }
  if (isLibraryMergeActive() || isLibraryRelocateActive() || hasLibraryRelocateJournalSync()) {
    return { status: 'busy_library' }
  }
  const pendingJoin = getPendingCuratedLibraryJoinPrompt()
  if (!payload.joinMode && trigger !== 'realtime' && pendingJoin) {
    return pendingJoin
  }
  bindPowerMonitor()
  running = true
  cancelRequested = false
  abortController = new AbortController()
  sessionFailures = []
  sessionConflicts = []
  sessionAttemptedTransfers = false
  sessionCompletedWork = false
  try {
    dismissProgress()
    throwIfCancelled()
    let status = await fetchCuratedLibraryStatus()
    cacheQuotaFromStatus(status)
    let lastRevision = getCuratedLibrarySyncLastAppliedRevision()
    let rewound = false
    if (
      lastRevision !== null &&
      lastRevision > 0 &&
      (!status.snapshotReady || status.revision < lastRevision)
    ) {
      forgetCuratedLibrarySyncJoinState()
      cacheQuotaFromStatus(status)
      lastRevision = null
      rewound = true
    }
    if (trigger === 'realtime' && !rewound) {
      if (!status.snapshotReady || lastRevision === null) return { status: 'success' }
      return await runIncremental()
    }
    if (!status.snapshotReady && status.firstSnapshotLocked) {
      status = await waitForFirstSnapshotUnlock()
    }
    if (!status.snapshotReady) {
      if (payload.joinMode === 'cloud-wins') {
        return await runJoin('cloud-wins')
      }
      if (rewound && !payload.joinMode) {
        const local = await scanCuratedLibraryForSync()
        return {
          status: 'needs_join_choice',
          localFileCount: local.files.length,
          cloudFileCount: status.fileCount,
          cloudRevision: status.revision
        }
      }
      if (
        (rewound || lastRevision !== null) &&
        (payload.joinMode === 'local-wins' || payload.joinMode === 'merge')
      ) {
        return await runFirstSnapshotUpload()
      }
      if (lastRevision !== null) {
        return { status: 'success' }
      }
      try {
        return await runFirstSnapshotUpload()
      } catch (error) {
        if (!isFirstSnapshotRace(error)) throw error
        status = await waitForFirstSnapshotUnlock()
        if (!status.snapshotReady) {
          return await runFirstSnapshotUpload()
        }
      }
    }
    if (lastRevision === null) {
      if (!payload.joinMode) {
        const local = await scanCuratedLibraryForSync()
        return {
          status: 'needs_join_choice',
          localFileCount: local.files.length,
          cloudFileCount: status.fileCount,
          cloudRevision: status.revision
        }
      }
      if (payload.joinMode === 'local-wins' && !payload.confirmOverwriteCloud) {
        const localCount = (await scanCuratedLibraryForSync()).files.length
        if (status.fileCount > 0 && (localCount === 0 || localCount * 2 < status.fileCount)) {
          return {
            status: 'needs_overwrite_cloud_confirm',
            localFileCount: localCount,
            cloudFileCount: status.fileCount,
            cloudRevision: status.revision
          }
        }
      }
      return await runJoin(payload.joinMode)
    }
    return await runIncremental()
  } catch (error) {
    if (cancelRequested || (error as { name?: string })?.name === 'AbortError') {
      return { status: 'cancelled' }
    }
    const code = String((error as { code?: unknown })?.code || '')
    if (code === 'ENOSPC') return { status: 'disk_full' }
    const message = error instanceof Error ? error.message : String(error || 'CURATED_SYNC_FAILED')
    if (
      message.includes('fetch failed') ||
      code === 'ENOTFOUND' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT'
    ) {
      return { status: 'paused_offline' }
    }
    log.error('[curated-library-sync] failed', error)
    return { status: 'failed', message: mapCuratedError(message) }
  } finally {
    const cancelled = cancelRequested
    running = false
    abortController = null
    dismissProgress()
    if (!cancelled) {
      persistSessionReports(!sessionCompletedWork)
      emitSyncNotice()
    }
  }
}
