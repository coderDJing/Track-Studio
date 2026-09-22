type ContextMenuPointInput = {
  clickX: number
  clickY: number
  menuWidth: number
  menuHeight: number
}

type ContextMenuPointOptions = {
  padding?: number
  topInset?: number
  windowWidth?: number
  windowHeight?: number
}

const TOP_DRAG_ELEMENT_SELECTOR = '.canDrag, [data-context-menu-safe-top="true"]'
const TOP_DRAG_CACHE_TTL_MS = 120
const TOP_DRAG_TOLERANCE_PX = 2

let topDragInsetCache = 0
let topDragInsetCachedAt = 0

const toFinite = (value: unknown, fallback: number) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

const clamp = (value: number, min: number, max: number) => {
  if (max < min) return min
  return Math.max(min, Math.min(max, value))
}

const getAppRegion = (el: Element) => {
  const style = window.getComputedStyle(el)
  const appRegion =
    style.getPropertyValue('-webkit-app-region').trim() ||
    String((style as CSSStyleDeclaration & { webkitAppRegion?: string }).webkitAppRegion || '')
  return appRegion.trim()
}

const resolveTopDragInsetFrom = (elements: Element[]) => {
  let maxBottom = 0
  for (const el of elements) {
    const appRegion = getAppRegion(el)
    if (appRegion !== 'drag') continue
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0 || rect.width <= 0) continue
    if (rect.top > TOP_DRAG_TOLERANCE_PX) continue
    maxBottom = Math.max(maxBottom, rect.bottom)
  }
  return maxBottom
}

const resolveTopDragSafeInset = (): number => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0

  const now = Date.now()
  if (now - topDragInsetCachedAt <= TOP_DRAG_CACHE_TTL_MS) {
    return topDragInsetCache
  }

  const preferredElements = Array.from(document.querySelectorAll(TOP_DRAG_ELEMENT_SELECTOR))
  let maxBottom = resolveTopDragInsetFrom(preferredElements)

  if (maxBottom <= 0) {
    const allElements = Array.from(document.body?.querySelectorAll('*') || [])
    maxBottom = resolveTopDragInsetFrom(allElements)
  }

  topDragInsetCache = Math.max(0, Math.ceil(maxBottom))
  topDragInsetCachedAt = now
  return topDragInsetCache
}

export const resolveContextMenuPoint = (
  input: ContextMenuPointInput,
  options: ContextMenuPointOptions = {}
) => {
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0
  const width = Math.max(0, toFinite(options.windowWidth, viewportWidth))
  const height = Math.max(0, toFinite(options.windowHeight, viewportHeight))
  const menuWidth = Math.max(0, toFinite(input.menuWidth, 0))
  const menuHeight = Math.max(0, toFinite(input.menuHeight, 0))
  const clickX = toFinite(input.clickX, 0)
  const clickY = toFinite(input.clickY, 0)
  const padding = Math.max(0, toFinite(options.padding, 8))
  const topInset = Math.max(0, toFinite(options.topInset, resolveTopDragSafeInset()))

  const minX = padding
  const maxX = Math.max(minX, width - menuWidth - padding)
  const minY = Math.max(padding, topInset + padding)
  const maxY = Math.max(minY, height - menuHeight - padding)

  return {
    x: clamp(clickX, minX, maxX),
    y: clamp(clickY, minY, maxY),
    topInset
  }
}
