<script setup lang="ts">
import { ref, type CSSProperties } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import type { TimelineTrackLayout } from '@renderer/composables/mixtape/types'
import type { TrackLoopOverlayViewModel } from '@renderer/composables/mixtape/useMixtapeTrackLoopEditor'

const props = defineProps<{
  item: TimelineTrackLayout
  overlay: TrackLoopOverlayViewModel | null
  loopEditMode: boolean
  handleTrackLoopGridLineClick: (
    item: TimelineTrackLayout,
    baseSec: number,
    displaySec: number,
    disabled: boolean
  ) => void
  handleTrackLoopSelectLoop: (item: TimelineTrackLayout, event: MouseEvent) => void
  handleTrackLoopRepeatStep: (item: TimelineTrackLayout, step: -1 | 1) => void
  handleTrackLoopRemove: (trackId: string, loopKey?: string) => void
}>()

const hoveredGridKey = ref('')

const resolveGridTone = (level: 'downbeat' | 'beat') => {
  if (level === 'downbeat') return 'var(--mixtape-loop-grid-beat)'
  return 'color-mix(in srgb, var(--mixtape-loop-grid-beat) 70%, transparent)'
}

const resolveGridLineStyle = (
  line: TrackLoopOverlayViewModel['gridLines'][number]
): CSSProperties[] => {
  const hovered = !line.disabled && hoveredGridKey.value === line.key
  return [
    line.style,
    {
      position: 'absolute',
      top: '6%',
      bottom: '6%',
      width: '14px',
      transform: 'translateX(-50%)',
      background: line.disabled
        ? 'transparent'
        : hovered || line.active
          ? 'var(--mixtape-loop-grid-hover-bg)'
          : 'transparent',
      color: resolveGridTone(line.level),
      pointerEvents: 'auto',
      cursor: 'default',
      zIndex: 10,
      opacity: line.disabled ? 0.28 : 0.92,
      boxShadow:
        hovered || line.active ? 'inset 0 0 0 1px var(--mixtape-loop-grid-hover-border)' : undefined
    }
  ]
}

const resolveGridRailStyle = (
  line: TrackLoopOverlayViewModel['gridLines'][number]
): CSSProperties => {
  const hovered = !line.disabled && hoveredGridKey.value === line.key
  return {
    position: 'absolute',
    top: '4px',
    bottom: '4px',
    left: '50%',
    width: hovered || line.active ? '2px' : '1px',
    transform: 'translateX(-50%)',
    borderRadius: '999px',
    background: 'currentColor',
    opacity: hovered || line.active ? 0.96 : 0.62,
    boxShadow: hovered || line.active ? '0 0 12px var(--mixtape-loop-grid-hover-glow)' : 'none',
    pointerEvents: 'none'
  }
}

const resolveGridHoverLabelStyle = (
  line: TrackLoopOverlayViewModel['gridLines'][number]
): CSSProperties => {
  const hovered = !line.disabled && hoveredGridKey.value === line.key
  return {
    position: 'absolute',
    left: '50%',
    top: '4px',
    transform: hovered
      ? 'translate(-50%, calc(-100% - 6px))'
      : 'translate(-50%, calc(-100% - 2px))',
    padding: '4px 8px',
    borderRadius: '999px',
    border: '1px solid var(--mixtape-loop-label-border)',
    background: 'var(--mixtape-loop-label-bg)',
    color: 'var(--mixtape-loop-label-text)',
    backdropFilter: 'blur(8px)',
    fontSize: '9px',
    fontWeight: '600',
    letterSpacing: '0.04em',
    lineHeight: '1',
    whiteSpace: 'nowrap',
    opacity: hovered ? 1 : 0,
    pointerEvents: 'none',
    boxShadow: '0 8px 18px rgba(0, 0, 0, 0.2)'
  }
}

const resolveLoopBlockStyle = (
  block: TrackLoopOverlayViewModel['blocks'][number],
  selectedLoopKey: string | null
): CSSProperties[] => [
  block.style,
  {
    position: 'absolute',
    top: '4px',
    bottom: '4px',
    borderRadius: '0',
    overflow: 'hidden',
    pointerEvents: 'auto',
    zIndex: 9,
    background:
      block.kind === 'source'
        ? 'rgba(255, 214, 102, 0.18)'
        : 'repeating-linear-gradient(-58deg, rgba(255, 218, 92, 0.18) 0, rgba(255, 218, 92, 0.18) 4px, rgba(255, 218, 92, 0.07) 4px, rgba(255, 218, 92, 0.07) 8px)',
    opacity: selectedLoopKey ? (block.selected ? 1 : 0.72) : 1,
    boxShadow: block.selected
      ? 'inset 0 0 0 1px rgba(255, 236, 164, 0.3), inset 0 0 0 999px rgba(255, 223, 120, 0.04)'
      : undefined
  }
]

const resolveRepeatControlsStyle = (
  repeatControl: NonNullable<TrackLoopOverlayViewModel['repeatControl']>
): CSSProperties[] => [
  repeatControl.style,
  {
    position: 'absolute',
    top: '8px',
    transform: 'translateX(-50%)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: '32px',
    padding: '4px 6px',
    border: '1px solid rgba(255, 223, 120, 0.24)',
    borderRadius: '999px',
    background: repeatControl.pending ? 'rgba(17, 14, 10, 0.58)' : 'rgba(17, 14, 10, 0.78)',
    boxShadow: '0 10px 24px rgba(0, 0, 0, 0.22), inset 0 0 0 1px rgba(255, 244, 200, 0.06)',
    backdropFilter: 'blur(10px)',
    pointerEvents: 'auto',
    zIndex: 12,
    opacity: repeatControl.pending ? 0.72 : 1
  }
]

const resolveRepeatButtonStyle = (disabled: boolean, clear = false): CSSProperties => ({
  appearance: 'none',
  WebkitAppearance: 'none',
  boxSizing: 'border-box',
  minWidth: clear ? '48px' : '24px',
  width: clear ? 'auto' : '24px',
  height: '24px',
  padding: clear ? '0 9px' : '0',
  border: 'none',
  borderRadius: '999px',
  background: disabled ? 'rgba(255, 223, 120, 0.08)' : 'rgba(255, 223, 120, 0.18)',
  color: disabled ? 'rgba(255, 245, 214, 0.42)' : 'rgba(255, 245, 214, 0.96)',
  fontFamily: 'inherit',
  fontSize: clear ? '11px' : '16px',
  fontWeight: '700',
  lineHeight: '1',
  cursor: disabled ? 'default' : 'pointer',
  outline: 'none'
})

const repeatLabelStyle: CSSProperties = {
  minWidth: '72px',
  color: 'rgba(255, 245, 214, 0.96)',
  fontSize: '11px',
  fontWeight: '600',
  lineHeight: '1',
  textAlign: 'center',
  whiteSpace: 'nowrap'
}

const resolveStatusChipClass = (tone: 'info' | 'error' | undefined) =>
  tone === 'error'
    ? 'mixtape-track-loop__status-chip--error'
    : 'mixtape-track-loop__status-chip--info'

const resolveStatusChipStyle = (
  chip: NonNullable<TrackLoopOverlayViewModel['statusChip']>
): CSSProperties => ({
  position: 'absolute',
  top: '8px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '24px',
  padding: '4px 10px',
  borderRadius: '999px',
  background: chip.tone === 'error' ? 'rgba(48, 16, 14, 0.78)' : 'rgba(15, 16, 18, 0.76)',
  border:
    chip.tone === 'error'
      ? '1px solid rgba(255, 158, 128, 0.18)'
      : '1px solid rgba(255, 223, 120, 0.12)',
  color: chip.tone === 'error' ? 'rgba(255, 228, 214, 0.96)' : 'rgba(255, 245, 214, 0.94)',
  backdropFilter: 'blur(8px)',
  pointerEvents: 'none',
  zIndex: 13,
  boxShadow: '0 8px 20px rgba(0, 0, 0, 0.2)',
  ...(chip.style || {})
})

const resolveStatusTitleStyle = (): CSSProperties => ({
  fontSize: '11px',
  fontWeight: '700',
  lineHeight: '1',
  whiteSpace: 'nowrap'
})

const resolveStatusMetaStyle = (tone: 'info' | 'error' | undefined): CSSProperties => ({
  fontSize: '10px',
  lineHeight: '1',
  whiteSpace: 'nowrap',
  color: tone === 'error' ? 'rgba(255, 228, 214, 0.72)' : 'rgba(255, 245, 214, 0.72)'
})
</script>

<template>
  <div
    v-if="overlay"
    class="mixtape-track-loop"
    :class="{
      'is-preview': overlay.preview,
      'is-editable': loopEditMode,
      'is-selected-loop': !!overlay.selectedLoopKey
    }"
  >
    <div
      v-if="loopEditMode && overlay.statusChip"
      class="mixtape-track-loop__status-chip"
      :class="resolveStatusChipClass(overlay.statusChip.tone)"
      :style="resolveStatusChipStyle(overlay.statusChip)"
    >
      <span class="mixtape-track-loop__status-title" :style="resolveStatusTitleStyle()">
        {{ overlay.statusChip.title }}
      </span>
      <span
        v-if="overlay.statusChip.detail"
        class="mixtape-track-loop__status-detail"
        :style="resolveStatusMetaStyle(overlay.statusChip.tone)"
      >
        {{ overlay.statusChip.detail }}
      </span>
      <span
        v-if="overlay.statusChip.hint"
        class="mixtape-track-loop__status-hint"
        :style="resolveStatusMetaStyle(overlay.statusChip.tone)"
      >
        {{ overlay.statusChip.hint }}
      </span>
    </div>
    <bubbleBoxTrigger
      v-for="line in overlay.gridLines"
      :key="line.key"
      tag="div"
      class="mixtape-track-loop__grid-line"
      :class="{ 'is-active': line.active }"
      :style="resolveGridLineStyle(line)"
      :title="line.hoverLabel"
      :aria-label="line.hoverLabel"
      @mouseenter="hoveredGridKey = line.disabled ? '' : line.key"
      @mouseleave="hoveredGridKey = ''"
      @mousedown.stop.prevent
      @click.stop.prevent="
        loopEditMode
          ? props.handleTrackLoopGridLineClick(item, line.baseSec, line.displaySec, line.disabled)
          : undefined
      "
    >
      <span
        class="mixtape-track-loop__grid-rail"
        :style="resolveGridRailStyle(line)"
        aria-hidden="true"
      ></span>
      <span class="mixtape-track-loop__grid-hover-label" :style="resolveGridHoverLabelStyle(line)">
        {{ line.hoverLabel }}
      </span>
    </bubbleBoxTrigger>
    <div
      v-if="
        loopEditMode &&
        overlay.gridEmptyHint &&
        overlay.gridLines.length === 0 &&
        !overlay.blocks.length
      "
      class="mixtape-track-loop__grid-empty-hint"
    >
      {{ overlay.gridEmptyHint }}
    </div>
    <div
      v-for="block in overlay.blocks"
      :key="block.key"
      class="mixtape-track-loop__block"
      :style="resolveLoopBlockStyle(block, overlay.selectedLoopKey)"
      @mousedown.stop.prevent="
        loopEditMode ? props.handleTrackLoopSelectLoop(item, $event) : undefined
      "
    ></div>
    <div
      v-for="marker in overlay.boundaryMarkers"
      :key="marker.key"
      class="mixtape-track-loop__boundary"
      :class="`mixtape-track-loop__boundary--${marker.kind}`"
      :style="marker.style"
    ></div>
    <div
      v-if="loopEditMode && overlay.repeatControl"
      class="mixtape-track-loop__repeat-controls"
      :class="{ 'is-pending': overlay.repeatControl.pending }"
      :style="resolveRepeatControlsStyle(overlay.repeatControl)"
      @mousedown.stop.prevent
    >
      <bubbleBoxTrigger
        wrapper-tag="span"
        tag="button"
        class="mixtape-track-loop__repeat-btn"
        type="button"
        :title="overlay.repeatControl.decreaseTitle"
        :aria-label="overlay.repeatControl.decreaseTitle"
        :disabled="!overlay.repeatControl.canDecrease || overlay.repeatControl.pending"
        :style="
          resolveRepeatButtonStyle(
            !overlay.repeatControl.canDecrease || overlay.repeatControl.pending
          )
        "
        @click.stop.prevent="props.handleTrackLoopRepeatStep(item, -1)"
      >
        -
      </bubbleBoxTrigger>
      <span class="mixtape-track-loop__repeat-label" :style="repeatLabelStyle">
        {{ overlay.repeatControl.label }}
      </span>
      <bubbleBoxTrigger
        wrapper-tag="span"
        tag="button"
        class="mixtape-track-loop__repeat-btn"
        type="button"
        :title="overlay.repeatControl.increaseTitle"
        :aria-label="overlay.repeatControl.increaseTitle"
        :disabled="!overlay.repeatControl.canIncrease || overlay.repeatControl.pending"
        :style="
          resolveRepeatButtonStyle(
            !overlay.repeatControl.canIncrease || overlay.repeatControl.pending
          )
        "
        @click.stop.prevent="props.handleTrackLoopRepeatStep(item, 1)"
      >
        +
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        wrapper-tag="span"
        tag="button"
        class="mixtape-track-loop__repeat-btn mixtape-track-loop__repeat-btn--clear"
        type="button"
        :title="overlay.repeatControl.clearTitle"
        :aria-label="overlay.repeatControl.clearTitle"
        :disabled="overlay.repeatControl.pending"
        :style="resolveRepeatButtonStyle(overlay.repeatControl.pending, true)"
        @click.stop.prevent="
          props.handleTrackLoopRemove(item.track.id, overlay.repeatControl.loopKey)
        "
      >
        {{ overlay.repeatControl.clearTitle }}
      </bubbleBoxTrigger>
    </div>
  </div>
</template>
