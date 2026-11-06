const FOLLOW_PLAYHEAD_LOCK_RATIO = 1 / 3

export const scrollTimelineViewportToPlayhead = (params: {
  viewport: HTMLElement
  viewportWidth: number
  layoutTotalWidth: number
  playheadX: number
  syncScrollState: () => void
}) => {
  const { viewport, viewportWidth, layoutTotalWidth, playheadX, syncScrollState } = params
  const scrollableWidth = Math.max(
    viewportWidth,
    layoutTotalWidth,
    Number(viewport.scrollWidth || 0)
  )
  if (scrollableWidth <= viewportWidth) return
  const maxScrollLeft = scrollableWidth - viewportWidth
  const nextLeft = Math.max(
    0,
    Math.min(maxScrollLeft, playheadX - viewportWidth * FOLLOW_PLAYHEAD_LOCK_RATIO)
  )
  const currentLeft = Math.max(0, Math.min(maxScrollLeft, Number(viewport.scrollLeft || 0)))
  if (Math.abs(nextLeft - currentLeft) < 0.001) return
  viewport.scrollLeft = nextLeft
  // The browser may quantize scrollLeft to a device pixel. Synchronize only after actual movement.
  if (viewport.scrollLeft !== currentLeft) syncScrollState()
}
