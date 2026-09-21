<script setup lang="ts">
import { computed } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'

const props = defineProps<{
  visible: boolean
  title: string
  text: string
  percent: number
  hint: string
}>()

const runtime = useRuntimeStore()
const clampedPercent = computed(() =>
  Math.max(0, Math.min(100, Math.round((props.percent || 0) * 10) / 10))
)
const percentText = computed(() =>
  Number.isInteger(clampedPercent.value)
    ? String(clampedPercent.value)
    : clampedPercent.value.toFixed(1)
)
const shouldRender = computed(
  () => props.visible && !runtime.analysisRuntime.downloadOverlayMinimized
)

const minimizeOverlay = () => {
  runtime.setAnalysisRuntimeDownloadOverlayMinimized(true)
}
</script>

<template>
  <div v-if="shouldRender" class="analysis-runtime-download-mask">
    <div class="analysis-runtime-download-card">
      <div class="analysis-runtime-download-header">
        <div class="analysis-runtime-download-title">{{ title }}</div>
        <button class="analysis-runtime-download-minimize" type="button" @click="minimizeOverlay">
          {{ t('analysisRuntime.minimizeOverlay') }}
        </button>
      </div>
      <div class="analysis-runtime-download-hint">{{ hint }}</div>
      <div class="analysis-runtime-download-text">{{ text }}</div>
      <div class="analysis-runtime-download-progress-row">
        <span>{{ percentText }}%</span>
      </div>
      <div class="analysis-runtime-download-progress">
        <div
          class="analysis-runtime-download-progress__fill"
          :style="{ width: `${clampedPercent}%` }"
        ></div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.analysis-runtime-download-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-blocking-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
  background: rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(10px);
  cursor: progress;
}

.analysis-runtime-download-card {
  width: min(480px, 100%);
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elev);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.analysis-runtime-download-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.analysis-runtime-download-title {
  flex: 1 1 auto;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
}

.analysis-runtime-download-minimize {
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
  border-radius: 6px;
  padding: 4px 10px;
  background: color-mix(in srgb, var(--bg) 76%, transparent);
  color: var(--text-weak);
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.analysis-runtime-download-minimize:hover {
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, var(--bg));
  color: var(--text);
}

.analysis-runtime-download-hint,
.analysis-runtime-download-text {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-weak);
  overflow-wrap: anywhere;
}

.analysis-runtime-download-progress-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  font-size: 12px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.analysis-runtime-download-progress {
  width: 100%;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(127, 127, 127, 0.18);
}

.analysis-runtime-download-progress__fill {
  height: 100%;
  width: 0;
  background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 72%, #ffffff));
  transition: width 0.2s ease;
}
</style>
