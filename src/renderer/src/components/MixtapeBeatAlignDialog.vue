<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch, type PropType } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { t } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import HorizontalBrowseWaveformOverview from '@renderer/components/HorizontalBrowseWaveformOverview.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import MixtapeBeatAlignGridAdjustToolbar from '@renderer/components/mixtapeBeatAlignGridAdjustToolbar.vue'
import MixtapeBeatAlignTopControls from '@renderer/components/mixtapeBeatAlignTopControls.vue'
import { useMixtapeBeatAlignGridAdjust } from '@renderer/components/mixtapeBeatAlignGridAdjust'
import { useMixtapeBeatAlignPlayback } from '@renderer/components/mixtapeBeatAlignPlayback'
import { useMixtapeBeatAlignMetronome } from '@renderer/components/mixtapeBeatAlignMetronome'
import {
  useMixtapeBeatAlignInitialGridAlignment,
  useMixtapeBeatAlignPreviewInteraction,
  useMixtapeBeatAlignWaveformError
} from '@renderer/components/mixtapeBeatAlignPreviewState'
import {
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
} from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { useHorizontalBrowseRawWaveformCanvas } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRawWaveformCanvas'
import { useHorizontalBrowseCompactVisualWaveformStrip } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseCompactVisualWaveformStrip'
import { createHorizontalBrowseStableInteractionHandoff } from '@renderer/composables/horizontalBrowse/horizontalBrowseStableInteractionHandoff'
import { useHorizontalBrowseDynamicBeatGridEdit } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDynamicBeatGridEdit'
import {
  HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_TARGET_CSS_PX,
  HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_TARGET_CSS_PX,
  resolveHorizontalBrowseGridShiftMs
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailExpose'
import {
  PREVIEW_DOWNBEAT_BEAT_INTERVAL,
  PREVIEW_BPM_MAX,
  PREVIEW_BPM_MIN,
  PREVIEW_BPM_STEP,
  PREVIEW_BPM_TAP_MAX_COUNT,
  PREVIEW_BPM_TAP_MAX_DELTA_MS,
  PREVIEW_BPM_TAP_MIN_DELTA_MS,
  PREVIEW_BPM_TAP_RESET_MS,
  PREVIEW_SHORTCUT_BEATS,
  PREVIEW_SHORTCUT_FALLBACK_BPM,
  PREVIEW_WARMUP_DELAY_MS,
  PREVIEW_WARMUP_EAGER_DELAY_MS,
  formatPreviewBpm,
  isEditableEventTarget,
  normalizeBeatOffset,
  normalizePathKey,
  normalizePreviewBpm,
  parsePreviewBpmInput
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import {
  createSongBeatGridMapV2FromFixedGrid,
  projectSongBeatGridMapV2ToFixedGrid,
  type SongBeatGridMapV2
} from '@shared/songBeatGridMapV2'

const props = defineProps({
  trackTitle: {
    type: String,
    default: ''
  },
  trackKey: {
    type: String,
    default: ''
  },
  filePath: {
    type: String,
    default: ''
  },
  bpm: {
    type: Number,
    default: 128
  },
  firstBeatMs: {
    type: Number,
    default: 0
  },
  timeBasisOffsetMs: {
    type: Number,
    default: 0
  },
  downbeatBeatOffset: {
    type: Number,
    default: 0
  },
  beatGridMap: {
    type: Object as PropType<SongBeatGridMapV2 | null>,
    default: null
  },
  windowVolume: {
    type: Number,
    default: 0.8
  }
})

const emit = defineEmits<{
  (event: 'cancel'): void
  (
    event: 'save-grid-definition',
    payload: {
      beatGridMap: SongBeatGridMapV2
    }
  ): void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const previewLoading = ref(false)
const previewError = ref('')
const previewMixxxData = ref<MixxxWaveformData | null>(null)
const previewWaveformData = ref<RawWaveformData | null>(null)
const compactVisualWaveformActive = ref(false)
const previewWaveformRequestStarted = ref(false)
const previewZoom = ref(HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
const previewStartSec = ref(0)
const previewDragging = ref(false)
const previewPlaying = ref(false)
const overviewCurrentSec = ref(0)
const previewDownbeatBeatOffset = ref(0)
const previewFirstBeatMs = ref(0)
const previewTimeBasisOffsetMs = ref(0)
const previewBeatGridMap = ref<SongBeatGridMapV2 | null>(null)
const previewBpm = ref(128)
const previewBpmInput = ref('128.00')
const bpmTapTimestamps = ref<number[]>([])

let previewLoadSequence = 0
let previewWarmupTimer: ReturnType<typeof setTimeout> | null = null
let bpmTapResetTimer: ReturnType<typeof setTimeout> | null = null
let overviewClockRaf = 0
let applyDynamicPreviewBpm = (_bpm: number) => false

const bpmDisplay = computed(() => {
  const bpmValue = Number(previewBpm.value)
  if (!Number.isFinite(bpmValue) || bpmValue <= 0) return 'N/A'
  return formatPreviewBpm(bpmValue)
})

const trackKeyDisplay = computed(() => {
  const raw = String(props.trackKey || '').trim()
  if (!raw) return ''
  return raw.toLowerCase() === 'o' ? '-' : raw
})

const trackMetaDisplay = computed(() => {
  const chunks = [`${t('mixtape.bpm')} ${bpmDisplay.value}`]
  if (trackKeyDisplay.value) {
    chunks.push(`${t('columns.key')} ${trackKeyDisplay.value}`)
  }
  return chunks.join(' · ')
})

const trackNameTitle = computed(() => {
  const title = String(props.trackTitle || '').trim()
  const meta = trackMetaDisplay.value
  if (!title) return meta
  return meta ? `${title} · ${meta}` : title
})

const syncPreviewBpmFromProps = () => {
  previewBpm.value = normalizePreviewBpm(props.bpm)
  previewBpmInput.value = formatPreviewBpm(previewBpm.value)
  resetPreviewBpmTap()
}

const handlePreviewBpmInputUpdate = (value: string) => {
  const parsed = parsePreviewBpmInput(value)
  if (parsed === null) {
    previewBpmInput.value = formatPreviewBpm(previewBpm.value)
    return
  }
  if (applyDynamicPreviewBpm(parsed)) return
  previewBpm.value = parsed
  previewBpmInput.value = formatPreviewBpm(parsed)
  resetPreviewBpmTap()
}

const handlePreviewBpmInputBlur = () => {
  previewBpmInput.value = formatPreviewBpm(previewBpm.value)
}

const clearBpmTapResetTimer = () => {
  if (!bpmTapResetTimer) return
  clearTimeout(bpmTapResetTimer)
  bpmTapResetTimer = null
}

const resetPreviewBpmTap = () => {
  clearBpmTapResetTimer()
  bpmTapTimestamps.value = []
}

const schedulePreviewBpmTapReset = () => {
  clearBpmTapResetTimer()
  bpmTapResetTimer = setTimeout(() => {
    bpmTapResetTimer = null
    bpmTapTimestamps.value = []
  }, PREVIEW_BPM_TAP_RESET_MS)
}

const handlePreviewBpmTap = () => {
  if (!canAdjustGrid.value) return
  const now = Date.now()
  const lastTap = bpmTapTimestamps.value[bpmTapTimestamps.value.length - 1]
  if (lastTap && now - lastTap > PREVIEW_BPM_TAP_RESET_MS) {
    bpmTapTimestamps.value = []
  }
  bpmTapTimestamps.value.push(now)
  if (bpmTapTimestamps.value.length > PREVIEW_BPM_TAP_MAX_COUNT) {
    bpmTapTimestamps.value = bpmTapTimestamps.value.slice(-PREVIEW_BPM_TAP_MAX_COUNT)
  }
  schedulePreviewBpmTapReset()

  if (bpmTapTimestamps.value.length < 2) return
  const deltas: number[] = []
  for (let i = 1; i < bpmTapTimestamps.value.length; i += 1) {
    const delta = bpmTapTimestamps.value[i] - bpmTapTimestamps.value[i - 1]
    if (delta > PREVIEW_BPM_TAP_MIN_DELTA_MS && delta < PREVIEW_BPM_TAP_MAX_DELTA_MS) {
      deltas.push(delta)
    }
  }
  if (!deltas.length) return
  const avgMs = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
  if (!Number.isFinite(avgMs) || avgMs <= 0) return
  const tappedBpm = 60000 / avgMs
  if (applyDynamicPreviewBpm(tappedBpm)) return
  previewBpm.value = normalizePreviewBpm(tappedBpm)
  previewBpmInput.value = formatPreviewBpm(previewBpm.value)
}

const closeDialog = () => {
  stopPreviewPlayback({ syncPosition: false })
  closeWithAnimation(() => emit('cancel'))
}

const cancel = () => closeDialog()

const save = () => {
  const dynamicProjection = projectSongBeatGridMapV2ToFixedGrid(previewBeatGridMap.value)
  const beatGridMap =
    previewBeatGridMap.value ??
    createSongBeatGridMapV2FromFixedGrid({
      bpm: dynamicProjection?.bpm ?? normalizePreviewBpm(previewBpm.value),
      firstBeatMs:
        dynamicProjection?.firstBeatMs ??
        (Number.isFinite(Number(previewFirstBeatMs.value)) ? Number(previewFirstBeatMs.value) : 0),
      downbeatBeatOffset:
        dynamicProjection?.downbeatBeatOffset ??
        normalizeBeatOffset(previewDownbeatBeatOffset.value, PREVIEW_DOWNBEAT_BEAT_INTERVAL),
      source: 'manual'
    })
  if (!beatGridMap) return
  emit('save-grid-definition', {
    beatGridMap
  })
  closeDialog()
}

const normalizedFilePath = computed(() => String(props.filePath || '').trim())
syncPreviewBpmFromProps()

const resolveBeatAlignFileName = () => {
  const filePath = normalizedFilePath.value
  const fileName = filePath.split(/[\\/]/).pop()?.trim()
  return fileName || String(props.trackTitle || '').trim()
}

const beatAlignSong = computed<ISongInfo | null>(() => {
  const filePath = normalizedFilePath.value
  if (!filePath) return null
  const duration = Math.max(
    0,
    Number(previewWaveformData.value?.duration || previewMixxxData.value?.duration || 0)
  )
  return {
    filePath,
    fileName: resolveBeatAlignFileName(),
    fileFormat: '',
    cover: null,
    title: String(props.trackTitle || '').trim() || undefined,
    artist: undefined,
    album: undefined,
    duration: duration > 0 ? String(duration) : '',
    genre: undefined,
    label: undefined,
    bitrate: undefined,
    container: undefined,
    key: String(props.trackKey || '').trim() || undefined,
    bpm: Number(previewBpm.value) || 0,
    firstBeatMs: Number(previewFirstBeatMs.value) || 0,
    downbeatBeatOffset: normalizeBeatOffset(
      previewDownbeatBeatOffset.value,
      PREVIEW_DOWNBEAT_BEAT_INTERVAL
    ),
    timeBasisOffsetMs: Number(previewTimeBasisOffsetMs.value) || 0,
    ...(previewBeatGridMap.value ? { beatGridMap: previewBeatGridMap.value } : {})
  }
})

const sourceBeatAlignSong = computed<ISongInfo | null>(() => {
  const song = beatAlignSong.value
  if (!song) return null
  return {
    ...song,
    ...(props.beatGridMap ? { beatGridMap: props.beatGridMap } : {})
  }
})

const playbackSyncRevision = computed(() => 0)
let resolveWaveformCurrentSeconds = () => 0

const {
  wrapRef: previewWrapRef,
  waveformCanvasRef,
  overlayCanvasRef,
  resolvePreviewDurationSec,
  resolveVisibleDurationSec,
  resolvePreviewAnchorSec,
  clampPreviewStart,
  resolvePlaybackAlignedStart,
  resolveRenderedCanvasViewportStartSec,
  resetWaveformRenderState,
  scheduleDraw: schedulePreviewDraw,
  clearCanvas: clearPreviewCanvas,
  invalidateWaveformTiles,
  mountWaveformCanvasWorker,
  resetGridRenderer,
  resetLiveWaveformData,
  replaceLiveWaveformRaw,
  drawWaveformNow,
  beginDragCanvasPresentation,
  applyDragCanvasPresentationOffset,
  endDragCanvasPresentation,
  measureStableCanvasPresentation,
  applyStableCanvasPresentation,
  stopStableCanvasPlayback,
  reanchorStableCanvasPlayback,
  hideStableCanvasPresentation,
  waveformSurfaceRef,
  waveformCanvasBackRef,
  overlaySurfaceRef,
  overlayCanvasBackRef,
  dispose: disposeWaveformCanvas
} = useHorizontalBrowseRawWaveformCanvas({
  song: () => beatAlignSong.value,
  direction: () => 'up',
  cueSeconds: () => undefined,
  hotCues: () => [],
  memoryCues: () => [],
  loopRange: () => null,
  currentSeconds: () => resolveWaveformCurrentSeconds(),
  playbackRate: () => 1,
  visualTimeScale: () => 1,
  playing: previewPlaying,
  playbackSyncRevision,
  rawData: previewWaveformData,
  mixxxData: previewMixxxData,
  previewLoading,
  previewStartSec,
  previewZoom,
  previewBpm,
  previewFirstBeatMs,
  previewDownbeatBeatOffset,
  previewTimeBasisOffsetMs,
  dragging: previewDragging,
  allowNegativeTimeline: () => false,
  waveformLayout: () => 'full',
  waveformRenderStyle: () => 'raw-curve',
  stableWaveformSource: () => compactVisualWaveformActive.value,
  beatGridMap: () => previewBeatGridMap.value
})

const {
  requestCompactVisualWaveformStrip,
  resetCompactVisualWaveformStrip,
  disposeCompactVisualWaveformStrip
} = useHorizontalBrowseCompactVisualWaveformStrip({
  song: () => beatAlignSong.value,
  active: compactVisualWaveformActive,
  rawData: previewWaveformData,
  mixxxData: previewMixxxData,
  previewLoading,
  previewZoom,
  resolveVisibleDurationSec,
  resolvePreviewAnchorSec,
  clampPreviewStart,
  replaceLiveWaveformRaw,
  resetPlaybackRenderState: () => resetWaveformRenderState({ preserveDisplay: true }),
  scheduleDraw: schedulePreviewDraw
})

const { syncPreviewWaveformError } = useMixtapeBeatAlignWaveformError({
  previewWaveformRequestStarted,
  previewLoading,
  previewMixxxData,
  previewError,
  resolveUnavailableText: () => t('mixtape.gridAdjustWaveformUnavailable')
})

const normalizePreviewTimelineSeconds = (seconds: number) => {
  const duration = resolvePreviewDurationSec()
  const numeric = Number(seconds)
  if (!Number.isFinite(numeric)) return 0
  return duration > 0 ? Math.max(0, Math.min(numeric, duration)) : Math.max(0, numeric)
}

const { applyPreviewPlaybackPosition, forceRenderStableSeekTarget, clearStableSeekRenderRaf } =
  createHorizontalBrowseStableInteractionHandoff({
    previewStartSec,
    compactVisualWaveformActive,
    normalizeSeconds: normalizePreviewTimelineSeconds,
    clampPreviewStart,
    resolvePlaybackAlignedStart,
    resolveVisibleDurationSec,
    resolveRenderedCanvasViewportStartSec,
    suppressStablePlaybackReanchor: () => {},
    stopStableCanvasPlayback,
    hideStableCanvasPresentation,
    drawWaveformNow,
    scheduleDraw: schedulePreviewDraw,
    playheadRatio: HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
  })

const resolvePreviewLeadingPadSec = () =>
  resolveVisibleDurationSec() * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO

const { markInitialGridAlignmentPending, clearInitialGridAlignmentPending } =
  useMixtapeBeatAlignInitialGridAlignment({
    song: () => beatAlignSong.value,
    previewWaveformData,
    previewMixxxData,
    previewStartSec,
    resolvePreviewDurationSec,
    resolvePlaybackAlignedStart,
    schedulePreviewDraw
  })

const {
  previewDecoding,
  previewAnchorStyle,
  canTogglePreviewPlayback,
  startPreviewScrub,
  updatePreviewScrub,
  stopPreviewScrub,
  seekPreviewAnchorSec,
  nudgePreviewBySec,
  getPreviewPlaybackSec,
  handlePreviewPlaybackToggle,
  warmupPreviewPlayback,
  stopPreviewPlayback,
  cleanupPreviewPlayback
} = useMixtapeBeatAlignPlayback({
  filePathRef: normalizedFilePath,
  previewLoading,
  previewMixxxData,
  previewPlaying,
  previewStartSec,
  windowVolumeRef: toRef(props, 'windowVolume'),
  resolveVisibleDurationSec,
  resolvePreviewDurationSec,
  clampPreviewStart,
  schedulePreviewDraw,
  isViewportInteracting: () => previewDragging.value,
  playheadRatio: HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
})

resolveWaveformCurrentSeconds = getPreviewPlaybackSec

const stopOverviewClock = () => {
  if (!overviewClockRaf) return
  cancelAnimationFrame(overviewClockRaf)
  overviewClockRaf = 0
}

const syncOverviewCurrentSec = (seconds: number = getPreviewPlaybackSec()) => {
  const duration = resolvePreviewDurationSec()
  const numeric = Number(seconds)
  if (!Number.isFinite(numeric)) return
  const next = duration > 0 ? Math.max(0, Math.min(numeric, duration)) : Math.max(0, numeric)
  if (Math.abs(next - overviewCurrentSec.value) <= 0.005) return
  overviewCurrentSec.value = next
}

const tickOverviewClock = () => {
  overviewClockRaf = 0
  if (!dialogVisible.value || !previewPlaying.value) return
  syncOverviewCurrentSec()
  overviewClockRaf = requestAnimationFrame(tickOverviewClock)
}

const startOverviewClock = () => {
  if (overviewClockRaf || !dialogVisible.value || !previewPlaying.value) return
  overviewClockRaf = requestAnimationFrame(tickOverviewClock)
}

const applyStablePresentationSeekTarget = (seconds: number) => {
  if (!compactVisualWaveformActive.value) return false
  const targetSec = normalizePreviewTimelineSeconds(seconds)
  const result = applyStableCanvasPresentation(targetSec, {
    allowReanchor: false,
    requirePresentable: true
  })
  if (!result.applied) return false
  applyPreviewPlaybackPosition(targetSec, false)
  if (previewPlaying.value) {
    reanchorStableCanvasPlayback(targetSec, 1)
  } else {
    stopStableCanvasPlayback()
  }
  return true
}

const applyPreviewSeekTarget = (seconds: number) => {
  const targetSec = normalizePreviewTimelineSeconds(seconds)
  if (compactVisualWaveformActive.value) {
    if (applyStablePresentationSeekTarget(targetSec)) return
    forceRenderStableSeekTarget(targetSec)
    return
  }
  applyPreviewPlaybackPosition(targetSec, true, true)
}

const { metronomeEnabled, metronomeVolumeLevel, metronomeSupported, cycleMetronomeState } =
  useMixtapeBeatAlignMetronome({
    dialogVisible,
    previewPlaying,
    bpm: computed(() => Number(previewBpm.value) || 0),
    firstBeatMs: computed(() => Number(previewFirstBeatMs.value) || 0),
    beatGridMap: () => previewBeatGridMap.value,
    outputVolume: toRef(props, 'windowVolume'),
    resolveAnchorSec: () => getPreviewPlaybackSec()
  })

const canToggleMetronome = computed(() => {
  if (previewLoading.value) return false
  if (!previewMixxxData.value) return false
  return metronomeSupported.value
})

const canStopPreviewPlayback = computed(() => {
  if (previewPlaying.value) return true
  if (previewLoading.value) return false
  return !!previewMixxxData.value
})

const handleMetronomeStateCycle = () => {
  if (!canToggleMetronome.value) return
  cycleMetronomeState()
}

const handlePreviewStopToStart = () => {
  stopPreviewPlayback({ syncPosition: false })
  previewStartSec.value = clampPreviewStart(-resolvePreviewLeadingPadSec())
  syncOverviewCurrentSec()
  schedulePreviewDraw()
}

const previewFirstBeatMsComputed = computed(() => Number(previewFirstBeatMs.value) || 0)

const dynamicGridEdit = useHorizontalBrowseDynamicBeatGridEdit({
  enabled: () => !previewLoading.value && !!previewMixxxData.value,
  song: () => sourceBeatAlignSong.value,
  previewBeatGridMap,
  previewBpm,
  previewBpmInput,
  previewFirstBeatMs,
  previewDownbeatBeatOffset,
  previewStartSec,
  previewWrapRef,
  resolveCurrentSec: () => getPreviewPlaybackSec(),
  resolvePreviewAnchorSec,
  resolvePreviewDurationSec,
  resolveVisibleDurationSec,
  clampPreviewStart,
  schedulePreviewDraw,
  schedulePersistGridDefinition: () => {}
})

applyDynamicPreviewBpm = (bpm: number) => {
  if (!dynamicGridEdit.isDynamic.value) return false
  return dynamicGridEdit.setActiveGridBpm(bpm)
}

watch(
  () => resolvePreviewDurationSec(),
  () => dynamicGridEdit.syncFromSong(),
  { flush: 'post' }
)

const handleCreateDynamicBoundaryAfterPlayhead = () => {
  dynamicGridEdit.createBoundaryAfterPlayhead()
}

const handleSelectWholeDynamicAdjustment = () => {
  dynamicGridEdit.selectWholeAdjustment()
}

const handleDeleteDynamicBoundary = () => {
  dynamicGridEdit.deleteSelectedBoundary()
}

const dynamicGridControlsDisabled = computed(() => dynamicGridEdit.gridControlsDisabled.value)
const dynamicBoundarySelected = computed(() => dynamicGridEdit.isBoundarySelected.value)
const dynamicGridAdjustScope = computed(() => dynamicGridEdit.adjustmentScope.value)

const {
  canAdjustGrid,
  handlePreviewMouseDownForGridTargetSelect,
  handleSetDownbeatLineAtPlayhead,
  handleGridShift
} = useMixtapeBeatAlignGridAdjust({
  previewWrapRef,
  previewLoading,
  previewMixxxData,
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
  getPreviewPlaybackSec,
  schedulePreviewDraw,
  downbeatBeatInterval: PREVIEW_DOWNBEAT_BEAT_INTERVAL,
  dynamicGridEdit
})

const clearPreviewWarmupTimer = () => {
  if (!previewWarmupTimer) return
  clearTimeout(previewWarmupTimer)
  previewWarmupTimer = null
}
const schedulePreviewWarmup = (
  filePath: string,
  requestSeq: number,
  delayMs: number = PREVIEW_WARMUP_DELAY_MS
) => {
  clearPreviewWarmupTimer()
  const normalized = filePath.trim()
  if (!normalized) return
  previewWarmupTimer = setTimeout(
    () => {
      previewWarmupTimer = null
      if (requestSeq !== previewLoadSequence) return
      if (normalizePathKey(props.filePath) !== normalizePathKey(normalized)) return
      void warmupPreviewPlayback(normalized)
    },
    Math.max(0, Number(delayMs) || 0)
  )
}

const { handlePreviewWheel, handlePreviewMouseDown, stopPreviewDragging } =
  useMixtapeBeatAlignPreviewInteraction({
    previewWrapRef,
    previewDragging,
    previewPlaying,
    previewMixxxData,
    previewStartSec,
    previewZoom,
    resolvePreviewDurationSec,
    resolveVisibleDurationSec,
    resolvePreviewAnchorSec,
    clampPreviewStart,
    getPreviewPlaybackSec,
    handlePreviewMouseDownForGridTargetSelect,
    requestCompactVisualWaveformStrip,
    startPreviewScrub,
    updatePreviewScrub,
    stopPreviewScrub,
    seekPreviewAnchorSec,
    beginDragCanvasPresentation,
    applyDragCanvasPresentationOffset,
    endDragCanvasPresentation,
    drawWaveformNow,
    schedulePreviewDraw,
    resetGridRenderer
  })

const handleOverviewSeek = (seconds: number) => {
  const duration = resolvePreviewDurationSec()
  const numeric = Number(seconds)
  if (!Number.isFinite(numeric) || duration <= 0) return
  const targetSec = Math.max(0, Math.min(numeric, duration))
  overviewCurrentSec.value = targetSec
  applyPreviewSeekTarget(targetSec)
  resetGridRenderer()
  void requestCompactVisualWaveformStrip(targetSec, { clearIfOutside: true })
  void seekPreviewAnchorSec(targetSec)
}

const resolvePreviewGridShiftMs = (targetCssPx: number) =>
  resolveHorizontalBrowseGridShiftMs(
    {
      resolveVisibleDurationSec,
      resolveWrapWidth: () => Number(previewWrapRef.value?.getBoundingClientRect().width || 0)
    },
    targetCssPx
  )

const handlePreviewGridShift = (targetCssPx: number, direction: 1 | -1) => {
  handleGridShift(resolvePreviewGridShiftMs(targetCssPx) * direction)
}

const handlePreviewGridShiftLargeLeft = () =>
  handlePreviewGridShift(HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_TARGET_CSS_PX, -1)

const handlePreviewGridShiftSmallLeft = () =>
  handlePreviewGridShift(HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_TARGET_CSS_PX, -1)

const handlePreviewGridShiftSmallRight = () =>
  handlePreviewGridShift(HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_TARGET_CSS_PX, 1)

const handlePreviewGridShiftLargeRight = () =>
  handlePreviewGridShift(HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_TARGET_CSS_PX, 1)

const loadPreviewWaveform = async (filePath: string) => {
  const normalized = typeof filePath === 'string' ? filePath.trim() : ''
  const requestSeq = ++previewLoadSequence
  clearPreviewWarmupTimer()
  stopPreviewPlayback({ syncPosition: false })
  invalidateWaveformTiles()
  resetLiveWaveformData()
  resetGridRenderer()
  replaceLiveWaveformRaw(null)
  clearPreviewCanvas()
  previewLoading.value = false
  previewMixxxData.value = null
  previewWaveformData.value = null
  compactVisualWaveformActive.value = false
  previewWaveformRequestStarted.value = false
  clearInitialGridAlignmentPending()
  previewError.value = ''
  previewZoom.value = HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM
  previewStartSec.value = 0
  overviewCurrentSec.value = 0
  syncPreviewBpmFromProps()
  previewDownbeatBeatOffset.value = normalizeBeatOffset(
    props.downbeatBeatOffset,
    PREVIEW_DOWNBEAT_BEAT_INTERVAL
  )
  previewFirstBeatMs.value = Number.isFinite(Number(props.firstBeatMs))
    ? Number(props.firstBeatMs)
    : 0
  previewTimeBasisOffsetMs.value = Math.max(0, Number(props.timeBasisOffsetMs) || 0)
  stopPreviewDragging()
  resetCompactVisualWaveformStrip()
  schedulePreviewDraw()
  if (!normalized || !window?.electron?.ipcRenderer?.invoke) {
    previewError.value = t('mixtape.gridAdjustWaveformUnavailable')
    schedulePreviewDraw()
    return
  }
  previewLoading.value = true
  // 对话框一打开即开始预解码，避免用户首次点击播放时才触发解码等待
  schedulePreviewWarmup(normalized, requestSeq, PREVIEW_WARMUP_EAGER_DELAY_MS)
  try {
    compactVisualWaveformActive.value = true
    previewWaveformRequestStarted.value = true
    markInitialGridAlignmentPending()
    previewStartSec.value = 0
    const requested = await requestCompactVisualWaveformStrip(resolvePreviewAnchorSec(), {
      force: true,
      clearIfOutside: true
    })
    if (requestSeq !== previewLoadSequence) return
    if (!requested) {
      clearInitialGridAlignmentPending()
      syncPreviewWaveformError()
    }
    schedulePreviewDraw()
  } catch {
    if (requestSeq !== previewLoadSequence) return
    clearInitialGridAlignmentPending()
    previewError.value = t('mixtape.gridAdjustWaveformUnavailable')
    previewLoading.value = false
    schedulePreviewDraw()
  }
}

const handleWindowResize = () => {
  schedulePreviewDraw()
}

const handleSongWaveformUpdated = (_event: unknown, payload?: { filePath?: string }) => {
  const updatedPath = normalizePathKey(payload?.filePath)
  const currentPath = normalizePathKey(props.filePath)
  if (!updatedPath || !currentPath || updatedPath !== currentPath) return
  void loadPreviewWaveform(props.filePath)
}

const handleWindowKeydown = (event: KeyboardEvent) => {
  if (!dialogVisible.value) return
  if (isEditableEventTarget(event.target)) return

  if (event.code === 'Space' || event.key === ' ') {
    event.preventDefault()
    handlePreviewPlaybackToggle()
    return
  }

  if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    event.preventDefault()
    const bpmValue = Number(previewBpm.value)
    const safeBpm =
      Number.isFinite(bpmValue) && bpmValue > 0 ? bpmValue : PREVIEW_SHORTCUT_FALLBACK_BPM
    const deltaSec = (60 / safeBpm) * PREVIEW_SHORTCUT_BEATS
    void nudgePreviewBySec(event.code === 'ArrowLeft' ? -deltaSec : deltaSec)
  }
}

watch(
  () => props.filePath,
  (nextPath) => {
    void loadPreviewWaveform(nextPath)
  },
  { immediate: true }
)

watch(
  () => props.bpm,
  () => {
    syncPreviewBpmFromProps()
  }
)

watch(
  () => previewBpm.value,
  () => {
    schedulePreviewDraw()
  }
)

watch(
  () => props.firstBeatMs,
  (next) => {
    previewFirstBeatMs.value = Number.isFinite(Number(next)) ? Number(next) : 0
    schedulePreviewDraw()
  }
)

watch(
  () => props.downbeatBeatOffset,
  (next) => {
    const normalized = normalizeBeatOffset(next, PREVIEW_DOWNBEAT_BEAT_INTERVAL)
    if (previewDownbeatBeatOffset.value === normalized) return
    previewDownbeatBeatOffset.value = normalized
    schedulePreviewDraw()
  }
)

watch(
  () => props.timeBasisOffsetMs,
  (next) => {
    previewTimeBasisOffsetMs.value = Math.max(0, Number(next) || 0)
    invalidateWaveformTiles()
    resetGridRenderer()
    schedulePreviewDraw()
  }
)

watch(
  () => previewStartSec.value,
  () => {
    if (previewPlaying.value) return
    syncOverviewCurrentSec()
  }
)

watch(
  () => previewPlaying.value,
  (playing) => {
    syncOverviewCurrentSec()
    if (playing) {
      startOverviewClock()
    } else {
      stopOverviewClock()
      syncOverviewCurrentSec()
    }
  }
)

watch(
  () => dialogVisible.value,
  (visible) => {
    if (visible) {
      syncOverviewCurrentSec()
      schedulePreviewDraw()
      startOverviewClock()
    } else {
      stopOverviewClock()
      resetPreviewBpmTap()
      stopPreviewPlayback({ syncPosition: false })
    }
  }
)

onMounted(() => {
  mountWaveformCanvasWorker()
  window.electron.ipcRenderer.on('song-waveform-updated', handleSongWaveformUpdated)
  window.addEventListener('resize', handleWindowResize, { passive: true })
  window.addEventListener('keydown', handleWindowKeydown)
})

onBeforeUnmount(() => {
  previewLoadSequence += 1
  clearPreviewWarmupTimer()
  resetPreviewBpmTap()
  cleanupPreviewPlayback()
  clearStableSeekRenderRaf()
  stopOverviewClock()
  disposeWaveformCanvas()
  disposeCompactVisualWaveformStrip()
  stopPreviewDragging()
  window.electron.ipcRenderer.removeListener('song-waveform-updated', handleSongWaveformUpdated)
  window.removeEventListener('resize', handleWindowResize)
  window.removeEventListener('keydown', handleWindowKeydown)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      v-dialog-drag="'.dialog-title'"
      class="inner"
      style="width: 820px; height: 520px; display: flex; flex-direction: column"
    >
      <div class="dialog-title dialog-header">
        <span>{{ t('mixtape.beatAlignDialogTitle') }}</span>
      </div>
      <div class="dialog-body">
        <bubbleBoxTrigger v-if="trackTitle" tag="div" class="track-name" :title="trackNameTitle">
          <span class="track-name__title">{{ trackTitle }}</span>
          <span class="track-name__meta"> · {{ trackMetaDisplay }}</span>
        </bubbleBoxTrigger>
        <MixtapeBeatAlignTopControls
          :preview-decoding="previewDecoding"
          :preview-playing="previewPlaying"
          :can-toggle-preview-playback="canTogglePreviewPlayback"
          :can-stop-preview-playback="canStopPreviewPlayback"
          :metronome-enabled="metronomeEnabled"
          :metronome-volume-level="metronomeVolumeLevel"
          :can-toggle-metronome="canToggleMetronome"
          @toggle-playback="handlePreviewPlaybackToggle"
          @stop-to-start="handlePreviewStopToStart"
          @cycle-metronome-state="handleMetronomeStateCycle"
        />
        <div
          ref="previewWrapRef"
          class="preview-canvas-wrap raw-detail-waveform raw-detail-waveform--up"
          :class="{
            'is-dragging': previewDragging
          }"
          @mousedown="handlePreviewMouseDown"
          @wheel.prevent="handlePreviewWheel"
        >
          <div ref="waveformSurfaceRef" class="raw-detail-waveform__surface">
            <canvas
              ref="waveformCanvasRef"
              class="raw-detail-waveform__canvas raw-detail-waveform__canvas--waveform"
            ></canvas>
            <canvas
              ref="waveformCanvasBackRef"
              class="raw-detail-waveform__canvas raw-detail-waveform__canvas--waveform raw-detail-waveform__canvas--buffer-back"
            ></canvas>
          </div>
          <div ref="overlaySurfaceRef" class="raw-detail-waveform__overlay-surface">
            <canvas
              ref="overlayCanvasRef"
              class="raw-detail-waveform__canvas raw-detail-waveform__canvas--overlay"
            ></canvas>
            <canvas
              ref="overlayCanvasBackRef"
              class="raw-detail-waveform__canvas raw-detail-waveform__canvas--overlay raw-detail-waveform__canvas--buffer-back"
            ></canvas>
          </div>
          <div
            class="preview-anchor-line"
            :class="{ 'is-active': previewPlaying }"
            :style="previewAnchorStyle"
          ></div>
          <div v-if="previewLoading" class="preview-status">
            {{ t('mixtape.gridAdjustWaveformLoading') }}
          </div>
          <div v-else-if="previewError" class="preview-status is-error">
            {{ previewError }}
          </div>
        </div>
        <MixtapeBeatAlignGridAdjustToolbar
          :disabled="!canAdjustGrid"
          :grid-controls-disabled="dynamicGridControlsDisabled"
          :bpm-input-value="previewBpmInput"
          :bpm-step="PREVIEW_BPM_STEP"
          :bpm-min="PREVIEW_BPM_MIN"
          :bpm-max="PREVIEW_BPM_MAX"
          :show-split-after-playhead="true"
          :show-delete-boundary="dynamicBoundarySelected"
          :grid-adjust-scope="dynamicGridAdjustScope"
          @set-downbeat-line="handleSetDownbeatLineAtPlayhead"
          @shift-left-large="handlePreviewGridShiftLargeLeft"
          @shift-left-small="handlePreviewGridShiftSmallLeft"
          @shift-right-small="handlePreviewGridShiftSmallRight"
          @shift-right-large="handlePreviewGridShiftLargeRight"
          @select-whole-adjustment="handleSelectWholeDynamicAdjustment"
          @split-after-playhead="handleCreateDynamicBoundaryAfterPlayhead"
          @delete-boundary="handleDeleteDynamicBoundary"
          @update-bpm-input="handlePreviewBpmInputUpdate"
          @blur-bpm-input="handlePreviewBpmInputBlur"
          @tap-bpm="handlePreviewBpmTap"
        />
        <div class="overview-canvas-wrap">
          <HorizontalBrowseWaveformOverview
            :song="beatAlignSong"
            :current-seconds="overviewCurrentSec"
            :duration-seconds="resolvePreviewDurationSec()"
            marker-anchor="top"
            @seek="handleOverviewSeek"
          />
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" @click="save">{{ t('mixtape.gridAdjustApply') }}</div>
        <div class="button" @click="cancel">{{ t('common.cancel') }}</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped src="./MixtapeBeatAlignDialog.scss"></style>
