<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import MixtapeTrackEnvelopeCurve from './MixtapeTrackEnvelopeCurve.vue'
import type { MixtapeGainEnvelopeEditor } from '@renderer/composables/mixtape/useGainEnvelopeEditor'
import type { TimelineTrackLayout } from '@renderer/composables/mixtape/types'

const props = defineProps<{
  editor: MixtapeGainEnvelopeEditor
  item: TimelineTrackLayout
  curve: boolean
  segmentMode: boolean
}>()
const { t } = useI18n()
const dots = computed(() => props.editor.resolveActiveEnvelopePointDots(props.item))
const ghost = computed(() => props.editor.resolveActiveGhostPointDot(props.item))
const range = computed(() => props.editor.resolveEnvelopeRangeStyle(props.item))
const guide = computed(() =>
  props.editor.snapGuide.value?.trackId === props.item.track.id
    ? props.editor.snapGuide.value
    : null
)
const menu = computed(() =>
  props.editor.envelopeContextMenu.value?.trackId === props.item.track.id
    ? props.editor.envelopeContextMenu.value
    : null
)
const dbLabel = (db: number) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
</script>

<template>
  <div v-if="curve && !segmentMode" class="envelope-waveform-shade"></div>
  <MixtapeTrackEnvelopeCurve
    :visible="curve && !segmentMode"
    :polygon="editor.resolveActiveEnvelopePolygon(item)"
    :polyline="editor.resolveActiveEnvelopePolyline(item)"
    :hover-line="editor.resolveEnvelopeHoverLine(item)"
  />
  <div
    class="lane-track__envelope-points"
    :class="{ 'is-segment-mute-mode': segmentMode }"
    :style="{ cursor: segmentMode ? 'crosshair' : editor.resolveEnvelopeCursor(item) }"
    @pointerdown.stop.prevent="editor.handleEnvelopeStageMouseDown(item, $event)"
    @pointermove="editor.handleEnvelopeStageMouseMove(item, $event)"
    @pointerleave="editor.handleEnvelopeStageMouseLeave()"
    @dblclick.stop.prevent="editor.handleEnvelopeStageDoubleClick(item, $event)"
    @mousedown.stop
    @contextmenu.stop.prevent
  >
    <template v-if="curve && !segmentMode">
      <div v-if="range" class="envelope-range" :style="range"></div>
      <div v-if="guide" class="envelope-snap-guide" :style="{ left: `${guide.x}%` }"></div>
      <div
        v-if="ghost"
        class="lane-track__envelope-ghost-point"
        :style="{ left: `${ghost.x}%`, top: `${ghost.y}%` }"
      ></div>
      <div
        v-for="point in dots"
        :key="point.index"
        class="lane-track__envelope-point-wrap"
        :style="{ left: `${point.x}%`, top: `${point.y}%` }"
      >
        <button
          class="lane-track__envelope-point"
          type="button"
          :class="{
            'is-active': point.isActive,
            'is-selected': point.isSelected,
            'is-hovered': point.isHovered,
            'is-boundary': point.isBoundary
          }"
          :aria-label="`${point.sec.toFixed(3)} s, ${dbLabel(point.gainDb)}`"
          :aria-pressed="point.isSelected"
          @pointerdown.stop.prevent="editor.handleEnvelopePointMouseDown(item, point.index, $event)"
          @mousedown.stop.prevent
          @dblclick.stop.prevent
          @contextmenu.stop.prevent="
            editor.handleEnvelopePointContextMenu(item, point.index, $event)
          "
        ></button>
        <div
          v-if="point.isActive || point.isSelected || point.isHovered"
          class="lane-track__envelope-point-label"
          :class="{
            'is-above': point.y > 18,
            'is-below': point.y <= 18,
            'is-align-left': point.x < 8,
            'is-align-right': point.x > 92
          }"
        >
          {{ point.sec.toFixed(3) }} s · {{ dbLabel(point.gainDb) }}
        </div>
      </div>
      <div
        v-if="menu"
        class="envelope-point-menu"
        role="menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @pointerdown.stop
        @mousedown.stop
        @dblclick.stop
      >
        <button
          role="menuitem"
          type="button"
          :disabled="!editor.selectedEnvelopeValue.value?.removable"
          @click.stop="editor.deleteSelectedEnvelopePoint()"
        >
          {{ t('mixtape.envelopeDelete') }} <span>Delete</span>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.envelope-waveform-shade {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--waveform-bg) 30%, transparent);
  pointer-events: none;
  z-index: 1;
}
.lane-track__envelope-points {
  position: absolute;
  left: calc(-1 * var(--lane-track-border-width));
  width: calc(100% + var(--lane-track-border-width) * 2);
  top: 4px;
  bottom: 4px;
  height: calc(100% - 8px);
  z-index: 3;
  touch-action: none;
  user-select: none;
}
.lane-track__envelope-point-wrap {
  position: absolute;
  width: 0;
  height: 0;
  z-index: 5;
}
.lane-track__envelope-point {
  position: absolute;
  width: 8px;
  height: 8px;
  padding: 0;
  appearance: none;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  border: 1px solid var(--mixtape-point-border);
  background: var(--mixtape-point-bg);
  pointer-events: auto;
  cursor: grab;
  overflow: visible;
  opacity: 0;
}
.lane-track__envelope-points:hover .lane-track__envelope-point {
  opacity: 1;
}
.lane-track__envelope-point::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 24px;
  height: 24px;
  border-radius: 50%;
}
.lane-track__envelope-point.is-active {
  opacity: 1;
  cursor: grabbing;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 30%, transparent);
}
.lane-track__envelope-point.is-boundary {
  background: var(--mixtape-point-boundary-bg);
}
.lane-track__envelope-ghost-point {
  position: absolute;
  width: 8px;
  height: 8px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: var(--mixtape-point-ghost-bg);
  border: 1px solid var(--mixtape-point-ghost-border);
  pointer-events: none;
}
.lane-track__envelope-point-label {
  position: absolute;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--mixtape-point-label-bg);
  color: var(--mixtape-point-label-text);
  white-space: nowrap;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
}
.lane-track__envelope-point-label.is-above {
  bottom: 10px;
  transform: translateX(-50%);
}
.lane-track__envelope-point-label.is-below {
  top: 10px;
  transform: translateX(-50%);
}
.lane-track__envelope-point-label.is-align-left {
  left: 0;
  transform: none;
}
.lane-track__envelope-point-label.is-align-right {
  right: 0;
  transform: none;
}
.envelope-range {
  position: absolute;
  inset-block: 0;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-inline: 1px solid var(--accent);
  pointer-events: none;
}
.envelope-snap-guide {
  position: absolute;
  inset-block: 0;
  width: 0;
  border-left: 1px dashed var(--accent);
  pointer-events: none;
}
.lane-track__envelope-point.is-selected,
.lane-track__envelope-point.is-hovered {
  opacity: 1;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
}
.lane-track__envelope-point {
  transition: opacity 0.1s ease;
}
.lane-track__envelope-point-label {
  font-size: 11px;
  z-index: 6;
}
.envelope-point-menu {
  position: absolute;
  z-index: 10;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px;
}
.envelope-point-menu button {
  display: flex;
  gap: 18px;
  color: var(--text);
  background: transparent;
  border: 0;
  padding: 5px 8px;
  font-size: 12px;
}
.envelope-point-menu button:hover {
  background: var(--hover);
}
.envelope-point-menu button:disabled {
  opacity: 0.4;
}
.envelope-point-menu span {
  color: var(--text-secondary);
}
</style>
