<script setup lang="ts">
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'

defineProps<{
  pending: boolean
  withJump: boolean
}>()

const emit = defineEmits<{
  analyze: []
}>()
</script>

<template>
  <bubbleBoxTrigger
    tag="button"
    class="playlist-analysis-floating-button"
    :class="{ 'playlist-analysis-floating-button--with-jump': withJump }"
    type="button"
    :disabled="pending"
    :title="t('bottomInfo.analyzePending')"
    @click.stop="emit('analyze')"
  >
    <span class="playlist-analysis-floating-button__icon" aria-hidden="true">
      <span class="playlist-analysis-floating-button__bar"></span>
      <span class="playlist-analysis-floating-button__bar"></span>
      <span class="playlist-analysis-floating-button__bar"></span>
      <span class="playlist-analysis-floating-button__spark"></span>
    </span>
    <span class="playlist-analysis-floating-button__text">{{
      t('bottomInfo.analyzePending')
    }}</span>
  </bubbleBoxTrigger>
</template>

<style lang="scss" scoped>
.playlist-analysis-floating-button {
  position: absolute;
  right: 12px;
  bottom: 12px;
  height: 30px;
  padding: 0 12px 0 10px;
  box-sizing: border-box;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  opacity: 0.65;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  z-index: 6;
  cursor: pointer;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18);
  transition:
    opacity 0.15s ease,
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.playlist-analysis-floating-button--with-jump {
  right: 48px;
}

.playlist-analysis-floating-button:hover:not(:disabled) {
  opacity: 0.95;
  transform: translateY(-1px);
}

.playlist-analysis-floating-button:active:not(:disabled) {
  transform: translateY(0);
}

.playlist-analysis-floating-button:disabled {
  cursor: default;
  opacity: 0.55;
}

.playlist-analysis-floating-button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: 2px;
}

.playlist-analysis-floating-button__icon {
  position: relative;
  width: 17px;
  height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: color-mix(in srgb, var(--main-color) 78%, var(--text));
}

.playlist-analysis-floating-button__bar {
  width: 2px;
  border-radius: 2px;
  background: currentColor;
  box-shadow: 0 0 6px color-mix(in srgb, var(--main-color) 45%, transparent);
}

.playlist-analysis-floating-button__bar:nth-child(1) {
  height: 7px;
}

.playlist-analysis-floating-button__bar:nth-child(2) {
  height: 13px;
}

.playlist-analysis-floating-button__bar:nth-child(3) {
  height: 9px;
}

.playlist-analysis-floating-button__spark {
  position: absolute;
  right: -1px;
  top: 1px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--main-color) 88%, #ffffff);
  box-shadow: 0 0 7px color-mix(in srgb, var(--main-color) 62%, transparent);
}

.playlist-analysis-floating-button__text {
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
}
</style>
