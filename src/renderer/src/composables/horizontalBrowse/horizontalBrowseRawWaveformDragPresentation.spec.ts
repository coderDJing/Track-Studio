import { describe, expect, it, vi } from 'vitest'
import { createHorizontalBrowseRawWaveformDragPresentation } from './horizontalBrowseRawWaveformDragPresentation'

const frame = (viewportStartSec: number, marginSec: number) => ({
  viewportStartSec,
  minViewportStartSec: viewportStartSec - marginSec,
  maxViewportStartSec: viewportStartSec + marginSec,
  pixelsPerSec: 100,
  offsetCssPx: 0
})

const createHarness = () => {
  let target = 40
  const present = vi.fn()
  const requestFrame = vi.fn()
  const promote = vi.fn()
  const drag = createHorizontalBrowseRawWaveformDragPresentation({
    getViewportStartSec: () => target,
    present,
    requestFrame
  })
  return {
    drag,
    present,
    requestFrame,
    promote,
    move: (seconds: number) => {
      target = seconds
      drag.update()
    }
  }
}

describe('大波形按住拖动时的画布交接', () => {
  it('从播放帧开始拖动，补画就绪前保持画面，随后对齐到鼠标的最新位置', () => {
    const { drag, present, requestFrame, promote, move } = createHarness()
    drag.start(frame(40, 0), true)
    expect(requestFrame).toHaveBeenCalledWith(40)
    drag.rememberFrame(1, frame(40, 6))

    move(42)
    expect(present).toHaveBeenLastCalledWith(0, 40)
    expect(requestFrame).toHaveBeenCalledOnce()
    drag.commit(1, true, promote)
    expect(promote).toHaveBeenCalledWith(-200, 42)

    move(38)
    expect(present).toHaveBeenLastCalledWith(200, 38)
    expect(requestFrame).toHaveBeenCalledOnce()
  })

  it('越过新帧覆盖范围时追上最近位置，松手后丢弃待提交帧', () => {
    const { drag, present, requestFrame, promote, move } = createHarness()
    drag.start(frame(40, 6), false)
    move(55)
    expect(present).toHaveBeenLastCalledWith(-600, 46)
    expect(requestFrame).toHaveBeenLastCalledWith(55)

    drag.rememberFrame(1, frame(55, 6))
    move(25)
    expect(present).toHaveBeenLastCalledWith(600, 34)
    drag.commit(1, true, promote)
    expect(promote).not.toHaveBeenCalled()
    expect(requestFrame).toHaveBeenLastCalledWith(25)

    drag.rememberFrame(2, frame(25, 6))
    expect(drag.stop()).toBe(true)
    drag.commit(2, true, promote)
    expect(promote).not.toHaveBeenCalled()
  })
})
