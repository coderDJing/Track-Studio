<script setup lang="ts">
import { ref } from 'vue'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import HorizontalBrowseRawWaveformDetail from '@renderer/components/HorizontalBrowseRawWaveformDetail.vue'
import type {
  HorizontalBrowseGridShiftOptions,
  HorizontalBrowseGridToolbarState
} from '@renderer/composables/horizontalBrowse/useHorizontalBrowseGridToolbar'
import type {
  HorizontalBrowseDetailZoomChangePayload,
  HorizontalBrowseRawWaveformDetailExpose
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailTypes'
import type { HorizontalBrowseWaveformPresentationState } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformPresentationCoordinator'
import type {
  HorizontalBrowseLinkedGridVisualTransactionCommitOptions,
  HorizontalBrowseLinkedGridVisualTransactionDeckState
} from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedGridVisualTransaction'
import type { AudioEditClip } from '@shared/audioEditTimeline'
import type { SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'

type HorizontalBrowseSharedZoomState = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  revision: number
}

type HorizontalBrowseLoopRange = {
  startSec: number
  endSec: number
}

const props = defineProps<{
  song: ISongInfo | null
  sharedZoomState: HorizontalBrowseSharedZoomState
  currentSeconds: number
  playing: boolean
  playbackActive: boolean
  playbackRate: number
  waveformDensityPlaybackRate?: number
  liveTempoPreviewRate?: number | null
  waveformGain?: number
  playbackSyncRevision: number
  gridBpm: number
  loopRange: HorizontalBrowseLoopRange | null
  audioEditSelection?: HorizontalBrowseLoopRange | null
  audioEditPendingStartSec?: number | null
  audioEditPendingEndSec?: number | null
  audioEditInsertedRanges?: HorizontalBrowseLoopRange[] | null
  audioEditClips?: AudioEditClip[] | null
  cueSeconds?: number
  hotCues: ISongHotCue[]
  memoryCues: ISongMemoryCue[]
  seekTargetSeconds: number
  seekRevision: number
  linkedDragActive?: boolean
  linkedDragAnchorSec?: number | null
  linkedGridActive?: boolean
  linkedGridVisualPending?: boolean
  presentationState?: HorizontalBrowseWaveformPresentationState
  direction: 'up' | 'down'
  maxZoom?: number
  waveformLayout?: 'auto' | 'full'
  waveformRenderStyle?: 'columns' | 'raw-curve'
  allowNegativeTimeline?: boolean
  gridEditMode?: boolean
  interactionDisabled?: boolean
  deferGridPersist?: boolean
  deckHovered: boolean
  regionId: number
}>()

const emit = defineEmits<{
  (event: 'region-drag-enter', regionId: number, dragEvent: DragEvent): void
  (event: 'region-drag-over', regionId: number, dragEvent: DragEvent): void
  (event: 'region-drag-leave', regionId: number, dragEvent: DragEvent): void
  (event: 'region-drop', regionId: number, dragEvent: DragEvent): void
  (event: 'toolbar-state-change', value: HorizontalBrowseGridToolbarState): void
  (event: 'zoom-change', value: HorizontalBrowseDetailZoomChangePayload): void
  (event: 'drag-session-start'): void
  (event: 'drag-session-preview', payload: { anchorSec: number; playbackRate: number }): void
  (event: 'drag-session-end', payload: { anchorSec: number; committed: boolean }): void
  (event: 'edit-waveform-loading-change', value: boolean): void
  (event: 'display-beat-grid-change', value: SongBeatGridMapV2 | null): void
  (event: 'grid-dirty-change', value: boolean): void
}>()

const detailRef = ref<HorizontalBrowseRawWaveformDetailExpose | null>(null)

defineExpose<HorizontalBrowseRawWaveformDetailExpose>({
  setDownbeatLineAtPlayhead: () => detailRef.value?.setDownbeatLineAtPlayhead?.(),
  shiftGridLargeLeft: (options?: HorizontalBrowseGridShiftOptions) =>
    detailRef.value?.shiftGridLargeLeft?.(options),
  shiftGridSmallLeft: (options?: HorizontalBrowseGridShiftOptions) =>
    detailRef.value?.shiftGridSmallLeft?.(options),
  shiftGridSmallRight: (options?: HorizontalBrowseGridShiftOptions) =>
    detailRef.value?.shiftGridSmallRight?.(options),
  shiftGridLargeRight: (options?: HorizontalBrowseGridShiftOptions) =>
    detailRef.value?.shiftGridLargeRight?.(options),
  updateBpmInput: (value: string) => detailRef.value?.updateBpmInput?.(value),
  blurBpmInput: () => detailRef.value?.blurBpmInput?.(),
  tapBpm: () => detailRef.value?.tapBpm?.(),
  selectWholeAdjustment: () => detailRef.value?.selectWholeAdjustment?.(),
  splitAfterPlayhead: () => detailRef.value?.splitAfterPlayhead?.(),
  deleteBoundary: () => detailRef.value?.deleteBoundary?.(),
  freezeDynamicGridSelectionForBpmInput: () =>
    detailRef.value?.freezeDynamicGridSelectionForBpmInput?.(),
  releaseDynamicGridSelectionForBpmInput: () =>
    detailRef.value?.releaseDynamicGridSelectionForBpmInput?.(),
  cycleMetronomeState: () => detailRef.value?.cycleMetronomeState?.(),
  setLiveTempoPreviewRate: (rate: number | null) =>
    detailRef.value?.setLiveTempoPreviewRate?.(rate),
  prepareStableFrameForAnchor: (seconds: number, options?: { timeoutMs?: number }) =>
    detailRef.value?.prepareStableFrameForAnchor?.(seconds, options) ?? Promise.resolve(false),
  commitLinkedGridVisualTransaction: (
    deckState?: HorizontalBrowseLinkedGridVisualTransactionDeckState,
    options?: HorizontalBrowseLinkedGridVisualTransactionCommitOptions
  ) => detailRef.value?.commitLinkedGridVisualTransaction?.(deckState, options) ?? null,
  flushGridPersist: (filePath?: string) =>
    detailRef.value?.flushGridPersist?.(filePath) ?? Promise.resolve(),
  restoreGridFromSong: () => detailRef.value?.restoreGridFromSong?.(),
  clearGridHistory: () => detailRef.value?.clearGridHistory?.()
})
</script>

<template>
  <div
    class="detail-lane drop-zone"
    :class="{ 'is-deck-hover': props.deckHovered }"
    @dragenter.stop.prevent="emit('region-drag-enter', props.regionId, $event)"
    @dragover.stop.prevent="emit('region-drag-over', props.regionId, $event)"
    @dragleave.stop="emit('region-drag-leave', props.regionId, $event)"
    @drop.stop.prevent="emit('region-drop', props.regionId, $event)"
  >
    <HorizontalBrowseRawWaveformDetail
      ref="detailRef"
      :song="props.song"
      :shared-zoom-state="props.sharedZoomState"
      :current-seconds="props.currentSeconds"
      :playing="props.playing"
      :playback-active="props.playbackActive"
      :playback-rate="props.playbackRate"
      :waveform-density-playback-rate="props.waveformDensityPlaybackRate"
      :live-tempo-preview-rate="props.liveTempoPreviewRate"
      :waveform-gain="props.waveformGain"
      :playback-sync-revision="props.playbackSyncRevision"
      :grid-bpm="props.gridBpm"
      :loop-range="props.loopRange"
      :audio-edit-selection="props.audioEditSelection"
      :audio-edit-pending-start-sec="props.audioEditPendingStartSec"
      :audio-edit-pending-end-sec="props.audioEditPendingEndSec"
      :audio-edit-inserted-ranges="props.audioEditInsertedRanges"
      :audio-edit-clips="props.audioEditClips"
      :cue-seconds="props.cueSeconds"
      :hot-cues="props.hotCues"
      :memory-cues="props.memoryCues"
      :seek-target-seconds="props.seekTargetSeconds"
      :seek-revision="props.seekRevision"
      :linked-drag-active="props.linkedDragActive"
      :linked-drag-anchor-sec="props.linkedDragAnchorSec"
      :linked-grid-active="props.linkedGridActive"
      :linked-grid-visual-pending="props.linkedGridVisualPending"
      :presentation-state="props.presentationState"
      :max-zoom="props.maxZoom"
      :waveform-layout="props.waveformLayout"
      :waveform-render-style="props.waveformRenderStyle"
      :allow-negative-timeline="props.allowNegativeTimeline"
      :grid-edit-mode="props.gridEditMode"
      :interaction-disabled="props.interactionDisabled"
      :defer-grid-persist="props.deferGridPersist"
      :direction="props.direction"
      @toolbar-state-change="emit('toolbar-state-change', $event)"
      @zoom-change="emit('zoom-change', $event)"
      @drag-session-start="emit('drag-session-start')"
      @drag-session-preview="emit('drag-session-preview', $event)"
      @drag-session-end="emit('drag-session-end', $event)"
      @edit-waveform-loading-change="emit('edit-waveform-loading-change', $event)"
      @display-beat-grid-change="emit('display-beat-grid-change', $event)"
      @grid-dirty-change="emit('grid-dirty-change', $event)"
    />
    <div
      v-show="!!props.song"
      class="detail-lane__playhead"
      :class="{ 'is-paused': !props.playing }"
    ></div>
  </div>
</template>

<style scoped lang="scss">
.detail-lane__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  background: var(--shell-playhead-bg);
  pointer-events: none;
  z-index: 6;
}

.detail-lane__playhead.is-paused {
  opacity: 0.7;
}
</style>
