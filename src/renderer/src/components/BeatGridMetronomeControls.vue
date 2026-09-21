<script setup lang="ts">
import { computed } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'

const props = defineProps({
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
  (event: 'cycle-metronome-state'): void
}>()

const normalizedMetronomeVolumeLevel = computed(() => {
  const numeric = Math.round(Number(props.metronomeVolumeLevel) || 1)
  if (numeric <= 1) return 1
  if (numeric >= 3) return 3
  return 2
})

const metronomeStateLabel = computed(() =>
  props.metronomeEnabled
    ? `${normalizedMetronomeVolumeLevel.value}/3`
    : t('mixtape.metronomeStateOff')
)

const metronomeTitle = computed(() => {
  const stateTitle = props.metronomeEnabled
    ? t('mixtape.metronomeVolumeLevel', { level: normalizedMetronomeVolumeLevel.value })
    : t('mixtape.metronomeOff')
  return `${stateTitle} · ${t('mixtape.metronomeCycleHint')} · ${t('mixtape.metronomeNotRecorded')}`
})
</script>

<template>
  <div class="metronome-controls">
    <bubbleBoxTrigger
      wrapper-tag="span"
      tag="button"
      class="metronome-cycle-btn"
      type="button"
      :class="{ 'is-active': metronomeEnabled }"
      :disabled="!canToggleMetronome"
      :title="metronomeTitle"
      :aria-label="metronomeTitle"
      @click="emit('cycle-metronome-state')"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4.5 2h7l-1.2 11h-4.6L4.5 2Z"></path>
        <path d="M8 5.3v3.8"></path>
        <circle cx="8" cy="10.9" r="1.1"></circle>
      </svg>
      <span class="metronome-cycle-btn__label">{{ t('mixtape.metronome') }}</span>
      <span class="metronome-cycle-btn__state">{{ metronomeStateLabel }}</span>
    </bubbleBoxTrigger>
  </div>
</template>

<style scoped lang="scss">
.metronome-controls {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.metronome-cycle-btn {
  &:focus {
    outline: none;
  }

  &:focus-visible {
    outline: none;
    box-shadow: none;
  }
}

.metronome-cycle-btn {
  height: 22px;
  min-width: 86px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.metronome-cycle-btn svg {
  width: 14px;
  height: 14px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.metronome-cycle-btn svg path:first-child {
  fill: currentColor;
  stroke: none;
  opacity: 0.18;
}

.metronome-cycle-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.metronome-cycle-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.metronome-cycle-btn.is-active {
  border-color: color-mix(in srgb, var(--accent) 80%, #ffffff);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent) inset;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.metronome-cycle-btn__label,
.metronome-cycle-btn__state {
  white-space: nowrap;
}

.metronome-cycle-btn__state {
  min-width: 22px;
  text-align: center;
  font-weight: 600;
}
</style>
