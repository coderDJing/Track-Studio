import type { HorizontalBrowseDetailLiveCanvasRenderRequest } from './horizontalBrowseDetailLiveCanvas.types'
import type { PlaybackAnimationState } from './horizontalBrowseDetailLiveCanvasRenderState'
import { resolveHorizontalBrowseLoopPlaybackSeconds } from '@shared/horizontalBrowseLoopClock'

export const PLAYHEAD_RATIO = 0.5
export const PLAYBACK_RENDER_INTERVAL_MS = 16
export const PLAYBACK_RENDER_FALLBACK_TIMEOUT_MS = 48
export const PLAYBACK_RENDER_MIN_FRAME_GAP_MS = PLAYBACK_RENDER_INTERVAL_MS
export const PLAYBACK_SCROLL_REUSE_MAX_FRAME_GAP_MS = PLAYBACK_RENDER_FALLBACK_TIMEOUT_MS * 2
export const PLAYBACK_CLOCK_REANCHOR_MIN_FRAME_GAP_MS = 120
export const PLAYBACK_SCROLL_REUSE_RECOVERY_FRAMES = 0
export const PLAYBACK_INITIAL_FULL_RENDER_LEAD_DEFAULT_MS = 30
const PLAYBACK_INITIAL_FULL_RENDER_LEAD_MAX_MS = 48

export const clampPlaybackRenderLeadMs = (value: number) => {
  const safeValue = Number.isFinite(value) ? value : PLAYBACK_INITIAL_FULL_RENDER_LEAD_DEFAULT_MS
  return Math.max(0, Math.min(PLAYBACK_INITIAL_FULL_RENDER_LEAD_MAX_MS, safeValue))
}

const resolveWorkerPerformanceTimeOrigin = () => {
  if (typeof performance === 'undefined') return Date.now()
  const timeOrigin = Number(performance.timeOrigin)
  return Number.isFinite(timeOrigin) ? timeOrigin : Date.now() - performance.now()
}

export const hasPlaybackRenderClock = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
  const epochMs = Number(request.playbackRenderClockEpochMs)
  return Number.isFinite(epochMs) && epochMs > 0
}

export const resolvePlaybackRenderClockStartedAtMs = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  fallbackMs: number
) => {
  const epochMs = Number(request.playbackRenderClockEpochMs)
  if (!Number.isFinite(epochMs) || epochMs <= 0) return fallbackMs
  return epochMs - resolveWorkerPerformanceTimeOrigin()
}

const clampPlaybackRangeStart = (
  value: number,
  duration: number,
  leadingPad: number,
  trailingPad: number
) => {
  if (!duration || leadingPad + trailingPad <= 0) return 0
  return Math.min(Number.isFinite(value) ? value : 0, Math.max(-leadingPad, duration - trailingPad))
}

export const resolvePlaybackSeconds = (
  request: Pick<
    HorizontalBrowseDetailLiveCanvasRenderRequest,
    'playbackRate' | 'playbackDurationSec' | 'playbackActive' | 'loopRange'
  >,
  baseSeconds: number,
  startedAtMs: number,
  nowMs = performance.now()
) => {
  const elapsedSec = Math.max(0, nowMs - startedAtMs) / 1000
  const playbackRate = Math.max(0, Number(request.playbackRate) || 1)
  const durationSec = Math.max(0, Number(request.playbackDurationSec) || 0)
  const linearSeconds = baseSeconds + elapsedSec * playbackRate
  if (!Number.isFinite(linearSeconds)) return 0
  const seconds = request.playbackActive
    ? resolveHorizontalBrowseLoopPlaybackSeconds(linearSeconds, request.loopRange)
    : linearSeconds
  return durationSec ? Math.min(seconds, durationSec) : seconds
}

export const resolvePlaybackRangeStartSec = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  playbackSeconds: number
) => {
  const durationSec = Math.max(0, Number(request.playbackDurationSec) || 0)
  return clampPlaybackRangeStart(
    playbackSeconds - request.rangeDurationSec * PLAYHEAD_RATIO,
    durationSec,
    request.rangeDurationSec * PLAYHEAD_RATIO,
    request.rangeDurationSec * (1 - PLAYHEAD_RATIO)
  )
}

export const buildPlaybackRenderRequest = (
  animation: PlaybackAnimationState,
  allowScrollReuse = animation.request.allowScrollReuse !== false,
  nowMs = performance.now()
): HorizontalBrowseDetailLiveCanvasRenderRequest => {
  const playbackSeconds = resolvePlaybackSeconds(
    animation.request,
    animation.baseSeconds,
    animation.startedAtMs,
    nowMs
  )
  const rangeStartSec = resolvePlaybackRangeStartSec(animation.request, playbackSeconds)
  return {
    ...animation.request,
    playbackSeconds,
    allowScrollReuse,
    phaseAwareScrollReuse: allowScrollReuse && animation.request.phaseAwareScrollReuse === true,
    rangeStartSec,
    viewportRangeStartSec: rangeStartSec
  }
}
