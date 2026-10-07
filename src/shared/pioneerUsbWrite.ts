export type PioneerUsbLibraryType = 'deviceLibrary' | 'oneLibrary'

/** ANLZ stores milliseconds; permit floating point representation error only. */
export const hasPioneerUsbCueMillisecondPrecision = (sec: number): boolean =>
  Number.isFinite(sec) && Math.abs(sec * 1000 - Math.round(sec * 1000)) <= 1e-6

/** Slots follow FRKB's zero-based A–H numbering. All times are seconds. */
export type PioneerUsbCue = {
  slot?: number
  sec: number
  loopEndSec?: number
  loopNumerator?: number
  loopDenominator?: number
  comment?: string
  colorIndex?: number
  color?: string
  activeLoop?: boolean
}

export type PioneerUsbWriteOperation =
  | { kind: 'reorder'; playlistId: number; trackIds: number[] }
  | { kind: 'add-to-playlist'; playlistId: number; trackIds: number[] }
  | { kind: 'remove-from-playlist'; playlistId: number; trackIds: number[] }
  | { kind: 'delete-tracks'; trackIds: number[] }
  | { kind: 'delete-playlist'; playlistId: number; deleteExclusiveTracks: boolean }
  | { kind: 'set-cues'; trackId: number; hotCues: PioneerUsbCue[]; memoryCues: PioneerUsbCue[] }
  | { kind: 'shift-grid'; trackId: number; offsetMs: number }

export type PioneerUsbWriteRequest = {
  rootPath: string
  libraryType: PioneerUsbLibraryType
  operation: PioneerUsbWriteOperation
}

export type PioneerUsbWriteSummary = {
  libraries: PioneerUsbLibraryType[]
  changedFileCount: number
  deletedTrackCount: number
  deletedFiles: string[]
  deletedTrackFilePaths?: string[]
  preservedSharedFileCount: number
}

export type PioneerUsbWritePreview = {
  token: string
  summary: PioneerUsbWriteSummary
}

export type PioneerUsbWriteResponse<T = PioneerUsbWriteSummary> =
  | { ok: true; result: T }
  | { ok: false; error: string }
