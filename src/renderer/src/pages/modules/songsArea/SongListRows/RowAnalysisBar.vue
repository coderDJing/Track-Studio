<script setup lang="ts">
import { computed, type CSSProperties } from 'vue'
import {
  DYNAMIC_GRID_PHASE_LABEL_KEYS,
  type DynamicGridPublicProgress
} from '@shared/dynamicGridProgress'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'

const props = defineProps<{
  progress: number | null
  viewportWidth: number
  scrollLeft: number
  dynamicGrid?: DynamicGridPublicProgress | null
}>()

const safeProgress = computed(() => {
  if (props.progress == null) return null
  return Math.min(100, Math.max(0, Math.round(props.progress)))
})

const barStyle = computed<CSSProperties>(() => {
  const progress = safeProgress.value ?? 0
  const viewportWidth = Math.max(0, Math.floor(props.viewportWidth || 0))
  const scrollLeft = Math.max(0, Math.round(props.scrollLeft || 0))
  const width = progress === 0 ? viewportWidth : Math.round((viewportWidth * progress) / 100)

  return {
    width: `${width}px`,
    transform: `translateX(${scrollLeft}px)`
  }
})

const phaseLabel = computed(() =>
  props.dynamicGrid ? t(DYNAMIC_GRID_PHASE_LABEL_KEYS[props.dynamicGrid.phase]) : ''
)

const windowText = computed(() => {
  const grid = props.dynamicGrid
  if (
    !grid ||
    typeof grid.completedWindows !== 'number' ||
    typeof grid.totalWindows !== 'number' ||
    grid.totalWindows <= 0
  ) {
    return ''
  }
  return t('tracks.dynamicAnalysisWindowProgress', {
    completed: grid.completedWindows,
    total: grid.totalWindows
  })
})

const metaText = computed(() => [phaseLabel.value, windowText.value].filter(Boolean).join(' · '))

// 透明悬停锚点只负责触气泡：布局固定，不覆盖标题/列，也不改变主题着色。
const hoverStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  height: '8px',
  zIndex: 2,
  background: 'transparent'
}
</script>

<template>
  <div
    v-if="safeProgress != null && viewportWidth > 0"
    class="row-analysis-bar"
    :class="{
      'row-analysis-bar--waiting': safeProgress === 0,
      'row-analysis-bar--active': safeProgress > 0
    }"
    :style="barStyle"
  ></div>
  <!-- 底部 8px 透明悬停区：只做气泡锚点，事件继续冒泡给行，不拦截选择/双击/拖拽。 -->
  <bubbleBoxTrigger
    v-if="safeProgress != null && viewportWidth > 0 && metaText"
    tag="div"
    class="row-analysis-progress-hover"
    role="note"
    :style="hoverStyle"
    :title="metaText"
    :aria-label="metaText"
  />
</template>

<style lang="scss" scoped>
.row-analysis-bar {
  position: absolute;
  left: 0;
  bottom: 1px;
  height: 2px;
  border-radius: 1px;
  pointer-events: none;
  z-index: 1;
  transition: width 0.3s ease;
  will-change: transform, width;
}

.row-analysis-bar--waiting {
  background: var(--text-weak);
  opacity: 0.2;
}

.row-analysis-bar--active {
  background: var(--accent, #5b8def);
  opacity: 0.7;
}
</style>
