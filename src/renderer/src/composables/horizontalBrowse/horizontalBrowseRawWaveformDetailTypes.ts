import type { HorizontalBrowseGridShiftOptions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseGridToolbar'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type { AudioEditClip } from '@shared/audioEditTimeline'
import type { SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import type { HorizontalBrowseGridToolbarState } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseGridToolbar'
import type { HorizontalBrowseScrubPreviewPayload } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseWaveformScrubPreview'
import type { HorizontalBrowseWaveformPresentationState } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformPresentationCoordinator'
import type {
  HorizontalBrowseLinkedGridVisualTransactionCommitOptions,
  HorizontalBrowseLinkedGridVisualTransactionDeckState,
  HorizontalBrowseLinkedGridVisualTransactionResult
} from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedGridVisualTransaction'

export type HorizontalBrowseSharedZoomState = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  revision: number
}

export type HorizontalBrowseDragSessionEndPayload = {
  anchorSec: number
  committed: boolean
}

export type HorizontalBrowseLoopRange = {
  startSec: number
  endSec: number
}

export type HorizontalBrowseDetailZoomChangePayload = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down'
  anchorSec?: number
  viewportStartSec?: number
  visibleDurationSec?: number
  timeScale?: number
}

export type HorizontalBrowseWaveformLayout = 'auto' | 'full'
export type HorizontalBrowseWaveformRenderStyle = 'columns' | 'raw-curve'

export type HorizontalBrowseRawWaveformDetailProps = {
  song: ISongInfo | null
  direction: 'up' | 'down'
  sharedZoomState?: HorizontalBrowseSharedZoomState
  currentSeconds?: number
  playing?: boolean
  playbackActive?: boolean
  playbackRate?: number
  liveTempoPreviewRate?: number | null
  waveformGain?: number
  playbackSyncRevision?: number
  gridBpm?: number
  loopRange?: HorizontalBrowseLoopRange | null
  audioEditSelection?: HorizontalBrowseLoopRange | null
  audioEditPendingStartSec?: number | null
  audioEditPendingEndSec?: number | null
  audioEditInsertedRanges?: HorizontalBrowseLoopRange[] | null
  audioEditClips?: AudioEditClip[] | null
  cueSeconds?: number
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
  seekTargetSeconds?: number
  seekRevision?: number
  linkedDragActive?: boolean
  linkedDragAnchorSec?: number | null
  linkedGridActive?: boolean
  linkedGridVisualPending?: boolean
  presentationState?: HorizontalBrowseWaveformPresentationState
  maxZoom?: number
  waveformLayout?: HorizontalBrowseWaveformLayout
  waveformRenderStyle?: HorizontalBrowseWaveformRenderStyle
  allowNegativeTimeline?: boolean
  gridEditMode?: boolean
  interactionDisabled?: boolean
  deferGridPersist?: boolean
}

export type HorizontalBrowseRawWaveformDetailEmit = {
  (event: 'toolbar-state-change', value: HorizontalBrowseGridToolbarState): void
  (event: 'zoom-change', value: HorizontalBrowseDetailZoomChangePayload): void
  (event: 'drag-session-start'): void
  (event: 'drag-session-preview', value: HorizontalBrowseScrubPreviewPayload): void
  (event: 'drag-session-end', value: HorizontalBrowseDragSessionEndPayload): void
  (event: 'edit-waveform-loading-change', value: boolean): void
  (event: 'display-beat-grid-change', value: SongBeatGridMapV2 | null): void
  (event: 'grid-dirty-change', value: boolean): void
}

export type HorizontalBrowseRawWaveformDetailExpose = {
  setDownbeatLineAtPlayhead: () => void
  shiftGridSmallLeft: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridLargeLeft: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridSmallRight: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridLargeRight: (options?: HorizontalBrowseGridShiftOptions) => void
  updateBpmInput: (value: string) => void
  blurBpmInput: () => void
  tapBpm: () => void
  selectWholeAdjustment: () => void
  splitAfterPlayhead: () => void
  deleteBoundary: () => void
  freezeDynamicGridSelectionForBpmInput: () => void
  releaseDynamicGridSelectionForBpmInput: () => void
  cycleMetronomeState: () => void
  setLiveTempoPreviewRate?: (rate: number | null) => void
  prepareStableFrameForAnchor: (
    seconds: number,
    options?: { timeoutMs?: number }
  ) => Promise<boolean>
  commitLinkedGridVisualTransaction: (
    deckState?: HorizontalBrowseLinkedGridVisualTransactionDeckState,
    options?: HorizontalBrowseLinkedGridVisualTransactionCommitOptions
  ) => HorizontalBrowseLinkedGridVisualTransactionResult | null
  flushGridPersist: (filePath?: string) => Promise<void>
  restoreGridFromSong: () => void
  clearGridHistory: () => void
}
