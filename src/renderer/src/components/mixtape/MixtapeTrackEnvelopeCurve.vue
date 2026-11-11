<script setup lang="ts">
defineProps<{ visible: boolean; polygon: string; polyline: string; hoverLine?: string }>()
</script>

<template>
  <svg class="lane-track__envelope-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
    <line
      class="lane-track__envelope-midline"
      :class="{ 'is-hidden': !visible }"
      x1="0"
      y1="50"
      x2="100"
      y2="50"
    />
    <polygon
      class="lane-track__envelope-fill"
      :class="{ 'is-hidden': !visible }"
      :points="polygon"
    />
    <polyline
      class="lane-track__envelope-line"
      :class="{ 'is-hidden': !visible }"
      :points="polyline"
    />
    <polyline
      class="lane-track__envelope-segment-hit"
      :class="{ 'is-hidden': !visible }"
      :points="polyline"
    />
    <polyline v-if="visible && hoverLine" class="lane-track__envelope-hover" :points="hoverLine" />
  </svg>
</template>

<style scoped lang="scss">
.lane-track__envelope-svg {
  position: absolute;
  left: calc(-1 * var(--lane-track-border-width));
  right: calc(-1 * var(--lane-track-border-width));
  top: 4px;
  bottom: 4px;
  width: calc(100% + var(--lane-track-border-width) * 2);
  height: calc(100% - 8px);
  pointer-events: none;
  z-index: 2;
}

.lane-track__envelope-line {
  fill: none;
  stroke: var(--mix-envelope-line-color);
  stroke-width: 1.6;
  vector-effect: non-scaling-stroke;
  opacity: 1;
  filter: drop-shadow(0 0 1px var(--mixtape-point-line-shadow));
}

.lane-track__envelope-midline {
  stroke: var(--mix-envelope-line-color);
  stroke-width: 1.4;
  stroke-dasharray: 5 3;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
  opacity: 0.5;
}

.lane-track__envelope-line.is-hidden {
  display: none;
}

.lane-track__envelope-midline.is-hidden {
  display: none;
}

.lane-track__envelope-fill {
  fill: var(--mix-envelope-line-color);
  opacity: 0.15;
  pointer-events: none;
}

.lane-track__envelope-fill.is-hidden {
  display: none;
}

.lane-track__envelope-segment-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 16;
  vector-effect: non-scaling-stroke;
  pointer-events: none;
  cursor: ns-resize;
}

.lane-track__envelope-hover {
  fill: none;
  stroke: var(--mix-envelope-line-color);
  stroke-width: 4;
  opacity: 0.55;
  vector-effect: non-scaling-stroke;
}

.lane-track__envelope-segment-hit.is-hidden {
  display: none;
}
</style>
