import { ref } from 'vue'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { shouldUseAttackSafeRawPeaks } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasPolicy'
import { resolveHorizontalBrowseWaveformThemeVariant } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformDetail.utils'
import { createHorizontalBrowseDetailLiveCanvasBridge } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailLiveCanvasBridge'
import { HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailOverlayCanvas'
import {
  resolveHorizontalBrowseStableOverscanCssPx,
  resolvePixelSnappedCssSize
} from '@renderer/composables/horizontalBrowse/horizontalBrowseCanvasGeometry'
import { createHorizontalBrowseStableCanvasPresentationController } from '@renderer/composables/horizontalBrowse/horizontalBrowseStableCanvasPresentation'
import { isHorizontalBrowseWaveformTileRenderingEnabled } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformTileFlag'
import { createHorizontalBrowseWaveformTileRendering } from './horizontalBrowseWaveformTileRendering'
import { PREVIEW_MAX_SAMPLES_PER_PIXEL } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import type { UseHorizontalBrowseRawWaveformCanvasOptions } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasTypes'
import { normalizeSongHotCues } from '@shared/hotCues'
import { normalizeSongMemoryCues } from '@shared/memoryCues'
import { resolveHorizontalBrowseLinkedGridVisualPhase } from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedGridVisualPhase'
import { createHorizontalBrowseLiveCanvasBuffers } from '@renderer/composables/horizontalBrowse/horizontalBrowseLiveCanvasBuffers'
import {
  hasHorizontalBrowseDrawableRawFrames,
  resolveHorizontalBrowseWorkerLoopRange
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformRenderPayload'
import {
  createHorizontalBrowseRawWaveformDrawScheduler,
  type HorizontalBrowseRawWaveformDrawOptions,
  type HorizontalBrowseRawWaveformDrawScheduler
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDrawScheduler'
import { createHorizontalBrowseRawWaveformDragReleaseState } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDragReleaseState'
import { createHorizontalBrowseRawWaveformDragPresentation } from './horizontalBrowseRawWaveformDragPresentation'
import { shouldCommitHorizontalBrowseDragReleaseRenderedViewport } from '@renderer/composables/horizontalBrowse/horizontalBrowseDragPresentationRelease'
import {
  resolveHorizontalBrowseAudioEditAccentColor,
  resolveHorizontalBrowseCueAccentColor
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasData'
import { createHorizontalBrowseRawWaveformDisplayViewportState } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDisplayViewport'
import { createHorizontalBrowseRawWaveformSurfaceVisibility } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformSurfaceVisibility'
import {
  cloneRekordboxBeatGridEntriesForHorizontalBrowseWorker,
  cloneSongBeatGridMapForHorizontalBrowseWorker
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformWorkerGrid'
import { queueHorizontalBrowseLinkedCanvasActivation } from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedCanvasActivationBarrier'
import {
  canReplacePendingHorizontalBrowseStableRevisionRender,
  clearHorizontalBrowseRawWaveformGridCanvas,
  resolveHorizontalBrowsePlaybackDurationSecForRender,
  resolveHorizontalBrowseRawSlotForRender,
  resolveHorizontalBrowseStableRevisionRenderKind,
  resolveHorizontalBrowseWaveformGain,
  type HorizontalBrowseStableRevisionRenderKind as StableRevisionRenderKind
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasHelpers'
import {
  createHorizontalBrowseRawWaveformViewport,
  resolveHorizontalBrowseRawWaveformRenderViewport
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformViewport'
import {
  createHorizontalBrowseRawWaveformDraw,
  type HorizontalBrowseLiveWaveformRenderPayload,
  type HorizontalBrowseRawWaveformDrawState
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDraw'
import type { HorizontalBrowseDetailLiveCanvasWorkerOutgoing } from '@renderer/workers/horizontalBrowseDetailLiveCanvas.types'
type LiveCanvasRenderedPayload = Extract<
  HorizontalBrowseDetailLiveCanvasWorkerOutgoing,
  { type: 'rendered' }
>['payload']
type LiveCanvasPresentationPayload = Extract<
  HorizontalBrowseDetailLiveCanvasWorkerOutgoing,
  { type: 'presentation' }
>['payload']
const PLAYBACK_RAW_SETTLE_HOLD_MS = 360
const STABLE_VIEWPORT_RENDER_HOLD_MS = 90
const STABLE_FULL_RENDER_DELAY_MS = 96
const STABLE_SEEK_REVEAL_HOLD_MS = 0
const WAVEFORM_SURFACE_FADE_IN_MS = 50

export const useHorizontalBrowseRawWaveformCanvas = (
  options: UseHorizontalBrowseRawWaveformCanvasOptions
) => {
  const wrapRef = ref<HTMLDivElement | null>(null)
  const liveCanvasBuffers = createHorizontalBrowseLiveCanvasBuffers()
  const { waveformSurfaceRef, waveformCanvasRef, waveformCanvasBackRef, gridCanvasRef } =
    liveCanvasBuffers
  const { overlaySurfaceRef, overlayCanvasRef, overlayCanvasBackRef } = liveCanvasBuffers
  let drawScheduler: HorizontalBrowseRawWaveformDrawScheduler | null = null
  let liveCanvasRenderToken = 0
  let liveCanvasAttached = false
  let queuedLivePresentation: { index: number; offsetCssPx: number } | null = null
  let queuedReleasePlaybackFrame = false
  const drawState: HorizontalBrowseRawWaveformDrawState = {
    suppressNextPlaybackScrollReuse: false,
    lastRenderedRawData: null,
    lastDrawPlaybackActive: false
  }
  const scheduleDraw = (drawOptions: HorizontalBrowseRawWaveformDrawOptions = {}) =>
    drawScheduler?.scheduleDraw(drawOptions)
  const drawWaveformNow = (drawOptions: HorizontalBrowseRawWaveformDrawOptions = {}) =>
    drawScheduler?.drawNow(drawOptions)
  const clearStablePlaybackRenderRetryTimer = () =>
    drawScheduler?.clearStablePlaybackRenderRetryTimer()
  const scheduleStablePlaybackRenderRetry = (retryAfterMs: number) =>
    drawScheduler?.scheduleStablePlaybackRenderRetry(retryAfterMs)
  // worker overlay 独立渲染，即使 displayReady=false，也会跟随当前 range 立即更新。
  const displayStartSec = ref(0)
  const {
    displayViewportStartSec,
    displayViewportDurationSec,
    displayViewportRevision,
    resetDisplayViewport,
    rememberRenderViewport,
    applyDisplayViewport,
    applyRenderedViewport
  } = createHorizontalBrowseRawWaveformDisplayViewportState()
  let lastQueuedPlaybackSyncRevision = -1
  let playbackRawSettleUntilMs = 0
  let lastQueuedPlaybackRawSlot: 'live' | null = null
  let lastQueuedMissingPlaybackRawSyncRevision = -1
  let lastQueuedStableRenderRevision = -1
  let stableFullRenderTimer: ReturnType<typeof setTimeout> | null = null
  let stableViewportRenderPendingUntilMs = 0
  let pendingStableRevisionRender: {
    revision: number
    token: number
    kind: StableRevisionRenderKind
  } | null = null
  let linkedReleaseActivation: 'linked' | 'stable' | null = null
  let lastRenderedRangeStartSec: number | null = null
  let lastRenderedRangeDurationSec: number | null = null
  let queuedPreviewTimeScale = 1
  const clearStableRevisionReplacementState = () => {
    pendingStableRevisionRender = null
  }
  const surfaceVisibility = createHorizontalBrowseRawWaveformSurfaceVisibility({
    waveformSurfaceRef,
    overlaySurfaceRef,
    syncBufferVisibility: () => liveCanvasBuffers.syncVisibility(),
    clearStableRevisionReplacementState,
    fadeInMs: WAVEFORM_SURFACE_FADE_IN_MS
  })
  const {
    displayReady,
    placeholderVisible,
    clearDisplayReadyRevealTimer,
    setDisplayReady,
    setWaveformSurfaceVisible,
    syncWaveformSurfaceVisibility,
    resolveDisplayReadyForReuse
  } = surfaceVisibility

  const stablePresentation = createHorizontalBrowseStableCanvasPresentationController({
    isActive: () => resolveStableWaveformSource(),
    isPlaying: () => options.playing.value,
    isDragging: () => options.dragging.value,
    currentSeconds: () => Number(options.currentSeconds()) || 0,
    playbackRate: () => Number(options.playbackRate()) || 1,
    loopRange: options.loopRange,
    linkedPlaybackActive: () => options.linkedGridActive?.() === true,
    renderRevision: () => resolveStableRenderRevision(),
    resolveViewportRangeStartSec: (seconds, visibleDurationOverrideSec) =>
      resolvePlaybackAlignedStart(seconds, visibleDurationOverrideSec),
    waveformCanvas: () => liveCanvasBuffers.presentationWaveformCanvas(),
    overlayCanvas: () => liveCanvasBuffers.presentationOverlayCanvas(),
    scheduleDraw: () => drawWaveformNow(),
    onPresentationApplied: () => {
      syncDisplayViewportFromRenderedCanvas()
    }
  })

  const liveCanvasBridge = createHorizontalBrowseDetailLiveCanvasBridge({
    onRendered: (payload) => handleLiveCanvasRendered(payload),
    onPresentation: (payload) => handleLiveCanvasPresentation(payload)
  })
  const {
    resolvePreviewTimeScale,
    resolvePreviewDurationSec,
    canShowTimelinePlaceholder,
    resolveVisibleDurationSec,
    resolvePreviewAnchorSec,
    clampPreviewStart,
    resolveSnappedRenderStartSec,
    resolvePlaybackDrivenRenderStartSec,
    resolveWaveformLayout,
    resolvePlaybackAlignedStart
  } = createHorizontalBrowseRawWaveformViewport(options)
  const dragReleaseState = createHorizontalBrowseRawWaveformDragReleaseState({
    playing: options.playing,
    dragging: options.dragging,
    currentSeconds: options.currentSeconds,
    resolvePlaybackAlignedStart,
    resolveVisibleDurationSec,
    resolveStableWaveformSource: () => resolveStableWaveformSource(),
    drawWaveformNow
  })

  const resolveStableWaveformSource = () => options.stableWaveformSource?.() === true
  const resolveStableRenderRevision = () =>
    Math.max(0, Math.floor(Number(options.stableRenderRevision?.()) || 0))

  const resetLiveWaveformData = () => {
    clearStableFullRenderTimer()
    clearStablePlaybackRenderRetryTimer()
    dragPresentation.stop()
    dragReleaseState.reset()
    linkedReleaseActivation = null
    surfaceVisibility.clearPreservedSurface()
    clearStableRevisionReplacementState()
    liveCanvasRenderToken += 1
    liveCanvasBridge.clearRaw()
    drawState.suppressNextPlaybackScrollReuse = false
    drawState.lastDrawPlaybackActive = false
    drawState.lastRenderedRawData = null
    playbackRawSettleUntilMs = 0
    lastQueuedPlaybackRawSlot = null
    lastQueuedMissingPlaybackRawSyncRevision = -1
    lastQueuedStableRenderRevision = -1
    lastRenderedRangeStartSec = null
    lastRenderedRangeDurationSec = null
    stablePresentation.clear()
    clearLiveCanvasPresentationOffset()
    resetDisplayViewport()
    setDisplayReady(false)
  }

  const resetWaveformRenderState = (resetOptions: { preserveDisplay?: boolean } = {}) => {
    clearStableFullRenderTimer()
    clearStablePlaybackRenderRetryTimer()
    const preserveDisplay = resetOptions.preserveDisplay === true && resolveDisplayReadyForReuse()
    if (!preserveDisplay) {
      liveCanvasRenderToken += 1
      dragPresentation.invalidateFrames()
      clearStableRevisionReplacementState()
      setDisplayReady(false)
      liveCanvasBridge.clear()
      // worker 的 clear 会清掉块画布像素，块池状态必须同步失效，否则会误判「这块已画过」。
      resetTilePools()
      drawState.lastRenderedRawData = null
      drawState.suppressNextPlaybackScrollReuse = true
    }
    playbackRawSettleUntilMs = 0
    lastQueuedPlaybackRawSlot = null
    lastQueuedMissingPlaybackRawSyncRevision = -1
    lastQueuedStableRenderRevision = -1
    lastRenderedRangeStartSec = null
    lastRenderedRangeDurationSec = null
    if (!preserveDisplay) {
      resetDisplayViewport()
    }
    clearStableRevisionReplacementState()
    stablePresentation.clear()
  }

  const clearCanvas = () => {
    clearStableFullRenderTimer()
    clearStablePlaybackRenderRetryTimer()
    dragPresentation.stop()
    dragReleaseState.reset()
    linkedReleaseActivation = null
    surfaceVisibility.clearPreservedSurface()
    clearStableRevisionReplacementState()
    placeholderVisible.value = false
    liveCanvasRenderToken += 1
    liveCanvasBridge.clear()
    resetTilePools()
    lastRenderedRangeStartSec = null
    lastRenderedRangeDurationSec = null
    lastQueuedStableRenderRevision = -1
    resetDisplayViewport()
    stablePresentation.clear()
    clearLiveCanvasPresentationOffset()
    setDisplayReady(false)
    clearHorizontalBrowseRawWaveformGridCanvas(gridCanvasRef.value)
  }

  const clearGridCanvas = () => {
    clearHorizontalBrowseRawWaveformGridCanvas(gridCanvasRef.value)
  }

  const ensureLiveCanvasMounted = () => {
    if (liveCanvasAttached) return true
    const tileCanvases = liveCanvasBuffers.tileCanvases()
    liveCanvasAttached = liveCanvasBridge.mount(
      liveCanvasBuffers.waveformCanvases(),
      liveCanvasBuffers.overlayCanvases(),
      isHorizontalBrowseWaveformTileRenderingEnabled() ? tileCanvases : []
    )
    return liveCanvasAttached
  }

  const {
    resetTilePools,
    resolveTileForwardDirection,
    resolveTileRenderPlan,
    commitRenderedTileSlots
  } = createHorizontalBrowseWaveformTileRendering({
    buffers: liveCanvasBuffers,
    isPlaying: () => options.playing.value && !options.dragging.value,
    getViewportStartSec: () => displayViewportStartSec.value,
    getTimeScale: resolvePreviewTimeScale
  })

  const commitLiveCanvasRendered = (payload: LiveCanvasRenderedPayload) => {
    if (payload.renderToken !== liveCanvasRenderToken) return
    commitRenderedTileSlots(payload)
    // 屏幕外块（P1/P2）补齐的回报只用于登记块池：可见面早已在 P0 就绪时切换过，
    // 这里不能再走一遍 promote / displayReady，否则会重复触发可见面切换。
    if (payload.renderedTileSlotIndexes?.length && payload.renderViewportOnly === true) return
    if (dragPresentation.isActive()) {
      dragPresentation.commit(payload.renderToken, payload.ready, (offset, viewportStartSec) => {
        const index = payload.renderTargetIndex === 1 ? 1 : 0
        const tiled = payload.renderedTileSlotIndexes !== undefined
        options.onPreparingPreviewTimeScale?.(queuedPreviewTimeScale, index)
        liveCanvasBuffers.withPresentationTarget(index, tiled, () =>
          liveCanvasBuffers.applyPresentationOffset(offset, true)
        )
        liveCanvasBuffers.activate(index, tiled)
        lastRenderedRangeStartSec = payload.rangeStartSec
        lastRenderedRangeDurationSec = payload.rangeDurationSec
        applyDisplayViewport(viewportStartSec, resolveVisibleDurationSec())
        setDisplayReady(true)
        options.onPresentedPreviewTimeScale?.(queuedPreviewTimeScale)
        stablePresentation.clear()
      })
      return
    }
    const pendingStableRender = pendingStableRevisionRender
    if (pendingStableRender?.token === payload.renderToken) {
      pendingStableRevisionRender = null
    }
    let forceStableViewportStart = false
    if (dragReleaseState.pending && payload.ready) {
      const canCompleteRelease = dragReleaseState.canComplete(payload, queuedReleasePlaybackFrame)
      const releaseExpired = dragReleaseState.isExpired()
      const playingReadyRelease = options.playing.value && !options.dragging.value
      if (
        !shouldCommitHorizontalBrowseDragReleaseRenderedViewport({
          pending: true,
          canCompleteRelease,
          releaseExpired
        })
      ) {
        drawWaveformNow({ preferPreviewStart: true })
        return
      }
      const canForceStableRelease =
        releaseExpired &&
        payload.stableWaveformSource === true &&
        dragReleaseState.viewportStartSec !== null
      const forcedStableRelease =
        canForceStableRelease && !canCompleteRelease && !playingReadyRelease
      forceStableViewportStart = true
      dragReleaseState.finish({ requiresFreshFrame: forcedStableRelease })
    }
    const placeholderPresentationReady = !payload.ready && placeholderVisible.value
    const preservePreviousSurfaceOnNotReady =
      !payload.ready &&
      !placeholderPresentationReady &&
      (surfaceVisibility.isPreservingSurface() ||
        (payload.stableWaveformSource === true && displayReady.value))
    if (payload.ready) {
      lastRenderedRangeStartSec = payload.rangeStartSec
      lastRenderedRangeDurationSec = payload.rangeDurationSec
    } else if (!preservePreviousSurfaceOnNotReady) {
      lastRenderedRangeStartSec = null
      lastRenderedRangeDurationSec = null
    }
    applyRenderedViewport(payload)
    displayStartSec.value = payload.rangeStartSec
    const renderTargetIndex = Number.isInteger(payload.renderTargetIndex)
      ? Number(payload.renderTargetIndex)
      : null
    const stableViewportOnlyRender =
      payload.ready && payload.stableWaveformSource === true && payload.renderViewportOnly === true
    if (payload.ready && renderTargetIndex !== null) {
      options.onPreparingPreviewTimeScale?.(queuedPreviewTimeScale, renderTargetIndex === 1 ? 1 : 0)
    }
    if (preservePreviousSurfaceOnNotReady) return
    if (renderTargetIndex !== null && (payload.ready || placeholderPresentationReady)) {
      const tiled = payload.renderedTileSlotIndexes !== undefined
      if (payload.stableWaveformSource === true) {
        liveCanvasBuffers.withPresentationTarget(renderTargetIndex, tiled, () =>
          stablePresentation.handleRendered(
            { ...payload, ready: true },
            { forceViewportRangeStart: forceStableViewportStart }
          )
        )
      } else if (forceStableViewportStart) {
        liveCanvasBuffers.withPresentationTarget(renderTargetIndex, tiled, () =>
          liveCanvasBuffers.applyPresentationOffset(queuedLivePresentation?.offsetCssPx ?? 0, true)
        )
      }
      if (!stableViewportOnlyRender) {
        liveCanvasBuffers.activate(renderTargetIndex, tiled)
        if (payload.ready) linkedReleaseActivation = null
      }
    }
    if (!payload.ready) {
      setDisplayReady(false)
      return
    }
    setDisplayReady(true)
    options.onPresentedPreviewTimeScale?.(queuedPreviewTimeScale)
    syncDisplayViewportFromRenderedCanvas()
    if (
      payload.renderViewportOnly === true &&
      resolveStableWaveformSource() &&
      !options.playing.value
    ) {
      scheduleStableFullRender()
    }
  }

  const handleLiveCanvasRendered = (payload: LiveCanvasRenderedPayload) => {
    if (payload.renderToken !== liveCanvasRenderToken) return
    const playbackFrame = payload.stableWaveformSource !== true && queuedReleasePlaybackFrame
    const stableFrame = payload.stableWaveformSource === true
    const shouldSynchronizeLinkedReleaseActivation =
      (linkedReleaseActivation === 'linked'
        ? stableFrame || playbackFrame
        : linkedReleaseActivation === 'stable' &&
          stableFrame &&
          options.linkedGridActive?.() === true) &&
      payload.ready &&
      payload.renderViewportOnly !== true &&
      Number.isInteger(payload.renderTargetIndex)
    if (!shouldSynchronizeLinkedReleaseActivation) {
      commitLiveCanvasRendered(payload)
      return
    }
    queueHorizontalBrowseLinkedCanvasActivation(options.direction(), {
      commit: () => commitLiveCanvasRendered(payload),
      playbackFrame,
      isCurrent: () => payload.renderToken === liveCanvasRenderToken
    })
  }

  const clearLiveCanvasPresentationOffset = () => liveCanvasBuffers.applyPresentationOffset(0, true)

  const handleLiveCanvasPresentation = (payload: LiveCanvasPresentationPayload) => {
    if (dragPresentation.isActive()) return
    if (payload.renderToken !== liveCanvasRenderToken) return
    if (!queuedLivePresentation) return
    const offset = Number(payload.offsetCssPx) || 0
    queuedLivePresentation.offsetCssPx = offset
    if (dragReleaseState.pending) return
    const { index } = queuedLivePresentation
    if (index === liveCanvasBuffers.activeIndex()) {
      liveCanvasBuffers.applyPresentationOffset(offset, true)
      syncDisplayViewportFromRenderedCanvas()
      return
    }
    liveCanvasBuffers.withPresentationTarget(index, false, () =>
      liveCanvasBuffers.applyPresentationOffset(offset, true)
    )
  }

  const queueLiveWaveformRender = (payload: HorizontalBrowseLiveWaveformRenderPayload) => {
    const wrap = wrapRef.value
    if (!wrap || !ensureLiveCanvasMounted()) return false
    const wrapRect = wrap.getBoundingClientRect()
    const wrapStyle = getComputedStyle(wrap)
    const waveformLayout = resolveWaveformLayout()
    const waveformRenderStyle = options.waveformRenderStyle()
    const pixelRatio = window.devicePixelRatio || 1
    // 画布几何使用布局尺寸；官网预览外层的 transform 缩放不能再次计入画布尺寸。
    // computed style 保留亚像素精度，避免 clientWidth / clientHeight 的整数取整。
    const wrapWidth = Math.max(1, Number.parseFloat(wrapStyle.width) || 0)
    const wrapHeight = Math.max(1, Number.parseFloat(wrapStyle.height) || 0)
    const width = resolvePixelSnappedCssSize(wrapWidth, pixelRatio)
    const height = resolvePixelSnappedCssSize(wrapHeight, pixelRatio)
    const dragRender = payload.dragPresentation === true
    const sourcePlaybackActive = options.playing.value && !options.dragging.value && !dragRender
    const stableWaveformSource = dragRender || resolveStableWaveformSource()
    const stableOverscanCssPx = stableWaveformSource
      ? resolveHorizontalBrowseStableOverscanCssPx(width, pixelRatio)
      : 0
    const dragGuardCssPx = dragRender ? Math.min(stableOverscanCssPx, width * 0.5) : 0
    const viewportOnly = payload.viewportOnly === true && !stableWaveformSource
    const renderWidth = width + stableOverscanCssPx * 2
    const renderDurationScale = renderWidth / Math.max(1, width)
    const renderRangeDurationSec = payload.rangeDurationSec * renderDurationScale
    const playheadCanvasX =
      stableOverscanCssPx + wrapWidth * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    const rawSlot = resolveHorizontalBrowseRawSlotForRender(payload.rawData)
    const playbackSyncRevision = Math.max(
      0,
      Math.floor(Number(options.playbackSyncRevision.value) || 0)
    )
    const preferRawPeaksOnly =
      payload.preferRawPeaksOnly ||
      (waveformLayout === 'full' && waveformRenderStyle === 'columns') ||
      shouldUseAttackSafeRawPeaks(payload.rangeDurationSec, width, pixelRatio, waveformRenderStyle)
    const nowMs = performance.now()
    const playbackActive = sourcePlaybackActive && !stableWaveformSource
    const playbackSyncChanged =
      playbackActive &&
      !stableWaveformSource &&
      playbackSyncRevision !== lastQueuedPlaybackSyncRevision
    const renderPlaybackSyncRevision = stableWaveformSource
      ? resolveStableRenderRevision()
      : playbackSyncRevision
    const playbackRawRecovering = playbackActive && !!rawSlot && !displayReady.value
    const allowScrollReuse = payload.allowScrollReuse && !playbackSyncChanged
    const renderBpm = Number(options.previewBpm.value) || 0
    const renderFirstBeatMs = Number(options.previewFirstBeatMs.value) || 0
    const renderDownbeatBeatOffset = Number(options.previewDownbeatBeatOffset.value) || 0
    const renderBeatGridMap = cloneSongBeatGridMapForHorizontalBrowseWorker(
      options.beatGridMap?.() ?? options.song()?.beatGridMap ?? null
    )
    const renderRekordboxGridEntries = cloneRekordboxBeatGridEntriesForHorizontalBrowseWorker(
      options.rekordboxGridEntries?.() ?? options.song()?.rekordboxGridEntries
    )
    const renderBeatGridEditMode = options.beatGridEditMode?.() === true
    const rawBeatGridVisibleFromSec = Number(options.beatGridVisibleFromSec?.())
    const renderBeatGridVisibleFromSec =
      renderBeatGridEditMode && Number.isFinite(rawBeatGridVisibleFromSec)
        ? Math.max(0, rawBeatGridVisibleFromSec)
        : null
    const rawBeatGridSelectedBoundarySec = Number(options.beatGridSelectedBoundarySec?.())
    const renderBeatGridSelectedBoundarySec =
      renderBeatGridEditMode && Number.isFinite(rawBeatGridSelectedBoundarySec)
        ? Math.max(0, rawBeatGridSelectedBoundarySec)
        : null
    const showBeatGrid = renderBpm > 0 || !!renderBeatGridMap
    const renderPlaybackDurationSec = resolveHorizontalBrowsePlaybackDurationSecForRender(
      payload.rawData,
      resolvePreviewDurationSec(),
      resolveTimeBasisOffsetSec()
    )
    const renderTimeBasisOffsetMs = Number(options.previewTimeBasisOffsetMs.value) || 0
    const playbackRate = Math.max(0.25, Number(options.playbackRate()) || 1)
    const sourcePlaybackSeconds = Number(options.currentSeconds()) || 0
    const anchorStartedAtMs = performance.now()
    const linkedGridPhaseLocked = dragReleaseState.pending || dragReleaseState.active.value
    const visualGridPhase = resolveHorizontalBrowseLinkedGridVisualPhase({
      direction: options.direction(),
      active: waveformLayout !== 'full' && options.linkedGridActive?.() === true,
      clockActive: sourcePlaybackActive,
      bpm: renderBpm,
      firstBeatMs: renderFirstBeatMs,
      downbeatBeatOffset: renderDownbeatBeatOffset,
      currentSec: sourcePlaybackSeconds,
      playbackRate,
      phaseLocked: linkedGridPhaseLocked
    })
    const playbackSeconds = visualGridPhase.playbackSeconds
    const preferPreviewStart = payload.preferPreviewStart === true
    const suppressStablePlaybackRender =
      stableWaveformSource &&
      sourcePlaybackActive &&
      !preferPreviewStart &&
      !viewportOnly &&
      nowMs < stableViewportRenderPendingUntilMs
    const stableRevisionRenderKind = resolveHorizontalBrowseStableRevisionRenderKind(
      preferPreviewStart,
      viewportOnly
    )
    const stableRevisionChanged =
      !dragRender &&
      stableWaveformSource &&
      renderPlaybackSyncRevision !== lastQueuedStableRenderRevision
    const { renderAnchorSec, renderRangeStartSec, viewportRangeStartSec } =
      resolveHorizontalBrowseRawWaveformRenderViewport({
        usePreviewStart:
          !dragRender && (preferPreviewStart || (!sourcePlaybackActive && !visualGridPhase.linked)),
        rangeStartSec: payload.rangeStartSec,
        rangeDurationSec: payload.rangeDurationSec,
        playbackSeconds: dragRender
          ? payload.rangeStartSec +
            payload.rangeDurationSec * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
          : playbackSeconds,
        playheadCanvasX,
        renderWidth,
        renderRangeDurationSec,
        stableWaveformSource,
        stableOverscanCssPx,
        viewportLeftCssPx: wrapRect.left,
        pixelRatio
      })
    const duplicateStableRevisionRenderPending =
      stableWaveformSource &&
      !stableRevisionChanged &&
      !!pendingStableRevisionRender &&
      pendingStableRevisionRender.revision === renderPlaybackSyncRevision &&
      !displayReady.value &&
      surfaceVisibility.isPreservingSurface()
    if (
      duplicateStableRevisionRenderPending &&
      pendingStableRevisionRender &&
      !canReplacePendingHorizontalBrowseStableRevisionRender(
        pendingStableRevisionRender.kind,
        stableRevisionRenderKind
      )
    ) {
      return false
    }
    if (suppressStablePlaybackRender) {
      scheduleStablePlaybackRenderRetry(stableViewportRenderPendingUntilMs)
      return false
    }
    if (stableWaveformSource) {
      liveCanvasBridge.stopPlayback()
    } else if (playbackSyncChanged) {
      playbackRawSettleUntilMs = nowMs + PLAYBACK_RAW_SETTLE_HOLD_MS
      lastQueuedPlaybackRawSlot = null
      liveCanvasBridge.stopPlayback()
    }
    if (!playbackActive) {
      playbackRawSettleUntilMs = 0
      lastQueuedPlaybackRawSlot = null
      lastQueuedMissingPlaybackRawSyncRevision = -1
      if (!stableWaveformSource) liveCanvasBridge.stopPlayback()
      if (!stableWaveformSource) clearLiveCanvasPresentationOffset()
    }
    lastQueuedPlaybackSyncRevision = playbackSyncRevision
    if (playbackActive && !rawSlot && !displayReady.value) {
      if (lastQueuedMissingPlaybackRawSyncRevision === playbackSyncRevision) {
        return false
      }
      lastQueuedMissingPlaybackRawSyncRevision = playbackSyncRevision
    } else if (rawSlot) {
      lastQueuedMissingPlaybackRawSyncRevision = -1
    }
    if (
      playbackActive &&
      rawSlot &&
      lastQueuedPlaybackRawSlot === rawSlot &&
      displayReady.value &&
      nowMs < playbackRawSettleUntilMs
    ) {
      return false
    }
    const previousDisplayReady = resolveDisplayReadyForReuse()
    if (!stableWaveformSource) {
      lastQueuedStableRenderRevision = -1
      clearStableRevisionReplacementState()
    } else if (stableRevisionChanged) {
      liveCanvasBridge.stopPlayback()
    }
    const renderToken = liveCanvasRenderToken + 1
    liveCanvasRenderToken = renderToken
    if (stableWaveformSource && !dragRender) {
      lastQueuedStableRenderRevision = renderPlaybackSyncRevision
    }
    stablePresentation.queueRenderFrame(
      stableWaveformSource && !dragRender,
      renderToken,
      renderPlaybackSyncRevision,
      sourcePlaybackActive,
      renderRangeStartSec,
      renderRangeDurationSec,
      viewportRangeStartSec,
      renderAnchorSec,
      anchorStartedAtMs,
      playbackRate,
      renderWidth,
      stableOverscanCssPx,
      pixelRatio
    )
    if (stableWaveformSource && !dragRender) {
      pendingStableRevisionRender = {
        revision: renderPlaybackSyncRevision,
        token: renderToken,
        kind: stableRevisionRenderKind
      }
    }
    if (stableRevisionChanged) {
      if (previousDisplayReady && sourcePlaybackActive) {
        stablePresentation.measure(playbackSeconds, {
          allowRevisionHandoff: true,
          useFrameViewportForRevisionHandoff: true
        })
      }
      if (previousDisplayReady) {
        surfaceVisibility.preserveUntilNextReady()
      } else {
        surfaceVisibility.clearPreservedSurface()
      }
      setDisplayReady(false)
    }
    if (stableWaveformSource && viewportOnly) {
      stableViewportRenderPendingUntilMs = performance.now() + STABLE_VIEWPORT_RENDER_HOLD_MS
    }
    const renderSourceIndex = liveCanvasBuffers.activeIndex()
    queuedReleasePlaybackFrame = sourcePlaybackActive && dragReleaseState.pending
    // macOS 播放时从瓦片切到 Worker 整帧，先在隐藏缓冲区准备波形和网格。
    const renderTargetIndex =
      stableWaveformSource ||
      liveCanvasBuffers.isActiveTiled() ||
      (linkedReleaseActivation === 'linked' && queuedReleasePlaybackFrame)
        ? liveCanvasBuffers.inactiveIndex()
        : renderSourceIndex
    queuedLivePresentation = stableWaveformSource
      ? null
      : { index: renderTargetIndex, offsetCssPx: 0 }
    const reuseVisibleFrame =
      allowScrollReuse && (stableWaveformSource || renderTargetIndex === renderSourceIndex)
    const renderRequest = {
      renderToken,
      renderPriority: stableWaveformSource ? 'immediate' : 'normal',
      renderTargetIndex,
      renderSourceIndex: stableWaveformSource ? renderSourceIndex : renderTargetIndex,
      renderViewportOnly: viewportOnly,
      width: renderWidth,
      height,
      pixelRatio,
      bpm: renderBpm,
      firstBeatMs: renderFirstBeatMs,
      downbeatBeatOffset: visualGridPhase.downbeatBeatOffset,
      beatGridMap: renderBeatGridMap,
      rekordboxGridEntries: renderRekordboxGridEntries,
      beatGridEditMode: renderBeatGridEditMode,
      beatGridVisibleFromSec: renderBeatGridVisibleFromSec,
      beatGridSelectedBoundarySec: renderBeatGridSelectedBoundarySec,
      showGridClipBoundaries:
        renderBeatGridEditMode || options.showGridClipBoundaries?.() !== false,
      timeBasisOffsetMs: renderTimeBasisOffsetMs,
      rangeStartSec: renderRangeStartSec,
      rangeDurationSec: renderRangeDurationSec,
      viewportWidth: width,
      viewportRangeStartSec,
      viewportRangeDurationSec: payload.rangeDurationSec,
      maxSamplesPerPixel: payload.maxSamplesPerPixel,
      showDetailHighlights: false,
      showCenterLine: false,
      showBackground: false,
      showBeatGrid,
      allowScrollReuse: reuseVisibleFrame,
      phaseAwareScrollReuse: reuseVisibleFrame && options.phaseAwareScrollReuse?.() === true,
      presentationOffsetMode: stableWaveformSource ? 'device-pixel' : 'free',
      stableWaveformSource,
      waveformLayout,
      waveformRenderStyle,
      preferRawPeaksOnly,
      // 网格和真实波形优先级高于空时间轴占位，避免中间态叠在一起。
      showTimelinePlaceholder:
        canShowTimelinePlaceholder() &&
        !showBeatGrid &&
        !hasHorizontalBrowseDrawableRawFrames(payload.rawData),
      themeVariant: resolveHorizontalBrowseWaveformThemeVariant(),
      rawSlot,
      direction: options.direction(),
      cueSeconds: Number.isFinite(Number(options.cueSeconds()))
        ? Number(options.cueSeconds())
        : null,
      hotCues: normalizeSongHotCues(options.hotCues()),
      memoryCues: normalizeSongMemoryCues(options.memoryCues()),
      loopRange: resolveHorizontalBrowseWorkerLoopRange(options.loopRange()),
      audioEditSelection: resolveHorizontalBrowseWorkerLoopRange(options.audioEditSelection?.()),
      audioEditPendingStartSec:
        options.audioEditPendingStartSec?.() == null
          ? null
          : Number(options.audioEditPendingStartSec()) || 0,
      audioEditPendingEndSec:
        options.audioEditPendingEndSec?.() == null
          ? null
          : Number(options.audioEditPendingEndSec()) || 0,
      audioEditAccentColor: resolveHorizontalBrowseAudioEditAccentColor(),
      cueAccentColor: resolveHorizontalBrowseCueAccentColor(),
      playbackActive,
      playbackSeconds,
      playbackSyncRevision: renderPlaybackSyncRevision,
      playbackRate,
      playbackRenderClockEpochMs: playbackActive
        ? visualGridPhase.playbackRenderClockEpochMs
        : null,
      playbackDurationSec: renderPlaybackDurationSec,
      waveformGain: resolveHorizontalBrowseWaveformGain(options.waveformGain?.()),
      // 稳定帧有波形数据时才画瓦片。占位帧和 Worker 滚动帧使用整帧画布。
      tilePlan:
        stableWaveformSource && rawSlot
          ? resolveTileRenderPlan({
              renderToken,
              renderTargetIndex,
              renderWidthCssPx: renderWidth,
              heightCssPx: height,
              pixelRatio,
              rangeStartSec: renderRangeStartSec,
              rangeDurationSec: renderRangeDurationSec,
              viewportStartCssPx: stableOverscanCssPx - dragGuardCssPx,
              viewportWidthCssPx: width + dragGuardCssPx * 2,
              renderRevision: renderPlaybackSyncRevision,
              // 播放推进方向即前向；拖拽时按拖动方向，交由 P1/P2 互换决定补齐顺序。
              forward: resolveTileForwardDirection()
            })
          : null
    } satisfies Parameters<typeof liveCanvasBridge.render>[0]
    liveCanvasBuffers.setGeometry(
      renderTargetIndex,
      renderRequest.tilePlan !== null,
      -stableOverscanCssPx,
      renderWidth,
      height,
      height + HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX * 2
    )
    if (dragRender) {
      const guardSec = (dragGuardCssPx * payload.rangeDurationSec) / width
      dragPresentation.rememberFrame(renderToken, {
        viewportStartSec: viewportRangeStartSec,
        minViewportStartSec: viewportRangeStartSec - guardSec,
        maxViewportStartSec: viewportRangeStartSec + guardSec,
        pixelsPerSec: width / payload.rangeDurationSec,
        offsetCssPx: 0
      })
    }
    rememberRenderViewport(renderRequest)
    queuedPreviewTimeScale = resolvePreviewTimeScale()
    liveCanvasBridge.render(renderRequest)
    if (playbackRawRecovering) {
      playbackRawSettleUntilMs = Math.max(
        playbackRawSettleUntilMs,
        nowMs + PLAYBACK_RAW_SETTLE_HOLD_MS
      )
    }
    lastQueuedPlaybackRawSlot = playbackActive ? rawSlot : null
    return true
  }

  const resolveTimeBasisOffsetSec = () =>
    Math.max(0, Number(options.previewTimeBasisOffsetMs.value) || 0) / 1000

  const invalidateWaveformTiles = (invalidateOptions: { preserveDisplay?: boolean } = {}) => {
    liveCanvasRenderToken += 1
    dragPresentation.invalidateFrames()
    if (invalidateOptions.preserveDisplay === true && resolveDisplayReadyForReuse()) {
      surfaceVisibility.preserveUntilNextReady()
      return
    }
    resetDisplayViewport()
    clearStableRevisionReplacementState()
    liveCanvasBridge.clear()
    resetTilePools()
  }

  const drawWaveform = createHorizontalBrowseRawWaveformDraw({
    options,
    state: drawState,
    wrapRef,
    activeWaveformCanvas: () => liveCanvasBuffers.activeWaveformCanvas(),
    dragPresentationActive: () => dragPresentation.isActive(),
    resolvePreviewDurationSec,
    resolveVisibleDurationSec,
    clampPreviewStart,
    resolveSnappedRenderStartSec,
    resolvePlaybackDrivenRenderStartSec,
    resolveDisplayReadyForReuse,
    resolveStableWaveformSource,
    resolveTimeBasisOffsetSec,
    canShowTimelinePlaceholder,
    placeholderVisible,
    clearCanvas,
    setDisplayReady,
    queueLiveWaveformRender
  })
  drawScheduler = createHorizontalBrowseRawWaveformDrawScheduler({
    draw: (drawOptions) => {
      if (dragPresentation.isActive()) dragPresentation.update()
      else drawWaveform(drawOptions)
    }
  })

  const clearStableFullRenderTimer = () => {
    if (!stableFullRenderTimer) return
    clearTimeout(stableFullRenderTimer)
    stableFullRenderTimer = null
  }

  const scheduleStableFullRender = () => {
    clearStableFullRenderTimer()
    stableFullRenderTimer = setTimeout(() => {
      stableFullRenderTimer = null
      drawWaveform({ preferPreviewStart: true })
    }, STABLE_FULL_RENDER_DELAY_MS)
  }

  const resolveRenderedCanvasViewportStartSec = () =>
    liveCanvasBuffers.resolveActiveViewportStartSec(
      lastRenderedRangeStartSec,
      lastRenderedRangeDurationSec
    )

  const syncDisplayViewportFromRenderedCanvas = () => {
    const viewportStartSec = resolveRenderedCanvasViewportStartSec()
    const viewportDurationSec = Math.max(0.001, Number(resolveVisibleDurationSec()) || 0)
    if (typeof viewportStartSec !== 'number' || !Number.isFinite(viewportStartSec)) return false
    return applyDisplayViewport(viewportStartSec, viewportDurationSec)
  }

  const beginDragCanvasPresentation = () => {
    const fromLivePlayback = options.playing.value && !resolveStableWaveformSource()
    const viewportStartSec = fromLivePlayback
      ? resolvePlaybackAlignedStart(Number(options.currentSeconds()) || 0)
      : resolveRenderedCanvasViewportStartSec()
    linkedReleaseActivation = null
    playbackRawSettleUntilMs = 0
    dragReleaseState.reset()
    surfaceVisibility.clearPreservedSurface()
    clearStableRevisionReplacementState()
    stablePresentation.stopPlayback()
    liveCanvasBridge.stopPlayback()
    const duration = resolveVisibleDurationSec()
    const rangeStartSec = fromLivePlayback ? viewportStartSec : lastRenderedRangeStartSec
    const rangeDurationSec = fromLivePlayback ? duration : lastRenderedRangeDurationSec
    const width = wrapRef.value?.clientWidth ?? 0
    dragPresentation.start(
      viewportStartSec === null || rangeStartSec === null || rangeDurationSec === null
        ? null
        : {
            viewportStartSec,
            minViewportStartSec: Math.min(viewportStartSec, rangeStartSec),
            maxViewportStartSec: Math.max(
              viewportStartSec,
              rangeStartSec + rangeDurationSec - duration
            ),
            pixelsPerSec: width / duration,
            offsetCssPx: liveCanvasBuffers.resolveActiveTranslateX()
          },
      fromLivePlayback
    )
    return {
      viewportStartSec
    }
  }

  const dragPresentation = createHorizontalBrowseRawWaveformDragPresentation({
    getViewportStartSec: () => options.previewStartSec.value,
    requestFrame: (viewportStartSec) => {
      const rawData = options.rawData.value
      if (!hasHorizontalBrowseDrawableRawFrames(rawData)) return
      queueLiveWaveformRender({
        rangeStartSec: viewportStartSec,
        rangeDurationSec: resolveVisibleDurationSec(),
        rawData,
        maxSamplesPerPixel: PREVIEW_MAX_SAMPLES_PER_PIXEL,
        allowScrollReuse: false,
        preferRawPeaksOnly: false,
        dragPresentation: true
      })
    },
    present: (offset, viewportStartSec) => {
      liveCanvasBuffers.applyPresentationOffset(offset, true)
      applyDisplayViewport(viewportStartSec, resolveVisibleDurationSec())
    }
  })

  const endDragCanvasPresentation = (viewportStartSec?: number, linkedRelease = false) => {
    if (!dragPresentation.isActive()) {
      return {
        requiresRender: false
      }
    }
    const safeViewportStartSec = Number.isFinite(Number(viewportStartSec))
      ? Number(viewportStartSec)
      : null
    linkedReleaseActivation = linkedRelease
      ? 'linked'
      : options.linkedGridActive?.() === true
        ? 'stable'
        : null
    const visibleDurationSec = Math.max(0.001, Number(resolveVisibleDurationSec()) || 0)
    if (dragPresentation.stop()) liveCanvasRenderToken += 1
    dragReleaseState.resetForDragEnd(safeViewportStartSec)
    if (safeViewportStartSec !== null) {
      applyDisplayViewport(safeViewportStartSec, visibleDurationSec)
    }
    if (
      safeViewportStartSec !== null &&
      resolveStableWaveformSource() &&
      stablePresentation.applyViewportRangeStart(safeViewportStartSec)
    ) {
      dragReleaseState.reset()
      surfaceVisibility.preserveUntilNextReady()
      syncDisplayViewportFromRenderedCanvas()
      return {
        requiresRender: true
      }
    }
    dragReleaseState.startPending(safeViewportStartSec)
    surfaceVisibility.preserveUntilNextReady()
    return {
      requiresRender: true
    }
  }

  const hideStableCanvasPresentation = () => {
    clearStableFullRenderTimer()
    if (resolveDisplayReadyForReuse()) {
      surfaceVisibility.preserveUntilNextReady()
      surfaceVisibility.setStableSurfaceForceHidden(false)
      stablePresentation.stopPlayback()
      surfaceVisibility.setStablePresentationRevealAfterMs(0)
      syncWaveformSurfaceVisibility(false)
      return
    }
    surfaceVisibility.setStableSurfaceForceHidden(true)
    setWaveformSurfaceVisible(false, false)
    clearStableRevisionReplacementState()
    stablePresentation.clear()
    surfaceVisibility.setStablePresentationRevealAfterMs(
      performance.now() + STABLE_SEEK_REVEAL_HOLD_MS
    )
    setDisplayReady(false)
    clearLiveCanvasPresentationOffset()
  }

  const scheduleGridOverlayDraw = () => {
    scheduleDraw()
  }

  const resetGridRenderer = () => {
    clearGridCanvas()
  }

  const mountWaveformCanvasWorker = () => {
    ensureLiveCanvasMounted()
  }

  const replaceLiveWaveformRaw = (data: RawWaveformData | null) => {
    liveCanvasBridge.replaceRaw(data)
  }

  const stopLiveWaveformPlayback = (preservePresentation = false) => {
    syncDisplayViewportFromRenderedCanvas()
    liveCanvasBridge.stopPlayback()
    if (!preservePresentation) clearLiveCanvasPresentationOffset()
  }

  const dispose = () => {
    clearStableFullRenderTimer()
    clearDisplayReadyRevealTimer()
    resetLiveWaveformData()
    liveCanvasAttached = false
    drawScheduler?.dispose()
    liveCanvasBridge.dispose()
  }

  return {
    wrapRef,
    waveformSurfaceRef,
    waveformCanvasRef,
    waveformCanvasBackRef,
    resolveActiveCanvasBufferIndex: liveCanvasBuffers.activeIndex,
    waveformTileContainerRefs: liveCanvasBuffers.waveformTileContainerRefs,
    waveformTileCanvasRefs: liveCanvasBuffers.waveformTileCanvasRefs,
    gridCanvasRef,
    overlaySurfaceRef,
    overlayCanvasRef,
    overlayCanvasBackRef,
    resolvePreviewTimeScale,
    resolvePreviewDurationSec,
    resolveVisibleDurationSec,
    resolvePreviewAnchorSec,
    clampPreviewStart,
    resolveSnappedRenderStartSec,
    resolvePlaybackAlignedStart,
    resetWaveformRenderState,
    clearCanvas,
    invalidateWaveformTiles,
    mountWaveformCanvasWorker,
    scheduleDraw,
    drawWaveformNow,
    beginDragCanvasPresentation,
    updateDragCanvasPresentation: dragPresentation.update,
    endDragCanvasPresentation,
    syncDragPresentationReleaseViewportStart: dragReleaseState.syncViewportStart,
    consumeDragPresentationReleaseRequiresFreshFrame: dragReleaseState.consumeRequiresFreshFrame,
    resolveRenderedCanvasViewportStartSec,
    dragPresentationReleaseActive: dragReleaseState.active,
    scheduleGridOverlayDraw,
    resetGridRenderer,
    resetLiveWaveformData,
    stopLiveWaveformPlayback,
    measureStableCanvasPresentation: stablePresentation.measure,
    adoptStableCanvasRenderRevision: stablePresentation.adoptCurrentFrameRenderRevision,
    applyStableCanvasPresentation: stablePresentation.apply,
    startStableCanvasPlayback: stablePresentation.startPlayback,
    stopStableCanvasPlayback: stablePresentation.stopPlayback,
    reanchorStableCanvasPlayback: stablePresentation.reanchorPlayback,
    hideStableCanvasPresentation,
    replaceLiveWaveformRaw,
    displayStartSec,
    displayViewportStartSec,
    displayViewportDurationSec,
    displayViewportRevision,
    displayReady,
    placeholderVisible,
    dispose
  }
}
