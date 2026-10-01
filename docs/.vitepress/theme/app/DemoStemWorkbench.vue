<script setup lang="ts">
// 官网 Stem 章节：直接渲染应用原版 libraryStemSeparationDialog。
// 分离状态由 demoStemIpc 按主进程推送格式驱动，离开视口时停在“就绪”画面。
import { onMounted, onUnmounted, ref } from 'vue'
import LibraryStemSeparationDialog from '@renderer/components/libraryStemSeparationDialog.vue'
import {
  DEMO_STEM_FILE_PATH,
  showDemoStemReady,
  startDemoStemCycle,
  stopDemoStemCycle
} from './demoStemIpc'

const rootRef = ref<HTMLDivElement | null>(null)
let intersectionObserver: IntersectionObserver | null = null

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    showDemoStemReady()
    return
  }
  intersectionObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) startDemoStemCycle()
    else stopDemoStemCycle()
  })
  if (rootRef.value) intersectionObserver.observe(rootRef.value)
})

onUnmounted(() => {
  intersectionObserver?.disconnect()
  stopDemoStemCycle()
})
</script>

<template>
  <div ref="rootRef" class="frkb-app theme-dark frkb-app--dialog-host">
    <LibraryStemSeparationDialog :file-path="DEMO_STEM_FILE_PATH" song-title="Night Shift" />
  </div>
</template>

<style scoped>
/* 应用按窗口大小限制弹窗；官网按演示容器限制，避免手机视口先把原界面压窄再缩放。 */
.frkb-app :deep(.library-stem-dialog__inner) {
  width: min(780px, calc(100% - 32px));
  max-height: calc(100% - 32px);
}
</style>
