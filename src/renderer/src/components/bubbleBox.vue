<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick, computed, getCurrentInstance } from 'vue'
import type { PropType } from 'vue'
import shortcutIconAsset from '@renderer/assets/shortcutIcon.svg?asset'
const shortcutIcon = shortcutIconAsset

type BoundaryType = 'window' | 'element'

const props = defineProps({
  // 触发气泡的锚点 DOM
  dom: {
    type: Object as PropType<HTMLElement | null>,
    default: null
  },
  // 标题（若未提供默认插槽，则使用标题+快捷键信息的布局）
  title: {
    type: String,
    default: ''
  },
  // 快捷键信息（可选）
  shortcut: {
    type: String,
    default: ''
  },
  // 显示/隐藏延迟（毫秒）
  showDelay: {
    type: Number,
    default: 500
  },
  hideDelay: {
    type: Number,
    default: 80
  },
  // 边界感知：窗口或指定元素
  boundary: {
    type: String as PropType<BoundaryType>,
    default: 'window'
  },
  boundaryEl: {
    type: Object as PropType<HTMLElement | null>,
    default: null
  },
  // 偏移距离
  offset: {
    type: Number,
    default: 8
  },
  // 最大宽度（自动换行），高度自适应
  maxWidth: {
    type: Number,
    default: 280
  },
  // 是否允许气泡拦截鼠标事件。默认不拦截，否则会叠在指针上把 HTML5 拖拽抢走。
  interactive: {
    type: Boolean,
    default: false
  },
  // 是否跟随鼠标移动定位（默认不跟随，只锚定到触发元素）
  followMouse: {
    type: Boolean,
    default: false
  },
  // 鼠标静止后才显示；移动时立即收起，并重新等待 showDelay
  showWhenMouseIdle: {
    type: Boolean,
    default: false
  },
  // 层级
  zIndex: {
    type: [Number, String] as PropType<number | string>,
    default: 'var(--z-tooltip)'
  },
  // 仅当锚点元素内容发生溢出（如被省略号遮挡）时才显示气泡
  onlyWhenOverflow: {
    type: Boolean,
    default: false
  }
})

const visible = ref(false)
const bubbleEl = ref<HTMLDivElement | null>(null)
const topPx = ref(0)
const leftPx = ref(0)
const hoverTimer = ref<NodeJS.Timeout | null>(null)
const hideTimer = ref<NodeJS.Timeout | null>(null)
const mouseX = ref<number | null>(null)
const mouseY = ref<number | null>(null)
const resizeListenerOptions: AddEventListenerOptions = { passive: true }

const hasDefaultSlot = computed(() => {
  // 避免在 setup 直接使用 useSlots 导致类型提示缺失
  // 运行时从实例上获取 slots
  try {
    // @ts-ignore
    const slots = (getCurrentInstance && getCurrentInstance()?.slots) || undefined
    return !!slots?.default
  } catch {
    return false
  }
})

const effectiveInteractive = computed(() => props.interactive)

function clearTimers() {
  if (hoverTimer.value) {
    clearTimeout(hoverTimer.value)
    hoverTimer.value = null
  }
  if (hideTimer.value) {
    clearTimeout(hideTimer.value)
    hideTimer.value = null
  }
}

function isAnchorOverflow(anchor: HTMLElement) {
  return anchor.scrollWidth > anchor.clientWidth || anchor.scrollHeight > anchor.clientHeight
}

function queueShowForAnchor(anchor: HTMLElement | null) {
  if (!anchor) return
  if (hideTimer.value) {
    clearTimeout(hideTimer.value)
    hideTimer.value = null
  }
  if (hoverTimer.value) clearTimeout(hoverTimer.value)
  hoverTimer.value = setTimeout(async () => {
    if (props.dom !== anchor) return
    if (props.onlyWhenOverflow && !isAnchorOverflow(anchor)) return
    visible.value = true
    await nextTick()
    updatePosition()
    if (hideTimer.value) {
      clearTimeout(hideTimer.value)
      hideTimer.value = null
    }
  }, props.showDelay)
}

function onAnchorMouseEnter(e: MouseEvent) {
  // 记录进入时的鼠标坐标，避免延时期间位置偏差
  mouseX.value = e.clientX
  mouseY.value = e.clientY
  queueShowForAnchor(props.dom)
}

function onAnchorMouseLeave(e: MouseEvent) {
  if (hoverTimer.value) {
    clearTimeout(hoverTimer.value)
    hoverTimer.value = null
  }
  if (hideTimer.value) clearTimeout(hideTimer.value)
  const rt = (e && (e.relatedTarget as Node | null)) || null
  // 若移入的是气泡本身或其子元素，则不触发隐藏
  if (rt && bubbleEl.value && bubbleEl.value.contains(rt)) {
    return
  }
  hideTimer.value = setTimeout(() => {
    visible.value = false
  }, props.hideDelay)
}

function onAnchorMouseMove(e: MouseEvent) {
  // 总是记录最新鼠标位置
  mouseX.value = e.clientX
  mouseY.value = e.clientY
  if (props.showWhenMouseIdle) {
    if (visible.value) {
      visible.value = false
    }
    queueShowForAnchor(props.dom)
    return
  }
  // 仅在需要跟随且已显示时才实时更新
  if (props.followMouse && visible.value) updatePosition()
}

function onBubbleMouseEnter() {
  if (hideTimer.value) {
    clearTimeout(hideTimer.value)
    hideTimer.value = null
  }
}

function hideImmediately() {
  clearTimers()
  visible.value = false
}

const isInside = (target: EventTarget | null, element: HTMLElement | null) =>
  target instanceof Node && !!element?.contains(target)

function onWindowPointerMove(event: PointerEvent) {
  if (!visible.value) return
  // 锚点被重建或窗口边界切换时，浏览器不一定会补发 mouseleave。
  // 用下一次指针事件校正状态，避免气泡脱离锚点后永久残留。
  if (props.dom?.matches(':hover') || isInside(event.target, bubbleEl.value)) return
  hideImmediately()
}

function onWindowBlur() {
  hideImmediately()
}

function onDocumentVisibilityChange() {
  if (document.visibilityState !== 'visible') hideImmediately()
}

function onWindowPointerDown(event: PointerEvent) {
  if (isInside(event.target, bubbleEl.value)) {
    return
  }
  hideImmediately()
}

function onBubbleMouseLeave() {
  if (hideTimer.value) clearTimeout(hideTimer.value)
  hideTimer.value = setTimeout(() => {
    visible.value = false
  }, props.hideDelay)
}

function getBoundaryRect(): DOMRect {
  if (props.boundary === 'element' && props.boundaryEl) {
    return props.boundaryEl.getBoundingClientRect()
  }
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight)
}

function getAnchorBasePoint() {
  const boundary = getBoundaryRect()
  if (mouseX.value !== null && mouseY.value !== null) {
    return { x: mouseX.value, y: mouseY.value, boundary }
  }
  if (props.dom) {
    const rect = props.dom.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    return { x, y, boundary }
  }
  return { x: boundary.left + boundary.width / 2, y: boundary.top + boundary.height / 2, boundary }
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function updatePosition() {
  const el = bubbleEl.value
  if (!el) return
  const { x, y, boundary } = getAnchorBasePoint()
  // 先确保元素渲染后再量尺寸
  const w = el.offsetWidth
  const h = el.offsetHeight
  const leftSpace = x - boundary.left
  const rightSpace = boundary.right - x
  const topSpace = y - boundary.top
  const bottomSpace = boundary.bottom - y

  const verticalOrder = bottomSpace >= topSpace ? ['bottom', 'top'] : ['top', 'bottom']
  const horizontalOrder = rightSpace >= leftSpace ? ['right', 'left'] : ['left', 'right']

  type V = 'top' | 'bottom'
  type H = 'left' | 'right'
  const candidates: Array<{ v: V; h: H }> = []
  for (const v of verticalOrder as V[]) {
    for (const hDir of horizontalOrder as H[]) {
      candidates.push({ v, h: hDir })
    }
  }

  let finalTop = 0
  let finalLeft = 0
  let placed = false
  // 必须离开指针一定距离：贴在光标上时，即便暂时可穿透，后续若被设为可交互也会吞掉拖拽。
  const effectiveOffset = Math.max(8, Number(props.offset) || 0)

  for (const c of candidates) {
    const t = c.v === 'bottom' ? y + effectiveOffset : y - h - effectiveOffset
    const l = c.h === 'right' ? x + effectiveOffset : x - w - effectiveOffset
    const fits =
      t >= boundary.top && l >= boundary.left && t + h <= boundary.bottom && l + w <= boundary.right
    if (fits) {
      finalTop = t
      finalLeft = l
      placed = true
      break
    }
  }

  if (!placed) {
    // 若都不完全适配，则对当前优先方向进行 clamp
    const v = verticalOrder[0] as V
    const hDir = horizontalOrder[0] as H
    const t = v === 'bottom' ? y + effectiveOffset : y - h - effectiveOffset
    const l = hDir === 'right' ? x + effectiveOffset : x - w - effectiveOffset
    finalTop = clamp(t, boundary.top, boundary.bottom - h)
    finalLeft = clamp(l, boundary.left, boundary.right - w)
  }

  topPx.value = Math.round(finalTop)
  leftPx.value = Math.round(finalLeft)
}

function addAnchorListeners(anchor: HTMLElement | null) {
  if (!anchor) return
  anchor.addEventListener('mouseenter', onAnchorMouseEnter)
  anchor.addEventListener('mouseleave', onAnchorMouseLeave)
  anchor.addEventListener('mousemove', onAnchorMouseMove)
  // 条件渲染下，气泡组件挂载时锚点可能已经处于 hover 中，这里补一次显示调度。
  if (anchor.matches(':hover')) {
    mouseX.value = null
    mouseY.value = null
    queueShowForAnchor(anchor)
  }
}

function removeAnchorListeners(anchor: HTMLElement | null) {
  if (!anchor) return
  anchor.removeEventListener('mouseenter', onAnchorMouseEnter)
  anchor.removeEventListener('mouseleave', onAnchorMouseLeave)
  anchor.removeEventListener('mousemove', onAnchorMouseMove)
}

watch(
  () => props.dom,
  (newEl, oldEl) => {
    if (newEl !== oldEl) hideImmediately()
    removeAnchorListeners(oldEl as HTMLElement | null)
    addAnchorListeners(newEl as HTMLElement | null)
  },
  { immediate: true }
)

const bindDragHideListeners = () => {
  window.addEventListener('dragstart', hideImmediately, true)
  window.addEventListener('pointerdown', onWindowPointerDown, true)
  window.addEventListener('pointermove', onWindowPointerMove, true)
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('visibilitychange', onDocumentVisibilityChange)
}

const unbindDragHideListeners = () => {
  window.removeEventListener('dragstart', hideImmediately, true)
  window.removeEventListener('pointerdown', onWindowPointerDown, true)
  window.removeEventListener('pointermove', onWindowPointerMove, true)
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
}

watch(visible, (isVisible) => {
  if (isVisible) bindDragHideListeners()
  else unbindDragHideListeners()
})

onMounted(() => {
  window.addEventListener('scroll', updatePosition, true)
  window.addEventListener('resize', updatePosition, resizeListenerOptions)
})

onUnmounted(() => {
  window.removeEventListener('scroll', updatePosition, true)
  window.removeEventListener('resize', updatePosition)
  unbindDragHideListeners()
  removeAnchorListeners(props.dom)
  clearTimers()
})
</script>

<template>
  <teleport to="body">
    <transition name="fade">
      <div
        v-if="visible"
        ref="bubbleEl"
        class="frkb-bubble"
        :draggable="false"
        :style="{
          top: topPx + 'px',
          left: leftPx + 'px',
          maxWidth: maxWidth + 'px',
          zIndex: zIndex,
          pointerEvents: effectiveInteractive ? 'auto' : 'none',
          userSelect: effectiveInteractive ? 'text' : 'none'
        }"
        @mouseenter="onBubbleMouseEnter"
        @mouseleave="onBubbleMouseLeave"
      >
        <template v-if="hasDefaultSlot">
          <slot />
        </template>
        <template v-else>
          <div class="frkb-bubble-row">
            <span>{{ title }}</span>
            <div v-if="shortcut" class="frkb-bubble-shortcut">
              <img :src="shortcutIcon" :draggable="false" alt="" />
              <span>{{ shortcut }}</span>
            </div>
          </div>
        </template>
      </div>
    </transition>
  </teleport>
</template>

<style scoped lang="scss">
.frkb-bubble {
  position: fixed;
  background-color: var(--bg-elev);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.4;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
}

.frkb-bubble-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.frkb-bubble-shortcut {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  img {
    width: 16px;
    height: 16px;
  }
}
</style>
