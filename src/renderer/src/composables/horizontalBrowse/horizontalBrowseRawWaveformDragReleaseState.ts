import { ref, type Ref } from 'vue'
import {
  canCompleteHorizontalBrowseDragPresentationRelease,
  isHorizontalBrowseDragPresentationReleaseExpired,
  resolveHorizontalBrowseDragReleaseRenderedViewportStartSec
} from '@renderer/composables/horizontalBrowse/horizontalBrowseDragPresentationRelease'

type LiveCanvasRenderedPayload = {
  rangeStartSec: number
  rangeDurationSec: number
  stableWaveformSource?: boolean
}

type DrawWaveformNow = (options?: { preferPreviewStart?: boolean }) => void

type RawWaveformDragReleaseStateOptions = {
  playing: Ref<boolean>
  dragging: Ref<boolean>
  currentSeconds: () => number | undefined
  resolvePlaybackAlignedStart: (seconds: number) => number
  resolveVisibleDurationSec: () => number
  resolveStableWaveformSource: () => boolean
  drawWaveformNow: DrawWaveformNow
}

export const createHorizontalBrowseRawWaveformDragReleaseState = (
  options: RawWaveformDragReleaseStateOptions
) => {
  const active = ref(false)
  let pending = false
  let viewportStartSec: number | null = null
  let startedAtMs = 0
  let requiresFreshFrame = false
  let viewportSynced = false
  let baseSeconds: number | null = null

  const resolveBaseSeconds = () => {
    const seconds = Number(options.currentSeconds())
    return Number.isFinite(seconds) ? seconds : null
  }

  const reset = () => {
    pending = false
    active.value = false
    viewportStartSec = null
    startedAtMs = 0
    requiresFreshFrame = false
    viewportSynced = false
    baseSeconds = null
  }

  const finish = (finishOptions: { requiresFreshFrame?: boolean } = {}) => {
    requiresFreshFrame = finishOptions.requiresFreshFrame === true
    pending = false
    active.value = false
    viewportStartSec = null
    startedAtMs = 0
    viewportSynced = false
    baseSeconds = null
  }

  const consumeRequiresFreshFrame = () => {
    const consumed = requiresFreshFrame
    requiresFreshFrame = false
    return consumed
  }

  const resetForDragEnd = (nextViewportStartSec: number | null) => {
    requiresFreshFrame = false
    viewportSynced = false
    baseSeconds = nextViewportStartSec !== null ? resolveBaseSeconds() : null
  }

  const startPending = (nextViewportStartSec: number | null) => {
    pending = true
    active.value = true
    viewportStartSec = nextViewportStartSec
    viewportSynced = false
    baseSeconds = resolveBaseSeconds()
    startedAtMs = performance.now()
  }

  const syncViewportStart = (seconds: number) => {
    if (!pending || viewportSynced) return
    const safeSeconds = Number(seconds) || 0
    const nextViewportStartSec = options.resolvePlaybackAlignedStart(safeSeconds)
    if (!Number.isFinite(nextViewportStartSec)) return
    const clockMoved = baseSeconds === null || Math.abs(safeSeconds - baseSeconds) > 0.0001
    const matchesReleaseViewport =
      viewportStartSec !== null && Math.abs(viewportStartSec - nextViewportStartSec) <= 0.0001
    // 暂停拖动松手时，两边位置可能已对齐，但仍需请求一帧来结束拖动交接。
    const needsPausedReleaseFrame = !options.playing.value && matchesReleaseViewport
    if (!needsPausedReleaseFrame && (!clockMoved || matchesReleaseViewport)) return
    viewportStartSec = nextViewportStartSec
    viewportSynced = true
    options.drawWaveformNow({ preferPreviewStart: true })
  }

  const resolveRenderedViewportStartSec = (payload: LiveCanvasRenderedPayload) =>
    resolveHorizontalBrowseDragReleaseRenderedViewportStartSec({
      stableWaveformSource: options.resolveStableWaveformSource(),
      rangeStartSec: payload.rangeStartSec,
      rangeDurationSec: payload.rangeDurationSec,
      visibleDurationSec: options.resolveVisibleDurationSec()
    })

  const canComplete = (payload: LiveCanvasRenderedPayload, queuedForPlayback: boolean) => {
    // 起播帧已按本次松手后的播放时钟绘制。回报送达时，播放头可能已向前走了数帧。
    if (pending && queuedForPlayback && options.playing.value && !options.dragging.value) {
      return true
    }
    const expectedStartSec =
      options.playing.value && !options.dragging.value
        ? options.resolvePlaybackAlignedStart(Number(options.currentSeconds()) || 0)
        : viewportStartSec
    return canCompleteHorizontalBrowseDragPresentationRelease({
      pending,
      expectedStartSec,
      renderedViewportStartSec: resolveRenderedViewportStartSec(payload)
    })
  }

  return {
    active,
    reset,
    finish,
    consumeRequiresFreshFrame,
    resetForDragEnd,
    startPending,
    syncViewportStart,
    canComplete,
    isExpired: () => isHorizontalBrowseDragPresentationReleaseExpired(startedAtMs),
    get pending() {
      return pending
    },
    get viewportStartSec() {
      return viewportStartSec
    }
  }
}
