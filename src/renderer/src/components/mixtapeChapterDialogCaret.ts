export const resolveTextareaCaretMarkerText = (value: string, caretIndex: number): string => {
  const index = Number.isFinite(caretIndex) ? Math.max(0, Math.floor(caretIndex)) : 0
  return String(value || '').charAt(index) || '.'
}

export const resolveScrollTopToShowRange = (
  viewTop: number,
  viewHeight: number,
  rangeTop: number,
  rangeBottom: number
): number => {
  const safeViewTop = Number.isFinite(viewTop) ? Math.max(0, viewTop) : 0
  const safeViewHeight = Number.isFinite(viewHeight) && viewHeight > 0 ? viewHeight : 0
  if (safeViewHeight <= 0) return safeViewTop
  const safeRangeTop = Number.isFinite(rangeTop) ? rangeTop : 0
  const safeRangeBottom = Number.isFinite(rangeBottom)
    ? Math.max(safeRangeTop, rangeBottom)
    : safeRangeTop
  const viewBottom = safeViewTop + safeViewHeight
  if (safeRangeTop < safeViewTop) return Math.max(0, safeRangeTop)
  if (safeRangeBottom > viewBottom) return Math.max(0, safeRangeBottom - safeViewHeight)
  return safeViewTop
}

const CARET_MIRROR_STYLES = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontFamily',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'wordSpacing',
  'whiteSpace',
  'wordWrap',
  'wordBreak',
  'overflowWrap'
] as const

export const getTextareaCaretY = (el: HTMLTextAreaElement) => {
  const style = window.getComputedStyle(el)
  const mirror = document.createElement('div')
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.style.overflow = 'hidden'
  mirror.style.whiteSpace = style.whiteSpace || 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  for (const property of CARET_MIRROR_STYLES) {
    mirror.style[property] = style[property]
  }
  const value = el.value
  const end = el.selectionEnd ?? 0
  mirror.textContent = value.slice(0, end)
  const marker = document.createElement('span')
  marker.textContent = resolveTextareaCaretMarkerText(value, end)
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const top = marker.offsetTop
  const height = marker.offsetHeight || parseFloat(style.lineHeight) || 21
  mirror.remove()
  return { top, bottom: top + height }
}
