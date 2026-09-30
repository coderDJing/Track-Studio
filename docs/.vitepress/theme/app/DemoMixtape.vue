<script setup lang="ts">
// 官网 Mixtape 章节：直接渲染应用原版 Mixtape 自动录制窗口（src/renderer/src/Mixtape.vue）。
// 项目数据由 demoMixtapeIpc 按 mixtape:list 的真实格式提供，波形走 unified-display-waveform-cache:batch。
import './demoMixtapeIpc'
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { withBase } from 'vitepress'
import MixtapeWindow from '@renderer/Mixtape.vue'
import { DEMO_MIXTAPE_PLAYLIST_ID } from './demoMixtapeIpc'
import { registerDemoUnifiedWaveform } from './demoIpc'
import { loadDemoUnifiedWaveforms } from './demoSongs'

const ready = ref(false)
const rootRef = ref<HTMLDivElement | null>(null)
let titleObserver: MutationObserver | null = null
let visibilityObserver: IntersectionObserver | null = null

const syncPlayback = (visible: boolean) => {
  const button = rootRef.value?.querySelector<HTMLButtonElement>('.timeline-stop-btn')
  if (!button) return
  if (visible && button.querySelector('polygon')) button.click()
  if (!visible && button.querySelector('rect')) button.click()
}

onUnmounted(() => {
  syncPlayback(false)
  visibilityObserver?.disconnect()
  titleObserver?.disconnect()
})

onMounted(async () => {
  // Mixtape 窗口会把自己的标题写进 document.title，嵌进官网后要还原
  const originalTitle = document.title
  titleObserver = new MutationObserver(() => {
    if (document.title !== originalTitle) document.title = originalTitle
  })
  const titleEl = document.querySelector('title')
  if (titleEl)
    titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true })
  // Mixtape 窗口从地址栏读 playlistId；官网里改成读自己的演示项目，读完再还原地址
  const url = new URL(window.location.href)
  const originalSearch = url.search
  url.searchParams.set('playlistId', DEMO_MIXTAPE_PLAYLIST_ID)
  url.searchParams.set('playlistName', 'Peak Time Mix')
  try {
    const waveforms = await loadDemoUnifiedWaveforms(withBase('/assets/unified-waveforms/'))
    waveforms.forEach(({ filePath, data }) => registerDemoUnifiedWaveform(filePath, data))
  } catch (error) {
    console.error('Failed to load mixtape waveforms:', error)
  }
  window.history.replaceState(window.history.state, '', url)
  ready.value = true
  await nextTick()
  visibilityObserver = new IntersectionObserver((entries) => {
    syncPlayback(entries.some((entry) => entry.isIntersecting))
  })
  if (rootRef.value) visibilityObserver.observe(rootRef.value)
  requestAnimationFrame(() => {
    const restore = new URL(window.location.href)
    restore.search = originalSearch
    window.history.replaceState(window.history.state, '', restore)
  })
})
</script>

<template>
  <div ref="rootRef" class="frkb-app theme-dark demo-mixtape">
    <MixtapeWindow v-if="ready" />
  </div>
</template>

<style scoped>
.demo-mixtape {
  height: 100%;
  overflow: hidden;
}

/* Mixtape 窗口本身按 100vh 布局；嵌进章节后改成铺满这块区域。
   外层 grid/flex 子项默认 min-width:auto，会被时间线画布撑宽，这里收回到容器宽度 */
.demo-mixtape {
  min-width: 0;
  width: 100%;
}

.demo-mixtape :deep(.mixtape-shell) {
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
}

/* 桌面窗口标题栏原本使用 100vw，嵌入官网后按演示窗口宽度布局。 */
.demo-mixtape :deep(.titleComponent) {
  width: 100%;
}

/* mixtape-shell 是 flex 列，里面 display:block 的子项会被时间线画布撑开，
   应用里窗口宽度固定所以看不出来；嵌进官网后要显式收住宽度 */
.demo-mixtape :deep(.mixtape-shell > *),
.demo-mixtape :deep(.mixtape-window),
.demo-mixtape :deep(.mixtape-body > *) {
  min-width: 0;
  max-width: 100%;
}
</style>
