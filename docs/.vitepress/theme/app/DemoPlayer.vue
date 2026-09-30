<script setup lang="ts">
// 播放章节直接组合应用播放器使用的控制区、封面、波形概览和段落条。
import { defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue'
import { withBase } from 'vitepress'
import PlayerCoverSlot from '@renderer/pages/modules/songPlayer/PlayerCoverSlot.vue'
import HorizontalBrowseWaveformOverview from '@renderer/components/HorizontalBrowseWaveformOverview.vue'
import { DEMO_TRACKS, loadDemoUnifiedWaveforms } from './demoSongs'
import { registerDemoUnifiedWaveform } from './demoIpc'

const track = DEMO_TRACKS[0]
const PlayerControls = defineAsyncComponent(() => import('@renderer/components/playerControls.vue'))
const currentSeconds = ref(track.startSec)
const ready = ref(false)
const playing = ref(true)
const rootRef = ref<HTMLDivElement | null>(null)
let frame = 0
let lastTime = 0
let visible = false
let observer: IntersectionObserver | null = null

const tick = (time: number) => {
  if (!visible || !playing.value) return
  if (lastTime)
    currentSeconds.value =
      (currentSeconds.value + Math.min(0.05, (time - lastTime) / 1000) * 6) % track.durationSec
  lastTime = time
  frame = requestAnimationFrame(tick)
}

const syncAnimation = () => {
  cancelAnimationFrame(frame)
  lastTime = 0
  if (visible && playing.value && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    frame = requestAnimationFrame(tick)
  }
}

const handlePlay = () => {
  playing.value = true
  syncAnimation()
}

const handlePause = () => {
  playing.value = false
  syncAnimation()
}

onMounted(async () => {
  const waveforms = await loadDemoUnifiedWaveforms(withBase('/assets/unified-waveforms/'))
  waveforms.forEach(({ filePath, data }) => registerDemoUnifiedWaveform(filePath, data))
  ready.value = true
  observer = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting)
    syncAnimation()
  })
  if (rootRef.value) observer.observe(rootRef.value)
})

onUnmounted(() => {
  observer?.disconnect()
  cancelAnimationFrame(frame)
})
</script>

<template>
  <div ref="rootRef" class="frkb-app theme-dark demo-player">
    <div class="demo-player__list"><slot /></div>
    <div class="demo-player__bar">
      <PlayerCoverSlot cover-blob-url="" :placeholder-src="withBase('/assets/icon.webp')" />
      <div class="demo-player__controls">
        <PlayerControls v-if="ready" :playing="playing" @play="handlePlay" @pause="handlePause" />
      </div>
      <div class="demo-player__waveform">
        <HorizontalBrowseWaveformOverview
          v-if="ready"
          :song="track.song"
          :current-seconds="currentSeconds"
          :duration-seconds="track.durationSec"
          :hot-cues="track.song.hotCues"
          :memory-cues="track.song.memoryCues"
          @seek="currentSeconds = $event"
          @seek-play="currentSeconds = $event"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.demo-player {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
}
.demo-player__list {
  flex: 1 1 auto;
  min-height: 0;
}
.demo-player__bar {
  display: flex;
  align-items: center;
  height: 64px;
  min-width: 0;
  border-top: 1px solid var(--border);
}
.demo-player__controls {
  flex: 0 0 280px;
}
.demo-player__waveform {
  flex: 1 1 auto;
  height: 52px;
  min-width: 0;
}
@media (max-width: 700px) {
  .demo-player__bar {
    min-width: 700px;
  }
}
</style>
