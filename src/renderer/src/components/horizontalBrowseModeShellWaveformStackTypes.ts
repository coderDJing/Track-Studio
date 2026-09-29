import type { ComputedRef, Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { buildHorizontalBrowseDeckToolbarState } from '@renderer/composables/horizontalBrowse/horizontalBrowseShellState'
import type { HorizontalBrowseDetailZoomChangePayload } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailTypes'
import type {
  HorizontalBrowseDeckDetailLaneExpose,
  SharedDetailZoomState
} from '@renderer/composables/horizontalBrowse/horizontalBrowseModeShellTypes'
import type { createHorizontalBrowseDeckEjectHandler } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckEject'
import type { useHorizontalBrowseAudioEditShell } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseAudioEditShell'
import type { useHorizontalBrowseDeckDrop } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckDrop'
import type { useHorizontalBrowseDeckHotCues } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckHotCues'
import type { useHorizontalBrowseDeckMemoryCues } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckMemoryCues'
import type { useHorizontalBrowseDeckMove } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckMove'
import type { useHorizontalBrowseDeckQuantize } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckQuantize'
import type { useHorizontalBrowseDeckTempoControls } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckTempoControls'
import type { useHorizontalBrowseDeckTempoNudge } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckTempoNudge'
import type { useHorizontalBrowseDeckToolbarInteractions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckToolbarInteractions'
import type { useHorizontalBrowseDeckTransportInteractions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckTransportInteractions'
import type { HorizontalBrowsePlaybackRangeOverlay } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseEditPlaybackRange'
import type { useHorizontalBrowseModePlaybackHandoff } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseModePlaybackHandoff'
import type { useHorizontalBrowseTransportController } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseTransportController'
import type { useHorizontalBrowseTransportMutations } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseTransportMutations'
import type { useHorizontalBrowseWaveformPresentationCoordinator } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformPresentationCoordinator'

type DeckKey = HorizontalBrowseDeckKey
type AudioEditShell = ReturnType<typeof useHorizontalBrowseAudioEditShell>
type DeckDrop = ReturnType<typeof useHorizontalBrowseDeckDrop>
type DeckHotCues = ReturnType<typeof useHorizontalBrowseDeckHotCues>
type DeckMemoryCues = ReturnType<typeof useHorizontalBrowseDeckMemoryCues>
type DeckMove = ReturnType<typeof useHorizontalBrowseDeckMove>
type DeckQuantize = ReturnType<typeof useHorizontalBrowseDeckQuantize>
type DeckTempoControls = ReturnType<typeof useHorizontalBrowseDeckTempoControls>
type DeckTempoNudge = ReturnType<typeof useHorizontalBrowseDeckTempoNudge>
type DeckToolbarInteractions = ReturnType<typeof useHorizontalBrowseDeckToolbarInteractions>
type DeckTransportInteractions = ReturnType<typeof useHorizontalBrowseDeckTransportInteractions>
type ModePlaybackHandoff = ReturnType<typeof useHorizontalBrowseModePlaybackHandoff>
type TransportController = ReturnType<typeof useHorizontalBrowseTransportController>
type TransportMutations = ReturnType<typeof useHorizontalBrowseTransportMutations>

export type HorizontalBrowseModeShellWaveformStackExpose = {
  resolveDetailRef: (deck: DeckKey) => HorizontalBrowseDeckDetailLaneExpose | null
}

export type HorizontalBrowseModeShellWaveformStackModel = {
  isEditMode: ComputedRef<boolean>
  topDeckSong: Ref<ISongInfo | null>
  bottomDeckSong: Ref<ISongInfo | null>
  deckSyncState: TransportController['deckSyncState']
  deckKeysHarmonicMatched: ComputedRef<boolean>
  topDeckVisibleCurrentSeconds: AudioEditShell['topDeckVisibleCurrentSeconds']
  topDeckVisibleDurationSeconds: AudioEditShell['topDeckVisibleDurationSeconds']
  topDeckVisiblePlaying: AudioEditShell['topDeckVisiblePlaying']
  bottomDeckRenderCurrentSeconds: TransportController['bottomDeckRenderCurrentSeconds']
  bottomDeckDurationSeconds: ComputedRef<number>
  bottomDeckUiPlaying: ComputedRef<boolean>
  audioEdit: AudioEditShell['audioEdit']
  playbackRangeOverlay: ComputedRef<HorizontalBrowsePlaybackRangeOverlay>
  deckQuantizeEnabled: DeckQuantize['deckQuantizeEnabled']
  topDeckWaveformPlaybackActive: ComputedRef<boolean>
  bottomDeckWaveformPlaybackActive: ComputedRef<boolean>
  topDeckPlaybackRate: TransportController['topDeckPlaybackRate']
  bottomDeckPlaybackRate: TransportController['bottomDeckPlaybackRate']
  topDeckPlaybackSyncRevision: TransportController['topDeckPlaybackSyncRevision']
  bottomDeckPlaybackSyncRevision: TransportController['bottomDeckPlaybackSyncRevision']
  topDeckGridBpm: ComputedRef<number>
  bottomDeckGridBpm: ComputedRef<number>
  topDeckCuePointSeconds: Ref<number>
  bottomDeckCuePointSeconds: Ref<number>
  deckSeekIntent: TransportController['deckSeekIntent']
  sharedDetailZoomState: Ref<SharedDetailZoomState>
  editDetailZoomState: Ref<SharedDetailZoomState>
  gridEditMode: AudioEditShell['gridEditMode']
  waveformPresentation: ReturnType<typeof useHorizontalBrowseWaveformPresentationCoordinator>
  isDeckHovered: DeckDrop['isDeckHovered']
  resolveDeckSyncUiEnabled: (deck: DeckKey) => boolean
  pendingMasterDeck: Ref<DeckKey | null>
  failedMasterDeck: Ref<DeckKey | null>
  pendingBeatSync: Record<DeckKey, boolean>
  resolveDeckToolbarState: (
    deck: DeckKey
  ) => ReturnType<typeof buildHorizontalBrowseDeckToolbarState>
  resolveDeckLoopRange: DeckTransportInteractions['resolveDeckLoopRange']
  isDeckSongReadOnly: DeckMove['isDeckSongReadOnly']
  isDeckMasterTempoEnabled: DeckTempoControls['isDeckMasterTempoEnabled']
  resolveDeckTempoNudgeDirection: DeckTempoNudge['resolveDeckTempoNudgeDirection']
  handleRegionDragEnter: DeckDrop['handleRegionDragEnter']
  handleRegionDragOver: DeckDrop['handleRegionDragOver']
  handleRegionDragLeave: DeckDrop['handleRegionDragLeave']
  handleRegionDrop: DeckDrop['handleRegionDrop']
  triggerDeckBeatSync: TransportMutations['triggerDeckBeatSync']
  toggleDeckMaster: TransportMutations['toggleDeckMaster']
  handleTopDeckEjectSong: () => void
  handleDeckEjectSong: ReturnType<typeof createHorizontalBrowseDeckEjectHandler>
  handleDeckPlayheadSeek: AudioEditShell['handleDeckPlayheadSeek']
  handleDeckSectionSeekPlay: AudioEditShell['handleDeckSectionSeekPlay']
  handleDeckSetDownbeatLineAtPlayhead: DeckToolbarInteractions['handleDeckSetDownbeatLineAtPlayhead']
  handleDeckGridShiftLargeLeft: DeckToolbarInteractions['handleDeckGridShiftLargeLeft']
  handleDeckGridShiftSmallLeft: DeckToolbarInteractions['handleDeckGridShiftSmallLeft']
  handleDeckGridShiftSmallRight: DeckToolbarInteractions['handleDeckGridShiftSmallRight']
  handleDeckGridShiftLargeRight: DeckToolbarInteractions['handleDeckGridShiftLargeRight']
  handleDeckBpmInputUpdate: DeckToolbarInteractions['handleDeckBpmInputUpdate']
  handleDeckBpmInputLive: DeckToolbarInteractions['handleDeckBpmInputLive']
  handleDeckBpmInputBlur: DeckToolbarInteractions['handleDeckBpmInputBlur']
  handleDeckBpmTap: DeckToolbarInteractions['handleDeckBpmTap']
  handleDeckMemoryCueCreate: DeckMemoryCues['handleDeckMemoryCueCreate']
  handleDeckSelectWholeAdjustment: DeckToolbarInteractions['handleDeckSelectWholeAdjustment']
  handleDeckSplitAfterPlayhead: DeckToolbarInteractions['handleDeckSplitAfterPlayhead']
  handleDeckDeleteBoundary: DeckToolbarInteractions['handleDeckDeleteBoundary']
  handleDeckMetronomeStateCycle: DeckToolbarInteractions['handleDeckMetronomeStateCycle']
  handleDeckLoopStepDown: DeckTransportInteractions['handleDeckLoopStepDown']
  handleDeckLoopStepUp: DeckTransportInteractions['handleDeckLoopStepUp']
  handleDeckLoopToggle: DeckTransportInteractions['handleDeckLoopToggle']
  handleDeckMasterTempoToggle: (deck: DeckKey) => void
  resetDeckTempo: DeckTempoControls['resetDeckTempo']
  handleDeckQuantizeToggle: (deck: DeckKey) => void
  startDeckTempoNudge: DeckTempoNudge['startDeckTempoNudge']
  stopDeckTempoNudge: DeckTempoNudge['stopDeckTempoNudge']
  openDeckMoveDialog: DeckMove['openDeckMoveDialog']
  resolveDeckPlaybackRateForTransport: DeckTempoNudge['resolveDeckPlaybackRateForTransport']
  resolveDeckWaveformGain: (deck: DeckKey) => number
  isDeckWaveformDragging: DeckTransportInteractions['isDeckWaveformDragging']
  resolveDeckWaveformDragAnchorSec: DeckTransportInteractions['resolveDeckWaveformDragAnchorSec']
  shouldPreserveGridShiftPhase: (deck: DeckKey) => boolean
  handleToolbarStateChange: DeckToolbarInteractions['handleToolbarStateChange']
  handleDetailZoomChange: (payload: HorizontalBrowseDetailZoomChangePayload) => void
  handleDeckRawWaveformDragStart: AudioEditShell['handleDeckRawWaveformDragStart']
  handleDeckRawWaveformScrubPreview: AudioEditShell['handleDeckRawWaveformScrubPreview']
  handleDeckRawWaveformDragEnd: AudioEditShell['handleDeckRawWaveformDragEnd']
  handleEditWaveformLoadingChange: ModePlaybackHandoff['handleEditWaveformLoadingChange']
  handleDeckHotCuePress: DeckHotCues['handleDeckHotCuePress']
  handleDeckHotCueDelete: DeckHotCues['handleDeckHotCueDelete']
  handleDeckMemoryCueRecallPress: DeckMemoryCues['handleDeckMemoryCueRecallPress']
  handleDeckMemoryCueDelete: DeckMemoryCues['handleDeckMemoryCueDelete']
}
