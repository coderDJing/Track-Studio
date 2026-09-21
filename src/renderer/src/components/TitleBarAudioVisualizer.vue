<script setup lang="ts">
import type { TitleAudioVisualizerMode } from 'src/types/globals'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'
import {
  resolveTitleAudioVisualizerAnalyser,
  type TitleAudioVisualizerAnalyserLike,
  type TitleAudioVisualizerTarget
} from '@renderer/composables/titleAudioVisualizerBridge'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  target: TitleAudioVisualizerTarget
}>()

const runtime = useRuntimeStore()
const canvasRef = ref<HTMLCanvasElement | null>(null)
const modeKeyByTarget = {
  mainWindow: 'mainWindowTitleAudioVisualizerMode',
  mixtapeWindow: 'mixtapeWindowTitleAudioVisualizerMode'
} as const
const BAR_COUNT = 15
const LINE_SAMPLE_COUNT = 44
const MIN_BAR_RATIO = 0.12
const FRAME_INTERVAL_MS = 1000 / 60
const BAR_RISE_BASE = 0.18
const BAR_FALL_BASE = 0.08
const LINE_RISE_FACTOR = 0.52
const LINE_FALL_FACTOR = 0.3

let frameRequestId = 0
let lastFrameAt = 0
let frequencyData = new Uint8Array(0)
let timeDomainData = new Uint8Array(0)
let barLevels: number[] = Array.from({ length: BAR_COUNT }, () => MIN_BAR_RATIO)
let lineLevels: number[] = Array.from({ length: LINE_SAMPLE_COUNT }, () => 0)

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const visible = computed(() => runtime.setting.showTitleAudioVisualizer !== false)

const mode = computed<TitleAudioVisualizerMode>({
  get: () => {
    const raw = runtime.setting[modeKeyByTarget[props.target]]
    return raw === 'line' ? 'line' : 'bars'
  },
  set: (value) => {
    runtime.setting[modeKeyByTarget[props.target]] = value
  }
})

const tooltip = computed(() => {
  const modeLabel =
    mode.value === 'bars'
      ? t('player.titleAudioVisualizerModeBars')
      : t('player.titleAudioVisualizerModeLine')
  return `${modeLabel} · ${t('player.titleAudioVisualizerToggleHint')}`
})

const stopLoop = () => {
  if (!frameRequestId) return
  cancelAnimationFrame(frameRequestId)
  frameRequestId = 0
}

const queueFrame = () => {
  frameRequestId = requestAnimationFrame(renderFrame)
}

const ensureCanvasSize = (canvas: HTMLCanvasElement) => {
  const width = Math.max(1, Math.round(canvas.clientWidth))
  const height = Math.max(1, Math.round(canvas.clientHeight))
  const ratio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
  const scaledWidth = Math.round(width * ratio)
  const scaledHeight = Math.round(height * ratio)
  if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
    canvas.width = scaledWidth
    canvas.height = scaledHeight
  }
  return { width, height, ratio }
}

const ensureAnalyserBuffers = (analyser: TitleAudioVisualizerAnalyserLike) => {
  if (frequencyData.length !== analyser.frequencyBinCount) {
    frequencyData = new Uint8Array(analyser.frequencyBinCount)
  }
  if (timeDomainData.length !== analyser.fftSize) {
    timeDomainData = new Uint8Array(analyser.fftSize)
  }
}

const resolveSignalMetrics = (analyser: TitleAudioVisualizerAnalyserLike | null) => {
  if (!analyser) {
    return { analyser: null, active: false, deviationAverage: 0, energyBoost: 1 }
  }
  ensureAnalyserBuffers(analyser)
  analyser.getByteFrequencyData(frequencyData)
  analyser.getByteTimeDomainData(timeDomainData)
  let deviationTotal = 0
  for (let index = 0; index < timeDomainData.length; index += 1) {
    deviationTotal += Math.abs(timeDomainData[index] - 128)
  }
  const deviationAverage = deviationTotal / Math.max(1, timeDomainData.length)
  const active = deviationAverage > 1.2
  const energyBoost = Math.max(1, Math.min(2.1, 1 + deviationAverage / 9))
  return { analyser, active, deviationAverage, energyBoost }
}

const drawBars = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  active: boolean,
  energyBoost: number,
  accentColor: string,
  idleColor: string
) => {
  const gap = 2
  const barWidth = Math.max(1, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT)
  const bottom = height
  for (let barIndex = 0; barIndex < BAR_COUNT; barIndex += 1) {
    const start = Math.max(1, Math.floor((barIndex * frequencyData.length) / BAR_COUNT))
    const end = Math.max(start + 1, Math.floor(((barIndex + 1) * frequencyData.length) / BAR_COUNT))
    let sum = 0
    let peak = 0
    for (let index = start; index < end; index += 1) {
      const value = frequencyData[index] || 0
      sum += value
      if (value > peak) peak = value
    }
    const average = sum / Math.max(1, end - start)
    const normalizedAverage = average / 255
    const normalizedPeak = peak / 255
    const transientBlend = normalizedAverage * 0.82 + normalizedPeak * 0.18
    const response = Math.pow(clamp01(transientBlend), 0.68)
    const lowBandCompensation = 0.76 + (barIndex / Math.max(1, BAR_COUNT - 1)) * 0.38
    const boosted = clamp01(response * Math.min(1.65, energyBoost * 0.96) * lowBandCompensation)
    const target = active ? MIN_BAR_RATIO + boosted * (1 - MIN_BAR_RATIO) : MIN_BAR_RATIO
    const current = barLevels[barIndex] ?? MIN_BAR_RATIO
    const nextLevel =
      target >= current
        ? Math.min(target, current + BAR_RISE_BASE + (target - current) * 0.55)
        : Math.max(target, current - (BAR_FALL_BASE + current * 0.12))
    barLevels[barIndex] = nextLevel
    const barHeight = Math.max(height * MIN_BAR_RATIO, height * nextLevel)
    const x = barIndex * (barWidth + gap)
    const y = bottom - barHeight
    ctx.fillStyle = active ? accentColor : idleColor
    ctx.fillRect(x, y, barWidth, barHeight)
  }
}

const drawLine = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  active: boolean,
  energyBoost: number,
  accentColor: string,
  idleColor: string
) => {
  const centerY = height / 2
  ctx.beginPath()
  for (let pointIndex = 0; pointIndex < LINE_SAMPLE_COUNT; pointIndex += 1) {
    const sampleIndex = Math.floor((pointIndex * timeDomainData.length) / LINE_SAMPLE_COUNT)
    const raw = ((timeDomainData[sampleIndex] || 128) - 128) / 128
    const boosted = Math.max(-1, Math.min(1, raw * (0.84 + (energyBoost - 1) * 0.82)))
    const target = active ? boosted : 0
    const current = lineLevels[pointIndex] ?? 0
    const nextLevel =
      Math.abs(target) >= Math.abs(current)
        ? current + (target - current) * LINE_RISE_FACTOR
        : current + (target - current) * LINE_FALL_FACTOR
    lineLevels[pointIndex] = nextLevel
    const x =
      LINE_SAMPLE_COUNT <= 1 ? 0 : (pointIndex / (LINE_SAMPLE_COUNT - 1)) * Math.max(0, width)
    const y = centerY - nextLevel * (height * 0.4)
    if (pointIndex === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  }
  ctx.strokeStyle = active ? accentColor : idleColor
  ctx.lineWidth = active ? 1.65 : 1.15
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.stroke()
}

const renderFrame = (timestamp = 0) => {
  frameRequestId = 0
  if (!visible.value) return
  if (timestamp - lastFrameAt < FRAME_INTERVAL_MS) {
    queueFrame()
    return
  }
  lastFrameAt = timestamp

  const canvas = canvasRef.value
  if (!canvas) {
    queueFrame()
    return
  }
  const context = canvas.getContext('2d')
  if (!context) {
    queueFrame()
    return
  }

  const { width, height, ratio } = ensureCanvasSize(canvas)
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)

  const styles = getComputedStyle(document.documentElement)
  const accentColor = styles.getPropertyValue('--accent').trim() || '#0078d4'
  const idleColor = styles.getPropertyValue('--text-weak').trim() || '#8c8c8c'
  const analyser = resolveTitleAudioVisualizerAnalyser(props.target)
  const { active, energyBoost } = resolveSignalMetrics(analyser)

  if (mode.value === 'line') {
    drawLine(context, width, height, active, energyBoost, accentColor, idleColor)
  } else {
    drawBars(context, width, height, active, energyBoost, accentColor, idleColor)
  }

  queueFrame()
}

const startLoop = () => {
  if (!visible.value || frameRequestId) return
  lastFrameAt = 0
  queueFrame()
}

const toggleMode = () => {
  mode.value = mode.value === 'bars' ? 'line' : 'bars'
}

watch(
  visible,
  (nextVisible) => {
    if (nextVisible) {
      startLoop()
      return
    }
    stopLoop()
  },
  { immediate: true }
)

watch(mode, () => {
  if (!visible.value) return
  barLevels = Array.from({ length: BAR_COUNT }, () => MIN_BAR_RATIO)
  lineLevels = Array.from({ length: LINE_SAMPLE_COUNT }, () => 0)
})

onBeforeUnmount(() => {
  stopLoop()
})
</script>

<template>
  <bubbleBoxTrigger
    v-if="visible"
    tag="button"
    type="button"
    class="title-audio-visualizer canNotDrag"
    :title="tooltip"
    :aria-label="tooltip"
    @click.stop="toggleMode"
  >
    <canvas ref="canvasRef" class="title-audio-visualizer__canvas"></canvas>
  </bubbleBoxTrigger>
</template>

<style scoped lang="scss">
.title-audio-visualizer {
  width: 98px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background-color: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.title-audio-visualizer:hover {
  background-color: var(--hover);
  border-color: var(--border);
}

.title-audio-visualizer:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
}

.title-audio-visualizer__canvas {
  width: 100%;
  height: 18px;
  display: block;
}
</style>
