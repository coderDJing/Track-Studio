// Shared with .dialog padding in main.scss: 35px title bar + 8px edge gap.
export const OVERLAY_TOP = 43
export const OVERLAY_GAP = 8

export function constrainDialog(
  left: number,
  top: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number
) {
  return {
    left: Math.max(OVERLAY_GAP, Math.min(left, viewportWidth - OVERLAY_GAP - width)),
    top: Math.max(OVERLAY_TOP, Math.min(top, viewportHeight - OVERLAY_GAP - height))
  }
}

export function positionPopover(input: {
  anchor: { left: number; top: number; bottom: number; width: number }
  width: number
  contentHeight: number
  maxHeight: number
  viewportWidth: number
  viewportHeight: number
  center?: boolean
}) {
  const { anchor, viewportWidth, viewportHeight } = input
  const width = Math.max(0, Math.min(input.width, viewportWidth - 2 * OVERLAY_GAP))
  const below = Math.max(0, viewportHeight - OVERLAY_GAP - anchor.bottom - 4)
  const above = Math.max(0, anchor.top - OVERLAY_TOP - 4)
  const desired = Math.min(input.contentHeight, input.maxHeight)
  const upwards = below < desired && above > below
  const maxHeight = Math.max(0, Math.min(input.maxHeight, upwards ? above : below))
  return {
    left: Math.max(
      OVERLAY_GAP,
      Math.min(
        input.center ? anchor.left + (anchor.width - width) / 2 : anchor.left,
        viewportWidth - width - OVERLAY_GAP
      )
    ),
    top: Math.max(
      OVERLAY_TOP,
      upwards ? anchor.top - 4 - Math.min(input.contentHeight, maxHeight) : anchor.bottom + 4
    ),
    width,
    maxHeight
  }
}
