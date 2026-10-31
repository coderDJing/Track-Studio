import { effectScope } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ISongInfo } from 'src/types/globals'
import {
  createEmptyHorizontalBrowseTransportSnapshot,
  type HorizontalBrowseDeckKey
} from '@shared/horizontalBrowseTransport'
import { useHorizontalBrowseDeckPlaybackController } from './useHorizontalBrowseDeckPlaybackController'
import type { UseHorizontalBrowseDeckPlaybackControllerParams } from './useHorizontalBrowseDeckPlaybackControllerTypes'

const createHarness = (playing = true) => {
  vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn() })
  const scope = effectScope()
  const snapshot = createEmptyHorizontalBrowseTransportSnapshot()
  Object.assign(snapshot.top, {
    currentSec: 10,
    renderCurrentSec: 10,
    playbackRate: 1.2,
    leader: true
  })
  Object.assign(snapshot.bottom, { currentSec: 4, renderCurrentSec: 4, playbackRate: 0.8 })
  for (const deck of ['top', 'bottom'] as const)
    Object.assign(snapshot[deck], {
      durationSec: 180,
      effectiveDurationSec: 180,
      loaded: true,
      playheadLoaded: true,
      playing,
      playingAudible: playing,
      syncEnabled: true,
      syncLock: 'full'
    })
  const visible = { top: 10.024, bottom: 4.016 }
  const song = { filePath: 'linked.wav', bpm: 120 } as ISongInfo
  const params: UseHorizontalBrowseDeckPlaybackControllerParams = {
    touchDeckInteraction: vi.fn(),
    notifyDeckSeekIntent: vi.fn(),
    holdDeckRenderCurrentSeconds: vi.fn(),
    startDeckRenderPlaybackClock: vi.fn(),
    nativeTransport: {
      setPlaying: vi.fn(async () => {}),
      setLeader: vi.fn(async () => {}),
      preparePlayhead: vi.fn(async () => {}),
      seek: vi.fn(async () => {}),
      setScrubPreview: vi.fn(async () => {}),
      beatsync: vi.fn(async () => {}),
      alignToLeader: vi.fn(async () => {}),
      setSyncEnabled: vi.fn(async () => {}),
      snapshot: vi.fn(async () => snapshot)
    },
    syncDeckRenderState: vi.fn(),
    commitDeckStatesToNative: vi.fn(async () => {}),
    resolveDeckSong: () => song,
    resolveDeckGridBpm: () => 120,
    resolveDeckDurationSeconds: () => 180,
    resolveDeckCurrentSeconds: (deck) => snapshot[deck].currentSec,
    resolveDeckRenderCurrentSeconds: vi.fn((deck: HorizontalBrowseDeckKey) => visible[deck]),
    resolveDeckPlaying: (deck) => snapshot[deck].playing,
    resolveDeckLoaded: () => true,
    resolveTransportDeckSnapshot: (deck) => snapshot[deck],
    isDeckLoopActive: () => false,
    syncDeckIntoLoopRangeBeforePlay: async () => {},
    applyDeckStoredCueDefinition: async () => null,
    resolveDualTransportSyncEnabled: () => true
  }
  const controller = scope.run(() => useHorizontalBrowseDeckPlaybackController(params))!
  return { controller, params, snapshot, visible, stop: () => scope.stop() }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('linked drag and pause handoff', () => {
  it.each(['top', 'bottom'] as const)(
    'dragging %s takes over the visible pair and pauses both atomically',
    async (source) => {
      const h = createHarness()
      try {
        h.controller.handleDeckRawWaveformDragStart(source)
        expect(h.controller.resolveDeckWaveformDragAnchorSec('top')).toBe(h.visible.top)
        expect(h.controller.resolveDeckWaveformDragAnchorSec('bottom')).toBe(h.visible.bottom)
        expect(h.params.nativeTransport.setPlaying).not.toHaveBeenCalled()
        expect(h.params.commitDeckStatesToNative).toHaveBeenCalledExactlyOnceWith(
          {
            top: {
              currentSec: h.visible.top,
              lastObservedAtMs: expect.any(Number),
              playing: false
            },
            bottom: {
              currentSec: h.visible.bottom,
              lastObservedAtMs: expect.any(Number),
              playing: false
            }
          },
          { allowPhaseAlignment: false }
        )
        const delta = h.snapshot[source].playbackRate * 0.5
        h.controller.handleDeckRawWaveformScrubPreview(source, {
          anchorSec: h.visible[source] + delta,
          playbackRate: 1
        })
        expect(h.controller.resolveDeckWaveformDragAnchorSec('top')).toBeCloseTo(
          h.visible.top + 0.6,
          9
        )
        expect(h.controller.resolveDeckWaveformDragAnchorSec('bottom')).toBeCloseTo(
          h.visible.bottom + 0.4,
          9
        )
        await Promise.resolve()
      } finally {
        h.stop()
      }
    }
  )

  it('linked pause submits the same visible phase for both decks in one command', async () => {
    const h = createHarness()
    try {
      h.controller.handleDeckPlayPauseToggle('bottom')
      expect(h.params.nativeTransport.setPlaying).not.toHaveBeenCalled()
      expect(h.params.commitDeckStatesToNative).toHaveBeenCalledTimes(1)
      const call = vi.mocked(h.params.commitDeckStatesToNative).mock.calls[0]
      expect(call[0]?.top?.currentSec).toBe(h.visible.top)
      expect(call[0]?.bottom?.currentSec).toBe(h.visible.bottom)
      expect(call[0]?.top?.lastObservedAtMs).toBe(call[0]?.bottom?.lastObservedAtMs)
      await Promise.resolve()
    } finally {
      h.stop()
    }
  })

  it('pause-all also uses one paired command while linked', async () => {
    const h = createHarness()
    try {
      h.controller.pauseAllDeckPlayback()
      expect(h.params.commitDeckStatesToNative).toHaveBeenCalledTimes(1)
      expect(h.params.nativeTransport.setPlaying).not.toHaveBeenCalled()
      await Promise.resolve()
    } finally {
      h.stop()
    }
  })

  it.each(['top', 'bottom'] as const)(
    'paused %s drag and quick reversal commit the final pair without resuming',
    async (source) => {
      const h = createHarness(false)
      try {
        h.controller.handleDeckRawWaveformDragStart(source)
        for (const delta of [2, -1, 0.25]) {
          h.controller.handleDeckRawWaveformScrubPreview(source, {
            anchorSec: h.visible[source] + delta * h.snapshot[source].playbackRate,
            playbackRate: Math.sign(delta)
          })
        }
        const finalTop = h.visible.top + 0.3
        const finalBottom = h.visible.bottom + 0.2
        h.controller.handleDeckRawWaveformDragEnd(source, {
          anchorSec: source === 'top' ? finalTop : finalBottom,
          committed: true
        })
        await vi.waitFor(() => expect(h.params.commitDeckStatesToNative).toHaveBeenCalledTimes(1))
        const overrides = vi.mocked(h.params.commitDeckStatesToNative).mock.calls[0][0]
        expect(overrides?.top?.currentSec).toBeCloseTo(finalTop, 9)
        expect(overrides?.bottom?.currentSec).toBeCloseTo(finalBottom, 9)
        expect(overrides?.top?.playing).toBe(false)
        expect(overrides?.bottom?.playing).toBe(false)
        expect(h.params.startDeckRenderPlaybackClock).not.toHaveBeenCalled()
        expect(h.params.nativeTransport.setPlaying).not.toHaveBeenCalled()
      } finally {
        h.stop()
      }
    }
  )

  it('release waits for an in-flight paired pause and resumes only the latest drag targets', async () => {
    const h = createHarness()
    let finishPause = () => {}
    vi.mocked(h.params.commitDeckStatesToNative).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPause = resolve
        })
    )
    try {
      h.controller.handleDeckRawWaveformDragStart('bottom')
      h.controller.handleDeckRawWaveformScrubPreview('bottom', {
        anchorSec: h.visible.bottom + 0.8,
        playbackRate: 1
      })
      h.controller.handleDeckRawWaveformDragEnd('bottom', {
        anchorSec: h.visible.bottom + 0.4,
        committed: true
      })
      expect(h.params.commitDeckStatesToNative).toHaveBeenCalledTimes(1)
      finishPause()
      await vi.waitFor(() => expect(h.params.commitDeckStatesToNative).toHaveBeenCalledTimes(3))
      const overrides = vi.mocked(h.params.commitDeckStatesToNative).mock.calls[2][0]
      expect(overrides?.top?.currentSec).toBeCloseTo(h.visible.top + 0.6, 9)
      expect(overrides?.bottom?.currentSec).toBeCloseTo(h.visible.bottom + 0.4, 9)
      expect(overrides?.top?.playing).toBe(true)
      expect(overrides?.bottom?.playing).toBe(true)
      expect(overrides?.top?.lastObservedAtMs).toBe(overrides?.bottom?.lastObservedAtMs)
      expect(h.params.nativeTransport.setPlaying).not.toHaveBeenCalled()
    } finally {
      h.stop()
    }
  })

  it('unlinked drag still pauses only the dragged deck', async () => {
    const h = createHarness()
    h.params.resolveDualTransportSyncEnabled = () => false
    try {
      h.controller.handleDeckRawWaveformDragStart('bottom')
      expect(h.params.nativeTransport.setPlaying).toHaveBeenCalledExactlyOnceWith('bottom', false)
      expect(h.params.commitDeckStatesToNative).not.toHaveBeenCalled()
      expect(h.controller.isDeckWaveformDragging('top')).toBe(false)
      await Promise.resolve()
    } finally {
      h.stop()
    }
  })
})
