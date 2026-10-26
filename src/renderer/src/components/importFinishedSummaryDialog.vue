<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

const props = defineProps<{
  summary: {
    startAt: string
    endAt: string
    durationMs: number
    scannedCount: number
    analyzeFailedCount: number
    importedToPlaylistCount: number
    duplicatesRemovedCount: number
    fingerprintAddedCount: number
    fingerprintAlreadyExistingCount: number
    fingerprintTotalBefore: number
    fingerprintTotalAfter: number
    isComparisonSongFingerprint: boolean
    isPushSongFingerprintLibrary: boolean
    hideOverviewSection?: boolean
  } | null
}>()
const emits = defineEmits(['close'])
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const close = () => closeWithAnimation(() => emits('close'))

const formatDurationSec = (ms: number) => {
  const seconds = ms / 1000
  if (seconds >= 10) return String(Math.round(seconds))
  return String(Math.round(seconds * 10) / 10)
}

const hasFingerprintSection = computed(() => {
  return !!props.summary && props.summary.isPushSongFingerprintLibrary === true
})

const showOverviewSection = computed(() => {
  if (!props.summary) return false
  return props.summary.hideOverviewSection !== true
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="title dialog-title dialog-header">{{ t('import.completed') }}</div>
      <div class="stats-body">
        <div class="stats">
          <div v-if="showOverviewSection" class="section">
            <div class="section-title">{{ t('import.overview') }}</div>
            <div class="chips">
              <div class="chip">
                <div class="num">{{ summary?.importedToPlaylistCount || 0 }}</div>
                <div class="cap">{{ t('import.importedToPlaylist') }}</div>
              </div>
              <div class="chip">
                <div class="num">{{ summary?.duplicatesRemovedCount || 0 }}</div>
                <div class="cap">{{ t('import.removedSkippedDuplicates') }}</div>
              </div>
              <div class="chip" :class="{ danger: (summary?.analyzeFailedCount || 0) > 0 }">
                <div class="num">{{ summary?.analyzeFailedCount || 0 }}</div>
                <div class="cap">{{ t('import.analysisFailed') }}</div>
              </div>
              <div class="chip">
                <div class="num">{{ formatDurationSec(summary?.durationMs || 0) }}</div>
                <div class="cap">{{ t('cloudSync.duration') }} ({{ t('player.seconds') }})</div>
              </div>
            </div>
          </div>
          <div v-if="hasFingerprintSection" class="section">
            <div class="section-title">{{ t('import.fingerprintChanges') }}</div>
            <div class="chips">
              <div class="chip" :class="{ success: (summary?.fingerprintAddedCount || 0) > 0 }">
                <div class="num">{{ summary?.fingerprintAddedCount || 0 }}</div>
                <div class="cap">{{ t('import.newFingerprints') }}</div>
              </div>
              <div class="chip">
                <div class="num">{{ summary?.fingerprintAlreadyExistingCount || 0 }}</div>
                <div class="cap">{{ t('import.alreadyExists') }}</div>
              </div>
            </div>
          </div>
          <div v-if="hasFingerprintSection" class="section">
            <div class="section-title">{{ t('import.totalFingerprints') }}</div>
            <div class="section-body">
              <span class="count-pair">
                <span class="count-text">{{ summary?.fingerprintTotalBefore || 0 }}</span>
                <span class="arrow" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path
                      d="M5 12h12M13 6l6 6-6 6"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    ></path>
                  </svg>
                </span>
                <span class="count-text">{{ summary?.fingerprintTotalAfter || 0 }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" @click="close">{{ t('common.close') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 520px;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.title {
  color: var(--text);
}
.stats-body {
  overflow-y: auto;
  overflow-wrap: anywhere;
  padding: 20px;
  flex: 1;
  min-height: 0;
}
.stats {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 12px;
  color: var(--text);
}
.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.section-title {
  font-size: 13px;
  color: var(--text);
  font-weight: 700;
  letter-spacing: 0.2px;
}
.section-body {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.row .label {
  width: 90px;
  min-width: 90px;
  text-align: right;
  color: var(--text-weak);
}
.row .value {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.chips {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.chip {
  min-width: 96px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
  display: inline-flex;
  flex-direction: column;
  align-items: center;
}
.chip .num {
  font-size: 18px;
  color: var(--text);
  font-weight: 700;
  line-height: 1;
}
.chip .cap {
  font-size: 11px;
  color: var(--text-weak);
  margin-top: 4px;
}
.chip.danger .num {
  color: var(--danger-text);
}
.chip.success .num {
  color: var(--success-text);
}
.big {
  font-size: 14px;
  color: var(--text);
  font-weight: 600;
}
.muted {
  color: var(--text-weak);
}
.count-pair {
  display: inline-flex;
  align-items: center;
  line-height: 14px;
  height: 14px;
  color: var(--text);
}
.count-pair > .count-text {
  display: inline-flex;
  align-items: center;
  line-height: 14px;
  height: 14px;
  color: var(--text);
}
.arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin: 0 6px;
  line-height: 14px;
  vertical-align: middle;
}
.arrow svg {
  width: 14px;
  height: 14px;
  display: block;
}
</style>
