import type { HorizontalBrowseDirection } from './horizontalBrowseRawWaveformCanvasTypes'

type PendingActivation = {
  commit: () => void
  playbackFrame: boolean
  isCurrent: () => boolean
}

const LINKED_ACTIVATION_FALLBACK_MS = 120

const pendingActivations: Partial<Record<HorizontalBrowseDirection, PendingActivation>> = {}
let firstAnimationFrame = 0
let secondAnimationFrame = 0
let fallbackTimer: ReturnType<typeof setTimeout> | null = null

const clearScheduledFlush = () => {
  if (firstAnimationFrame) cancelAnimationFrame(firstAnimationFrame)
  if (secondAnimationFrame) cancelAnimationFrame(secondAnimationFrame)
  if (fallbackTimer) clearTimeout(fallbackTimer)
  firstAnimationFrame = 0
  secondAnimationFrame = 0
  fallbackTimer = null
}

const resolveCurrentActivation = (direction: HorizontalBrowseDirection) => {
  const activation = pendingActivations[direction]
  return activation?.isCurrent() ? activation : undefined
}

const flushPendingActivations = () => {
  clearScheduledFlush()
  const up = resolveCurrentActivation('up')
  const down = resolveCurrentActivation('down')
  delete pendingActivations.up
  delete pendingActivations.down
  // 两个回调必须在同一个 JS 任务内完成，浏览器才不会绘制只切换了一轨的中间帧。
  up?.commit()
  down?.commit()
}

const resolvePairedPlaybackFrame = () => {
  const up = resolveCurrentActivation('up')
  const down = resolveCurrentActivation('down')
  return up && down && up.playbackFrame === down.playbackFrame ? up.playbackFrame : undefined
}

const schedulePairedFlush = () => {
  if (firstAnimationFrame || secondAnimationFrame) return
  firstAnimationFrame = requestAnimationFrame(() => {
    firstAnimationFrame = 0
    const playbackFrame = resolvePairedPlaybackFrame()
    if (playbackFrame === undefined) return
    if (playbackFrame) {
      flushPendingActivations()
      return
    }
    secondAnimationFrame = requestAnimationFrame(() => {
      secondAnimationFrame = 0
      if (resolvePairedPlaybackFrame() !== undefined) flushPendingActivations()
    })
  })
}

const scheduleFallbackFlush = () => {
  if (fallbackTimer) return
  fallbackTimer = setTimeout(flushPendingActivations, LINKED_ACTIVATION_FALLBACK_MS)
}

export const queueHorizontalBrowseLinkedCanvasActivation = (
  direction: HorizontalBrowseDirection,
  activation: PendingActivation
) => {
  // 同一轨在联结松手后可能连续产出过渡帧和校正帧；只保留绘制前最后一帧。
  pendingActivations[direction] = activation
  if (resolvePairedPlaybackFrame() !== undefined) schedulePairedFlush()
  scheduleFallbackFlush()
}

export const resetHorizontalBrowseLinkedCanvasActivationBarrier = () => {
  clearScheduledFlush()
  delete pendingActivations.up
  delete pendingActivations.down
}
