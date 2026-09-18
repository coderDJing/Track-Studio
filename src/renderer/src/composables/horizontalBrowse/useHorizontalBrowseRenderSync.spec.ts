import { describe, expect, it, vi } from 'vitest'
import {
  createEmptyHorizontalBrowseTransportSnapshot,
  type HorizontalBrowseDeckKey
} from '@shared/horizontalBrowseTransport'
import { useHorizontalBrowseRenderSync } from './useHorizontalBrowseRenderSync'

const createPlayingSnapshot = () => {
  const snapshot = createEmptyHorizontalBrowseTransportSnapshot()
  snapshot.stateRevision = 1
  snapshot.top = {
    ...snapshot.top,
    label: 'top',
    loaded: true,
    playing: true,
    playingAudible: true,
    durationSec: 180,
    effectiveDurationSec: 180,
    currentSec: 11.188552,
    renderCurrentSec: 11.188552,
    playbackRate: 1,
    syncEnabled: true,
    syncLock: 'full',
    leader: true
  }
  snapshot.bottom = {
    ...snapshot.bottom,
    label: 'bottom',
    loaded: true,
    playing: true,
    playingAudible: true,
    durationSec: 180,
    effectiveDurationSec: 180,
    currentSec: 3.907291,
    renderCurrentSec: 3.907291,
    playbackRate: 123 / 126,
    syncEnabled: true,
    syncLock: 'full',
    leader: false
  }
  return snapshot
}

const createRenderSync = (linkedGridVisualPending: () => boolean) => {
  const snapshot = createPlayingSnapshot()
  const resolveDeckSnapshot = (deck: HorizontalBrowseDeckKey) =>
    deck === 'top' ? snapshot.top : snapshot.bottom
  return {
    snapshot,
    renderSync: useHorizontalBrowseRenderSync({
      nativeTransport: {
        state: snapshot,
        snapshot: vi.fn(async () => snapshot)
      },
      resolveTransportDeckSnapshot: resolveDeckSnapshot,
      resolveDeckPlaying: (deck) => resolveDeckSnapshot(deck).playing,
      linkedGridVisualPending
    })
  }
}

describe('useHorizontalBrowseRenderSync', () => {
  it('联结视觉事务 pending 时普通同步不会重锚', () => {
    const { renderSync } = createRenderSync(() => true)

    renderSync.syncDeckRenderState({
      nowMs: 1000,
      snapshotAtMs: 1000
    })

    expect(renderSync.topDeckRenderCurrentSeconds.value).toBe(0)
    expect(renderSync.bottomDeckRenderCurrentSeconds.value).toBe(0)
  })

  it('联结开启可强制重锚两轨但不提升播放 revision', () => {
    const { snapshot, renderSync } = createRenderSync(() => true)

    renderSync.syncDeckRenderState({
      nowMs: 1000,
      snapshotAtMs: 1000,
      force: 'all',
      preserveRevision: true
    })

    expect(renderSync.topDeckRenderCurrentSeconds.value).toBeCloseTo(
      snapshot.top.renderCurrentSec,
      6
    )
    expect(renderSync.bottomDeckRenderCurrentSeconds.value).toBeCloseTo(
      snapshot.bottom.renderCurrentSec,
      6
    )
    expect(renderSync.topDeckPlaybackSyncRevision.value).toBe(0)
    expect(renderSync.bottomDeckPlaybackSyncRevision.value).toBe(0)
  })

  it('现有 force 同步仍会提升播放 revision', () => {
    const { renderSync } = createRenderSync(() => true)

    renderSync.syncDeckRenderState({
      nowMs: 1000,
      snapshotAtMs: 1000,
      force: 'all'
    })

    expect(renderSync.topDeckPlaybackSyncRevision.value).toBe(1)
    expect(renderSync.bottomDeckPlaybackSyncRevision.value).toBe(1)
  })

  it('列表试听暂挂时锁存两轨 UI，忽略后续轮询快照的小幅推进', () => {
    const { snapshot, renderSync } = createRenderSync(() => false)
    snapshot.auditionSuspended = true
    snapshot.top.playingAudible = false
    snapshot.bottom.playingAudible = false
    const frozenTopSec = snapshot.top.renderCurrentSec
    const frozenBottomSec = snapshot.bottom.renderCurrentSec

    renderSync.setAuditionPresentationSuspended(true)
    snapshot.top.renderCurrentSec += 0.2
    snapshot.bottom.renderCurrentSec += 0.15
    renderSync.syncDeckRenderState({
      nowMs: 5000,
      snapshotAtMs: 5000
    })

    expect(renderSync.topDeckRenderCurrentSeconds.value).toBeCloseTo(frozenTopSec, 6)
    expect(renderSync.bottomDeckRenderCurrentSeconds.value).toBeCloseTo(frozenBottomSec, 6)

    snapshot.auditionSuspended = false
    renderSync.setAuditionPresentationSuspended(false)
    expect(renderSync.topDeckRenderCurrentSeconds.value).toBeCloseTo(
      snapshot.top.renderCurrentSec,
      6
    )
    expect(renderSync.bottomDeckRenderCurrentSeconds.value).toBeCloseTo(
      snapshot.bottom.renderCurrentSec,
      6
    )
  })
})
