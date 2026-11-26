import type { ISongInfo } from '../types/globals'

export type CollectionHealthCheck = 'lowBitrate' | 'noCover' | 'albumTags' | 'duplicates'

export const COLLECTION_HEALTH_CHECKS: CollectionHealthCheck[] = [
  'lowBitrate',
  'noCover',
  'albumTags',
  'duplicates'
]

export type CollectionHealthCheckStatus = 'ready' | 'working' | 'waiting-idle' | 'error'

export type CollectionHealthTrackHit = {
  kind: 'track'
  listRoot: string
  filePath: string
  fileName: string
  title?: string
  artist?: string
  album?: string
  duration?: string
  bitrate?: number
  songListName: string
  /** 库根之下的完整层级（含歌单名），用于区分文件夹中的同名歌单。 */
  songListPath: string
  songListUuid: string
}

export type CollectionHealthAlbumVariant = {
  album: string
  count: number
  artists: string[]
  tracks: CollectionHealthTrackHit[]
}

export type CollectionHealthAlbumGroup = {
  kind: 'albumGroup'
  groupKey: string
  displayName: string
  trackCount: number
  variants: CollectionHealthAlbumVariant[]
  artistConflict: boolean
}

export type CollectionHealthDuplicateTrack = {
  listRoot: string
  filePath: string
  fileName: string
  title?: string
  artist?: string
  album?: string
  duration?: string
  bitrate?: number
  size: number
  songListName: string
  /** 库根之下的完整层级（含歌单名），用于区分文件夹中的同名歌单。 */
  songListPath: string
  songListUuid: string
}

export type CollectionHealthDuplicateGroup = {
  kind: 'duplicateGroup'
  groupId: string
  tracks: CollectionHealthDuplicateTrack[]
}

export type CollectionHealthCheckResult = {
  status: CollectionHealthCheckStatus
  hitCount: number
  ignoredCount: number
  trackHits: CollectionHealthTrackHit[]
  ignoredTracks: CollectionHealthTrackHit[]
  albumGroups: CollectionHealthAlbumGroup[]
  duplicateGroups: CollectionHealthDuplicateGroup[]
  done: number
  total: number
}

export type CollectionHealthSnapshot = {
  requestId: number
  libraryName: string
  lowBitrateThresholdKbps: number
  scannedAtMs: number
  checks: Record<CollectionHealthCheck, CollectionHealthCheckResult>
}

export type CollectionHealthStartRequest = {
  libraryName: string
  lowBitrateThresholdKbps?: number
}

export type CollectionHealthIgnoreRequest = {
  libraryName: string
  listRoot: string
  filePath: string
  check: CollectionHealthCheck
}

export type CollectionHealthTrackRef = {
  listRoot: string
  filePath: string
}

export type CollectionHealthIgnoreToggleRequest = CollectionHealthTrackRef & {
  requestId: number
  check: CollectionHealthCheck
  ignored: boolean
}

export type CollectionHealthMarkDuplicateFalseRequest = {
  requestId: number
  groupId: string
}

export type CollectionHealthRemoveDuplicatesRequest = {
  requestId: number
  keep: CollectionHealthTrackRef
  remove: CollectionHealthTrackRef[]
}

export type CollectionHealthRemoveTracksRequest = {
  requestId: number
  tracks: CollectionHealthTrackRef[]
}

export type CollectionHealthUnifyAlbumRequest = {
  requestId: number
  /** 基准专辑名，写回时使用这条原始标签值。 */
  album: string
  tracks: CollectionHealthTrackRef[]
}

export type CollectionHealthActionFailure = {
  filePath: string
  error: string
}

export type CollectionHealthMetadataUpdate = {
  song: ISongInfo
  oldFilePath?: string
}

export type CollectionHealthActionResponse = {
  snapshot: CollectionHealthSnapshot
  failed: CollectionHealthActionFailure[]
  updates?: CollectionHealthMetadataUpdate[]
}
