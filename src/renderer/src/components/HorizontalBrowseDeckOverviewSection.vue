<script setup lang="ts">
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import HorizontalBrowseDeckInfoCard from '@renderer/components/HorizontalBrowseDeckInfoCard.vue'
import HorizontalBrowseWaveformOverview from '@renderer/components/HorizontalBrowseWaveformOverview.vue'
import HorizontalBrowseDeckToolbarRow from '@renderer/components/HorizontalBrowseDeckToolbarRow.vue'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseTempoNudgeDirection } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckTempoNudge'
import type { HorizontalBrowseDeckMoveTargetLibrary } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckMove'
import type { LibraryTransferActionMode } from '@renderer/utils/libraryTransfer'
import type { HorizontalBrowsePlaybackRangeOverlay } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseEditPlaybackRange'
import type { AudioEditClip, AudioEditRange } from '@shared/audioEditTimeline'

type DeckToolbarState = {
  disabled: boolean
  bpmInputDisabled: boolean
  showGridControls: boolean
  bpmInputValue: string
  bpmStep: number
  bpmMin: number
  bpmMax: number
  bpmInputTitle?: string
  bpmInputFirst?: boolean
  showTapButton?: boolean
  tapBpmTitle?: string
  metronomeEnabled: boolean
  metronomeVolumeLevel: 1 | 2 | 3
  canToggleMetronome: boolean
  gridControlsDisabled: boolean
  gridShiftOnly?: boolean
  showSplitAfterPlayhead: boolean
  showDeleteBoundary: boolean
  gridAdjustScope: 'whole' | 'after'
  loopBeatLabel: string
  loopActive: boolean
  loopDisabled: boolean
  showMetronome: boolean
}

type HorizontalBrowseLoopRange = {
  startSec: number
  endSec: number
}

const props = defineProps<{
  position: 'top' | 'bottom'
  regionIds: number[]
  deck: HorizontalBrowseDeckKey
  deckHovered: boolean
  song: ISongInfo | null
  beatSyncEnabled: boolean
  beatSyncPending: boolean
  masterActive: boolean
  masterPending: boolean
  masterFailed: boolean
  keyHighlighted: boolean
  currentSeconds: number
  durationSeconds: number
  hotCues: ISongHotCue[]
  memoryCues: ISongMemoryCue[]
  toolbarState: DeckToolbarState
  loopRange: HorizontalBrowseLoopRange | null
  readOnlySource: boolean
  quantizeEnabled: boolean
  masterTempoEnabled: boolean
  tempoNudgeActiveDirection?: HorizontalBrowseTempoNudgeDirection | null
  showTempoNudge?: boolean
  hideSyncControls?: boolean
  showEnergy?: boolean
  showLargeShiftButtons?: boolean
  hideTransportActions?: boolean
  showQuantizeAction?: boolean
  sectionSeekMode?: 'seek' | 'seek-play'
  playbackRange?: HorizontalBrowsePlaybackRangeOverlay | null
  audioEditHasEdits?: boolean
  audioEditClips?: AudioEditClip[] | null
  audioEditSelection?: AudioEditRange | null
  audioEditPendingStartSec?: number | null
  audioEditPendingEndSec?: number | null
  audioEditInsertedRanges?: AudioEditRange[] | null
}>()

const emit = defineEmits<{
  (event: 'region-drag-enter', regionId: number, dragEvent: DragEvent): void
  (event: 'region-drag-over', regionId: number, dragEvent: DragEvent): void
  (event: 'region-drag-leave', regionId: number, dragEvent: DragEvent): void
  (event: 'region-drop', regionId: number, dragEvent: DragEvent): void
  (event: 'trigger-beat-sync'): void
  (event: 'toggle-master'): void
  (event: 'eject-song'): void
  (event: 'seek', seconds: number): void
  (event: 'seek-play', seconds: number): void
  (event: 'set-downbeat-line'): void
  (event: 'shift-left-large'): void
  (event: 'shift-left-small'): void
  (event: 'shift-right-small'): void
  (event: 'shift-right-large'): void
  (event: 'update-bpm-input', value: string): void
  (event: 'live-bpm-input', value: string): void
  (event: 'blur-bpm-input'): void
  (event: 'tap-bpm'): void
  (event: 'memory-cue'): void
  (event: 'select-whole-adjustment'): void
  (event: 'split-after-playhead'): void
  (event: 'delete-boundary'): void
  (event: 'loop-step-down'): void
  (event: 'loop-step-up'): void
  (event: 'toggle-loop'): void
  (event: 'toggle-master-tempo'): void
  (event: 'reset-tempo'): void
  (event: 'toggle-quantize'): void
  (event: 'cycle-metronome-state'): void
  (event: 'tempo-nudge-start', direction: HorizontalBrowseTempoNudgeDirection): void
  (event: 'tempo-nudge-end', direction: HorizontalBrowseTempoNudgeDirection): void
  (
    event: 'select-move-target',
    target: HorizontalBrowseDeckMoveTargetLibrary,
    actionMode?: LibraryTransferActionMode
  ): void
}>()

const isTop = props.position === 'top'
</script>

<template>
  <section
    class="overview"
    :class="[
      props.position === 'top' ? 'overview--top' : 'overview--bottom',
      { 'is-deck-hover': props.deckHovered }
    ]"
  >
    <div
      v-for="regionId in props.regionIds"
      :key="regionId"
      class="overview__region drop-zone"
      :class="{
        'overview__region--deck-info': isTop ? regionId === 1 : regionId === 8,
        'overview__region--muted': isTop ? regionId === 2 : regionId === 7,
        'overview__region--toolbar': isTop ? regionId === 3 : regionId === 6
      }"
      @dragenter.stop.prevent="emit('region-drag-enter', regionId, $event)"
      @dragover.stop.prevent="emit('region-drag-over', regionId, $event)"
      @dragleave.stop="emit('region-drag-leave', regionId, $event)"
      @drop.stop.prevent="emit('region-drop', regionId, $event)"
    >
      <HorizontalBrowseDeckInfoCard
        v-if="(isTop && regionId === 1) || (!isTop && regionId === 8)"
        :song="props.song"
        :beat-sync-enabled="props.beatSyncEnabled"
        :beat-sync-pending="props.beatSyncPending"
        :master-active="props.masterActive"
        :master-pending="props.masterPending"
        :master-failed="props.masterFailed"
        :key-highlighted="props.keyHighlighted"
        :current-seconds="props.currentSeconds"
        :duration-seconds="props.durationSeconds"
        :hide-sync-controls="props.hideSyncControls"
        :show-energy="props.showEnergy"
        :user-guide-target="isTop ? 'horizontal-beat-sync' : undefined"
        @trigger-beat-sync="emit('trigger-beat-sync')"
        @toggle-master="emit('toggle-master')"
        @eject-song="emit('eject-song')"
      />
      <HorizontalBrowseWaveformOverview
        v-else-if="(isTop && regionId === 2) || (!isTop && regionId === 7)"
        :song="props.song"
        :current-seconds="props.currentSeconds"
        :duration-seconds="props.durationSeconds"
        :hot-cues="props.hotCues"
        :memory-cues="props.memoryCues"
        marker-anchor="top"
        :loop-range="props.loopRange"
        :section-seek-mode="props.sectionSeekMode || 'seek-play'"
        :playback-range="props.playbackRange"
        :audio-edit-has-edits="props.audioEditHasEdits"
        :audio-edit-clips="props.audioEditClips"
        :audio-edit-selection="props.audioEditSelection"
        :audio-edit-pending-start-sec="props.audioEditPendingStartSec"
        :audio-edit-pending-end-sec="props.audioEditPendingEndSec"
        :audio-edit-inserted-ranges="props.audioEditInsertedRanges"
        @seek="emit('seek', $event)"
        @seek-play="emit('seek-play', $event)"
      />
      <HorizontalBrowseDeckToolbarRow
        v-else-if="(isTop && regionId === 3) || (!isTop && regionId === 6)"
        :data-user-guide-target="isTop ? 'horizontal-tools' : undefined"
        :disabled="props.toolbarState.disabled"
        :bpm-input-disabled="props.toolbarState.bpmInputDisabled"
        :show-grid-controls="props.toolbarState.showGridControls"
        :bpm-input-value="props.toolbarState.bpmInputValue"
        :bpm-step="props.toolbarState.bpmStep"
        :bpm-min="props.toolbarState.bpmMin"
        :bpm-max="props.toolbarState.bpmMax"
        :bpm-input-title="props.toolbarState.bpmInputTitle"
        :bpm-input-first="props.toolbarState.bpmInputFirst"
        :show-tap-button="props.toolbarState.showTapButton"
        :tap-bpm-title="props.toolbarState.tapBpmTitle"
        :grid-controls-disabled="props.toolbarState.gridControlsDisabled"
        :grid-shift-only="props.toolbarState.gridShiftOnly"
        :show-split-after-playhead="props.toolbarState.showSplitAfterPlayhead"
        :show-delete-boundary="props.toolbarState.showDeleteBoundary"
        :grid-adjust-scope="props.toolbarState.gridAdjustScope"
        :loop-beat-label="props.toolbarState.loopBeatLabel"
        :loop-active="props.toolbarState.loopActive"
        :loop-disabled="props.toolbarState.loopDisabled"
        :song-present="!!props.song"
        :read-only-source="props.readOnlySource"
        :quantize-enabled="props.quantizeEnabled"
        :master-tempo-enabled="props.masterTempoEnabled"
        :show-metronome="props.toolbarState.showMetronome"
        :tempo-nudge-active-direction="props.tempoNudgeActiveDirection"
        :show-tempo-nudge="props.showTempoNudge"
        :metronome-enabled="props.toolbarState.metronomeEnabled"
        :metronome-volume-level="props.toolbarState.metronomeVolumeLevel"
        :can-toggle-metronome="props.toolbarState.canToggleMetronome"
        :show-large-shift-buttons="props.showLargeShiftButtons"
        :hide-transport-actions="props.hideTransportActions"
        :show-quantize-action="props.showQuantizeAction"
        @set-downbeat-line="emit('set-downbeat-line')"
        @shift-left-large="emit('shift-left-large')"
        @shift-left-small="emit('shift-left-small')"
        @shift-right-small="emit('shift-right-small')"
        @shift-right-large="emit('shift-right-large')"
        @update-bpm-input="emit('update-bpm-input', $event)"
        @live-bpm-input="emit('live-bpm-input', $event)"
        @blur-bpm-input="emit('blur-bpm-input')"
        @tap-bpm="emit('tap-bpm')"
        @memory-cue="emit('memory-cue')"
        @select-whole-adjustment="emit('select-whole-adjustment')"
        @split-after-playhead="emit('split-after-playhead')"
        @delete-boundary="emit('delete-boundary')"
        @loop-step-down="emit('loop-step-down')"
        @loop-step-up="emit('loop-step-up')"
        @toggle-loop="emit('toggle-loop')"
        @toggle-master-tempo="emit('toggle-master-tempo')"
        @reset-tempo="emit('reset-tempo')"
        @toggle-quantize="emit('toggle-quantize')"
        @cycle-metronome-state="emit('cycle-metronome-state')"
        @tempo-nudge-start="emit('tempo-nudge-start', $event)"
        @tempo-nudge-end="emit('tempo-nudge-end', $event)"
        @select-move-target="(target, actionMode) => emit('select-move-target', target, actionMode)"
      >
        <template v-if="$slots['toolbar-leading']" #leading>
          <slot name="toolbar-leading" />
        </template>
        <template v-if="$slots['toolbar-tools']" #tools>
          <slot name="toolbar-tools" />
        </template>
      </HorizontalBrowseDeckToolbarRow>
    </div>
  </section>
</template>

<style scoped lang="scss">
.overview__region {
  position: relative;
  display: flex;
  align-items: stretch;
  justify-content: flex-start;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.overview__region > * {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 100%;
}

.overview__region--deck-info {
  overflow: hidden;
}

.overview__region--toolbar {
  overflow: visible;
  z-index: var(--shell-z-deck-menu, 45);
}

.overview--top .overview__region--deck-info {
  z-index: var(--shell-z-deck-info-top);
}

.overview--bottom .overview__region--deck-info {
  z-index: var(--shell-z-deck-info-bottom);
}

.overview__region--muted {
  padding: 0;
}
</style>
