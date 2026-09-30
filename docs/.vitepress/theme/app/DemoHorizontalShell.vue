<script setup lang="ts">
// 官网首屏：直接渲染应用双轨横推模式的真实组件。
// 外壳结构照抄 src/renderer/src/components/HorizontalBrowseModeShell.vue 的模板与样式
// （HorizontalBrowseModeShell.scss），子组件全部是应用原件：
// HorizontalBrowseDeckControlRow / HorizontalBrowseFaderPanel / HorizontalBrowseModeShellWaveformStack。
// 真实 ModeShell 依赖主进程音频传输，这里换成 useDemoHorizontalShellModel 提供的演示状态。
import { onMounted, onUnmounted, ref } from 'vue'
import HorizontalBrowseDeckControlRow from '@renderer/components/HorizontalBrowseDeckControlRow.vue'
import HorizontalBrowseFaderPanel from '@renderer/components/HorizontalBrowseFaderPanel.vue'
import HorizontalBrowseModeShellWaveformStack from '@renderer/components/HorizontalBrowseModeShellWaveformStack.vue'
import { useDemoHorizontalShellModel } from './useDemoHorizontalShellModel'

const demo = useDemoHorizontalShellModel()
const rootRef = ref<HTMLDivElement | null>(null)
const faderControlsExpanded = ref(false)
let intersectionObserver: IntersectionObserver | null = null

onMounted(() => {
  void demo.init()
  // 只在首屏可见时推进播放，离开视口就暂停
  intersectionObserver = new IntersectionObserver((entries) => {
    demo.setVisible(entries.some((entry) => entry.isIntersecting))
  })
  if (rootRef.value) intersectionObserver.observe(rootRef.value)
})

onUnmounted(() => {
  intersectionObserver?.disconnect()
  demo.dispose()
})
</script>

<template>
  <div ref="rootRef" class="frkb-app theme-dark demo-shell-host">
    <div class="horizontal-shell" :class="{ 'is-fader-controls-expanded': faderControlsExpanded }">
      <div class="controls">
        <HorizontalBrowseDeckControlRow
          deck="top"
          :playing="demo.playing.value"
          :decoding="false"
          :pending-play="false"
          :pending-cue="false"
          :cue-active="false"
          :bands-visible="faderControlsExpanded"
          :bands="demo.deckBandState.top"
          :song-present="true"
          :show-cue="true"
          :cue-monitor-enabled="false"
          @play-toggle="demo.togglePlay"
        />
        <HorizontalBrowseFaderPanel
          v-model:expanded="faderControlsExpanded"
          :native-transport="demo.faderTransport"
          :main-window-volume="1"
          :transport-sync-enabled="true"
          :transport-sync-disabled="false"
        />
        <HorizontalBrowseDeckControlRow
          deck="bottom"
          :playing="demo.playing.value"
          :decoding="false"
          :pending-play="false"
          :pending-cue="false"
          :cue-active="false"
          :bands-visible="faderControlsExpanded"
          :bands="demo.deckBandState.bottom"
          :song-present="true"
          :show-cue="true"
          :cue-monitor-enabled="false"
          @play-toggle="demo.togglePlay"
        />
      </div>
      <HorizontalBrowseModeShellWaveformStack :model="demo.model" />
    </div>
  </div>
</template>

<!-- 应用双轨外壳的原样式；:deep 选择器照常作用于子组件 -->
<style scoped lang="scss" src="@renderer/components/HorizontalBrowseModeShell.scss"></style>
<style scoped lang="scss">
.demo-shell-host {
  // 与 App.vue 中双轨外壳的固定高度一致
  --horizontal-browse-shell-height: 372px;
  --horizontal-browse-side-panel-width: calc((372px - 1px) / 2);
  height: 372px;

  :deep(.fader-panel .fader) {
    pointer-events: none;
  }
}

@media (max-width: 700px) {
  .demo-shell-host {
    min-width: 960px;
  }
}
</style>
