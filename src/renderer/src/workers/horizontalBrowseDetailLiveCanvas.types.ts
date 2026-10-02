import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { ISongHotCue, ISongMemoryCue } from 'src/types/globals'
import type { RekordboxBeatGridEntry, SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'

type HorizontalBrowseDetailLiveCanvasRawSlot = 'live'
type HorizontalBrowseDetailLiveCanvasDirection = 'up' | 'down'
type HorizontalBrowseDetailLiveCanvasWaveformRenderStyle = 'columns' | 'raw-curve'

export type HorizontalBrowseDetailLiveCanvasLoopRange = {
  startSec: number
  endSec: number
}

export type HorizontalBrowseDetailLiveCanvasRenderRequest = {
  renderToken: number
  renderPriority?: 'normal' | 'immediate'
  renderTargetIndex?: number
  renderSourceIndex?: number
  renderViewportOnly?: boolean
  width: number
  height: number
  pixelRatio: number
  bpm: number
  firstBeatMs: number
  downbeatBeatOffset: number
  beatGridMap?: SongBeatGridMapV2 | null
  rekordboxGridEntries?: RekordboxBeatGridEntry[]
  beatGridEditMode?: boolean
  beatGridVisibleFromSec?: number | null
  beatGridSelectedBoundarySec?: number | null
  showGridClipBoundaries?: boolean
  timeBasisOffsetMs: number
  rangeStartSec: number
  rangeDurationSec: number
  viewportWidth?: number
  viewportRangeStartSec?: number
  viewportRangeDurationSec?: number
  maxSamplesPerPixel: number
  showDetailHighlights: boolean
  showCenterLine: boolean
  showBackground: boolean
  showBeatGrid: boolean
  allowScrollReuse: boolean
  phaseAwareScrollReuse: boolean
  presentationOffsetMode?: 'free' | 'device-pixel' | 'none'
  stableWaveformSource?: boolean
  waveformLayout: 'full' | 'top-half' | 'bottom-half'
  waveformRenderStyle: HorizontalBrowseDetailLiveCanvasWaveformRenderStyle
  preferRawPeaksOnly: boolean
  showTimelinePlaceholder: boolean
  themeVariant: 'light' | 'dark'
  rawSlot: HorizontalBrowseDetailLiveCanvasRawSlot | null
  direction: HorizontalBrowseDetailLiveCanvasDirection
  cueSeconds: number | null
  hotCues: ISongHotCue[]
  memoryCues: ISongMemoryCue[]
  loopRange: HorizontalBrowseDetailLiveCanvasLoopRange | null
  audioEditSelection?: HorizontalBrowseDetailLiveCanvasLoopRange | null
  audioEditPendingStartSec?: number | null
  audioEditPendingEndSec?: number | null
  audioEditAccentColor?: string
  cueAccentColor: string
  playbackActive: boolean
  playbackSeconds: number
  playbackSyncRevision: number
  playbackRate: number
  playbackRenderClockEpochMs?: number | null
  playbackDurationSec: number
  waveformGain: number
  /**
   * 分块渲染计划。存在时 worker 走分块路径画波形层（overlay 仍单层不分块），
   * 且只在 P0 全部就绪后才回报 `ready: true`。
   */
  tilePlan?: HorizontalBrowseDetailLiveCanvasTilePlan | null
}

/** 分块路径的单块渲染指令。几何与时间范围全部由主线程的渲染计划算好，worker 只负责绘制。 */
export type HorizontalBrowseDetailLiveCanvasTileRenderRequest = {
  slotIndex: number
  globalIndex: number
  scaledWidth: number
  scaledHeight: number
  rangeStartSec: number
  rangeDurationSec: number
  /** 0=可见区 1=前向 overscan 2=后向 overscan。 */
  priority: number
}

/**
 * 分块渲染计划，随渲染请求一起下发。
 *
 * 块计划必须与渲染请求同一条消息：worker 要先画完 P0 再回报 `rendered`，主线程的 promote
 * 时序才天然正确（`rendered` 到达即意味着可见区已就绪），无需在主线程做双路异步汇合。
 */
export type HorizontalBrowseDetailLiveCanvasTilePlan = {
  /** 只含本轮需要重画的块，已按 P0 → P1 → P2 排序。 */
  tiles: HorizontalBrowseDetailLiveCanvasTileRenderRequest[]
  /** 可见区块的 slotIndex 全集（含本轮复用、无需重画的块）。 */
  visibleSlotIndexes: number[]
}

export type HorizontalBrowseDetailLiveCanvasWorkerIncoming =
  | {
      type: 'attachCanvas'
      payload: {
        waveformCanvas: OffscreenCanvas
        overlayCanvas: OffscreenCanvas
        waveformCanvases?: OffscreenCanvas[]
        overlayCanvases?: OffscreenCanvas[]
        /** 分块路径：[buffer0 的全部块, buffer1 的全部块]。 */
        waveformTileCanvases?: OffscreenCanvas[][]
      }
    }
  | {
      type: 'clear'
    }
  | {
      type: 'clearRaw'
    }
  | {
      type: 'stopPlayback'
    }
  | {
      type: 'replaceRaw'
      payload: {
        data: RawWaveformData | null
      }
    }
  | {
      type: 'render'
      payload: HorizontalBrowseDetailLiveCanvasRenderRequest
    }

export type HorizontalBrowseDetailLiveCanvasWorkerOutgoing =
  | {
      type: 'rendered'
      payload: {
        renderToken: number
        rangeStartSec: number
        rangeDurationSec: number
        ready: boolean
        renderViewportOnly?: boolean
        renderTargetIndex?: number
        stableWaveformSource?: boolean
        rawWaveformKind?: 'rekordbox-rgb' | 'rekordbox-triband' | 'traktor'
        /** 分块路径本轮成功绘制的块，供主线程更新块池 ready 状态。 */
        renderedTileSlotIndexes?: number[]
        /** 分块路径是否还有屏幕外块待补（P1/P2 未画完）。 */
        tilesPending?: boolean
        notReadyReason?:
          | 'missing-metrics'
          | 'missing-raw-data'
          | 'render-full-frame-failed'
          | 'tile-visible-not-ready'
      }
    }
  | {
      type: 'presentation'
      payload: {
        renderToken: number
        offsetCssPx: number
      }
    }
