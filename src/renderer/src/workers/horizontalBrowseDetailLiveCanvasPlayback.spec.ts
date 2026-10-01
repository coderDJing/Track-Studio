import { describe, expect, it } from 'vitest'
import { resolvePlaybackSeconds } from './horizontalBrowseDetailLiveCanvasPlayback'

describe('detail waveform worker loop playback', () => {
  const request = {
    playbackRate: 1,
    playbackDurationSec: 180,
    playbackActive: true,
    loopRange: { startSec: 10.123, endSec: 10.248 }
  }

  it('wraps the waveform without waiting for a new render message', () => {
    expect(resolvePlaybackSeconds(request, 10.223, 1000, 1080)).toBeCloseTo(10.178, 9)
    expect(resolvePlaybackSeconds(request, 10.223, 1000, 1700)).toBeCloseTo(10.173, 9)
  })

  it('accounts for playback rate when a frame spans several loop cycles', () => {
    expect(
      resolvePlaybackSeconds({ ...request, playbackRate: 1.5 }, 10.223, 1000, 1100)
    ).toBeCloseTo(10.123, 9)
  })

  it('keeps normal playback linear after the loop is disabled', () => {
    expect(resolvePlaybackSeconds({ ...request, loopRange: null }, 10.223, 1000, 1700)).toBeCloseTo(
      10.923,
      9
    )
  })
})
