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
  it.each([0.5, 0.125, 0.0625, 0.03125, 0.0078125])(
    '两轨短 Loop（%s 秒）每帧回环，无需等待 native 快照',
    (loopDurationSec) => {
      const { snapshot, renderSync } = createRenderSync(() => false)
      for (const deck of ['top', 'bottom'] as const) {
        snapshot[deck].loopActive = true
        snapshot[deck].loopStartSec = 10.123
        snapshot[deck].loopEndSec = 10.123 + loopDurationSec
        snapshot[deck].renderCurrentSec = 10.123 + loopDurationSec * 0.4
        snapshot[deck].playbackRate = 1
      }
      renderSync.syncDeckRenderState({ nowMs: 1000, snapshotAtMs: 1000 })
      const clock = vi.spyOn(performance, 'now').mockReturnValue(1000 + loopDurationSec * 3200)
      try {
        for (const deck of ['top', 'bottom'] as const) {
          expect(renderSync.resolveDeckRenderCurrentSeconds(deck)).toBeCloseTo(
            10.123 + loopDurationSec * 0.6,
            9
          )
        }
      } finally {
        clock.mockRestore()
      }
    }
  )

  it('Loop 快照小幅相位误差及时修正，正常回环不提升播放 revision', () => {
    const { snapshot, renderSync } = createRenderSync(() => false)
    Object.assign(snapshot.top, {
      loopActive: true,
      loopStartSec: 10.123,
      loopEndSec: 10.248,
      renderCurrentSec: 10.173,
      playbackRate: 1
    })
    renderSync.syncDeckRenderState({ nowMs: 1000, snapshotAtMs: 1000 })
    const initialRevision = renderSync.topDeckPlaybackSyncRevision.value
    // Two cycles later native audio is 5 ms behind the visual clock.
    snapshot.top.renderCurrentSec = 10.168
    renderSync.syncDeckRenderState({ nowMs: 1250, snapshotAtMs: 1250 })
    expect(renderSync.topDeckRenderCurrentSeconds.value).toBeCloseTo(10.168, 9)
    expect(renderSync.topDeckPlaybackSyncRevision.value).toBe(initialRevision)
  })

  it('Loop 关闭后继续正常外推，暂停时保持当前位置', () => {
    const { snapshot, renderSync } = createRenderSync(() => false)
    Object.assign(snapshot.top, {
      loopActive: true,
      loopStartSec: 10.123,
      loopEndSec: 10.248,
      renderCurrentSec: 10.173,
      playbackRate: 1
    })
    renderSync.syncDeckRenderState({ nowMs: 1000, snapshotAtMs: 1000 })
    snapshot.top.loopActive = false
    renderSync.syncDeckRenderState({ nowMs: 1250, snapshotAtMs: 1250 })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1500)
    try {
      expect(renderSync.resolveDeckRenderCurrentSeconds('top')).toBeCloseTo(10.423, 9)
      snapshot.top.playing = false
      snapshot.top.playingAudible = false
      snapshot.top.renderCurrentSec = 10.223
      renderSync.syncDeckRenderState({ nowMs: 1500, snapshotAtMs: 1500 })
      clock.mockReturnValue(5000)
      expect(renderSync.resolveDeckRenderCurrentSeconds('top')).toBe(10.223)
    } finally {
      clock.mockRestore()
    }
  })

  it.each([
    ['top', 180, false],
    ['bottom', 180, false],
    ['top', 179.9, true],
    ['bottom', 179.9, true]
  ] as const)('曲尾保持播放时 %s 渲染位置锁定在 %s，BeatSync=%s', (deck, endSec, syncEnabled) => {
    const { snapshot, renderSync } = createRenderSync(() => false)
    snapshot[deck].syncEnabled = syncEnabled
    snapshot[deck].syncLock = syncEnabled ? 'full' : 'off'
    snapshot[deck].effectiveDurationSec = endSec
    snapshot[deck].currentSec = endSec - 0.2
    snapshot[deck].renderCurrentSec = endSec - 0.2
    snapshot[deck].playbackRate = 1
    renderSync.syncDeckRenderState({ nowMs: 1000, snapshotAtMs: 1000 })

    const clock = vi.spyOn(performance, 'now').mockReturnValue(1250)
    try {
      expect(renderSync.resolveDeckRenderCurrentSeconds(deck)).toBe(endSec)
      snapshot[deck].currentSec = endSec
      snapshot[deck].renderCurrentSec = endSec
      snapshot[deck].playingAudible = false

      // Audible status can update before the next render synchronization/RAF tick.
      expect(renderSync.resolveDeckRenderCurrentSeconds(deck)).toBe(endSec)
      renderSync.syncDeckRenderState({ nowMs: 1300, snapshotAtMs: 1300 })
      const renderedSeconds =
        deck === 'top'
          ? renderSync.topDeckRenderCurrentSeconds
          : renderSync.bottomDeckRenderCurrentSeconds
      expect(renderedSeconds.value).toBe(endSec)
      clock.mockReturnValue(8000)
      expect(renderSync.resolveDeckRenderCurrentSeconds(deck)).toBe(endSec)

      // The user's drag target still takes priority over the old end snapshot.
      renderSync.applyDeckRenderCurrentSeconds(deck, 120)
      expect(renderSync.resolveDeckRenderCurrentSeconds(deck)).toBe(120)
      snapshot[deck].currentSec = 120
      snapshot[deck].renderCurrentSec = 120
      snapshot[deck].playingAudible = true
      renderSync.syncDeckRenderState({ nowMs: 8000, snapshotAtMs: 8000 })
      clock.mockReturnValue(8250)
      expect(renderSync.resolveDeckRenderCurrentSeconds(deck)).toBe(120.25)
    } finally {
      clock.mockRestore()
    }
  })

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

  it('BeatSync 快照经过 IPC 延迟后按命令时刻外推，保持不同 BPM 两轨相位一致', () => {
    const { snapshot, renderSync } = createRenderSync(() => true)
    snapshot.top.renderCurrentSec = 20.560113
    snapshot.top.playbackRate = 1
    snapshot.bottom.renderCurrentSec = 15.07100129787234
    snapshot.bottom.playbackRate = 150 / 141

    renderSync.syncDeckRenderState({
      nowMs: 1100,
      snapshotAtMs: 1000,
      force: 'all'
    })

    const topBeatDistance = ((renderSync.topDeckRenderCurrentSeconds.value - 0.050113) * 150) / 60
    const bottomBeatDistance =
      ((renderSync.bottomDeckRenderCurrentSeconds.value - 0.060363) * 141) / 60
    expect(topBeatDistance - bottomBeatDistance).toBeCloseTo(16, 6)
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
