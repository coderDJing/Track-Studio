import type { HorizontalBrowseGridShiftOptions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseGridToolbar'
import type {
  HorizontalBrowseLinkedGridVisualTransactionCommitOptions,
  HorizontalBrowseLinkedGridVisualTransactionDeckState,
  HorizontalBrowseLinkedGridVisualTransactionResult
} from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedGridVisualTransaction'

export type HorizontalBrowseViewMode = 'dual' | 'edit'

export type SharedDetailZoomState = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  revision: number
}

export type DeckCuePanelMode = 'memory' | 'hot-cue'

export type HorizontalBrowseDeckDetailLaneExpose = {
  setDownbeatLineAtPlayhead?: () => void
  shiftGridLargeLeft?: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridSmallLeft?: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridSmallRight?: (options?: HorizontalBrowseGridShiftOptions) => void
  shiftGridLargeRight?: (options?: HorizontalBrowseGridShiftOptions) => void
  updateBpmInput?: (value: string) => void
  blurBpmInput?: () => void
  tapBpm?: () => void
  splitAfterPlayhead?: () => void
  deleteBoundary?: () => void
  freezeDynamicGridSelectionForBpmInput?: () => void
  releaseDynamicGridSelectionForBpmInput?: () => void
  cycleMetronomeState?: () => void
  setLiveTempoPreviewRate?: (rate: number | null) => void
  prepareStableFrameForAnchor?: (
    seconds: number,
    options?: { timeoutMs?: number }
  ) => Promise<boolean>
  commitLinkedGridVisualTransaction?: (
    deckState?: HorizontalBrowseLinkedGridVisualTransactionDeckState,
    options?: HorizontalBrowseLinkedGridVisualTransactionCommitOptions
  ) => HorizontalBrowseLinkedGridVisualTransactionResult | null
  flushGridPersist?: (filePath?: string) => Promise<void>
  restoreGridFromSong?: () => void
  clearGridHistory?: () => void
}

export const EDIT_MODE_BPM_INPUT_TITLE = 'horizontalBrowse.editModeBpmInputTitle'
export const DUAL_MODE_BPM_INPUT_TITLE = 'horizontalBrowse.dualModeBpmInputTitle'
export const EDIT_MODE_TAP_BPM_TITLE = 'horizontalBrowse.editModeTapBpmTitle'

export const createDefaultSharedDetailZoomState = (value: number): SharedDetailZoomState => ({
  value,
  anchorRatio: 0.5,
  sourceDirection: null,
  revision: 0
})

export const createDefaultDeckToolbarState = () => ({
  disabled: true,
  bpmInputDisabled: true,
  showGridControls: true,
  showMetronome: true,
  bpmInputValue: '',
  bpmStep: 0.01,
  bpmMin: 1,
  bpmMax: 300,
  bpmInputTitle: '',
  bpmInputFirst: false,
  showTapButton: false,
  tapBpmTitle: '',
  metronomeEnabled: false,
  metronomeVolumeLevel: 2 as 1 | 2 | 3,
  canToggleMetronome: false,
  gridControlsDisabled: false,
  showSplitAfterPlayhead: false,
  showDeleteBoundary: false,
  gridAdjustScope: 'whole' as 'whole' | 'after'
})
