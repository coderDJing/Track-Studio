import { describe, expect, it } from 'vitest'
import { resolveHorizontalBrowseRawWaveformRenderViewport } from './horizontalBrowseRawWaveformViewport'
import {
  resolveHorizontalBrowseStableOverscanCssPx,
  resolvePixelSnappedCssSize
} from './horizontalBrowseCanvasGeometry'
import {
  resolveHorizontalBrowseStableCanvasOffsetCssPx,
  type HorizontalBrowseStableCanvasPresentationFrame
} from './horizontalBrowseStableCanvasPresentation'
import { resolveHorizontalBrowseWaveformTileRenderPlan } from './horizontalBrowseWaveformTilePlan'
import { createHorizontalBrowseWaveformTilePool } from './horizontalBrowseWaveformTilePool'
import { HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT } from './horizontalBrowseWaveformTileLayout'

const createFrame = (
  anchorSec: number,
  pixelRatio: number,
  viewportLeftCssPx: number,
  wrapWidth = 965.37
) => {
  const width = resolvePixelSnappedCssSize(wrapWidth, pixelRatio)
  const overscanCssPx = resolveHorizontalBrowseStableOverscanCssPx(width, pixelRatio)
  const renderWidth = width + overscanCssPx * 2
  const visibleDurationSec = 6.785714285714286
  const rangeDurationSec = (visibleDurationSec * renderWidth) / width
  const viewport = resolveHorizontalBrowseRawWaveformRenderViewport({
    usePreviewStart: false,
    rangeStartSec: anchorSec - visibleDurationSec * 0.5,
    rangeDurationSec: visibleDurationSec,
    playbackSeconds: anchorSec,
    playheadCanvasX: overscanCssPx + wrapWidth * 0.5,
    renderWidth,
    renderRangeDurationSec: rangeDurationSec,
    stableWaveformSource: true,
    stableOverscanCssPx: overscanCssPx,
    viewportLeftCssPx,
    pixelRatio
  })
  const frame: HorizontalBrowseStableCanvasPresentationFrame = {
    renderToken: 1,
    renderRevision: 0,
    playbackActive: true,
    rangeStartSec: viewport.renderRangeStartSec,
    rangeDurationSec,
    viewportRangeStartSec: viewport.viewportRangeStartSec,
    anchorSec: viewport.renderAnchorSec,
    anchorStartedAtMs: 0,
    playbackRate: 1,
    renderWidth,
    overscanCssPx,
    pixelRatio
  }
  const plan = resolveHorizontalBrowseWaveformTileRenderPlan({
    renderWidthCssPx: renderWidth,
    heightCssPx: 96,
    pixelRatio,
    rangeStartSec: frame.rangeStartSec,
    rangeDurationSec,
    viewportStartCssPx: overscanCssPx,
    viewportWidthCssPx: width,
    generation: { timeScale: 1, renderRevision: 0 },
    pool: createHorizontalBrowseWaveformTilePool(HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT)
  })
  return { frame, plan, visibleDurationSec, wrapWidth }
}

describe('大波形分块的屏幕像素对齐', () => {
  it.each(
    [1, 1.25, 1.5, 1.75, 2].flatMap((pixelRatio) =>
      [965.37, 1920.13].map((wrapWidth) => ({ pixelRatio, wrapWidth }))
    )
  )(
    '小数布局位置、半像素 overscan 下换帧保持同一采样点位置 (dpr=$pixelRatio, width=$wrapWidth)',
    ({ pixelRatio, wrapWidth }) => {
      for (const viewportLeftCssPx of [0, 12.3, 67.125]) {
        const previous = createFrame(30.137, pixelRatio, viewportLeftCssPx, wrapWidth)
        const next = createFrame(35.913, pixelRatio, viewportLeftCssPx, wrapWidth)
        const commonTile = previous.plan.tiles.find((tile) =>
          next.plan.tiles.some((candidate) => candidate.globalIndex === tile.globalIndex)
        )
        expect(commonTile).toBeDefined()
        for (const seconds of [35.913, 36.018, 36.137]) {
          const viewportStartSec = seconds - previous.visibleDurationSec * 0.5
          const positions = [previous, next].map(({ frame, plan }) => {
            const offsetCssPx = resolveHorizontalBrowseStableCanvasOffsetCssPx(
              frame,
              viewportStartSec
            )
            const screenLeftCssPx = viewportLeftCssPx - frame.overscanCssPx + offsetCssPx
            for (const tile of plan.tiles) {
              const screenPixel = (screenLeftCssPx + tile.leftCssPx) * pixelRatio
              expect(screenPixel).toBeCloseTo(Math.round(screenPixel), 7)
            }
            const tile = plan.tiles.find(
              (candidate) => candidate.globalIndex === commonTile?.globalIndex
            )!
            return (screenLeftCssPx + tile.leftCssPx) * pixelRatio
          })
          // 同一块的同一列在翻转 buffer 前后位置完全重合，不能只检查块之间没有接缝。
          expect(positions[0]).toBeCloseTo(positions[1], 7)
        }
        const rawRangeStartSec =
          previous.frame.anchorSec -
          ((previous.frame.overscanCssPx + previous.wrapWidth * 0.5) / previous.frame.renderWidth) *
            previous.frame.rangeDurationSec
        const alignmentErrorScaledPx =
          ((previous.frame.rangeStartSec - rawRangeStartSec) *
            previous.frame.renderWidth *
            pixelRatio) /
          previous.frame.rangeDurationSec
        expect(Math.abs(alignmentErrorScaledPx)).toBeLessThanOrEqual(0.5 + 1e-9)
      }
    }
  )

  it('歌曲开头的负时间范围仍可对齐，暂停预览保留指定锚点', () => {
    const viewport = resolveHorizontalBrowseRawWaveformRenderViewport({
      usePreviewStart: true,
      rangeStartSec: -3,
      rangeDurationSec: 6,
      playbackSeconds: 100,
      playheadCanvasX: 3500,
      renderWidth: 7000,
      renderRangeDurationSec: 42,
      stableWaveformSource: true,
      stableOverscanCssPx: 3000,
      viewportLeftCssPx: 12.3,
      pixelRatio: 1.75
    })
    expect(viewport.renderAnchorSec).toBe(0)
    expect(viewport.renderRangeStartSec).toBeLessThan(0)
    const songOriginScaledPx = (12.3 - 3000 - (viewport.renderRangeStartSec * 7000) / 42) * 1.75
    expect(songOriginScaledPx).toBeCloseTo(Math.round(songOriginScaledPx), 7)
  })

  it('逐帧 worker 绘制路径保留原始时间范围', () => {
    const viewport = resolveHorizontalBrowseRawWaveformRenderViewport({
      usePreviewStart: false,
      rangeStartSec: 0,
      rangeDurationSec: 6,
      playbackSeconds: 30.137,
      playheadCanvasX: 500,
      renderWidth: 1000,
      renderRangeDurationSec: 6,
      stableWaveformSource: false,
      stableOverscanCssPx: 0,
      viewportLeftCssPx: 12.3,
      pixelRatio: 1.75
    })
    expect(viewport.renderRangeStartSec).toBe(30.137 - 3)
    expect(viewport.viewportRangeStartSec).toBe(viewport.renderRangeStartSec)
  })
})
