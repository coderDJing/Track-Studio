<script setup lang="ts">
import BeatGridMetronomeControls from '@renderer/components/BeatGridMetronomeControls.vue'
import MixtapeBeatAlignGridAdjustToolbar from '@renderer/components/mixtapeBeatAlignGridAdjustToolbar.vue'
import HorizontalBrowseDeckMoveButton from '@renderer/components/HorizontalBrowseDeckMoveButton.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'
import type { HorizontalBrowseDeckMoveTargetLibrary } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckMove'
import type { LibraryTransferActionMode } from '@renderer/utils/libraryTransfer'
import type { HorizontalBrowseTempoNudgeDirection } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckTempoNudge'

const props = defineProps<{
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
  gridControlsDisabled?: boolean
  showSplitAfterPlayhead?: boolean
  showDeleteBoundary?: boolean
  gridAdjustScope?: 'whole' | 'after'
  loopBeatLabel: string
  loopActive: boolean
  loopDisabled: boolean
  songPresent: boolean
  readOnlySource: boolean
  quantizeEnabled: boolean
  masterTempoEnabled: boolean
  showMetronome: boolean
  metronomeEnabled: boolean
  metronomeVolumeLevel: 1 | 2 | 3
  canToggleMetronome: boolean
  tempoNudgeActiveDirection?: HorizontalBrowseTempoNudgeDirection | null
  showTempoNudge?: boolean
  showLargeShiftButtons?: boolean
  hideTransportActions?: boolean
  showQuantizeAction?: boolean
}>()

const emit = defineEmits<{
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

const captureTempoNudgePointer = (event: PointerEvent) => {
  const target = event.currentTarget as HTMLElement | null
  target?.setPointerCapture?.(event.pointerId)
}

const releaseTempoNudgePointer = (event: PointerEvent) => {
  const target = event.currentTarget as HTMLElement | null
  if (target?.hasPointerCapture?.(event.pointerId)) {
    target.releasePointerCapture?.(event.pointerId)
  }
}

const handleTempoNudgePointerDown = (
  direction: HorizontalBrowseTempoNudgeDirection,
  event: PointerEvent
) => {
  if (!props.songPresent || event.button !== 0) return
  captureTempoNudgePointer(event)
  emit('tempo-nudge-start', direction)
}

const handleTempoNudgePointerEnd = (
  direction: HorizontalBrowseTempoNudgeDirection,
  event: PointerEvent
) => {
  releaseTempoNudgePointer(event)
  emit('tempo-nudge-end', direction)
}

const handleTempoNudgeKeyDown = (
  direction: HorizontalBrowseTempoNudgeDirection,
  event: KeyboardEvent
) => {
  if (!props.songPresent || event.repeat) return
  emit('tempo-nudge-start', direction)
}

const handleTempoNudgeKeyUp = (direction: HorizontalBrowseTempoNudgeDirection) => {
  emit('tempo-nudge-end', direction)
}
</script>

<template>
  <div class="overview__toolbar-row">
    <div class="overview__toolbar-main">
      <slot name="leading" />
      <slot name="tools">
        <MixtapeBeatAlignGridAdjustToolbar
          :disabled="props.disabled"
          :bpm-input-disabled="props.bpmInputDisabled"
          :grid-controls-disabled="props.gridControlsDisabled"
          :show-grid-controls="props.showGridControls"
          :bpm-input-value="props.bpmInputValue"
          :bpm-step="props.bpmStep"
          :bpm-min="props.bpmMin"
          :bpm-max="props.bpmMax"
          :bpm-input-title="props.bpmInputTitle"
          :bpm-input-first="props.bpmInputFirst"
          :show-tap-button="props.showTapButton === true"
          :tap-bpm-title="props.tapBpmTitle"
          :show-memory-button="props.showGridControls"
          :show-split-after-playhead="props.showSplitAfterPlayhead"
          :show-delete-boundary="props.showDeleteBoundary"
          :grid-adjust-scope="props.gridAdjustScope"
          :show-large-shift-buttons="props.showLargeShiftButtons"
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
        />
        <div class="overview__toolbar-group overview__loop-control">
          <bubbleBoxTrigger
            wrapper-tag="span"
            tag="button"
            type="button"
            class="overview__loop-arrow"
            :disabled="props.loopDisabled"
            :title="t('horizontalBrowse.loopShorten')"
            :aria-label="t('horizontalBrowse.loopShorten')"
            @click="emit('loop-step-down')"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M10.5 3.5 6 8l4.5 4.5"></path>
            </svg>
          </bubbleBoxTrigger>
          <bubbleBoxTrigger
            wrapper-tag="span"
            tag="button"
            type="button"
            class="overview__loop-value"
            :class="{ 'is-active': props.loopActive }"
            :disabled="props.loopDisabled"
            title="Toggle Loop"
            aria-label="Toggle Loop"
            @click="emit('toggle-loop')"
          >
            {{ props.loopBeatLabel }}
          </bubbleBoxTrigger>
          <bubbleBoxTrigger
            wrapper-tag="span"
            tag="button"
            type="button"
            class="overview__loop-arrow"
            :disabled="props.loopDisabled"
            :title="t('horizontalBrowse.loopLengthen')"
            :aria-label="t('horizontalBrowse.loopLengthen')"
            @click="emit('loop-step-up')"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M5.5 3.5 10 8l-4.5 4.5"></path>
            </svg>
          </bubbleBoxTrigger>
        </div>
        <div v-if="props.showMetronome" class="overview__toolbar-group">
          <BeatGridMetronomeControls
            :metronome-enabled="props.metronomeEnabled"
            :metronome-volume-level="props.metronomeVolumeLevel"
            :can-toggle-metronome="props.canToggleMetronome"
            @cycle-metronome-state="emit('cycle-metronome-state')"
          />
        </div>
        <div
          v-if="props.showTempoNudge !== false"
          class="overview__toolbar-group overview__tempo-nudge-control"
          role="group"
          :aria-label="t('horizontalBrowse.tempoNudgeGroup')"
        >
          <bubbleBoxTrigger
            wrapper-tag="span"
            tag="button"
            type="button"
            class="overview__tempo-nudge-btn"
            :class="{ 'is-active': props.tempoNudgeActiveDirection === 'fast' }"
            :disabled="!props.songPresent"
            :title="t('horizontalBrowse.tempoNudgeFaster')"
            :aria-label="t('horizontalBrowse.tempoNudgeFaster')"
            @pointerdown="handleTempoNudgePointerDown('fast', $event)"
            @pointerup="handleTempoNudgePointerEnd('fast', $event)"
            @pointercancel="handleTempoNudgePointerEnd('fast', $event)"
            @lostpointercapture="emit('tempo-nudge-end', 'fast')"
            @blur="emit('tempo-nudge-end', 'fast')"
            @keydown.space.prevent="handleTempoNudgeKeyDown('fast', $event)"
            @keyup.space.prevent="handleTempoNudgeKeyUp('fast')"
            @keydown.enter.prevent="handleTempoNudgeKeyDown('fast', $event)"
            @keyup.enter.prevent="handleTempoNudgeKeyUp('fast')"
          >
            <svg viewBox="0 0 18 16" aria-hidden="true" focusable="false">
              <path d="M14.5 8H3.5l4.8-4.5"></path>
            </svg>
          </bubbleBoxTrigger>
          <bubbleBoxTrigger
            wrapper-tag="span"
            tag="button"
            type="button"
            class="overview__tempo-nudge-btn"
            :class="{ 'is-active': props.tempoNudgeActiveDirection === 'slow' }"
            :disabled="!props.songPresent"
            :title="t('horizontalBrowse.tempoNudgeSlower')"
            :aria-label="t('horizontalBrowse.tempoNudgeSlower')"
            @pointerdown="handleTempoNudgePointerDown('slow', $event)"
            @pointerup="handleTempoNudgePointerEnd('slow', $event)"
            @pointercancel="handleTempoNudgePointerEnd('slow', $event)"
            @lostpointercapture="emit('tempo-nudge-end', 'slow')"
            @blur="emit('tempo-nudge-end', 'slow')"
            @keydown.space.prevent="handleTempoNudgeKeyDown('slow', $event)"
            @keyup.space.prevent="handleTempoNudgeKeyUp('slow')"
            @keydown.enter.prevent="handleTempoNudgeKeyDown('slow', $event)"
            @keyup.enter.prevent="handleTempoNudgeKeyUp('slow')"
          >
            <svg viewBox="0 0 18 16" aria-hidden="true" focusable="false">
              <path d="M3.5 8h11l-4.8-4.5"></path>
            </svg>
          </bubbleBoxTrigger>
        </div>
      </slot>
    </div>
    <div
      v-if="!props.hideTransportActions || props.showQuantizeAction"
      class="overview__toolbar-actions"
    >
      <template v-if="!props.hideTransportActions">
        <div class="overview__toolbar-group overview__toolbar-group--actions">
          <bubbleBoxTrigger
            wrapper-tag="span"
            tag="button"
            type="button"
            class="overview__transport-btn"
            :class="{ 'is-active': props.masterTempoEnabled }"
            :disabled="!props.songPresent"
            title="Master Tempo"
            @click="emit('toggle-master-tempo')"
          >
            MT
          </bubbleBoxTrigger>
          <bubbleBoxTrigger
            wrapper-tag="span"
            tag="button"
            type="button"
            class="overview__transport-btn"
            :disabled="!props.songPresent"
            title="Reset Tempo"
            @click="emit('reset-tempo')"
          >
            RES
          </bubbleBoxTrigger>
        </div>
        <div class="overview__toolbar-group">
          <bubbleBoxTrigger
            wrapper-tag="span"
            tag="button"
            type="button"
            class="overview__transport-btn"
            :class="{ 'is-active': props.quantizeEnabled }"
            :disabled="!props.songPresent"
            title="Quantize"
            aria-label="Quantize"
            @click="emit('toggle-quantize')"
          >
            Q
          </bubbleBoxTrigger>
        </div>
        <div class="overview__toolbar-group">
          <HorizontalBrowseDeckMoveButton
            :disabled="!props.songPresent"
            :read-only-source="props.readOnlySource"
            @select-target="(target, actionMode) => emit('select-move-target', target, actionMode)"
          />
        </div>
      </template>
      <div v-if="props.showQuantizeAction" class="overview__toolbar-group">
        <bubbleBoxTrigger
          wrapper-tag="span"
          tag="button"
          type="button"
          class="overview__transport-btn"
          :class="{ 'is-active': props.quantizeEnabled }"
          :disabled="!props.songPresent"
          title="Quantize"
          aria-label="Quantize"
          @click="emit('toggle-quantize')"
        >
          Q
        </bubbleBoxTrigger>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.overview__toolbar-row {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  min-width: 0;
  width: 100%;
  height: 100%;
  padding: 0 8px;
  box-sizing: border-box;
}

.overview__toolbar-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.overview__toolbar-main :deep(.grid-adjust-bpm-input) {
  width: 44px;
}

.overview__toolbar-group {
  display: inline-flex;
  align-items: center;
}

.overview__toolbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}

.overview__toolbar-group--actions {
  gap: 6px;
}

.overview__tempo-nudge-control {
  gap: 4px;
}

.overview__tempo-nudge-btn {
  width: 28px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: default;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease,
    color 0.14s ease,
    box-shadow 0.14s ease;
}

.overview__tempo-nudge-btn:focus {
  outline: none;
}

.overview__tempo-nudge-btn:focus-visible {
  outline: none;
  box-shadow: none;
}

.overview__tempo-nudge-btn svg {
  width: 16px;
  height: 14px;
  display: block;
  transform: translateY(2px);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.overview__tempo-nudge-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.overview__tempo-nudge-btn.is-active {
  color: var(--shell-active-control-text, #ffffff);
  border-color: var(--shell-active-control-border, var(--accent));
  background: var(--shell-active-control-bg, var(--accent));
  box-shadow:
    0 0 0 1px var(--shell-active-control-outline, transparent),
    inset 0 1px 0 var(--shell-active-control-inset, transparent);
}

.overview__tempo-nudge-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.overview__loop-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.overview__loop-arrow,
.overview__loop-value {
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  box-sizing: border-box;
  cursor: pointer;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease,
    color 0.14s ease,
    box-shadow 0.14s ease;
}

.overview__loop-arrow {
  width: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.overview__loop-arrow svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.overview__loop-value {
  min-width: 44px;
  padding: 0 9px;
  font-size: 11px;
  line-height: 20px;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.overview__loop-arrow:hover:not(:disabled),
.overview__loop-value:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.overview__loop-value.is-active {
  color: var(--shell-cue-accent, #d98921);
  border-color: color-mix(in srgb, var(--shell-cue-accent, #d98921) 72%, var(--border));
  background: color-mix(in srgb, var(--shell-cue-accent, #d98921) 12%, var(--bg-elev));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--shell-cue-accent, #d98921) 22%, transparent);
}

.overview__loop-arrow:disabled,
.overview__loop-value:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.overview__transport-btn {
  height: 22px;
  min-width: 34px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  line-height: 20px;
  letter-spacing: 0;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease,
    color 0.14s ease,
    box-shadow 0.14s ease;
}

.overview__transport-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.overview__transport-btn.is-active {
  color: var(--shell-active-control-text, #ffffff);
  border-color: var(--shell-active-control-border, var(--accent));
  background: var(--shell-active-control-bg, var(--accent));
  box-shadow:
    0 0 0 1px var(--shell-active-control-outline, transparent),
    inset 0 1px 0 var(--shell-active-control-inset, transparent);
}

.overview__transport-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
