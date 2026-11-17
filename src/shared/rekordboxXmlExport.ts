import type { ISongHotCue, ISongMemoryCue } from '../types/globals'

export type RekordboxXmlExportMode = 'copy' | 'move'

export type RekordboxXmlExportSourceLibraryName =
  'FilterLibrary' | 'CuratedLibrary' | 'SetLibrary' | 'NeteaseLibrary'

export type RekordboxXmlExportTrackInput = {
  filePath: string
  displayName?: string
  playlistTrackNumber?: number
  artist?: string
  album?: string
  genre?: string
  label?: string
  bitrate?: number
  duration?: string
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
  setItemId?: string
}

type RekordboxXmlExportSelectedTracksSource = {
  kind: 'selected-tracks'
  songListUUID: string
  tracks: RekordboxXmlExportTrackInput[]
}

type RekordboxXmlExportPlaylistSource = {
  kind: 'playlist'
  songListUUID: string
  songListPath: string
  playlistName: string
}

export type RekordboxXmlExportSource =
  RekordboxXmlExportSelectedTracksSource | RekordboxXmlExportPlaylistSource

export type RekordboxXmlExportRequest = {
  jobId: string
  targetRootDir: string
  exportDirName: string
  xmlFileName: string
  xmlPlaylistName: string
  mode: RekordboxXmlExportMode
  sourceLibraryName: RekordboxXmlExportSourceLibraryName
  source: RekordboxXmlExportSource
}

export type RekordboxXmlExportSuccessSummary = {
  mode: RekordboxXmlExportMode
  trackCount: number
  exportDirPath: string
  xmlPath: string
  playlistName: string
  sourceFilePaths: string[]
  exportedFilePaths: string[]
  removedSetItemIds?: string[]
}

type RekordboxXmlExportFailureSummary = {
  errorCode: string
  errorMessage: string
  rolledBack: boolean
  libraryChanged: boolean
  cancelled: boolean
  logPath: string
}

export type RekordboxXmlExportResponse =
  | {
      ok: true
      summary: RekordboxXmlExportSuccessSummary
    }
  | {
      ok: false
      summary: RekordboxXmlExportFailureSummary
    }
