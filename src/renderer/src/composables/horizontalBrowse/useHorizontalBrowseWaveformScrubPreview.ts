import type { Ref } from 'vue'
import { clampNumber } from '@renderer/composables/horizontalBrowse/horizontalBrowseMath'

export type HorizontalBrowseScrubPreviewPayload = {
  anchorSec: number
  playbackRate: number
}

type HorizontalBrowseScrubPreviewStopOptions = {
  flushPending?: boolean
}

type UseHorizontalBrowseWaveformScrubPreviewOptions = {
  dragging: Ref<boolean>
  resolveAnchorSec: () => number
  emitPreview: (payload: HorizontalBrowseScrubPreviewPayload) => void
  immediate?: () => boolean
}

const SCRUB_IDLE_STOP_MS = 80
const SCRUB_MIN_RATE = 0.04
const SCRUB_MAX_RATE = 8
const SCRUB_RATE_SMOOTHING = 0.35

const normalizeScrubPreviewRate = (rate: number) => {
  if (!Number.isFinite(rate) || Math.abs(rate) < SCRUB_MIN_RATE) return 0
  return clampNumber(rate, -SCRUB_MAX_RATE, SCRUB_MAX_RATE)
}

export const useHorizontalBrowseWaveformScrubPreview = (
  options: UseHorizontalBrowseWaveformScrubPreviewOptions
) => {
  let lastAnchorSec = 0
  let lastMoveAt = 0
  let smoothedRate = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let previewRaf = 0
  let pendingPreviewAnchorSec = 0
  let pendingPreviewPlaybackRate = 0

  const clearIdleTimer = () => {
    if (!idleTimer) return
    clearTimeout(idleTimer)
    idleTimer = null
  }

  const clearPreviewRaf = () => {
    if (!previewRaf) return
    cancelAnimationFrame(previewRaf)
    previewRaf = 0
  }

  const flushPendingPreviewEmit = () => {
    if (!previewRaf) return
    clearPreviewRaf()
    emitPreview(pendingPreviewAnchorSec, pendingPreviewPlaybackRate)
  }

  const emitPreview = (anchorSec: number, playbackRate: number) => {
    options.emitPreview({
      anchorSec: Number(anchorSec) || 0,
      playbackRate: normalizeScrubPreviewRate(playbackRate)
    })
  }

  const schedulePreviewEmit = (anchorSec: number, playbackRate: number) => {
    // The source canvas moves in pointermove. Publish the linked lane's position in
    // that same event so it does not trail the source by an animation frame.
    if (options.immediate?.()) {
      clearPreviewRaf()
      emitPreview(anchorSec, playbackRate)
      return
    }
    pendingPreviewAnchorSec = Number(anchorSec) || 0
    pendingPreviewPlaybackRate = Number(playbackRate) || 0
    if (previewRaf) return
    previewRaf = requestAnimationFrame(() => {
      previewRaf = 0
      emitPreview(pendingPreviewAnchorSec, pendingPreviewPlaybackRate)
    })
  }

  const scheduleIdleStop = () => {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (!options.dragging.value) return
      smoothedRate = 0
      emitPreview(options.resolveAnchorSec(), 0)
    }, SCRUB_IDLE_STOP_MS)
  }

  const start = (anchorSec: number) => {
    clearPreviewRaf()
    lastAnchorSec = Number(anchorSec) || 0
    lastMoveAt = performance.now()
    smoothedRate = 0
    emitPreview(lastAnchorSec, 0)
    scheduleIdleStop()
  }

  const update = (anchorSec: number) => {
    const safeAnchorSec = Number(anchorSec) || 0
    const nowMs = performance.now()
    const elapsedSec = Math.max(0, nowMs - lastMoveAt) / 1000
    const rawRate =
      elapsedSec > 0.004
        ? normalizeScrubPreviewRate((safeAnchorSec - lastAnchorSec) / elapsedSec)
        : 0

    smoothedRate =
      rawRate === 0 || Math.sign(rawRate) !== Math.sign(smoothedRate)
        ? rawRate
        : smoothedRate * (1 - SCRUB_RATE_SMOOTHING) + rawRate * SCRUB_RATE_SMOOTHING

    lastAnchorSec = safeAnchorSec
    lastMoveAt = nowMs
    schedulePreviewEmit(safeAnchorSec, smoothedRate)
    scheduleIdleStop()
  }

  const stop = (stopOptions: HorizontalBrowseScrubPreviewStopOptions = {}) => {
    clearIdleTimer()
    if (stopOptions.flushPending) {
      flushPendingPreviewEmit()
    } else {
      clearPreviewRaf()
    }
    smoothedRate = 0
  }

  return {
    start,
    update,
    stop
  }
}
