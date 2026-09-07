import { applyHorizontalBrowseCanvasPresentationOffset } from './horizontalBrowseCanvasGeometry'

export type HorizontalBrowseStableCanvasPresentationFrame = {
  renderToken: number
  renderRevision: number
  playbackActive: boolean
  rangeStartSec: number
  rangeDurationSec: number
  viewportRangeStartSec: number
  anchorSec: number
  anchorStartedAtMs: number
  playbackRate: number
  renderWidth: number
  overscanCssPx: number
  pixelRatio: number
}

export const resolveHorizontalBrowseStableCanvasOffsetCssPx = (
  frame: HorizontalBrowseStableCanvasPresentationFrame,
  viewportRangeStartSec: number
) => {
  const rangeDurationSec = Math.max(0.0001, Number(frame.rangeDurationSec) || 0.0001)
  const renderWidth = Math.max(1, Number(frame.renderWidth) || 1)
  const overscanSec =
    (Math.max(0, Number(frame.overscanCssPx) || 0) * rangeDurationSec) / renderWidth
  const requestedRangeStartSec = viewportRangeStartSec - overscanSec
  const rawOffset =
    ((frame.rangeStartSec - requestedRangeStartSec) * renderWidth) / rangeDurationSec
  const pixelRatio =
    Number.isFinite(frame.pixelRatio) && frame.pixelRatio > 0 ? frame.pixelRatio : 1
  return Math.round(rawOffset * pixelRatio) / pixelRatio
}

const shouldReanchorHorizontalBrowseStableCanvas = (
  frame: HorizontalBrowseStableCanvasPresentationFrame,
  offsetCssPx: number
) => {
  const overscanCssPx = Math.max(0, Number(frame.overscanCssPx) || 0)
  const reanchorOffsetLimit = overscanCssPx * 0.7
  return Math.abs(offsetCssPx) >= Math.max(1, reanchorOffsetLimit)
}

export const canPresentHorizontalBrowseStableCanvas = (
  frame: HorizontalBrowseStableCanvasPresentationFrame,
  offsetCssPx: number
) => {
  const renderWidth = Math.max(1, Number(frame.renderWidth) || 1)
  const viewportWidth = Math.max(1, renderWidth - Math.max(0, Number(frame.overscanCssPx) || 0) * 2)
  const coverOffsetLimit = Math.max(0, (renderWidth - viewportWidth) * 0.5)
  return Math.abs(offsetCssPx) <= coverOffsetLimit
}

const STABLE_REANCHOR_RETRY_MS = 96
const STABLE_PENDING_PLAYBACK_START_EPSILON_SEC = 0.5
const STABLE_STALE_FRAME_PLAYBACK_START_SEC = 1
const STABLE_STATIC_TO_PLAYBACK_HANDOFF_SEC = 0.75
const STABLE_RENDER_REVISION_ADOPTION_ANCHOR_EPSILON_SEC = 0.08

const normalizeRenderRevision = (value: unknown) => Math.max(0, Math.floor(Number(value) || 0))

export const applyHorizontalBrowseStableCanvasPresentation = (
  waveformCanvas: HTMLElement | null,
  overlayCanvas: HTMLElement | null,
  offsetCssPx: number
) => {
  applyHorizontalBrowseCanvasPresentationOffset(waveformCanvas, overlayCanvas, offsetCssPx, true)
}

type StableCanvasRenderedPayload = {
  renderToken: number
  rangeStartSec: number
  rangeDurationSec: number
  ready: boolean
  renderViewportOnly?: boolean
}

type StableCanvasPresentationControllerOptions = {
  isActive: () => boolean
  isPlaying: () => boolean
  isDragging: () => boolean
  currentSeconds: () => number
  playbackRate: () => number
  renderRevision?: () => number
  resolveViewportRangeStartSec: (seconds: number, visibleDurationOverrideSec?: number) => number
  // 分块路径下波形侧是块容器 div，旧路径下是单张超宽 canvas；两者 left / width / transform
  // 语义一致，presentation 逻辑无需区分。
  waveformCanvas: () => HTMLElement | null
  overlayCanvas: () => HTMLElement | null
  scheduleDraw: () => void
  onPresentationApplied?: () => void
}

type StableCanvasPresentationApplyOptions = {
  allowReanchor?: boolean
  requirePresentable?: boolean
  allowRevisionHandoff?: boolean
  useFrameViewportForRevisionHandoff?: boolean
}

type StableCanvasPresentationMeasureOptions = {
  allowRevisionHandoff?: boolean
  useFrameViewportForRevisionHandoff?: boolean
}

type StableCanvasRenderedOptions = {
  forceViewportRangeStart?: boolean
}

type StableCanvasPresentationPlaybackClock = {
  seconds: number
  startedAtMs: number
  playbackRate: number
}

type StableCanvasPresentationPlaybackClockOptions = {
  startedAtMs?: number
}

export type HorizontalBrowseStableCanvasPresentationApplyResult = {
  applied: boolean
  offsetCssPx: number | null
  presentable: boolean
}

export type HorizontalBrowseStableCanvasPresentationMeasureResult = {
  frame: HorizontalBrowseStableCanvasPresentationFrame | null
  offsetCssPx: number | null
  presentable: boolean
  reanchorNeeded: boolean
}

export const createHorizontalBrowseStableCanvasPresentationController = (
  options: StableCanvasPresentationControllerOptions
) => {
  let pendingFrame: HorizontalBrowseStableCanvasPresentationFrame | null = null
  let currentFrame: HorizontalBrowseStableCanvasPresentationFrame | null = null
  let reanchorPending = false
  let reanchorPendingAtMs = 0
  let playbackClock: StableCanvasPresentationPlaybackClock | null = null
  let playbackRaf = 0

  const resolveRenderRevision = () => normalizeRenderRevision(options.renderRevision?.())

  const isCurrentRenderRevision = (
    frame: HorizontalBrowseStableCanvasPresentationFrame | null
  ): frame is HorizontalBrowseStableCanvasPresentationFrame =>
    !!frame && normalizeRenderRevision(frame.renderRevision) === resolveRenderRevision()

  const canUseRevisionHandoffFrame = (
    frame: HorizontalBrowseStableCanvasPresentationFrame | null
  ): frame is HorizontalBrowseStableCanvasPresentationFrame => {
    const safePendingFrame = pendingFrame
    const renderRevision = resolveRenderRevision()
    if (
      !frame ||
      !safePendingFrame ||
      !options.isPlaying() ||
      options.isDragging() ||
      normalizeRenderRevision(frame.renderRevision) === renderRevision ||
      normalizeRenderRevision(safePendingFrame.renderRevision) !== renderRevision
    ) {
      return false
    }
    if (frame.playbackActive === true) return true
    if (safePendingFrame.playbackActive !== true || !playbackClock) return false
    const frameAnchorSec = Number(frame.anchorSec)
    const pendingAnchorSec = Number(safePendingFrame.anchorSec)
    if (!Number.isFinite(frameAnchorSec) || !Number.isFinite(pendingAnchorSec)) return false
    return Math.abs(frameAnchorSec - pendingAnchorSec) <= STABLE_STATIC_TO_PLAYBACK_HANDOFF_SEC
  }

  const clearPlaybackLoop = () => {
    if (!playbackRaf) return
    cancelAnimationFrame(playbackRaf)
    playbackRaf = 0
  }

  const estimatePlaybackSeconds = (nowMs = performance.now()) => {
    if (!playbackClock) return Number(options.currentSeconds()) || 0
    const elapsedSec = Math.max(0, nowMs - playbackClock.startedAtMs) / 1000
    return playbackClock.seconds + elapsedSec * playbackClock.playbackRate
  }

  const estimateFramePlaybackSeconds = (
    frame: HorizontalBrowseStableCanvasPresentationFrame,
    nowMs = performance.now()
  ) => {
    const elapsedSec = Math.max(0, nowMs - frame.anchorStartedAtMs) / 1000
    return frame.anchorSec + elapsedSec * Math.max(0.25, Number(frame.playbackRate) || 1)
  }

  const resolveFramePlaybackViewportRangeStartSec = (
    frame: HorizontalBrowseStableCanvasPresentationFrame,
    seconds: number
  ) => {
    const elapsedSec = Number(seconds) - Number(frame.anchorSec)
    return frame.viewportRangeStartSec + (Number.isFinite(elapsedSec) ? elapsedSec : 0)
  }

  // 该帧视口（去掉左右 overscan）对应的可见时长 = 帧自身密度下一屏的时间宽度。
  const resolveFrameViewportVisibleDurationSec = (
    frame: HorizontalBrowseStableCanvasPresentationFrame
  ) => {
    const renderWidth = Math.max(1, Number(frame.renderWidth) || 1)
    const viewportWidth = Math.max(
      1,
      renderWidth - Math.max(0, Number(frame.overscanCssPx) || 0) * 2
    )
    const rangeDurationSec = Math.max(0.0001, Number(frame.rangeDurationSec) || 0.0001)
    return (rangeDurationSec * viewportWidth) / renderWidth
  }

  const shouldDeferPlaybackStartForPendingFrame = (seconds: number) => {
    if (!isCurrentRenderRevision(pendingFrame)) return !isCurrentRenderRevision(currentFrame)
    if (
      Math.abs(Number(pendingFrame.anchorSec) - seconds) > STABLE_PENDING_PLAYBACK_START_EPSILON_SEC
    ) {
      return false
    }
    if (!currentFrame) return true
    return (
      Math.abs(Number(currentFrame.anchorSec) - seconds) > STABLE_STALE_FRAME_PLAYBACK_START_SEC
    )
  }

  const clear = () => {
    clearPlaybackLoop()
    playbackClock = null
    pendingFrame = null
    currentFrame = null
    reanchorPending = false
    reanchorPendingAtMs = 0
  }

  const queueFrame = (frame: HorizontalBrowseStableCanvasPresentationFrame | null) => {
    pendingFrame = frame
    if (!frame) {
      currentFrame = null
      reanchorPending = false
      reanchorPendingAtMs = 0
    }
  }

  /**
   * 拖动松手完成时，presentation owner 会从 drag 切回 playback，并产生一个纯展示层 revision。
   * 刚刚按最终锚点画好的帧内容并未失效；在锚点严格匹配时把它收编到新 revision，避免同一松手
   * 紧接着再画、再 promote 一张内容等价的帧。
   */
  const adoptCurrentFrameRenderRevision = (seconds: number) => {
    if (!options.isActive() || !currentFrame) return false
    const safeSeconds = Number(seconds)
    if (
      !Number.isFinite(safeSeconds) ||
      Math.abs(Number(currentFrame.anchorSec) - safeSeconds) >
        STABLE_RENDER_REVISION_ADOPTION_ANCHOR_EPSILON_SEC
    ) {
      return false
    }
    currentFrame = {
      ...currentFrame,
      renderRevision: resolveRenderRevision()
    }
    return true
  }

  const queueRenderFrame = (
    active: boolean,
    renderToken: number,
    renderRevision: number,
    playbackActive: boolean,
    rangeStartSec: number,
    rangeDurationSec: number,
    viewportRangeStartSec: number,
    anchorSec: number,
    anchorStartedAtMs: number,
    playbackRate: number,
    renderWidth: number,
    overscanCssPx: number,
    pixelRatio: number
  ) => {
    const safeRenderRevision = normalizeRenderRevision(renderRevision)
    queueFrame(
      active
        ? {
            renderToken,
            renderRevision: safeRenderRevision,
            playbackActive,
            rangeStartSec,
            rangeDurationSec,
            viewportRangeStartSec,
            anchorSec,
            anchorStartedAtMs,
            playbackRate,
            renderWidth,
            overscanCssPx,
            pixelRatio
          }
        : null
    )
  }

  const shouldRetryReanchor = () =>
    !reanchorPending || performance.now() - reanchorPendingAtMs >= STABLE_REANCHOR_RETRY_MS

  const requestReanchor = () => {
    reanchorPending = true
    reanchorPendingAtMs = performance.now()
    options.scheduleDraw()
  }

  const measure = (
    seconds = Number(options.currentSeconds()) || 0,
    measureOptions: StableCanvasPresentationMeasureOptions = {}
  ): HorizontalBrowseStableCanvasPresentationMeasureResult => {
    const currentRevisionFrame = isCurrentRenderRevision(currentFrame)
    const revisionHandoffFrame =
      !currentRevisionFrame &&
      measureOptions.allowRevisionHandoff === true &&
      canUseRevisionHandoffFrame(currentFrame)
    const measuredFrame = currentRevisionFrame || revisionHandoffFrame ? currentFrame : null
    if (!options.isActive() || !measuredFrame) {
      return {
        frame: null,
        offsetCssPx: null,
        presentable: false,
        reanchorNeeded: false
      }
    }
    // 用当前显示帧自身密度对应的可见时长来定位播放头。普通播放帧密度==当前 rate，
    // 该值与 resolveViewportRangeStartSec 内部默认一致、行为不变；tempo 预览过渡期显示的是旧密度帧，
    // 若按当前 rate 的 visibleDuration 对齐会让屏幕 50% 偏离真实播放头，松手换新密度帧时回弹成横跳。
    const frameViewportVisibleSec = resolveFrameViewportVisibleDurationSec(measuredFrame)
    const viewportRangeStartSec =
      revisionHandoffFrame && measureOptions.useFrameViewportForRevisionHandoff === true
        ? resolveFramePlaybackViewportRangeStartSec(measuredFrame, seconds)
        : options.resolveViewportRangeStartSec(seconds, frameViewportVisibleSec)
    const offsetCssPx = resolveHorizontalBrowseStableCanvasOffsetCssPx(
      measuredFrame,
      viewportRangeStartSec
    )
    const reanchorNeeded = shouldReanchorHorizontalBrowseStableCanvas(measuredFrame, offsetCssPx)
    const presentable = canPresentHorizontalBrowseStableCanvas(measuredFrame, offsetCssPx)
    return {
      frame: measuredFrame,
      offsetCssPx,
      presentable,
      reanchorNeeded
    }
  }

  const apply = (
    seconds = Number(options.currentSeconds()) || 0,
    applyOptions: StableCanvasPresentationApplyOptions = {}
  ): HorizontalBrowseStableCanvasPresentationApplyResult => {
    const measured = measure(seconds, {
      allowRevisionHandoff: applyOptions.allowRevisionHandoff,
      useFrameViewportForRevisionHandoff: applyOptions.useFrameViewportForRevisionHandoff
    })
    const currentFrame = measured.frame
    if (!currentFrame) {
      return { applied: false, offsetCssPx: null, presentable: false }
    }
    const offsetCssPx = measured.offsetCssPx ?? 0
    const reanchorNeeded = measured.reanchorNeeded
    const presentable = measured.presentable
    if (!presentable) {
      if (
        applyOptions.requirePresentable !== true &&
        applyOptions.allowReanchor !== false &&
        options.isPlaying() &&
        !options.isDragging() &&
        shouldRetryReanchor()
      ) {
        requestReanchor()
      }
      return { applied: false, offsetCssPx, presentable }
    }
    applyHorizontalBrowseStableCanvasPresentation(
      options.waveformCanvas(),
      options.overlayCanvas(),
      offsetCssPx
    )
    options.onPresentationApplied?.()
    const shouldReanchor =
      applyOptions.allowReanchor !== false &&
      options.isPlaying() &&
      !options.isDragging() &&
      shouldRetryReanchor() &&
      reanchorNeeded
    if (shouldReanchor) {
      requestReanchor()
    }
    return { applied: true, offsetCssPx, presentable }
  }

  const tickPlayback = () => {
    playbackRaf = 0
    if (!playbackClock || !options.isActive() || !options.isPlaying() || options.isDragging()) {
      playbackClock = null
      return
    }
    const estimatedSeconds = estimatePlaybackSeconds()
    const result = apply(estimatedSeconds, {
      allowReanchor: true,
      allowRevisionHandoff: true,
      useFrameViewportForRevisionHandoff: true
    })
    if (result.applied) {
      playbackRaf = requestAnimationFrame(tickPlayback)
      return
    }
    playbackClock = null
  }

  const resolveClockStartedAtMs = (
    options: StableCanvasPresentationPlaybackClockOptions | undefined
  ) => {
    const startedAtMs = Number(options?.startedAtMs)
    return Number.isFinite(startedAtMs) ? startedAtMs : performance.now()
  }

  const startPlayback = (
    seconds: number,
    playbackRate: number,
    clockOptions?: StableCanvasPresentationPlaybackClockOptions
  ) => {
    const safeSeconds = Number(seconds) || 0
    const safePlaybackRate = Math.max(0.25, Number(playbackRate) || 1)
    const deferForPendingFrame = shouldDeferPlaybackStartForPendingFrame(safeSeconds)
    playbackClock = {
      seconds: safeSeconds,
      startedAtMs: resolveClockStartedAtMs(clockOptions),
      playbackRate: safePlaybackRate
    }
    if (deferForPendingFrame) {
      if (canUseRevisionHandoffFrame(currentFrame)) {
        if (!playbackRaf) {
          playbackRaf = requestAnimationFrame(tickPlayback)
        }
      } else {
        clearPlaybackLoop()
      }
      return
    }
    if (!playbackRaf) {
      playbackRaf = requestAnimationFrame(tickPlayback)
    }
  }

  const stopPlayback = () => {
    clearPlaybackLoop()
    playbackClock = null
  }

  const reanchorPlayback = (
    seconds: number,
    playbackRate: number,
    clockOptions?: StableCanvasPresentationPlaybackClockOptions
  ) => {
    const rate = Math.max(0.25, Number(playbackRate) || 1)
    playbackClock = {
      seconds,
      startedAtMs: resolveClockStartedAtMs(clockOptions),
      playbackRate: rate
    }
    if (options.isActive() && options.isPlaying() && !options.isDragging() && !playbackRaf) {
      playbackRaf = requestAnimationFrame(tickPlayback)
    }
  }

  const resumePlaybackFrom = (seconds: number) => {
    if (!options.isActive() || !options.isPlaying() || options.isDragging()) return
    reanchorPlayback(seconds, options.playbackRate())
  }

  const applyViewportRangeStart = (viewportRangeStartSec: number) => {
    if (!options.isActive() || !isCurrentRenderRevision(currentFrame)) return false
    const offsetCssPx = resolveHorizontalBrowseStableCanvasOffsetCssPx(
      currentFrame,
      viewportRangeStartSec
    )
    const presentable = canPresentHorizontalBrowseStableCanvas(currentFrame, offsetCssPx)
    if (!presentable) return false
    applyHorizontalBrowseStableCanvasPresentation(
      options.waveformCanvas(),
      options.overlayCanvas(),
      offsetCssPx
    )
    options.onPresentationApplied?.()
    return true
  }

  const handleRendered = (
    payload: StableCanvasRenderedPayload,
    renderedOptions: StableCanvasRenderedOptions = {}
  ) => {
    if (payload.renderToken !== pendingFrame?.renderToken) return false
    if (!isCurrentRenderRevision(pendingFrame)) {
      pendingFrame = null
      reanchorPending = false
      reanchorPendingAtMs = 0
      return false
    }
    const renderedFrame = pendingFrame
    const pendingViewportRangeStartSec = pendingFrame.viewportRangeStartSec
    const canPromoteFrame = payload.ready && payload.renderViewportOnly !== true
    currentFrame = canPromoteFrame
      ? {
          ...renderedFrame,
          rangeStartSec: payload.rangeStartSec,
          rangeDurationSec: payload.rangeDurationSec
        }
      : payload.ready
        ? currentFrame
        : null
    pendingFrame = null
    reanchorPending = false
    reanchorPendingAtMs = 0
    if (canPromoteFrame && options.isActive()) {
      if (renderedOptions.forceViewportRangeStart === true) {
        applyViewportRangeStart(pendingViewportRangeStartSec)
        if (options.isPlaying() && !playbackClock) {
          const seconds = estimateFramePlaybackSeconds(renderedFrame)
          apply(seconds, { allowReanchor: false })
          resumePlaybackFrom(seconds)
        }
      } else if (!options.isPlaying()) {
        applyViewportRangeStart(pendingViewportRangeStartSec)
      } else {
        const pendingPlaybackSeconds =
          renderedFrame.anchorSec +
          (Math.max(0, performance.now() - renderedFrame.anchorStartedAtMs) / 1000) *
            renderedFrame.playbackRate
        // promote 帧定位与后续 RAF tick 必须同相：playbackClock 是独立外推器，松手后不再被
        // reanchor，会与 render-sync currentSeconds 自由脱相。若 promote 用回调时刻的
        // estimatePlaybackSeconds() 定位、下一帧 RAF 又用同一 clock 的 vsync 采样，两次采样相位
        // 不同，promote 帧就相对相邻帧偏 ±几 ms（亚像素抖动）。promote 时先把 playbackClock 重锚到
        // render-sync currentSeconds，使这一帧与后续帧共用同一相位基准，消除单帧错位。不改播放
        // 速率、不露白、不触音频。
        if (playbackClock) {
          const renderSyncSeconds = Number(options.currentSeconds())
          if (Number.isFinite(renderSyncSeconds)) {
            reanchorPlayback(renderSyncSeconds, playbackClock.playbackRate)
          }
        }
        const seconds = playbackClock ? estimatePlaybackSeconds() : pendingPlaybackSeconds
        const result = apply(seconds)
        if (result.applied && options.isPlaying()) {
          if (!playbackClock) {
            resumePlaybackFrom(seconds)
          } else if (!playbackRaf) {
            playbackRaf = requestAnimationFrame(tickPlayback)
          }
        }
      }
    }
    return true
  }

  return {
    clear,
    queueFrame,
    queueRenderFrame,
    adoptCurrentFrameRenderRevision,
    handleRendered,
    measure,
    apply,
    applyViewportRangeStart,
    startPlayback,
    stopPlayback,
    reanchorPlayback,
    isActive: options.isActive
  }
}
