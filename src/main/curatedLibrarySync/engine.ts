import { powerMonitor } from 'electron'
import store from '../store'
import { log } from '../log'
import mainWindow from '../window/mainWindow'
import { isLibraryMergeActive } from '../services/libraryMerge'
import { isLibraryRelocateActive, hasLibraryRelocateJournalSync } from '../services/libraryRelocate'
import { beginLibraryTreeWatcherBulkOperation } from '../libraryTreeWatcher'
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
  forgetCuratedLibrarySyncJoinState,
  readCuratedLibrarySyncPendingJoinMode,
  writeCuratedLibrarySyncPendingJoinMode
} from '../librarySettingsDb'
import {
  clearPendingCuratedLibraryJoinPrompt,
  getPendingCuratedLibraryJoinPrompt
} from './joinPrompt'
import {
  CURATED_LIBRARY_SYNC_PROGRESS_ID,
  type CuratedLibrarySyncActivity,
  type CuratedLibrarySyncActivityPhase,
  type CuratedLibrarySyncStatus,
  type CuratedLibrarySyncConflictItem,
  type CuratedLibrarySyncFailureItem,
  type CuratedLibrarySyncJoinMode,
  type CuratedLibrarySyncOp,
  type CuratedLibrarySyncSnapshot,
  type CuratedLibrarySyncStartPayload,
  type CuratedLibrarySyncStartResult,
  type CuratedLibrarySyncTrigger
} from '../../shared/curatedLibrarySync'
import {
  beginFirstCuratedSnapshot,
  commitFirstCuratedSnapshot,
  fetchCuratedLibraryStatus,
  pullCuratedSnapshot,
  pushCuratedOps,
  replaceCuratedSnapshot
} from './apiClient'
import { uploadBlobWithResume } from './blobTransfer'
import { collectDroppedOps } from './conflictDiff'
import { isFirstSnapshotRace, mapCuratedSyncError, mapTransferErrorKey } from './reports'
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
import { finishApplyUi, notifyTree, queueImportedApplyUi, resetApplyUiFlush } from './applyUiNotify'
import { suppressCuratedLibraryTreeSync } from './treeSyncGuard'
import {
  countCuratedLibraryAudioFiles,
  scanCuratedLibraryForSync,
  type CuratedLocalFile,
  type CuratedLocalNode
} from './scan'
import { findCuratedLibraryNode, sameCloudParentUuid } from './paths'
import {
  listPendingDeletedCuratedNodeIds,
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
let sessionCompletedWork = false
const idleActivity = (): CuratedLibrarySyncActivity => ({
  running: false,
  phase: 'idle',
  now: 0,
  total: 0
})
const idleStatus = (): CuratedLibrarySyncStatus => ({
  ...idleActivity(),
  trigger: null,
  terminalStatus: 'idle',
  updatedAtMs: Date.now()
})
let sessionActivity: CuratedLibrarySyncActivity = idleActivity()
let sessionStatus: CuratedLibrarySyncStatus = idleStatus()

const emitSyncStatus = (): void => {
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  win.webContents.send('curatedLibrarySync/status', sessionStatus)
}

const setStatus = (patch: Partial<CuratedLibrarySyncStatus>): void => {
  sessionStatus = {
    ...sessionStatus,
    ...patch,
    updatedAtMs: Math.max(Date.now(), sessionStatus.updatedAtMs + 1)
  }
  emitSyncStatus()
}

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

const setActivity = (phase: CuratedLibrarySyncActivityPhase, now = 0, total = 0): void => {
  sessionActivity = {
    running: phase !== 'idle',
    phase,
    now,
    total
  }
  setStatus({ ...sessionActivity, terminalStatus: 'idle', message: undefined })
}

const clearActivity = (): void => {
  sessionActivity = idleActivity()
}

export const getCuratedLibrarySyncActivity = (): CuratedLibrarySyncActivity => ({
  ...sessionActivity,
  running: running || sessionActivity.running
})

export const getCuratedLibrarySyncStatus = (): CuratedLibrarySyncStatus => sessionStatus

export const completeCuratedLibrarySyncStatus = (result: CuratedLibrarySyncStartResult): void => {
  if (result.status === 'already_running' || result.status === 'needs_join_choice') return
  if (result.status === 'needs_overwrite_cloud_confirm') return
  const terminalStatus =
    result.status === 'success'
      ? result.changed === false
        ? 'up_to_date'
        : 'success'
      : result.status === 'cancelled'
        ? 'cancelled'
        : 'failed'
  setStatus({
    ...idleActivity(),
    terminalStatus,
    message: result.status === 'failed' ? result.message : result.status
  })
}

const scanLocalForSync = () => scanCuratedLibraryForSync()

const rescanAfterApply = async () => {
  setActivity('applying')
  return await scanLocalForSync()
}

const buildJoinChoice = async (status: {
  fileCount: number
  revision: number
}): Promise<CuratedLibrarySyncStartResult> => ({
  status: 'needs_join_choice',
  localFileCount: await countCuratedLibraryAudioFiles(),
  cloudFileCount: status.fileCount,
  cloudRevision: status.revision
})

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

const normalizeBlobSha = (value: string | undefined): string =>
  String(value || '')
    .trim()
    .toLowerCase()

const cloudBlobShaSet = (snapshot: { files: Array<{ sha256: string }> }): Set<string> => {
  const shas = new Set<string>()
  for (const file of snapshot.files) {
    const sha = normalizeBlobSha(file.sha256)
    if (sha) shas.add(sha)
  }
  return shas
}

const uploadMissingBlobs = async (
  files: CuratedLocalFile[],
  alreadyOnCloud?: Set<string>
): Promise<Set<string>> => {
  const pendingBySha = new Map<string, CuratedLocalFile>()
  for (const file of files) {
    const sha = normalizeBlobSha(file.contentSha256)
    if (!sha || alreadyOnCloud?.has(sha) || pendingBySha.has(sha)) continue
    pendingBySha.set(sha, file)
  }
  const pending = [...pendingBySha.values()]
  const failed = new Set<string>()
  const uniqueTotal = pending.length
  if (uniqueTotal === 0) return failed
  setActivity('uploading', 0, uniqueTotal)
  let index = 0
  for (const file of pending) {
    throwIfCancelled()
    await waitIfSuspended()
    index += 1
    setActivity('uploading', index, uniqueTotal)
    try {
      abortController = new AbortController()
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
      if (
        !cancelRequested &&
        abortController?.signal.aborted === true &&
        (error as { name?: string })?.name === 'AbortError'
      ) {
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
      continue
    }
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
  writeCuratedLibrarySyncPendingJoinMode(null)
}

const loadCachedSnapshot = () => parseCuratedLibrarySnapshot(readCuratedLibrarySyncLastSnapshot())

const pullMergedSnapshot = async (sinceRevision?: number | null) => {
  const cached = loadCachedSnapshot()
  const useDiff = cached != null && Number(sinceRevision) > 0
  const pulled = await pullCuratedSnapshot(useDiff ? sinceRevision : null, abortController?.signal)
  if (pulled.full === false && !cached) {
    const full = await pullCuratedSnapshot(null, abortController?.signal)
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
    const status = await fetchCuratedLibraryStatus(abortController?.signal)
    if (status.snapshotReady || !status.firstSnapshotLocked) return status
    setActivity('waiting-first-snapshot')
    if (Date.now() >= deadline) {
      throw new Error('CURATED_SYNC_FIRST_SNAPSHOT_WAIT_TIMEOUT')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 3000))
  }
}

const applyCtx = (): ApplyRemoteContext => ({
  signal: abortController?.signal || new AbortController().signal,
  onTransferFailure: (payload) => {
    recordFailure({
      direction: payload.direction,
      name: payload.name,
      sha256: payload.sha256,
      fileId: payload.fileId,
      errorKey: mapTransferErrorKey(payload.error)
    })
  },
  onFileProgress: (now, total) => {
    if (total > 0) setActivity('downloading', now, total)
  },
  onNodesReady: () => notifyTree(),
  onImported: queueImportedApplyUi
})

const runJoin = async (
  mode: CuratedLibrarySyncJoinMode
): Promise<CuratedLibrarySyncStartResult> => {
  writeCuratedLibrarySyncPendingJoinMode(mode)
  sessionCompletedWork = true
  setActivity('applying')
  const local = await scanLocalForSync()
  const snapshot = await pullMergedSnapshot(null)
  if (mode === 'local-wins') {
    const failedSha = await uploadMissingBlobs(local.files, cloudBlobShaSet(snapshot))
    if (failedSha.size > 0) {
      return { status: 'failed', message: 'cloudSync.curatedLibrary.errors.uploadIncomplete' }
    }
    setActivity('applying')
    const entities = buildCloudEntitiesFromLocal({
      ...local,
      files: local.files.filter((file) => !failedSha.has(file.contentSha256))
    })
    const next = await replaceCuratedSnapshot({ ...entities, signal: abortController?.signal })
    persistAppliedSnapshot(next, {
      files: local.files.filter((file) => !failedSha.has(file.contentSha256)),
      nodes: local.nodes
    })
    writeCuratedLibrarySyncDeferredOps([])
    return { status: 'success' }
  }
  if (mode === 'cloud-wins') {
    clearPendingCuratedLibraryJoinPrompt()
  }
  const extras = mode === 'cloud-wins' ? 'delete' : 'keep'
  const release = beginLibraryTreeWatcherBulkOperation()
  let latest = local
  try {
    setActivity('applying')
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
    latest = await rescanAfterApply()
    if (applied.diskFull) return { status: 'disk_full' }
    writeCuratedLibrarySyncDeferredOps(applied.deferred)
    const after = latest
    if (mode === 'merge') {
      const failedSha = await uploadMissingBlobs(after.files, cloudBlobShaSet(snapshot))
      const retain = collectUnappliedCloudIds(snapshot, after, {
        extras: 'keep',
        adoptIds: true,
        applyTombstones: false,
        knownFileIds: null,
        knownNodeIds: null
      })
      const ops = omitFailedBlobOps(buildPushOps(after, snapshot, retain), failedSha)
      if (ops.length > 0) {
        setActivity('applying')
        const pushed = await pushCuratedOps({
          baseRevision: snapshot.revision,
          ops,
          signal: abortController?.signal
        })
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
          latest = await rescanAfterApply()
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
    suppressCuratedLibraryTreeSync()
    release()
    await finishApplyUi(local, latest)
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

const runIncremental = async (): Promise<CuratedLibrarySyncStartResult> => {
  sessionCompletedWork = true
  setActivity('applying')
  const local = await scanLocalForSync()
  const lastAppliedRevision = getCuratedLibrarySyncLastAppliedRevision()
  let snapshot = await pullMergedSnapshot(lastAppliedRevision)
  let changed = lastAppliedRevision === null || snapshot.revision !== lastAppliedRevision
  // reset/回滚可能恰好发生在 status 与 pull 之间；不能把本机旧文件再推回刚清空的云端。
  if (lastAppliedRevision != null && snapshot.revision < lastAppliedRevision) {
    return await runJoin('cloud-wins')
  }
  const release = beginLibraryTreeWatcherBulkOperation()
  let latest = local
  try {
    setActivity('applying')
    const applyCloudAuthoritativeSnapshot = async (
      winning: CuratedLibrarySyncSnapshot,
      currentLocal: { files: CuratedLocalFile[]; nodes: CuratedLocalNode[] }
    ): Promise<CuratedLibrarySyncStartResult> => {
      const applied = await applyRemoteSnapshot(
        winning,
        currentLocal,
        {
          extras: 'delete',
          adoptIds: true,
          applyTombstones: true,
          knownFileIds: null,
          knownNodeIds: null,
          preservePendingLocal: false
        },
        applyCtx()
      )
      await purgePendingDeletedCuratedNodeShells()
      latest = await rescanAfterApply()
      if (applied.diskFull) return { status: 'disk_full' }
      writeCuratedLibrarySyncDeferredOps(applied.deferred)
      persistAppliedSnapshot(winning, latest)
      return { status: 'success', changed: true }
    }
    const deferred = toDeferred(readCuratedLibrarySyncDeferredOps())
    if (deferred.length > 0) changed = true
    const applyOptions = incrementalApplyOptions()
    const remainingDeferred = await retryDeferredRemoteOps(deferred, snapshot, applyCtx())
    const retainBefore = collectUnappliedCloudIds(snapshot, local, applyOptions)
    const initialOps = omitFailedBlobOps(buildPushOps(local, snapshot, retainBefore), new Set())
    if (
      !changed &&
      deferred.length === 0 &&
      remainingDeferred.length === 0 &&
      initialOps.length === 0
    ) {
      return { status: 'success', changed: false }
    }
    const deletionOps = initialOps.filter(isDeletionOp)
    if (deletionOps.length > 0) {
      changed = true
      const pushedDeletes = await pushCuratedOps({
        baseRevision: snapshot.revision,
        ops: deletionOps,
        signal: abortController?.signal
      })
      if (pushedDeletes.ok) {
        snapshot = pushedDeletes.snapshot
      } else {
        if (pushedDeletes.snapshot.revision < snapshot.revision) {
          forgetCuratedLibrarySyncJoinState()
          return await applyCloudAuthoritativeSnapshot(pushedDeletes.snapshot, local)
        }
        rememberPushConflicts(deletionOps, pushedDeletes.snapshot)
        snapshot = pushedDeletes.snapshot
      }
    }
    const applied = await applyRemoteSnapshot(snapshot, local, applyOptions, applyCtx())
    await purgePendingDeletedCuratedNodeShells()
    latest = await rescanAfterApply()
    if (applied.diskFull) return { status: 'disk_full' }
    remainingDeferred.push(...applied.deferred)
    writeCuratedLibrarySyncDeferredOps(remainingDeferred)
    const after = latest
    const failedSha = await uploadMissingBlobs(after.files, cloudBlobShaSet(snapshot))
    const retain = collectUnappliedCloudIds(snapshot, after, applyOptions)
    const ops = omitFailedBlobOps(buildPushOps(after, snapshot, retain), failedSha)
    if (ops.length === 0) {
      persistAppliedSnapshot(snapshot, after)
      writeCuratedLibrarySyncDeferredOps(remainingDeferred)
      return { status: 'success', changed }
    }
    changed = true
    setActivity('applying')
    const pushed = await pushCuratedOps({
      baseRevision: snapshot.revision,
      ops,
      signal: abortController?.signal
    })
    if (!pushed.ok) {
      if (pushed.snapshot.revision < snapshot.revision) {
        forgetCuratedLibrarySyncJoinState()
        return await applyCloudAuthoritativeSnapshot(pushed.snapshot, after)
      }
      rememberPushConflicts(ops, pushed.snapshot)
      const conflictApplied = await applyRemoteSnapshot(
        pushed.snapshot,
        after,
        { ...applyOptions, preservePendingLocal: false },
        applyCtx()
      )
      writeCuratedLibrarySyncDeferredOps([...remainingDeferred, ...conflictApplied.deferred])
      await purgePendingDeletedCuratedNodeShells()
      latest = await rescanAfterApply()
      persistAppliedSnapshot(pushed.snapshot, latest)
      return { status: 'success', changed }
    }
    persistAppliedSnapshot(pushed.snapshot, after)
    writeCuratedLibrarySyncDeferredOps(remainingDeferred)
    return { status: 'success', changed }
  } finally {
    suppressCuratedLibraryTreeSync()
    release()
    await finishApplyUi(local, latest)
  }
}

const runFirstSnapshotUpload = async (): Promise<CuratedLibrarySyncStartResult> => {
  sessionCompletedWork = true
  setActivity('applying')
  const local = await scanLocalForSync()
  const failedSha = await uploadMissingBlobs(local.files)
  if (failedSha.size > 0) {
    return { status: 'failed', message: 'cloudSync.curatedLibrary.errors.uploadIncomplete' }
  }
  setActivity('applying')
  const session = await beginFirstCuratedSnapshot(abortController?.signal)
  const entities = buildCloudEntitiesFromLocal({
    ...local,
    files: local.files.filter((file) => !failedSha.has(file.contentSha256))
  })
  const committed = await commitFirstCuratedSnapshot({
    sessionId: session.sessionId,
    ...entities,
    signal: abortController?.signal
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
  const waiters = resumeWaiters
  resumeWaiters = []
  for (const waiter of waiters) waiter()
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
  if (!isCuratedLibrarySyncEnabled() && !payload.allowWhenDisabled) {
    return { status: 'not_enabled' }
  }
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
  setStatus({
    running: true,
    trigger,
    phase: 'scanning',
    now: 0,
    total: 0,
    terminalStatus: 'idle',
    message: undefined
  })
  abortController = new AbortController()
  sessionFailures = []
  sessionConflicts = []
  sessionCompletedWork = false
  resetApplyUiFlush()
  try {
    dismissProgress()
    throwIfCancelled()
    let status = await fetchCuratedLibraryStatus(abortController?.signal)
    cacheQuotaFromStatus(status)
    let lastRevision = getCuratedLibrarySyncLastAppliedRevision()
    let rewound = false
    if (lastRevision !== null && (!status.snapshotReady || status.revision < lastRevision)) {
      forgetCuratedLibrarySyncJoinState()
      cacheQuotaFromStatus(status)
      lastRevision = null
      rewound = true
    }
    if (trigger === 'realtime' && !rewound) {
      if (!status.snapshotReady || lastRevision === null) {
        return { status: 'success', changed: false }
      }
      return await runIncremental()
    }
    if (!status.snapshotReady) {
      if (payload.joinMode === 'cloud-wins') {
        return await runJoin('cloud-wins')
      }
      if (rewound && !payload.joinMode) {
        return await buildJoinChoice(status)
      }
      if (
        (rewound || lastRevision !== null) &&
        (payload.joinMode === 'local-wins' || payload.joinMode === 'merge')
      ) {
        return await runFirstSnapshotUpload()
      }
      if (lastRevision !== null) {
        return { status: 'success', changed: false }
      }
      // 空云端第一次：静默上传本机精选库，不弹对齐。
      try {
        if (status.firstSnapshotLocked) {
          status = await waitForFirstSnapshotUnlock()
          if (status.snapshotReady) {
            return await buildJoinChoice(status)
          }
        }
        return await runFirstSnapshotUpload()
      } catch (error) {
        if (!isFirstSnapshotRace(error)) throw error
        status = await waitForFirstSnapshotUnlock()
        if (!status.snapshotReady) {
          return await runFirstSnapshotUpload()
        }
        return await buildJoinChoice(status)
      }
    }
    // 显式 cloud-wins（清空云端 / 对端看到 revision 回绕）必须按空云端删本机。
    // lastRevision 为 0 时也会落到这里；不能再走增量，否则会把本机库 upsert 回刚清空的云端。
    if (payload.joinMode === 'cloud-wins') {
      return await runJoin('cloud-wins')
    }
    if (lastRevision === null) {
      if (!payload.joinMode) {
        if (rewound && status.snapshotReady) {
          return await runJoin('cloud-wins')
        }
        const pendingJoinMode = readCuratedLibrarySyncPendingJoinMode()
        if (pendingJoinMode) {
          return await runJoin(pendingJoinMode)
        }
        return await buildJoinChoice(status)
      }
      if (payload.joinMode === 'local-wins' && !payload.confirmOverwriteCloud) {
        const localCount = await countCuratedLibraryAudioFiles()
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
      setStatus({ running: false, phase: 'idle', now: 0, total: 0, terminalStatus: 'cancelled' })
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
    return { status: 'failed', message: mapCuratedSyncError(message) }
  } finally {
    const cancelled = cancelRequested
    running = false
    abortController = null
    suppressCuratedLibraryTreeSync()
    clearActivity()
    dismissProgress()
    if (!cancelled) {
      persistSessionReports(!sessionCompletedWork)
      emitSyncNotice()
    }
  }
}
