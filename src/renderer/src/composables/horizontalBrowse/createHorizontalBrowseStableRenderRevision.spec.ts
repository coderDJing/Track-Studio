import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHorizontalBrowseStableRenderRevision } from './createHorizontalBrowseStableRenderRevision'
import { useHorizontalBrowseWaveformPresentationCoordinator } from './horizontalBrowseWaveformPresentationCoordinator'
import { createHorizontalBrowseStableCanvasPresentationController } from './horizontalBrowseStableCanvasPresentation'

afterEach(() => vi.unstubAllGlobals())

describe('Cue 跳转复用稳定波形', () => {
  it.each(['top', 'bottom'] as const)(
    '%s 反复返回 Cue 只移动已有画布，不让整片波形失效',
    (deck) => {
      vi.stubGlobal('requestAnimationFrame', () => 1)
      vi.stubGlobal('cancelAnimationFrame', () => {})
      const coordinator = useHorizontalBrowseWaveformPresentationCoordinator()
      const revision = createHorizontalBrowseStableRenderRevision({
        song: null,
        direction: deck === 'top' ? 'up' : 'down',
        get presentationState() {
          return coordinator.state[deck]
        }
      })
      const scheduleDraw = vi.fn()
      let playing = false
      const controller = createHorizontalBrowseStableCanvasPresentationController({
        isActive: () => true,
        isPlaying: () => playing,
        isDragging: () => false,
        currentSeconds: () => 8.615104,
        playbackRate: () => 1,
        renderRevision: () => revision.value,
        resolveViewportRangeStartSec: (seconds, visible = 12) => seconds - visible / 2,
        waveformCanvas: () => null,
        overlayCanvas: () => null,
        scheduleDraw
      })
      // 覆盖初始画布，以及曾拖动/调整后持有非零展示版本的画布。
      for (const afterDrag of [false, true]) {
        if (afterDrag) coordinator.markDragPreview(deck, 8.615104, false)
        const frameRevision = revision.value
        controller.queueFrame({
          renderToken: 1,
          renderRevision: frameRevision,
          playbackActive: false,
          rangeStartSec: -33.384896,
          rangeDurationSec: 84,
          viewportRangeStartSec: 2.615104,
          anchorSec: 8.615104,
          anchorStartedAtMs: performance.now(),
          playbackRate: 1,
          renderWidth: 8400,
          overscanCssPx: 3600,
          pixelRatio: 1.75
        })
        controller.handleRendered({
          renderToken: 1,
          rangeStartSec: -33.384896,
          rangeDurationSec: 84,
          ready: true
        })
        for (let i = 0; i < 8; i += 1) {
          playing = true
          controller.startPlayback(8.615104, 1)
          expect(controller.apply(8.815104, { requirePresentable: true }).applied).toBe(true)
          coordinator.markSeek(deck, 8.615104)
          playing = false
          controller.stopPlayback()
          expect(coordinator.state[deck].owner).toBe('seek')
          expect(revision.value).toBe(frameRevision)
          expect(controller.apply(8.615104, { requirePresentable: true }).applied).toBe(true)
        }
        expect(scheduleDraw).not.toHaveBeenCalled()
        // 超出缓存覆盖范围仍须请求新画面，不能显示旧位置。
        coordinator.markSeek(deck, 120)
        expect(controller.apply(120, { requirePresentable: true }).applied).toBe(false)
      }
      // 改变展示内容的拖动版本仍会失效旧帧。
      coordinator.markDragPreview(deck, 60, false)
      expect(controller.measure(8.615104).presentable).toBe(false)
    }
  )
})
