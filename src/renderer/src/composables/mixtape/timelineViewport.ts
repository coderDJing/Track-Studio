import { computed } from 'vue'
import type { TimelineLayoutSnapshot } from '@renderer/composables/mixtape/types'

type ValueRef<T> = {
  value: T
}

type TimelineViewportContext = {
  timelineViewportWidth: ValueRef<number>
  overviewWidth: ValueRef<number>
  timelineScrollWidth: ValueRef<number>
  timelineContentWidth: ValueRef<number>
  timelineLayout: ValueRef<TimelineLayoutSnapshot>
  timelineScrollLeft: ValueRef<number>
  preRenderState: ValueRef<{ total: number; done: number }>
}

export const createTimelineViewportModule = (ctx: TimelineViewportContext) => {
  const {
    timelineViewportWidth,
    overviewWidth,
    timelineScrollWidth,
    timelineContentWidth,
    timelineLayout,
    timelineScrollLeft,
    preRenderState
  } = ctx

  const overviewViewportMetrics = computed(() => {
    const viewportWidth = Math.max(0, timelineViewportWidth.value)
    const overviewTotalWidth = Math.max(0, overviewWidth.value)
    const domScrollWidth = Number(timelineScrollWidth.value) || 0
    const fallbackScrollWidth = Math.max(
      1,
      Number(timelineContentWidth.value) || 0,
      Number(timelineLayout.value.totalWidth) || 0
    )
    const scrollTotalWidth = Math.max(1, domScrollWidth > 0 ? domScrollWidth : fallbackScrollWidth)
    if (!overviewTotalWidth || !viewportWidth) {
      return { left: 0, width: 0 }
    }
    const widthRatio = overviewTotalWidth / scrollTotalWidth
    const rawWidth = viewportWidth * widthRatio
    const width = Math.min(overviewTotalWidth, Math.max(0, rawWidth))
    const maxLeft = Math.max(0, overviewTotalWidth - width)
    const maxScrollLeft = Math.max(0, scrollTotalWidth - viewportWidth)
    const safeScrollLeft = Math.max(
      0,
      Math.min(maxScrollLeft, Number(timelineScrollLeft.value) || 0)
    )
    const scrollRatio =
      maxScrollLeft > 0 ? Math.max(0, Math.min(1, safeScrollLeft / maxScrollLeft)) : 0
    const left = maxLeft * scrollRatio
    return { left, width }
  })
  const overviewViewportLeft = computed(() => overviewViewportMetrics.value.left)
  const overviewViewportWidth = computed(() => overviewViewportMetrics.value.width)
  const overviewViewportStyle = computed(() => ({
    left: `${overviewViewportMetrics.value.left}px`,
    width: `${overviewViewportMetrics.value.width}px`
  }))
  const timelineScrollbarOptions = {
    scrollbars: {
      autoHide: 'leave' as const,
      autoHideDelay: 50,
      clickScroll: true
    },
    overflow: {
      x: 'scroll',
      // 轨道区高度是按 lane 高度精确算出来的，纵向不该出现滚动条：
      // 用 auto 而不是 scroll，避免内容刚好放下时也常显一条竖向滚动条。
      y: 'auto'
    } as const
  }
  const preRenderPercent = computed(() => {
    const total = preRenderState.value.total
    const done = preRenderState.value.done
    if (!total || total <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
  })

  return {
    overviewViewportMetrics,
    overviewViewportLeft,
    overviewViewportWidth,
    overviewViewportStyle,
    timelineScrollbarOptions,
    preRenderPercent
  }
}
