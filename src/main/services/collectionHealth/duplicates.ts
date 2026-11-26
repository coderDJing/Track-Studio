import type {
  CollectionHealthCheckResult,
  CollectionHealthDuplicateGroup,
  CollectionHealthDuplicateTrack,
  CollectionHealthTrackHit
} from '../../../shared/collectionHealth'
import type { LibraryTrack } from './libraryTracks'
import { groupSameRecordings } from './fingerprint'
import { trackRuntimeKey, toTrackHit } from './fastChecks'
import { ignoreKey } from './store'

const hashString = (value: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export type DuplicateScan = {
  result: CollectionHealthCheckResult
  /** groupId -> 组内指纹，供“标记非重复”写压制记录。 */
  groupFingerprints: Map<string, string[]>
}

const toDuplicateTrack = (track: LibraryTrack): CollectionHealthDuplicateTrack => ({
  listRoot: track.listRoot,
  filePath: track.absFilePath,
  fileName: track.fileName,
  title: track.title || undefined,
  artist: track.artist || undefined,
  album: track.album.trim() || undefined,
  duration: track.duration || undefined,
  bitrate: track.bitrate ?? undefined,
  size: track.size,
  songListName: track.songListName
})

/**
 * 判重只对有新鲜指纹的曲目生效；被用户忽略的曲目保留在“已忽略”里，
 * 但不再出现在分组中。只有组内剩余曲目仍 >= 2 才作为命中。
 */
export function buildDuplicatesResult(params: {
  tracks: LibraryTrack[]
  fingerprintByRuntimeKey: ReadonlyMap<string, string>
  ignoredKeys: ReadonlySet<string>
  mutedPairs: ReadonlySet<string>
  status: CollectionHealthCheckResult['status']
  done: number
}): DuplicateScan {
  const { tracks, fingerprintByRuntimeKey, ignoredKeys, mutedPairs } = params
  const trackByRuntimeKey = new Map<string, LibraryTrack>()
  const fingerprinted: Array<{ id: string; fingerprint: string }> = []
  for (const track of tracks) {
    const runtimeKey = trackRuntimeKey(track)
    trackByRuntimeKey.set(runtimeKey, track)
    const fingerprint = fingerprintByRuntimeKey.get(runtimeKey)
    if (fingerprint) fingerprinted.push({ id: runtimeKey, fingerprint })
  }

  const rawGroups = groupSameRecordings(fingerprinted, { mutedPairs })
  const duplicateGroups: CollectionHealthDuplicateGroup[] = []
  const ignoredTracks: CollectionHealthTrackHit[] = []
  const groupFingerprints = new Map<string, string[]>()
  const fingerprintById = new Map(fingerprinted.map((item) => [item.id, item.fingerprint]))

  for (const group of rawGroups) {
    const members = group
      .map((item) => trackByRuntimeKey.get(item.id))
      .filter((track): track is LibraryTrack => Boolean(track))
    if (members.length < 2) continue
    const active: LibraryTrack[] = []
    for (const track of members) {
      if (ignoredKeys.has(ignoreKey(track.listRoot, track.filePath, 'duplicates'))) {
        ignoredTracks.push(toTrackHit(track))
      } else {
        active.push(track)
      }
    }
    if (active.length < 2) continue
    active.sort(
      (left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0) || right.size - left.size
    )
    const identityKey = active
      .map((track) => trackRuntimeKey(track))
      .sort()
      .join('\u0001')
    const groupId = `dup_${hashString(identityKey)}`
    duplicateGroups.push({
      kind: 'duplicateGroup',
      groupId,
      tracks: active.map(toDuplicateTrack)
    })
    const activeFingerprints = active
      .map((track) => fingerprintById.get(trackRuntimeKey(track)))
      .filter((fingerprint): fingerprint is string => Boolean(fingerprint))
    groupFingerprints.set(groupId, activeFingerprints)
  }

  duplicateGroups.sort(
    (left, right) =>
      right.tracks.length - left.tracks.length || left.groupId.localeCompare(right.groupId)
  )
  ignoredTracks.sort((left, right) => (left.title || '').localeCompare(right.title || ''))
  return {
    groupFingerprints,
    result: {
      status: params.status,
      hitCount: duplicateGroups.length,
      ignoredCount: ignoredTracks.length,
      trackHits: [],
      ignoredTracks,
      albumGroups: [],
      duplicateGroups,
      done: params.done,
      total: tracks.length
    }
  }
}
