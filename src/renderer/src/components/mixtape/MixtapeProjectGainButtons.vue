<script setup lang="ts">
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'
import type { ProjectGainUnavailableReason } from '@renderer/composables/mixtape/useMixtapeProjectGain'

const props = defineProps<{
  canDecrease: boolean
  canIncrease: boolean
  busy: boolean
  unavailableReason?: ProjectGainUnavailableReason
}>()
const emit = defineEmits<{ adjust: [direction: -1 | 1] }>()
const actionHint = (direction: -1 | 1) =>
  t(direction === -1 ? 'mixtape.projectGainDecreaseHint' : 'mixtape.projectGainIncreaseHint')
const hint = (direction: -1 | 1) => {
  if (props.busy || props.unavailableReason === 'saving') return t('mixtape.projectGainSaving')
  if (props.unavailableReason === 'empty') return t('mixtape.projectGainEmpty')
  if (props.unavailableReason === 'blocked') return t('mixtape.projectGainBlocked')
  if (props.unavailableReason === 'notReady') return t('mixtape.projectGainNotReady')
  if (!(direction === -1 ? props.canDecrease : props.canIncrease)) {
    return t(direction === -1 ? 'mixtape.projectGainLowerLimit' : 'mixtape.projectGainUpperLimit')
  }
  return actionHint(direction)
}
</script>

<template>
  <div
    class="project-gain-buttons"
    role="group"
    :aria-label="t('mixtape.projectGainAction')"
    :aria-busy="busy"
  >
    <div class="project-gain-buttons__label">
      <span>{{ t('mixtape.projectGainAction') }}</span>
      <span class="project-gain-buttons__step">{{
        t(busy ? 'mixtape.projectGainSaving' : 'mixtape.projectGainStep')
      }}</span>
    </div>
    <bubbleBoxTrigger
      v-for="direction in [-1, 1] as const"
      :key="direction"
      wrapper-tag="span"
      tag="button"
      type="button"
      class="button project-gain-button"
      :disabled="busy || (direction === -1 ? !canDecrease : !canIncrease)"
      :title="hint(direction)"
      :aria-label="actionHint(direction)"
      @click="emit('adjust', direction)"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path :d="direction === -1 ? 'M8 3v10m-4-4 4 4 4-4' : 'M8 13V3m-4 4 4-4 4 4'" />
      </svg>
      <span>{{
        t(direction === -1 ? 'mixtape.projectGainDecrease' : 'mixtape.projectGainIncrease')
      }}</span>
    </bubbleBoxTrigger>
  </div>
</template>

<style scoped lang="scss">
.project-gain-buttons {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding-left: 8px;
  margin-left: 2px;
  border-left: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-weak);
  white-space: nowrap;
}

.project-gain-buttons__label {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-right: 2px;
  line-height: 12px;
  color: var(--text);
}

.project-gain-buttons__step {
  font-size: 10px;
  color: var(--text-weak);
}

.project-gain-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-height: 25px;
  height: auto;
  padding: 0 9px;
  font-size: 11px;
  line-height: 20px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: color-mix(in srgb, var(--bg-elev) 92%, transparent);
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}

.project-gain-button svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.project-gain-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.project-gain-button:hover:not(:disabled) {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 48%, var(--border));
  background: color-mix(in srgb, var(--bg-elev) 82%, var(--accent) 18%);
}

.project-gain-button:disabled {
  color: var(--text);
  background: color-mix(in srgb, var(--bg-elev) 92%, transparent);
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
