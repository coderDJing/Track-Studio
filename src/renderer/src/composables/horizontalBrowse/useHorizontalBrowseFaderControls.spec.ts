import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyHorizontalBrowseTransportSnapshot } from '@shared/horizontalBrowseTransport'
import type { ISongInfo } from 'src/types/globals'
import { useHorizontalBrowseFaderControls } from './useHorizontalBrowseFaderControls'

const song: ISongInfo = {
  filePath: 'track.wav',
  fileName: 'track.wav',
  fileFormat: 'wav',
  cover: null,
  title: undefined,
  artist: undefined,
  album: undefined,
  duration: '3:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined
}

describe('关闭双轨联结', () => {
  it.each(['top', 'bottom'] as const)('%s 为主轨时，先等从轨解除同步再关闭主轨', async (leader) => {
    const follower = leader === 'top' ? 'bottom' : 'top'
    const snapshot = createEmptyHorizontalBrowseTransportSnapshot()
    for (const deck of [snapshot.top, snapshot.bottom]) {
      deck.playing = true
      deck.syncEnabled = true
      deck.syncLock = 'full'
    }
    let finishFollowerUnlock = () => {}
    const followerUnlock = new Promise<void>((resolve) => {
      finishFollowerUnlock = resolve
    })
    const setSyncEnabled = vi.fn().mockResolvedValue(undefined)
    setSyncEnabled.mockReturnValueOnce(followerUnlock)
    const clearLinkedPresentation = vi.fn()
    const scope = effectScope()
    const controls = scope.run(() =>
      useHorizontalBrowseFaderControls({
        topDeckSong: ref(song),
        bottomDeckSong: ref(song),
        setting: { horizontalBrowseFaderControlsExpanded: true },
        deckSyncState: { leaderDeck: leader },
        nativeTransport: {
          setBandState: vi.fn(),
          setCueMonitorEnabled: vi.fn(),
          setLeader: vi.fn(),
          setSyncEnabled,
          alignToLeader: vi.fn(),
          setPlaying: vi.fn()
        },
        commitDeckStatesToNative: vi.fn(),
        syncDeckRenderState: vi.fn(),
        clearLinkedPresentation,
        resolveDeckSong: () => song,
        resolveDeckPlaying: () => true,
        resolveDeckCurrentSeconds: () => 0,
        resolveDeckDurationSeconds: () => 180,
        resolveTransportDeckSnapshot: (deck) => snapshot[deck]
      })
    )!
    try {
      await controls.activateDualTransportSync()
      controls.deactivateDualTransportSync()
      controls.deactivateDualTransportSync()
      expect(setSyncEnabled.mock.calls).toEqual([[follower, false]])
      expect(clearLinkedPresentation).not.toHaveBeenCalled()

      finishFollowerUnlock()
      await vi.waitFor(() => expect(controls.dualTransportSyncDeactivating.value).toBe(false))
      expect(setSyncEnabled.mock.calls).toEqual([
        [follower, false],
        [leader, false]
      ])
      expect(clearLinkedPresentation).toHaveBeenCalledOnce()
    } finally {
      scope.stop()
    }
  })
})
