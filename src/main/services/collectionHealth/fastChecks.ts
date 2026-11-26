import type {
  CollectionHealthAlbumGroup,
  CollectionHealthAlbumVariant,
  CollectionHealthCheckResult,
  CollectionHealthTrackHit
} from '../../../shared/collectionHealth'
import type { LibraryTrack } from './libraryTracks'
import { ignoreKey } from './store'

export const DEFAULT_LOW_BITRATE_KBPS = 192

/** UI 动作回传的曲目引用按“歌单根 + 绝对路径”定位，避免渲染层接触缓存键。 */
export const trackRefKey = (listRoot: string, absFilePath: string): string =>
  `${listRoot.replace(/\\/g, '/').toLowerCase()}\u0000${absFilePath.replace(/\\/g, '/').toLowerCase()}`

export const trackRuntimeKey = (track: LibraryTrack): string =>
  trackRefKey(track.listRoot, track.absFilePath)

export const toTrackHit = (track: LibraryTrack): CollectionHealthTrackHit => ({
  kind: 'track',
  listRoot: track.listRoot,
  filePath: track.absFilePath,
  fileName: track.fileName,
  title: track.title || undefined,
  artist: track.artist || undefined,
  album: track.album.trim() || undefined,
  duration: track.duration || undefined,
  bitrate: track.bitrate ?? undefined,
  songListName: track.songListName,
  songListPath: track.songListPath,
  songListUuid: track.songListUuid
})

const emptyResult = (): CollectionHealthCheckResult => ({
  status: 'ready',
  hitCount: 0,
  ignoredCount: 0,
  trackHits: [],
  ignoredTracks: [],
  albumGroups: [],
  duplicateGroups: [],
  done: 0,
  total: 0
})

export function buildLowBitrateResult(
  tracks: LibraryTrack[],
  thresholdKbps: number,
  ignoredKeys: ReadonlySet<string>
): CollectionHealthCheckResult {
  const hits: LibraryTrack[] = []
  const ignoredTracks: CollectionHealthTrackHit[] = []
  for (const track of tracks) {
    if (track.bitrate === null || track.bitrate >= thresholdKbps) continue
    if (ignoredKeys.has(ignoreKey(track.listRoot, track.filePath, 'lowBitrate'))) {
      ignoredTracks.push(toTrackHit(track))
      continue
    }
    hits.push(track)
  }
  hits.sort(
    (left, right) =>
      (left.bitrate ?? 0) - (right.bitrate ?? 0) || left.fileName.localeCompare(right.fileName)
  )
  return {
    ...emptyResult(),
    hitCount: hits.length,
    ignoredCount: ignoredTracks.length,
    trackHits: hits.map(toTrackHit),
    ignoredTracks,
    done: tracks.length,
    total: tracks.length
  }
}

const normalizeAlbumKey = (album: string): string =>
  album.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

const normalizeArtistKey = (artist: string): string =>
  artist.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

type AlbumBucket = {
  groupKey: string
  tracks: LibraryTrack[]
  ignored: LibraryTrack[]
}

/**
 * 专辑标签混乱：同专辑名（忽略大小写/空白/全半角）出现多种原始写法，
 * 或同一专辑内艺人标签互相打架。只写标签的批量修复由弹窗动作执行。
 */
export function buildAlbumTagsResult(
  tracks: LibraryTrack[],
  ignoredKeys: ReadonlySet<string>
): CollectionHealthCheckResult {
  const buckets = new Map<string, AlbumBucket>()
  for (const track of tracks) {
    const groupKey = normalizeAlbumKey(track.album)
    if (!groupKey) continue
    let bucket = buckets.get(groupKey)
    if (!bucket) {
      bucket = { groupKey, tracks: [], ignored: [] }
      buckets.set(groupKey, bucket)
    }
    if (ignoredKeys.has(ignoreKey(track.listRoot, track.filePath, 'albumTags'))) {
      bucket.ignored.push(track)
    } else {
      bucket.tracks.push(track)
    }
  }

  const groups: CollectionHealthAlbumGroup[] = []
  const ignoredTracks: CollectionHealthTrackHit[] = []
  for (const bucket of buckets.values()) {
    for (const track of bucket.ignored) ignoredTracks.push(toTrackHit(track))
    if (bucket.tracks.length < 2) continue

    const variantMap = new Map<string, { tracks: LibraryTrack[]; artists: Set<string> }>()
    for (const track of bucket.tracks) {
      let variant = variantMap.get(track.album)
      if (!variant) {
        variant = { tracks: [], artists: new Set<string>() }
        variantMap.set(track.album, variant)
      }
      variant.tracks.push(track)
      const artistKey = normalizeArtistKey(track.artist)
      if (artistKey) variant.artists.add(artistKey)
    }

    const allArtists = new Set<string>()
    for (const variant of variantMap.values()) {
      for (const artist of variant.artists) allArtists.add(artist)
    }
    const artistConflict = allArtists.size > 1
    if (variantMap.size < 2 && !artistConflict) continue

    const variants: CollectionHealthAlbumVariant[] = [...variantMap.entries()]
      .map(([album, variant]) => ({
        album: album.trim(),
        count: variant.tracks.length,
        artists: [...new Set(variant.tracks.map((track) => track.artist.trim()).filter(Boolean))],
        tracks: variant.tracks.map(toTrackHit)
      }))
      .sort((left, right) => right.count - left.count || left.album.localeCompare(right.album))

    groups.push({
      kind: 'albumGroup',
      groupKey: bucket.groupKey,
      displayName: variants[0]?.album || bucket.groupKey,
      trackCount: bucket.tracks.length,
      variants,
      artistConflict
    })
  }

  groups.sort(
    (left, right) =>
      right.trackCount - left.trackCount || left.displayName.localeCompare(right.displayName)
  )
  ignoredTracks.sort((left, right) => (left.title || '').localeCompare(right.title || ''))
  return {
    ...emptyResult(),
    hitCount: groups.length,
    ignoredCount: ignoredTracks.length,
    albumGroups: groups,
    ignoredTracks,
    done: tracks.length,
    total: tracks.length
  }
}
