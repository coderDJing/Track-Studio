import { nextTick, onUnmounted, watch, type Ref } from 'vue'
import type { ISongsAreaColumn } from 'src/types/globals'

// 只在列顺序变化时测量位置；普通滚动、标签和分析进度更新不应触发布局测量。
export function useSongColumnReorderAnimation(
  rowsRoot: Ref<HTMLElement | null>,
  columns: Ref<ISongsAreaColumn[]>
) {
  const animations = new Set<Animation>()
  let revision = 0

  const cancelAnimations = () => {
    for (const animation of animations) animation.cancel()
    animations.clear()
  }

  const readPositions = () => {
    const positions = new Map<HTMLElement, number>()
    const groups = rowsRoot.value?.querySelectorAll<HTMLElement>('.song-row-columns')
    for (const group of groups || []) {
      const left = group.getBoundingClientRect().left
      for (const child of Array.from(group.children)) {
        if (child instanceof HTMLElement) {
          positions.set(child, child.getBoundingClientRect().left - left)
        }
      }
    }
    return positions
  }

  watch(
    () => columns.value.map((column) => column.key),
    (keys, previousKeys) => {
      if (keys.length === previousKeys.length && keys.every((key, i) => key === previousKeys[i])) {
        return
      }
      const ticket = ++revision
      const previousPositions = readPositions()
      cancelAnimations()
      void nextTick(() => {
        if (ticket !== revision) return
        const positions = readPositions()
        // 先批量读取再启动动画，避免逐行读写交错造成反复强制布局。
        for (const [element, left] of positions) {
          const previousLeft = previousPositions.get(element)
          if (previousLeft === undefined || Math.abs(previousLeft - left) < 0.5) continue
          const animation = element.animate(
            [{ transform: `translateX(${previousLeft - left}px)` }, { transform: 'translateX(0)' }],
            { duration: 150, easing: 'ease' }
          )
          animations.add(animation)
          animation.onfinish = () => animations.delete(animation)
        }
      })
    }
  )

  onUnmounted(() => {
    revision += 1
    cancelAnimations()
  })
}
