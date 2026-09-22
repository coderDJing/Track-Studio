<script setup lang="ts">
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'

type BeatStep = 4 | 8 | 16 | 32 | 128

const beatStepOptions: BeatStep[] = [4, 8, 16, 32, 128]

defineProps<{
  songPresent: boolean
  canPreviousSong: boolean
  canNextSong: boolean
  beatStep: BeatStep
  disabled?: boolean
}>()

const emit = defineEmits<{
  (event: 'previous-song'): void
  (event: 'next-song'): void
  (event: 'jump-beats', direction: -1 | 1): void
  (event: 'update:beat-step', value: BeatStep): void
}>()

const isBeatStep = (value: number): value is BeatStep => beatStepOptions.includes(value as BeatStep)

const handleBeatStepChange = (event: Event) => {
  const value = Number((event.target as HTMLSelectElement | null)?.value)
  if (!isBeatStep(value)) return
  emit('update:beat-step', value)
}
</script>

<template>
  <div class="edit-deck-controls" :aria-label="t('horizontalBrowse.editModeControls')">
    <div class="edit-deck-controls__pair">
      <bubbleBoxTrigger
        tag="button"
        wrapper-tag="span"
        wrapper-class="edit-deck-controls__anchor"
        class="edit-deck-controls__button"
        :title="
          disabled
            ? t('horizontalBrowse.saveBlockingSongSwitch')
            : canPreviousSong
              ? t('horizontalBrowse.loadPreviousSong')
              : t('horizontalBrowse.noPreviousSong')
        "
        shortcut="W"
        type="button"
        :disabled="disabled || !canPreviousSong"
        :aria-label="
          canPreviousSong
            ? t('horizontalBrowse.loadPreviousSong')
            : t('horizontalBrowse.noPreviousSong')
        "
        @click="emit('previous-song')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 5h2v14H6z" />
          <path d="m18 6-8 6 8 6z" />
        </svg>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        tag="button"
        wrapper-tag="span"
        wrapper-class="edit-deck-controls__anchor"
        class="edit-deck-controls__button"
        :title="
          disabled
            ? t('horizontalBrowse.saveBlockingSongSwitch')
            : canNextSong
              ? t('horizontalBrowse.loadNextSong')
              : t('horizontalBrowse.noNextSong')
        "
        shortcut="S"
        type="button"
        :disabled="disabled || !canNextSong"
        :aria-label="canNextSong ? t('horizontalBrowse.loadNextSong') : t('horizontalBrowse.noNextSong')"
        @click="emit('next-song')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M16 5h2v14h-2z" />
          <path d="m6 6 8 6-8 6z" />
        </svg>
      </bubbleBoxTrigger>
    </div>

    <div class="edit-deck-controls__pair">
      <bubbleBoxTrigger
        tag="button"
        wrapper-tag="span"
        wrapper-class="edit-deck-controls__anchor"
        class="edit-deck-controls__button"
        :title="
          disabled
            ? t('horizontalBrowse.saveBlockingSeek')
            : t('horizontalBrowse.jumpBackward', { beats: beatStep })
        "
        type="button"
        :disabled="disabled || !songPresent"
        :aria-label="t('horizontalBrowse.jumpBackward', { beats: beatStep })"
        @click="emit('jump-beats', -1)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M10 7h2v10h-2z" />
          <path d="m4 12 6-5v10z" />
          <path d="m20 12-6-5v10z" opacity="0.7" />
        </svg>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        tag="button"
        wrapper-tag="span"
        wrapper-class="edit-deck-controls__anchor"
        class="edit-deck-controls__button"
        :title="
          disabled
            ? t('horizontalBrowse.saveBlockingSeek')
            : t('horizontalBrowse.jumpForward', { beats: beatStep })
        "
        type="button"
        :disabled="disabled || !songPresent"
        :aria-label="t('horizontalBrowse.jumpForward', { beats: beatStep })"
        @click="emit('jump-beats', 1)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 7h2v10h-2z" />
          <path d="m4 12 6-5v10z" opacity="0.7" />
          <path d="m20 12-6-5v10z" />
        </svg>
      </bubbleBoxTrigger>
    </div>

    <bubbleBoxTrigger
      tag="div"
      class="edit-deck-controls__select-wrap"
      :title="
        disabled
          ? t('horizontalBrowse.saveBlockingAdjust')
          : t('horizontalBrowse.jumpStep', { beats: beatStep })
      "
    >
      <select
        class="edit-deck-controls__select"
        :value="beatStep"
        :disabled="disabled || !songPresent"
        :aria-label="t('horizontalBrowse.changeJumpStep')"
        @change="handleBeatStepChange"
      >
        <option v-for="option in beatStepOptions" :key="option" :value="option">
          {{ option }} beats
        </option>
      </select>
    </bubbleBoxTrigger>
  </div>
</template>

<style scoped lang="scss">
.edit-deck-controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 8px 0 2px;
  min-width: 0;
}

.edit-deck-controls__pair {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.edit-deck-controls__anchor {
  flex: 0 0 auto;
}

.edit-deck-controls__button {
  width: 32px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--shell-border, var(--border));
  border-radius: 5px;
  background: color-mix(in srgb, var(--bg-elev) 70%, transparent);
  color: var(--text-weak);
  padding: 0;
  box-sizing: border-box;
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    color 0.16s ease,
    background-color 0.16s ease;
}

.edit-deck-controls__button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 56%, var(--border));
  color: var(--text);
  background: color-mix(in srgb, var(--accent) 12%, var(--bg-elev));
}

.edit-deck-controls__button:disabled {
  cursor: default;
  opacity: 0.36;
}

.edit-deck-controls__button svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.edit-deck-controls__select-wrap {
  position: relative;
  display: inline-flex;
  width: 70px;
  height: 28px;
}

.edit-deck-controls__select {
  width: 100%;
  height: 100%;
  appearance: none;
  border: 1px solid var(--shell-border, var(--border));
  border-radius: 5px;
  background: color-mix(in srgb, var(--bg-elev) 70%, transparent);
  color: var(--text-weak);
  font: inherit;
  font-size: 10.5px;
  line-height: 1;
  padding: 0 6px;
  text-align: center;
  box-sizing: border-box;
  cursor: pointer;
  outline: none;
  transition:
    border-color 0.16s ease,
    color 0.16s ease,
    box-shadow 0.16s ease;
}

.edit-deck-controls__select:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 56%, var(--border));
  color: var(--text);
}

.edit-deck-controls__select:focus {
  outline: none;
}

.edit-deck-controls__select:focus-visible {
  border-color: color-mix(in srgb, var(--accent) 64%, var(--border));
  color: var(--text);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
}

.edit-deck-controls__select:disabled {
  cursor: default;
  opacity: 0.36;
}
</style>
