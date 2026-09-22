<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import HorizontalBrowseDeckControlRow from '@renderer/components/HorizontalBrowseDeckControlRow.vue'
import HorizontalBrowseEditDeckControls from '@renderer/components/HorizontalBrowseEditDeckControls.vue'
import HorizontalBrowseAudioEditChrome from '@renderer/components/HorizontalBrowseAudioEditChrome.vue'
import HorizontalBrowseDeckMoveDialog from '@renderer/components/HorizontalBrowseDeckMoveDialog.vue'
import HorizontalBrowseFaderPanel from '@renderer/components/HorizontalBrowseFaderPanel.vue'
import HorizontalBrowseModeShellWaveformStack from '@renderer/components/HorizontalBrowseModeShellWaveformStack.vue'
import type {
  HorizontalBrowseModeShellWaveformStackExpose,
  HorizontalBrowseModeShellWaveformStackModel
} from '@renderer/components/horizontalBrowseModeShellWaveformStackTypes'
import {
  HORIZONTAL_BROWSE_EDIT_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM
} from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import {
  buildHorizontalBrowseDeckToolbarState,
  parseHorizontalBrowseDurationToSeconds,
  resolveHorizontalBrowseDeckDurationSeconds,
  resolveHorizontalBrowseDeckGridBpm,
  resolveHorizontalBrowseDeckSyncUiEnabled,
  resolveHorizontalBrowseDeckWaveformGain
} from '@renderer/composables/horizontalBrowse/horizontalBrowseShellState'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import {
  resolveHorizontalBrowseCuePointSec,
  resolveHorizontalBrowseDefaultCuePointSec
} from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailMath'
import { createHorizontalBrowseDeckEjectHandler } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckEject'
import { useHorizontalBrowseDeckMove } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckMove'
import { useHorizontalBrowseDeckSongs } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckSongs'
import { useHorizontalBrowseDeckTempoControls } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckTempoControls'
import { useHorizontalBrowseDeckTempoNudge } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckTempoNudge'
import { useHorizontalBrowseDeckToolbarInteractions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckToolbarInteractions'
import { useHorizontalBrowseDeckTransportInteractions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckTransportInteractions'
import { useHorizontalBrowseEditDeckNavigation } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseEditDeckNavigation'
import { useHorizontalBrowseDeckHotCues } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckHotCues'
import { useHorizontalBrowseDeckMemoryCues } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckMemoryCues'
import { useHorizontalBrowseDeckQuantize } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckQuantize'
import { useHorizontalBrowseDeckSongSync } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckSongSync'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { isHarmonicMixCompatible } from '@shared/keyDisplay'
import emitter from '@renderer/utils/mitt'
import { createHorizontalBrowseDeckAssigner } from '@renderer/composables/horizontalBrowse/horizontalBrowseDeckAssignment'
import type { HorizontalBrowseDeckAssignTransportOptions } from '@renderer/composables/horizontalBrowse/horizontalBrowseDeckAssignment'
import { useHorizontalBrowseTransportController } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseTransportController'
import { useHorizontalBrowseWaveformPreviewSuspension } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseWaveformPreviewSuspension'
import { useHorizontalBrowseTransportMutations } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseTransportMutations'
import { useHorizontalBrowseFaderControls } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseFaderControls'
import { useHorizontalBrowseVisualizer } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseVisualizer'
import {
  useHorizontalBrowseDeckSourceState,
  type HorizontalBrowseDeckSongSourceOptions
} from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckSourceState'
import { useHorizontalBrowseDeckDrop } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckDrop'
import { useHorizontalBrowseDeckInteractionState } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckInteractionState'
import { useHorizontalBrowseSongsRemoved } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseSongsRemoved'
import {
  createDefaultDeckToolbarState,
  createDefaultSharedDetailZoomState,
  DUAL_MODE_BPM_INPUT_TITLE,
  EDIT_MODE_BPM_INPUT_TITLE,
  EDIT_MODE_TAP_BPM_TITLE,
  type HorizontalBrowseViewMode,
  type SharedDetailZoomState
} from '@renderer/composables/horizontalBrowse/horizontalBrowseModeShellTypes'
import { useHorizontalBrowseModePlaybackHandoff } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseModePlaybackHandoff'
import { useHorizontalBrowseEditPlaybackRange } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseEditPlaybackRange'
import { useHorizontalBrowseAudioEditShell } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseAudioEditShell'
import { useHorizontalBrowseModeShellHotkeys } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseModeShellHotkeys'
import { useHorizontalBrowseVolumeSync } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseVolumeSync'
import { MAIN_WINDOW_PLAYBACK_SNAPSHOT_REQUEST_EVENT } from '@renderer/utils/mainWindowPlaybackHandoff'
import { useHorizontalBrowseWaveformPresentationCoordinator } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformPresentationCoordinator'
import { createHorizontalBrowseWaveformPresentationShellBridge } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformPresentationShellBridge'
import type { HorizontalBrowseDetailZoomChangePayload } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailTypes'
import { createHorizontalBrowseModeShellDetailTransactions } from '@renderer/composables/horizontalBrowse/horizontalBrowseModeShellDetailTransactions'
import {
  resolveHorizontalBrowseLightThemeActive,
  resolveHorizontalBrowseDeckToolbarBpmInputValue,
  resolveHorizontalBrowseDeckWaveformPlaybackActive
} from '@renderer/composables/horizontalBrowse/horizontalBrowseModeShellPresentationResolvers'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { resolveInitialPlaybackRangeStartSec } from '@shared/playbackRange'
import { t } from '@renderer/utils/translate'

type DeckKey = HorizontalBrowseDeckKey
const props = withDefaults(defineProps<{ viewMode?: HorizontalBrowseViewMode }>(), {
  viewMode: 'dual'
})
const runtime = useRuntimeStore()
const {
  topDeckSong,
  bottomDeckSong,
  setDeckSong: setDeckSongState,
  resolveDeckSong
} = useHorizontalBrowseDeckSongs()
const topDeckCuePointSeconds = ref(0)
const bottomDeckCuePointSeconds = ref(0)
const waveformPresentation = useHorizontalBrowseWaveformPresentationCoordinator()
const waveformStackRef = ref<HorizontalBrowseModeShellWaveformStackExpose | null>(null)
const resolveDetailRef = (deck: DeckKey) => waveformStackRef.value?.resolveDetailRef(deck) ?? null
const {
  prepareDeckStableFrameForAnchor,
  beginLinkedGridVisualTransaction,
  cancelLinkedGridVisualTransaction,
  commitLinkedGridVisualTransaction
} = createHorizontalBrowseModeShellDetailTransactions({
  presentation: waveformPresentation,
  resolveDetailRef
})
const faderPanelRef = ref<InstanceType<typeof HorizontalBrowseFaderPanel> | null>(null)
const topDeckToolbarState = ref(createDefaultDeckToolbarState())
const bottomDeckToolbarState = ref(createDefaultDeckToolbarState())
const sharedDetailZoomState = ref<SharedDetailZoomState>(
  createDefaultSharedDetailZoomState(HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
)
const editDetailZoomState = ref<SharedDetailZoomState>(
  createDefaultSharedDetailZoomState(HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
)
const horizontalBrowseViewMode = computed<HorizontalBrowseViewMode>(() => props.viewMode)
const isEditMode = computed(() => horizontalBrowseViewMode.value === 'edit')
const isLightTheme = computed(() =>
  resolveHorizontalBrowseLightThemeActive(runtime.setting?.themeMode || 'system')
)
watch(
  isEditMode,
  (editMode) => {
    waveformPresentation.setSurfaceMode('top', editMode ? 'edit-detail' : 'dual-detail')
    waveformPresentation.setSurfaceMode('bottom', 'dual-detail')
  },
  { immediate: true }
)
const {
  resolveSongsAreaStateBySongListUUID,
  resolveSongListSnapshot,
  resolveDeckSongSourceOptions,
  setDeckSongListSource,
  clearDeckSongListSource,
  clearAllDeckSongListSources
} = useHorizontalBrowseDeckSourceState()
const setDeckSong = (deck: DeckKey, song: ISongInfo | null) => {
  deckTempoInputDirty[deck] = false
  if (!song) {
    if (deck === 'top') {
      topDeckCuePointSeconds.value = 0
    } else {
      bottomDeckCuePointSeconds.value = 0
    }
  }
  setDeckSongState(deck, song)
  if (!song) {
    clearDeckSongListSource(deck)
  }
}
const deckTempoInputDirty = reactive<Record<DeckKey, boolean>>({
  top: false,
  bottom: false
})
const deckTempoCommitToken = reactive<Record<DeckKey, number>>({
  top: 0,
  bottom: 0
})
const { touchDeckInteraction, clearDeckRecentInteractionTimer } =
  useHorizontalBrowseDeckInteractionState()
const {
  nativeTransport,
  deckSyncState,
  deckSeekIntent,
  topDeckPlaybackRate,
  bottomDeckPlaybackRate,
  auditionPresentationSuspended,
  topDeckRenderCurrentSeconds,
  bottomDeckRenderCurrentSeconds,
  topDeckPlaybackSyncRevision,
  bottomDeckPlaybackSyncRevision,
  resolveTransportDeckSnapshot,
  resolveDeckCurrentSeconds,
  resolveDeckPlaying,
  resolveDeckLoaded,
  resolveDeckDecoding,
  resolveDeckRenderCurrentSeconds,
  syncDeckRenderState,
  setAuditionPresentationSuspended,
  startSnapshotSync,
  stopSnapshotSync,
  startRenderSyncLoop,
  stopRenderSyncLoop,
  holdDeckRenderCurrentSeconds,
  startDeckRenderPlaybackClock,
  primeDeckRenderCurrentSeconds,
  notifyDeckSeekIntent
} = useHorizontalBrowseTransportController({
  linkedGridVisualPending: () =>
    waveformPresentation.state.top.visualPending === true ||
    waveformPresentation.state.bottom.visualPending === true
})
const { handlePlayerInteraction } = useHorizontalBrowseWaveformPreviewSuspension({
  nativeTransport,
  syncDeckRenderState,
  setAuditionPresentationSuspended,
  playerInteractionEnabled: () => !isEditMode.value
})
const notifyDeckSeekPresentationIntent = (deck: DeckKey, seconds: number) => {
  waveformPresentation.markSeek(deck, seconds)
  notifyDeckSeekIntent(deck, seconds)
}
useHorizontalBrowseVisualizer({ nativeTransport })
const { mainWindowVolume, syncCurrentVolume } = useHorizontalBrowseVolumeSync({ nativeTransport })
const topDeckDurationSeconds = computed(() => resolveDeckDurationSeconds('top'))
const bottomDeckDurationSeconds = computed(() => resolveDeckDurationSeconds('bottom'))
const resolveDeckCuePointRef = (deck: DeckKey) =>
  deck === 'top' ? topDeckCuePointSeconds : bottomDeckCuePointSeconds
const resolveDeckDurationSeconds = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckDurationSeconds(
    resolveTransportDeckSnapshot(deck).durationSec,
    resolveDeckSong(deck)?.duration
  )
const topDeckUiPlaying = computed(() => resolveDeckPlaying('top'))
const bottomDeckUiPlaying = computed(() => resolveDeckPlaying('bottom'))
const resolveDeckWaveformPlaybackActive = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckWaveformPlaybackActive({
    deck,
    snapshot: resolveTransportDeckSnapshot(deck),
    auditionSuspended:
      auditionPresentationSuspended.value || nativeTransport.state.auditionSuspended,
    topRenderCurrentSeconds: topDeckRenderCurrentSeconds,
    bottomRenderCurrentSeconds: bottomDeckRenderCurrentSeconds,
    negativePlaybackEpsilonSec: 0.0001
  })
const topDeckWaveformPlaybackActive = computed(() => resolveDeckWaveformPlaybackActive('top'))
const bottomDeckWaveformPlaybackActive = computed(() => resolveDeckWaveformPlaybackActive('bottom'))
const resolveDeckWaveformGain = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckWaveformGain(resolveTransportDeckSnapshot(deck))
const topDeckCueActive = computed(
  () => resolveDeckCuePreviewRuntimeState('top').active || deckPendingCuePreviewOnLoad.top
)
const bottomDeckCueActive = computed(
  () => resolveDeckCuePreviewRuntimeState('bottom').active || deckPendingCuePreviewOnLoad.bottom
)
const topDeckPlayButtonActive = computed(() => topDeckUiPlaying.value && !topDeckCueActive.value)
const bottomDeckPlayButtonActive = computed(
  () => bottomDeckUiPlaying.value && !bottomDeckCueActive.value
)
const topDeckUiDecoding = computed(() => resolveDeckDecoding('top'))
const bottomDeckUiDecoding = computed(() => resolveDeckDecoding('bottom'))
const resolveDeckGridBpm = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckGridBpm(
    resolveTransportDeckSnapshot(deck).effectiveBpm,
    resolveTransportDeckSnapshot(deck).playbackRate,
    resolveDeckSong(deck)?.bpm
  )
const topDeckGridBpm = computed(() => resolveDeckGridBpm('top'))
const bottomDeckGridBpm = computed(() => resolveDeckGridBpm('bottom'))
const deckKeysHarmonicMatched = computed(() =>
  isHarmonicMixCompatible(
    String(topDeckSong.value?.key || ''),
    String(bottomDeckSong.value?.key || '')
  )
)
const syncDeckDefaultCue = (deck: DeckKey, song: ISongInfo | null, force = false) => {
  const target = resolveDeckCuePointRef(deck)
  if (!force && target.value > 0.000001) return
  target.value = resolveHorizontalBrowseDefaultCuePointSec(song, resolveDeckDurationSeconds(deck))
}
const {
  deckQuantizeEnabled,
  toggleDeckQuantize,
  resolveDeckCuePlacementSec,
  resolveDeckMarkerPlacementSec
} = useHorizontalBrowseDeckQuantize({
  resolveDeckPlaying,
  resolveDeckCurrentSeconds,
  resolveDeckRenderCurrentSeconds,
  resolveDeckDurationSeconds,
  resolveDeckGridBpm,
  resolveDeckSong,
  resolveCuePointSec: resolveHorizontalBrowseCuePointSec
})
const editQuantizeEnabled = computed(() => deckQuantizeEnabled.top)
const resolveDeckMarkerPlacementSeconds = (deck: DeckKey) =>
  Math.max(0, Number(resolveDeckMarkerPlacementSec(deck)) || 0)
const resolveDeckToolbarBpmInputValue = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckToolbarBpmInputValue({
    deck,
    toolbarState: deck === 'top' ? topDeckToolbarState.value : bottomDeckToolbarState.value,
    deckTempoInputDirty,
    editMode: isEditMode.value,
    resolveDeckSong,
    resolveDeckGridBpm,
    resolveTransportDeckSnapshot
  })
let resolveDeckMasterTempoEnabledForTransport: (deck: DeckKey) => boolean = () => true
const {
  resolveDeckPlaybackRateForTransport,
  resolveDeckTempoNudgeDirection,
  startDeckTempoNudge,
  stopDeckTempoNudge,
  stopAllDeckTempoNudge,
  resetAllDeckTempoNudgePlaybackRates
} = useHorizontalBrowseDeckTempoNudge({
  touchDeckInteraction,
  nativeTransport,
  syncDeckRenderState,
  resolveDeckSong,
  resolveTransportDeckSnapshot
})

const { commitDeckStateToNative, commitDeckStatesToNative, toggleDeckMaster, triggerDeckBeatSync } =
  useHorizontalBrowseTransportMutations({
    touchDeckInteraction,
    nativeTransport,
    syncDeckRenderState,
    commitLinkedGridVisualTransaction,
    beginLinkedGridVisualTransaction,
    cancelLinkedGridVisualTransaction,
    clearLinkedPresentation: waveformPresentation.clearLinkedPresentation,
    resolveDeckSong,
    resolveDeckCurrentSeconds,
    resolveDeckDurationSeconds,
    resolveDeckPlaying,
    resolveDeckPlaybackRate: resolveDeckPlaybackRateForTransport,
    resolveDeckMasterTempoEnabled: (deck) => resolveDeckMasterTempoEnabledForTransport(deck),
    resolveTransportDeckSnapshot
  })
const {
  selectSongListDialogVisible,
  selectSongListDialogTargetLibraryName,
  selectSongListDialogActionMode,
  isDeckSongReadOnly,
  openDeckMoveDialog,
  handleDeckMoveSong,
  handleDeckMoveDialogCancel
} = useHorizontalBrowseDeckMove({
  getDeckSong: resolveDeckSong,
  setDeckSong
})
const {
  isDeckMasterTempoEnabled,
  toggleDeckMasterTempo,
  scheduleDeckLiveTargetBpm,
  commitDeckTargetBpm,
  cancelDeckLiveTargetBpm,
  resetDeckTempo
} = useHorizontalBrowseDeckTempoControls({
  resolveDeckSong,
  resolveDeckGridBpm,
  resolveTransportDeckSnapshot,
  nativeTransport,
  onLiveVisualPlaybackRate: (deck, playbackRate) => {
    resolveDetailRef(deck)?.setLiveTempoPreviewRate?.(playbackRate)
  }
})
resolveDeckMasterTempoEnabledForTransport = isDeckMasterTempoEnabled
const handleDeckMasterTempoToggle = (deck: DeckKey) => {
  touchDeckInteraction(deck)
  toggleDeckMasterTempo(deck)
  void nativeTransport.setMasterTempoEnabled(deck, isDeckMasterTempoEnabled(deck))
}

const {
  deckBandState,
  deckCueMonitorState,
  faderControlsExpanded,
  dualTransportSyncEnabled,
  dualTransportSyncActivating,
  dualTransportSyncDeactivating,
  canUseDualTransportSync,
  activateDualTransportSync,
  deactivateDualTransportSync,
  handleDualTransportSyncToggle,
  handleDeckBandToggle,
  handleDeckCueMonitorToggle,
  clearAllDeckCueMonitor
} = useHorizontalBrowseFaderControls({
  topDeckSong,
  bottomDeckSong,
  setting: runtime.setting,
  deckSyncState,
  nativeTransport,
  commitDeckStatesToNative,
  syncDeckRenderState,
  commitLinkedGridVisualTransaction,
  beginLinkedGridVisualTransaction,
  cancelLinkedGridVisualTransaction,
  clearLinkedPresentation: waveformPresentation.clearLinkedPresentation,
  resolveDeckSong,
  resolveDeckPlaying,
  resolveDeckCurrentSeconds,
  resolveDeckDurationSeconds,
  resolveTransportDeckSnapshot
})
const { assignSongToDeck: assignSongToDeckBase } = createHorizontalBrowseDeckAssigner({
  touchDeckInteraction,
  setDeckSong,
  resolveDeckSong,
  resolveDeckPlaying,
  resolveDeckCurrentSeconds,
  shouldDeferDeckSongPriorityAnalysis: (deck) => {
    const otherDeck = deck === 'top' ? 'bottom' : 'top'
    return resolveDeckPlaying(otherDeck) && !resolveDeckPlaying(deck)
  },
  syncDeckDefaultCue,
  primeDeckRenderCurrentSeconds,
  setDeckBeatGridToNative: nativeTransport.setBeatGrid,
  commitDeckStateToNative
})

const assignSongToDeck = async (
  deck: DeckKey,
  song: ISongInfo,
  sourceOptions?: HorizontalBrowseDeckSongSourceOptions,
  transportOptions?: HorizontalBrowseDeckAssignTransportOptions
) => {
  setDeckSongListSource(deck, resolveDeckSongSourceOptions(sourceOptions))
  const shouldApplyEditPlaybackRange =
    deck === 'top' &&
    isEditMode.value &&
    runtime.setting.enablePlaybackRange === true &&
    !Number.isFinite(transportOptions?.initialCurrentSec)
  const resolvedTransportOptions = shouldApplyEditPlaybackRange
    ? {
        ...(transportOptions || {}),
        initialCurrentSec: resolveInitialPlaybackRangeStartSec(
          runtime.setting,
          song.songStructure,
          parseHorizontalBrowseDurationToSeconds(song.duration)
        )
      }
    : transportOptions
  await assignSongToDeckBase(deck, song, resolvedTransportOptions)
}

const {
  deckPendingPlayVisible,
  deckPendingCuePreviewOnLoad,
  suppressDeckCueClick,
  isDeckWaveformDragging,
  resolveDeckWaveformDragAnchorSec,
  resolveDeckCuePreviewRuntimeState,
  resolveDeckLoopRange,
  resolveDeckLoopBeatLabel,
  resolveDeckLoopDisabled,
  isDeckLoopActive,
  handleDeckLoopToggle,
  handleDeckLoopStepDown,
  handleDeckLoopStepUp,
  handleDeckLoopPlaybackTick,
  handleDeckRawWaveformDragStart: startDeckRawWaveformDrag,
  handleDeckRawWaveformScrubPreview: previewDeckRawWaveformScrub,
  handleDeckRawWaveformDragEnd: endDeckRawWaveformDrag,
  handleDeckPlayheadSeek: nativeHandleDeckPlayheadSeek,
  handleDeckSectionSeekPlay: nativeHandleDeckSectionSeekPlay,
  handleDeckBarJump,
  handleDeckPhraseJump,
  handleDeckBeatJump: nativeHandleDeckBeatJump,
  handleDeckSeekPercent: nativeHandleDeckSeekPercent,
  buildDeckStoredCueDefinition,
  handleDeckMemoryCueRecall,
  handleDeckHotCueRecall,
  stopAllDeckCuePreview,
  handleWindowDeckCuePointerUp,
  handleDeckCuePointerDown,
  handleDeckCueClick,
  handleDeckCueHotkeyDown,
  handleDeckCueHotkeyUp,
  handleDeckPlayPauseToggle: nativeHandleDeckPlayPauseToggle
} = useHorizontalBrowseDeckTransportInteractions({
  touchDeckInteraction,
  notifyDeckSeekIntent: notifyDeckSeekPresentationIntent,
  holdDeckRenderCurrentSeconds,
  startDeckRenderPlaybackClock,
  prepareDeckStableFrameForAnchor,
  nativeTransport,
  syncDeckRenderState,
  commitLinkedGridVisualTransaction,
  beginLinkedGridVisualTransaction,
  cancelLinkedGridVisualTransaction,
  commitDeckStatesToNative,
  resolveDeckSong,
  resolveDeckGridBpm,
  resolveDeckDurationSeconds,
  resolveDeckCurrentSeconds,
  resolveDeckRenderCurrentSeconds,
  resolveDeckPlaying,
  resolveDeckLoaded,
  resolveTransportDeckSnapshot,
  resolveDeckCuePointRef,
  resolveDeckCuePlacementSec,
  resolveBrowseViewMode: () => horizontalBrowseViewMode.value,
  resolveDualTransportSyncEnabled: () =>
    dualTransportSyncEnabled.value && canUseDualTransportSync.value,
  ensureDualTransportSync: activateDualTransportSync,
  deactivateDualTransportSync
})
const {
  handleDeckRawWaveformDragStart: startNativeRawWaveformDrag,
  handleDeckRawWaveformScrubPreview: previewNativeRawWaveformDrag,
  handleDeckRawWaveformDragEnd: endNativeRawWaveformDrag,
  markDetailZoomPresentation
} = createHorizontalBrowseWaveformPresentationShellBridge({
  presentation: waveformPresentation,
  resolveLinkedDragActive: () =>
    !isEditMode.value && dualTransportSyncEnabled.value && canUseDualTransportSync.value,
  resolveZoomLinked: () => horizontalBrowseViewMode.value !== 'edit',
  resolveDeckRenderCurrentSeconds,
  resolveDeckWaveformDragAnchorSec,
  startDeckRawWaveformDrag,
  previewDeckRawWaveformScrub,
  endDeckRawWaveformDrag
})
const {
  editBeatStep,
  canPreviousEditSong,
  canNextEditSong,
  loadEditAdjacentSong: nativeLoadEditAdjacentSong,
  jumpEditDeckByBeats: nativeJumpEditDeckByBeats
} = useHorizontalBrowseEditDeckNavigation({
  topDeckSong,
  assignSongToDeck,
  handleDeckBeatJump: nativeHandleDeckBeatJump,
  resolveDeckPlaying,
  handleDeckPlayPauseToggle: nativeHandleDeckPlayPauseToggle
})
const {
  audioEdit,
  gridEditMode,
  topDeckVisibleCurrentSeconds,
  topDeckVisibleDurationSeconds,
  topDeckVisiblePlaying,
  handleDeckPlayPauseToggle,
  handleDeckPlayheadSeek,
  handleDeckSectionSeekPlay,
  handleDeckSeekPercent,
  handleDeckRawWaveformDragStart,
  handleDeckRawWaveformScrubPreview,
  handleDeckRawWaveformDragEnd,
  loadEditAdjacentSong,
  jumpEditDeckByBeats
} = useHorizontalBrowseAudioEditShell({
  isEditMode,
  topDeckSong,
  sourceDurationSec: topDeckDurationSeconds,
  quantizeEnabled: editQuantizeEnabled,
  nativePlaying: topDeckUiPlaying,
  nativeSeconds: topDeckRenderCurrentSeconds,
  nativePlayToggle: nativeHandleDeckPlayPauseToggle,
  nativeSeek: nativeHandleDeckPlayheadSeek,
  nativeSeekPercent: nativeHandleDeckSeekPercent,
  nativeSectionSeekPlay: nativeHandleDeckSectionSeekPlay,
  nativeLoadEditAdjacentSong,
  nativeJumpEditDeckByBeats,
  editBeatStep,
  resolveDeckPlaying,
  assignSongToDeck,
  nativeTransport,
  notifySeekIntent: (seconds) => notifyDeckSeekPresentationIntent('top', seconds),
  nativeRawWaveformDragStart: startNativeRawWaveformDrag,
  nativeRawWaveformScrubPreview: previewNativeRawWaveformDrag,
  nativeRawWaveformDragEnd: endNativeRawWaveformDrag,
  resolveCuePointSec: () => topDeckCuePointSeconds.value,
  resolveLoopRange: () => resolveDeckLoopRange('top')
})
const handleTopDeckEjectSong = () => {
  if (isEditMode.value) {
    audioEdit.handleContextChange(() => handleDeckEjectSong('top'))
    return
  }
  void handleDeckEjectSong('top')
}
const { playbackRangeOverlay, handleDeckPlaybackTick } = useHorizontalBrowseEditPlaybackRange({
  runtime,
  isEditMode,
  topDeckSong: audioEdit.displaySong,
  currentSeconds: topDeckVisibleCurrentSeconds,
  durationSeconds: topDeckVisibleDurationSeconds,
  resolvePlaying: () => topDeckVisiblePlaying.value,
  resolveLoopActive: () => isDeckLoopActive('top'),
  seek: (seconds) => handleDeckPlayheadSeek('top', seconds),
  seekAndPlay: (seconds) => handleDeckSectionSeekPlay('top', seconds),
  pause: () => topDeckVisiblePlaying.value && handleDeckPlayPauseToggle('top'),
  advanceToNextSong: () => Boolean(loadEditAdjacentSong(1)),
  handleLoopPlaybackTick: handleDeckLoopPlaybackTick,
  customRangeSec: audioEdit.session.playbackRange,
  setCustomRangeSec: audioEdit.session.setPlaybackRange
})
const { handleDeckHotCuePress, handleDeckHotCueDelete, handleSongHotCuesUpdated } =
  useHorizontalBrowseDeckHotCues({
    resolveDeckSong,
    setDeckSong,
    resolveDeckMarkerPlacementSec: resolveDeckMarkerPlacementSeconds,
    resolveDeckPlaying,
    resolveDeckDurationSeconds,
    resolveTransportDeckSnapshot,
    buildDeckStoredCueDefinition,
    handleDeckHotCueRecall,
    nativeTransport,
    commitDeckStatesToNative,
    syncDeckRenderState,
    isDeckLoopActive
  })
const {
  handleDeckMemoryCueCreate,
  handleDeckMemoryCueDelete,
  handleDeckMemoryCueRecallPress,
  handleSongMemoryCuesUpdated
} = useHorizontalBrowseDeckMemoryCues({
  resolveDeckSong,
  setDeckSong,
  buildDeckStoredCueDefinition,
  handleDeckMemoryCueRecall
})
const handleDeckEjectSong = createHorizontalBrowseDeckEjectHandler({
  resolveDeckCuePreviewRuntimeState,
  resolveTransportDeckSnapshot,
  nativeTransport,
  setDeckSong,
  commitDeckStateToNative,
  suppressDeckCueClick
})
const handleDeckQuantizeToggle = (deck: DeckKey) => {
  touchDeckInteraction(deck)
  toggleDeckQuantize(deck)
}
const handleSharedDetailZoomChange = (payload: HorizontalBrowseDetailZoomChangePayload) => {
  const numeric = Number(payload?.value)
  if (!Number.isFinite(numeric) || numeric <= 0) return
  sharedDetailZoomState.value = {
    value: Math.max(
      HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
      Math.min(HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM, numeric)
    ),
    anchorRatio: Math.max(0, Math.min(1, Number(payload?.anchorRatio) || 0)),
    sourceDirection: payload?.sourceDirection || null,
    revision: sharedDetailZoomState.value.revision + 1
  }
}
const handleEditDetailZoomChange = (payload: HorizontalBrowseDetailZoomChangePayload) => {
  const numeric = Number(payload?.value)
  if (!Number.isFinite(numeric) || numeric <= 0) return
  editDetailZoomState.value = {
    value: Math.max(
      HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
      Math.min(HORIZONTAL_BROWSE_EDIT_DETAIL_MAX_ZOOM, numeric)
    ),
    anchorRatio: Math.max(0, Math.min(1, Number(payload?.anchorRatio) || 0)),
    sourceDirection: payload?.sourceDirection || null,
    revision: editDetailZoomState.value.revision + 1
  }
}
const handleDetailZoomChange = (payload: HorizontalBrowseDetailZoomChangePayload) => {
  if (!markDetailZoomPresentation(payload)) return
  if (horizontalBrowseViewMode.value === 'edit') {
    handleEditDetailZoomChange(payload)
    return
  }
  handleSharedDetailZoomChange(payload)
}
const shouldPreserveGridShiftPhase = (deck: DeckKey) => {
  const snapshot = resolveTransportDeckSnapshot(deck)
  return snapshot.syncEnabled && snapshot.syncLock === 'full'
}
const {
  handleToolbarStateChange,
  handleDeckSetDownbeatLineAtPlayhead,
  handleDeckGridShiftLargeLeft,
  handleDeckGridShiftSmallLeft,
  handleDeckGridShiftSmallRight,
  handleDeckGridShiftLargeRight,
  handleDeckMetronomeStateCycle,
  handleDeckBpmTap,
  handleDeckBpmInputUpdate,
  handleDeckBpmInputLive,
  handleDeckBpmInputBlur,
  handleDeckSelectWholeAdjustment,
  handleDeckSplitAfterPlayhead,
  handleDeckDeleteBoundary
} = useHorizontalBrowseDeckToolbarInteractions({
  topDeckToolbarState,
  bottomDeckToolbarState,
  deckTempoInputDirty,
  deckTempoCommitToken,
  touchDeckInteraction,
  resolveDetailRef,
  resolveDeckToolbarBpmInputValue,
  shouldPreserveGridShiftPhase,
  shouldCommitBpmInputAsGridEdit: (deck) => isEditMode.value && deck === 'top',
  scheduleDeckLiveTargetBpm,
  commitDeckTargetBpm,
  cancelDeckLiveTargetBpm
})

const resolveDeckSyncUiEnabled = (deck: DeckKey) =>
  resolveHorizontalBrowseDeckSyncUiEnabled(
    Boolean(resolveDeckSong(deck)),
    resolveTransportDeckSnapshot(deck).syncEnabled,
    resolveDeckCuePreviewRuntimeState(deck).active,
    resolveDeckCuePreviewRuntimeState(deck).syncEnabledBefore
  )

const resolveDeckToolbarState = (deck: DeckKey) => {
  const toolbarState = buildHorizontalBrowseDeckToolbarState(
    deck === 'top' ? topDeckToolbarState.value : bottomDeckToolbarState.value,
    resolveDeckToolbarBpmInputValue(deck),
    {
      loopBeatLabel: resolveDeckLoopBeatLabel(deck),
      loopActive: isDeckLoopActive(deck),
      loopDisabled: resolveDeckLoopDisabled(deck),
      bpmInputTitle: t(
        isEditMode.value ? EDIT_MODE_BPM_INPUT_TITLE : DUAL_MODE_BPM_INPUT_TITLE
      ),
      bpmInputFirst: isEditMode.value,
      showTapButton: isEditMode.value,
      tapBpmTitle: isEditMode.value ? t(EDIT_MODE_TAP_BPM_TITLE) : ''
    }
  )
  const editSaving = isEditMode.value && deck === 'top' && audioEdit.saving.value
  return {
    ...toolbarState,
    disabled: toolbarState.disabled || editSaving,
    // 双轨的 BPM 是 transport 临时速度目标，不能被只读网格/细节波形的状态禁用。
    bpmInputDisabled: editSaving
      ? true
      : isEditMode.value
        ? toolbarState.bpmInputDisabled
        : !resolveDeckSong(deck)?.filePath,
    gridControlsDisabled: toolbarState.gridControlsDisabled || editSaving,
    // 外部曲目的网格属于 Rekordbox；双轨只保留临时速度控制，隐藏无效的网格工具。
    showGridControls: isEditMode.value
      ? audioEdit.subMode.value === 'grid'
      : !isRekordboxExternalPlaybackSource('', resolveDeckSong(deck)),
    showMetronome: isEditMode.value || !isRekordboxExternalPlaybackSource('', resolveDeckSong(deck))
  }
}

useHorizontalBrowseModeShellHotkeys({
  runtime,
  onPlayerInteraction: handlePlayerInteraction,
  touchDeckInteraction,
  resolveDeckSong,
  ejectDeckSong: handleDeckEjectSong,
  openDeckMoveDialog,
  onTogglePlayPause: handleDeckPlayPauseToggle,
  onCueKeyDown: (deck) => (isEditMode.value ? false : handleDeckCueHotkeyDown(deck)),
  onCueKeyUp: (deck) => {
    if (!isEditMode.value) handleDeckCueHotkeyUp(deck)
  },
  onJumpBar: handleDeckBarJump,
  onJumpPhrase: handleDeckPhraseJump,
  onJumpEditBeats: jumpEditDeckByBeats,
  onSeekPercent: handleDeckSeekPercent,
  faderPanel: faderPanelRef,
  onNavigateEditSong: loadEditAdjacentSong,
  guardSongContextChange: (action) => {
    if (isEditMode.value) return audioEdit.handleContextChange(action)
    void action()
    return true
  }
})

const {
  isDeckHovered,
  handleRegionDragEnter,
  handleRegionDragOver,
  handleRegionDragLeave,
  handleRegionDrop,
  handleGlobalDragFinish
} = useHorizontalBrowseDeckDrop({
  resolveSongsAreaStateBySongListUUID,
  resolveSongListSnapshot,
  assignSongToDeck
})

const {
  disposeSongSync,
  handleExternalDeckSongLoad,
  handleSongGridBatchUpdated,
  handleSongGridUpdated,
  handleSongKeyUpdated,
  handleSongStructureUpdated
} = useHorizontalBrowseDeckSongSync({
  topDeckSong,
  bottomDeckSong,
  resolveDeckSong,
  setDeckSong,
  syncDeckDefaultCue,
  setDeckBeatGridToNative: (deck, payload) => nativeTransport.setBeatGrid(deck, payload),
  assignSongToDeck
})

const handleSharedGridBatchUpdated = (
  payloads: Array<{
    filePath?: string
    timeBasisOffsetMs?: number
    beatGridMap?: ISongInfo['beatGridMap'] | null
  }>
) => {
  handleSongGridBatchUpdated(undefined, payloads)
}

watch(
  () => deckSyncState.leaderDeck,
  (leaderDeck) => {
    runtime.horizontalBrowseDecks.leaderDeck =
      leaderDeck === 'top' || leaderDeck === 'bottom' ? leaderDeck : null
  },
  { immediate: true }
)

const {
  handleEditWaveformLoadingChange,
  handleMainWindowPlaybackSnapshotRequest,
  markPlaybackHandoffReady,
  clearPlaybackHandoffRuntimeState,
  syncDeckDataToPlayingData
} = useHorizontalBrowseModePlaybackHandoff({
  runtime,
  horizontalBrowseViewMode,
  deckSyncState,
  faderPanelRef,
  clearAllDeckCueMonitor,
  stopAllDeckCuePreview,
  resetAllDeckTempoNudgePlaybackRates,
  deactivateDualTransportSync,
  nativeTransport,
  resolveDeckSong,
  resolveDeckPlaying,
  resolveDeckCurrentSeconds,
  resolveDeckRenderCurrentSeconds,
  resolveDeckDurationSeconds,
  resolveTransportDeckSnapshot,
  setDeckSong,
  assignSongToDeck,
  notifyDeckSeekIntent: notifyDeckSeekPresentationIntent,
  commitDeckStateToNative,
  syncDeckRenderState,
  handleDeckPlayPauseToggle
})

const { handleSongsRemoved } = useHorizontalBrowseSongsRemoved({
  resolveDeckSong,
  handleDeckEjectSong
})

const waveformStackModel: HorizontalBrowseModeShellWaveformStackModel = {
  isEditMode,
  topDeckSong,
  bottomDeckSong,
  deckSyncState,
  deckKeysHarmonicMatched,
  topDeckVisibleCurrentSeconds,
  topDeckVisibleDurationSeconds,
  topDeckVisiblePlaying,
  bottomDeckRenderCurrentSeconds,
  bottomDeckDurationSeconds,
  bottomDeckUiPlaying,
  audioEdit,
  playbackRangeOverlay,
  deckQuantizeEnabled,
  topDeckWaveformPlaybackActive,
  bottomDeckWaveformPlaybackActive,
  topDeckPlaybackRate,
  bottomDeckPlaybackRate,
  topDeckPlaybackSyncRevision,
  bottomDeckPlaybackSyncRevision,
  topDeckGridBpm,
  bottomDeckGridBpm,
  topDeckCuePointSeconds,
  bottomDeckCuePointSeconds,
  deckSeekIntent,
  sharedDetailZoomState,
  editDetailZoomState,
  gridEditMode,
  waveformPresentation,
  isDeckHovered,
  resolveDeckSyncUiEnabled,
  resolveDeckToolbarState,
  resolveDeckLoopRange,
  isDeckSongReadOnly,
  isDeckMasterTempoEnabled,
  resolveDeckTempoNudgeDirection,
  handleRegionDragEnter,
  handleRegionDragOver,
  handleRegionDragLeave,
  handleRegionDrop,
  triggerDeckBeatSync,
  toggleDeckMaster,
  handleTopDeckEjectSong,
  handleDeckEjectSong,
  handleDeckPlayheadSeek,
  handleDeckSectionSeekPlay,
  handleDeckSetDownbeatLineAtPlayhead,
  handleDeckGridShiftLargeLeft,
  handleDeckGridShiftSmallLeft,
  handleDeckGridShiftSmallRight,
  handleDeckGridShiftLargeRight,
  handleDeckBpmInputUpdate,
  handleDeckBpmInputLive,
  handleDeckBpmInputBlur,
  handleDeckBpmTap,
  handleDeckMemoryCueCreate,
  handleDeckSelectWholeAdjustment,
  handleDeckSplitAfterPlayhead,
  handleDeckDeleteBoundary,
  handleDeckMetronomeStateCycle,
  handleDeckLoopStepDown,
  handleDeckLoopStepUp,
  handleDeckLoopToggle,
  handleDeckMasterTempoToggle,
  resetDeckTempo,
  handleDeckQuantizeToggle,
  startDeckTempoNudge,
  stopDeckTempoNudge,
  openDeckMoveDialog,
  resolveDeckPlaybackRateForTransport,
  resolveDeckWaveformGain,
  isDeckWaveformDragging,
  resolveDeckWaveformDragAnchorSec,
  shouldPreserveGridShiftPhase,
  handleToolbarStateChange,
  handleDetailZoomChange,
  handleDeckRawWaveformDragStart,
  handleDeckRawWaveformScrubPreview,
  handleDeckRawWaveformDragEnd,
  handleEditWaveformLoadingChange,
  handleDeckHotCuePress,
  handleDeckHotCueDelete,
  handleDeckMemoryCueRecallPress,
  handleDeckMemoryCueDelete
}

onMounted(() => {
  startSnapshotSync()
  void nativeTransport.reset().finally(() => {
    faderPanelRef.value?.syncCrossfaderValue(0)
    syncCurrentVolume()
    markPlaybackHandoffReady()
  })
  startRenderSyncLoop(handleDeckPlaybackTick)
  window.addEventListener('drop', handleGlobalDragFinish, true)
  window.addEventListener('dragend', handleGlobalDragFinish, true)
  window.addEventListener('pointerup', handleWindowDeckCuePointerUp)
  window.addEventListener('pointercancel', handleWindowDeckCuePointerUp)
  window.addEventListener('blur', stopAllDeckCuePreview)
  emitter.on(MAIN_WINDOW_PLAYBACK_SNAPSHOT_REQUEST_EVENT, handleMainWindowPlaybackSnapshotRequest)
  emitter.on('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  emitter.on('songsRemoved', handleSongsRemoved)
  emitter.on('horizontalBrowse/shared-grid-batch-updated', handleSharedGridBatchUpdated)
  window.electron.ipcRenderer.on('song-grid-batch-updated', handleSongGridBatchUpdated)
  window.electron.ipcRenderer.on('song-grid-updated', handleSongGridUpdated)
  window.electron.ipcRenderer.on('song-key-updated', handleSongKeyUpdated)
  window.electron.ipcRenderer.on('song-structure-updated', handleSongStructureUpdated)
  window.electron.ipcRenderer.on('song-hot-cues-updated', handleSongHotCuesUpdated)
  window.electron.ipcRenderer.on('song-memory-cues-updated', handleSongMemoryCuesUpdated)
})

onUnmounted(() => {
  stopAllDeckCuePreview()
  stopAllDeckTempoNudge()
  clearPlaybackHandoffRuntimeState()
  stopSnapshotSync()
  void nativeTransport.reset().catch((error) => {
    console.error('[horizontal-browse] reset transport failed on exit', error)
  })
  stopRenderSyncLoop()
  clearDeckRecentInteractionTimer('top')
  clearDeckRecentInteractionTimer('bottom')
  window.removeEventListener('drop', handleGlobalDragFinish, true)
  window.removeEventListener('dragend', handleGlobalDragFinish, true)
  window.removeEventListener('pointerup', handleWindowDeckCuePointerUp)
  window.removeEventListener('pointercancel', handleWindowDeckCuePointerUp)
  window.removeEventListener('blur', stopAllDeckCuePreview)
  disposeSongSync()
  emitter.off(MAIN_WINDOW_PLAYBACK_SNAPSHOT_REQUEST_EVENT, handleMainWindowPlaybackSnapshotRequest)
  emitter.off('horizontalBrowse/load-song', handleExternalDeckSongLoad)
  emitter.off('songsRemoved', handleSongsRemoved)
  emitter.off('horizontalBrowse/shared-grid-batch-updated', handleSharedGridBatchUpdated)
  window.electron.ipcRenderer.removeListener('song-grid-batch-updated', handleSongGridBatchUpdated)
  window.electron.ipcRenderer.removeListener('song-grid-updated', handleSongGridUpdated)
  window.electron.ipcRenderer.removeListener('song-key-updated', handleSongKeyUpdated)
  window.electron.ipcRenderer.removeListener('song-structure-updated', handleSongStructureUpdated)
  window.electron.ipcRenderer.removeListener('song-hot-cues-updated', handleSongHotCuesUpdated)
  window.electron.ipcRenderer.removeListener(
    'song-memory-cues-updated',
    handleSongMemoryCuesUpdated
  )
  syncDeckDataToPlayingData()
  runtime.horizontalBrowseDecks.topSong = null
  runtime.horizontalBrowseDecks.bottomSong = null
  runtime.horizontalBrowseDecks.leaderDeck = null
  clearAllDeckSongListSources()
})
</script>

<template>
  <div
    class="horizontal-shell"
    :class="{
      'is-edit-mode': isEditMode,
      'is-light-theme': isLightTheme,
      'is-fader-controls-expanded': faderControlsExpanded && !isEditMode
    }"
    @pointerdown.capture="handlePlayerInteraction"
    @wheel.capture="handlePlayerInteraction"
    @keydown.capture="handlePlayerInteraction"
    @drop.capture="handlePlayerInteraction"
  >
    <div class="controls" :class="{ 'controls--edit': isEditMode }">
      <HorizontalBrowseEditDeckControls
        v-if="isEditMode"
        v-model:beat-step="editBeatStep"
        :song-present="!!topDeckSong"
        :can-previous-song="canPreviousEditSong"
        :can-next-song="canNextEditSong"
        :disabled="audioEdit.saving.value"
        @previous-song="loadEditAdjacentSong(-1)"
        @next-song="loadEditAdjacentSong(1)"
        @jump-beats="jumpEditDeckByBeats"
      />

      <HorizontalBrowseDeckControlRow
        deck="top"
        :playing="isEditMode ? topDeckVisiblePlaying && !topDeckCueActive : topDeckPlayButtonActive"
        :decoding="topDeckUiDecoding || (isEditMode && audioEdit.playback.preparing.value)"
        :pending-play="deckPendingPlayVisible.top"
        :pending-cue="deckPendingCuePreviewOnLoad.top"
        :cue-active="topDeckCueActive"
        :bands-visible="faderControlsExpanded && !isEditMode"
        :bands="deckBandState.top"
        :song-present="!!topDeckSong"
        :disabled="isEditMode && audioEdit.saving.value"
        :show-cue="!isEditMode"
        :cue-monitor-enabled="deckCueMonitorState.top"
        @cue-pointer-down="handleDeckCuePointerDown('top', $event)"
        @cue-click="handleDeckCueClick('top')"
        @play-toggle="handleDeckPlayPauseToggle('top')"
        @toggle-band="handleDeckBandToggle"
        @toggle-cue-monitor="handleDeckCueMonitorToggle"
      />

      <HorizontalBrowseFaderPanel
        v-if="!isEditMode"
        ref="faderPanelRef"
        v-model:expanded="faderControlsExpanded"
        :native-transport="nativeTransport"
        :main-window-volume="mainWindowVolume"
        :transport-sync-enabled="dualTransportSyncEnabled || dualTransportSyncActivating"
        :transport-sync-disabled="
          !canUseDualTransportSync || dualTransportSyncActivating || dualTransportSyncDeactivating
        "
        @toggle-transport-sync="handleDualTransportSyncToggle"
      />

      <HorizontalBrowseDeckControlRow
        v-if="!isEditMode"
        deck="bottom"
        :playing="bottomDeckPlayButtonActive"
        :decoding="bottomDeckUiDecoding"
        :pending-play="deckPendingPlayVisible.bottom"
        :pending-cue="deckPendingCuePreviewOnLoad.bottom"
        :cue-active="bottomDeckCueActive"
        :bands-visible="faderControlsExpanded"
        :bands="deckBandState.bottom"
        :song-present="!!bottomDeckSong"
        :show-cue="true"
        :cue-monitor-enabled="deckCueMonitorState.bottom"
        @cue-pointer-down="handleDeckCuePointerDown('bottom', $event)"
        @cue-click="handleDeckCueClick('bottom')"
        @play-toggle="handleDeckPlayPauseToggle('bottom')"
        @toggle-band="handleDeckBandToggle"
        @toggle-cue-monitor="handleDeckCueMonitorToggle"
      />
    </div>

    <HorizontalBrowseModeShellWaveformStack ref="waveformStackRef" :model="waveformStackModel" />

    <HorizontalBrowseAudioEditChrome
      v-if="isEditMode"
      :save-open="audioEdit.saveOpen.value"
      :leave-open="audioEdit.leaveOpen.value"
      :original-title="String(topDeckSong?.title || topDeckSong?.fileName || '')"
      :original-format="audioEdit.originalFormat.value"
      :version-preview-name="audioEdit.versionPreviewName.value"
      :lossless-source="audioEdit.losslessSource.value"
      @confirm-save="void audioEdit.commitSave($event)"
      @cancel-save="audioEdit.cancelSave()"
      @leave-save="audioEdit.finishLeave('save')"
      @leave-discard="audioEdit.finishLeave('discard')"
      @leave-cancel="audioEdit.finishLeave('cancel')"
    />
    <HorizontalBrowseDeckMoveDialog
      :visible="selectSongListDialogVisible"
      :library-name="selectSongListDialogTargetLibraryName"
      :action-mode="selectSongListDialogActionMode"
      @confirm="handleDeckMoveSong"
      @cancel="handleDeckMoveDialogCancel"
    />
  </div>
</template>

<style scoped lang="scss" src="./HorizontalBrowseModeShell.scss"></style>
