<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { normalizeSongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
  HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR
} from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { useHorizontalBrowseGridToolbar } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseGridToolbar'
import { useMixtapeBeatAlignGridAdjust } from '@renderer/components/mixtapeBeatAlignGridAdjust'
import { useMixtapeBeatAlignMetronome } from '@renderer/components/mixtapeBeatAlignMetronome'
import {
  PREVIEW_DOWNBEAT_BEAT_INTERVAL,
  clampNumber
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { useHorizontalBrowseRawWaveformCanvas } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRawWaveformCanvas'
import { resolveHorizontalBrowseEffectiveTimelineEndSec } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformTimeline'
import { useHorizontalBrowseCompactVisualWaveformStrip } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseCompactVisualWaveformStrip'
import { useHorizontalBrowseWaveformScrubPreview } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseWaveformScrubPreview'
import type {
  HorizontalBrowseRawWaveformDetailEmit,
  HorizontalBrowseRawWaveformDetailProps
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailTypes'
import type {
  HorizontalBrowseLinkedGridVisualTransactionCommitOptions,
  HorizontalBrowseLinkedGridVisualTransactionDeckState
} from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedGridVisualTransaction'
import { createHorizontalBrowseRawWaveformDetailExpose } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailExpose'
import {
  applyHorizontalBrowseLiveTempoPreviewTransform,
  resolveHorizontalBrowseLiveTempoPreviewReleasePlan,
  shouldFinishHorizontalBrowseLiveTempoPreviewRelease
} from '@renderer/composables/horizontalBrowse/horizontalBrowseLiveTempoPreview'
import { useHorizontalBrowseAudioEditDetailRaw } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseAudioEditDetailRaw'
import { isHorizontalBrowseWaveformTileRenderingEnabled } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformTileFlag'
import { HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformTileLayout'
import {
  createPioneerDetailRawWaveform,
  type PioneerDetailWaveformData
} from '@renderer/composables/horizontalBrowse/horizontalBrowsePioneerDetailWaveform'
import { useHorizontalBrowseRawWaveformAudioEditOverlay } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRawWaveformAudioEditOverlay'
import {
  useHorizontalBrowseRawWaveformDetailLifecycle,
  watchHorizontalBrowseRawWaveformLoadingChange
} from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRawWaveformDetailLifecycle'
import { resolveAudioEditDisplayBeatGridMap } from '@shared/audioEditBeatGrid'
import {
  createHorizontalBrowsePlaybackDiscontinuityDetector,
  normalizeHorizontalBrowseTimelineSeconds
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailMath'
import { createHorizontalBrowseStablePlaybackReanchorGate } from '@renderer/composables/horizontalBrowse/horizontalBrowseStableCanvasJump'
import { createHorizontalBrowseDragReleaseHandoff } from '@renderer/composables/horizontalBrowse/horizontalBrowseDragReleaseHandoff'
import { createHorizontalBrowseStableInteractionHandoff } from '@renderer/composables/horizontalBrowse/horizontalBrowseStableInteractionHandoff'
import { createHorizontalBrowseWaveformPointerInteraction } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformPointerInteraction'
import { createHorizontalBrowseDetailPresentationState } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailPresentationState'
import { createHorizontalBrowseDetailPresentationActions } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailPresentationActions'
import { createHorizontalBrowseDetailGridPersistence } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailGridPersistence'
import { createHorizontalBrowseDetailPresentationConsumer } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailPresentationConsumer'
import { useHorizontalBrowseDynamicBeatGridEdit } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDynamicBeatGridEdit'
import {
  getRekordboxDetailWaveformRequestChannel,
  isRekordboxExternalPlaybackSource,
  resolveSongExternalWaveformSource
} from '@renderer/utils/rekordboxExternalSource'
import { createHorizontalBrowseNativeMetronomeSync } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeMetronome'
import {
  createHorizontalBrowseRawWaveformDynamicGridSelectionState,
  watchHorizontalBrowseRawWaveformDynamicGridSelection
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDynamicGridSelection'
import type { SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'

const HORIZONTAL_BROWSE_TIMELINE_TAIL_TOLERANCE_SEC = 0.75
const props = defineProps<HorizontalBrowseRawWaveformDetailProps>()
const emit = defineEmits<HorizontalBrowseRawWaveformDetailEmit>()
const runtime = useRuntimeStore()
const rawData = ref<RawWaveformData | null>(null)
const sourceRawData = ref<RawWaveformData | null>(null)
const mixxxData = ref<MixxxWaveformData | null>(null)
const previewLoading = ref(false)
const previewStartSec = ref(0)
const dragging = ref(false)
const previewDownbeatBeatOffset = ref(0)
const previewFirstBeatMs = ref(0)
const previewTimeBasisOffsetMs = ref(0)
const previewBpm = ref(0)
const previewBpmInput = ref('')
const previewBeatGridMap = ref<SongBeatGridMapV2 | null>(null)
const bpmTapTimestamps = ref<number[]>([])
const previewZoom = ref(HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
const compactVisualWaveformActive = ref(false)
// 分块渲染 flag。关闭时块容器与块画布完全不渲染进 DOM，走原有单张超宽 canvas 路径。
const waveformTileRenderingEnabled = isHorizontalBrowseWaveformTileRenderingEnabled()
const waveformTileSlotIndexes = Array.from(
  { length: HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT },
  (_unused, index) => index
)
const waveformTempoScalerRef = ref<HTMLDivElement | null>(null)
const waveformTempoScalerBackRef = ref<HTMLDivElement | null>(null)
const overlayTempoScalerRef = ref<HTMLDivElement | null>(null)
const overlayTempoScalerBackRef = ref<HTMLDivElement | null>(null)
const previewPlaying = ref(false)
const localGridShiftPhaseOffsetSec = ref(0)
const playbackSyncRevision = computed(() =>
  Math.max(0, Math.floor(Number(props.playbackSyncRevision) || 0))
)
let lastPresentationStableRenderRevision = 0
const stableRenderRevision = computed(() => {
  const state = props.presentationState
  const presentationRevision = Math.max(0, Math.floor(Number(state?.revision) || 0))
  if (
    state?.owner === 'linked-playback' ||
    state?.owner === 'seek' ||
    state?.owner === 'drag' ||
    state?.owner === 'linked-drag'
  ) {
    lastPresentationStableRenderRevision = presentationRevision
    return presentationRevision
  }
  if (
    state?.owner === 'sync-transaction' ||
    (state?.owner === 'playback' &&
      state.sourceDeck === null &&
      state.visualPending === false &&
      lastPresentationStableRenderRevision > 0) ||
    state?.visualPending === true ||
    props.linkedGridVisualPending === true
  ) {
    return lastPresentationStableRenderRevision
  }
  lastPresentationStableRenderRevision = 0
  return 0
})
const waveformPlaybackActive = computed(() => Boolean(props.playbackActive ?? props.playing))
// macOS 上播放期间不使用超宽稳定 Canvas 的 CSS transform 路径；
// 交给已有 Worker 增量滚动渲染，避免 Metal 合成超宽纹理时出现抽动。
const resolveCanvasStableWaveformSource = () =>
  compactVisualWaveformActive.value &&
  (runtime.setting.platform !== 'darwin' || !waveformPlaybackActive.value)
const isRekordboxReadOnlySong = computed(() => isRekordboxExternalPlaybackSource('', props.song))
const externalDetailWaveformUnavailable = computed(
  () => isRekordboxReadOnlySong.value && !rawData.value
)

const gridEditingEnabled = computed(
  () =>
    props.gridEditMode === true &&
    props.interactionDisabled !== true &&
    !isRekordboxReadOnlySong.value
)
const presentationLinkedDragActive = computed(
  () => Boolean(props.linkedDragActive) || props.presentationState?.owner === 'linked-drag'
)
const presentationLinkedDragAnchorSec = computed(() => {
  const stateAnchor = Number(props.presentationState?.anchorSec)
  if (props.presentationState?.owner === 'linked-drag' && Number.isFinite(stateAnchor)) {
    return stateAnchor
  }
  return props.linkedDragAnchorSec ?? null
})
const presentationLinkedGridActive = computed(
  () => props.linkedGridActive === true || props.presentationState?.linked === true
)
const presentationLinkedGridVisualPending = computed(
  () =>
    props.linkedGridVisualPending === true ||
    props.presentationState?.visualPending === true ||
    props.presentationState?.owner === 'sync-transaction'
)
const previewMaxZoom = computed(() => {
  const value = Number(props.maxZoom)
  return Number.isFinite(value) && value > HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM
    ? value
    : HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM
})
const resolveWaveformLayout = () =>
  props.waveformLayout === 'full' ? 'full' : props.direction === 'up' ? 'top-half' : 'bottom-half'
const resolveWaveformRenderStyle = () =>
  isRekordboxReadOnlySong.value
    ? 'columns'
    : props.waveformRenderStyle === 'raw-curve'
      ? 'raw-curve'
      : 'columns'
const resolveDetailDeck = () => (props.direction === 'up' ? 'top' : 'bottom')

const resolveWaveformCurrentSeconds = () =>
  normalizePreviewTimelineSeconds(
    (Number(props.currentSeconds) || 0) + localGridShiftPhaseOffsetSec.value
  )
const resolveWaveformPlaybackRate = () => Math.max(0.25, Number(props.playbackRate) || 1)

const resolveGridEditVisibleFromSec = () =>
  gridEditingEnabled.value ? selectedDynamicGridVisibleFromSec.value : null

let loadToken = 0
let liveTempoPreviewRateValue: number | null = null
let liveTempoPreviewReleasePendingScale: number | null = null
let displayedPreviewTimeScale = 1
const playbackDiscontinuityDetector = createHorizontalBrowsePlaybackDiscontinuityDetector()
let linkedGridVisualTransactionCommitted = false
const stablePlaybackReanchorGate = createHorizontalBrowseStablePlaybackReanchorGate()
const dynamicGridSelection = createHorizontalBrowseRawWaveformDynamicGridSelectionState()
const {
  selectedBoundarySec: selectedDynamicGridBoundarySec,
  selectedVisibleFromSec: selectedDynamicGridVisibleFromSec
} = dynamicGridSelection
const presentationState = createHorizontalBrowseDetailPresentationState({
  song: () => props.song,
  direction: () => props.direction,
  gridBpm: () => props.gridBpm,
  playbackRate: () => props.playbackRate,
  visualPlaybackRate: () => props.visualPlaybackRate,
  linkedGridActive: () => presentationLinkedGridActive.value,
  linkedGridVisualPending: () => presentationLinkedGridVisualPending.value,
  waveformLayout: resolveWaveformLayout,
  waveformPlaybackActive: () => waveformPlaybackActive.value,
  resolveWaveformCurrentSeconds,
  resolveWaveformPlaybackRate,
  previewBpm,
  previewFirstBeatMs,
  previewDownbeatBeatOffset,
  previewTimeBasisOffsetMs
})
const {
  previewRenderBpm,
  visualGridBpm,
  visualGridFirstBeatMs,
  visualGridDownbeatBeatOffset,
  visualGridTimeBasisOffsetMs,
  visualGridRenderBpm,
  resolveDisplayGridBpm,
  resolveIncomingPreviewTimeScale,
  resolveCanvasVisualPlaybackRate,
  syncVisualGridStateFromPreview,
  publishLinkedGridVisualPhaseSample
} = presentationState

const resolveDetailBeatGridMap = () =>
  resolveAudioEditDisplayBeatGridMap({
    sourceMap:
      previewBeatGridMap.value ??
      normalizeSongBeatGridMapV2(props.song?.beatGridMap, { allowSingleClip: true }) ??
      null,
    clips: props.audioEditClips,
    sourceDurationSec: Number(sourceRawData.value?.duration) || 0,
    fallback: {
      bpm: previewBpm.value,
      firstBeatMs: previewFirstBeatMs.value,
      downbeatBeatOffset: previewDownbeatBeatOffset.value
    }
  })

watch(
  () => [
    resolveDetailBeatGridMap()?.signature || '',
    props.audioEditClips?.map((clip) => `${clip.sourceStartSec}:${clip.sourceEndSec}`).join('|') ||
      ''
  ],
  () => {
    emit('display-beat-grid-change', resolveDetailBeatGridMap())
  },
  { immediate: true }
)

const {
  wrapRef,
  waveformSurfaceRef,
  waveformCanvasRef,
  waveformCanvasBackRef,
  waveformTileContainerRefs,
  waveformTileCanvasRefs,
  overlaySurfaceRef,
  overlayCanvasRef,
  overlayCanvasBackRef,
  resolvePreviewTimeScale,
  resolvePreviewDurationSec,
  resolveVisibleDurationSec,
  resolvePreviewAnchorSec,
  clampPreviewStart,
  resolvePlaybackAlignedStart,
  displayViewportStartSec,
  displayViewportDurationSec,
  resetWaveformRenderState,
  clearCanvas,
  invalidateWaveformTiles,
  mountWaveformCanvasWorker,
  scheduleDraw,
  scheduleGridOverlayDraw,
  resetGridRenderer,
  resetLiveWaveformData,
  stopLiveWaveformPlayback,
  measureStableCanvasPresentation,
  adoptStableCanvasRenderRevision,
  applyStableCanvasPresentation,
  startStableCanvasPlayback,
  stopStableCanvasPlayback,
  reanchorStableCanvasPlayback,
  hideStableCanvasPresentation,
  replaceLiveWaveformRaw,
  drawWaveformNow,
  beginDragCanvasPresentation,
  applyDragCanvasPresentationOffset,
  endDragCanvasPresentation,
  syncDragPresentationReleaseViewportStart,
  consumeDragPresentationReleaseRequiresFreshFrame,
  resolveRenderedCanvasViewportStartSec,
  dragPresentationReleaseActive,
  dispose: disposeWaveformCanvas
} = useHorizontalBrowseRawWaveformCanvas({
  song: () => props.song,
  direction: () => props.direction,
  cueSeconds: () => (props.song ? props.cueSeconds : undefined),
  hotCues: () => props.hotCues,
  memoryCues: () => props.memoryCues,
  loopRange: () => props.loopRange,
  // 音频编辑选区由 DOM 层绘制，避免 worker 帧延迟和双重叠色。
  audioEditSelection: () => null,
  audioEditPendingStartSec: () => null,
  audioEditPendingEndSec: () => null,
  currentSeconds: resolveWaveformCurrentSeconds,
  playbackRate: () => props.playbackRate,
  visualPlaybackRate: resolveCanvasVisualPlaybackRate,
  waveformGain: () => props.waveformGain,
  playing: previewPlaying,
  playbackSyncRevision,
  rawData,
  mixxxData,
  previewLoading,
  previewStartSec,
  previewZoom,
  previewBpm: visualGridRenderBpm,
  previewFirstBeatMs: visualGridFirstBeatMs,
  previewDownbeatBeatOffset: visualGridDownbeatBeatOffset,
  beatGridMap: resolveDetailBeatGridMap,
  rekordboxGridEntries: () =>
    isRekordboxExternalPlaybackSource('', props.song)
      ? props.song?.rekordboxGridEntries
      : undefined,
  beatGridEditMode: () => gridEditingEnabled.value,
  beatGridVisibleFromSec: resolveGridEditVisibleFromSec,
  beatGridSelectedBoundarySec: () => selectedDynamicGridBoundarySec.value,
  showGridClipBoundaries: () => !props.audioEditClips,
  previewTimeBasisOffsetMs: visualGridTimeBasisOffsetMs,
  dragging,
  allowNegativeTimeline: () => Boolean(props.allowNegativeTimeline),
  waveformLayout: resolveWaveformLayout,
  waveformRenderStyle: resolveWaveformRenderStyle,
  stableWaveformSource: resolveCanvasStableWaveformSource,
  stableRenderRevision: () => stableRenderRevision.value,
  linkedGridActive: () => presentationLinkedGridActive.value,
  phaseAwareScrollReuse: () => Math.abs(localGridShiftPhaseOffsetSec.value) > 0.000001,
  onPreparingPreviewTimeScale: (timeScale, renderTargetIndex) => {
    applyLiveTempoPreviewTransformForBuffer(renderTargetIndex, timeScale)
  },
  onPresentedPreviewTimeScale: (timeScale) => {
    displayedPreviewTimeScale = Math.max(0.25, Number(timeScale) || 1)
    if (
      shouldFinishHorizontalBrowseLiveTempoPreviewRelease(
        displayedPreviewTimeScale,
        liveTempoPreviewReleasePendingScale
      )
    ) {
      liveTempoPreviewReleasePendingScale = null
      liveTempoPreviewRateValue = null
    }
    syncLiveTempoPreviewTransform()
  }
})

presentationState.setLastAppliedPreviewTimeScale(
  Math.max(0.25, Number(resolvePreviewTimeScale()) || 1)
)
displayedPreviewTimeScale = presentationState.getLastAppliedPreviewTimeScale()

const applyLocalGridShiftPhaseCompensation = (deltaMs: number) => {
  const deltaSec = Number(deltaMs) / 1000
  if (!Number.isFinite(deltaSec) || Math.abs(deltaSec) <= 0) return
  localGridShiftPhaseOffsetSec.value += deltaSec
  if (!previewPlaying.value || dragging.value) {
    const compensatedSeconds = resolveWaveformCurrentSeconds()
    previewStartSec.value = resolvePlaybackAlignedStart(compensatedSeconds)
  }
}
const scrubPreview = useHorizontalBrowseWaveformScrubPreview({
  dragging,
  resolveAnchorSec: resolvePreviewAnchorSec,
  emitPreview: (payload) => emit('drag-session-preview', payload)
})

function resolveEffectiveTimelineEndSec() {
  return resolveHorizontalBrowseEffectiveTimelineEndSec({
    rawData: rawData.value,
    durationSec: resolvePreviewDurationSec(),
    timeBasisOffsetMs: visualGridTimeBasisOffsetMs.value,
    tailToleranceSec: HORIZONTAL_BROWSE_TIMELINE_TAIL_TOLERANCE_SEC
  })
}

const normalizePreviewTimelineSeconds = (seconds: number) =>
  normalizeHorizontalBrowseTimelineSeconds(
    seconds,
    resolveEffectiveTimelineEndSec(),
    Boolean(props.allowNegativeTimeline)
  )

const dragReleaseHandoff = createHorizontalBrowseDragReleaseHandoff({
  normalizeSeconds: normalizePreviewTimelineSeconds
})

const {
  applyPreviewPlaybackPosition,
  shouldRenderStableCanvasForPlaybackToggle,
  freezeStableCanvasPlaybackTogglePosition,
  holdStablePlaybackToggleRender,
  isStablePlaybackToggleRenderHeld,
  startStableSeekSyncHandoff,
  isStableSeekSyncHandoffActive,
  forceRenderStableSeekTarget,
  clearStableSeekRenderRaf
} = createHorizontalBrowseStableInteractionHandoff({
  previewStartSec,
  compactVisualWaveformActive,
  normalizeSeconds: normalizePreviewTimelineSeconds,
  clampPreviewStart,
  resolvePlaybackAlignedStart,
  resolveVisibleDurationSec,
  resolveRenderedCanvasViewportStartSec,
  suppressStablePlaybackReanchor: stablePlaybackReanchorGate.suppress,
  stopStableCanvasPlayback,
  hideStableCanvasPresentation,
  drawWaveformNow,
  scheduleDraw,
  playheadRatio: HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
})

const consumeDragReleaseStablePresentationOffsetLimit = (seconds: number) => {
  const consumed = dragReleaseHandoff.consume('stable-presentation', seconds)
  return consumed ? Number.POSITIVE_INFINITY : undefined
}

const applyStablePresentationSeekTarget = (seconds: number) => {
  if (!compactVisualWaveformActive.value) return false
  const result = applyStableCanvasPresentation(seconds, {
    allowReanchor: false,
    requirePresentable: true
  })
  if (!result.applied) return false
  applyPreviewPlaybackPosition(seconds, false)
  if (waveformPlaybackActive.value) {
    reanchorStableCanvasPlayback(seconds, resolveWaveformPlaybackRate())
  } else {
    stopStableCanvasPlayback()
  }
  return true
}

const applyPresentationSeekTarget = (targetSeconds: number, revision: number) => {
  if (!props.song?.filePath) return
  const safeTargetSeconds = normalizePreviewTimelineSeconds(targetSeconds)
  if (dragReleaseHandoff.consume('seek-revision', safeTargetSeconds)) {
    applyPreviewPlaybackPosition(safeTargetSeconds, false)
    return
  }
  if (compactVisualWaveformActive.value) {
    if (applyStablePresentationSeekTarget(safeTargetSeconds)) return
    startStableSeekSyncHandoff(revision, safeTargetSeconds)
    forceRenderStableSeekTarget(safeTargetSeconds)
    return
  }
  applyPreviewPlaybackPosition(safeTargetSeconds, true, true)
}

const canAdjustGrid = computed(() => {
  if (previewLoading.value) return false
  if (isRekordboxReadOnlySong.value) return false
  return !!props.song?.filePath && resolvePreviewDurationSec() > 0
})
const canAdjustBpmInput = computed(() => {
  if (previewLoading.value) return false
  if (props.gridEditMode === true) return canAdjustGrid.value
  return !!props.song?.filePath && resolvePreviewDurationSec() > 0
})
const previewFirstBeatMsComputed = computed(() => Number(previewFirstBeatMs.value) || 0)
const metronomePlaybackRate = computed(() => Math.max(0.25, Number(props.playbackRate) || 1))
const metronomeResetKey = computed(
  () => `${String(props.song?.filePath || '')}:${Number(props.seekRevision) || 0}`
)
const syncNativeMetronomeState = createHorizontalBrowseNativeMetronomeSync(() => props.direction)

const {
  buildSongGridSignature,
  clearPendingLocalGridSignature,
  clearPersistTimer,
  clearBpmTapResetTimer,
  resetPreviewBpmTap,
  schedulePreviewBpmTapReset,
  persistGridDefinition,
  schedulePersistGridDefinition,
  shouldDeferSongGridSync
} = createHorizontalBrowseDetailGridPersistence({
  song: () => props.song,
  previewBpm,
  previewFirstBeatMs,
  previewDownbeatBeatOffset,
  previewTimeBasisOffsetMs,
  previewBeatGridMap,
  resolvePreviewDurationSec,
  bpmTapTimestamps,
  deferPersistToDisk: () => props.deferGridPersist === true,
  onDirtyChange: (dirty) => emit('grid-dirty-change', dirty),
  resolvePersistBeatGridMap: () => resolveDetailBeatGridMap()
})

const forceDynamicGridFrameRefresh = () => {
  syncVisualGridStateFromPreview()
  invalidateWaveformTiles({ preserveDisplay: compactVisualWaveformActive.value })
  resetGridRenderer()
  scheduleGridOverlayDraw()
}

const dynamicBeatGridEdit = useHorizontalBrowseDynamicBeatGridEdit({
  enabled: () => gridEditingEnabled.value,
  autoSyncFromSong: false,
  song: () => props.song,
  previewBeatGridMap,
  previewBpm,
  previewBpmInput,
  previewFirstBeatMs,
  previewDownbeatBeatOffset,
  previewStartSec,
  previewWrapRef: wrapRef,
  resolveCurrentSec: () =>
    waveformPlaybackActive.value ? resolveWaveformCurrentSeconds() : resolvePreviewAnchorSec(),
  resolvePreviewAnchorSec,
  resolvePreviewDurationSec,
  resolveVisibleDurationSec,
  resolveViewportStartSec: resolveRenderedCanvasViewportStartSec,
  clampPreviewStart,
  playbackActive: () => waveformPlaybackActive.value,
  schedulePreviewDraw: scheduleGridOverlayDraw,
  forceGridFrameRefresh: forceDynamicGridFrameRefresh,
  schedulePersistGridDefinition
})

const detailVisible = computed(() => true)
watchHorizontalBrowseRawWaveformLoadingChange({
  previewLoading,
  emitLoadingChange: (loading) => emit('edit-waveform-loading-change', loading)
})

const {
  handlePreviewMouseDownForGridTargetSelect,
  handleSetDownbeatLineAtPlayhead,
  handleGridShift
} = useMixtapeBeatAlignGridAdjust({
  previewWrapRef: wrapRef,
  previewLoading,
  previewMixxxData: mixxxData,
  canAdjustGrid,
  previewPlaying,
  previewDownbeatBeatOffset,
  previewFirstBeatMs,
  previewStartSec,
  bpm: previewBpm,
  firstBeatMs: previewFirstBeatMsComputed,
  resolvePreviewAnchorSec,
  resolvePreviewDurationSec,
  resolveVisibleDurationSec,
  clampPreviewStart,
  getPreviewPlaybackSec: resolvePreviewAnchorSec,
  schedulePreviewDraw: scheduleGridOverlayDraw,
  applyPlaybackPhaseCompensation: applyLocalGridShiftPhaseCompensation,
  downbeatBeatInterval: PREVIEW_DOWNBEAT_BEAT_INTERVAL,
  dynamicGridEdit: dynamicBeatGridEdit
})

const {
  metronomeEnabled,
  metronomeVolumeLevel,
  metronomeSupported,
  cycleMetronomeState: cycleMetronomeRuntimeState
} = useMixtapeBeatAlignMetronome({
  dialogVisible: detailVisible,
  previewPlaying,
  bpm: previewBpm,
  firstBeatMs: previewFirstBeatMsComputed,
  playbackRate: metronomePlaybackRate,
  resetKey: metronomeResetKey,
  outputMode: 'external',
  syncExternalState: syncNativeMetronomeState,
  resolveAnchorSec: () => Math.max(0, Number(props.currentSeconds) || 0),
  beatGridMap: resolveDetailBeatGridMap,
  resolveDurationSec: resolvePreviewDurationSec
})

const canToggleMetronome = computed(() => canAdjustGrid.value && metronomeSupported.value)

const {
  emitToolbarState,
  syncGridStateFromSong,
  handlePreviewBpmInputUpdate,
  handlePreviewBpmInputBlur,
  handlePreviewBpmTap,
  setDownbeatLineAtPlayhead,
  shiftGrid,
  cycleMetronomeState,
  splitAfterPlayhead,
  selectWholeAdjustment,
  deleteBoundary
} = useHorizontalBrowseGridToolbar({
  canAdjustGrid,
  canAdjustBpmInput,
  previewLoading,
  previewBpm,
  previewBpmInput,
  previewFirstBeatMs,
  previewDownbeatBeatOffset,
  previewTimeBasisOffsetMs,
  bpmTapTimestamps,
  metronomeEnabled,
  metronomeVolumeLevel,
  canToggleMetronome,
  emitToolbarStateChange: (value) => emit('toolbar-state-change', value),
  resolveDisplayGridBpm,
  resolveSongFirstBeatMs: () => Number(props.song?.firstBeatMs) || 0,
  resolveSongDownbeatBeatOffset: () => Number(props.song?.downbeatBeatOffset) || 0,
  resolveSongTimeBasisOffsetMs: () => Number(props.song?.timeBasisOffsetMs) || 0,
  scheduleDraw: scheduleGridOverlayDraw,
  schedulePreviewBpmTapReset,
  persistGridDefinition,
  schedulePersistGridDefinition,
  resetPreviewBpmTap,
  handleSetDownbeatLineAtPlayhead,
  handleGridShift,
  handleMetronomeStateCycle: cycleMetronomeRuntimeState,
  resolveGridControlsDisabled: () => dynamicBeatGridEdit.gridControlsDisabled.value,
  resolveShowSplitAfterPlayhead: () => gridEditingEnabled.value && canAdjustGrid.value,
  resolveShowDeleteBoundary: () => dynamicBeatGridEdit.isBoundarySelected.value,
  resolveGridAdjustScope: () => dynamicBeatGridEdit.adjustmentScope.value,
  handleSelectWholeAdjustment: dynamicBeatGridEdit.selectWholeAdjustment,
  handleSplitAfterPlayhead: dynamicBeatGridEdit.createBoundaryAfterPlayhead,
  handleDeleteBoundary: dynamicBeatGridEdit.deleteSelectedBoundary,
  applyBpmToActiveGridTarget: (bpm) =>
    dynamicBeatGridEdit.isDynamic.value && dynamicBeatGridEdit.setActiveGridBpm(bpm)
})

watchHorizontalBrowseRawWaveformDynamicGridSelection({
  source: dynamicBeatGridEdit,
  selection: dynamicGridSelection,
  forceFrameRefresh: forceDynamicGridFrameRefresh,
  scheduleGridOverlayDraw,
  emitToolbarState
})

const syncGridStateFromSongForDisplay = () => {
  dynamicBeatGridEdit.syncFromSong()
  syncGridStateFromSong()
  dynamicBeatGridEdit.syncPreviewFromSelectedTarget()
  if (!presentationLinkedGridVisualPending.value) {
    syncVisualGridStateFromPreview()
  }
}

const { commitSource: commitAudioEditSourceRaw } = useHorizontalBrowseAudioEditDetailRaw({
  clips: () => props.audioEditClips,
  sourceRawData,
  displayRawData: rawData,
  mixxxData,
  replaceLiveWaveformRaw,
  resetPlaybackRenderState: (resetOptions) =>
    resetWaveformRenderState({
      preserveDisplay: resetOptions?.preserveDisplay !== false
    }),
  reanchorViewport: () => {
    previewStartSec.value = resolvePlaybackAlignedStart(resolveWaveformCurrentSeconds())
  },
  scheduleDraw
})

const {
  requestCompactVisualWaveformStrip,
  maybeContinueCompactVisualWaveformStrip,
  resetCompactVisualWaveformStrip,
  disposeCompactVisualWaveformStrip
} = useHorizontalBrowseCompactVisualWaveformStrip({
  song: () => props.song,
  active: compactVisualWaveformActive,
  rawData: sourceRawData,
  mixxxData,
  previewLoading,
  previewZoom,
  resolveVisibleDurationSec,
  resolvePreviewAnchorSec,
  clampPreviewStart,
  replaceLiveWaveformRaw: (data) => commitAudioEditSourceRaw(data),
  resetPlaybackRenderState: () => resetWaveformRenderState({ preserveDisplay: true }),
  scheduleDraw
})

const maybeContinueWaveformSource = (anchorSec?: number) =>
  maybeContinueCompactVisualWaveformStrip(anchorSec)

const {
  clearPlaybackStableFrameRenderTimer,
  schedulePlaybackStableFrameRender,
  prepareStableFrameForAnchor,
  applyIncomingPreviewTimeScale,
  commitLinkedGridVisualTransaction: commitLinkedGridVisualPresentationTransaction
} = createHorizontalBrowseDetailPresentationActions({
  deck: resolveDetailDeck,
  currentSeconds: () => props.currentSeconds,
  compactVisualWaveformActive,
  previewStartSec,
  localGridShiftPhaseOffsetSec,
  waveformPlaybackActive: () => waveformPlaybackActive.value,
  linkedGridVisualPending: () => presentationLinkedGridVisualPending.value,
  normalizePreviewTimelineSeconds,
  resolveVisibleDurationSec,
  resolvePreviewDurationSec,
  resolveWaveformCurrentSeconds,
  allowNegativeTimeline: () => Boolean(props.allowNegativeTimeline),
  clampPreviewStart,
  stopStableCanvasPlayback,
  drawWaveformNow,
  measureStableCanvasPresentation,
  getLastAppliedPreviewTimeScale: presentationState.getLastAppliedPreviewTimeScale,
  setLastAppliedPreviewTimeScale: presentationState.setLastAppliedPreviewTimeScale,
  resolveIncomingPreviewTimeScale,
  resolveWaveformPlaybackRate,
  resolveGridTimeBasis: () => ({
    bpm: previewRenderBpm.value,
    firstBeatMs: previewFirstBeatMs.value,
    downbeatBeatOffset: previewDownbeatBeatOffset.value,
    timeBasisOffsetMs: previewTimeBasisOffsetMs.value
  }),
  invalidateWaveformTiles,
  resetGridRenderer,
  maybeContinueWaveformSource,
  scheduleDraw,
  syncGridStateFromSong,
  syncVisualGridStateFromPreview,
  applyPreviewPlaybackPosition,
  publishLinkedGridVisualPhaseSample,
  markLinkedGridVisualTransactionCommitted: () => {
    linkedGridVisualTransactionCommitted = true
  }
})

const commitLinkedGridVisualTransaction = (
  deckState?: HorizontalBrowseLinkedGridVisualTransactionDeckState,
  options?: HorizontalBrowseLinkedGridVisualTransactionCommitOptions
) =>
  props.song?.filePath ? commitLinkedGridVisualPresentationTransaction(deckState, options) : null

const { handleSharedZoomState, handlePresentationState } =
  createHorizontalBrowseDetailPresentationConsumer({
    deck: resolveDetailDeck,
    direction: () => props.direction,
    presentationState: () => props.presentationState,
    previewZoom,
    previewMaxZoom,
    previewStartSec,
    waveformPlaybackActive: () => waveformPlaybackActive.value,
    resolveWaveformCurrentSeconds,
    resolveWaveformPlaybackRate,
    resolveVisibleDurationSec,
    clampPreviewStart,
    resetGridRenderer,
    maybeContinueWaveformSource,
    setLastAppliedPreviewTimeScale: presentationState.setLastAppliedPreviewTimeScale,
    applyGridTimeBasis: (gridTimeBasis) => {
      visualGridBpm.value = gridTimeBasis.bpm
      visualGridFirstBeatMs.value = gridTimeBasis.firstBeatMs
      visualGridDownbeatBeatOffset.value = gridTimeBasis.downbeatBeatOffset
      visualGridTimeBasisOffsetMs.value = gridTimeBasis.timeBasisOffsetMs
    },
    drawWaveformNow,
    schedulePlaybackStableFrameRender,
    clearPlaybackStableFrameRenderTimer,
    reanchorStableCanvasPlayback,
    scheduleDraw,
    applyPresentationSeekTarget
  })

const resolveLiveTempoPreviewActiveBufferIndex = (): 0 | 1 =>
  waveformCanvasBackRef.value?.style.opacity === '1' ? 1 : 0

const resolveLiveTempoPreviewScalers = (bufferIndex: 0 | 1) =>
  bufferIndex === 1
    ? [waveformTempoScalerBackRef.value, overlayTempoScalerBackRef.value]
    : [waveformTempoScalerRef.value, overlayTempoScalerRef.value]

const applyLiveTempoPreviewTransformForBuffer = (bufferIndex: 0 | 1, bufferTimeScale: number) => {
  applyHorizontalBrowseLiveTempoPreviewTransform(
    resolveLiveTempoPreviewScalers(bufferIndex),
    bufferTimeScale,
    liveTempoPreviewRateValue ?? presentationState.getLastAppliedPreviewTimeScale()
  )
}

const syncLiveTempoPreviewTransform = () => {
  if (liveTempoPreviewRateValue == null) {
    applyHorizontalBrowseLiveTempoPreviewTransform(
      [
        waveformTempoScalerRef.value,
        waveformTempoScalerBackRef.value,
        overlayTempoScalerRef.value,
        overlayTempoScalerBackRef.value
      ],
      1,
      1
    )
    return
  }
  applyLiveTempoPreviewTransformForBuffer(
    resolveLiveTempoPreviewActiveBufferIndex(),
    displayedPreviewTimeScale
  )
}

const clearLiveTempoPreviewRelease = () => {
  liveTempoPreviewReleasePendingScale = null
  liveTempoPreviewRateValue = null
  syncLiveTempoPreviewTransform()
}

const applyLiveTempoPreviewRate = (liveRate: number | null | undefined) => {
  const leavingLive = liveTempoPreviewRateValue != null
  const nextRate =
    liveRate != null && Number.isFinite(Number(liveRate)) && Number(liveRate) > 0
      ? Number(liveRate)
      : null
  if (nextRate != null) {
    liveTempoPreviewReleasePendingScale = null
    liveTempoPreviewRateValue = nextRate
    syncLiveTempoPreviewTransform()
    if (compactVisualWaveformActive.value && waveformPlaybackActive.value) {
      reanchorStableCanvasPlayback(resolveWaveformCurrentSeconds(), nextRate)
    }
    return
  }
  if (!leavingLive || presentationLinkedGridVisualPending.value) {
    clearLiveTempoPreviewRelease()
    return
  }
  const incomingTimeScale = Math.max(0.25, Number(resolveIncomingPreviewTimeScale()) || 1)
  const releasePlan = resolveHorizontalBrowseLiveTempoPreviewReleasePlan(
    displayedPreviewTimeScale,
    incomingTimeScale
  )
  if (releasePlan.mode === 'immediate') {
    clearLiveTempoPreviewRelease()
    applyIncomingPreviewTimeScale(true, { keepCurrentFrame: true })
    return
  }
  liveTempoPreviewReleasePendingScale = releasePlan.pendingScale
  liveTempoPreviewRateValue = releasePlan.pendingScale
  syncLiveTempoPreviewTransform()
  const scheduledNewFrame = applyIncomingPreviewTimeScale(true, {
    keepCurrentFrame: true,
    forceFrameWhenUnchanged: true
  })
  if (!scheduledNewFrame) {
    clearLiveTempoPreviewRelease()
  }
}

watch(
  () => props.liveTempoPreviewRate,
  (liveRate) => applyLiveTempoPreviewRate(liveRate),
  { flush: 'sync' }
)

const { stopDragging, handlePointerDown, handleWheel } =
  createHorizontalBrowseWaveformPointerInteraction({
    wrapRef,
    dragging,
    previewStartSec,
    previewZoom,
    previewMaxZoom,
    direction: () => props.direction,
    hasSong: () => Boolean(props.song?.filePath) && props.interactionDisabled !== true,
    resolvePreviewDurationSec,
    resolveVisibleDurationSec,
    resolvePreviewAnchorSec,
    resolveWaveformCurrentSeconds,
    clampPreviewStart,
    beginDragCanvasPresentation,
    applyDragCanvasPresentationOffset,
    endDragCanvasPresentation,
    clearDragReleaseHandoff: dragReleaseHandoff.clear,
    beginDragReleaseHandoff: dragReleaseHandoff.begin,
    scrubPreview,
    handlePreviewMouseDownForGridTargetSelect,
    emitToolbarState,
    schedulePersistGridDefinition,
    emitDragSessionStart: () => emit('drag-session-start'),
    emitDragSessionEnd: (payload) => emit('drag-session-end', payload),
    emitZoomChange: (payload) => emit('zoom-change', payload),
    linkedDragActive: () => presentationLinkedDragActive.value,
    linkedDragAnchorSec: () => presentationLinkedDragAnchorSec.value,
    resolvePlaybackActive: () => waveformPlaybackActive.value,
    maybeContinueWaveformSource,
    drawWaveformNow,
    scheduleDraw,
    zoomStepFactor: HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR,
    minZoom: HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
    clampNumber
  })

const loadWaveform = async () => {
  const currentSong = props.song
  const currentToken = ++loadToken
  clearPendingLocalGridSignature()
  dragReleaseHandoff.clear()

  clearPersistTimer()
  clearPlaybackStableFrameRenderTimer()
  resetCompactVisualWaveformStrip()
  invalidateWaveformTiles()
  previewLoading.value = false
  compactVisualWaveformActive.value = false
  commitAudioEditSourceRaw(null)
  previewStartSec.value = 0
  resetLiveWaveformData()
  resetGridRenderer()
  clearCanvas()

  const filePath = String(currentSong?.filePath || '').trim()
  if (!filePath) {
    syncGridStateFromSongForDisplay()
    return
  }
  if (isRekordboxExternalPlaybackSource('', currentSong)) {
    const external = resolveSongExternalWaveformSource(currentSong)
    if (external) {
      try {
        const response = (await window.electron.ipcRenderer.invoke(
          getRekordboxDetailWaveformRequestChannel(external.sourceKind),
          external.rootPath,
          [external.analyzePath]
        )) as { items?: Array<{ data?: PioneerDetailWaveformData | null }> }
        if (currentToken !== loadToken || props.song?.filePath !== currentSong?.filePath) return
        const detailData = response?.items?.[0]?.data
        const detailRaw = createPioneerDetailRawWaveform(
          detailData?.columns || [],
          resolvePreviewDurationSec(),
          detailData?.detailRate ?? detailData?.detail_rate,
          detailData?.style
        )
        if (detailRaw) {
          commitAudioEditSourceRaw(detailRaw)
          compactVisualWaveformActive.value = true
          scheduleDraw({ preferPreviewStart: true })
        }
      } catch {}
    }
    syncGridStateFromSongForDisplay()
    return
  }

  try {
    previewLoading.value = true
    syncGridStateFromSongForDisplay()
    previewStartSec.value = resolvePlaybackAlignedStart(resolveWaveformCurrentSeconds())
    compactVisualWaveformActive.value = true
    await requestCompactVisualWaveformStrip(resolveWaveformCurrentSeconds(), {
      force: true,
      clearIfOutside: true
    })
    if (currentToken !== loadToken) return
  } catch {
    if (currentToken !== loadToken) return
    previewLoading.value = false
    compactVisualWaveformActive.value = true
    commitAudioEditSourceRaw(null)
    resetGridRenderer()
    clearCanvas()
    syncGridStateFromSongForDisplay()
  }
}

useHorizontalBrowseRawWaveformDetailLifecycle({
  props,
  state: {
    presentationLinkedGridVisualPending,
    presentationLinkedGridActive,
    visualGridRenderBpm,
    visualGridFirstBeatMs,
    visualGridDownbeatBeatOffset,
    waveformPlaybackActive,
    compactVisualWaveformActive,
    canAdjustGrid,
    canAdjustBpmInput,
    previewBpm,
    previewRenderBpm,
    previewFirstBeatMs,
    previewDownbeatBeatOffset,
    previewTimeBasisOffsetMs,
    metronomeEnabled,
    metronomeVolumeLevel,
    canToggleMetronome
  },
  runtimeThemeMode: () => runtime.setting?.themeMode,
  resolveWaveformLayout,
  resolveWaveformRenderStyle,
  resolveDetailDeck,
  loadWaveform,
  buildSongGridSignature,
  shouldDeferSongGridSync,
  syncGridStateFromSongForDisplay,
  emitToolbarState,
  scheduleGridOverlayDraw,
  scheduleDraw,
  invalidateWaveformTiles,
  resetGridRenderer,
  publishLinkedGridVisualPhaseSample,
  resolveIncomingPreviewTimeScale,
  applyIncomingPreviewTimeScale,
  handleSharedZoomState,
  handlePresentationState,
  applyPresentationSeekTarget,
  syncVisualGridStateFromPreview,
  playbackToggleWatch: {
    playbackActive: () => waveformPlaybackActive.value,
    previewPlaying,
    linkedGridVisualPending: () => presentationLinkedGridVisualPending.value,
    dragging,
    compactVisualWaveformActive,
    dragPresentationReleaseActive,
    resolveCurrentSeconds: resolveWaveformCurrentSeconds,
    resolvePlaybackRate: resolveWaveformPlaybackRate,
    stopLiveWaveformPlayback,
    stopStableCanvasPlayback,
    suppressStablePlaybackReanchor: stablePlaybackReanchorGate.suppress,
    holdStablePlaybackToggleRender,
    measureStableCanvasPresentation,
    shouldRenderStableCanvasForPlaybackToggle,
    applyPreviewPlaybackPosition,
    freezeStableCanvasPlaybackTogglePosition,
    startStableCanvasPlayback,
    maybeContinueWaveformSource
  },
  playbackPositionWatch: {
    direction: () => props.direction,
    currentSeconds: () => props.currentSeconds,
    playbackActive: () => waveformPlaybackActive.value,
    songKey: () => props.song?.filePath ?? '',
    playbackSyncRevision: () => playbackSyncRevision.value,
    seekRevision: () => props.seekRevision,
    seekTargetSeconds: () => props.seekTargetSeconds,
    playbackRate: () => props.playbackRate,
    linkedGridActive: () => presentationLinkedGridActive.value,
    linkedGridVisualPending: () => presentationLinkedGridVisualPending.value,
    linkedGridVisualTransactionCommitted: () => linkedGridVisualTransactionCommitted,
    setLinkedGridVisualTransactionCommitted: (value) => {
      linkedGridVisualTransactionCommitted = value
    },
    dragging,
    compactVisualWaveformActive,
    dragPresentationReleaseActive,
    syncDragPresentationReleaseViewportStart,
    consumeDragPresentationReleaseRequiresFreshFrame,
    normalizePreviewTimelineSeconds,
    playbackDiscontinuityDetector,
    applyPreviewPlaybackPosition,
    dragReleaseHandoff,
    applyStablePresentationSeekTarget,
    startStableSeekSyncHandoff,
    isStableSeekSyncHandoffActive,
    forceRenderStableSeekTarget,
    isStablePlaybackToggleRenderHeld,
    stopStableCanvasPlayback,
    consumeDragReleaseStablePresentationOffsetLimit,
    measureStableCanvasPresentation,
    adoptStableCanvasRenderRevision,
    hideStableCanvasPresentation,
    applyStableCanvasPresentation,
    reanchorStableCanvasPlayback,
    resolveWaveformPlaybackRate,
    maybeContinueWaveformSource,
    stablePlaybackReanchorCanReanchor: stablePlaybackReanchorGate.canReanchor
  },
  mount: {
    mountWaveformCanvasWorker,
    resolveWrapElement: () => wrapRef.value,
    invalidateWaveformTiles,
    resetGridRenderer,
    emitToolbarState,
    scheduleDraw
  },
  unmount: {
    invalidateLoad: () => {
      loadToken += 1
    },
    resetCompactVisualWaveformStrip,
    clearPersistTimer,
    clearBpmTapResetTimer,
    clearPlaybackStableFrameRenderTimer,
    clearStableSeekRenderRaf,
    stopDragging,
    disposeWaveformCanvas,
    disposeCompactVisualWaveformStrip
  }
})

const { audioEditSelectionStyle, audioEditInsertedStyles, audioEditBoundStyles } =
  useHorizontalBrowseRawWaveformAudioEditOverlay({
    hasSong: () => Boolean(props.song),
    selection: () => props.audioEditSelection,
    pendingStartSec: () => props.audioEditPendingStartSec,
    pendingEndSec: () => props.audioEditPendingEndSec,
    insertedRanges: () => props.audioEditInsertedRanges,
    dragging,
    displayViewportStartSec,
    displayViewportDurationSec,
    previewStartSec,
    resolveVisibleDurationSec
  })

defineExpose(
  createHorizontalBrowseRawWaveformDetailExpose({
    setLiveTempoPreviewRate: (rate) => applyLiveTempoPreviewRate(rate),
    setDownbeatLineAtPlayhead,
    shiftGrid,
    updateBpmInput: handlePreviewBpmInputUpdate,
    blurBpmInput: handlePreviewBpmInputBlur,
    tapBpm: handlePreviewBpmTap,
    splitAfterPlayhead,
    selectWholeAdjustment,
    deleteBoundary,
    freezeDynamicGridSelectionForBpmInput: dynamicBeatGridEdit.freezeSelectionForBpmInput,
    releaseDynamicGridSelectionForBpmInput: dynamicBeatGridEdit.releaseSelectionForBpmInput,
    cycleMetronomeState,
    prepareStableFrameForAnchor,
    commitLinkedGridVisualTransaction,
    resolveVisibleDurationSec,
    resolveWrapWidth: () => Number(wrapRef.value?.getBoundingClientRect().width || 0),
    persistGridDefinition,
    syncGridStateFromSongForDisplay,
    clearGridHistory: dynamicBeatGridEdit.clearHistory
  })
)
</script>

<template>
  <div
    ref="wrapRef"
    :class="[
      'raw-detail-waveform',
      `raw-detail-waveform--${props.direction}`,
      {
        'is-dragging': dragging,
        'is-loading': previewLoading,
        'is-interaction-disabled': props.interactionDisabled
      }
    ]"
    @pointerdown.stop="handlePointerDown"
    @wheel.prevent.stop="handleWheel"
  >
    <div ref="waveformSurfaceRef" class="raw-detail-waveform__surface">
      <div ref="waveformTempoScalerRef" class="raw-detail-waveform__tempo-scaler">
        <canvas
          ref="waveformCanvasRef"
          class="raw-detail-waveform__canvas raw-detail-waveform__canvas--waveform"
        />
        <!-- 分块路径：块容器与旧超宽 canvas 几何一致，统一位移挂在容器上（每块不独立缩放/位移，
             否则边界会出现亚像素错位）。容器位于 tempo-scaler 之内，故 CSS 变速缩放仍作用于整层。 -->
        <div
          v-if="waveformTileRenderingEnabled"
          :ref="
            (element) => (waveformTileContainerRefs[0].value = element as HTMLDivElement | null)
          "
          class="raw-detail-waveform__tile-container"
        >
          <canvas
            v-for="slotIndex in waveformTileSlotIndexes"
            :key="`tile-front-${slotIndex}`"
            :ref="
              (element) =>
                (waveformTileCanvasRefs[0].value[slotIndex] = element as HTMLCanvasElement | null)
            "
            class="raw-detail-waveform__canvas--waveform raw-detail-waveform__tile"
          />
        </div>
      </div>
      <div ref="waveformTempoScalerBackRef" class="raw-detail-waveform__tempo-scaler">
        <canvas
          ref="waveformCanvasBackRef"
          class="raw-detail-waveform__canvas raw-detail-waveform__canvas--waveform raw-detail-waveform__canvas--buffer-back"
        />
        <div
          v-if="waveformTileRenderingEnabled"
          :ref="
            (element) => (waveformTileContainerRefs[1].value = element as HTMLDivElement | null)
          "
          class="raw-detail-waveform__tile-container raw-detail-waveform__tile-container--buffer-back"
        >
          <canvas
            v-for="slotIndex in waveformTileSlotIndexes"
            :key="`tile-back-${slotIndex}`"
            :ref="
              (element) =>
                (waveformTileCanvasRefs[1].value[slotIndex] = element as HTMLCanvasElement | null)
            "
            class="raw-detail-waveform__canvas--waveform raw-detail-waveform__tile"
          />
        </div>
      </div>
    </div>
    <div v-if="externalDetailWaveformUnavailable" class="raw-detail-waveform__unavailable">
      {{ t('horizontalBrowse.waveformUnavailable') }}
    </div>
    <div ref="overlaySurfaceRef" class="raw-detail-waveform__overlay-surface">
      <div ref="overlayTempoScalerRef" class="raw-detail-waveform__tempo-scaler">
        <canvas
          ref="overlayCanvasRef"
          class="raw-detail-waveform__canvas raw-detail-waveform__canvas--overlay"
        />
      </div>
      <div ref="overlayTempoScalerBackRef" class="raw-detail-waveform__tempo-scaler">
        <canvas
          ref="overlayCanvasBackRef"
          class="raw-detail-waveform__canvas raw-detail-waveform__canvas--overlay raw-detail-waveform__canvas--buffer-back"
        />
      </div>
    </div>
    <div
      v-for="region in audioEditInsertedStyles"
      :key="region.key"
      class="raw-detail-waveform__audio-edit-insert"
      :style="region.style"
      aria-hidden="true"
    ></div>
    <div
      v-if="audioEditSelectionStyle"
      class="raw-detail-waveform__audio-edit-selection"
      :style="audioEditSelectionStyle"
    ></div>
    <div
      v-for="bound in audioEditBoundStyles"
      :key="bound.key"
      class="raw-detail-waveform__audio-edit-bound"
      :class="`is-${bound.kind}`"
      :style="bound.style"
      aria-hidden="true"
    >
      <span>{{ bound.label }}</span>
    </div>
  </div>
</template>
<style scoped lang="scss" src="./HorizontalBrowseRawWaveformDetail.scss"></style>
