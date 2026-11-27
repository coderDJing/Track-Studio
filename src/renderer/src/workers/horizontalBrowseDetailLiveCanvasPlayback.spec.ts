import { describe, expect, it } from 'vitest'
import {
  buildPlaybackRenderRequest,
  resolvePlaybackSeconds
} from './horizontalBrowseDetailLiveCanvasPlayback'
import type { PlaybackAnimationState } from './horizontalBrowseDetailLiveCanvasRenderState'

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

  it('keeps playback frames reusable and pixel aligned after a viewport-only redraw', () => {
    const animation: PlaybackAnimationState = {
      token: 1,
      baseSeconds: 40,
      startedAtMs: 1000,
      lastRenderedAtMs: 1000,
      scrollReuseSuppressedFrames: 0,
      request: {
        ...request,
        loopRange: null,
        renderToken: 1,
        renderViewportOnly: true,
        presentationOffsetMode: 'free',
        width: 1000,
        height: 100,
        pixelRatio: 2,
        bpm: 120,
        firstBeatMs: 0,
        downbeatBeatOffset: 0,
        timeBasisOffsetMs: 0,
        rangeStartSec: 34,
        rangeDurationSec: 12,
        maxSamplesPerPixel: 32,
        showDetailHighlights: false,
        showCenterLine: false,
        showBackground: false,
        showBeatGrid: true,
        allowScrollReuse: true,
        phaseAwareScrollReuse: false,
        waveformLayout: 'top-half',
        waveformRenderStyle: 'raw-curve',
        preferRawPeaksOnly: false,
        showTimelinePlaceholder: false,
        themeVariant: 'dark',
        rawSlot: 'live',
        direction: 'up',
        cueSeconds: null,
        hotCues: [],
        memoryCues: [],
        cueAccentColor: '#fff',
        playbackSeconds: 40,
        playbackSyncRevision: 1,
        waveformGain: 1
      }
    }

    expect(buildPlaybackRenderRequest(animation, false, 1000)).toMatchObject({
      renderViewportOnly: false,
      presentationOffsetMode: 'device-pixel',
      allowScrollReuse: false
    })
    expect(buildPlaybackRenderRequest(animation, true, 1016)).toMatchObject({
      renderViewportOnly: false,
      presentationOffsetMode: 'device-pixel',
      allowScrollReuse: true
    })
  })
})
