import { effectScope, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createHorizontalBrowseWaveformPointerInteraction } from './horizontalBrowseWaveformPointerInteraction'

const createHarness = () => {
  const dragging = ref(false)
  const linkedDragActive = ref(false)
  const linkedDragAnchorSec = ref<number | null>(null)
  const hasSong = ref(true)
  const previewStartSec = ref(5)
  const callOrder: string[] = []
  const beginDragReleaseHandoff = vi.fn(() => callOrder.push('handoff'))
  const clearDragReleaseHandoff = vi.fn(() => callOrder.push('clear-handoff'))
  const endDragCanvasPresentation = vi.fn(() => {
    callOrder.push('end-presentation')
    return { requiresRender: true }
  })
  const drawWaveformNow = vi.fn()

  const scope = effectScope()
  scope.run(() => {
    createHorizontalBrowseWaveformPointerInteraction({
      wrapRef: ref({ clientWidth: 700 } as HTMLDivElement),
      dragging,
      previewStartSec,
      previewZoom: ref(1),
      previewMaxZoom: ref(8),
      direction: () => 'down',
      hasSong: () => hasSong.value,
      resolvePreviewDurationSec: () => 100,
      resolveVisibleDurationSec: () => 10,
      resolvePreviewAnchorSec: () => previewStartSec.value + 5,
      resolveWaveformCurrentSeconds: () => previewStartSec.value + 5,
      clampPreviewStart: (seconds) => seconds,
      beginDragCanvasPresentation: () => ({ viewportStartSec: previewStartSec.value }),
      updateDragCanvasPresentation: vi.fn(),
      endDragCanvasPresentation,
      clearDragReleaseHandoff,
      beginDragReleaseHandoff,
      scrubPreview: {
        start: vi.fn(),
        update: vi.fn(),
        stop: vi.fn()
      },
      handlePreviewMouseDownForGridTargetSelect: () => false,
      emitToolbarState: vi.fn(),
      schedulePersistGridDefinition: vi.fn(),
      emitDragSessionStart: vi.fn(),
      emitDragSessionEnd: vi.fn(),
      emitZoomChange: vi.fn(),
      linkedDragActive: () => linkedDragActive.value,
      linkedDragAnchorSec: () => linkedDragAnchorSec.value,
      resolvePlaybackActive: () => false,
      maybeContinueWaveformSource: vi.fn(),
      drawWaveformNow,
      scheduleDraw: vi.fn(),
      zoomStepFactor: 1.25,
      minZoom: 1,
      clampNumber: (value, min, max) => Math.max(min, Math.min(max, value))
    })
  })

  return {
    scope,
    linkedDragActive,
    linkedDragAnchorSec,
    hasSong,
    previewStartSec,
    callOrder,
    beginDragReleaseHandoff,
    clearDragReleaseHandoff,
    endDragCanvasPresentation,
    drawWaveformNow
  }
}

describe('createHorizontalBrowseWaveformPointerInteraction', () => {
  it('联结被动轨正常松手时先建立交接再结束拖动呈现', async () => {
    const harness = createHarness()
    harness.linkedDragAnchorSec.value = 20
    harness.linkedDragActive.value = true
    await nextTick()

    expect(harness.previewStartSec.value).toBe(15)

    harness.linkedDragActive.value = false
    await nextTick()

    expect(harness.beginDragReleaseHandoff).toHaveBeenCalledWith(20)
    expect(harness.clearDragReleaseHandoff).not.toHaveBeenCalled()
    expect(harness.callOrder).toEqual(['handoff', 'end-presentation'])
    expect(harness.endDragCanvasPresentation).toHaveBeenCalledWith(15, true)
    expect(harness.drawWaveformNow).not.toHaveBeenCalled()
    harness.scope.stop()
  })

  it('联结被动轨因歌曲卸载而结束时清除交接', async () => {
    const harness = createHarness()
    harness.linkedDragAnchorSec.value = 20
    harness.linkedDragActive.value = true
    await nextTick()

    harness.hasSong.value = false
    await nextTick()

    expect(harness.beginDragReleaseHandoff).not.toHaveBeenCalled()
    expect(harness.clearDragReleaseHandoff).toHaveBeenCalledOnce()
    expect(harness.callOrder).toEqual(['clear-handoff', 'end-presentation'])
    harness.scope.stop()
  })
})
