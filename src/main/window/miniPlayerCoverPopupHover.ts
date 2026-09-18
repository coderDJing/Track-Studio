export type CoverPopupHoverPoint = {
  x: number
  y: number
}

export type CoverPopupHoverRectangle = CoverPopupHoverPoint & {
  width: number
  height: number
}

export const isPointWithinCoverPopupRectangle = (
  point: CoverPopupHoverPoint,
  rectangle: CoverPopupHoverRectangle,
  margin = 0
) => {
  const safeMargin = Math.max(0, Number(margin) || 0)
  const left = Math.min(rectangle.x, rectangle.x + rectangle.width) - safeMargin
  const right = Math.max(rectangle.x, rectangle.x + rectangle.width) + safeMargin
  const top = Math.min(rectangle.y, rectangle.y + rectangle.height) - safeMargin
  const bottom = Math.max(rectangle.y, rectangle.y + rectangle.height) + safeMargin
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
}

export const isPointWithinCoverPopupHoverRegion = (
  point: CoverPopupHoverPoint,
  anchor: CoverPopupHoverRectangle,
  popup: CoverPopupHoverRectangle,
  margin = 0
) =>
  isPointWithinCoverPopupRectangle(point, anchor, margin) ||
  isPointWithinCoverPopupRectangle(point, popup, margin)
