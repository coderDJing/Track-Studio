import type { Directive, DirectiveBinding } from 'vue'
import { constrainDialog } from '../utils/overlayLayout'

const contexts = new WeakMap<HTMLElement, { handle: HTMLElement; remove: () => void }>()
const getHandle = (el: HTMLElement, binding: DirectiveBinding<string | undefined | null>) =>
  (binding.value ? el.querySelector<HTMLElement>(binding.value) : null) || el

const mount = (el: HTMLElement, binding: DirectiveBinding<string | undefined | null>) => {
  const handle = getHandle(el, binding)
  let drag: { id: number; x: number; y: number; tx: number; ty: number } | null = null
  let frame = 0
  let previousUserSelect = ''
  const overlay = el.closest('.dialog')
  const translate = () => ({
    x: Number(el.dataset.dragTranslateX || 0),
    y: Number(el.dataset.dragTranslateY || 0)
  })
  const place = (x: number, y: number) => {
    const current = translate()
    const rect = el.getBoundingClientRect()
    const left = rect.left - current.x
    const top = rect.top - current.y
    const position = constrainDialog(
      left + x,
      top + y,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight
    )
    const nextX = position.left - left
    const nextY = position.top - top
    el.style.transform = `translate(${nextX}px, ${nextY}px)`
    el.dataset.dragTranslateX = String(nextX)
    el.dataset.dragTranslateY = String(nextY)
  }
  const stop = () => {
    if (!drag) return
    if (handle.hasPointerCapture(drag.id)) handle.releasePointerCapture(drag.id)
    drag = null
    document.body.style.userSelect = previousUserSelect
    overlay?.classList.remove('dialog--dragging')
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
  }
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return
    event.preventDefault()
    place(drag.tx + event.clientX - drag.x, drag.ty + event.clientY - drag.y)
  }
  const start = (event: PointerEvent) => {
    if (event.button !== 0 || !overlay) return
    const target = event.target
    if (
      target instanceof Element &&
      target.closest(
        '[data-dialog-drag-ignore], button, a, input, textarea, select, [contenteditable="true"]'
      )
    )
      return
    stop()
    const current = translate()
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, tx: current.x, ty: current.y }
    previousUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    overlay.classList.add('dialog--dragging')
    el.classList.add('dialog-positioned')
    handle.setPointerCapture(event.pointerId)
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
    event.preventDefault()
  }
  const reflow = () => {
    // Untouched dialogs are centered by CSS. Do not replace their entrance animation.
    if (!el.dataset.dragTranslateX) return
    stop()
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      const current = translate()
      place(current.x, current.y)
    })
  }
  const observer = new ResizeObserver(reflow)
  observer.observe(el)
  window.addEventListener('resize', reflow)
  window.addEventListener('blur', stop)
  handle.addEventListener('pointerdown', start)
  handle.style.touchAction = 'none'
  contexts.set(el, {
    handle,
    remove: () => {
      stop()
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', reflow)
      window.removeEventListener('blur', stop)
      handle.removeEventListener('pointerdown', start)
    }
  })
}

const dialogDrag: Directive<HTMLElement, string | undefined | null> = {
  mounted: mount,
  updated(el, binding) {
    const context = contexts.get(el)
    if (context?.handle === getHandle(el, binding)) return
    context?.remove()
    mount(el, binding)
  },
  unmounted(el) {
    contexts.get(el)?.remove()
    contexts.delete(el)
  }
}
export default dialogDrag
