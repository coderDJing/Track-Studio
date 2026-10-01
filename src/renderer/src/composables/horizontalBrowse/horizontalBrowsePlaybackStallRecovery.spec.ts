import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ISongInfo } from 'src/types/globals'
import { createEmptyHorizontalBrowseTransportSnapshot } from '@shared/horizontalBrowseTransport'
import { createHorizontalBrowsePlaybackStallRecovery } from './horizontalBrowsePlaybackStallRecovery'

const createPlayingSnapshot = (currentSec: number) => {
  const snapshot = createEmptyHorizontalBrowseTransportSnapshot()
  return {
    ...snapshot,
    top: {
      ...snapshot.top,
      loaded: true,
      playheadLoaded: true,
      playing: true,
      playingAudible: true,
      currentSec,
      audioCurrentSec: currentSec,
      renderCurrentSec: currentSec
    }
  }
}

const loadedSong = { filePath: 'F:\\test.mp3' } as ISongInfo

describe('horizontalBrowsePlaybackStallRecovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('新鲜原生快照仍在前进时不重启播放', async () => {
    let currentSnapshot = createPlayingSnapshot(1)
    const freshSnapshot = createPlayingSnapshot(4)
    const preparePlayhead = vi.fn(async () => undefined)
    const setPlaying = vi.fn(async () => undefined)
    const snapshot = vi.fn(async () => {
      currentSnapshot = freshSnapshot
      return freshSnapshot
    })
    const recovery = createHorizontalBrowsePlaybackStallRecovery({
      nativeTransport: { preparePlayhead, setPlaying, snapshot },
      syncDeckRenderState: vi.fn(),
      resolveDeckSong: (deck) => (deck === 'top' ? loadedSong : null),
      resolveDeckPlaying: (deck) => deck === 'top',
      resolveDeckPendingPlay: () => false,
      resolveTransportDeckSnapshot: (deck) =>
        deck === 'top' ? currentSnapshot.top : currentSnapshot.bottom
    })

    await vi.advanceTimersByTimeAsync(3250)

    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(preparePlayhead).not.toHaveBeenCalled()
    expect(setPlaying).not.toHaveBeenCalled()
    recovery.dispose()
  })

  it('新鲜原生快照也没有前进时保留恢复动作', async () => {
    const currentSnapshot = createPlayingSnapshot(1)
    const preparePlayhead = vi.fn(async () => undefined)
    const setPlaying = vi.fn(async () => undefined)
    const snapshot = vi.fn(async () => currentSnapshot)
    const syncDeckRenderState = vi.fn()
    const recovery = createHorizontalBrowsePlaybackStallRecovery({
      nativeTransport: { preparePlayhead, setPlaying, snapshot },
      syncDeckRenderState,
      resolveDeckSong: (deck) => (deck === 'top' ? loadedSong : null),
      resolveDeckPlaying: (deck) => deck === 'top',
      resolveDeckPendingPlay: () => false,
      resolveTransportDeckSnapshot: (deck) =>
        deck === 'top' ? currentSnapshot.top : currentSnapshot.bottom
    })

    await vi.advanceTimersByTimeAsync(3250)

    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(preparePlayhead).toHaveBeenCalledOnce()
    expect(setPlaying).toHaveBeenCalledWith('top', true)
    expect(syncDeckRenderState).toHaveBeenCalledWith({ force: 'top', forceRevision: true })
    recovery.dispose()
  })

  it.each([false, true])('曲尾保持播放时不触发卡顿恢复，原生快照确认=%s', async (freshOnly) => {
    const currentSnapshot = createPlayingSnapshot(2.5)
    currentSnapshot.top.durationSec = 3
    currentSnapshot.top.effectiveDurationSec = freshOnly ? 3 : 2.5
    const freshSnapshot = {
      ...currentSnapshot,
      top: { ...currentSnapshot.top, effectiveDurationSec: 2.5, playingAudible: false }
    }
    const preparePlayhead = vi.fn(async () => undefined)
    const setPlaying = vi.fn(async () => undefined)
    const snapshot = vi.fn(async () => freshSnapshot)
    const recovery = createHorizontalBrowsePlaybackStallRecovery({
      nativeTransport: { preparePlayhead, setPlaying, snapshot },
      syncDeckRenderState: vi.fn(),
      resolveDeckSong: (deck) => (deck === 'top' ? loadedSong : null),
      resolveDeckPlaying: (deck) => deck === 'top',
      resolveDeckPendingPlay: () => false,
      resolveTransportDeckSnapshot: (deck) => currentSnapshot[deck]
    })

    await vi.advanceTimersByTimeAsync(10_000)

    expect(preparePlayhead).not.toHaveBeenCalled()
    expect(setPlaying).not.toHaveBeenCalled()
    if (!freshOnly) expect(snapshot).not.toHaveBeenCalled()
    recovery.dispose()
  })
})
