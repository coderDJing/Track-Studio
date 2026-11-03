<script setup lang="ts">
import { computed } from 'vue'
import HotCueMarkersLayer from '@renderer/components/HotCueMarkersLayer.vue'
import MemoryCueMarkersLayer from '@renderer/components/MemoryCueMarkersLayer.vue'
import { BASE_PX_PER_SEC, MIXTAPE_WIDTH_SCALE } from '@renderer/composables/mixtape/constants'
import { buildMixtapeTrackCueMarkers } from '@renderer/composables/mixtape/mixtapeTrackCueMarkers'
import type { TimelineTrackLayout } from '@renderer/composables/mixtape/types'

const props = defineProps<{
  item: TimelineTrackLayout
  sourceDurationSec: number
  renderZoom: number
}>()

const markers = computed(() =>
  buildMixtapeTrackCueMarkers({
    track: { ...props.item.track, startSec: props.item.startSec },
    sourceDurationSec: props.sourceDurationSec,
    pxPerSec: BASE_PX_PER_SEC * MIXTAPE_WIDTH_SCALE * props.renderZoom
  })
)
</script>

<template>
  <div v-if="markers.length" class="mixtape-track-cues">
    <div
      v-for="marker in markers"
      :key="marker.key"
      class="mixtape-track-cue"
      :class="[
        `mixtape-track-cue--${marker.kind}`,
        { 'is-at-start': marker.leftPx < 12, 'is-at-end': marker.leftPx > item.width - 12 }
      ]"
      :style="{ left: `${marker.leftPx}px`, '--cue-color': marker.color }"
    >
      <HotCueMarkersLayer
        v-if="marker.hotCue"
        :hot-cues="[marker.hotCue]"
        :start-sec="marker.hotCue.sec"
        :visible-duration-sec="1"
        anchor="top"
        size="compact"
      />
      <MemoryCueMarkersLayer
        v-if="marker.memoryCue"
        :memory-cues="[marker.memoryCue]"
        :start-sec="marker.memoryCue.sec"
        :visible-duration-sec="1"
        anchor="top"
        size="compact"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.mixtape-track-cues {
  position: absolute;
  inset: 0 calc(-1 * var(--lane-track-border-width, 3px));
  z-index: 4;
  pointer-events: none;
  overflow: hidden;
}

.mixtape-track-cue {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 1px solid var(--cue-color);
  filter: drop-shadow(0 0 1px var(--waveform-bg));
}

.mixtape-track-cue--memory {
  border-left-style: dashed;
}

.mixtape-track-cue :deep(.hotcue-marker__label),
.mixtape-track-cue :deep(.memorycue-marker) {
  pointer-events: auto;
}

.mixtape-track-cue.is-at-start :deep(.hotcue-marker__label),
.mixtape-track-cue.is-at-start :deep(.memorycue-marker) {
  transform: none;
}

.mixtape-track-cue.is-at-end :deep(.hotcue-marker__label),
.mixtape-track-cue.is-at-end :deep(.memorycue-marker) {
  transform: translateX(-100%);
}
</style>
