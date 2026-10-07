<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'

const props = defineProps({
  disabled: {
    type: Boolean,
    default: false
  },
  bpmInputDisabled: {
    type: Boolean,
    default: undefined
  },
  gridControlsDisabled: {
    type: Boolean,
    default: false
  },
  showGridControls: {
    type: Boolean,
    default: true
  },
  showDownbeatLine: { type: Boolean, default: true },
  bpmInputValue: {
    type: String,
    default: ''
  },
  bpmStep: {
    type: Number,
    default: 0.01
  },
  bpmMin: {
    type: Number,
    default: 1
  },
  bpmMax: {
    type: Number,
    default: 300
  },
  bpmInputTitle: {
    type: String,
    default: ''
  },
  bpmInputFirst: {
    type: Boolean,
    default: false
  },
  tapBpmTitle: {
    type: String,
    default: ''
  },
  showTapButton: {
    type: Boolean,
    default: true
  },
  showMemoryButton: {
    type: Boolean,
    default: false
  },
  showSplitAfterPlayhead: {
    type: Boolean,
    default: false
  },
  gridAdjustScope: {
    type: String,
    default: 'whole'
  },
  showDeleteBoundary: {
    type: Boolean,
    default: false
  },
  showLargeShiftButtons: {
    type: Boolean,
    default: true
  }
})

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
}>()

type ShiftEventName =
  | 'shift-left-large'
  | 'shift-left-small'
  | 'shift-right-small'
  | 'shift-right-large'

const HOLD_START_DELAY_MS = 1000
const HOLD_REPEAT_INTERVAL_MS = 300
const BPM_DRAG_THRESHOLD_PX = 4
const BPM_DRAG_BPM_PER_SCREEN = 40

let holdStartTimer: ReturnType<typeof setTimeout> | null = null
let holdRepeatTimer: ReturnType<typeof setInterval> | null = null
let holdEventName: ShiftEventName | null = null
let suppressNextClickFor: ShiftEventName | null = null
let bpmDragPointerId: number | null = null
let bpmDragStartY = 0
let bpmDragStartValue = 0
let bpmDragActive = false
let bpmDragInputTarget: HTMLInputElement | null = null
let bpmDragLastEmittedValue = ''
let bodyUserSelectBeforeBpmDrag = ''
const controlsDisabled = computed(() => props.disabled || props.gridControlsDisabled)
const bpmInputDisabled = computed(() => props.bpmInputDisabled ?? controlsDisabled.value)

const clearShiftHoldTimers = () => {
  if (holdStartTimer) {
    clearTimeout(holdStartTimer)
    holdStartTimer = null
  }
  if (holdRepeatTimer) {
    clearInterval(holdRepeatTimer)
    holdRepeatTimer = null
  }
  holdEventName = null
}

const emitShift = (eventName: ShiftEventName) => {
  if (controlsDisabled.value) return
  if (eventName === 'shift-left-large') {
    emit('shift-left-large')
    return
  }
  if (eventName === 'shift-left-small') {
    emit('shift-left-small')
    return
  }
  if (eventName === 'shift-right-small') {
    emit('shift-right-small')
    return
  }
  emit('shift-right-large')
}

const handleShiftPointerDown = (eventName: ShiftEventName, event?: PointerEvent) => {
  if (controlsDisabled.value || (event && event.button !== 0)) return
  clearShiftHoldTimers()
  suppressNextClickFor = null
  holdEventName = eventName
  holdStartTimer = setTimeout(() => {
    if (!holdEventName || controlsDisabled.value) return
    suppressNextClickFor = holdEventName
    emitShift(holdEventName)
    holdRepeatTimer = setInterval(() => {
      if (!holdEventName || controlsDisabled.value) return
      emitShift(holdEventName)
    }, HOLD_REPEAT_INTERVAL_MS)
  }, HOLD_START_DELAY_MS)
}

const handleShiftPointerUp = (eventName: ShiftEventName) => {
  const shouldSuppressNextClick = holdRepeatTimer !== null && suppressNextClickFor === eventName
  clearShiftHoldTimers()
  suppressNextClickFor = shouldSuppressNextClick ? eventName : null
}

const handleShiftPointerCancel = () => {
  clearShiftHoldTimers()
  suppressNextClickFor = null
}

const handleShiftBlur = () => {
  clearShiftHoldTimers()
  suppressNextClickFor = null
}

const handleShiftLostPointerCapture = () => {
  clearShiftHoldTimers()
  suppressNextClickFor = null
}

const handleShiftClick = (eventName: ShiftEventName) => {
  if (controlsDisabled.value) return
  if (suppressNextClickFor === eventName) {
    suppressNextClickFor = null
    return
  }
  emitShift(eventName)
}

const handleBpmInput = (event: Event) => {
  if (bpmInputDisabled.value) return
  const target = event.target as HTMLInputElement | null
  emit('update-bpm-input', target?.value || '')
}

const handleBpmInputEnter = (event: KeyboardEvent) => {
  const target = event.target as HTMLInputElement | null
  target?.blur()
}

const resolveBpmStep = () => {
  const numeric = Number(props.bpmStep)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1
}

const resolveBpmStepDecimals = () => {
  const stepText = String(props.bpmStep ?? '')
  const decimalIndex = stepText.indexOf('.')
  return decimalIndex >= 0 ? Math.max(0, stepText.length - decimalIndex - 1) : 0
}

const snapDraggedBpmValue = (value: number) => {
  const step = resolveBpmStep()
  const snapped = Math.round(value / step) * step
  return Number(snapped.toFixed(resolveBpmStepDecimals()))
}

const formatDraggedBpmValue = (value: number) => value.toFixed(resolveBpmStepDecimals())

const clampDraggedBpmValue = (value: number) => {
  const min = Number(props.bpmMin)
  const max = Number(props.bpmMax)
  let next = value
  if (Number.isFinite(min)) {
    next = Math.max(min, next)
  }
  if (Number.isFinite(max)) {
    next = Math.min(max, next)
  }
  return next
}

const resolveBpmDragStartValue = (target: HTMLInputElement | null) => {
  const directValue = Number(target?.value)
  if (Number.isFinite(directValue)) {
    return clampDraggedBpmValue(directValue)
  }
  const propValue = Number(props.bpmInputValue)
  if (Number.isFinite(propValue)) {
    return clampDraggedBpmValue(propValue)
  }
  const min = Number(props.bpmMin)
  return Number.isFinite(min) ? min : 0
}

const resolveBpmDragScreenHeight = () => {
  if (typeof window === 'undefined') return 900
  const rawHeight = Number(window.screen?.availHeight || window.screen?.height || 0)
  return Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : 900
}

const clearBpmDrag = () => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointermove', handleWindowBpmDragMove)
    window.removeEventListener('pointerup', handleWindowBpmDragEnd)
    window.removeEventListener('pointercancel', handleWindowBpmDragEnd)
  }
  if (typeof document !== 'undefined') {
    document.body.style.userSelect = bodyUserSelectBeforeBpmDrag
  }
  if (
    bpmDragInputTarget &&
    bpmDragPointerId !== null &&
    bpmDragInputTarget.hasPointerCapture?.(bpmDragPointerId)
  ) {
    bpmDragInputTarget.releasePointerCapture?.(bpmDragPointerId)
  }
  bpmDragPointerId = null
  bpmDragInputTarget = null
  bpmDragActive = false
  bpmDragLastEmittedValue = ''
}

function handleWindowBpmDragMove(event: PointerEvent) {
  if (bpmDragPointerId === null || event.pointerId !== bpmDragPointerId || bpmInputDisabled.value)
    return
  const deltaY = bpmDragStartY - event.clientY
  if (!bpmDragActive && Math.abs(deltaY) >= BPM_DRAG_THRESHOLD_PX) {
    bpmDragActive = true
  }
  if (!bpmDragActive) return
  const bpmOffset = (deltaY / resolveBpmDragScreenHeight()) * BPM_DRAG_BPM_PER_SCREEN
  const nextValue = clampDraggedBpmValue(snapDraggedBpmValue(bpmDragStartValue + bpmOffset))
  const formatted = formatDraggedBpmValue(nextValue)
  if (formatted === bpmDragLastEmittedValue) return
  bpmDragLastEmittedValue = formatted
  emit('update-bpm-input', formatted)
  emit('live-bpm-input', formatted)
}

function handleWindowBpmDragEnd(event: PointerEvent) {
  if (bpmDragPointerId === null || event.pointerId !== bpmDragPointerId) return
  const target = bpmDragInputTarget
  const didDrag = bpmDragActive
  clearBpmDrag()
  if (didDrag) {
    emit('blur-bpm-input')
    return
  }
  target?.focus()
  target?.select()
}

const handleBpmPointerDown = (event: PointerEvent) => {
  if (bpmInputDisabled.value || event.button !== 0 || event.pointerType === 'touch') return
  const target = event.target as HTMLInputElement | null
  if (!target) return
  event.preventDefault()
  clearBpmDrag()
  bpmDragPointerId = event.pointerId
  bpmDragStartY = event.clientY
  bpmDragStartValue = resolveBpmDragStartValue(target)
  bpmDragActive = false
  bpmDragLastEmittedValue = ''
  bpmDragInputTarget = target
  bodyUserSelectBeforeBpmDrag =
    typeof document !== 'undefined' ? document.body.style.userSelect : ''
  if (typeof document !== 'undefined') {
    document.body.style.userSelect = 'none'
  }
  target.setPointerCapture?.(event.pointerId)
  window.addEventListener('pointermove', handleWindowBpmDragMove)
  window.addEventListener('pointerup', handleWindowBpmDragEnd)
  window.addEventListener('pointercancel', handleWindowBpmDragEnd)
}

onBeforeUnmount(() => {
  clearShiftHoldTimers()
  suppressNextClickFor = null
  clearBpmDrag()
})
</script>

<template>
  <div class="grid-adjust-toolbar" :class="{ 'grid-adjust-toolbar--bpm-first': bpmInputFirst }">
    <div
      v-if="showGridControls"
      class="grid-adjust-toolbar__group grid-adjust-toolbar__group--icons"
    >
      <bubbleBoxTrigger
        v-if="showLargeShiftButtons"
        wrapper-tag="span"
        tag="button"
        class="grid-adjust-icon-btn"
        type="button"
        :disabled="controlsDisabled"
        :title="t('mixtape.gridAdjustShiftLeftLarge')"
        :aria-label="t('mixtape.gridAdjustShiftLeftLarge')"
        @click="handleShiftClick('shift-left-large')"
        @pointerdown="handleShiftPointerDown('shift-left-large', $event)"
        @pointerup="handleShiftPointerUp('shift-left-large')"
        @pointercancel="handleShiftPointerCancel"
        @pointerleave="handleShiftPointerCancel"
        @blur="handleShiftBlur"
        @lostpointercapture="handleShiftLostPointerCapture"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M11.5 3.5 7.8 8l3.7 4.5"></path>
          <path d="M8.1 3.5 4.4 8l3.7 4.5"></path>
        </svg>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        wrapper-tag="span"
        tag="button"
        class="grid-adjust-icon-btn"
        type="button"
        :disabled="controlsDisabled"
        :title="t('mixtape.gridAdjustShiftLeftSmall')"
        :aria-label="t('mixtape.gridAdjustShiftLeftSmall')"
        @click="handleShiftClick('shift-left-small')"
        @pointerdown="handleShiftPointerDown('shift-left-small', $event)"
        @pointerup="handleShiftPointerUp('shift-left-small')"
        @pointercancel="handleShiftPointerCancel"
        @pointerleave="handleShiftPointerCancel"
        @blur="handleShiftBlur"
        @lostpointercapture="handleShiftLostPointerCapture"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M10.5 3.5 6 8l4.5 4.5"></path>
        </svg>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        wrapper-tag="span"
        tag="button"
        class="grid-adjust-icon-btn"
        type="button"
        :disabled="controlsDisabled"
        :title="t('mixtape.gridAdjustSetDownbeatLineAtPlayhead')"
        :aria-label="t('mixtape.gridAdjustSetDownbeatLineAtPlayhead')"
        v-if="props.showDownbeatLine"
        @click="emit('set-downbeat-line')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M3 2v12"></path>
          <path d="M8 1v14"></path>
          <path d="M13 2v12"></path>
        </svg>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        wrapper-tag="span"
        tag="button"
        class="grid-adjust-icon-btn"
        type="button"
        :disabled="controlsDisabled"
        :title="t('mixtape.gridAdjustShiftRightSmall')"
        :aria-label="t('mixtape.gridAdjustShiftRightSmall')"
        @click="handleShiftClick('shift-right-small')"
        @pointerdown="handleShiftPointerDown('shift-right-small', $event)"
        @pointerup="handleShiftPointerUp('shift-right-small')"
        @pointercancel="handleShiftPointerCancel"
        @pointerleave="handleShiftPointerCancel"
        @blur="handleShiftBlur"
        @lostpointercapture="handleShiftLostPointerCapture"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M5.5 3.5 10 8l-4.5 4.5"></path>
        </svg>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        v-if="showLargeShiftButtons"
        wrapper-tag="span"
        tag="button"
        class="grid-adjust-icon-btn"
        type="button"
        :disabled="controlsDisabled"
        :title="t('mixtape.gridAdjustShiftRightLarge')"
        :aria-label="t('mixtape.gridAdjustShiftRightLarge')"
        @click="handleShiftClick('shift-right-large')"
        @pointerdown="handleShiftPointerDown('shift-right-large', $event)"
        @pointerup="handleShiftPointerUp('shift-right-large')"
        @pointercancel="handleShiftPointerCancel"
        @pointerleave="handleShiftPointerCancel"
        @blur="handleShiftBlur"
        @lostpointercapture="handleShiftLostPointerCapture"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="m4.5 3.5 3.7 4.5-3.7 4.5"></path>
          <path d="m7.9 3.5 3.7 4.5-3.7 4.5"></path>
        </svg>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        v-if="showSplitAfterPlayhead"
        wrapper-tag="span"
        tag="button"
        class="grid-adjust-icon-btn grid-adjust-icon-btn--scope"
        :class="{ 'is-active': gridAdjustScope !== 'after' }"
        type="button"
        :disabled="disabled"
        :title="t('mixtape.gridAdjustWholeAdjustment')"
        :aria-label="t('mixtape.gridAdjustWholeAdjustment')"
        @click="emit('select-whole-adjustment')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M2.5 3.5v9"></path>
          <path d="M13.5 3.5v9"></path>
          <path d="M5.5 5v6"></path>
          <path d="M10.5 5v6"></path>
          <path d="M2.5 8h11"></path>
        </svg>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        v-if="showSplitAfterPlayhead"
        wrapper-tag="span"
        tag="button"
        class="grid-adjust-icon-btn grid-adjust-icon-btn--scope"
        :class="{ 'is-active': gridAdjustScope === 'after' }"
        type="button"
        :disabled="disabled"
        :title="t('mixtape.gridAdjustSplitAfterPlayhead')"
        :aria-label="t('mixtape.gridAdjustSplitAfterPlayhead')"
        @click="emit('split-after-playhead')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M5.5 2.5v11"></path>
          <path d="M8 5h4.5"></path>
          <path d="m10.5 3 2 2-2 2"></path>
          <path d="M8 11h4.5"></path>
        </svg>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        v-if="showDeleteBoundary"
        wrapper-tag="span"
        tag="button"
        class="grid-adjust-boundary-btn grid-adjust-boundary-btn--danger"
        type="button"
        :disabled="disabled"
        :title="t('mixtape.gridAdjustDeleteBoundary')"
        :aria-label="t('mixtape.gridAdjustDeleteBoundary')"
        @click="emit('delete-boundary')"
      >
        {{ t('mixtape.gridAdjustDeleteBoundaryShort') }}
      </bubbleBoxTrigger>
    </div>
    <bubbleBoxTrigger
      v-if="showMemoryButton"
      wrapper-tag="span"
      tag="button"
      class="grid-adjust-memory-btn"
      type="button"
      :disabled="disabled"
      title="Memory Cue"
      aria-label="Memory Cue"
      @click="emit('memory-cue')"
    >
      MEMORY
    </bubbleBoxTrigger>
    <div class="grid-adjust-toolbar__group grid-adjust-toolbar__group--input">
      <bubbleBoxTrigger
        wrapper-tag="span"
        tag="input"
        class="grid-adjust-bpm-input"
        type="number"
        inputmode="decimal"
        :step="bpmStep"
        :min="bpmMin"
        :max="bpmMax"
        :disabled="bpmInputDisabled"
        :value="bpmInputValue"
        :title="bpmInputTitle || t('mixtape.bpm')"
        :aria-label="bpmInputTitle || t('mixtape.bpm')"
        @pointerdown="handleBpmPointerDown"
        @input="handleBpmInput"
        @blur="emit('blur-bpm-input')"
        @keydown.enter.prevent="handleBpmInputEnter"
      />
    </div>
    <bubbleBoxTrigger
      v-if="showTapButton"
      wrapper-tag="span"
      wrapper-class="grid-adjust-toolbar__tap-anchor"
      tag="button"
      class="grid-adjust-tap-btn"
      type="button"
      :disabled="controlsDisabled"
      :title="tapBpmTitle || t('mixtape.gridAdjustTapBpm')"
      :aria-label="tapBpmTitle || t('mixtape.gridAdjustTapBpm')"
      @click="emit('tap-bpm')"
    >
      Tap
    </bubbleBoxTrigger>
  </div>
</template>

<style scoped lang="scss">
.grid-adjust-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.grid-adjust-toolbar__group {
  display: flex;
  align-items: center;
}

.grid-adjust-toolbar__group--icons {
  gap: 6px;
}

.grid-adjust-toolbar--bpm-first .grid-adjust-toolbar__group--input {
  order: -2;
}

.grid-adjust-toolbar--bpm-first .grid-adjust-toolbar__tap-anchor {
  order: -1;
}

.grid-adjust-icon-btn {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.grid-adjust-memory-btn {
  height: 22px;
  min-width: 58px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  line-height: 20px;
  box-sizing: border-box;
  cursor: pointer;
}

.grid-adjust-boundary-btn {
  height: 22px;
  min-width: 38px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 11px;
  line-height: 20px;
  box-sizing: border-box;
  cursor: pointer;
  white-space: nowrap;
}

.grid-adjust-icon-btn--scope.is-active {
  border-color: var(--accent);
  background: var(--hover);
  color: var(--accent);
}

.grid-adjust-boundary-btn--danger {
  color: var(--danger, #d96a6a);
  border-color: color-mix(in srgb, var(--danger, #d96a6a) 44%, var(--border));
}

.grid-adjust-icon-btn:focus,
.grid-adjust-tap-btn:focus {
  outline: none;
}

.grid-adjust-icon-btn:focus-visible,
.grid-adjust-tap-btn:focus-visible {
  outline: none;
  box-shadow: none;
}

.grid-adjust-icon-btn svg {
  width: 14px;
  height: 14px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.grid-adjust-icon-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.grid-adjust-memory-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.grid-adjust-boundary-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.grid-adjust-icon-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.grid-adjust-memory-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.grid-adjust-boundary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.grid-adjust-bpm-input {
  appearance: textfield;
  -moz-appearance: textfield;
  width: 50px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 11px;
  line-height: 20px;
  text-align: center;
}

.grid-adjust-bpm-input::-webkit-outer-spin-button,
.grid-adjust-bpm-input::-webkit-inner-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

.grid-adjust-bpm-input:not(:focus) {
  cursor: ns-resize;
}

.grid-adjust-bpm-input:focus {
  cursor: text;
}

.grid-adjust-bpm-input:focus {
  border-color: var(--accent);
  outline: none;
}

.grid-adjust-bpm-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.grid-adjust-tap-btn {
  height: 22px;
  min-width: 36px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 11px;
  line-height: 20px;
  cursor: pointer;
}

.grid-adjust-tap-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.grid-adjust-tap-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
