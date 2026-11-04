import { describe, expect, it, vi } from 'vitest'
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
