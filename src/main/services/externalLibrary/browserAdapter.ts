import path from 'node:path'
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

const ALL_TRACKS_PLAYLIST_ID = 1
const PLAYLIST_ID_OFFSET = 2

export const getPlaylistNumericId = (playlist: ExternalLibraryPlaylist) =>
  PLAYLIST_ID_OFFSET + Math.max(0, Number(playlist.order) || 0)

const formatDuration = (durationSec: number | undefined) => {
  const total = Math.max(0, Math.round(Number(durationSec) || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const buildPlaylistTree = (snapshot: ExternalLibrarySnapshot): IPioneerPlaylistTreeNode[] => {
  const nodesByExternalId = new Map<string, IPioneerPlaylistTreeNode>()
  const roots: IPioneerPlaylistTreeNode[] = [
    {
      id: ALL_TRACKS_PLAYLIST_ID,
      parentId: 0,
      name: '全部曲目',
      isFolder: false,
      order: 0,
      sortOrder: 0,
      children: []
    }
  ]

  for (const playlist of snapshot.playlists) {
    nodesByExternalId.set(playlist.id, {
      id: getPlaylistNumericId(playlist),
      externalId: playlist.id,
      parentId: 0,
      name: playlist.name,
      isFolder: playlist.isFolder,
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

const toBrowserTrack = (
  track: ExternalLibraryTrack,
  playlistId: number,
  playlistName: string,
  entryIndex: number,
  trackIndex: number
): IPioneerPlaylistTrack => {
  const extension = track.fileFormat || path.extname(track.filePath).replace(/^\./, '')
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
    bpm: track.bpm,
    key: track.key,
    bitrate: track.bitrate,
    sampleRate: track.sampleRate,
    year: track.year,
    comment: track.comment,
    dateAdded: track.dateAdded,
    rekordboxGridEntries: track.cues
      .filter((cue) => cue.kind === 'grid' && Number.isFinite(cue.bpm))
      .map((cue, index) => ({
        timeMs: Math.max(0, cue.positionMs),
        bpm: Number(cue.bpm),
        beatNumber: (index % 4) + 1
      })),
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
