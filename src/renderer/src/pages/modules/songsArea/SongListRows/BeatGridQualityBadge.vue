<script setup lang="ts">
import { computed } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { resolveBeatGridQualityBadge } from '@renderer/utils/beatGridQualityDisplay'

const props = defineProps<{
  song: ISongInfo
}>()

// 正常网格没有质量标记，组件整体不渲染，列表里不占位置。
const badge = computed(() => resolveBeatGridQualityBadge(props.song))
</script>

<template>
  <bubbleBoxTrigger
    v-if="badge"
    tag="span"
    class="beat-grid-quality-badge"
    :title="badge.detailText"
  >
    <span class="beat-grid-quality-dot" />
  </bubbleBoxTrigger>
</template>

<style scoped lang="scss">
/* 圆点本身很小，padding 撑开 hover 命中区，不影响视觉 */
.beat-grid-quality-badge {
  flex: 0 0 auto;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  padding: 4px;
  cursor: default;
}

.beat-grid-quality-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--beat-grid-quality-dot);
  box-shadow: 0 0 0 3px var(--beat-grid-quality-dot-halo);
}
</style>
