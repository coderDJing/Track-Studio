import { ref } from 'vue'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { PREVIEW_MAX_SAMPLES_PER_PIXEL } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { shouldUseAttackSafeRawPeaks } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasPolicy'
import { startHorizontalBrowseUserTiming } from '@renderer/composables/horizontalBrowse/horizontalBrowseUserTiming'
import { resolveHorizontalBrowseWaveformThemeVariant } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformDetail.utils'
import { createHorizontalBrowseDetailLiveCanvasBridge } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailLiveCanvasBridge'
import { HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailOverlayCanvas'
import {
  resolveHorizontalBrowseStableOverscanCssPx,
  resolvePixelSnappedCssSize
} from '@renderer/composables/horizontalBrowse/horizontalBrowseCanvasGeometry'
import { createHorizontalBrowseStableCanvasPresentationController } from '@renderer/composables/horizontalBrowse/horizontalBrowseStableCanvasPresentation'
import { isHorizontalBrowseWaveformTileRenderingEnabled } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformTileFlag'
import { createHorizontalBrowseWaveformTilePool } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformTilePool'
import {
  resolveHorizontalBrowseWaveformTileRenderOrder,
  resolveHorizontalBrowseWaveformTileRenderPlan
} from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformTilePlan'
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
  isHorizontalBrowseRawDataCoveringRenderRange,
  isHorizontalBrowseRawDataIntersectingRenderRange,
  resolveHorizontalBrowseActiveMixxxSelectionForCanvas,
  resolveHorizontalBrowsePlaybackDurationSecForRender,
  resolveHorizontalBrowseRawSlotForRender,
  resolveHorizontalBrowseStableRevisionRenderKind,
  resolveHorizontalBrowseWaveformGain,
  type HorizontalBrowseStableRevisionRenderKind as StableRevisionRenderKind
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasHelpers'
import { createHorizontalBrowseRawWaveformViewport } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformViewport'
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
  let suppressNextPlaybackScrollReuse = false
  let lastRenderedRawData: RawWaveformData | null = null
  let lastDrawPlaybackActive = false
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
  let dragPresentationActive = false
  let linkedReleaseActivationPending = false
  let dragPresentationBaseOffsetCssPx = 0
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
    dragPresentationActive = false
    dragReleaseState.reset()
    surfaceVisibility.clearPreservedSurface()
    clearStableRevisionReplacementState()
    liveCanvasRenderToken += 1
    liveCanvasBridge.clearRaw()
    suppressNextPlaybackScrollReuse = false
    lastDrawPlaybackActive = false
    lastRenderedRawData = null
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
      clearStableRevisionReplacementState()
      setDisplayReady(false)
      liveCanvasBridge.clear()
      // worker 的 clear 会清掉块画布像素，块池状态必须同步失效，否则会误判「这块已画过」。
      resetTilePools()
      lastRenderedRawData = null
      suppressNextPlaybackScrollReuse = true
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
    dragPresentationActive = false
    dragReleaseState.reset()
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

  // 分块渲染状态：每 buffer 一个块池（stable 路径渲染到非活动 buffer 再翻转，两 buffer 内容不共享）。
  const tilePools = [
    createHorizontalBrowseWaveformTilePool(liveCanvasBuffers.tileSlotCount),
    createHorizontalBrowseWaveformTilePool(liveCanvasBuffers.tileSlotCount)
  ]
  let pendingTileRender: {
    renderToken: number
    renderTargetIndex: number
    generation: { timeScale: number; renderRevision: number }
    plan: ReturnType<typeof resolveHorizontalBrowseWaveformTileRenderPlan>
  } | null = null

  const resetTilePools = () => {
    for (const pool of tilePools) pool.invalidateAll()
    pendingTileRender = null
    lastTileViewportStartSec = null
    tileForward = true
  }

  // 非对称 overscan：播放只朝一个方向推进，后向 overscan 在稳态播放期基本闲置，
  // 因此屏幕外块的补齐顺序按当前推进方向分配（前向先补）。反向拖动时自动互换。
  let lastTileViewportStartSec: number | null = null
  let tileForward = true

  const resolveTileForwardDirection = () => {
    // 播放中恒为前向：播放推进方向就是未来时间。
    if (options.playing.value && !options.dragging.value) {
      tileForward = true
      return true
    }
    const viewportStartSec = Number(displayViewportStartSec.value)
    if (!Number.isFinite(viewportStartSec)) return tileForward
    if (lastTileViewportStartSec !== null) {
      const deltaSec = viewportStartSec - lastTileViewportStartSec
      // 阈值避免亚像素抖动来回翻转方向。
      if (Math.abs(deltaSec) > 0.001) tileForward = deltaSec > 0
    }
    lastTileViewportStartSec = viewportStartSec
    return tileForward
  }

  /**
   * 分块路径：算出渲染计划、摆好块布局，返回随渲染请求一起下发的 tilePlan。
   *
   * 返回 null 表示本轮不走分块（flag 关闭或块画布未就绪），调用方继续走旧整帧路径。
   * 块计划必须与渲染请求同一条消息：worker 先画完 P0 再回报 rendered，promote 时序才天然正确。
   */
  const resolveTileRenderPlan = (params: {
    renderToken: number
    renderTargetIndex: number
    renderWidthCssPx: number
    heightCssPx: number
    pixelRatio: number
    rangeStartSec: number
    rangeDurationSec: number
    viewportStartCssPx: number
    viewportWidthCssPx: number
    renderRevision: number
    forward: boolean
  }) => {
    if (!isHorizontalBrowseWaveformTileRenderingEnabled()) return null
    const bufferIndex = params.renderTargetIndex === 1 ? 1 : 0
    const pool = tilePools[bufferIndex]
    if (!pool) return null
    const generation = {
      timeScale: resolvePreviewTimeScale(),
      renderRevision: params.renderRevision
    }
    pool.invalidateStaleGenerations(generation)
    const plan = resolveHorizontalBrowseWaveformTileRenderPlan({
      renderWidthCssPx: params.renderWidthCssPx,
      heightCssPx: params.heightCssPx,
      pixelRatio: params.pixelRatio,
      rangeStartSec: params.rangeStartSec,
      rangeDurationSec: params.rangeDurationSec,
      viewportStartCssPx: params.viewportStartCssPx,
      viewportWidthCssPx: params.viewportWidthCssPx,
      generation,
      pool,
      forward: params.forward
    })
    if (plan.tiles.length === 0) return null
    liveCanvasBuffers.applyTileLayout(params.renderTargetIndex, plan.tiles, params.heightCssPx)
    pendingTileRender = {
      renderToken: params.renderToken,
      renderTargetIndex: bufferIndex,
      generation,
      plan
    }
    const renderOrder = resolveHorizontalBrowseWaveformTileRenderOrder(plan)
    return {
      tiles: renderOrder.map((tile) => ({
        slotIndex: tile.slotIndex,
        globalIndex: tile.globalIndex,
        scaledWidth: tile.scaledWidth,
        scaledHeight: plan.scaledHeight,
        rangeStartSec: tile.rangeStartSec,
        rangeDurationSec: tile.rangeDurationSec,
        priority: tile.priority
      })),
      visibleSlotIndexes: plan.visibleSlotIndexes
    }
  }

  /** 把 worker 回报的已画块登记进块池，供后续滚动复用。 */
  const commitRenderedTileSlots = (payload: LiveCanvasRenderedPayload) => {
    const renderedTileSlotIndexes = payload.renderedTileSlotIndexes
    if (!renderedTileSlotIndexes?.length) return
    const pending = pendingTileRender
    if (!pending || pending.renderToken !== payload.renderToken) return
    const pool = tilePools[pending.renderTargetIndex]
    if (!pool) return
    const plannedTileBySlot = new Map(
      pending.plan.tiles.map((tile) => [tile.slotIndex, tile] as const)
    )
    for (const slotIndex of renderedTileSlotIndexes) {
      const tile = plannedTileBySlot.get(slotIndex)
      if (!tile) continue
      pool.markRendered(slotIndex, pending.generation, tile.globalIndex)
    }
    if (payload.tilesPending !== true) pendingTileRender = null
  }

  const commitLiveCanvasRendered = (payload: LiveCanvasRenderedPayload) => {
    if (dragPresentationActive) return
    if (payload.renderToken !== liveCanvasRenderToken) return
    commitRenderedTileSlots(payload)
    // 屏幕外块（P1/P2）补齐的回报只用于登记块池：可见面早已在 P0 就绪时切换过，
    // 这里不能再走一遍 promote / displayReady，否则会重复触发可见面切换。
    if (payload.renderedTileSlotIndexes?.length && payload.renderViewportOnly === true) return
    const pendingStableRender = pendingStableRevisionRender
    if (pendingStableRender?.token === payload.renderToken) {
      pendingStableRevisionRender = null
    }
    let forceStableViewportStart = false
    if (dragReleaseState.pending && payload.ready) {
      const canCompleteRelease = dragReleaseState.canComplete(payload)
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
      clearLiveCanvasPresentationOffset()
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
    const presentationPayload = placeholderPresentationReady
      ? {
          ...payload,
          ready: true
        }
      : payload
    if (!payload.ready) {
      if (preservePreviousSurfaceOnNotReady) return
      if (placeholderPresentationReady) {
        if (payload.stableWaveformSource === true && renderTargetIndex !== null) {
          liveCanvasBuffers.withPresentationTarget(renderTargetIndex, () =>
            stablePresentation.handleRendered(presentationPayload, {
              forceViewportRangeStart: forceStableViewportStart
            })
          )
          liveCanvasBuffers.activate(renderTargetIndex)
        } else {
          stablePresentation.handleRendered(presentationPayload, {
            forceViewportRangeStart: forceStableViewportStart
          })
        }
      }
      setDisplayReady(false)
      return
    }
    if (payload.stableWaveformSource === true && renderTargetIndex !== null) {
      liveCanvasBuffers.withPresentationTarget(renderTargetIndex, () =>
        stablePresentation.handleRendered(presentationPayload, {
          forceViewportRangeStart: forceStableViewportStart
        })
      )
      if (!stableViewportOnlyRender) {
        liveCanvasBuffers.activate(renderTargetIndex)
      }
    } else {
      stablePresentation.handleRendered(presentationPayload, {
        forceViewportRangeStart: forceStableViewportStart
      })
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
    const shouldSynchronizeLinkedReleaseActivation =
      linkedReleaseActivationPending &&
      options.linkedGridActive?.() === true &&
      payload.ready &&
      payload.stableWaveformSource === true &&
      payload.renderViewportOnly !== true &&
      Number.isInteger(payload.renderTargetIndex)
    if (!shouldSynchronizeLinkedReleaseActivation) {
      commitLiveCanvasRendered(payload)
      return
    }
    queueHorizontalBrowseLinkedCanvasActivation(options.direction(), () => {
      if (payload.renderToken !== liveCanvasRenderToken) return
      linkedReleaseActivationPending = false
      commitLiveCanvasRendered(payload)
    })
  }

  const clearLiveCanvasPresentationOffset = () => liveCanvasBuffers.applyPresentationOffset(0, true)

  const handleLiveCanvasPresentation = (payload: LiveCanvasPresentationPayload) => {
    if (dragPresentationActive || dragReleaseState.pending) return
    if (payload.renderToken !== liveCanvasRenderToken) return
    if (stablePresentation.isActive()) return
    liveCanvasBuffers.applyPresentationOffset(Number(payload.offsetCssPx) || 0, true)
    syncDisplayViewportFromRenderedCanvas()
  }

  const queueLiveWaveformRender = (payload: {
    rangeStartSec: number
    rangeDurationSec: number
    rawData: RawWaveformData | null
    maxSamplesPerPixel: number
    allowScrollReuse: boolean
    preferRawPeaksOnly: boolean
    completeSeekTransition?: boolean
    preferPreviewStart?: boolean
    viewportOnly?: boolean
  }) => {
    const wrap = wrapRef.value
    if (!wrap || !ensureLiveCanvasMounted()) return false
    const wrapRect = wrap.getBoundingClientRect()
    const waveformLayout = resolveWaveformLayout()
    const waveformRenderStyle = options.waveformRenderStyle()
    const pixelRatio = window.devicePixelRatio || 1
    const wrapWidth = Math.max(1, wrapRect.width || wrap.clientWidth || 0)
    const wrapHeight = Math.max(1, wrapRect.height || wrap.clientHeight || 0)
    const width = resolvePixelSnappedCssSize(wrapWidth, pixelRatio)
    const height = resolvePixelSnappedCssSize(wrapHeight, pixelRatio)
    const sourcePlaybackActive = options.playing.value && !options.dragging.value
    const stableWaveformSource = resolveStableWaveformSource()
    const stableOverscanCssPx = stableWaveformSource
      ? resolveHorizontalBrowseStableOverscanCssPx(width, pixelRatio)
      : 0
    const viewportOnly = payload.viewportOnly === true && !stableWaveformSource
    const renderWidth = width + stableOverscanCssPx * 2
    const renderDurationScale = renderWidth / Math.max(1, width)
    const renderRangeDurationSec = payload.rangeDurationSec * renderDurationScale
    const stableOverscanSec = (payload.rangeDurationSec * stableOverscanCssPx) / Math.max(1, width)
    const playheadCanvasX =
      stableOverscanCssPx + wrapWidth * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    liveCanvasBuffers.setGeometry(
      -stableOverscanCssPx,
      renderWidth,
      height,
      height + HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX * 2
    )
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
      stableWaveformSource && renderPlaybackSyncRevision !== lastQueuedStableRenderRevision
    const baseViewportRangeStartSec =
      preferPreviewStart || (!sourcePlaybackActive && !visualGridPhase.linked)
        ? payload.rangeStartSec
        : resolvePlaybackAlignedStart(playbackSeconds)
    const renderAnchorSec =
      preferPreviewStart || (!sourcePlaybackActive && !visualGridPhase.linked)
        ? Math.max(
            0,
            baseViewportRangeStartSec +
              payload.rangeDurationSec * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
          )
        : playbackSeconds
    const renderRangeStartSec =
      renderAnchorSec -
      (playheadCanvasX / Math.max(1, renderWidth)) * Math.max(0.0001, renderRangeDurationSec)
    const viewportRangeStartSec = stableWaveformSource
      ? renderRangeStartSec + stableOverscanSec
      : renderRangeStartSec
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
    if (stableWaveformSource) {
      lastQueuedStableRenderRevision = renderPlaybackSyncRevision
    }
    stablePresentation.queueRenderFrame(
      stableWaveformSource,
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
    if (stableWaveformSource) {
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
    const renderTargetIndex = stableWaveformSource
      ? liveCanvasBuffers.inactiveIndex()
      : renderSourceIndex
    const renderRequest = {
      renderToken,
      renderPriority: stableWaveformSource ? 'immediate' : 'normal',
      renderTargetIndex,
      renderSourceIndex,
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
      allowScrollReuse,
      phaseAwareScrollReuse: allowScrollReuse && options.phaseAwareScrollReuse?.() === true,
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
      // 分块渲染计划随请求一起下发。stable 路径（含播放态：stable 下 playbackActive 恒为 false，
      // 滚动靠 presentation offset 而非 worker 逐帧重画）全程走分块；非 stable 的 worker 增量
      // 滚动路径保持原样不动。flag 关闭时 resolveTileRenderPlan 返回 null，行为与旧路径一致。
      tilePlan: stableWaveformSource
        ? resolveTileRenderPlan({
            renderToken,
            renderTargetIndex,
            renderWidthCssPx: renderWidth,
            heightCssPx: height,
            pixelRatio,
            rangeStartSec: renderRangeStartSec,
            rangeDurationSec: renderRangeDurationSec,
            viewportStartCssPx: stableOverscanCssPx,
            viewportWidthCssPx: width,
            renderRevision: renderPlaybackSyncRevision,
            // 播放推进方向即前向；拖拽时按拖动方向，交由 P1/P2 互换决定补齐顺序。
            forward: resolveTileForwardDirection()
          })
        : null
    } satisfies Parameters<typeof liveCanvasBridge.render>[0]
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
    if (invalidateOptions.preserveDisplay === true && resolveDisplayReadyForReuse()) {
      surfaceVisibility.preserveUntilNextReady()
      return
    }
    resetDisplayViewport()
    clearStableRevisionReplacementState()
    liveCanvasBridge.clear()
    resetTilePools()
  }

  const drawWaveform = (drawOptions: HorizontalBrowseRawWaveformDrawOptions = {}) => {
    if (dragPresentationActive) {
      return
    }
    const wrap = wrapRef.value
    const waveformCanvas = liveCanvasBuffers.activeWaveformCanvas()
    if (!wrap || !waveformCanvas) {
      return
    }

    const duration = resolvePreviewDurationSec()
    if (!duration) {
      placeholderVisible.value = false
      clearCanvas()
      setDisplayReady(false)
      return
    }

    const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
    options.previewStartSec.value = clampPreviewStart(options.previewStartSec.value)
    const renderStartSec =
      drawOptions.preferPreviewStart === true
        ? resolveSnappedRenderStartSec(visibleDuration)
        : resolvePlaybackDrivenRenderStartSec(visibleDuration)
    const wasDisplayReady = resolveDisplayReadyForReuse()
    const stableWaveformSource = resolveStableWaveformSource()
    const playbackViewportMoving = options.playing.value && !options.dragging.value
    const playbackStartedThisDraw = playbackViewportMoving && !lastDrawPlaybackActive
    lastDrawPlaybackActive = playbackViewportMoving
    const canReusePlaybackScroll =
      playbackViewportMoving &&
      wasDisplayReady &&
      !suppressNextPlaybackScrollReuse &&
      (!playbackStartedThisDraw || stableWaveformSource)
    const maxSamplesPerPixel = PREVIEW_MAX_SAMPLES_PER_PIXEL
    const activeMixxxSelection = resolveHorizontalBrowseActiveMixxxSelectionForCanvas(
      options.mixxxData.value
    )
    const preferPreviewStart = drawOptions.preferPreviewStart === true
    const viewportOnly = drawOptions.viewportOnly === true
    const liveRawData = options.rawData.value

    let effectiveRawData: RawWaveformData | null
    let effectiveMixxxSelection: {
      data: MixxxWaveformData | null
      source: 'live' | 'placeholder' | 'none'
    }
    if (liveRawData) {
      effectiveRawData = liveRawData
      effectiveMixxxSelection = activeMixxxSelection.data
        ? activeMixxxSelection
        : { data: null, source: 'none' }
    } else {
      effectiveRawData = null
      effectiveMixxxSelection = activeMixxxSelection.data
        ? activeMixxxSelection
        : { data: null, source: 'none' }
    }

    const effectiveMixxxData = effectiveMixxxSelection.data
    const effectiveMixxxDrawable =
      !!effectiveMixxxData && effectiveMixxxSelection.source !== 'placeholder'
    const timeBasisOffsetSec = resolveTimeBasisOffsetSec()
    const effectiveRawCoverage = isHorizontalBrowseRawDataCoveringRenderRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration,
      timeBasisOffsetSec
    )
    const allowPlaybackScrollReuse = canReusePlaybackScroll
    const effectiveRawIntersection = isHorizontalBrowseRawDataIntersectingRenderRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration,
      timeBasisOffsetSec
    )
    const drawableRawData = effectiveRawIntersection ? effectiveRawData : null
    const canRenderWithoutRawCoverage = effectiveMixxxSelection.source === 'live'
    const shouldHoldPlaybackFrame =
      playbackViewportMoving && !stableWaveformSource && wasDisplayReady
    const hasBeatGridTarget = Number(options.previewBpm.value) > 0 || !!options.beatGridMap?.()

    const hasTimelinePlaceholderTarget =
      canShowTimelinePlaceholder() &&
      !hasBeatGridTarget &&
      !hasHorizontalBrowseDrawableRawFrames(drawableRawData)
    const shouldShowEmptySurface = hasTimelinePlaceholderTarget || hasBeatGridTarget

    if (!effectiveMixxxDrawable && !drawableRawData) {
      if (shouldHoldPlaybackFrame) {
        return
      }
      lastRenderedRawData = null
      placeholderVisible.value = shouldShowEmptySurface
      // 完全无高清波形可画：只清波形层；worker 仍按当前 range 渲染网格或时间轴占位。
      setDisplayReady(false)
      queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: null,
        maxSamplesPerPixel,
        allowScrollReuse: false,
        preferRawPeaksOnly: false,
        preferPreviewStart,
        viewportOnly
      })
    } else if (options.playing.value || options.dragging.value) {
      // 稳定 ref 才允许滚动复用；播放恢复期不能提交 partial raw，避免隐藏 full render 挤占 worker。
      const rawDataRefStable = drawableRawData != null && drawableRawData === lastRenderedRawData
      const allowPartialViewportPaint =
        Boolean(drawableRawData) &&
        !playbackViewportMoving &&
        (options.dragging.value || !options.playing.value || !wasDisplayReady)
      const canDrawWaveform =
        Boolean(drawableRawData) &&
        (effectiveRawCoverage ||
          (allowPlaybackScrollReuse && rawDataRefStable) ||
          allowPartialViewportPaint)
      if (!canDrawWaveform) {
        if (shouldHoldPlaybackFrame) {
          return
        }
        lastRenderedRawData = null
        placeholderVisible.value = shouldShowEmptySurface
        setDisplayReady(false)
        queueLiveWaveformRender({
          rangeStartSec: renderStartSec,
          rangeDurationSec: visibleDuration,
          rawData: null,
          maxSamplesPerPixel,
          allowScrollReuse: false,
          preferRawPeaksOnly: false,
          preferPreviewStart,
          viewportOnly
        })
      } else {
        const finishTiming = startHorizontalBrowseUserTiming(
          `frkb:hb:canvas:worker-live:${options.direction()}`
        )
        const queued = queueLiveWaveformRender({
          rangeStartSec: renderStartSec,
          rangeDurationSec: visibleDuration,
          rawData: drawableRawData,
          maxSamplesPerPixel,
          allowScrollReuse: allowPlaybackScrollReuse,
          preferRawPeaksOnly: false,
          completeSeekTransition: effectiveRawCoverage,
          preferPreviewStart,
          viewportOnly
        })
        if (queued) {
          lastRenderedRawData = drawableRawData
        }
        suppressNextPlaybackScrollReuse = false
        finishTiming()
      }
    } else if (!drawableRawData && !canRenderWithoutRawCoverage) {
      lastRenderedRawData = null
      placeholderVisible.value = shouldShowEmptySurface
      setDisplayReady(false)
      queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: null,
        maxSamplesPerPixel,
        allowScrollReuse: false,
        preferRawPeaksOnly: false,
        preferPreviewStart,
        viewportOnly
      })
    } else {
      placeholderVisible.value = false
      const finishTiming = startHorizontalBrowseUserTiming(
        `frkb:hb:canvas:worker-live:${options.direction()}`
      )
      const queued = queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: drawableRawData,
        maxSamplesPerPixel,
        allowScrollReuse: allowPlaybackScrollReuse,
        preferRawPeaksOnly: false,
        completeSeekTransition: effectiveRawCoverage,
        preferPreviewStart,
        viewportOnly
      })
      if (queued) {
        lastRenderedRawData = drawableRawData
      }
      suppressNextPlaybackScrollReuse = false
      finishTiming()
    }
  }

  drawScheduler = createHorizontalBrowseRawWaveformDrawScheduler({ draw: drawWaveform })

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

  const resolveWaveformCanvasTranslateX = () => liveCanvasBuffers.resolveActiveTranslateX()

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
    const viewportStartSec = resolveRenderedCanvasViewportStartSec()
    dragPresentationActive = true
    linkedReleaseActivationPending = false
    dragReleaseState.reset()
    surfaceVisibility.clearPreservedSurface()
    clearStableRevisionReplacementState()
    dragPresentationBaseOffsetCssPx = resolveWaveformCanvasTranslateX()
    stablePresentation.stopPlayback()
    liveCanvasBridge.stopPlayback()
    return {
      viewportStartSec
    }
  }

  const applyDragCanvasPresentationOffset = (offsetCssPx: number) => {
    if (!dragPresentationActive) return
    const appliedOffsetCssPx = dragPresentationBaseOffsetCssPx + (Number(offsetCssPx) || 0)
    liveCanvasBuffers.applyPresentationOffset(appliedOffsetCssPx, true)
    syncDisplayViewportFromRenderedCanvas()
  }

  const endDragCanvasPresentation = (viewportStartSec?: number) => {
    if (!dragPresentationActive) {
      return {
        requiresRender: false
      }
    }
    const safeViewportStartSec = Number.isFinite(Number(viewportStartSec))
      ? Number(viewportStartSec)
      : null
    linkedReleaseActivationPending = options.linkedGridActive?.() === true
    const visibleDurationSec = Math.max(0.001, Number(resolveVisibleDurationSec()) || 0)
    dragPresentationActive = false
    dragPresentationBaseOffsetCssPx = 0
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
    applyDragCanvasPresentationOffset,
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
