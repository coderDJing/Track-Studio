import { describe, expect, it, vi } from 'vitest'
import { createMixtapeMasterGrid } from './mixtapeMasterGrid'
import type { TransportPlayableSource } from './timelineTransportPlayableSource'
import { applyTimelineTransportSync, type TransportSyncNode } from './timelineTransportSync'
import type { SerializedTrackTempoSnapshot } from './types'

const createTempoSnapshot = (): SerializedTrackTempoSnapshot => ({
  signature: 'fixed-128',
  durationSec: 120,
  baseDurationSec: 120,
  sourceDurationSec: 120,
  baseBpm: 128,
  gridSourceBpm: 128,
  originalBpm: 128,
  firstBeatSourceSec: 0,
  beatSourceSec: 60 / 128,
  downbeatBeatOffset: 0,
  controlPoints: []
})

const createNode = (
  trackId: string,
  sourceSec: number,
  latencySec: number,
  setTargetAtTime: (value: number, startTime: number, timeConstant: number) => void
): TransportSyncNode => {
  const source: TransportPlayableSource = {
    buffer: null,
    startOffsetKind: 'source',
    resolveLatencySec: () => latencySec,
    resolvePlaybackPositionSec: () => sourceSec,
    playbackRate: {
      value: 1,
      setTargetAtTime
    },
    onended: null,
    connect: () => undefined,
    disconnect: () => undefined,
    start: () => undefined,
    stop: () => undefined
  }
  return {
    trackId,
    source,
    entry: {
      trackId,
      startSec: 0,
      duration: 120,
      bpm: 128,
      tempoSnapshot: createTempoSnapshot(),
      beatSec: 60 / 128,
      masterTempo: true,
      syncAnchorSec: 0,
      tempoRatio: 1
    }
  }
}

describe('timeline transport source phase', () => {
  it.each([0.02, -0.02])(
    'locks an existing phase offset of %s seconds without inducing speed drift',
    (offset) => {
      const master = createNode('master', 8, 0, vi.fn())
      const follower = createNode('follower', 8, 0, vi.fn())
      master.entry.syncAnchorSec = 10
      follower.entry.syncAnchorSec = 10 + offset
      for (const timelineSec of [8, 20, 48]) {
        const result = applyTimelineTransportSync({
          nodes: [master, follower],
          timelineSec,
          masterTrackId: 'master',
          audioCtx: { state: 'running', currentTime: timelineSec } as BaseAudioContext,
          collectDiagnostics: true
        })
        expect(result.diagnostics[1].postPhaseErrorSec).toBeCloseTo(0, 8)
        expect(result.diagnostics[1].phasePull).toBeCloseTo(0, 8)
        expect(result.diagnostics[1].appliedRate).toBeCloseTo(1, 8)
      }
    }
  )

  it('keeps the aiSet 18/19 overlap at the same tempo on the edited BPM curve', () => {
    const points = [
      { sec: 0, bpm: 126 },
      { sec: 3441.9396, bpm: 127.1828 },
      { sec: 3551.2069, bpm: 129.9693 },
      { sec: 4272.2224, bpm: 132.375 }
    ]
    const grid = createMixtapeMasterGrid({ points, fallbackBpm: 126 })
    const master = createNode('18', 0, 0, vi.fn())
    const follower = createNode('19', 0, 0, vi.fn())
    for (const [node, startSec, sourceBpm] of [
      [master, 3387.2021, 132],
      [follower, 3588.7492, 130]
    ] as const) {
      node.entry.startSec = startSec
      node.entry.duration = 300
      node.entry.tempoSnapshot = {
        ...createTempoSnapshot(),
        signature: node.trackId,
        gridSourceBpm: sourceBpm,
        beatSourceSec: 60 / sourceBpm,
        mappingMode: 'masterGrid',
        trackStartSec: startSec,
        masterGridPoints: points,
        masterGridFallbackBpm: 130
      }
    }
    master.entry.syncAnchorSec = master.entry.startSec
    follower.entry.syncAnchorSec = grid.mapBeatsToSec(
      grid.mapSecToBeats(follower.entry.startSec) + (0.2185 * 130) / 60
    )

    for (const timelineSec of [3600, 3620, 3640]) {
      const result = applyTimelineTransportSync({
        nodes: [master, follower],
        timelineSec,
        masterTrackId: '18',
        audioCtx: { state: 'running', currentTime: timelineSec } as BaseAudioContext,
        collectDiagnostics: true
      })
      const followerDiagnostic = result.diagnostics[1]
      expect(Math.abs(followerDiagnostic.postPhaseErrorSec)).toBeLessThan(0.0001)
      expect(Math.abs(followerDiagnostic.phasePull)).toBeLessThan(0.00004)
      expect(followerDiagnostic.appliedRate).toBeCloseTo(followerDiagnostic.baseRate, 4)
    }
  })

  it.each([-0.04, 0.04])(
    'locks either direction of phase offset on a changing master grid (%s seconds)',
    (offset) => {
      const points = [
        { sec: 0, bpm: 120 },
        { sec: 120, bpm: 140 }
      ]
      const grid = createMixtapeMasterGrid({ points, fallbackBpm: 120 })
      const master = createNode('master', 0, 0, vi.fn())
      const follower = createNode('follower', 0, 0, vi.fn())
      for (const node of [master, follower]) {
        node.entry.tempoSnapshot = {
          ...createTempoSnapshot(),
          mappingMode: 'masterGrid',
          trackStartSec: 0,
          masterGridPoints: points,
          masterGridFallbackBpm: 120
        }
      }
      master.entry.syncAnchorSec = 5
      follower.entry.syncAnchorSec = grid.mapBeatsToSec(grid.mapSecToBeats(5) + 32) + offset
      const result = applyTimelineTransportSync({
        nodes: [master, follower],
        timelineSec: 60,
        masterTrackId: 'master',
        audioCtx: { state: 'running', currentTime: 60 } as BaseAudioContext,
        collectDiagnostics: true
      })
      expect(Math.abs(result.diagnostics[1].postPhaseErrorSec)).toBeLessThan(0.0001)
      expect(Math.abs(result.diagnostics[1].phasePull)).toBeLessThan(0.00004)
    }
  )

  it('hands Master to the next active track at the exact end, even when the previous source has latency', () => {
    const ended = createNode('ended', 120, 0.1, vi.fn())
    const next = createNode('next', 60, 0, vi.fn())
    next.entry.startSec = 60
    const result = applyTimelineTransportSync({
      nodes: [ended, next],
      timelineSec: 120,
      masterTrackId: 'ended',
      audioCtx: { state: 'running', currentTime: 120 } as BaseAudioContext
    })
    expect(result.masterTrackId).toBe('next')
    expect(result.activeTrackCount).toBe(1)
  })
  it('uses the corrected source grid BPM instead of stale metadata for playback', () => {
    const setRate = vi.fn()
    const node = createNode('corrected-grid', 8, 0, setRate)
    node.entry.originalBpm = 126
    node.entry.tempoSnapshot.gridSourceBpm = 128
    applyTimelineTransportSync({
      nodes: [node],
      timelineSec: 8,
      masterTrackId: node.trackId,
      audioCtx: { state: 'running', currentTime: 8 } as BaseAudioContext
    })
    expect(setRate).toHaveBeenCalledWith(1, 8, 0.04)
  })
  it('does not use mismatched processing-chain source clocks as musical phase feedback', () => {
    const masterSetRate = vi.fn()
    const followerSetRate = vi.fn()
    const masterNode = createNode('master', 8, 0, masterSetRate)
    const followerNode = createNode('follower', 8.07375, 0.07375, followerSetRate)

    const result = applyTimelineTransportSync({
      nodes: [masterNode, followerNode],
      timelineSec: 8,
      masterTrackId: 'master',
      sharedMasterBpm: 128,
      audioCtx: {
        state: 'running',
        currentTime: 8
      } as BaseAudioContext,
      collectDiagnostics: true
    })

    expect(result.diagnostics[1]?.phaseErrorSec).toBeCloseTo(0, 8)
    expect(result.diagnostics[1]?.appliedRate).toBeCloseTo(1, 8)
    expect(followerSetRate).toHaveBeenCalledWith(1, 8, 0.04)
  })
})
