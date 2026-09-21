<template>
  <div ref="rootRef" class="color-picker">
    <button
      type="button"
      class="color-picker__trigger"
      :class="{ 'color-picker__trigger--active': active }"
      :aria-expanded="isOpen"
      @click="togglePanel"
    >
      <span class="color-picker__trigger-fill" :style="{ backgroundColor: normalizedValue }" />
    </button>
    <transition name="color-picker-fade">
      <div v-if="isOpen" class="color-picker__panel" @click.stop>
        <div
          ref="svRef"
          class="color-picker__sv"
          :style="{ backgroundColor: hueColor }"
          @pointerdown="onSvPointerDown"
        >
          <div class="color-picker__sv-white" />
          <div class="color-picker__sv-black" />
          <div class="color-picker__sv-cursor" :style="svCursorStyle" />
        </div>
        <div ref="hueRef" class="color-picker__hue" @pointerdown="onHuePointerDown">
          <div class="color-picker__hue-cursor" :style="{ left: `${(hsv.h / 360) * 100}%` }" />
        </div>
        <div class="color-picker__row">
          <span class="color-picker__preview" :style="{ backgroundColor: normalizedValue }" />
          <input
            class="color-picker__hex"
            :value="hexDraft"
            spellcheck="false"
            maxlength="7"
            @input="onHexInput"
            @focus="hexFocused = true"
            @blur="onHexBlur"
            @keydown.enter.prevent="commitHex"
            @keydown.esc.stop="closePanel"
          />
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { DEFAULT_ACCENT_COLOR, normalizeAccentColor } from '@renderer/utils/accentColor'

const props = defineProps({
  modelValue: {
    type: String,
    default: DEFAULT_ACCENT_COLOR
  },
  active: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'change', value: string): void
}>()

type Hsv = { h: number; s: number; v: number }

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

const hexToHsv = (hex: string): Hsv => {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max }
}

const hsvToHex = ({ h, s, v }: Hsv): string => {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const toHex = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

const rootRef = ref<HTMLElement | null>(null)
const svRef = ref<HTMLElement | null>(null)
const hueRef = ref<HTMLElement | null>(null)
const isOpen = ref(false)
const hexFocused = ref(false)
const svDragging = ref(false)
const hueDragging = ref(false)

const normalizedValue = computed(
  () => normalizeAccentColor(props.modelValue) || DEFAULT_ACCENT_COLOR
)

const hsv = reactive<Hsv>(hexToHsv(normalizedValue.value))
const hexDraft = ref(normalizedValue.value)

watch(normalizedValue, (color) => {
  if (svDragging.value || hueDragging.value) return
  const next = hexToHsv(color)
  hsv.h = next.h
  hsv.s = next.s
  hsv.v = next.v
  if (!hexFocused.value) {
    hexDraft.value = color
  }
})

const hueColor = computed(() => hsvToHex({ h: hsv.h, s: 1, v: 1 }))

const svCursorStyle = computed(() => ({
  left: `${hsv.s * 100}%`,
  top: `${(1 - hsv.v) * 100}%`
}))

const emitColor = (commit: boolean) => {
  const hex = hsvToHex(hsv)
  hexDraft.value = hex
  emit('update:modelValue', hex)
  if (commit) {
    emit('change', hex)
  }
}

const bindDrag = (
  targetRef: typeof svRef,
  draggingRef: typeof svDragging,
  update: (event: PointerEvent) => void,
  event: PointerEvent
) => {
  event.preventDefault()
  targetRef.value?.setPointerCapture(event.pointerId)
  draggingRef.value = true
  update(event)
  const onMove = (moveEvent: PointerEvent) => update(moveEvent)
  const onUp = () => {
    draggingRef.value = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    emitColor(true)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

const onSvPointerDown = (event: PointerEvent) => {
  bindDrag(
    svRef,
    svDragging,
    (moveEvent) => {
      const rect = svRef.value?.getBoundingClientRect()
      if (!rect || rect.width === 0 || rect.height === 0) return
      hsv.s = clamp01((moveEvent.clientX - rect.left) / rect.width)
      hsv.v = 1 - clamp01((moveEvent.clientY - rect.top) / rect.height)
      emitColor(false)
    },
    event
  )
}

const onHuePointerDown = (event: PointerEvent) => {
  bindDrag(
    hueRef,
    hueDragging,
    (moveEvent) => {
      const rect = hueRef.value?.getBoundingClientRect()
      if (!rect || rect.width === 0) return
      hsv.h = clamp01((moveEvent.clientX - rect.left) / rect.width) * 360
      emitColor(false)
    },
    event
  )
}

const onHexInput = (event: Event) => {
  const raw = (event.target as HTMLInputElement).value.trim()
  hexDraft.value = raw
  const color = normalizeAccentColor(raw.startsWith('#') ? raw : `#${raw}`)
  if (!color) return
  const next = hexToHsv(color)
  hsv.h = next.h
  hsv.s = next.s
  hsv.v = next.v
  emit('update:modelValue', color)
}

const commitHex = () => {
  const raw = hexDraft.value.trim()
  const color = normalizeAccentColor(raw.startsWith('#') ? raw : `#${raw}`)
  if (color) {
    const next = hexToHsv(color)
    hsv.h = next.h
    hsv.s = next.s
    hsv.v = next.v
    hexDraft.value = color
    emit('update:modelValue', color)
    emit('change', color)
  } else {
    hexDraft.value = normalizedValue.value
  }
}

const onHexBlur = () => {
  hexFocused.value = false
  commitHex()
}

const openPanel = () => {
  const next = hexToHsv(normalizedValue.value)
  hsv.h = next.h
  hsv.s = next.s
  hsv.v = next.v
  hexDraft.value = normalizedValue.value
  isOpen.value = true
}

const closePanel = () => {
  if (!isOpen.value) return
  isOpen.value = false
}

const togglePanel = () => {
  if (isOpen.value) {
    closePanel()
  } else {
    openPanel()
  }
}

const handleClickOutside = (event: MouseEvent) => {
  if (!isOpen.value || !rootRef.value) return
  const target = event.target as Node | null
  if (target && rootRef.value.contains(target)) return
  closePanel()
}

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    closePanel()
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped lang="scss">
.color-picker {
  position: relative;
  display: inline-flex;
}

.color-picker__trigger {
  position: relative;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  padding: 0;
  background: conic-gradient(
    #dc2626,
    #ea580c,
    #ca8a04,
    #16a34a,
    #0d9488,
    #0078d4,
    #7c3aed,
    #c026d3,
    #dc2626
  );
  cursor: pointer;
}

.color-picker__trigger--active {
  border-color: var(--text);
}

.color-picker__trigger-fill {
  position: absolute;
  inset: 3px;
  border-radius: 50%;
}

.color-picker__panel {
  position: absolute;
  left: 50%;
  top: calc(100% + 8px);
  transform: translateX(-50%);
  z-index: 30;
  width: 216px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background-color: var(--bg-elev);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.color-picker__sv {
  position: relative;
  height: 128px;
  border-radius: 6px;
  overflow: hidden;
  cursor: crosshair;
  touch-action: none;
}

.color-picker__sv-white,
.color-picker__sv-black {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.color-picker__sv-white {
  background: linear-gradient(to right, #ffffff, transparent);
}

.color-picker__sv-black {
  background: linear-gradient(to top, #000000, transparent);
}

.color-picker__sv-cursor {
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid #ffffff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.color-picker__hue {
  position: relative;
  height: 10px;
  border-radius: 5px;
  background: linear-gradient(
    to right,
    #ff0000,
    #ffff00,
    #00ff00,
    #00ffff,
    #0000ff,
    #ff00ff,
    #ff0000
  );
  cursor: pointer;
  touch-action: none;
}

.color-picker__hue-cursor {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid #ffffff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.color-picker__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.color-picker__preview {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid var(--border);
  flex: none;
}

.color-picker__hex {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background-color: var(--bg, #1b1b1b);
  color: var(--text);
  font-size: 13px;
  font-family: Consolas, 'Courier New', monospace;
  outline: none;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;

  &:hover {
    border-color: var(--accent);
  }

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
}

.color-picker-fade-enter-active,
.color-picker-fade-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}

.color-picker-fade-enter-from,
.color-picker-fade-leave-to {
  opacity: 0;
}

.color-picker-fade-enter-from .color-picker__panel,
.color-picker-fade-leave-to .color-picker__panel {
  transform: translateX(-50%) translateY(-4px);
}
</style>
