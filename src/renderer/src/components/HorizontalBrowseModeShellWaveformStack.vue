<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import HorizontalBrowseAudioEditToolbar from '@renderer/components/HorizontalBrowseAudioEditToolbar.vue'
import HorizontalBrowseCuePanels from '@renderer/components/HorizontalBrowseCuePanels.vue'
import HorizontalBrowseDeckDetailLane from '@renderer/components/HorizontalBrowseDeckDetailLane.vue'
import HorizontalBrowseDeckOverviewSection from '@renderer/components/HorizontalBrowseDeckOverviewSection.vue'
import HorizontalBrowseEditSubModeSwitch from '@renderer/components/HorizontalBrowseEditSubModeSwitch.vue'
import {
  HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_EDIT_DETAIL_MAX_ZOOM
} from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type {
  DeckCuePanelMode,
  HorizontalBrowseDeckDetailLaneExpose
} from '@renderer/composables/horizontalBrowse/horizontalBrowseModeShellTypes'
import type {
  HorizontalBrowseModeShellWaveformStackExpose,
  HorizontalBrowseModeShellWaveformStackModel
} from '@renderer/components/horizontalBrowseModeShellWaveformStackTypes'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'

type DeckKey = HorizontalBrowseDeckKey

const props = defineProps<{
  model: HorizontalBrowseModeShellWaveformStackModel
}>()
const model = props.model
const topOverviewRegions = [1, 2, 3]
const bottomOverviewRegions = [6, 7, 8]
const topDetailRef = ref<HorizontalBrowseDeckDetailLaneExpose | null>(null)
const bottomDetailRef = ref<HorizontalBrowseDeckDetailLaneExpose | null>(null)
const deckCuePanelMode = reactive<Record<DeckKey, DeckCuePanelMode>>({
  top: 'memory',
  bottom: 'memory'
})

const resolveDetailRef = (deck: DeckKey) =>
  deck === 'top' ? topDetailRef.value : bottomDetailRef.value

const resolveMasterButtonActive = (deck: DeckKey) => {
  const pending = model.pendingMasterDeck.value
  if (pending && model.failedMasterDeck.value !== pending) return pending === deck
  const song = deck === 'top' ? model.topDeckSong.value : model.bottomDeckSong.value
  return Boolean(song) && model.deckSyncState.leaderDeck === deck
}

const handleCuePanelHotCuePress = async (payload: { deck: DeckKey; slot: number }) => {
  if (model.isEditMode.value && payload.deck === 'top') {
    const cue = model.audioEdit.session.hotCues.value.find((item) => item.slot === payload.slot)
    if (cue) {
      await model.audioEdit.handleSeekAndPlay(Number(cue.sec))
    } else {
      model.audioEdit.setHotCue(payload.slot)
    }
    return
  }
  if (!model.isEditMode.value || payload.deck !== 'top') {
    await model.handleDeckHotCuePress(payload.deck, payload.slot)
  }
}

const handleCuePanelMemoryCuePress = async (payload: { deck: DeckKey; sec: number }) => {
  if (model.isEditMode.value && payload.deck === 'top') {
    await model.audioEdit.handleSeekAndPlay(payload.sec)
    return
  }
  if (!model.isEditMode.value || payload.deck !== 'top') {
    await model.handleDeckMemoryCueRecallPress(payload.deck, payload.sec)
  }
}

const handleCuePanelHotCueDelete = async (payload: { deck: DeckKey; slot: number }) => {
  if (model.isEditMode.value && payload.deck === 'top') {
    model.audioEdit.deleteHotCue(payload.slot)
    return
  }
  await model.handleDeckHotCueDelete(payload.deck, payload.slot)
}

const handleCuePanelMemoryCueDelete = async (payload: { deck: DeckKey; sec: number }) => {
  if (model.isEditMode.value && payload.deck === 'top') {
    model.audioEdit.deleteMemoryCue(payload.sec)
    return
  }
  await model.handleDeckMemoryCueDelete(payload.deck, payload.sec)
}

const handleTopMemoryCueCreate = () => {
  if (model.isEditMode.value) {
    model.audioEdit.setMemoryCue()
    return
  }
  void model.handleDeckMemoryCueCreate('top')
}

const topDisplaySong = computed(() => {
  const song = model.topDeckSong.value
  if (!song || !model.isEditMode.value) return song
  return {
    ...song,
    songStructure: model.audioEdit.session.songStructure.value ?? song.songStructure
  }
})
const topDisplayHotCues = computed(() =>
  model.isEditMode.value
    ? model.audioEdit.session.hotCues.value
    : model.topDeckSong.value?.hotCues || []
)
const topDisplayMemoryCues = computed(() =>
  model.isEditMode.value
    ? model.audioEdit.session.memoryCues.value
    : model.topDeckSong.value?.memoryCues || []
)
const bottomDisplayHotCues = computed(() => model.bottomDeckSong.value?.hotCues || [])
const bottomDisplayMemoryCues = computed(() => model.bottomDeckSong.value?.memoryCues || [])
const topDisplayLoopRange = computed(() =>
  model.isEditMode.value
    ? model.audioEdit.session.loopRange.value
    : model.resolveDeckLoopRange('top')
)
const topDisplayCueSeconds = computed(() =>
  model.isEditMode.value
    ? (model.audioEdit.session.cuePointSec.value ?? undefined)
    : model.topDeckCuePointSeconds.value
)

defineExpose<HorizontalBrowseModeShellWaveformStackExpose>({
  resolveDetailRef
})

onMounted(() => {
  model.audioEdit.attachGridHost({
    persistToFile: (filePath) =>
      topDetailRef.value?.flushGridPersist?.(filePath) ?? Promise.resolve(),
    restoreFromSong: () => {
      topDetailRef.value?.restoreGridFromSong?.()
    },
    clearHistory: () => {
      topDetailRef.value?.clearGridHistory?.()
    }
  })
})
onUnmounted(() => {
  model.audioEdit.attachGridHost(null)
})
</script>

<template>
  <div class="waveform-stack" :class="{ 'waveform-stack--edit': model.isEditMode.value }">
    <HorizontalBrowseDeckOverviewSection
      position="top"
      :region-ids="topOverviewRegions"
      deck="top"
      :deck-hovered="model.isDeckHovered('top')"
      :song="topDisplaySong"
      :beat-sync-enabled="model.topDeckSong.value ? model.resolveDeckSyncUiEnabled('top') : false"
      :beat-sync-pending="model.pendingBeatSync.top"
      :master-active="resolveMasterButtonActive('top')"
      :master-pending="model.pendingMasterDeck.value === 'top'"
      :master-failed="model.failedMasterDeck.value === 'top'"
      :key-highlighted="model.deckKeysHarmonicMatched.value"
      :current-seconds="model.topDeckVisibleCurrentSeconds.value"
      :duration-seconds="model.topDeckVisibleDurationSeconds.value"
      :hot-cues="topDisplayHotCues"
      :memory-cues="topDisplayMemoryCues"
      :toolbar-state="model.resolveDeckToolbarState('top')"
      :loop-range="topDisplayLoopRange"
      :playback-range="model.playbackRangeOverlay.value"
      :audio-edit-has-edits="model.audioEdit.session.hasEdits.value"
      :audio-edit-clips="model.audioEdit.session.clips.value"
      :audio-edit-selection="model.audioEdit.session.completeSelection.value"
      :audio-edit-pending-start-sec="model.audioEdit.session.pendingStartSec.value"
      :audio-edit-pending-end-sec="model.audioEdit.session.pendingEndSec.value"
      :audio-edit-inserted-ranges="
        model.isEditMode.value ? model.audioEdit.session.insertedRanges.value : null
      "
      :read-only-source="model.isDeckSongReadOnly('top')"
      :quantize-enabled="model.deckQuantizeEnabled.top"
      :master-tempo-enabled="model.isDeckMasterTempoEnabled('top')"
      :tempo-nudge-active-direction="model.resolveDeckTempoNudgeDirection('top')"
      :show-tempo-nudge="!model.isEditMode.value"
      :hide-sync-controls="model.isEditMode.value"
      :hide-transport-actions="model.isEditMode.value"
      :show-quantize-action="model.isEditMode.value && model.audioEdit.subMode.value === 'grid'"
      :section-seek-mode="model.isEditMode.value ? 'seek' : 'seek-play'"
      show-energy
      :show-large-shift-buttons="model.isEditMode.value"
      @region-drag-enter="model.handleRegionDragEnter"
      @region-drag-over="model.handleRegionDragOver"
      @region-drag-leave="model.handleRegionDragLeave"
      @region-drop="model.handleRegionDrop"
      @trigger-beat-sync="model.triggerDeckBeatSync('top')"
      @toggle-master="model.toggleDeckMaster('top')"
      @eject-song="model.handleTopDeckEjectSong()"
      @seek="model.handleDeckPlayheadSeek('top', $event)"
      @seek-play="model.handleDeckSectionSeekPlay('top', $event)"
      @set-downbeat-line="model.handleDeckSetDownbeatLineAtPlayhead('top')"
      @shift-left-large="model.handleDeckGridShiftLargeLeft('top')"
      @shift-left-small="model.handleDeckGridShiftSmallLeft('top')"
      @shift-right-small="model.handleDeckGridShiftSmallRight('top')"
      @shift-right-large="model.handleDeckGridShiftLargeRight('top')"
      @update-bpm-input="model.handleDeckBpmInputUpdate('top', $event)"
      @live-bpm-input="model.handleDeckBpmInputLive('top', $event)"
      @blur-bpm-input="model.handleDeckBpmInputBlur('top')"
      @tap-bpm="model.handleDeckBpmTap('top')"
      @memory-cue="handleTopMemoryCueCreate()"
      @select-whole-adjustment="model.handleDeckSelectWholeAdjustment('top')"
      @split-after-playhead="model.handleDeckSplitAfterPlayhead('top')"
      @delete-boundary="model.handleDeckDeleteBoundary('top')"
      @cycle-metronome-state="model.handleDeckMetronomeStateCycle('top')"
      @loop-step-down="model.handleDeckLoopStepDown('top')"
      @loop-step-up="model.handleDeckLoopStepUp('top')"
      @toggle-loop="model.handleDeckLoopToggle('top')"
      @toggle-master-tempo="model.handleDeckMasterTempoToggle('top')"
      @reset-tempo="model.resetDeckTempo('top')"
      @toggle-quantize="model.handleDeckQuantizeToggle('top')"
      @tempo-nudge-start="model.startDeckTempoNudge('top', $event)"
      @tempo-nudge-end="model.stopDeckTempoNudge('top', $event)"
      @select-move-target="
        (target, actionMode) => model.openDeckMoveDialog('top', target, actionMode)
      "
    >
      <template v-if="model.isEditMode.value" #toolbar-leading>
        <HorizontalBrowseEditSubModeSwitch
          :mode="model.audioEdit.subMode.value"
          :disabled="model.audioEdit.saving.value"
          @update:mode="model.audioEdit.subMode.value = $event"
        />
      </template>
      <template
        v-if="model.isEditMode.value && model.audioEdit.subMode.value === 'audio'"
        #toolbar-tools
      >
        <HorizontalBrowseAudioEditToolbar
          :song-present="!!model.topDeckSong.value"
          :writable="model.audioEdit.writable.value"
          :preparing="model.audioEdit.playback.preparing.value"
          :prepare-failed="Boolean(model.audioEdit.playback.prepareError.value)"
          :ready="model.audioEdit.playback.ready.value"
          :playing="model.audioEdit.displayPlaying.value"
          :saving="model.audioEdit.saving.value"
          :can-undo="model.audioEdit.session.canUndo.value"
          :can-redo="model.audioEdit.session.canRedo.value"
          :has-selection="Boolean(model.audioEdit.session.completeSelection.value)"
          :start-set="model.audioEdit.session.pendingStartSec.value != null"
          :end-set="model.audioEdit.session.pendingEndSec.value != null"
          :has-clipboard="model.audioEdit.session.clipboard.value.length > 0"
          :loop-count="model.audioEdit.session.loopGroup.value?.count || 0"
          :has-loop-group="Boolean(model.audioEdit.session.loopGroup.value)"
          :selection-summary="model.audioEdit.session.selectionSummary.value"
          :dirty="model.audioEdit.canSave.value"
          :error-text="model.audioEdit.saveError.value"
          :notice-text="model.audioEdit.noticeMessage.value"
          @undo="model.audioEdit.undo()"
          @redo="model.audioEdit.redo()"
          @set-start="model.audioEdit.setStart()"
          @set-end="model.audioEdit.setEnd()"
          @clear-selection="model.audioEdit.clearSelection()"
          @cut="model.audioEdit.cut()"
          @copy="model.audioEdit.copy()"
          @paste="model.audioEdit.paste()"
          @loop="model.audioEdit.applyLoop()"
          @loop-minus="model.audioEdit.loopMinus()"
          @loop-plus="model.audioEdit.loopPlus()"
          @retry-prepare="model.audioEdit.retryPreparation()"
          @save="model.audioEdit.requestSave()"
        />
      </template>
    </HorizontalBrowseDeckOverviewSection>

    <section class="detail-pair" :class="{ 'detail-pair--edit': model.isEditMode.value }">
      <HorizontalBrowseDeckDetailLane
        ref="topDetailRef"
        :song="topDisplaySong"
        :shared-zoom-state="
          model.isEditMode.value
            ? model.editDetailZoomState.value
            : model.sharedDetailZoomState.value
        "
        :current-seconds="model.topDeckVisibleCurrentSeconds.value"
        :playing="model.topDeckVisiblePlaying.value"
        :playback-active="
          model.isEditMode.value
            ? model.topDeckVisiblePlaying.value
            : model.topDeckWaveformPlaybackActive.value
        "
        :playback-rate="model.topDeckPlaybackRate.value"
        :waveform-gain="model.resolveDeckWaveformGain('top')"
        :playback-sync-revision="model.topDeckPlaybackSyncRevision.value"
        :grid-bpm="model.topDeckGridBpm.value"
        :loop-range="topDisplayLoopRange"
        :audio-edit-selection="
          model.isEditMode.value ? model.audioEdit.session.completeSelection.value : null
        "
        :audio-edit-pending-start-sec="
          model.isEditMode.value ? model.audioEdit.session.pendingStartSec.value : null
        "
        :audio-edit-pending-end-sec="
          model.isEditMode.value ? model.audioEdit.session.pendingEndSec.value : null
        "
        :audio-edit-inserted-ranges="
          model.isEditMode.value ? model.audioEdit.session.insertedRanges.value : null
        "
        :audio-edit-clips="model.isEditMode.value ? model.audioEdit.session.clips.value : null"
        :cue-seconds="topDisplayCueSeconds"
        :hot-cues="topDisplayHotCues"
        :memory-cues="topDisplayMemoryCues"
        :seek-target-seconds="model.deckSeekIntent.top.seconds"
        :seek-revision="model.deckSeekIntent.top.revision"
        :linked-drag-active="!model.isEditMode.value && model.isDeckWaveformDragging('top')"
        :linked-drag-anchor-sec="
          !model.isEditMode.value ? model.resolveDeckWaveformDragAnchorSec('top') : null
        "
        :linked-grid-active="!model.isEditMode.value && model.shouldPreserveGridShiftPhase('top')"
        :presentation-state="model.waveformPresentation.state.top"
        :max-zoom="
          model.isEditMode.value
            ? HORIZONTAL_BROWSE_EDIT_DETAIL_MAX_ZOOM
            : HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM
        "
        :waveform-layout="model.isEditMode.value ? 'full' : 'auto'"
        waveform-render-style="raw-curve"
        allow-negative-timeline
        :grid-edit-mode="model.gridEditMode.value"
        :interaction-disabled="model.audioEdit.saving.value"
        :defer-grid-persist="model.isEditMode.value"
        direction="up"
        :deck-hovered="model.isDeckHovered('top')"
        :region-id="4"
        @region-drag-enter="model.handleRegionDragEnter"
        @region-drag-over="model.handleRegionDragOver"
        @region-drag-leave="model.handleRegionDragLeave"
        @region-drop="model.handleRegionDrop"
        @toolbar-state-change="model.handleToolbarStateChange('top', $event)"
        @zoom-change="model.handleDetailZoomChange"
        @drag-session-start="model.handleDeckRawWaveformDragStart('top')"
        @drag-session-preview="model.handleDeckRawWaveformScrubPreview('top', $event)"
        @drag-session-end="model.handleDeckRawWaveformDragEnd('top', $event)"
        @edit-waveform-loading-change="model.handleEditWaveformLoadingChange"
        @display-beat-grid-change="model.audioEdit.handleDisplayBeatGridChange"
        @grid-dirty-change="model.audioEdit.handleGridDirtyChange"
      />
      <HorizontalBrowseDeckDetailLane
        v-if="!model.isEditMode.value"
        ref="bottomDetailRef"
        :song="model.bottomDeckSong.value"
        :shared-zoom-state="model.sharedDetailZoomState.value"
        :current-seconds="model.bottomDeckRenderCurrentSeconds.value"
        :playing="model.bottomDeckUiPlaying.value"
        :playback-active="model.bottomDeckWaveformPlaybackActive.value"
        :playback-rate="model.bottomDeckPlaybackRate.value"
        :waveform-gain="model.resolveDeckWaveformGain('bottom')"
        :playback-sync-revision="model.bottomDeckPlaybackSyncRevision.value"
        :grid-bpm="model.bottomDeckGridBpm.value"
        :loop-range="model.resolveDeckLoopRange('bottom')"
        :cue-seconds="model.bottomDeckCuePointSeconds.value"
        :hot-cues="bottomDisplayHotCues"
        :memory-cues="bottomDisplayMemoryCues"
        :seek-target-seconds="model.deckSeekIntent.bottom.seconds"
        :seek-revision="model.deckSeekIntent.bottom.revision"
        :linked-drag-active="model.isDeckWaveformDragging('bottom')"
        :linked-drag-anchor-sec="model.resolveDeckWaveformDragAnchorSec('bottom')"
        :linked-grid-active="model.shouldPreserveGridShiftPhase('bottom')"
        :presentation-state="model.waveformPresentation.state.bottom"
        :max-zoom="HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM"
        waveform-layout="auto"
        waveform-render-style="raw-curve"
        allow-negative-timeline
        :grid-edit-mode="false"
        direction="down"
        :deck-hovered="model.isDeckHovered('bottom')"
        :region-id="5"
        @region-drag-enter="model.handleRegionDragEnter"
        @region-drag-over="model.handleRegionDragOver"
        @region-drag-leave="model.handleRegionDragLeave"
        @region-drop="model.handleRegionDrop"
        @toolbar-state-change="model.handleToolbarStateChange('bottom', $event)"
        @zoom-change="model.handleDetailZoomChange"
        @drag-session-start="model.handleDeckRawWaveformDragStart('bottom')"
        @drag-session-preview="model.handleDeckRawWaveformScrubPreview('bottom', $event)"
        @drag-session-end="model.handleDeckRawWaveformDragEnd('bottom', $event)"
      />
    </section>

    <HorizontalBrowseDeckOverviewSection
      v-if="!model.isEditMode.value"
      position="bottom"
      :region-ids="bottomOverviewRegions"
      deck="bottom"
      :deck-hovered="model.isDeckHovered('bottom')"
      :song="model.bottomDeckSong.value"
      :beat-sync-enabled="
        model.bottomDeckSong.value ? model.resolveDeckSyncUiEnabled('bottom') : false
      "
      :beat-sync-pending="model.pendingBeatSync.bottom"
      :master-active="resolveMasterButtonActive('bottom')"
      :master-pending="model.pendingMasterDeck.value === 'bottom'"
      :master-failed="model.failedMasterDeck.value === 'bottom'"
      :key-highlighted="model.deckKeysHarmonicMatched.value"
      :current-seconds="model.bottomDeckRenderCurrentSeconds.value"
      :duration-seconds="model.bottomDeckDurationSeconds.value"
      :hot-cues="bottomDisplayHotCues"
      :memory-cues="bottomDisplayMemoryCues"
      :toolbar-state="model.resolveDeckToolbarState('bottom')"
      :loop-range="model.resolveDeckLoopRange('bottom')"
      :read-only-source="model.isDeckSongReadOnly('bottom')"
      :quantize-enabled="model.deckQuantizeEnabled.bottom"
      :master-tempo-enabled="model.isDeckMasterTempoEnabled('bottom')"
      :tempo-nudge-active-direction="model.resolveDeckTempoNudgeDirection('bottom')"
      :show-tempo-nudge="!model.isEditMode.value"
      show-energy
      @region-drag-enter="model.handleRegionDragEnter"
      @region-drag-over="model.handleRegionDragOver"
      @region-drag-leave="model.handleRegionDragLeave"
      @region-drop="model.handleRegionDrop"
      @trigger-beat-sync="model.triggerDeckBeatSync('bottom')"
      @toggle-master="model.toggleDeckMaster('bottom')"
      @eject-song="model.handleDeckEjectSong('bottom')"
      @seek="model.handleDeckPlayheadSeek('bottom', $event)"
      @seek-play="model.handleDeckSectionSeekPlay('bottom', $event)"
      @set-downbeat-line="model.handleDeckSetDownbeatLineAtPlayhead('bottom')"
      @shift-left-large="model.handleDeckGridShiftLargeLeft('bottom')"
      @shift-left-small="model.handleDeckGridShiftSmallLeft('bottom')"
      @shift-right-small="model.handleDeckGridShiftSmallRight('bottom')"
      @shift-right-large="model.handleDeckGridShiftLargeRight('bottom')"
      @update-bpm-input="model.handleDeckBpmInputUpdate('bottom', $event)"
      @live-bpm-input="model.handleDeckBpmInputLive('bottom', $event)"
      @blur-bpm-input="model.handleDeckBpmInputBlur('bottom')"
      @tap-bpm="model.handleDeckBpmTap('bottom')"
      @memory-cue="void model.handleDeckMemoryCueCreate('bottom')"
      @select-whole-adjustment="model.handleDeckSelectWholeAdjustment('bottom')"
      @split-after-playhead="model.handleDeckSplitAfterPlayhead('bottom')"
      @delete-boundary="model.handleDeckDeleteBoundary('bottom')"
      @cycle-metronome-state="model.handleDeckMetronomeStateCycle('bottom')"
      @loop-step-down="model.handleDeckLoopStepDown('bottom')"
      @loop-step-up="model.handleDeckLoopStepUp('bottom')"
      @toggle-loop="model.handleDeckLoopToggle('bottom')"
      @toggle-master-tempo="model.handleDeckMasterTempoToggle('bottom')"
      @reset-tempo="model.resetDeckTempo('bottom')"
      @toggle-quantize="model.handleDeckQuantizeToggle('bottom')"
      @tempo-nudge-start="model.startDeckTempoNudge('bottom', $event)"
      @tempo-nudge-end="model.stopDeckTempoNudge('bottom', $event)"
      @select-move-target="
        (target, actionMode) => model.openDeckMoveDialog('bottom', target, actionMode)
      "
    />
    <HorizontalBrowseCuePanels
      v-model:top-mode="deckCuePanelMode.top"
      v-model:bottom-mode="deckCuePanelMode.bottom"
      :top-hot-cues="topDisplayHotCues"
      :bottom-hot-cues="bottomDisplayHotCues"
      :top-hot-cue-editable="
        model.isEditMode.value
          ? model.audioEdit.writable.value
          : !isRekordboxExternalPlaybackSource('', model.topDeckSong.value)
      "
      :bottom-hot-cue-editable="!isRekordboxExternalPlaybackSource('', model.bottomDeckSong.value)"
      :top-memory-cues="topDisplayMemoryCues"
      :bottom-memory-cues="bottomDisplayMemoryCues"
      :top-memory-cue-editable="!model.isEditMode.value || model.audioEdit.writable.value"
      @hotcue-press="void handleCuePanelHotCuePress($event)"
      @hotcue-delete="void handleCuePanelHotCueDelete($event)"
      @memorycue-press="void handleCuePanelMemoryCuePress($event)"
      @memorycue-delete="void handleCuePanelMemoryCueDelete($event)"
    />
  </div>
</template>

<style scoped lang="scss" src="./HorizontalBrowseModeShellWaveformStack.scss"></style>
