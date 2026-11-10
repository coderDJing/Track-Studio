import { computed, nextTick, ref, watch, type CSSProperties, type Ref } from 'vue'
import ascendingOrderAsset from '@renderer/assets/ascending-order.svg?asset'
import descendingOrderAsset from '@renderer/assets/descending-order.svg?asset'
import { useWaveformPreviewPlayer } from '@renderer/pages/modules/songsArea/composables/useWaveformPreviewPlayer'
import { useMixtape } from '@renderer/composables/useMixtape'
import { createMixtapeGainEnvelopeEditor } from '@renderer/composables/mixtape/useGainEnvelopeEditor'
import { useMixtapeAutoGainDialog } from '@renderer/composables/mixtape/useMixtapeAutoGainDialog'
import { useMixtapeEnvelopePreview } from '@renderer/composables/mixtape/useMixtapeEnvelopePreview'
import { useMixtapeMixParamUi } from '@renderer/composables/mixtape/useMixtapeMixParamUi'
import { useMixtapeMasterTempoLane } from '@renderer/composables/mixtape/useMixtapeMasterTempoLane'
import { useMixtapeOutputAvailability } from '@renderer/composables/mixtape/useMixtapeOutputAvailability'
import { useMixtapeShellUi } from '@renderer/composables/mixtape/useMixtapeShellUi'
import { useMixtapeStemPlaceholderState } from '@renderer/composables/mixtape/useMixtapeStemPlaceholderState'
import { useMixtapeTrackLoopEditor } from '@renderer/composables/mixtape/useMixtapeTrackLoopEditor'
import { useMixtapeTrackDragUndo } from '@renderer/composables/mixtape/useMixtapeTrackDragUndo'
import { useMixtapeCueOverlap } from '@renderer/composables/mixtape/useMixtapeCueOverlap'
import { useMixtapeProjectGain } from '@renderer/composables/mixtape/useMixtapeProjectGain'
import confirmDialog from '@renderer/components/confirmDialog'
import type {
  MixtapeEnvelopeParamId,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'
import {
  MIXTAPE_WINDOW_VOLUME_STORAGE_KEY,
  readWindowVolume,
  writeWindowVolume
} from '@renderer/utils/windowVolume'
import { formatWindowTitle } from '@renderer/utils/windowTitle'

type UseMixtapePageUiOptions = {
  mixtape: ReturnType<typeof useMixtape>
  masterTempoLaneExpanded: Ref<boolean>
  showToast: (message: string) => void
}

export const useMixtapePageUi = ({
  mixtape,
  masterTempoLaneExpanded,
  showToast
}: UseMixtapePageUiOptions) => {
  const projectGainBusy = ref(false)
  const mixtapeWindowVolume = ref(readWindowVolume(MIXTAPE_WINDOW_VOLUME_STORAGE_KEY))
  mixtape.setTransportMasterVolume(mixtapeWindowVolume.value)
  const mixtapeWindowTitle = computed(() => formatWindowTitle(mixtape.titleLabel.value))

  watch(
    mixtapeWindowTitle,
    (title) => {
      document.title = title
    },
    { immediate: true }
  )

  const handleMixtapeWindowVolumeChange = (value: number) => {
    const nextVolume = writeWindowVolume(MIXTAPE_WINDOW_VOLUME_STORAGE_KEY, value)
    mixtapeWindowVolume.value = nextVolume
    mixtape.setTransportMasterVolume(nextVolume)
  }

  const { canOutput: canOutputFromTitle } = useMixtapeOutputAvailability({
    tracks: mixtape.tracks,
    mixtapeItemsLoading: mixtape.mixtapeItemsLoading,
    mixtapeMixMode: mixtape.mixtapeMixMode,
    mixtapeStemProfile: mixtape.mixtapeStemProfile,
    bpmAnalysisActive: mixtape.bpmAnalysisActive,
    transportDecoding: mixtape.transportDecoding,
    transportPreloading: mixtape.transportPreloading,
    outputRunning: mixtape.outputRunning,
    resolveTrackSourceDurationSeconds: mixtape.resolveTrackSourceDurationSeconds
  })

  const titleMenus = computed(() => [
    {
      name: 'mixtape.menuOutput',
      subMenu: [],
      directAction: 'mixtape.menuOutput',
      disabled: !canOutputFromTitle.value || projectGainBusy.value
    },
    {
      name: 'mixtape.cueOverlapTitle',
      subMenu: [],
      directAction: 'mixtape.cueOverlapTitle',
      disabled: !cueOverlap.canOpen.value
    }
  ])

  const handleTitleMenuOpen = (key: string) => {
    if (projectGainBusy.value) return
    if (key === 'mixtape.cueOverlapTitle') {
      void cueOverlap.open()
      return
    }
    if (key === 'mixtape.menuOutput' && !canOutputFromTitle.value) return
    mixtape.handleTitleOpenDialog(key)
  }

  const stemPlaceholderStateByTrackId = useMixtapeStemPlaceholderState({
    mixtapeMixMode: mixtape.mixtapeMixMode,
    tracks: mixtape.tracks,
    stemRetryingTrackIdMap: mixtape.stemRetryingTrackIdMap,
    stemRuntimeProgressByTrackId: mixtape.stemRuntimeProgressByTrackId,
    t: mixtape.t
  })

  const {
    envelopeHintKey,
    envelopePreviewLineKeys,
    isEnvelopeParamMode,
    isGainParamMode,
    isLoopParamMode,
    isSegmentSelectionActive,
    isSegmentSelectionSupported,
    isStemMixMode,
    isStemParamMode,
    isTrackPositionMode,
    isVolumeParamMode,
    handleToggleSegmentSelectionMode,
    mixParamOptions,
    selectedMixParam,
    showEnvelopeCurve,
    showTrackEnvelopeEditor
  } = useMixtapeMixParamUi({
    mixtapeMixMode: mixtape.mixtapeMixMode,
    t: mixtape.t
  })

  const {
    resolveTrackLoopOverlay,
    resolveOverviewTrackLoopBlocks,
    resolveTrackLoopTrackUiState,
    handleTrackLoopGridLineClick,
    handleTrackLoopSelectLoop,
    handleTrackLoopTrackMouseDown,
    handleTrackLoopRepeatStep,
    handleRemoveTrackLoop
  } = useMixtapeTrackLoopEditor({
    t: mixtape.t,
    tracks: mixtape.tracks,
    mixtapePlaylistId: mixtape.mixtapePlaylistId,
    renderZoomLevel: mixtape.renderZoomLevel,
    isLoopParamMode,
    resolveTrackDurationSeconds: mixtape.resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds: mixtape.resolveTrackSourceDurationSeconds,
    clearTimelineLayoutCache: mixtape.clearTimelineLayoutCache,
    updateTimelineWidth: mixtape.updateTimelineWidth,
    scheduleTimelineDraw: mixtape.scheduleTimelineDraw,
    scheduleFullPreRender: mixtape.scheduleFullPreRender,
    scheduleWorkerPreRender: mixtape.scheduleWorkerPreRender
  })

  const {
    trackEnvelopePreviewLegend,
    timelineTrackAreaHeight,
    timelineAdaptiveStyle,
    resolveTrackEnvelopePreviewLines,
    resolveTrackStemPreviewRows,
    trackEnvelopePreviewViewportStyle
  } = useMixtapeEnvelopePreview({
    laneIndices: mixtape.laneIndices,
    laneHeight: mixtape.laneHeight,
    renderZoomLevel: mixtape.renderZoomLevel,
    showStemPreviewRows: isStemMixMode,
    previewParams: envelopePreviewLineKeys,
    timelineVisualScale: mixtape.timelineVisualScale,
    timelineContentWidth: mixtape.timelineContentWidth,
    timelineScrollLeft: mixtape.timelineScrollLeft,
    tracks: mixtape.tracks,
    resolveTrackDurationSeconds: mixtape.resolveTrackDurationSeconds,
    resolveTrackFirstBeatSeconds: mixtape.resolveTrackFirstBeatSeconds,
    resolveTrackSourceDurationSeconds: mixtape.resolveTrackSourceDurationSeconds
  })

  const {
    handleToggleMasterTempoLane,
    masterTempoEdited,
    masterTempoLaneHeight,
    timelineTrackAreaStyle
  } = useMixtapeMasterTempoLane({
    masterTempoLaneExpanded,
    tracks: mixtape.tracks,
    timelineVisualScale: mixtape.timelineVisualScale,
    timelineTrackAreaHeight,
    mixtapePlaylistId: mixtape.mixtapePlaylistId,
    resolveTrackDurationSeconds: mixtape.resolveTrackDurationSeconds
  })

  useWaveformPreviewPlayer()

  const ascendingOrder = ascendingOrderAsset
  const descendingOrder = descendingOrderAsset
  const autoGainHeaderTranslate = (key: string) => mixtape.t(key)
  const {
    autoGainColumnMenuVisible,
    autoGainColumnMenuEvent,
    autoGainDialogColumns,
    autoGainSongColumns,
    autoGainSongTotalWidth,
    autoGainDialogSongs,
    autoGainSelectedRowKeys,
    handleAutoGainSongClick,
    handleAutoGainSongDragStart,
    handleAutoGainColumnsUpdate,
    handleAutoGainColumnClick,
    handleAutoGainHeaderContextMenu,
    handleAutoGainToggleColumnVisibility,
    handleOpenAutoGainDialog,
    handleAutoGainDialogCancelClick,
    handleAutoGainDialogConfirmClick,
    handleAutoGainSelectLoudestReferenceClick,
    handleAutoGainSelectQuietestReferenceClick
  } = useMixtapeAutoGainDialog({
    mixtapeRawItems: mixtape.mixtapeRawItems,
    tracks: mixtape.tracks,
    autoGainReferenceTrackId: mixtape.autoGainReferenceTrackId,
    openAutoGainDialog: mixtape.openAutoGainDialog,
    handleAutoGainDialogCancel: mixtape.handleAutoGainDialogCancel,
    handleAutoGainDialogConfirm: mixtape.handleAutoGainDialogConfirm,
    handleAutoGainSelectLoudestReference: mixtape.handleAutoGainSelectLoudestReference,
    handleAutoGainSelectQuietestReference: mixtape.handleAutoGainSelectQuietestReference
  })

  const resolveStemMuteOverlayRows = (item: TimelineTrackLayout) => {
    if (!isStemParamMode.value) return []
    const rows = resolveTrackStemPreviewRows(item)
    const rowCount = rows.length
    if (!rowCount) return []
    const safeLaneHeight = Math.max(1, Math.round(Number(mixtape.laneHeight.value) || 0))
    return rows.map((row, rowIndex) => {
      const start = Math.floor((safeLaneHeight * rowIndex) / rowCount)
      const end = Math.floor((safeLaneHeight * (rowIndex + 1)) / rowCount)
      const rowHeight = Math.max(1, end - start)
      return {
        key: row.key,
        segments: row.muteSegments,
        isActive: row.key === selectedMixParam.value,
        style: {
          top: `${(start / safeLaneHeight) * 100}%`,
          height: `${(rowHeight / safeLaneHeight) * 100}%`
        } satisfies CSSProperties
      }
    })
  }

  const {
    resolveActiveEnvelopePolyline,
    resolveActiveEnvelopePolygon,
    resolveActiveGhostPointDot,
    resolveActiveEnvelopePointDots,
    resolveVolumeSegmentMasks,
    handleEnvelopeSegmentMouseDown,
    handleEnvelopePointMouseDown,
    handleEnvelopeStageMouseDown,
    handleEnvelopeStageMouseMove,
    handleEnvelopeStageMouseLeave,
    handleEnvelopePointDoubleClick,
    handleEnvelopePointContextMenu,
    canUndoMixParam,
    pushExternalUndoStep,
    flushPendingMixEnvelopePersist,
    undoLastMixParamChange,
    cleanupGainEnvelopeEditor
  } = createMixtapeGainEnvelopeEditor({
    tracks: mixtape.tracks,
    renderZoomLevel: mixtape.renderZoomLevel,
    resolveTrackDurationSeconds: mixtape.resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds: mixtape.resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatSeconds: mixtape.resolveTrackFirstBeatSeconds,
    resolveActiveParam: () =>
      isEnvelopeParamMode.value ? (selectedMixParam.value as MixtapeEnvelopeParamId) : null,
    isSegmentSelectionMode: () => isSegmentSelectionActive.value,
    isEditable: () => isEnvelopeParamMode.value && !projectGainBusy.value
  })

  const cueOverlap = useMixtapeCueOverlap({
    tracks: mixtape.tracks,
    playlistId: mixtape.mixtapePlaylistId,
    isBlocked: () =>
      projectGainBusy.value ||
      mixtape.mixtapeItemsLoading.value ||
      mixtape.bpmAnalysisActive.value ||
      mixtape.transportPlaying.value ||
      mixtape.transportDecoding.value ||
      mixtape.transportPreloading.value ||
      mixtape.outputRunning.value ||
      mixtape.autoGainBusy.value,
    resolveSourceDuration: mixtape.resolveTrackSourceDurationSeconds,
    pushUndo: pushExternalUndoStep,
    refresh: () => {
      mixtape.clearTimelineLayoutCache()
      mixtape.updateTimelineWidth(false)
      mixtape.scheduleTimelineDraw()
      mixtape.scheduleFullPreRender()
      mixtape.scheduleWorkerPreRender()
    }
  })

  const projectGain = useMixtapeProjectGain({
    busy: projectGainBusy,
    tracks: mixtape.tracks,
    playlistId: mixtape.mixtapePlaylistId,
    resolveDuration: mixtape.resolveTrackDurationSeconds,
    isBlocked: () =>
      !mixtape.mixtapePlaylistId.value ||
      mixtape.mixtapeItemsLoading.value ||
      mixtape.bpmAnalysisActive.value ||
      mixtape.outputRunning.value ||
      mixtape.autoGainBusy.value ||
      mixtape.mixtapeDropBusy.value ||
      mixtape.beatAlignDialogVisible.value ||
      cueOverlap.busy.value,
    flushPending: flushPendingMixEnvelopePersist,
    pushUndo: pushExternalUndoStep,
    refresh: mixtape.scheduleTimelineDraw,
    onAdjusted: (deltaDb, count) => {
      showToast(
        mixtape.t(deltaDb < 0 ? 'mixtape.projectGainDecreased' : 'mixtape.projectGainIncreased', {
          count
        })
      )
    },
    onUndone: (count) => showToast(mixtape.t('mixtape.projectGainUndone', { count })),
    showError: async () => {
      await confirmDialog({
        title: mixtape.t('common.error'),
        content: [mixtape.t('mixtape.projectGainFailed')],
        confirmShow: false
      })
    }
  })

  const trackDragUndoMouseDown = useMixtapeTrackDragUndo({
    tracks: mixtape.tracks,
    handleTrackDragStart: mixtape.handleTrackDragStart,
    pushExternalUndoStep
  })

  const handleLaneTrackMouseDown = (item: TimelineTrackLayout, event: MouseEvent) => {
    if (projectGainBusy.value) return
    if (isLoopParamMode.value) {
      handleTrackLoopTrackMouseDown(item, event)
      return
    }
    if (!isTrackPositionMode.value) return
    trackDragUndoMouseDown(item, event)
  }

  const handleLaneTrackMouseDownCapture = (item: TimelineTrackLayout, event: MouseEvent) => {
    if (projectGainBusy.value) return
    if (!isLoopParamMode.value) return
    handleTrackLoopTrackMouseDown(item, event)
  }

  const handleUndoMixParam = () => {
    if (!cueOverlap.busy.value && !projectGainBusy.value) undoLastMixParamChange()
  }
  const { handleZoomIn, handleZoomOut, isLightTheme } = useMixtapeShellUi({
    renderZoomLevel: mixtape.renderZoomLevel,
    setZoomValue: mixtape.setZoomValue,
    applyRenderZoomImmediate: mixtape.applyRenderZoomImmediate,
    canUndoMixParam,
    handleUndoMixParam,
    beatAlignDialogVisible: mixtape.beatAlignDialogVisible,
    outputDialogVisible: mixtape.outputDialogVisible,
    autoGainDialogVisible: mixtape.autoGainDialogVisible,
    cleanupGainEnvelopeEditor
  })

  const resolveEnvelopePointBoundaryClass = (point: unknown) => {
    const candidate = point as { x?: number }
    const x = Number(candidate.x)
    if (!Number.isFinite(x)) return ''
    if (x <= 0.001) return 'is-boundary-start'
    if (x >= 99.999) return 'is-boundary-end'
    return ''
  }

  const handleGlobalBpmTrackTargetsSync = (nextTracks: MixtapeTrack[]) => {
    mixtape.tracks.value = nextTracks
  }

  const shouldTraceOverviewPreview = false
  let overviewPreviewTraceToken = 0
  let lastOverviewPreviewTraceSignature = ''

  const stringifyOverviewTraceStyle = (style: CSSProperties) => ({
    left: String(style.left || ''),
    width: String(style.width || '')
  })

  const overviewPreviewTraceSignature = computed(() => {
    const laneSignatures = mixtape.laneIndices
      .map((laneIndex) => {
        const items = mixtape.laneTracks.value[laneIndex] || []
        return `${laneIndex}:${items
          .map((item) => {
            const overviewStyle = stringifyOverviewTraceStyle(
              mixtape.resolveOverviewTrackStyle(item)
            )
            return [
              item.track.id,
              Number(item.startSec).toFixed(3),
              Math.round(item.startX),
              Math.round(item.width),
              overviewStyle.left,
              overviewStyle.width
            ].join('@')
          })
          .join(',')}`
      })
      .join('|')
    return [
      mixtape.tracks.value.length,
      Math.round(Number(mixtape.timelineContentWidth.value) || 0),
      Math.round(Number(mixtape.timelineViewportWidth.value) || 0),
      laneSignatures
    ].join('||')
  })

  const emitOverviewPreviewTrace = async (reason: string) => {
    if (!shouldTraceOverviewPreview) return
    const signature = `${reason}::${overviewPreviewTraceSignature.value}`
    if (!signature || signature === lastOverviewPreviewTraceSignature) return
    lastOverviewPreviewTraceSignature = signature
    const token = ++overviewPreviewTraceToken
    await nextTick()
    requestAnimationFrame(() => {
      if (token !== overviewPreviewTraceToken) return
      const laneItems = mixtape.laneIndices.map((laneIndex) => {
        const items = mixtape.laneTracks.value[laneIndex] || []
        return {
          laneIndex,
          count: items.length,
          items: items.map((item) => {
            const overviewStyle = stringifyOverviewTraceStyle(
              mixtape.resolveOverviewTrackStyle(item)
            )
            const previewStyle = stringifyOverviewTraceStyle(mixtape.resolveTrackBlockStyle(item))
            const previewLines = resolveTrackEnvelopePreviewLines(item)
            const overviewLoopBlocks = resolveOverviewTrackLoopBlocks(item)
            return {
              trackId: item.track.id,
              title: mixtape.resolveTrackTitle(item.track),
              startSec: Number(item.startSec.toFixed(4)),
              startX: Math.round(item.startX),
              widthPx: Math.round(item.width),
              previewLineCount: previewLines.length,
              previewLineKeys: previewLines.map((line) => line.key),
              overviewLoopBlockCount: overviewLoopBlocks.length,
              overviewStyle,
              previewStyle
            }
          })
        }
      })
      const overviewLaneEls = Array.from(
        mixtape.overviewRef.value?.querySelectorAll('.overview-lane') || []
      ) as HTMLElement[]
      const previewLaneEls = Array.from(
        mixtape.envelopePreviewRef.value?.querySelectorAll('.timeline-envelope-preview__lane') || []
      ) as HTMLElement[]
      const overviewTrackEls = Array.from(
        mixtape.overviewRef.value?.querySelectorAll('.overview-track') || []
      ) as HTMLElement[]
      const previewTrackEls = Array.from(
        mixtape.envelopePreviewRef.value?.querySelectorAll('.timeline-envelope-preview__track') ||
          []
      ) as HTMLElement[]
      void reason
      void laneItems
      void overviewLaneEls
      void previewLaneEls
      void overviewTrackEls
      void previewTrackEls
    })
  }

  watch(
    overviewPreviewTraceSignature,
    () => {
      void emitOverviewPreviewTrace('layout-change')
    },
    { immediate: true }
  )

  return {
    projectGainBusy,
    canDecreaseProjectGain: projectGain.canDecrease,
    canIncreaseProjectGain: projectGain.canIncrease,
    projectGainUnavailableReason: projectGain.unavailableReason,
    adjustProjectGain: projectGain.adjust,
    mixtapeWindowVolume,
    mixtapeWindowTitle,
    handleMixtapeWindowVolumeChange,
    titleMenus,
    handleTitleMenuOpen,
    stemPlaceholderStateByTrackId,
    envelopeHintKey,
    isEnvelopeParamMode,
    isGainParamMode,
    isLoopParamMode,
    isSegmentSelectionActive,
    isSegmentSelectionSupported,
    isStemMixMode,
    isStemParamMode,
    isTrackPositionMode,
    isVolumeParamMode,
    handleToggleSegmentSelectionMode,
    mixParamOptions,
    selectedMixParam,
    showEnvelopeCurve,
    showTrackEnvelopeEditor,
    resolveTrackLoopOverlay,
    resolveOverviewTrackLoopBlocks,
    resolveTrackLoopTrackUiState,
    handleTrackLoopGridLineClick,
    handleTrackLoopSelectLoop,
    handleTrackLoopRepeatStep,
    handleRemoveTrackLoop,
    trackEnvelopePreviewLegend,
    timelineAdaptiveStyle,
    resolveTrackEnvelopePreviewLines,
    resolveTrackStemPreviewRows,
    trackEnvelopePreviewViewportStyle,
    handleToggleMasterTempoLane,
    masterTempoEdited,
    masterTempoLaneHeight,
    timelineTrackAreaStyle,
    ascendingOrder,
    descendingOrder,
    autoGainHeaderTranslate,
    autoGainColumnMenuVisible,
    autoGainColumnMenuEvent,
    autoGainDialogColumns,
    autoGainSongColumns,
    autoGainSongTotalWidth,
    autoGainDialogSongs,
    autoGainSelectedRowKeys,
    handleAutoGainSongClick,
    handleAutoGainSongDragStart,
    handleAutoGainColumnsUpdate,
    handleAutoGainColumnClick,
    handleAutoGainHeaderContextMenu,
    handleAutoGainToggleColumnVisibility,
    handleOpenAutoGainDialog,
    handleAutoGainDialogCancelClick,
    handleAutoGainDialogConfirmClick,
    handleAutoGainSelectLoudestReferenceClick,
    handleAutoGainSelectQuietestReferenceClick,
    resolveStemMuteOverlayRows,
    resolveActiveEnvelopePolyline,
    resolveActiveEnvelopePolygon,
    resolveActiveGhostPointDot,
    resolveActiveEnvelopePointDots,
    resolveVolumeSegmentMasks,
    handleEnvelopeSegmentMouseDown,
    handleEnvelopePointMouseDown,
    handleEnvelopeStageMouseDown,
    handleEnvelopeStageMouseMove,
    handleEnvelopeStageMouseLeave,
    handleEnvelopePointDoubleClick,
    handleEnvelopePointContextMenu,
    canUndoMixParam,
    handleUndoMixParam,
    pushExternalUndoStep,
    handleLaneTrackMouseDown,
    handleLaneTrackMouseDownCapture,
    handleZoomIn,
    handleZoomOut,
    isLightTheme,
    resolveEnvelopePointBoundaryClass,
    handleGlobalBpmTrackTargetsSync
  }
}
