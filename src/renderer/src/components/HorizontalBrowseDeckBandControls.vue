<script setup lang="ts">
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseBandKey } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseFaderControls'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useHorizontalBrowseAutoGain } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseAutoGain'
import { t } from '@renderer/utils/translate'

type HorizontalBrowseBandState = Record<HorizontalBrowseBandKey, boolean>

const props = defineProps<{
  deck: HorizontalBrowseDeckKey
  bands: HorizontalBrowseBandState
  cueMonitorEnabled: boolean
  cueMonitorDisabled: boolean
}>()

const emit = defineEmits<{
  (event: 'toggle-band', deck: HorizontalBrowseDeckKey, band: HorizontalBrowseBandKey): void
  (event: 'toggle-cue-monitor', deck: HorizontalBrowseDeckKey): void
}>()

const bandLabels: Record<HorizontalBrowseBandKey, string> = {
  high: 'HI',
  mid: 'MID',
  low: 'LOW'
}

const bandKeys: HorizontalBrowseBandKey[] = ['high', 'mid', 'low']
const { autoGainEnabled, autoGainStatus, autoGainTitle, toggleAutoGain } =
  useHorizontalBrowseAutoGain(props.deck)
</script>

<template>
  <div class="deck-band-controls" :class="`deck-band-controls--${props.deck}`">
    <bubbleBoxTrigger
      wrapper-tag="span"
      tag="button"
      class="deck-band-controls__button deck-band-controls__button--auto-gain"
      :class="[
        `is-auto-gain-${autoGainStatus}`,
        {
          'is-active': autoGainEnabled && autoGainStatus !== 'off',
          'is-pending': autoGainStatus === 'pending',
          'is-unavailable': autoGainStatus === 'unavailable'
        }
      ]"
      type="button"
      :title="autoGainTitle"
      :aria-pressed="autoGainEnabled"
      :aria-label="autoGainTitle"
      @click.stop="toggleAutoGain"
    >
      A.Gain
    </bubbleBoxTrigger>
    <button
      v-for="band in bandKeys"
      :key="band"
      class="deck-band-controls__button"
      :class="[`deck-band-controls__button--${band}`, { 'is-active': props.bands[band] }]"
      type="button"
      :aria-pressed="props.bands[band]"
      :aria-label="
        t(props.bands[band] ? 'horizontalBrowse.bandActive' : 'horizontalBrowse.bandCut', {
          band: bandLabels[band]
        })
      "
      @click.stop="emit('toggle-band', props.deck, band)"
    >
      {{ bandLabels[band] }}
    </button>
    <bubbleBoxTrigger
      wrapper-tag="span"
      wrapper-class="deck-band-controls__cue-monitor-wrap"
      tag="button"
      class="deck-band-controls__button deck-band-controls__button--cue-monitor"
      :class="{ 'is-active': props.cueMonitorEnabled }"
      type="button"
      :disabled="props.cueMonitorDisabled"
      :title="t('horizontalBrowse.cueMonitorTitle')"
      :aria-pressed="props.cueMonitorEnabled"
      :aria-label="
        t(props.cueMonitorEnabled ? 'horizontalBrowse.cueMonitorOn' : 'horizontalBrowse.cueMonitorOff')
      "
      @click.stop="emit('toggle-cue-monitor', props.deck)"
    >
      CUE
    </bubbleBoxTrigger>
  </div>
</template>

<style scoped lang="scss">
.deck-band-controls {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: center;
  justify-content: center;
  align-self: stretch;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  padding: 6px 5px 6px 2px;
}

.deck-band-controls--top {
  justify-content: flex-end;
}

.deck-band-controls--bottom {
  justify-content: flex-start;
}

.deck-band-controls__button {
  width: 32px;
  height: 14px;
  padding: 0;
  border: 1px solid var(--shell-border);
  border-radius: 4px;
  background: color-mix(in srgb, var(--shell-panel) 86%, var(--bg-elev));
  color: var(--text-weak);
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
  box-sizing: border-box;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.1s ease;
}

.deck-band-controls__button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--text-weak) 42%, var(--shell-border));
  color: var(--text);
}

.deck-band-controls__button:disabled {
  opacity: 0.44;
  cursor: not-allowed;
}

.deck-band-controls__button--auto-gain {
  font-size: 7px;
}

.deck-band-controls__cue-monitor-wrap {
  margin-top: 7px;
  position: relative;
}

.deck-band-controls__cue-monitor-wrap::before {
  content: '';
  position: absolute;
  top: -5px;
  left: 6px;
  right: 6px;
  height: 1px;
  background: color-mix(in srgb, var(--shell-border) 74%, transparent);
}

.deck-band-controls__button--auto-gain.is-active:not(.is-unavailable) {
  --band-color: #f59e0b;
}

.deck-band-controls__button--auto-gain.is-pending {
  animation: deck-auto-gain-pulse 1.1s ease-in-out infinite;
}

.deck-band-controls__button--auto-gain.is-unavailable {
  border-color: color-mix(in srgb, #ef4444 58%, var(--shell-border));
  background: color-mix(in srgb, #ef4444 8%, var(--shell-panel));
  color: color-mix(in srgb, #ef4444 74%, var(--text));
}

.deck-band-controls__button--high.is-active {
  --band-color: #3b82f6; /* Blue */
}

.deck-band-controls__button--mid.is-active {
  --band-color: #10b981; /* Green */
}

.deck-band-controls__button--low.is-active {
  --band-color: #ef4444; /* Red */
}

.deck-band-controls__button--cue-monitor {
  width: 30px;
  height: 14px;
  border-radius: 999px;
  border-color: var(--shell-border);
  background: color-mix(in srgb, var(--shell-panel) 82%, var(--bg-elev));
  color: var(--text);
  font-size: 8px;
  letter-spacing: 0;
}

.deck-band-controls__button.is-active {
  border-color: color-mix(in srgb, var(--band-color) 70%, transparent);
  background: color-mix(in srgb, var(--band-color) 15%, transparent);
  color: color-mix(in srgb, var(--band-color) 90%, #fff);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 15%, transparent);
}

.deck-band-controls__button--cue-monitor.is-active {
  border-color: color-mix(in srgb, var(--shell-cue-accent, #d98921) 78%, transparent);
  background: color-mix(in srgb, var(--shell-cue-accent, #d98921) 13%, transparent);
  color: color-mix(in srgb, var(--shell-cue-accent, #d98921) 92%, #fff);
}

@keyframes deck-auto-gain-pulse {
  0%,
  100% {
    box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 15%, transparent);
  }

  50% {
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, #fff 18%, transparent),
      0 0 0 1px color-mix(in srgb, #f59e0b 28%, transparent);
  }
}
</style>
