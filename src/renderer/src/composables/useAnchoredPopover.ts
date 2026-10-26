import { onBeforeUnmount, ref, watch, type CSSProperties, type Ref } from 'vue'
import { positionPopover } from '../utils/overlayLayout'

/** Body-teleported panels follow their anchor even while a dialog is dragged. */
export function useAnchoredPopover(
  open: Ref<boolean>,
  anchor: Ref<HTMLElement | null>,
  panel: Ref<HTMLElement | null>,
  options: {
    width?: number
    maxHeight: () => number
    center?: boolean
    contentHeight?: () => number
  }
) {
  const style = ref<CSSProperties>({ visibility: 'hidden' })
  let frame = 0
  let previous = ''
  const update = () => {
    if (!open.value) return
    const trigger = anchor.value
    const element = panel.value
    if (trigger && element) {
      const dialog = trigger.closest('.dialog')
      if (!trigger.isConnected || (dialog && !dialog.classList.contains('dialog-visible'))) {
        open.value = false
        return
      }
      const rect = trigger.getBoundingClientRect()
      const scrollViewport = trigger.closest('[data-overlayscrollbars-viewport]')
      const clip = scrollViewport?.getBoundingClientRect()
      if (clip && (rect.bottom <= clip.top || rect.top >= clip.bottom)) {
        open.value = false
        return
      }
      const { left, top, width, maxHeight } = positionPopover({
        anchor: rect,
        width: options.width ?? rect.width,
        contentHeight: options.contentHeight?.() ?? element.scrollHeight + 2,
        maxHeight: options.maxHeight(),
        center: options.center,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      })
      const next = `${left},${top},${width},${maxHeight}`
      if (next !== previous) {
        previous = next
        style.value = {
          position: 'fixed',
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          maxHeight: `${maxHeight}px`,
          visibility: 'visible'
        }
      }
    }
    frame = requestAnimationFrame(update)
  }
  watch(
    open,
    (visible) => {
      cancelAnimationFrame(frame)
      previous = ''
      style.value = { visibility: 'hidden' }
      if (visible) frame = requestAnimationFrame(update)
    },
    { flush: 'post' }
  )
  onBeforeUnmount(() => cancelAnimationFrame(frame))
  return style
}
