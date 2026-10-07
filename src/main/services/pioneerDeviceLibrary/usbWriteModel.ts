import type { PioneerUsbCue } from '../../../shared/pioneerUsbWrite'

export type UsbTrackRecord = {
  id: number
  filePath: string
  analyzePath: string
  artworkPath: string
}

export type UsbPlaylistRecord = {
  id: number
  parentId: number
  name: string
  isFolder: boolean
}

export type UsbPlaylistEntry = { playlistId: number; trackId: number; entryIndex: number }

export type UsbLibrarySnapshot = {
  tracks: UsbTrackRecord[]
  playlists: UsbPlaylistRecord[]
  entries: UsbPlaylistEntry[]
  protectedArtworkPaths?: string[]
  /** Bank List references retain audio during exclusive playlist deletion. */
  protectedTrackIds?: number[]
}

/** Concrete adapter IDs, after cross-library reconciliation. */
export type UsbLibraryMutation = {
  reorders: { playlistId: number; trackIds: number[] }[]
  additions: { playlistId: number; trackIds: number[] }[]
  removals: { playlistId: number; trackIds: number[] }[]
  deletePlaylistIds: number[]
  deleteTrackIds: number[]
  cueUpdates: { trackId: number; hotCues: PioneerUsbCue[]; memoryCues: PioneerUsbCue[] }[]
  gridUpdates: { trackId: number; offsetMs: number }[]
}

export const emptyUsbMutation = (): UsbLibraryMutation => ({
  reorders: [],
  additions: [],
  removals: [],
  deletePlaylistIds: [],
  deleteTrackIds: [],
  cueUpdates: [],
  gridUpdates: []
})
