<script setup lang="ts">
// 官网“去重与分析”章节：直接渲染应用原版 confirmDialog，按歌单右键“指纹去重”的真实流程
// 轮流显示“去重确认”与“去重完成”两个弹窗（文案全部取应用 i18n，与 useLibraryContextMenu.ts 一致）。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ConfirmDialog from '@renderer/components/confirmDialog.vue'
import { t } from '@renderer/utils/translate'

type Phase = 'confirm' | 'done'
const phase = ref<Phase>('confirm')
// 每次切换都换 key，让弹窗重新走一遍应用自己的进场动画
const cycle = ref(0)

// 摘要行的顺序、键名与 useLibraryContextMenu.ts 里去重完成弹窗一致
const confirmContent = computed(() => [t('playlist.deduplicateConfirm')])
const doneContent = computed(() => [
  t('playlist.deduplicateScannedCount', { n: 312 }),
  t('playlist.deduplicateRemovedCount', { n: 27 }),
  t('playlist.deduplicateModeUsed', { mode: t('fingerprints.modePCM') })
])

const rootRef = ref<HTMLDivElement | null>(null)
let timer: ReturnType<typeof setInterval> | null = null
let intersectionObserver: IntersectionObserver | null = null

const start = () => {
  if (timer || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  timer = setInterval(() => {
    phase.value = phase.value === 'confirm' ? 'done' : 'confirm'
    cycle.value += 1
  }, 3600)
}
const stop = () => {
  if (timer) clearInterval(timer)
  timer = null
}

onMounted(() => {
  intersectionObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) start()
    else stop()
  })
  if (rootRef.value) intersectionObserver.observe(rootRef.value)
})
onUnmounted(() => {
  stop()
  intersectionObserver?.disconnect()
})
</script>

<template>
  <div ref="rootRef" class="frkb-app theme-dark frkb-app--dialog-host">
    <ConfirmDialog
      v-if="phase === 'confirm'"
      :key="`confirm-${cycle}`"
      :title="t('playlist.deduplicateConfirmTitle')"
      :content="confirmContent"
    />
    <ConfirmDialog
      v-else
      :key="`done-${cycle}`"
      :title="t('playlist.deduplicateFinished')"
      :content="doneContent"
      :confirm-show="false"
    />
  </div>
</template>
