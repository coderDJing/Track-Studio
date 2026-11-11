<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import utils from '@renderer/utils/utils'

const props = defineProps<{
  title: string
  stageText: string
  percent: number
}>()

const emit = defineEmits<{
  (event: 'cancel'): void
}>()

const scope = uuidV4()
const { dialogVisible } = useDialogTransition()

const cancelRequested = ref(false)
const startedAtMs = Date.now()
const nowMs = ref(startedAtMs)
const percentSamples = ref<Array<{ atMs: number; percent: number }>>([])
let tickTimer: number | null = null

const normalizedPercent = computed(() => {
  const value = Number(props.percent)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
})

const progressFillStyle = computed(() => ({ width: `${normalizedPercent.value}%` }))

const formatDuration = (ms: number) => {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

const elapsedText = computed(() =>
  t('mixtape.outputProgressElapsed', { time: formatDuration(nowMs.value - startedAtMs) })
)

// 剩余时间只用实测进度速率推算，取窗口内最早样本做基准，避免单次抖动算飞。
const remainingText = computed(() => {
  const percent = normalizedPercent.value
  if (percent >= 100) return ''
  const samples = percentSamples.value
  const latest = samples[samples.length - 1]
  if (!latest) return ''
  const earliest = samples[0]
  const spanMs = latest.atMs - earliest.atMs
  if (spanMs < 4000) return ''
  const deltaPercent = latest.percent - earliest.percent
  if (!(deltaPercent > 0)) return ''
  const remainingMs = ((100 - percent) * spanMs) / deltaPercent
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return ''
  return t('mixtape.outputProgressRemaining', { time: formatDuration(remainingMs) })
})

const timingText = computed(() =>
  [elapsedText.value, remainingText.value].filter((item) => !!item).join(' · ')
)

const cancelLabel = computed(() =>
  cancelRequested.value ? t('mixtape.outputProgressCancelling') : `${t('common.cancel')} (Esc)`
)

const requestCancel = () => {
  if (cancelRequested.value) return
  cancelRequested.value = true
  emit('cancel')
}

onMounted(() => {
  tickTimer = window.setInterval(() => {
    nowMs.value = Date.now()
    percentSamples.value.push({ atMs: nowMs.value, percent: normalizedPercent.value })
    if (percentSamples.value.length > 12) percentSamples.value.shift()
  }, 1000)
  hotkeys('Esc', scope, () => {
    requestCancel()
    return false
  })
  utils.setHotkeysScpoe(scope)
})

onUnmounted(() => {
  if (tickTimer !== null) {
    window.clearInterval(tickTimer)
    tickTimer = null
  }
  utils.delHotkeysScope(scope)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      v-dialog-drag="'.dialog-title'"
      class="inner mixtape-output-progress"
      style="width: 440px; display: flex; flex-direction: column"
    >
      <div class="dialog-title dialog-header">
        <span>{{ title }}</span>
      </div>
      <div class="mixtape-output-progress__body">
        <div class="mixtape-output-progress__percent">
          {{ normalizedPercent }}<span class="mixtape-output-progress__percent-unit">%</span>
        </div>
        <div
          class="mixtape-output-progress__bar"
          role="progressbar"
          :aria-valuenow="normalizedPercent"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div class="mixtape-output-progress__fill" :style="progressFillStyle"></div>
        </div>
        <div class="mixtape-output-progress__stage">{{ stageText }}</div>
        <div v-if="timingText" class="mixtape-output-progress__timing">{{ timingText }}</div>
      </div>
      <div class="dialog-footer mixtape-output-progress__footer">
        <div
          class="button mixtape-output-progress__action"
          :class="{ 'is-busy': cancelRequested }"
          @click="requestCancel"
        >
          {{ cancelLabel }}
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.mixtape-output-progress__body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 18px 22px 14px;
}

.mixtape-output-progress__percent {
  font-size: 30px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.mixtape-output-progress__percent-unit {
  margin-left: 2px;
  font-size: 16px;
  font-weight: 500;
  color: var(--text-secondary);
}

.mixtape-output-progress__bar {
  box-sizing: border-box;
  width: 100%;
  height: 8px;
  border-radius: 999px;
  background: var(--mixtape-mask-rail, var(--hover));
  overflow: hidden;
}

.mixtape-output-progress__fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.18s ease;
}

.mixtape-output-progress__stage {
  font-size: 13px;
  color: var(--text);
  text-align: center;
  overflow-wrap: anywhere;
}

.mixtape-output-progress__timing {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.mixtape-output-progress__footer {
  justify-content: center;
}

.mixtape-output-progress__action {
  min-width: 132px;
  box-sizing: border-box;
  text-align: center;
}

.mixtape-output-progress__action.is-busy {
  opacity: 0.6;
  pointer-events: none;
}
</style>
