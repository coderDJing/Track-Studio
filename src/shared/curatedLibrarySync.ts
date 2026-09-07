export const CURATED_LIBRARY_SYNC_PROTOCOL_VERSION = 1

export const CURATED_LIBRARY_SYNC_PROGRESS_ID = 'curated-library-sync'

export const CURATED_LIBRARY_SYNC_CANCEL_CHANNEL = 'curatedLibrarySync/cancel'

/** 精选库同步改了哪些歌单文件。渲染进程按路径就地增删，不要整表重扫。 */
export const CURATED_LIBRARY_SYNC_PLAYLISTS_CHANGED_CHANNEL = 'curatedLibrarySync/playlistsChanged'

export type CuratedLibrarySyncListFileChange = {
  listUUID: string
  absPath: string
  libraryPath: string
  trackNumber: number | null
  addedAtMs: number | null
}

export type CuratedLibrarySyncPlaylistsChangedPayload = {
  uuids: string[]
  removed: CuratedLibrarySyncListFileChange[]
  added: CuratedLibrarySyncListFileChange[]
  updated: CuratedLibrarySyncListFileChange[]
}

export const CURATED_LIBRARY_SYNC_BLOB_CHUNK_SIZE = 8 * 1024 * 1024

/** 云端快照里代表「精选库根」的父节点。各机精选库 library 节点 UUID 不同，不能直接当 parentUuid。 */
export const CURATED_LIBRARY_SYNC_ROOT_PARENT_UUID = '00000000-0000-4000-8000-000000000000'

export type CuratedLibrarySyncJoinMode = 'merge' | 'cloud-wins' | 'local-wins'

export type CuratedLibrarySyncTrigger = 'manual' | 'scheduled' | 'realtime'

export type CuratedLibrarySyncLocation = 'curated' | 'recycle' | 'custody' | 'missing'

export type CuratedLibrarySyncNodeType = 'dir' | 'songList'

export type CuratedLibrarySyncCloudNode = {
  uuid: string
  parentUuid: string
  name: string
  nodeType: CuratedLibrarySyncNodeType
  sortOrder: number | null
  updatedAtMs: number
  revision?: number
}

export type CuratedLibrarySyncCloudFile = {
  fileId: string
  parentUuid: string
  fileName: string
  sha256: string
  size: number
  trackNumber: number | null
  addedAtMs: number | null
  updatedAtMs: number
  revision?: number
}

export type CuratedLibrarySyncTombstone = {
  kind: 'file' | 'node'
  id: string
  revision: number
  deletedAtMs: number
}

export type CuratedLibrarySyncSnapshot = {
  protocolVersion: number
  revision: number
  snapshotReady: boolean
  full?: boolean
  nodes: CuratedLibrarySyncCloudNode[]
  files: CuratedLibrarySyncCloudFile[]
  tombstones: CuratedLibrarySyncTombstone[]
}

export type CuratedLibrarySyncOp =
  | { type: 'upsertNode'; node: CuratedLibrarySyncCloudNode }
  | { type: 'deleteNode'; uuid: string; updatedAtMs: number }
  | { type: 'upsertFile'; file: CuratedLibrarySyncCloudFile }
  | { type: 'deleteFile'; fileId: string; updatedAtMs: number }
  | { type: 'undeleteFile'; file: CuratedLibrarySyncCloudFile }

export type CuratedLibrarySyncConflictKind =
  | 'file-move-lost'
  | 'file-rename-lost'
  | 'file-content-lost'
  | 'file-delete-lost'
  | 'file-undelete-lost'
  | 'file-order-lost'
  | 'node-change-lost'
  | 'node-delete-lost'

export type CuratedLibrarySyncConflictItem = {
  kind: CuratedLibrarySyncConflictKind
  name: string
  otherName?: string
}

export type CuratedLibrarySyncFailureItem = {
  direction: 'upload' | 'download'
  name: string
  errorKey: string
  atMs: number
  sha256?: string
  fileId?: string
}

export type CuratedLibrarySyncActivityPhase =
  | 'idle'
  | 'scanning'
  | 'downloading'
  | 'uploading'
  | 'waiting-first-snapshot'
  | 'applying'

export type CuratedLibrarySyncActivity = {
  running: boolean
  phase: CuratedLibrarySyncActivityPhase
  now: number
  total: number
}

export type CuratedLibrarySyncOverview = {
  liveConnected: boolean
  snapshotReady: boolean
  revision: number
  fileCount: number
  quotaUsedBytes: number
  quotaBytes: number
  conflicts: CuratedLibrarySyncConflictItem[]
  failures: CuratedLibrarySyncFailureItem[]
  activity: CuratedLibrarySyncActivity
}

export type CuratedLibrarySyncNotice = {
  kind: 'conflicts' | 'failures'
  conflictCount: number
  failureCount: number
}

export type CuratedLibrarySyncStartPayload = {
  trigger?: CuratedLibrarySyncTrigger
  joinMode?: CuratedLibrarySyncJoinMode
  confirmOverwriteCloud?: boolean
}

export type CuratedLibrarySyncStartResult =
  | { status: 'success' }
  | { status: 'already_running' }
  | { status: 'cancelled' }
  | { status: 'not_enabled' }
  | { status: 'not_configured' }
  | { status: 'busy_library' }
  | { status: 'disk_full' }
  | { status: 'paused_offline' }
  | { status: 'failed'; message: string }
  | {
      status: 'needs_join_choice'
      localFileCount: number
      cloudFileCount: number
      cloudRevision: number
    }
  | {
      status: 'needs_overwrite_cloud_confirm'
      localFileCount: number
      cloudFileCount: number
      cloudRevision: number
    }
