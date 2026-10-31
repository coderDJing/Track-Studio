import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useHorizontalBrowseWaveformScrubPreview } from './useHorizontalBrowseWaveformScrubPreview'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('linked waveform scrub preview timing', () => {
  it('publishes each linked position before the next animation frame, including the final stop', () => {
    vi.useFakeTimers()
    const raf = vi.fn(() => 1)
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const emitPreview = vi.fn()
    const options = {
      dragging: ref(true),
      resolveAnchorSec: () => 12,
      emitPreview,
      immediate: () => true
    }
    const scrub = useHorizontalBrowseWaveformScrubPreview(options)
    scrub.start(10)
    scrub.update(11)
    expect(emitPreview).toHaveBeenLastCalledWith({
      anchorSec: 11,
      playbackRate: expect.any(Number)
    })
    scrub.update(12)
    expect(emitPreview).toHaveBeenLastCalledWith({
      anchorSec: 12,
      playbackRate: expect.any(Number)
    })
    scrub.stop({ flushPending: true })
    expect(raf).not.toHaveBeenCalled()
    expect(emitPreview).toHaveBeenCalledTimes(3)
  })

  it('keeps single-deck audio preview coalesced to the latest position per frame', () => {
    vi.useFakeTimers()
    let frame = () => {}
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      frame = callback
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const emitPreview = vi.fn()
    const scrub = useHorizontalBrowseWaveformScrubPreview({
      dragging: ref(true),
      resolveAnchorSec: () => 12,
      emitPreview
    })
    scrub.start(10)
    scrub.update(11)
    scrub.update(12)
    expect(emitPreview).toHaveBeenCalledTimes(1)
    frame()
    expect(emitPreview).toHaveBeenCalledTimes(2)
    expect(emitPreview).toHaveBeenLastCalledWith({
      anchorSec: 12,
      playbackRate: expect.any(Number)
    })
    scrub.stop()
  })
})
