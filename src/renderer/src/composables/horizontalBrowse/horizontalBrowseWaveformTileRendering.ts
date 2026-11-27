import type { HorizontalBrowseDetailLiveCanvasWorkerOutgoing } from '@renderer/workers/horizontalBrowseDetailLiveCanvas.types'
import type { createHorizontalBrowseLiveCanvasBuffers } from './horizontalBrowseLiveCanvasBuffers'
import { isHorizontalBrowseWaveformTileRenderingEnabled } from './horizontalBrowseWaveformTileFlag'
import {
  resolveHorizontalBrowseWaveformTileRenderOrder,
  resolveHorizontalBrowseWaveformTileRenderPlan
} from './horizontalBrowseWaveformTilePlan'
import { createHorizontalBrowseWaveformTilePool } from './horizontalBrowseWaveformTilePool'

type TileRenderingOptions = {
  buffers: ReturnType<typeof createHorizontalBrowseLiveCanvasBuffers>
  isPlaying: () => boolean
  getViewportStartSec: () => number
  getTimeScale: () => number
}

type LiveCanvasRenderedPayload = Extract<
  HorizontalBrowseDetailLiveCanvasWorkerOutgoing,
  { type: 'rendered' }
>['payload']

export const createHorizontalBrowseWaveformTileRendering = (options: TileRenderingOptions) => {
  // 分块渲染状态：每 buffer 一个块池（stable 路径渲染到非活动 buffer 再翻转，两 buffer 内容不共享）。
  const tilePools = [
    createHorizontalBrowseWaveformTilePool(options.buffers.tileSlotCount),
    createHorizontalBrowseWaveformTilePool(options.buffers.tileSlotCount)
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
    if (options.isPlaying()) {
      tileForward = true
      return true
    }
    const viewportStartSec = options.getViewportStartSec()
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
    const bufferIndex = params.renderTargetIndex === 1 ? 1 : 0
    if (
      !isHorizontalBrowseWaveformTileRenderingEnabled() ||
      !options.buffers.waveformTileContainerRefs[bufferIndex].value
    ) {
      return null
    }
    const pool = tilePools[bufferIndex]
    if (!pool) return null
    const generation = {
      timeScale: options.getTimeScale(),
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
    options.buffers.applyTileLayout(params.renderTargetIndex, plan.tiles, params.heightCssPx)
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
    pool?.markRenderedSlots(renderedTileSlotIndexes, pending.generation, pending.plan.tiles)
    if (payload.tilesPending !== true) pendingTileRender = null
  }

  return {
    resetTilePools,
    resolveTileForwardDirection,
    resolveTileRenderPlan,
    commitRenderedTileSlots
  }
}
