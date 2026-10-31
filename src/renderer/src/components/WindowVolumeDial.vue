<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { clampVolumeValue, formatVolumePercent } from '@renderer/utils/windowVolume'

const props = withDefaults(
  defineProps<{
    modelValue: number
    label: string
    size?: number
    step?: number
    disabled?: boolean
    shortcut?: string
  }>(),
  {
    size: 28,
    step: 0.05,
    disabled: false,
    shortcut: ''
  }
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: number): void
}>()

const DRAG_DISTANCE = 180
const dragStartX = ref(0)
const dragStartY = ref(0)
const dragStartValue = ref(0)
const dragging = ref(false)

const safeVolume = computed(() => clampVolumeValue(props.modelValue))
const volumePercent = computed(() => Math.round(safeVolume.value * 100))
const volumeLabel = computed(() => formatVolumePercent(safeVolume.value))
const dialTitle = computed(() => `${props.label} ${volumeLabel.value}`)
const dialStyle = computed(() => ({
  '--volume-dial-size': `${props.size}px`,
  '--volume-dial-progress': `${safeVolume.value * 360}deg`
}))

const emitVolume = (nextValue: number) => {
  if (props.disabled) return
  emit('update:modelValue', clampVolumeValue(nextValue))
}

const adjustByStep = (direction: 1 | -1, multiplier = 1) => {
  emitVolume(safeVolume.value + direction * props.step * multiplier)
}

const updateDragVolume = (clientX: number, clientY: number) => {
  const deltaX = clientX - dragStartX.value
  const deltaY = clientY - dragStartY.value
  const delta = (deltaX - deltaY) / DRAG_DISTANCE
  emitVolume(dragStartValue.value + delta)
}

const cleanupPointerTracking = () => {
  dragging.value = false
  window.removeEventListener('pointermove', handlePointerMove)
  window.removeEventListener('pointerup', handlePointerUp)
  window.removeEventListener('pointercancel', handlePointerUp)
}

const handlePointerDown = (event: PointerEvent) => {
  if (props.disabled || event.button !== 0) return
  event.preventDefault()
  dragStartX.value = event.clientX
  dragStartY.value = event.clientY
  dragStartValue.value = safeVolume.value
  dragging.value = true
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handlePointerUp)
}

const handlePointerMove = (event: PointerEvent) => {
  if (!dragging.value) return
  updateDragVolume(event.clientX, event.clientY)
}

const handlePointerUp = () => {
  cleanupPointerTracking()
}

const handleWheel = (event: WheelEvent) => {
  if (props.disabled) return
  event.preventDefault()
  const dominantDelta =
    Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
  if (!dominantDelta) return
  adjustByStep(dominantDelta < 0 ? 1 : -1)
}

const handleKeydown = (event: KeyboardEvent) => {
  if (props.disabled) return
  switch (event.key) {
    case 'ArrowUp':
    case 'ArrowRight':
      event.preventDefault()
      adjustByStep(1)
      return
    case 'ArrowDown':
    case 'ArrowLeft':
      event.preventDefault()
      adjustByStep(-1)
      return
    case 'PageUp':
      event.preventDefault()
      adjustByStep(1, 2)
      return
    case 'PageDown':
      event.preventDefault()
      adjustByStep(-1, 2)
      return
    case 'Home':
      event.preventDefault()
      emitVolume(0)
      return
    case 'End':
      event.preventDefault()
      emitVolume(1)
      return
  }
}

onUnmounted(() => {
  cleanupPointerTracking()
})
</script>

<template>
  <bubbleBoxTrigger
    wrapper-tag="span"
    tag="button"
    class="windowVolumeDial"
    :class="{ 'is-dragging': dragging, 'is-disabled': disabled }"
    type="button"
    role="slider"
    :aria-label="label"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="volumePercent"
    :aria-valuetext="volumeLabel"
    :title="dialTitle"
    :shortcut="props.shortcut"
    :style="dialStyle"
    :disabled="disabled"
    @pointerdown="handlePointerDown"
    @wheel="handleWheel"
    @keydown="handleKeydown"
  >
    <span class="windowVolumeDial__ring" aria-hidden="true"></span>
  </bubbleBoxTrigger>
</template>

<style scoped lang="scss">
.windowVolumeDial {
  --volume-dial-progress-color: color-mix(in srgb, var(--accent) 72%, var(--text) 28%);
  --volume-dial-track-color: color-mix(in srgb, var(--border) 90%, transparent);
  position: relative;
  width: var(--volume-dial-size);
  height: var(--volume-dial-size);
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  user-select: none;
  touch-action: none;
  box-sizing: border-box;
  transition:
    background-color 0.14s ease,
    border-color 0.14s ease,
    opacity 0.14s ease;
}

.windowVolumeDial::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
  opacity: 0;
  transition: opacity 0.14s ease;
}

.windowVolumeDial:hover,
.windowVolumeDial:focus-visible,
.windowVolumeDial.is-dragging {
  --volume-dial-track-color: color-mix(in srgb, var(--accent) 18%, var(--border) 82%);
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}

.windowVolumeDial:hover::after,
.windowVolumeDial:focus-visible::after,
.windowVolumeDial.is-dragging::after {
  opacity: 1;
}

.windowVolumeDial:focus-visible {
  outline: none;
}

.windowVolumeDial.is-dragging {
  cursor: grabbing;
}

.windowVolumeDial.is-disabled,
.windowVolumeDial:disabled {
  opacity: 0.46;
  cursor: not-allowed;
  background: transparent;
}

.windowVolumeDial__ring,
.windowVolumeDial__ring::before {
  position: absolute;
  border-radius: inherit;
  pointer-events: none;
}

.windowVolumeDial__ring {
  position: absolute;
  inset: 4px;
  border-radius: inherit;
  background: conic-gradient(
    from -90deg,
    var(--volume-dial-progress-color) 0deg,
    var(--volume-dial-progress-color) var(--volume-dial-progress),
    var(--volume-dial-track-color) var(--volume-dial-progress),
    var(--volume-dial-track-color) 360deg
  );
}

.windowVolumeDial__ring::before {
  content: '';
  inset: 3px;
  border-radius: inherit;
  background: var(--bg);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border) 74%, transparent);
}
</style>
