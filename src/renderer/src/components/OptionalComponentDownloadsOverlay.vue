<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import {
  sanitizeOptionalComponentErrorMessage,
  useOptionalComponentDownloads
} from '@renderer/composables/useOptionalComponentDownloads'
import type { OptionalComponentDownloadState } from '@shared/optionalComponentDownloads'

const {
  entries,
  hasEntries,
  activeCount,
  collapsed,
  toggleCollapsed,
  retry,
  isRetrying,
  labelKeyFor
} = useOptionalComponentDownloads()

const percentOf = (state: OptionalComponentDownloadState) =>
  Math.max(0, Math.min(100, Math.round(state.percent)))

const statusText = (state: OptionalComponentDownloadState) => {
  if (state.status === 'downloading') {
    return t('optionalComponents.statusDownloading', { percent: percentOf(state) })
  }
  if (state.status === 'installing') return t('optionalComponents.statusInstalling')
  if (state.status === 'ready') return t('optionalComponents.statusReady')
  return t('optionalComponents.statusFailed')
}

const badgeText = computed(() => (activeCount.value > 0 ? String(activeCount.value) : ''))

const failureReason = (state: OptionalComponentDownloadState) =>
  sanitizeOptionalComponentErrorMessage(state.error) || t('optionalComponents.statusFailed')
</script>

<template>
  <div v-if="hasEntries" class="optional-downloads">
    <button
      v-if="collapsed"
      class="optional-downloads__pill"
      type="button"
      :aria-label="t('optionalComponents.expand')"
      @click="toggleCollapsed"
    >
      <span class="optional-downloads__pill-text">{{ t('optionalComponents.panelTitle') }}</span>
      <span v-if="badgeText" class="optional-downloads__badge">{{ badgeText }}</span>
    </button>
    <div v-else class="optional-downloads__card">
      <div class="optional-downloads__header">
        <span class="optional-downloads__title">{{ t('optionalComponents.panelTitle') }}</span>
        <button
          class="optional-downloads__collapse"
          type="button"
          :aria-label="t('optionalComponents.collapse')"
          @click="toggleCollapsed"
        >
          {{ t('optionalComponents.collapse') }}
        </button>
      </div>
      <div v-for="entry of entries" :key="entry.id" class="optional-downloads__row">
        <div class="optional-downloads__row-main">
          <span class="optional-downloads__label">{{ t(labelKeyFor(entry.id)) }}</span>
          <bubbleBoxTrigger
            v-if="entry.status === 'failed'"
            tag="span"
            class="optional-downloads__status optional-downloads__status--failed"
            :title="failureReason(entry)"
            :aria-label="failureReason(entry)"
          >
            {{ statusText(entry) }}
          </bubbleBoxTrigger>
          <span
            v-else
            class="optional-downloads__status"
            :class="`optional-downloads__status--${entry.status}`"
          >
            {{ statusText(entry) }}
          </span>
        </div>
        <div v-if="entry.status === 'downloading'" class="optional-downloads__bar">
          <div
            class="optional-downloads__bar-fill"
            :style="{ width: `${percentOf(entry)}%` }"
          ></div>
        </div>
        <div v-else-if="entry.status === 'installing'" class="optional-downloads__bar">
          <div class="optional-downloads__bar-fill optional-downloads__bar-fill--installing"></div>
        </div>
        <button
          v-if="entry.status === 'failed'"
          class="optional-downloads__retry"
          type="button"
          :disabled="isRetrying(entry.id)"
          @click="retry(entry.id)"
        >
          {{ isRetrying(entry.id) ? t('optionalComponents.retrying') : t('common.retry') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.optional-downloads {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: min(320px, calc(100vw - 32px));
  pointer-events: none;
}

.optional-downloads__card,
.optional-downloads__pill {
  pointer-events: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elev);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
}

.optional-downloads__card {
  width: 300px;
  max-width: 100%;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.optional-downloads__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.optional-downloads__title {
  font-size: 13px;
  color: var(--text);
}

.optional-downloads__collapse {
  border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
  border-radius: 6px;
  padding: 2px 8px;
  background: color-mix(in srgb, var(--bg) 76%, transparent);
  color: var(--text-weak);
  font-size: 11px;
  cursor: pointer;
}

.optional-downloads__collapse:hover {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
}

.optional-downloads__row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.optional-downloads__row-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.optional-downloads__label {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.optional-downloads__status {
  flex: 0 0 auto;
  color: var(--text-weak);
  font-variant-numeric: tabular-nums;
}

.optional-downloads__status--failed {
  color: var(--danger, #d9534f);
}

.optional-downloads__status--ready {
  color: var(--accent);
}

.optional-downloads__bar {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(127, 127, 127, 0.18);
}

.optional-downloads__bar-fill {
  height: 100%;
  width: 0;
  background: var(--accent);
  transition: width 0.2s ease;
}

.optional-downloads__bar-fill--installing {
  width: 40%;
  animation: optional-downloads-installing 1.2s ease-in-out infinite;
}

@keyframes optional-downloads-installing {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}

.optional-downloads__retry {
  align-self: flex-end;
  border: 1px solid color-mix(in srgb, var(--accent) 36%, var(--border));
  border-radius: 6px;
  padding: 2px 10px;
  background: color-mix(in srgb, var(--accent) 12%, var(--bg));
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
}

.optional-downloads__retry:disabled {
  opacity: 0.5;
  cursor: default;
}

.optional-downloads__pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  color: var(--text-weak);
  font-size: 12px;
  cursor: pointer;
}

.optional-downloads__pill:hover {
  color: var(--text);
}

.optional-downloads__badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--bg);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}
</style>
