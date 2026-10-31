<script setup lang="ts">
import BeatGridMetronomeControls from '@renderer/components/BeatGridMetronomeControls.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'

defineProps({
  previewDecoding: {
    type: Boolean,
    default: false
  },
  previewPlaying: {
    type: Boolean,
    default: false
  },
  canTogglePreviewPlayback: {
    type: Boolean,
    default: false
  },
  canStopPreviewPlayback: {
    type: Boolean,
    default: false
  },
  metronomeEnabled: {
    type: Boolean,
    default: false
  },
  metronomeVolumeLevel: {
    type: Number,
    default: 2
  },
  canToggleMetronome: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits<{
  (event: 'toggle-playback'): void
  (event: 'stop-to-start'): void
  (event: 'cycle-metronome-state'): void
}>()
</script>

<template>
  <div class="preview-toolbar">
    <div class="preview-tools">
      <bubbleBoxTrigger
        wrapper-tag="span"
        tag="button"
        class="playback-icon-btn"
        type="button"
        :disabled="!canTogglePreviewPlayback"
        shortcut="Space"
        :title="
          previewDecoding
            ? t('mixtape.transportDecoding')
            : previewPlaying
              ? t('mixtape.pause')
              : t('mixtape.play')
        "
        :aria-label="
          previewDecoding
            ? t('mixtape.transportDecoding')
            : previewPlaying
              ? t('mixtape.pause')
              : t('mixtape.play')
        "
        @click="emit('toggle-playback')"
      >
        <svg
          v-if="previewDecoding"
          class="is-spinning"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="8" cy="8" r="5.5"></circle>
        </svg>
        <svg v-else-if="previewPlaying" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="4" y="3" width="3" height="10" rx="0.9"></rect>
          <rect x="9" y="3" width="3" height="10" rx="0.9"></rect>
        </svg>
        <svg v-else viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <polygon points="5,3.5 12.5,8 5,12.5"></polygon>
        </svg>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        wrapper-tag="span"
        tag="button"
        class="playback-icon-btn"
        type="button"
        :disabled="!canStopPreviewPlayback"
        :title="t('mixtape.stop')"
        :aria-label="t('mixtape.stop')"
        @click="emit('stop-to-start')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="4" y="4" width="8" height="8" rx="1"></rect>
        </svg>
      </bubbleBoxTrigger>
      <BeatGridMetronomeControls
        :metronome-enabled="metronomeEnabled"
        :metronome-volume-level="metronomeVolumeLevel"
        :can-toggle-metronome="canToggleMetronome"
        @cycle-metronome-state="emit('cycle-metronome-state')"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.preview-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.preview-tools {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.playback-icon-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.playback-icon-btn:focus {
  outline: none;
}

.playback-icon-btn:focus-visible {
  outline: none;
  box-shadow: none;
}

.playback-icon-btn svg {
  width: 14px;
  height: 14px;
  display: block;
  fill: currentColor;
  stroke: currentColor;
  stroke-width: 1.6;
}

.playback-icon-btn svg.is-spinning {
  fill: none;
  stroke-linecap: round;
  stroke-dasharray: 24;
  stroke-dashoffset: 8;
  animation: beat-align-playback-spin 0.9s linear infinite;
}

.playback-icon-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.playback-icon-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@keyframes beat-align-playback-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
