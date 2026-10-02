import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  createDjLibraryCollectionNode,
  EXTERNAL_COLLECTION_PLAYLIST_ID
} from '../../../shared/djLibraryCollection'
import type {
  ExternalLibraryKind,
  ExternalLibraryPlaylist,
  ExternalLibrarySnapshot,
  ExternalLibraryTrack
} from '../../../shared/externalLibrary'
import type {
  IPioneerPlaylistTrack,
  IPioneerPlaylistTreeNode,
  ISongHotCue,
  ISongMemoryCue
} from '../../../types/globals'
import {
  parseSeratoWaveformOverview,
  type SeratoWaveformOverviewData
} from '../../../shared/seratoWaveformOverview'
import {
  createSongBeatGridMapV2FromClips,
  type SongBeatGridClipV2
} from '../../../shared/songBeatGridMapV2'

const ALL_TRACKS_PLAYLIST_ID = EXTERNAL_COLLECTION_PLAYLIST_ID
export const getPlaylistNumericId = (playlist: ExternalLibraryPlaylist) =>
  2 + Number.parseInt(createHash('sha256').update(playlist.id).digest('hex').slice(0, 13), 16)

const formatDuration = (durationSec: number | undefined) => {
  const total = Math.max(0, Math.round(Number(durationSec) || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const buildPlaylistTree = (snapshot: ExternalLibrarySnapshot): IPioneerPlaylistTreeNode[] => {
  const nodesByExternalId = new Map<string, IPioneerPlaylistTreeNode>()
  const roots: IPioneerPlaylistTreeNode[] = [createDjLibraryCollectionNode(ALL_TRACKS_PLAYLIST_ID)]

  for (const playlist of snapshot.playlists) {
    // Traktor Smartlists persist dynamic rules, which the browser does not evaluate yet.
    if (snapshot.kind === 'traktor' && playlist.isSmartPlaylist) continue
    nodesByExternalId.set(playlist.id, {
      id: getPlaylistNumericId(playlist),
      externalId: playlist.id,
      parentId: 0,
      name: playlist.name,
      isFolder: playlist.isFolder,
      isSmartPlaylist: playlist.isSmartPlaylist,
      order: playlist.order + 1,
      sortOrder: playlist.order + 1,
      children: []
    })
  }

  for (const playlist of snapshot.playlists) {
    const node = nodesByExternalId.get(playlist.id)
    if (!node) continue
    const parent = playlist.parentId ? nodesByExternalId.get(playlist.parentId) : undefined
    if (parent?.isFolder) {
      node.parentId = parent.id
      parent.children = [...(parent.children || []), node]
    } else {
      roots.push(node)
    }
  }

  return roots
}

const buildHotCues = (track: ExternalLibraryTrack): ISongHotCue[] =>
  track.cues.flatMap((cue) => {
    if (cue.kind !== 'hotCue' && !(cue.kind === 'loop' && cue.slot !== undefined)) return []
    return [
      {
        slot: Math.max(0, Number(cue.slot) || 0),
        sec: Math.max(0, cue.positionMs / 1000),
        label: cue.name,
        isLoop: cue.kind === 'loop',
        loopEndSec:
          cue.kind === 'loop' && cue.endPositionMs !== undefined
            ? Math.max(0, cue.endPositionMs / 1000)
            : undefined,
        source: 'external-library'
      }
    ]
  })

const buildMemoryCues = (track: ExternalLibraryTrack): ISongMemoryCue[] =>
  track.cues.flatMap((cue, index) => {
    if (cue.kind !== 'memory' && !(cue.kind === 'loop' && cue.slot === undefined)) return []
    return [
      {
        sec: Math.max(0, cue.positionMs / 1000),
        order: index,
        comment: cue.name,
        isLoop: cue.kind === 'loop',
        loopEndSec:
          cue.kind === 'loop' && cue.endPositionMs !== undefined
            ? Math.max(0, cue.endPositionMs / 1000)
            : undefined,
        source: 'external-library'
      }
    ]
  })

const buildNativeBeatGridMap = (track: ExternalLibraryTrack, kind: ExternalLibraryKind) => {
  const markers = track.cues
    .filter((cue) => cue.kind === 'grid' && Number.isFinite(cue.positionMs) && cue.positionMs >= 0)
    .sort((left, right) => left.positionMs - right.positionMs)
  const clips: SongBeatGridClipV2[] = []
  for (const marker of markers) {
    const bpm = Number(marker.bpm) > 0 ? Number(marker.bpm) : Number(track.bpm)
    if (!Number.isFinite(bpm) || bpm <= 0) continue
    const anchorSec = marker.positionMs / 1000
    if (clips.length && anchorSec <= clips[clips.length - 1].startSec) continue
    clips.push({
      startSec: clips.length ? anchorSec : 0,
      anchorSec,
      bpm,
      downbeatBeatOffset: marker.downbeatBeatOffset ?? 0
    })
  }
  return clips.length
    ? createSongBeatGridMapV2FromClips(clips, kind, { allowSingleClip: true })
    : null
}

const toBrowserTrack = (
  track: ExternalLibraryTrack,
  kind: ExternalLibraryKind,
  playlistId: number,
  playlistName: string,
  entryIndex: number,
  trackIndex: number
): IPioneerPlaylistTrack => {
  const extension = track.fileFormat || path.extname(track.filePath).replace(/^\./, '')
  const beatGridMap = buildNativeBeatGridMap(track, kind)
  return {
    rowKey: `${track.id}:${playlistId}:${entryIndex}`,
    playlistId,
    playlistName,
    trackId: trackIndex + 1,
    entryIndex,
    title: track.title || path.basename(track.filePath, path.extname(track.filePath)),
    artist: track.artist || '',
    album: track.album || '',
    label: track.label || '',
    genre: track.genre || '',
    filePath: track.filePath,
    fileName: path.basename(track.filePath),
    fileFormat: extension.toUpperCase(),
    container: extension.toUpperCase(),
    duration: formatDuration(track.durationSec),
    durationSec: Math.max(0, Number(track.durationSec) || 0),
    bpm: beatGridMap?.clips[0]?.bpm ?? track.bpm,
    beatGridMap: beatGridMap ?? undefined,
    key: track.key,
    bitrate: track.bitrate,
    sampleRate: track.sampleRate,
    timeBasisOffsetMs: track.timeBasisOffsetMs,
    year: track.year,
    comment: track.comment,
    dateAdded: track.dateAdded,
    hotCues: buildHotCues(track),
    memoryCues: buildMemoryCues(track),
    fileMissing: track.missing === true
  }
}

export const buildExternalLibraryBrowserTree = (snapshot: ExternalLibrarySnapshot) => ({
  treeNodes: buildPlaylistTree(snapshot),
  sourceName: snapshot.kind === 'serato' ? 'Serato 库' : 'Traktor 库',
  warnings: snapshot.warnings
})

export const buildExternalLibraryBrowserTracks = (
  snapshot: ExternalLibrarySnapshot,
  playlistId: number
) => {
  const trackById = new Map(snapshot.tracks.map((track, index) => [track.id, { track, index }]))
  const playlist = snapshot.playlists.find(
    (item) => getPlaylistNumericId(item) === Number(playlistId)
  )
  const selectedTrackIds =
    Number(playlistId) === ALL_TRACKS_PLAYLIST_ID
      ? snapshot.tracks.map((track) => track.id)
      : playlist?.trackIds || []
  const playlistName =
    Number(playlistId) === ALL_TRACKS_PLAYLIST_ID ? '全部曲目' : playlist?.name || ''

  return {
    tracks: selectedTrackIds.flatMap((trackId, entryIndex) => {
      const matched = trackById.get(trackId)
      return matched
        ? [
            toBrowserTrack(
              matched.track,
              snapshot.kind,
              Number(playlistId),
              playlistName,
              entryIndex,
              matched.index
            )
          ]
        : []
    })
  }
}

export const buildSeratoWaveformOverviews = (
  snapshot: ExternalLibrarySnapshot,
  filePaths: string[]
): Array<{ filePath: string; data: SeratoWaveformOverviewData | null }> => {
  if (snapshot.kind !== 'serato') return filePaths.map((filePath) => ({ filePath, data: null }))
  const trackByPath = new Map(
    snapshot.tracks.map((track) => [path.normalize(track.filePath).toLowerCase(), track])
  )
  return filePaths.map((filePath) => {
    const track = trackByPath.get(path.normalize(filePath).toLowerCase())
    return {
      filePath,
      data: parseSeratoWaveformOverview(track?.waveformOverview)
    }
  })
}

export const isExternalLibraryKind = (value: unknown): value is ExternalLibraryKind =>
  value === 'serato' || value === 'traktor'
