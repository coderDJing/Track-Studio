import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { createEmptyHorizontalBrowseTransportSnapshot } from '@shared/horizontalBrowseTransport'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import type { HorizontalBrowseDeckKey } from './horizontalBrowseNativeTransport'
import { useHorizontalBrowseDeckLoopController } from './useHorizontalBrowseDeckLoopController'

const createController = (overrides: Partial<ISongInfo> = {}) => {
  const song = {
    filePath: 'loop.wav',
    bpm: 120,
    beatGridMap: createSongBeatGridMapV2FromFixedGrid({
      bpm: 120,
      firstBeatMs: 0,
      downbeatBeatOffset: 0,
      source: 'analysis'
    }),
    ...overrides
  } as ISongInfo
  const snapshot = createEmptyHorizontalBrowseTransportSnapshot()
  for (const deck of [snapshot.top, snapshot.bottom]) {
    deck.durationSec = 20
    deck.currentSec = 1.2
    deck.renderCurrentSec = 1.21
    deck.playing = true
  }
  const quantize = { top: true, bottom: true }
  const liveSeconds = { top: 1.23, bottom: 2.34 }
  const cues = { top: ref(0), bottom: ref(0) }
  const transport = {
    toggleLoop: vi.fn(async (deck: HorizontalBrowseDeckKey) => {
      snapshot[deck].loopActive = !snapshot[deck].loopActive
    }),
    stepLoopBeats: vi.fn(async () => {}),
    clearLoop: vi.fn(async (deck: HorizontalBrowseDeckKey) => {
      snapshot[deck].loopActive = false
    }),
    setLoopFromRange: vi.fn(
      async (deck: HorizontalBrowseDeckKey, start: number, end: number, _exact?: boolean) => {
        Object.assign(snapshot[deck], {
          loopActive: true,
          loopStartSec: start,
          loopEndSec: end,
          loopStartBeatIndex: Math.round(start * 2)
        })
      }
    )
  }
  const controller = useHorizontalBrowseDeckLoopController({
    touchDeckInteraction: () => {},
    nativeTransport: transport,
    resolveDeckSong: () => song,
    resolveDeckPlaying: (deck) => snapshot[deck].playing,
    resolveDeckQuantizeEnabled: (deck) => quantize[deck],
    resolveDeckRenderCurrentSeconds: (deck) => liveSeconds[deck],
    resolveDeckDurationSeconds: (deck) => snapshot[deck].durationSec,
    resolveTransportDeckSnapshot: (deck) => snapshot[deck],
    resolveDeckCuePointRef: (deck) => cues[deck]
  })
  return { controller, transport, quantize, liveSeconds, snapshot, cues }
}

describe('deck loop quantize', () => {
  it('keeps the current grid snapping when quantize is enabled', async () => {
    const { controller, transport } = createController()
    await controller.toggleDeckLoopState('top')
    expect(transport.setLoopFromRange).toHaveBeenCalledWith('top', 1, 5, false)
  })

  it('starts at the live click position when quantize is disabled', async () => {
    const { controller, transport, quantize, cues } = createController()
    quantize.top = false
    expect(await controller.toggleDeckLoopState('top')).toEqual({
      active: true,
      shouldStartPlayback: false
    })
    expect(transport.setLoopFromRange).toHaveBeenCalledWith('top', 1.23, 5.23, true)
    expect(transport.toggleLoop).not.toHaveBeenCalled()
    expect(cues.top.value).toBe(1.23)
  })

  it('uses the stopped playhead and requests playback when starting from pause', async () => {
    const { controller, transport, quantize, snapshot } = createController()
    quantize.top = false
    snapshot.top.playing = false
    expect(await controller.toggleDeckLoopState('top')).toEqual({
      active: true,
      shouldStartPlayback: true
    })
    expect(transport.setLoopFromRange).toHaveBeenCalledWith('top', 1.2, 5.2, true)
  })

  it('preserves the original start when resizing, including after changing quantize', async () => {
    const { controller, transport, quantize } = createController()
    quantize.top = false
    await controller.toggleDeckLoopState('top')
    quantize.top = true
    await controller.handleDeckLoopStepDown('top')
    expect(transport.setLoopFromRange).toHaveBeenLastCalledWith('top', 1.23, 3.23, true)
    await controller.handleDeckLoopStepUp('top')
    expect(transport.setLoopFromRange).toHaveBeenLastCalledWith('top', 1.23, 5.23, true)
  })

  it('uses independent quantize settings for the two decks', async () => {
    const { controller, transport, quantize } = createController()
    quantize.bottom = false
    await controller.toggleDeckLoopState('top')
    await controller.toggleDeckLoopState('bottom')
    expect(transport.setLoopFromRange).toHaveBeenCalledWith('top', 1, 5, false)
    expect(transport.setLoopFromRange).toHaveBeenCalledWith('bottom', 2.34, 6.34, true)
  })

  it('uses BPM for tracks without a v2 grid without quantizing the start', async () => {
    const { controller, transport, quantize } = createController({ beatGridMap: undefined })
    quantize.top = false
    await controller.toggleDeckLoopState('top')
    expect(transport.setLoopFromRange).toHaveBeenCalledWith('top', 1.23, 5.23, true)
  })

  it('uses the local grid BPM instead of the song summary BPM', async () => {
    const { controller, transport, quantize } = createController({ bpm: 90 })
    quantize.top = false
    await controller.toggleDeckLoopState('top')
    expect(transport.setLoopFromRange).toHaveBeenCalledWith('top', 1.23, 5.23, true)
  })

  it('clips the loop end at the track end without moving the start', async () => {
    const { controller, transport, quantize, liveSeconds } = createController()
    quantize.top = false
    liveSeconds.top = 19.23
    await controller.toggleDeckLoopState('top')
    expect(transport.setLoopFromRange).toHaveBeenCalledWith('top', 19.23, 20, true)
    await controller.handleDeckLoopStepDown('top')
    expect(transport.setLoopFromRange).toHaveBeenLastCalledWith('top', 19.23, 20, true)
  })

  it('turns an exact loop off and snaps again on the next quantized activation', async () => {
    const { controller, transport, quantize } = createController()
    quantize.top = false
    await controller.toggleDeckLoopState('top')
    await controller.toggleDeckLoopState('top')
    expect(controller.isDeckLoopActive('top')).toBe(false)
    quantize.top = true
    await controller.toggleDeckLoopState('top')
    expect(transport.setLoopFromRange).toHaveBeenLastCalledWith('top', 1, 5, false)
  })
})
