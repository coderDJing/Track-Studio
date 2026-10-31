<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import titleComponent from '@renderer/components/titleComponent.vue'
import WindowVolumeDial from '@renderer/components/WindowVolumeDial.vue'
import TitleBarAudioVisualizer from '@renderer/components/TitleBarAudioVisualizer.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import MixtapeDialogsLayer from '@renderer/components/MixtapeDialogsLayer.vue'
import MixtapeEnvelopePreviewTrack from '@renderer/components/mixtape/MixtapeEnvelopePreviewTrack.vue'
import MixtapeGlobalBpmEditor from '@renderer/components/mixtape/MixtapeGlobalBpmEditor.vue'
import MixtapeTrackLoopOverlay from '@renderer/components/mixtape/MixtapeTrackLoopOverlay.vue'
import { useMixtape } from '@renderer/composables/useMixtape'
import { useMixtapePageUi } from '@renderer/composables/mixtape/useMixtapePageUi'
import { useMixtapeWindowUserGuide } from '@renderer/composables/mixtape/useMixtapeWindowUserGuide'
import UserGuideCard from '@renderer/components/userGuide/UserGuideCard.vue'

const masterTempoLaneExpanded = ref(false)
const transportToastVisible = ref(false)
const transportToastMessage = ref('')
let transportToastTimer: ReturnType<typeof setTimeout> | null = null

const clearTransportToastTimer = () => {
  if (!transportToastTimer) return
  clearTimeout(transportToastTimer)
  transportToastTimer = null
}

const showTransportToast = (message: string) => {
  const text = String(message || '').trim()
  if (!text) return
  transportToastMessage.value = text
  transportToastVisible.value = true
  clearTransportToastTimer()
  transportToastTimer = setTimeout(() => {
    transportToastVisible.value = false
    transportToastTimer = null
  }, 4000)
}

const mixtape = useMixtape({
  layoutScaleDeps: [masterTempoLaneExpanded]
})

const {
  t,
  mixtapeItemsLoading,
  mixtapePlaylistId,
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
  resolveTrackBlockStyle,
  resolveTrackTitle,
  resolveTrackTitleWithOriginalMeta,
  formatTrackBpm,
  formatTrackKey,
  isRawWaveformLoading,
  preRenderState,
  preRenderPercent,
  timelineRootRef,
  rulerRef,
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
  timelinePlayheadStyle,
  handleTransportPlayFromStart,
  handleTransportStop,
  handleRulerSeek,
  handleToggleFollowPlayhead,
  transportError,
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
  mixtapeDropOverlayVisible,
  mixtapeDropOverlayTitle,
  mixtapeDropOverlayHint,
  mixtapeDropBusy,
  handleMixtapeSongDragEnter,
  handleMixtapeSongDragOver,
  handleMixtapeSongDragLeave,
  handleMixtapeSongDrop,
  outputDialogVisible,
  outputPath,
  outputFormat,
  outputFilename,
  outputRunning,
  outputProgressText,
  outputProgressPercent,
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
  autoGainBusy,
  autoGainProgressText,
  canStartAutoGain
} = mixtape

const {
  expandBpmLane,
  activeStep: userGuideActiveStep,
  activeBeat: userGuideActiveBeat,
  beatNumber: userGuideBeatNumber,
  beatCount: userGuideBeatCount,
  hasNextBeat: userGuideHasNextBeat,
  isRekordboxUser: userGuideIsRekordboxUser,
  confirmShow: userGuideConfirmShow,
  goNextBeat: goNextUserGuideBeat,
  dismissActiveStep: dismissUserGuideStep
} = useMixtapeWindowUserGuide(mixtapeItemsLoading)

const {
  mixtapeWindowVolume,
  mixtapeWindowTitle,
  handleMixtapeWindowVolumeChange,
  titleMenus,
  handleTitleMenuOpen,
  stemPlaceholderStateByTrackId,
  envelopeHintKey,
  isEnvelopeParamMode,
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
  resolveActiveSegmentMasks,
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
} = useMixtapePageUi({
  mixtape,
  masterTempoLaneExpanded
})

watch(transportError, (message) => {
  const text = String(message || '').trim()
  if (!text) return
  showTransportToast(text)
  transportError.value = ''
})

onBeforeUnmount(() => {
  clearTransportToastTimer()
})
</script>

<template>
  <div
    class="mixtape-shell"
    :class="{ 'is-light-theme': isLightTheme, 'is-dark-theme': !isLightTheme }"
    @dragenter="handleMixtapeSongDragEnter"
    @dragover="handleMixtapeSongDragOver"
    @dragleave="handleMixtapeSongDragLeave"
    @drop="handleMixtapeSongDrop"
  >
    <div class="mixtape-title-wrap">
      <titleComponent
        control-prefix="mixtapeWindow"
        max-event-channel="mixtapeWindow-max"
        :title-text="mixtapeWindowTitle"
        :menu-override="titleMenus"
        :enable-menu-hotkeys="false"
        @open-dialog="handleTitleMenuOpen"
      >
        <template #rightExtra>
          <TitleBarAudioVisualizer target="mixtapeWindow" />
        </template>
      </titleComponent>
    </div>
    <div class="mixtape-window">
      <section class="mixtape-body">
        <div class="mixtape-param-bar">
          <div class="mixtape-param-bar__title">{{ t('mixtape.mixPanelTitle') }}</div>
          <div class="mixtape-param-bar__tabs">
            <div class="mixtape-param-bar__mix-tabs" data-user-guide-target="mixtape-params">
              <bubbleBoxTrigger
                v-for="item in mixParamOptions"
                :key="item.id"
                tag="button"
                class="mixtape-param-bar__tab"
                :class="[
                  `mixtape-param-bar__tab--${item.id}`,
                  { 'is-active': selectedMixParam === item.id }
                ]"
                :data-user-guide-target="
                  item.id === 'vocal' ||
                  item.id === 'inst' ||
                  item.id === 'bass' ||
                  item.id === 'drums'
                    ? 'mixtape-stem'
                    : undefined
                "
                type="button"
                :title="
                  item.id === 'position'
                    ? t('mixtape.positionModeActionHint')
                    : item.id === 'loop'
                      ? t('mixtape.loopEditHint')
                      : undefined
                "
                @click="selectedMixParam = item.id"
              >
                {{ t(item.labelKey) }}
              </bubbleBoxTrigger>
            </div>
            <button
              class="mixtape-param-bar__tab mixtape-param-bar__tab--bpm"
              :class="{ 'is-active': masterTempoLaneExpanded || expandBpmLane }"
              data-user-guide-target="mixtape-bpm"
              type="button"
              :disabled="!tracks.length"
              :aria-pressed="masterTempoLaneExpanded || expandBpmLane"
              @click="handleToggleMasterTempoLane"
            >
              <span class="mixtape-param-bar__toggle-dot" aria-hidden="true"></span>
              <span class="mixtape-param-bar__toggle-label">{{ t('mixtape.bpm') }}</span>
              <span class="mixtape-param-bar__toggle-state">
                {{
                  t(
                    masterTempoLaneExpanded || expandBpmLane
                      ? 'mixtape.masterTempoLaneSwitchOn'
                      : 'mixtape.masterTempoLaneSwitchOff'
                  )
                }}
              </span>
            </button>
          </div>
          <div v-if="isEnvelopeParamMode" class="mixtape-param-bar__hint">
            {{ t(envelopeHintKey) }}
          </div>
          <div class="mixtape-param-bar__actions">
            <bubbleBoxTrigger
              tag="button"
              class="button mixtape-param-bar__action-btn mixtape-param-bar__action-btn--icon"
              type="button"
              :title="t('mixtape.zoomOut')"
              :aria-label="t('mixtape.zoomOut')"
              @click="handleZoomOut"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M4 8h8"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                ></path>
              </svg>
            </bubbleBoxTrigger>
            <bubbleBoxTrigger
              tag="button"
              class="button mixtape-param-bar__action-btn mixtape-param-bar__action-btn--icon"
              type="button"
              :title="t('mixtape.zoomIn')"
              :aria-label="t('mixtape.zoomIn')"
              @click="handleZoomIn"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M8 4v8M4 8h8"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                ></path>
              </svg>
            </bubbleBoxTrigger>
            <bubbleBoxTrigger
              wrapper-tag="span"
              tag="button"
              class="button mixtape-param-bar__action-btn mixtape-param-bar__action-btn--icon"
              type="button"
              :disabled="!canUndoMixParam"
              :title="t('mixtape.undoActionHint')"
              :aria-label="t('mixtape.undoActionHint')"
              @click="handleUndoMixParam"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M6 3.5 2.5 7l3.5 3.5"></path>
                <path d="M3 7h5.5a3.5 3.5 0 1 1 0 7H7.5"></path>
              </svg>
            </bubbleBoxTrigger>
            <bubbleBoxTrigger
              tag="button"
              class="button mixtape-param-bar__action-btn mixtape-param-bar__action-btn--icon"
              :class="{ 'is-active': followPlayheadEnabled }"
              type="button"
              :title="
                followPlayheadEnabled
                  ? t('mixtape.followPlayheadActionHintDisable')
                  : t('mixtape.followPlayheadActionHintEnable')
              "
              :aria-label="
                followPlayheadEnabled
                  ? t('mixtape.followPlayheadActionHintDisable')
                  : t('mixtape.followPlayheadActionHintEnable')
              "
              @click="handleToggleFollowPlayhead"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect x="3" y="3" width="10" height="10" rx="1.4"></rect>
                <path d="M8 2v12"></path>
                <path d="M5.9 5.4 8 3.3l2.1 2.1"></path>
                <path d="M5.9 10.6 8 12.7l2.1-2.1"></path>
              </svg>
            </bubbleBoxTrigger>
            <button
              v-if="selectedMixParam === 'gain'"
              class="button mixtape-param-bar__action-btn"
              type="button"
              :disabled="!canStartAutoGain"
              @click="handleOpenAutoGainDialog"
            >
              {{ t('mixtape.autoGainAction') }}
            </button>
            <button
              v-if="isSegmentSelectionSupported"
              class="button mixtape-param-bar__action-btn"
              :class="{ 'is-active': isSegmentSelectionActive }"
              type="button"
              @click="handleToggleSegmentSelectionMode"
            >
              {{ t(isVolumeParamMode ? 'mixtape.segmentMuteAction' : 'mixtape.stemSegmentAction') }}
            </button>
            <WindowVolumeDial
              class="mixtape-param-bar__volume"
              :model-value="mixtapeWindowVolume"
              :label="t('player.volumeControl')"
              :size="28"
              @update:model-value="handleMixtapeWindowVolumeChange"
            />
          </div>
        </div>
        <div class="mixtape-main">
          <section
            ref="timelineRootRef"
            class="timeline"
            data-user-guide-target="mixtape-timeline"
            :style="timelineAdaptiveStyle"
          >
            <div class="timeline-primary-zone">
              <div class="timeline-ruler-wrap">
                <div class="timeline-ruler-stop-float">
                  <bubbleBoxTrigger
                    v-if="transportPlaying || transportDecoding"
                    tag="button"
                    class="timeline-stop-btn"
                    type="button"
                    :title="t('mixtape.stop')"
                    shortcut="Space"
                    :aria-label="t('mixtape.stop')"
                    @mousedown.stop.prevent
                    @click.stop="handleTransportStop"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                      <rect x="4" y="4" width="8" height="8" rx="1"></rect>
                    </svg>
                  </bubbleBoxTrigger>
                  <bubbleBoxTrigger
                    v-else
                    tag="button"
                    class="timeline-stop-btn"
                    type="button"
                    :title="t('player.play')"
                    shortcut="Space"
                    :aria-label="t('player.play')"
                    @mousedown.stop.prevent
                    @click.stop="handleTransportPlayFromStart"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                      <polygon points="5,4 12,8 5,12"></polygon>
                    </svg>
                  </bubbleBoxTrigger>
                  <span v-if="transportDecoding" class="timeline-decoding-hint">
                    {{ t('mixtape.transportDecoding') }}
                  </span>
                </div>
                <div ref="rulerRef" class="timeline-ruler" @mousedown="handleRulerSeek">
                  <div class="timeline-ruler__ticks">
                    <div
                      v-for="tick in rulerMinuteTicks"
                      :key="`tick-${tick.sec}-${tick.left}`"
                      class="timeline-ruler__tick"
                      :style="{ left: tick.left }"
                    >
                      <div class="timeline-ruler__tick-line"></div>
                      <div
                        class="timeline-ruler__tick-label"
                        :class="{
                          'timeline-ruler__tick-label--start': tick.align === 'start',
                          'timeline-ruler__tick-label--end': tick.align === 'end'
                        }"
                      >
                        {{ tick.label }}
                      </div>
                    </div>
                  </div>
                  <div class="timeline-ruler__label">
                    {{ playheadTimeLabel }} / {{ timelineDurationLabel }}
                  </div>
                  <div
                    v-if="rulerInactiveStyle"
                    class="timeline-ruler__inactive"
                    :style="rulerInactiveStyle"
                  ></div>
                </div>
              </div>
              <div
                ref="timelineScrollWrapRef"
                class="timeline-scroll-wrap"
                :class="{ 'is-panning': isTimelinePanning }"
                :style="timelineTrackAreaStyle"
                @mousedown="handleTimelinePanStart"
              >
                <OverlayScrollbarsComponent
                  ref="timelineScrollRef"
                  class="timeline-scroll"
                  :options="timelineScrollbarOptions"
                  element="div"
                  defer
                >
                  <div
                    ref="timelineViewport"
                    class="timeline-viewport"
                    :style="{
                      width: `${timelineContentWidth}px`,
                      '--timeline-scroll-left': `${timelineScrollLeft}px`,
                      '--timeline-viewport-width': `${timelineViewportWidth}px`
                    }"
                  >
                    <div v-if="tracks.length > 0" class="timeline-master-bpm-divider">
                      <div class="timeline-master-bpm-divider__inner">
                        <span class="timeline-master-bpm-divider__title">
                          {{ t('mixtape.masterBpm') }}
                        </span>
                        <span v-if="masterTempoEdited" class="timeline-master-bpm-divider__badge">
                          {{ t('mixtape.masterTempoLaneEdited') }}
                        </span>
                      </div>
                    </div>
                    <MixtapeGlobalBpmEditor
                      :visible="tracks.length > 0"
                      :expanded="masterTempoLaneExpanded || expandBpmLane"
                      :playlist-id="mixtapePlaylistId"
                      :tracks="tracks"
                      :height-px="masterTempoLaneHeight"
                      :render-zoom-level="renderZoomLevel"
                      :timeline-scroll-left="timelineScrollLeft"
                      :timeline-viewport-width="timelineViewportWidth"
                      :playhead-sec="playheadSec"
                      :playhead-visible="playheadVisible"
                      :timeline-content-width="timelineContentWidth"
                      :resolve-track-duration-seconds="resolveTrackDurationSeconds"
                      :resolve-track-source-duration-seconds="resolveTrackSourceDurationSeconds"
                      :push-external-undo-step="pushExternalUndoStep"
                      :on-tracks-sync="handleGlobalBpmTrackTargetsSync"
                      :on-envelope-preview-changed="
                        () => {
                          clearTimelineLayoutCache()
                          updateTimelineWidth(false)
                          scheduleTimelineDraw()
                        }
                      "
                      :on-envelope-committed="
                        () => {
                          clearTimelineLayoutCache()
                          updateTimelineWidth(false)
                          scheduleTimelineDraw()
                          scheduleFullPreRender()
                          scheduleWorkerPreRender()
                        }
                      "
                    />
                    <div class="timeline-lanes">
                      <div v-if="tracks.length === 0" class="timeline-empty">
                        <div>
                          {{ mixtapeItemsLoading ? t('mixtape.loading') : t('mixtape.trackEmpty') }}
                        </div>
                        <div v-if="!mixtapeItemsLoading" class="timeline-empty-hint">
                          {{ t('mixtape.trackEmptyHint') }}
                        </div>
                      </div>
                      <template v-else>
                        <div
                          v-for="laneIndex in laneIndices"
                          :key="laneIndex"
                          class="timeline-lane"
                        >
                          <div
                            class="lane-body"
                            :style="{ height: `${laneHeight}px`, minHeight: `${laneHeight}px` }"
                          >
                            <bubbleBoxTrigger
                              v-for="item in laneTracks[laneIndex]"
                              :key="`${item.track.id}-${item.startX}`"
                              tag="div"
                              class="lane-track"
                              :class="{
                                'is-loop-mode': isLoopParamMode,
                                'is-loop-selecting': resolveTrackLoopTrackUiState(item.track)
                                  .selecting,
                                'is-loop-disabled': resolveTrackLoopTrackUiState(item.track)
                                  .disabled,
                                'is-loop-selected': resolveTrackLoopTrackUiState(item.track)
                                  .selectedLoop,
                                'is-stem-pending':
                                  stemPlaceholderStateByTrackId[item.track.id]?.kind === 'pending',
                                'is-stem-running':
                                  stemPlaceholderStateByTrackId[item.track.id]?.kind === 'running',
                                'is-stem-failed':
                                  stemPlaceholderStateByTrackId[item.track.id]?.kind === 'failed'
                              }"
                              :style="resolveTrackBlockStyle(item)"
                              :title="
                                isTrackPositionMode
                                  ? t('mixtape.positionModeTrackHoverHint')
                                  : undefined
                              "
                              :show-delay="240"
                              :hide-delay="60"
                              :show-when-mouse-idle="true"
                              :interactive="false"
                              :max-width="260"
                              @mousedown.capture="handleLaneTrackMouseDownCapture(item, $event)"
                              @mousedown.stop="handleLaneTrackMouseDown(item, $event)"
                              @contextmenu.stop.prevent="handleTrackContextMenu(item, $event)"
                            >
                              <svg
                                class="lane-track__envelope-svg"
                                viewBox="0 0 100 100"
                                preserveAspectRatio="none"
                              >
                                <line
                                  class="lane-track__envelope-midline"
                                  :class="{ 'is-hidden': !showEnvelopeCurve }"
                                  x1="0"
                                  y1="50"
                                  x2="100"
                                  y2="50"
                                ></line>
                                <polygon
                                  class="lane-track__envelope-fill"
                                  :class="{ 'is-hidden': !showEnvelopeCurve }"
                                  :points="resolveActiveEnvelopePolygon(item)"
                                ></polygon>
                                <polyline
                                  class="lane-track__envelope-line"
                                  :class="{ 'is-hidden': !showEnvelopeCurve }"
                                  :points="resolveActiveEnvelopePolyline(item)"
                                ></polyline>
                                <polyline
                                  class="lane-track__envelope-segment-hit"
                                  :class="{ 'is-hidden': !showEnvelopeCurve }"
                                  :points="resolveActiveEnvelopePolyline(item)"
                                  @mousedown.stop.prevent="
                                    handleEnvelopeSegmentMouseDown(item, $event)
                                  "
                                ></polyline>
                              </svg>
                              <div class="lane-track__mute-segments">
                                <template v-if="isStemParamMode">
                                  <div
                                    v-for="row in resolveStemMuteOverlayRows(item)"
                                    :key="`mute-row-${item.track.id}-${row.key}`"
                                    class="lane-track__stem-mute-row"
                                    :class="{ 'is-active': row.isActive }"
                                    :style="row.style"
                                  >
                                    <div
                                      v-for="segment in row.segments"
                                      :key="`mute-${item.track.id}-${row.key}-${segment.key}`"
                                      class="lane-track__mute-segment"
                                      :style="{
                                        left: `${segment.left}%`,
                                        width: `${segment.width}%`
                                      }"
                                    ></div>
                                  </div>
                                </template>
                                <template v-else>
                                  <div
                                    v-for="segment in resolveActiveSegmentMasks(item)"
                                    :key="`mute-${item.track.id}-${segment.key}`"
                                    class="lane-track__mute-segment"
                                    :style="{
                                      left: `${segment.left}%`,
                                      width: `${segment.width}%`
                                    }"
                                  ></div>
                                </template>
                              </div>
                              <MixtapeTrackLoopOverlay
                                :item="item"
                                :overlay="resolveTrackLoopOverlay(item)"
                                :loop-edit-mode="isLoopParamMode"
                                :handle-track-loop-grid-line-click="handleTrackLoopGridLineClick"
                                :handle-track-loop-select-loop="handleTrackLoopSelectLoop"
                                :handle-track-loop-repeat-step="handleTrackLoopRepeatStep"
                                :handle-track-loop-remove="handleRemoveTrackLoop"
                              />
                              <div
                                v-if="showTrackEnvelopeEditor"
                                class="lane-track__envelope-points"
                                :class="{
                                  'is-segment-mute-mode': isSegmentSelectionActive
                                }"
                                @mousedown.stop.prevent="handleEnvelopeStageMouseDown(item, $event)"
                                @mousemove="handleEnvelopeStageMouseMove(item, $event)"
                                @mouseleave="handleEnvelopeStageMouseLeave"
                              >
                                <template
                                  v-if="
                                    showEnvelopeCurve &&
                                    !(isVolumeParamMode && isSegmentSelectionActive)
                                  "
                                >
                                  <div
                                    v-if="resolveActiveGhostPointDot(item)"
                                    class="lane-track__envelope-ghost-point"
                                    :style="{
                                      left: `${resolveActiveGhostPointDot(item)!.x}%`,
                                      top: `${resolveActiveGhostPointDot(item)!.y}%`
                                    }"
                                  ></div>
                                  <div
                                    v-for="point in resolveActiveEnvelopePointDots(item)"
                                    :key="`point-wrap-${item.track.id}-${point.index}`"
                                    class="lane-track__envelope-point-wrap"
                                    :style="{
                                      left: `${point.x}%`,
                                      top: `${point.y}%`
                                    }"
                                  >
                                    <button
                                      class="lane-track__envelope-point"
                                      :class="[
                                        {
                                          'is-boundary': point.isBoundary,
                                          'is-active': point.isActive
                                        },
                                        resolveEnvelopePointBoundaryClass(point)
                                      ]"
                                      type="button"
                                      @mousedown.stop.prevent="
                                        handleEnvelopePointMouseDown(item, point.index, $event)
                                      "
                                      @dblclick.stop.prevent="
                                        handleEnvelopePointDoubleClick(item, point.index)
                                      "
                                      @contextmenu.stop.prevent="
                                        handleEnvelopePointContextMenu(item, point.index)
                                      "
                                    ></button>
                                    <div
                                      v-if="point.isActive"
                                      class="lane-track__envelope-point-label"
                                      :class="{
                                        'is-above': point.y > 15,
                                        'is-below': point.y <= 15,
                                        'is-align-left': point.x < 5,
                                        'is-align-right': point.x > 95
                                      }"
                                    >
                                      {{ point.gainDb > 0 ? '+' : ''
                                      }}{{ point.gainDb.toFixed(1) }} dB
                                    </div>
                                  </div>
                                </template>
                              </div>
                              <div
                                v-if="stemPlaceholderStateByTrackId[item.track.id]"
                                class="lane-track__stem-placeholder"
                                :class="`is-${stemPlaceholderStateByTrackId[item.track.id].kind}`"
                              >
                                <div class="lane-track__stem-placeholder-top">
                                  <span class="lane-track__stem-placeholder-pill">
                                    {{ stemPlaceholderStateByTrackId[item.track.id].label }}
                                  </span>
                                  <span
                                    v-if="
                                      stemPlaceholderStateByTrackId[item.track.id].percent !== null
                                    "
                                    class="lane-track__stem-placeholder-percent"
                                  >
                                    {{ stemPlaceholderStateByTrackId[item.track.id].percent }}%
                                  </span>
                                </div>
                                <div class="lane-track__stem-placeholder-detail">
                                  {{ stemPlaceholderStateByTrackId[item.track.id].detail }}
                                </div>
                                <div
                                  class="lane-track__stem-placeholder-bar"
                                  :class="{
                                    'is-indeterminate':
                                      stemPlaceholderStateByTrackId[item.track.id].kind ===
                                      'pending'
                                  }"
                                >
                                  <div
                                    class="lane-track__stem-placeholder-fill"
                                    :class="{
                                      'is-indeterminate':
                                        stemPlaceholderStateByTrackId[item.track.id].kind ===
                                        'pending'
                                    }"
                                    :style="
                                      stemPlaceholderStateByTrackId[item.track.id].kind !==
                                      'running'
                                        ? undefined
                                        : {
                                            width: `${stemPlaceholderStateByTrackId[item.track.id].percent}%`
                                          }
                                    "
                                  ></div>
                                </div>
                                <div
                                  v-if="
                                    stemPlaceholderStateByTrackId[item.track.id].kind === 'failed'
                                  "
                                  class="lane-track__stem-placeholder-actions"
                                >
                                  <button
                                    class="lane-track__stem-retry-btn"
                                    type="button"
                                    @mousedown.stop.prevent
                                    @click.stop="handleRetryTrackStem(item.track.id)"
                                  >
                                    {{ t('common.retry') }}
                                  </button>
                                </div>
                              </div>
                              <div v-if="isTrackPositionMode" class="lane-track__meta">
                                <div class="lane-track__meta-title">
                                  {{ item.track.mixOrder }}.
                                  {{ resolveTrackTitleWithOriginalMeta(item.track) }}
                                </div>
                                <div class="lane-track__meta-sub">
                                  {{ t('mixtape.bpm') }} {{ formatTrackBpm(item.track.bpm) }}
                                  <template v-if="formatTrackKey(item.track.key)">
                                    | {{ t('columns.key') }} {{ formatTrackKey(item.track.key) }}
                                  </template>
                                </div>
                              </div>
                              <div v-if="isRawWaveformLoading(item.track)" class="lane-loading">
                                {{ t('mixtape.rawWaveformLoading') }}
                              </div>
                            </bubbleBoxTrigger>
                          </div>
                        </div>
                      </template>
                    </div>
                  </div>
                </OverlayScrollbarsComponent>
                <canvas ref="timelineCanvasRef" class="timeline-waveform-canvas"></canvas>
                <div v-if="preRenderState.active" class="timeline-preload">
                  <div class="preload-card">
                    <div class="preload-title">
                      {{ t('mixtape.waveformPreparing') }} {{ preRenderPercent }}%
                    </div>
                    <div class="preload-bar">
                      <div
                        class="preload-bar__fill"
                        :style="{ width: `${preRenderPercent}%` }"
                      ></div>
                    </div>
                    <div class="preload-sub">
                      {{ preRenderState.done }} / {{ preRenderState.total }}
                    </div>
                  </div>
                </div>
              </div>
              <div class="timeline-envelope-preview">
                <div class="timeline-envelope-preview__legend">
                  <span
                    v-for="legend in trackEnvelopePreviewLegend"
                    :key="`envelope-preview-legend-${legend.key}`"
                    class="timeline-envelope-preview__legend-item"
                    :style="{ color: legend.color }"
                  >
                    <span
                      class="timeline-envelope-preview__legend-dot"
                      :style="legend.dotStyle"
                    ></span>
                    {{ legend.label }}
                  </span>
                </div>
                <div
                  ref="envelopePreviewRef"
                  class="timeline-envelope-preview__stage"
                  :class="{ 'is-dragging': isTimelinePanning }"
                  @mousedown="handleTimelineHorizontalPanStart"
                >
                  <div
                    v-if="tracks.length === 0"
                    class="timeline-envelope-preview__empty"
                    :class="{ 'is-loading': mixtapeItemsLoading }"
                  >
                    {{ mixtapeItemsLoading ? t('mixtape.loading') : t('mixtape.trackEmptyHint') }}
                  </div>
                  <div
                    v-else
                    class="timeline-envelope-preview__viewport"
                    :style="trackEnvelopePreviewViewportStyle"
                  >
                    <div class="timeline-envelope-preview__lanes">
                      <div
                        v-for="laneIndex in laneIndices"
                        :key="`envelope-preview-${laneIndex}`"
                        class="timeline-envelope-preview__lane"
                      >
                        <MixtapeEnvelopePreviewTrack
                          v-for="item in laneTracks[laneIndex]"
                          :key="`envelope-preview-${item.track.id}`"
                          :item="item"
                          :track-style="resolveTrackBlockStyle(item)"
                          :lines="resolveTrackEnvelopePreviewLines(item)"
                          :loop-blocks="resolveOverviewTrackLoopBlocks(item)"
                          :stem-rows="resolveTrackStemPreviewRows(item)"
                          :mute-segments="resolveActiveSegmentMasks(item)"
                          :show-stem-rows="isStemMixMode"
                          :show-mute-segments="!isStemMixMode || isVolumeParamMode"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div
                v-if="playheadVisible && timelinePlayheadStyle"
                class="timeline-primary-playhead"
                :style="timelinePlayheadStyle"
              ></div>
            </div>
            <div class="timeline-overview">
              <div
                ref="overviewRef"
                class="overview-stage"
                :class="{ 'is-dragging': isOverviewDragging }"
                @mousedown="handleOverviewMouseDown"
                @click="handleOverviewClick"
              >
                <div class="overview-lanes">
                  <div
                    v-for="laneIndex in laneIndices"
                    :key="`overview-${laneIndex}`"
                    class="overview-lane"
                  >
                    <div
                      v-for="item in laneTracks[laneIndex]"
                      :key="`overview-${item.track.id}`"
                      class="overview-track"
                      :style="resolveOverviewTrackStyle(item)"
                    >
                      <div
                        v-for="block in resolveOverviewTrackLoopBlocks(item)"
                        :key="block.key"
                        class="overview-track__loop"
                        :class="`overview-track__loop--${block.kind}`"
                        :style="block.style"
                      ></div>
                    </div>
                  </div>
                </div>
                <div
                  v-if="playheadVisible && overviewPlayheadStyle"
                  class="overview-playhead"
                  :style="overviewPlayheadStyle"
                ></div>
                <div class="overview-viewport" :style="overviewViewportStyle"></div>
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
    <MixtapeDialogsLayer
      :t="t"
      :transport-preloading="transportPreloading"
      :transport-preload-done="transportPreloadDone"
      :transport-preload-total="transportPreloadTotal"
      :transport-preload-percent="transportPreloadPercent"
      :stem-separation-progress-visible="stemSeparationProgressVisible"
      :stem-separation-progress-percent="stemSeparationProgressPercent"
      :stem-separation-progress-text="stemSeparationProgressText"
      :stem-separation-running-progress-lines="stemSeparationRunningProgressLines"
      :bpm-analysis-active="bpmAnalysisActive"
      :bpm-analysis-failed="bpmAnalysisFailed"
      :bpm-analysis-failed-count="bpmAnalysisFailedCount"
      :bpm-analysis-failed-reason="bpmAnalysisFailedReason"
      :retry-bpm-analysis="retryBpmAnalysis"
      :dismiss-bpm-analysis-failure="dismissBpmAnalysisFailure"
      :auto-gain-busy="autoGainBusy"
      :auto-gain-dialog-visible="autoGainDialogVisible"
      :auto-gain-progress-text="autoGainProgressText"
      :output-running="outputRunning"
      :output-progress-text="outputProgressText"
      :output-progress-percent="outputProgressPercent"
      :auto-gain-reference-feedback="autoGainReferenceFeedback"
      :auto-gain-dialog-columns="autoGainDialogColumns"
      :auto-gain-song-columns="autoGainSongColumns"
      :auto-gain-song-total-width="autoGainSongTotalWidth"
      :auto-gain-dialog-songs="autoGainDialogSongs"
      :auto-gain-selected-row-keys="autoGainSelectedRowKeys"
      :auto-gain-column-menu-visible="autoGainColumnMenuVisible"
      :auto-gain-column-menu-event="autoGainColumnMenuEvent"
      :auto-gain-header-translate="autoGainHeaderTranslate"
      :ascending-order="ascendingOrder"
      :descending-order="descendingOrder"
      :mixtape-playlist-id="mixtapePlaylistId"
      :handle-auto-gain-columns-update="handleAutoGainColumnsUpdate"
      :handle-auto-gain-column-click="handleAutoGainColumnClick"
      :handle-auto-gain-header-context-menu="handleAutoGainHeaderContextMenu"
      :handle-auto-gain-toggle-column-visibility="handleAutoGainToggleColumnVisibility"
      :handle-auto-gain-song-click="handleAutoGainSongClick"
      @update:auto-gain-column-menu-visible="autoGainColumnMenuVisible = $event"
      :handle-auto-gain-song-drag-start="handleAutoGainSongDragStart"
      :handle-auto-gain-select-loudest-reference-click="handleAutoGainSelectLoudestReferenceClick"
      :handle-auto-gain-select-quietest-reference-click="handleAutoGainSelectQuietestReferenceClick"
      :handle-auto-gain-dialog-cancel-click="handleAutoGainDialogCancelClick"
      :handle-auto-gain-dialog-confirm-click="handleAutoGainDialogConfirmClick"
      :auto-gain-reference-track-id="autoGainReferenceTrackId"
      :output-dialog-visible="outputDialogVisible"
      :output-path="outputPath"
      :output-format="outputFormat"
      :output-filename="outputFilename"
      :handle-output-dialog-confirm="handleOutputDialogConfirm"
      :handle-output-dialog-cancel="handleOutputDialogCancel"
      :handle-output-cancel-running="handleOutputCancelRunning"
      :track-context-menu-visible="trackContextMenuVisible"
      :track-context-menu-style="trackContextMenuStyle"
      :handle-track-menu-adjust-grid="handleTrackMenuAdjustGrid"
      :handle-track-menu-toggle-master-tempo="handleTrackMenuToggleMasterTempo"
      :handle-track-menu-remove-from-mixtape="handleTrackMenuRemoveFromMixtape"
      :track-menu-master-tempo-checked="trackMenuMasterTempoChecked"
      :beat-align-dialog-visible="beatAlignDialogVisible"
      :beat-align-track="beatAlignTrack"
      :beat-align-window-volume="mixtapeWindowVolume"
      :resolve-track-title="resolveTrackTitle"
      :handle-beat-align-grid-definition-save="handleBeatAlignGridDefinitionSave"
      :handle-beat-align-dialog-cancel="handleBeatAlignDialogCancel"
    />
    <Transition name="mixtape-drop-overlay">
      <div
        v-if="mixtapeDropOverlayVisible"
        class="mixtape-drop-overlay"
        :class="{ 'is-busy': mixtapeDropBusy }"
      >
        <div class="mixtape-drop-overlay__panel">
          <div class="mixtape-drop-overlay__title">{{ mixtapeDropOverlayTitle }}</div>
          <div class="mixtape-drop-overlay__hint">{{ mixtapeDropOverlayHint }}</div>
        </div>
      </div>
    </Transition>
    <Transition name="mixtape-transport-toast">
      <div
        v-if="transportToastVisible"
        class="mixtape-transport-toast"
        role="alert"
        aria-live="assertive"
      >
        <div class="mixtape-transport-toast__message">{{ transportToastMessage }}</div>
      </div>
    </Transition>
    <UserGuideCard
      v-if="userGuideActiveStep && !userGuideConfirmShow"
      :key="userGuideActiveStep"
      :step="userGuideActiveStep"
      :beat="userGuideActiveBeat"
      :rekordbox-user="userGuideIsRekordboxUser"
      :beat-number="userGuideBeatNumber"
      :beat-count="userGuideBeatCount"
      :has-next="userGuideHasNextBeat"
      @next="goNextUserGuideBeat"
      @skip="dismissUserGuideStep"
    />
  </div>
</template>

<style scoped lang="scss" src="./Mixtape.scss"></style>
