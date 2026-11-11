import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { PRODUCT_DISPLAY_NAME } from '@shared/productBrand'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import confirmDialog from '@renderer/components/confirmDialog'
import { useMixtapeTimeline } from '@renderer/composables/mixtape/useMixtapeTimeline'
import { createMixtapeAutoGainController } from '@renderer/composables/mixtape/autoGainController'
import { createUseMixtapeBpmAndUiModule } from '@renderer/composables/mixtape/useMixtapeBpmAndUiModule'
import { createUseMixtapeStemRuntimeModule } from '@renderer/composables/mixtape/useMixtapeStemRuntimeModule'
import {
  MIXTAPE_ENVELOPE_PARAMS_STEM,
  MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL,
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  buildFlatMixEnvelope,
  normalizeMixEnvelopePoints
} from '@renderer/composables/mixtape/gainEnvelope'
import {
  normalizeBpm,
  normalizeDownbeatBeatOffset,
  normalizeFirstBeatMs,
  normalizeMixtapeFilePath,
  normalizeUniquePaths,
  parseSnapshot
} from '@renderer/composables/mixtape/mixtapeTrackSnapshot'
import {
  applyBpmResultsToTracks,
  buildMixtapeBpmTargetKey,
  buildMixtapeBpmTargets,
  resolveMissingBpmTrackCount
} from '@renderer/composables/mixtape/mixtapeBpmAnalysis'
import {
  buildRecFilename,
  resolveMixtapeOutputProgressState
} from '@renderer/composables/mixtape/mixtapeOutputProgress'
import { createMixtapeMissingTracksNotifier } from '@renderer/composables/mixtape/mixtapeMissingTracksNotifier'
import { useMixtapeMainWindowDrop } from '@renderer/composables/mixtape/useMixtapeMainWindowDrop'
import { createMixtapeGeneratedGlobalTempoRefresh } from '@renderer/composables/mixtape/mixtapeGeneratedGlobalTempoRefresh'
import { createMixtapeSongMetadataSync } from '@renderer/composables/mixtape/mixtapeSongMetadataSync'
import { getKeyDisplayText as formatKeyDisplayText } from '@shared/keyDisplay'
import {
  DEFAULT_MIXTAPE_STEM_PROFILE,
  resolveMixtapeStemModelByProfile
} from '@shared/mixtapeStemProfiles'
import { FIXED_MIXTAPE_STEM_MODE } from '@shared/mixtapeStemMode'
import { createClickThroughGuard } from '@renderer/utils/clickThroughGuard'
import type {
  MixtapeMixMode,
  MixtapeOpenPayload,
  MixtapeStemMode,
  MixtapeStemProfile as RendererMixtapeStemProfile,
  MixtapeTrack,
  MixtapeRawItem
} from '@renderer/composables/mixtape/types'
import type { MixtapeOutputProgressPayload } from '@renderer/composables/mixtape/timelineTransportRenderWav'
import type { Ref } from 'vue'

type PlaylistContentChangedPayload = {
  uuids?: string[]
}

type MixtapeItemsRemovedPayload = {
  playlistId?: string
}
const decodeMixtapeQueryValue = (value: string | null): string | undefined => {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
const resolveInitialMixtapePayload = (): MixtapeOpenPayload => {
  if (typeof window === 'undefined') return {}
  try {
    const params = new URLSearchParams(window.location.search)
    return {
      playlistId: params.get('playlistId') || undefined,
      playlistPath: decodeMixtapeQueryValue(params.get('playlistPath')),
      playlistName: decodeMixtapeQueryValue(params.get('playlistName'))
    }
  } catch {
    return {}
  }
}
type UseMixtapeOptions = {
  layoutScaleDeps?: Ref<unknown>[]
}

export const useMixtape = (options: UseMixtapeOptions = {}) => {
  const contextMenuClickThroughGuard = createClickThroughGuard()
  const CONTEXT_MENU_SELECTOR = '[data-frkb-context-menu="true"]'
  const payload = ref<MixtapeOpenPayload>(resolveInitialMixtapePayload())
  const mixtapeMixMode = ref<MixtapeMixMode>('stem')
  const mixtapeStemMode = ref<MixtapeStemMode>(FIXED_MIXTAPE_STEM_MODE)
  const mixtapeStemProfile = ref<RendererMixtapeStemProfile>(DEFAULT_MIXTAPE_STEM_PROFILE)
  const tracks = ref<MixtapeTrack[]>([])
  const mixtapeRawItems = ref<MixtapeRawItem[]>([])
  const mixtapeItemsLoading = ref(!!payload.value.playlistId)
  const selectedTrackId = ref('')
  const runtime = useRuntimeStore()
  const outputPath = ref('')
  const outputFormat = ref<'wav' | 'mp3'>('wav')
  const outputFilename = ref(buildRecFilename())
  const outputDialogVisible = ref(false)
  const outputRunning = ref(false)
  const outputProgressKey = ref('mixtape.outputProgressPreparing')
  const outputProgressPercent = ref(0)
  const outputProgressDone = ref(0)
  const outputProgressTotal = ref(100)
  const stemRetryingTrackIdMap = ref<Record<string, boolean>>({})
  const trackContextMenuVisible = ref(false)
  const trackContextMenuX = ref(0)
  const trackContextMenuY = ref(0)
  const trackContextTrackId = ref('')
  const beatAlignDialogVisible = ref(false)
  const beatAlignTrackId = ref('')
  const bpmAnalysisActive = ref(false)
  const bpmAnalysisFailed = ref(false)
  const bpmAnalysisFailedCount = ref(0)
  const bpmAnalysisFailedReason = ref('')
  let playlistUpdateTimer: ReturnType<typeof setTimeout> | null = null
  const { notifyMissingTracksRemoved } = createMixtapeMissingTracksNotifier()
  const {
    clearTimelineLayoutCache,
    updateTimelineWidth,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    renderZoomLevel,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatSeconds,
    laneIndices,
    laneHeight,
    laneTracks,
    resolveTrackBlockStyle,
    resolveGainEnvelopePolyline,
    resolveTrackTitle,
    formatTrackBpm,
    isRawWaveformLoading,
    preRenderState,
    preRenderPercent,
    timelineRootRef,
    rulerRef,
    timelineVisualScale,
    handleTrackDragStart,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadVisible,
    playheadSec,
    followPlayheadEnabled,
    playheadTimeLabel,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    overviewPlayheadStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    handleTransportToggle,
    handleTransportPlayFromStart,
    handleTransportStop,
    handleRulerSeek,
    handleToggleFollowPlayhead,
    transportError,
    renderMixtapeOutputWav,
    setTransportMasterVolume,
    timelineScrollWrapRef,
    isTimelinePanning,
    handleTimelinePanStart,
    handleTimelineHorizontalPanStart,
    timelineScrollRef,
    timelineScrollbarOptions,
    timelineViewport,
    timelineContentWidth,
    timelineScrollLeft,
    timelineViewportWidth,
    timelineCanvasRef,
    envelopePreviewRef,
    overviewRef,
    isOverviewDragging,
    handleOverviewMouseDown,
    handleOverviewClick,
    resolveOverviewTrackStyle,
    overviewViewportStyle,
    setZoomValue,
    applyRenderZoomImmediate
  } = useMixtapeTimeline({
    tracks,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    mixtapeMixMode,
    mixtapeStemMode,
    layoutScaleDeps: options.layoutScaleDeps
  })
  const {
    createEmptyStemSummary,
    stemSummary,
    stemRuntimeProgressByTrackId,
    stemResumeBootstrappedPlaylistIdSet,
    stemResumeSignatureByPlaylistId,
    normalizeStemProfile,
    normalizeMixtapeStemStatus,
    normalizeStemSummary,
    stemSeparationProgressVisible,
    stemSeparationProgressPercent,
    stemSeparationProgressText,
    stemSeparationRunningProgressLines,
    hasTrackStemPathsReady,
    resolveTrackStemModel,
    pruneStemRuntimeProgressByTracks,
    handlePlaylistIdChange,
    resetStemResumeStateOnReopen,
    autoResumePendingStemJobs,
    handleStemStatusPayload,
    handleMixtapeStemCpuSlowHint,
    handleMixtapeStemRuntimeProgress
  } = createUseMixtapeStemRuntimeModule({
    payload,
    tracks,
    mixtapeMixMode,
    mixtapeStemProfile,
    resolveTrackTitle,
    t,
    confirmDialog
  })
  const displayName = computed(() => {
    return (
      payload.value.playlistName ||
      payload.value.playlistPath ||
      payload.value.playlistId ||
      t('mixtape.playlistUnknown')
    )
  })
  const titleLabel = computed(() => {
    return `${PRODUCT_DISPLAY_NAME} - ${t('mixtape.title')} - ${displayName.value}`
  })
  const mixtapePlaylistId = computed(() => String(payload.value.playlistId || ''))
  const normalizeMixtapeMixMode = (value: unknown): MixtapeMixMode =>
    value === 'eq' ? 'eq' : 'stem'
  const normalizeMixtapeStemMode = (_value: unknown): MixtapeStemMode => FIXED_MIXTAPE_STEM_MODE
  const trackContextMenuStyle = computed(() => ({
    left: `${trackContextMenuX.value}px`,
    top: `${trackContextMenuY.value}px`
  }))
  const beatAlignTrack = computed(() => {
    const trackId = beatAlignTrackId.value
    if (!trackId) return null
    return tracks.value.find((track) => track.id === trackId) || null
  })
  const trackContextTrack = computed(() => {
    const trackId = trackContextTrackId.value
    if (!trackId) return null
    return tracks.value.find((track) => track.id === trackId) || null
  })
  const trackMenuMasterTempoChecked = computed(() => trackContextTrack.value?.masterTempo !== false)
  const formatOutputProgressSeconds = (value: number) => {
    const total = Math.max(0, Math.round(value))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    const pad = (item: number) => String(item).padStart(2, '0')
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
  }
  const outputProgressText = computed(() => {
    const stageKey = outputProgressKey.value || 'mixtape.outputProgressPreparing'
    const stageLabel = t(stageKey)
    const done = Math.max(0, Number(outputProgressDone.value) || 0)
    const total = Math.max(0, Number(outputProgressTotal.value) || 0)
    if (stageKey === 'mixtape.outputProgressRendering' && total > 0) {
      return `${stageLabel} · ${t('mixtape.outputProgressRenderingDetail', {
        done: formatOutputProgressSeconds(done),
        total: formatOutputProgressSeconds(total)
      })}`
    }
    if (stageKey === 'mixtape.outputProgressDecoding' && total > 0) {
      return `${stageLabel} · ${t('mixtape.outputProgressDecodingDetail', { done, total })}`
    }
    return stageLabel
  })
  const formatTrackKey = (value?: string) => {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) return ''
    if (raw.toLowerCase() === 'o') return '-'
    const style = runtime.setting.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
    return formatKeyDisplayText(raw, style)
  }
  const formatTrackOriginalMeta = (track?: MixtapeTrack | null) => {
    if (!track) return ''
    const originalBpm = Number(track.originalBpm)
    const originalBpmText =
      Number.isFinite(originalBpm) && originalBpm > 0 ? formatTrackBpm(originalBpm) : ''
    const originalKeyText = formatTrackKey(track.originalKey || track.key)
    if (originalBpmText && originalKeyText) {
      return t('mixtape.originalMetaBoth', { bpm: originalBpmText, key: originalKeyText })
    }
    if (originalBpmText) {
      return t('mixtape.originalMetaBpmOnly', { bpm: originalBpmText })
    }
    if (originalKeyText) {
      return t('mixtape.originalMetaKeyOnly', { key: originalKeyText })
    }
    return ''
  }
  const resolveTrackTitleWithOriginalMeta = (track: MixtapeTrack) => {
    const baseTitle = resolveTrackTitle(track)
    const originalMeta = formatTrackOriginalMeta(track)
    if (!originalMeta) return baseTitle
    return `${baseTitle} (${originalMeta})`
  }
  const mixtapeMenus = computed(() => [
    {
      name: 'mixtape.menuOutput',
      subMenu: [],
      directAction: 'mixtape.menuOutput',
      disabled: outputRunning.value
    }
  ])
  const applyPayload = (next: MixtapeOpenPayload) => {
    payload.value = {
      ...payload.value,
      ...(next || {})
    }
  }
  const { refreshGeneratedGlobalTempoEnvelope } = createMixtapeGeneratedGlobalTempoRefresh({
    payload,
    tracks,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatSeconds
  })
  const refreshMixtapeTrackDerivedUi = () => {
    refreshGeneratedGlobalTempoEnvelope()
    clearTimelineLayoutCache()
    updateTimelineWidth(false)
    scheduleTimelineDraw()
    scheduleFullPreRender()
    scheduleWorkerPreRender()
  }
  const {
    handleSongKeyUpdated,
    handleSongGridUpdated,
    handleSongGridBatchUpdated,
    handleSongHotCuesUpdated,
    handleSongMemoryCuesUpdated
  } = createMixtapeSongMetadataSync({
    tracks,
    mixtapeRawItems,
    normalizeMixtapeFilePath,
    normalizeBpm,
    normalizeFirstBeatMs,
    normalizeDownbeatBeatOffset,
    refreshMixtapeTrackDerivedUi
  })
  const buildBpmTargets = () => buildMixtapeBpmTargets(tracks.value)
  const resolveMissingBpmCount = (bpmTargets: Set<string>) =>
    resolveMissingBpmTrackCount(tracks.value, bpmTargets)
  const applyBpmAnalysisToTracks = (results: unknown[]) => {
    const applied = applyBpmResultsToTracks(tracks.value, results)
    if (applied.resolvedCount <= 0) return applied
    tracks.value = applied.nextTracks
    if (applied.changedCount > 0) {
      clearTimelineLayoutCache()
      updateTimelineWidth(false)
      scheduleTimelineDraw()
      scheduleFullPreRender()
      scheduleWorkerPreRender()
    }
    return applied
  }
  // BPM、菜单与导出逻辑已拆分到 useMixtapeBpmAndUiModule
  const persistGainEnvelope = async (
    entries: Array<{ itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> }>
  ) => {
    if (!entries.length || !window?.electron?.ipcRenderer?.invoke) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:update-gain-envelope', { entries })
    } catch (error) {
      console.error('[mixtape] update gain envelope failed', {
        count: entries.length,
        error
      })
    }
  }
  const showAutoGainErrorDialog = async (message: string) => {
    await confirmDialog({
      title: t('common.error'),
      content: [message],
      confirmShow: false
    })
  }
  const {
    autoGainDialogVisible,
    autoGainReferenceTrackId,
    autoGainReferenceFeedback,
    autoGainBusy,
    autoGainReferenceOptions,
    autoGainProgressText,
    canStartAutoGain,
    openAutoGainDialog,
    handleAutoGainDialogCancel,
    handleAutoGainDialogConfirm,
    handleAutoGainSelectLoudestReference,
    handleAutoGainSelectQuietestReference,
    syncReferenceTrack: syncAutoGainReferenceTrack,
    resetAutoGainState
  } = createMixtapeAutoGainController({
    tracks,
    selectedTrackId,
    bpmAnalysisActive,
    resolveTrackTitle,
    t,
    onEnvelopeApplied: () => {
      clearTimelineLayoutCache()
      updateTimelineWidth(false)
      scheduleTimelineDraw()
    },
    persistGainEnvelope,
    showErrorDialog: showAutoGainErrorDialog
  })
  const {
    handleBpmBatchReady,
    dismissBpmAnalysisFailure,
    retryBpmAnalysis,
    loadMixtapeItems,
    handleTrackContextMenu,
    handleTrackMenuAdjustGrid,
    handleTrackMenuToggleMasterTempo,
    handleTrackMenuRemoveFromMixtape,
    handleBeatAlignDialogCancel,
    handleBeatAlignGridDefinitionSave,
    handleGlobalPointerDown,
    handleWindowKeydown,
    openOutputDialog,
    applyOutputProgressPayload,
    handleOutputDialogConfirm,
    handleOutputDialogCancel,
    handleOutputCancelRunning
  } = createUseMixtapeBpmAndUiModule({
    payload,
    tracks,
    mixtapeRawItems,
    mixtapeItemsLoading,
    selectedTrackId,
    mixtapeMixMode,
    mixtapeStemMode,
    mixtapeStemProfile,
    outputDialogVisible,
    outputRunning,
    outputPath,
    outputFormat,
    outputFilename,
    outputProgressKey,
    outputProgressPercent,
    outputProgressDone,
    outputProgressTotal,
    trackContextMenuVisible,
    trackContextMenuX,
    trackContextMenuY,
    trackContextTrackId,
    beatAlignDialogVisible,
    beatAlignTrackId,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    bpmAnalysisFailedCount,
    bpmAnalysisFailedReason,
    stemSummary,
    stemRuntimeProgressByTrackId,
    stemResumeBootstrappedPlaylistIdSet,
    stemResumeSignatureByPlaylistId,
    autoGainDialogVisible,
    transportPreloading,
    transportPlaying,
    transportDecoding,
    createEmptyStemSummary,
    applyBpmAnalysisToTracks,
    buildBpmTargets,
    resolveMissingBpmCount,
    buildMixtapeBpmTargetKey,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    clearTimelineLayoutCache,
    updateTimelineWidth,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatSeconds,
    resolveTrackTitle,
    renderMixtapeOutputWav,
    normalizeMixtapeFilePath,
    normalizeMixtapeMixMode,
    normalizeMixtapeStemMode,
    normalizeStemProfile,
    normalizeMixtapeStemStatus,
    normalizeStemSummary,
    normalizeUniquePaths,
    parseSnapshot,
    hasTrackStemPathsReady,
    autoResumePendingStemJobs,
    pruneStemRuntimeProgressByTracks,
    resolveTrackStemModel,
    syncAutoGainReferenceTrack,
    resetAutoGainState,
    notifyMissingTracksRemoved,
    resolveMixtapeStemModelByProfile,
    resolveMixtapeOutputProgressState,
    normalizeDownbeatBeatOffset,
    normalizeFirstBeatMs,
    normalizeBpm,
    MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL,
    MIXTAPE_ENVELOPE_PARAMS_STEM,
    MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
    buildFlatMixEnvelope,
    normalizeMixEnvelopePoints,
    DEFAULT_MIXTAPE_STEM_PROFILE,
    confirmDialog,
    t,
    handleTransportStop,
    handleTransportPlayFromStart
  })
  const schedulePlaylistReload = () => {
    if (playlistUpdateTimer) {
      clearTimeout(playlistUpdateTimer)
    }
    playlistUpdateTimer = setTimeout(() => {
      playlistUpdateTimer = null
      loadMixtapeItems({ background: true })
    }, 120)
  }
  const scrollTimelineToEnd = () => {
    nextTick(() => {
      requestAnimationFrame(() => {
        const viewport = timelineScrollRef.value?.osInstance()?.elements().viewport as
          HTMLElement | undefined
        if (!viewport) return
        viewport.scrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
      })
    })
  }
  const {
    mixtapeDropOverlayVisible,
    mixtapeDropOverlayTitle,
    mixtapeDropOverlayHint,
    dropBusy: mixtapeDropBusy,
    handleMixtapeSongDragEnter,
    handleMixtapeSongDragOver,
    handleMixtapeSongDragLeave,
    handleMixtapeSongDrop
  } = useMixtapeMainWindowDrop({
    payload,
    tracks,
    selectedTrackId,
    loadMixtapeItems,
    scrollTimelineToEnd,
    t
  })
  const handlePlaylistContentChanged = (eventPayload: PlaylistContentChangedPayload | null) => {
    const playlistId = payload.value.playlistId
    if (!playlistId) return
    const uuids: string[] = Array.isArray(eventPayload?.uuids)
      ? eventPayload.uuids.filter(Boolean)
      : []
    if (!uuids.includes(playlistId)) return
    schedulePlaylistReload()
  }
  const handleMixtapeItemsRemoved = (
    _e: unknown,
    eventPayload: MixtapeItemsRemovedPayload | null
  ) => {
    const playlistId = String(payload.value.playlistId || '').trim()
    if (!playlistId) return
    const targetPlaylistId =
      typeof eventPayload?.playlistId === 'string' ? eventPayload.playlistId.trim() : ''
    if (!targetPlaylistId || targetPlaylistId !== playlistId) return
    schedulePlaylistReload()
  }
  const handleMixtapeStemStatusUpdated = (_e: unknown, eventPayload: unknown) => {
    if (!handleStemStatusPayload(eventPayload)) return
    schedulePlaylistReload()
  }
  const handleOpen = (_e: unknown, next: MixtapeOpenPayload) => {
    if (!next || typeof next !== 'object') return
    const currentPlaylistId = String(payload.value.playlistId || '').trim()
    const nextPlaylistId = String(next.playlistId || '').trim()
    resetStemResumeStateOnReopen(nextPlaylistId, currentPlaylistId)
    applyPayload(next)
    loadMixtapeItems()
  }
  const handleMixtapeOutputProgress = (
    _e: unknown,
    payload: MixtapeOutputProgressPayload | null
  ) => {
    applyOutputProgressPayload(payload)
  }
  const handleRetryTrackStem = async (trackId: string) => {
    const playlistId = String(payload.value.playlistId || '').trim()
    const normalizedTrackId = String(trackId || '').trim()
    if (!playlistId || !normalizedTrackId || !window?.electron?.ipcRenderer?.invoke) return
    const targetTrack = tracks.value.find((track) => track.id === normalizedTrackId)
    if (!targetTrack) return
    if (stemRetryingTrackIdMap.value[normalizedTrackId]) return
    const filePath = normalizeMixtapeFilePath(targetTrack.filePath)
    stemRetryingTrackIdMap.value = {
      ...stemRetryingTrackIdMap.value,
      [normalizedTrackId]: true
    }
    try {
      await window.electron.ipcRenderer.invoke('mixtape:stem:retry', {
        playlistId,
        stemMode: mixtapeStemMode.value,
        itemIds: [normalizedTrackId],
        filePaths: filePath ? [filePath] : [],
        profile: mixtapeStemProfile.value
      })
      await loadMixtapeItems({ background: true })
    } catch (error) {
      console.error('[mixtape] retry track stem failed', {
        playlistId,
        trackId: normalizedTrackId,
        filePath,
        error
      })
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.stemRetryFailed')],
        confirmShow: false
      })
    } finally {
      const next = { ...stemRetryingTrackIdMap.value }
      delete next[normalizedTrackId]
      stemRetryingTrackIdMap.value = next
    }
  }
  const handleTitleOpenDialog = (key: string) => {
    if (!key) return
    if (key === 'mixtape.menuOutput') {
      if (outputRunning.value) return
      openOutputDialog()
      return
    }
    if (key === 'menu.exit') {
      window.electron.ipcRenderer.send('toggle-close')
      window.electron.ipcRenderer.send('mixtapeWindow-toggle-close')
      return
    }
    window.electron.ipcRenderer.send('mixtapeWindow-open-dialog', key)
  }

  const hasOpenContextMenu = () => {
    return !!document.querySelector(CONTEXT_MENU_SELECTOR)
  }

  const isInsideContextMenu = (target: EventTarget | null) => {
    const element = target as Element | null
    if (!element) return false
    return !!element.closest(CONTEXT_MENU_SELECTOR)
  }

  const handleContextMenuPointerDownCapture = (event: PointerEvent) => {
    if (event.button !== 0) return
    if (!hasOpenContextMenu()) return
    if (isInsideContextMenu(event.target)) return
    contextMenuClickThroughGuard.markFromPointer(event)
    event.preventDefault()
    event.stopPropagation()
  }

  const handleContextMenuClickCapture = (event: MouseEvent) => {
    contextMenuClickThroughGuard.suppressClickIfNeeded(event)
  }

  // immediate: true 会在 setup 阶段触发，早于 onMounted 中的 IPC 监听器注册。
  // 这是安全的：loadMixtapeItems() 是主动加载，不依赖 IPC 事件；
  // IPC 监听器用于后续状态更新（BPM、stem 等），注册稍晚不影响初始加载。
  watch(
    () => payload.value.playlistId,
    (nextPlaylistId, prevPlaylistId) => {
      handlePlaylistIdChange(nextPlaylistId, prevPlaylistId)
      loadMixtapeItems()
    },
    { immediate: true }
  )
  onMounted(() => {
    applyPayload(resolveInitialMixtapePayload())
    window.electron.ipcRenderer.on('song-key-updated', handleSongKeyUpdated)
    window.electron.ipcRenderer.on('song-hot-cues-updated', handleSongHotCuesUpdated)
    window.electron.ipcRenderer.on('song-memory-cues-updated', handleSongMemoryCuesUpdated)
    window.electron.ipcRenderer.on('song-grid-batch-updated', handleSongGridBatchUpdated)
    window.electron.ipcRenderer.on('song-grid-updated', handleSongGridUpdated)
    window.electron.ipcRenderer.on('mixtape-open', handleOpen)
    window.electron.ipcRenderer.on('mixtape-bpm-batch-ready', handleBpmBatchReady)
    window.electron.ipcRenderer.on('mixtape-stem-status-updated', handleMixtapeStemStatusUpdated)
    window.electron.ipcRenderer.on('mixtape-stem-cpu-slow-hint', handleMixtapeStemCpuSlowHint)
    window.electron.ipcRenderer.on(
      'mixtape-stem-runtime-progress',
      handleMixtapeStemRuntimeProgress
    )
    window.electron.ipcRenderer.on('mixtape-output:progress', handleMixtapeOutputProgress)
    window.electron.ipcRenderer.on('mixtape-items-removed', handleMixtapeItemsRemoved)
    window.electron.ipcRenderer.on('mixtapeWindow-max', (_e, next: boolean) => {
      runtime.isWindowMaximized = !!next
    })
    emitter.on('playlistContentChanged', handlePlaylistContentChanged)
    window.addEventListener('pointerdown', handleContextMenuPointerDownCapture, true)
    window.addEventListener('click', handleContextMenuClickCapture, true)
    window.addEventListener('pointerdown', handleGlobalPointerDown, true)
    window.addEventListener('keydown', handleWindowKeydown)
  })
  onBeforeUnmount(() => {
    window.electron.ipcRenderer.removeListener('song-hot-cues-updated', handleSongHotCuesUpdated)
    window.electron.ipcRenderer.removeListener(
      'song-memory-cues-updated',
      handleSongMemoryCuesUpdated
    )
    try {
      window.electron.ipcRenderer.removeListener('song-key-updated', handleSongKeyUpdated)
    } catch {}
    try {
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener('song-grid-updated', handleSongGridUpdated)
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener(
        'song-grid-batch-updated',
        handleSongGridBatchUpdated
      )
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener('mixtape-open', handleOpen)
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener('mixtape-bpm-batch-ready', handleBpmBatchReady)
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener(
        'mixtape-stem-status-updated',
        handleMixtapeStemStatusUpdated
      )
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener(
        'mixtape-stem-cpu-slow-hint',
        handleMixtapeStemCpuSlowHint
      )
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener(
        'mixtape-stem-runtime-progress',
        handleMixtapeStemRuntimeProgress
      )
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener(
        'mixtape-output:progress',
        handleMixtapeOutputProgress
      )
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener('mixtape-items-removed', handleMixtapeItemsRemoved)
    } catch {}
    try {
      window.electron.ipcRenderer.removeAllListeners('mixtapeWindow-max')
    } catch {}
    try {
      emitter.off('playlistContentChanged', handlePlaylistContentChanged)
    } catch {}
    try {
      window.removeEventListener('pointerdown', handleContextMenuPointerDownCapture, true)
    } catch {}
    try {
      window.removeEventListener('click', handleContextMenuClickCapture, true)
    } catch {}
    try {
      window.removeEventListener('pointerdown', handleGlobalPointerDown, true)
    } catch {}
    try {
      window.removeEventListener('keydown', handleWindowKeydown)
    } catch {}
    if (playlistUpdateTimer) {
      clearTimeout(playlistUpdateTimer)
      playlistUpdateTimer = null
    }
    contextMenuClickThroughGuard.clear()
  })
  return {
    t,
    titleLabel,
    mixtapePlaylistId,
    mixtapeMixMode,
    mixtapeStemMode,
    mixtapeStemProfile,
    mixtapeMenus,
    handleTitleOpenDialog,
    mixtapeRawItems,
    mixtapeItemsLoading,
    tracks,
    clearTimelineLayoutCache,
    updateTimelineWidth,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    laneIndices,
    laneHeight,
    laneTracks,
    renderZoomLevel,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatSeconds,
    resolveTrackBlockStyle,
    resolveGainEnvelopePolyline,
    resolveTrackTitle,
    resolveTrackTitleWithOriginalMeta,
    formatTrackBpm,
    formatTrackKey,
    formatTrackOriginalMeta,
    isRawWaveformLoading,
    preRenderState,
    preRenderPercent,
    timelineRootRef,
    rulerRef,
    timelineVisualScale,
    handleTrackDragStart,
    handleTrackContextMenu,
    trackContextMenuVisible,
    trackContextMenuStyle,
    handleTrackMenuAdjustGrid,
    handleTrackMenuToggleMasterTempo,
    handleTrackMenuRemoveFromMixtape,
    trackMenuMasterTempoChecked,
    beatAlignDialogVisible,
    beatAlignTrack,
    handleBeatAlignDialogCancel,
    handleBeatAlignGridDefinitionSave,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadVisible,
    playheadSec,
    followPlayheadEnabled,
    playheadTimeLabel,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    overviewPlayheadStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    handleTransportToggle,
    handleTransportPlayFromStart,
    handleTransportStop,
    handleRulerSeek,
    handleToggleFollowPlayhead,
    transportError,
    setTransportMasterVolume,
    timelineScrollWrapRef,
    isTimelinePanning,
    handleTimelinePanStart,
    handleTimelineHorizontalPanStart,
    timelineScrollRef,
    timelineScrollbarOptions,
    timelineViewport,
    timelineContentWidth,
    timelineScrollLeft,
    timelineViewportWidth,
    timelineCanvasRef,
    envelopePreviewRef,
    overviewRef,
    isOverviewDragging,
    handleOverviewMouseDown,
    handleOverviewClick,
    resolveOverviewTrackStyle,
    overviewViewportStyle,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    bpmAnalysisFailedCount,
    bpmAnalysisFailedReason,
    dismissBpmAnalysisFailure,
    retryBpmAnalysis,
    outputDialogVisible,
    outputPath,
    outputFormat,
    outputFilename,
    outputRunning,
    outputProgressText,
    outputProgressPercent,
    stemRetryingTrackIdMap,
    stemRuntimeProgressByTrackId,
    handleOutputDialogConfirm,
    handleOutputDialogCancel,
    handleOutputCancelRunning,
    stemSeparationProgressVisible,
    stemSeparationProgressPercent,
    stemSeparationProgressText,
    stemSeparationRunningProgressLines,
    handleRetryTrackStem,
    autoGainDialogVisible,
    autoGainReferenceTrackId,
    autoGainReferenceFeedback,
    autoGainReferenceOptions,
    autoGainBusy,
    autoGainProgressText,
    canStartAutoGain,
    mixtapeDropOverlayVisible,
    mixtapeDropOverlayTitle,
    mixtapeDropOverlayHint,
    mixtapeDropBusy,
    handleMixtapeSongDragEnter,
    handleMixtapeSongDragOver,
    handleMixtapeSongDragLeave,
    handleMixtapeSongDrop,
    openAutoGainDialog,
    handleAutoGainDialogCancel,
    handleAutoGainDialogConfirm,
    handleAutoGainSelectLoudestReference,
    handleAutoGainSelectQuietestReference,
    setZoomValue,
    applyRenderZoomImmediate
  }
}
