<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { KEY_FILTER_OPTIONS } from '@shared/keyDisplay'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

const props = defineProps<{ selected: string[]; styleName: 'Classic' | 'Camelot' }>()
const emit = defineEmits<{
  (e: 'confirm', keys: string[]): void
  (e: 'clear'): void
  (e: 'cancel'): void
}>()
const selected = ref(new Set(props.selected))
const uuid = uuidV4()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const wheelCenter = 250
function point(radius: number, angle: number) {
  const radians = (angle * Math.PI) / 180
  return {
    x: wheelCenter + radius * Math.sin(radians),
    y: wheelCenter - radius * Math.cos(radians)
  }
}
function sectorPath(number: number, inner: number, outer: number) {
  const start = (number - 1) * 30 - 15
  const end = start + 30
  const a = point(outer, start)
  const b = point(outer, end)
  const c = point(inner, end)
  const d = point(inner, start)
  return `M ${a.x} ${a.y} A ${outer} ${outer} 0 0 1 ${b.x} ${b.y} L ${c.x} ${c.y} A ${inner} ${inner} 0 0 0 ${d.x} ${d.y} Z`
}
function optionGeometry(camelot: string) {
  const number = Number.parseInt(camelot)
  const minor = camelot.endsWith('A')
  return {
    path: sectorPath(number, minor ? 103 : 167, minor ? 164 : 228),
    label: point(minor ? 133.5 : 197.5, (number - 1) * 30)
  }
}
function toggle(key: string) {
  const next = new Set(selected.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selected.value = next
}
function close(action: () => void) {
  closeWithAnimation(action)
}
onMounted(() => {
  utils.setHotkeysScpoe(uuid)
  hotkeys('E,Enter', uuid, () => {
    close(() => emit('confirm', [...selected.value]))
    return false
  })
  hotkeys('Q', uuid, () => {
    close(() => emit('clear'))
    return false
  })
  hotkeys('Esc', uuid, () => {
    close(() => emit('cancel'))
    return false
  })
})
onUnmounted(() => utils.delHotkeysScope(uuid))
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      v-dialog-drag="'.dialog-title'"
      class="inner key-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t('filters.filterByKey')"
    >
      <div class="dialog-title dialog-header">{{ t('filters.filterByKey') }}</div>
      <div class="wheel-hint">{{ t('filters.keyWheelHint') }}</div>
      <div class="wheel-wrap">
        <svg class="key-wheel" viewBox="0 0 500 500" :aria-label="t('filters.filterByKey')">
          <g
            v-for="option in KEY_FILTER_OPTIONS"
            :key="option.camelot"
            class="key-sector"
            :class="{ selected: selected.has(option.camelot) }"
            role="button"
            tabindex="0"
            :aria-label="`${option.camelot} ${option.classic}`"
            :aria-pressed="selected.has(option.camelot)"
            @click="toggle(option.camelot)"
            @keydown.enter.stop.prevent="toggle(option.camelot)"
            @keydown.space.stop.prevent="toggle(option.camelot)"
          >
            <path :d="optionGeometry(option.camelot).path" />
            <text
              :x="optionGeometry(option.camelot).label.x"
              :y="optionGeometry(option.camelot).label.y - 3"
              class="key-label"
            >
              {{ styleName === 'Camelot' ? option.camelot : option.classic }}
            </text>
            <text
              :x="optionGeometry(option.camelot).label.x"
              :y="optionGeometry(option.camelot).label.y + 14"
              class="key-secondary"
            >
              {{ styleName === 'Camelot' ? option.classic : option.camelot }}
            </text>
          </g>
          <circle class="wheel-center" cx="250" cy="250" r="96" />
          <text class="center-label" x="250" y="243">{{ t('filters.selectedKeys') }}</text>
          <text class="center-count" x="250" y="275">{{ selected.size }}</text>
        </svg>
      </div>
      <div class="dialog-footer key-actions">
        <button type="button" class="button" @click="close(() => emit('confirm', [...selected]))">
          {{ t('common.confirm') }} (E)
        </button>
        <button type="button" class="button" @click="close(() => emit('clear'))">
          {{ t('filters.clearThisColumn') }} (Q)
        </button>
        <button type="button" class="button" @click="close(() => emit('cancel'))">
          {{ t('common.cancel') }} (Esc)
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.key-dialog {
  width: min(520px, 94vw);
  color: var(--text);
  display: flex;
  flex-direction: column;
}
.wheel-hint {
  padding: 16px 20px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-weak);
}
.wheel-wrap {
  display: flex;
  justify-content: center;
  padding: 4px 16px 12px;
}
.key-wheel {
  display: block;
  width: min(100%, 430px, max(180px, 100vh - 220px));
  height: auto;
  overflow: visible;
}
.key-sector {
  cursor: pointer;
  outline: none;
}
.key-sector path {
  fill: var(--hover);
  stroke: var(--bg-elev);
  stroke-width: 2;
  transition: fill 120ms ease;
}
.key-sector:nth-child(even) path {
  fill: color-mix(in srgb, var(--hover) 65%, var(--bg));
}
.key-sector:hover path,
.key-sector:focus-visible path {
  fill: color-mix(in srgb, var(--accent) 28%, var(--hover));
}
.key-sector.selected path {
  fill: color-mix(in srgb, var(--accent) 42%, var(--hover));
  stroke: var(--accent);
  stroke-width: 2.5;
}
.key-sector text,
.wheel-center,
.center-label,
.center-count {
  pointer-events: none;
}
.key-sector text,
.center-label,
.center-count {
  fill: var(--text);
  text-anchor: middle;
}
.key-label {
  font-size: 17px;
  font-weight: 600;
}
.key-secondary {
  font-size: 11px;
  opacity: 0.7;
}
.wheel-center {
  fill: var(--bg);
  stroke: var(--border);
  stroke-width: 1;
}
.center-label {
  font-size: 13px;
  opacity: 0.75;
}
.center-count {
  font-size: 28px;
  font-weight: 600;
}
.key-actions {
  gap: 10px;
  padding: 10px 20px 18px;
}
.key-actions button {
  box-sizing: content-box;
  width: 90px;
  border: 0;
  color: inherit;
  font-family: inherit;
  cursor: pointer;
}
.key-actions button:nth-child(2) {
  width: 120px;
}
.key-actions button:hover {
  color: #fff;
}
.key-actions button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
