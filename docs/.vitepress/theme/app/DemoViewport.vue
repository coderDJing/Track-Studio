<script setup lang="ts">
// 手机先展示完整的真实界面，放大后仅在本容器内横向浏览。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useData } from 'vitepress'

const props = defineProps<{ width: number; height: number }>()
const { localeIndex } = useData()
const rootRef = ref<HTMLElement | null>(null)
const mobile = ref(false)
const expanded = ref(false)
const availableWidth = ref(props.width)
const isEn = computed(() => localeIndex.value === 'en')
const scale = computed(() => Math.min(1, availableWidth.value / props.width))
const viewportStyle = computed(() =>
  mobile.value
    ? { height: `${props.height * (expanded.value ? 1 : scale.value)}px` }
    : { height: '100%' }
)
const canvasStyle = computed(() =>
  mobile.value
    ? {
        width: `${props.width}px`,
        height: `${props.height}px`,
        transform: `scale(${expanded.value ? 1 : scale.value})`
      }
    : { height: '100%' }
)
let observer: ResizeObserver | null = null
let media: MediaQueryList | null = null
const syncSize = () => {
  mobile.value = media?.matches ?? false
  availableWidth.value = rootRef.value?.clientWidth ?? props.width
  if (!mobile.value) expanded.value = false
}
const toggleExpanded = () => {
  expanded.value = !expanded.value
  if (rootRef.value) rootRef.value.scrollLeft = 0
}
onMounted(() => {
  media = window.matchMedia('(max-width: 640px)')
  media.addEventListener('change', syncSize)
  observer = new ResizeObserver(syncSize)
  if (rootRef.value) observer.observe(rootRef.value)
  syncSize()
})
onUnmounted(() => {
  observer?.disconnect()
  media?.removeEventListener('change', syncSize)
})
</script>

<template>
  <div class="demo-viewport" :class="{ 'is-mobile': mobile, 'is-expanded': expanded }">
    <div ref="rootRef" class="demo-viewport__view" :style="viewportStyle">
      <div class="demo-viewport__canvas" :style="canvasStyle" :inert="mobile">
        <slot />
      </div>
    </div>
    <div v-if="mobile" class="demo-viewport__toolbar">
      <span>{{
        isEn
          ? expanded
            ? 'Swipe to explore'
            : 'Live app preview'
          : expanded
            ? '左右滑动查看细节'
            : '软件真实界面演示'
      }}</span>
      <button type="button" :aria-expanded="expanded" @click="toggleExpanded">
        {{ isEn ? (expanded ? 'Fit preview' : 'Enlarge') : expanded ? '收起界面' : '放大查看' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.demo-viewport {
  height: 100%;
  min-width: 0;
}
.demo-viewport__view {
  position: relative;
  width: 100%;
  min-width: 0;
}
.demo-viewport__canvas {
  transform-origin: top left;
}
.is-mobile {
  height: auto;
}
.is-mobile .demo-viewport__view {
  overflow: hidden;
}
.is-mobile .demo-viewport__canvas {
  position: absolute;
  inset: 0 auto auto 0;
}
.is-expanded .demo-viewport__view {
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.demo-viewport__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 48px;
  padding: 0 12px;
  border-top: 1px solid var(--border);
  color: var(--text-weak);
  font-size: 11px;
}
.demo-viewport__toolbar button {
  min-height: 44px;
  padding: 0 4px;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.demo-viewport__toolbar button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
</style>
