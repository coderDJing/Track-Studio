type DragCanvasFrame = {
  viewportStartSec: number
  minViewportStartSec: number
  maxViewportStartSec: number
  pixelsPerSec: number
  offsetCssPx: number
}

type DragCanvasPresentationOptions = {
  getViewportStartSec: () => number
  requestFrame: (viewportStartSec: number) => void
  present: (offsetCssPx: number, viewportStartSec: number) => void
}

const coversViewport = (frame: DragCanvasFrame, viewportStartSec: number) =>
  viewportStartSec >= frame.minViewportStartSec && viewportStartSec <= frame.maxViewportStartSec

const resolveOffset = (frame: DragCanvasFrame, viewportStartSec: number) =>
  frame.offsetCssPx + (frame.viewportStartSec - viewportStartSec) * frame.pixelsPerSec

export const createHorizontalBrowseRawWaveformDragPresentation = (
  options: DragCanvasPresentationOptions
) => {
  let active = false
  let frame: DragCanvasFrame | null = null
  let pending: { token: number; frame: DragCanvasFrame } | null = null

  const invalidateFrames = () => {
    frame = null
    pending = null
  }

  const stop = () => {
    const wasPending = pending !== null
    active = false
    invalidateFrames()
    return wasPending
  }

  const start = (initialFrame: DragCanvasFrame | null, prepareFrame: boolean) => {
    stop()
    active = true
    frame = initialFrame
    if (prepareFrame && initialFrame) options.requestFrame(initialFrame.viewportStartSec)
  }

  const update = () => {
    if (!active) return
    const target = options.getViewportStartSec()
    if (frame) {
      const coveredStart = Math.min(
        frame.maxViewportStartSec,
        Math.max(frame.minViewportStartSec, target)
      )
      options.present(resolveOffset(frame, coveredStart), coveredStart)
    }
    if (!pending && (!frame || !coversViewport(frame, target))) options.requestFrame(target)
  }

  const rememberFrame = (token: number, nextFrame: DragCanvasFrame) => {
    pending = { token, frame: nextFrame }
  }

  const commit = (
    token: number,
    ready: boolean,
    promote: (offsetCssPx: number, viewportStartSec: number) => void
  ) => {
    if (pending?.token !== token) return
    const nextFrame = pending.frame
    pending = null
    if (!ready) return
    const target = options.getViewportStartSec()
    if (!coversViewport(nextFrame, target)) {
      update()
      return
    }
    frame = nextFrame
    promote(resolveOffset(frame, target), target)
  }

  return { isActive: () => active, start, update, rememberFrame, commit, stop, invalidateFrames }
}
