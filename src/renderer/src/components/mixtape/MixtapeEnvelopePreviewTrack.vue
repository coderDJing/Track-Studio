<script setup lang="ts">
import type { CSSProperties } from 'vue'
import type { MixSegmentMask } from '@renderer/composables/mixtape/gainEnvelopeEditorTypes'
import type {
  TrackEnvelopePreviewLine,
  TrackStemPreviewRow
} from '@renderer/composables/mixtape/useMixtapeEnvelopePreview'
import type { TimelineTrackLayout } from '@renderer/composables/mixtape/types'

defineProps<{
  item: TimelineTrackLayout
  lines: TrackEnvelopePreviewLine[]
  loopBlocks: Array<{
    key: string
    kind: 'source' | 'repeat'
    style: CSSProperties
  }>
  muteSegments: MixSegmentMask[]
  showMuteSegments: boolean
  showStemRows: boolean
  stemRows: TrackStemPreviewRow[]
  trackStyle: CSSProperties
}>()
</script>

<template>
  <div
    class="timeline-envelope-preview__track"
    :class="{ 'is-stem-mode': showStemRows }"
    :style="trackStyle"
  >
    <div v-if="loopBlocks.length" class="timeline-envelope-preview__loop-blocks">
      <div
        v-for="block in loopBlocks"
        :key="`envelope-preview-loop-${item.track.id}-${block.key}`"
        class="timeline-envelope-preview__loop-block"
        :class="`timeline-envelope-preview__loop-block--${block.kind}`"
        :style="block.style"
      ></div>
    </div>
    <div v-if="showStemRows" class="timeline-envelope-preview__stem-grid">
      <div
        v-for="row in stemRows"
        :key="`envelope-preview-stem-row-${item.track.id}-${row.key}`"
        class="timeline-envelope-preview__stem-row"
        :style="{
          '--stem-preview-fill': row.fillColor
        }"
      >
        <div class="timeline-envelope-preview__stem-mute-segments">
          <div
            v-for="segment in row.muteSegments"
            :key="`envelope-preview-stem-segment-${item.track.id}-${row.key}-${segment.key}`"
            class="timeline-envelope-preview__stem-mute-segment"
            :style="{
              left: `${segment.left}%`,
              width: `${segment.width}%`
            }"
          ></div>
        </div>
      </div>
    </div>
    <div v-if="showMuteSegments" class="timeline-envelope-preview__mute-segments">
      <div
        v-for="segment in muteSegments"
        :key="`envelope-preview-mute-${item.track.id}-${segment.key}`"
        class="timeline-envelope-preview__mute-segment"
        :style="{
          left: `${segment.left}%`,
          width: `${segment.width}%`
        }"
      ></div>
    </div>
    <svg
      class="timeline-envelope-preview__track-svg"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <polyline
        v-for="line in lines"
        :key="`envelope-preview-outline-${item.track.id}-${line.key}`"
        class="timeline-envelope-preview__line-outline"
        :points="line.points"
        :style="{ strokeWidth: line.strokeWidth + 1.8 }"
      ></polyline>
      <polyline
        v-for="line in lines"
        :key="`envelope-preview-${item.track.id}-${line.key}`"
        class="timeline-envelope-preview__line"
        :class="`timeline-envelope-preview__line--${line.key}`"
        :points="line.points"
        :style="{ stroke: line.color, strokeWidth: line.strokeWidth }"
      ></polyline>
    </svg>
  </div>
</template>

<style scoped lang="scss">
.timeline-envelope-preview__track {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  min-width: 1px;
  border: 0;
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--accent) 46%, transparent),
    inset 1px 0 0 rgba(255, 255, 255, 0.14),
    inset -1px 0 0 rgba(6, 9, 14, 0.2);
  background:
    linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.08) 0%,
      rgba(255, 255, 255, 0.015) 38%,
      rgba(0, 0, 0, 0.08) 100%
    ),
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--accent) 22%, transparent) 0%,
      color-mix(in srgb, var(--accent) 12%, transparent) 55%,
      color-mix(in srgb, var(--accent) 18%, transparent) 100%
    );
  overflow: hidden;
}

.timeline-envelope-preview__track.is-stem-mode {
  background:
    linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.08) 0%,
      rgba(255, 255, 255, 0.02) 34%,
      rgba(0, 0, 0, 0.12) 100%
    ),
    var(--mixtape-preview-stem-base-bg);
}

.timeline-envelope-preview__track::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  border-top: 1px dashed var(--mixtape-preview-grid-line);
  transform: translateY(-0.5px);
  pointer-events: none;
  z-index: 1;
}

.timeline-envelope-preview__loop-blocks {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 1;
}

.timeline-envelope-preview__loop-block {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 0;
}

.timeline-envelope-preview__loop-block--source {
  background: rgba(255, 214, 102, 0.24);
  box-shadow: inset 0 0 0 1px rgba(255, 244, 182, 0.24);
}

.timeline-envelope-preview__loop-block--repeat {
  background: repeating-linear-gradient(
    -58deg,
    rgba(255, 218, 92, 0.28) 0,
    rgba(255, 218, 92, 0.28) 4px,
    rgba(255, 218, 92, 0.08) 4px,
    rgba(255, 218, 92, 0.08) 8px
  );
  box-shadow: inset 0 0 0 1px rgba(255, 244, 182, 0.18);
}

.timeline-envelope-preview__mute-segments {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  pointer-events: none;
  z-index: 2;
}

.timeline-envelope-preview__mute-segment {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(210, 58, 58, 0.28);
}

.timeline-envelope-preview__stem-grid {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  pointer-events: none;
  z-index: 0;
}

.timeline-envelope-preview__stem-row {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.015) 0%, rgba(0, 0, 0, 0.16) 100%),
    linear-gradient(90deg, var(--stem-preview-fill, rgba(255, 255, 255, 0.12)) 0 100%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--mixtape-preview-grid-line) 50%, transparent);
}

.timeline-envelope-preview__stem-mute-segments {
  position: absolute;
  inset: 0;
  z-index: 1;
}

.timeline-envelope-preview__stem-mute-segment {
  position: absolute;
  top: 0;
  bottom: 0;
  background:
    repeating-linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.22) 0 5px,
      rgba(255, 255, 255, 0) 5px 10px
    ),
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--mixtape-preview-stem-base-bg) 78%, transparent) 0%,
      color-mix(in srgb, var(--mixtape-preview-stem-base-bg) 96%, transparent) 100%
    );
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.16),
    inset 0 0 12px rgba(0, 0, 0, 0.32);
}

.timeline-envelope-preview__track-svg {
  position: absolute;
  inset: 0;
  z-index: 3;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
}

.timeline-envelope-preview__line-outline {
  fill: none;
  stroke: rgba(6, 9, 14, 0.9);
  vector-effect: non-scaling-stroke;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 1;
}

.timeline-envelope-preview__line {
  fill: none;
  vector-effect: non-scaling-stroke;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 1;
  filter: drop-shadow(0 0 1px var(--mixtape-preview-line-shadow));
}

.timeline-envelope-preview__line--gain {
  opacity: 0.96;
}

.timeline-envelope-preview__line--volume {
  opacity: 0.92;
}
</style>
