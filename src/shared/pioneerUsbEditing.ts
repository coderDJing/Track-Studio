import type { ISongHotCue, ISongMemoryCue, IRekordboxBeatGridEntry } from '../types/globals'
import type { PioneerUsbLibraryType, PioneerUsbWriteResponse } from './pioneerUsbWrite'

export type PioneerUsbSongSource = {
  rootPath: string
  libraryType: PioneerUsbLibraryType
  trackId: number
}

export type PioneerUsbSongEdit =
  | { kind: 'set-hot-cue'; cue: ISongHotCue }
  | { kind: 'delete-hot-cue'; slot: number }
  | { kind: 'add-memory-cue'; cue: ISongMemoryCue }
  | { kind: 'delete-memory-cue'; sec: number }
  | { kind: 'shift-grid'; offsetMs: number }

export type PioneerUsbSongEditRequest = {
  source: PioneerUsbSongSource
  filePath: string
  edit: PioneerUsbSongEdit
}

export type PioneerUsbSongEditResult = {
  filePath: string
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
  rekordboxGridEntries?: IRekordboxBeatGridEntry[]
}

export type PioneerUsbSongEditResponse = PioneerUsbWriteResponse<PioneerUsbSongEditResult>
