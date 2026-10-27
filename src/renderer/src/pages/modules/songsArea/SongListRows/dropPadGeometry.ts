export const getBottomDropPad = (
  container: Pick<DOMRect, 'top' | 'bottom'>,
  rows: Pick<DOMRect, 'top' | 'bottom'>
) => {
  const top = Math.min(Math.max(rows.bottom, rows.top, container.top), container.bottom)
  return { top, height: Math.max(0, container.bottom - top) }
}
