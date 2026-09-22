<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'

const props = defineProps<{
  preLimiterPeakLeftDb: number
  preLimiterPeakRightDb: number
  limiterGainReductionDb: number
  limiterOverload: boolean
}>()

const METER_FLOOR_DB = -42
const displayedLevels = ref<[number, number]>([0, 0])
let frameId = 0

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
const peakDb = computed<[number, number]>(() => [
  Math.max(METER_FLOOR_DB, Number(props.preLimiterPeakLeftDb) || METER_FLOOR_DB),
  Math.max(METER_FLOOR_DB, Number(props.preLimiterPeakRightDb) || METER_FLOOR_DB)
])
const targetLevels = computed<[number, number]>(() => [
  clamp01((peakDb.value[0] - METER_FLOOR_DB) / -METER_FLOOR_DB),
  clamp01((peakDb.value[1] - METER_FLOOR_DB) / -METER_FLOOR_DB)
])
const gainReductionDb = computed(() => Math.max(0, Number(props.limiterGainReductionDb) || 0))
const limiterActive = computed(() => props.limiterOverload || gainReductionDb.value >= 0.05)
const meterStyle = computed(() => ({
  '--master-meter-left-level': `${displayedLevels.value[0] * 100}%`,
  '--master-meter-right-level': `${displayedLevels.value[1] * 100}%`
}))
const meterHint = computed(() => {
  const formatPeak = (value: number) =>
    value <= METER_FLOOR_DB
      ? t('horizontalBrowse.masterMeterNoProgramAudio')
      : `${value.toFixed(1)} dBFS`
  const peakText = `L ${formatPeak(peakDb.value[0])} · R ${formatPeak(peakDb.value[1])}`
  if (!limiterActive.value) {
    return t('horizontalBrowse.masterMeterIdle', { peaks: peakText })
  }
  return t('horizontalBrowse.masterMeterActive', {
    peaks: peakText,
    reduction: gainReductionDb.value.toFixed(1)
  })
})

const animate = () => {
  displayedLevels.value = displayedLevels.value.map((current, index) => {
    const target = targetLevels.value[index]
    const factor = target >= current ? 0.74 : 0.13
    const next = current + (target - current) * factor
    return Math.abs(target - next) < 0.002 ? target : next
  }) as [number, number]
  frameId = requestAnimationFrame(animate)
}

watch(
  targetLevels,
  () => {
    if (!frameId) frameId = requestAnimationFrame(animate)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (frameId) cancelAnimationFrame(frameId)
})
</script>

<template>
  <bubbleBoxTrigger tag="span" class="master-meter-anchor" :title="meterHint" :max-width="300">
    <span class="master-meter" :style="meterStyle">
      <span class="master-meter__label">LIMIT</span>
      <span class="master-meter__tracks" :aria-label="t('horizontalBrowse.masterMeterTracks')">
        <span class="master-meter__track master-meter__track--left">
          <span class="master-meter__fill"></span>
          <span class="master-meter__warning"></span>
          <span class="master-meter__ceiling"></span>
        </span>
        <span class="master-meter__track master-meter__track--right">
          <span class="master-meter__fill"></span>
          <span class="master-meter__warning"></span>
          <span class="master-meter__ceiling"></span>
        </span>
      </span>
      <span class="master-meter__reduction">{{
        gainReductionDb > 0.05 ? `${gainReductionDb.toFixed(1)}` : ''
      }}</span>
    </span>
  </bubbleBoxTrigger>
</template>

<style scoped lang="scss">
.master-meter-anchor {
  display: inline-flex;
}

.master-meter {
  min-width: 84px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
  font-size: 8px;
  font-variant-numeric: tabular-nums;
}

.master-meter__label {
  font-size: 7px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.master-meter__track {
  position: relative;
  width: 54px;
  height: 5px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--shell-border) 62%, var(--text-muted) 24%);
  border-radius: 1px;
  background: color-mix(in srgb, var(--text-muted) 28%, var(--shell-panel));
  box-shadow:
    inset 0 1px 1px color-mix(in srgb, var(--bg) 72%, transparent),
    inset 0 -1px 0 color-mix(in srgb, #fff 10%, transparent);
}

.master-meter__fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(
    90deg,
    var(--accent) 0%,
    var(--accent) 70%,
    color-mix(in srgb, var(--accent) 58%, var(--warning, #d6ab4d)) 84%,
    var(--warning, #d6ab4d) 93%,
    var(--danger, #d96a6a) 100%
  );
  background-size: 54px 100%;
  background-position: left center;
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 18%, transparent);
}

.master-meter__track--left .master-meter__fill {
  width: var(--master-meter-left-level);
}

.master-meter__track--right .master-meter__fill {
  width: var(--master-meter-right-level);
}

.master-meter__tracks {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
}

.master-meter__warning,
.master-meter__ceiling {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  pointer-events: none;
}

.master-meter__warning {
  left: 93%;
  background: var(--warning, #d6ab4d);
}

.master-meter__ceiling {
  right: 0;
  background: var(--danger, #d96a6a);
}

.master-meter__reduction {
  min-width: 12px;
  color: var(--danger, #d96a6a);
  text-align: right;
}
</style>
