export type ExternalLibraryKind = 'serato' | 'traktor'

export type ExternalLibrarySourceProbe = {
  kind: ExternalLibraryKind
  available: boolean
  sourceKey: string
  sourcePath: string
  displayName: string
}

export type ExternalCueKind = 'hotCue' | 'memory' | 'loop' | 'grid'

export type ExternalLibraryCue = {
  kind: ExternalCueKind
  positionMs: number
  endPositionMs?: number
  slot?: number
  name?: string
  bpm?: number
}

export type ExternalLibraryTrack = {
  id: string
  filePath: string
  title?: string
  artist?: string
  album?: string
  genre?: string
  label?: string
  comment?: string
  key?: string
  bpm?: number
  durationSec?: number
  bitrate?: number
  sampleRate?: number
  fileFormat?: string
  year?: number
  dateAdded?: string
  missing?: boolean
  waveformOverview?: Uint8Array
  cues: ExternalLibraryCue[]
}

export type ExternalLibraryPlaylist = {
  id: string
  name: string
  parentId: string | null
  isFolder: boolean
  isSmartPlaylist?: boolean
  trackIds: string[]
  order: number
}

export type ExternalLibraryMutationResponse = {
  ok: boolean
  summary: {
    errorMessage: string
    logPath?: string
    playlistId?: number
    externalId?: string
    parentExternalId?: string
    removedCount?: number
    addedCount?: number
    skippedDuplicateCount?: number
  }
}

export type ExternalLibraryPlaylistWriteTarget = {
  mode: 'append'
  externalId: string
  playlistName?: string
}

export type ExternalLibrarySnapshot = {
  kind: ExternalLibraryKind
  rootPath: string
  libraryPath: string
  tracks: ExternalLibraryTrack[]
  playlists: ExternalLibraryPlaylist[]
  warnings: string[]
}
