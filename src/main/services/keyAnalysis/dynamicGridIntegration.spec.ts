import { describe, expect, it } from 'vitest'
import {
  readAnalysisGridMode,
  readDynamicGridOutcome,
  readDynamicGridSidecarPid
} from './dynamicGridIntegration'
import { createSongBeatGridMapV2FromClips } from '../../../shared/songBeatGridMapV2'

const MAP = createSongBeatGridMapV2FromClips(
  [
    { startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 },
    { startSec: 30, anchorSec: 30, bpm: 124, downbeatBeatOffset: 0 }
  ],
  'analysis',
  { allowSingleClip: true }
)!

const buildMetrics = () => ({
  policyVersion: 'p1',
  windowCount: 4,
  okWindowCount: 4,
  noBeatWindowCount: 0,
  scannedDurationAudioSec: 60,
  scannedCoverageRatio: 1,
  noBeatWindowDurationAudioSec: 0,
  beatEvidenceSpanDurationAudioSec: 60,
  beatEvidenceSpanRatio: 1,
  evidenceBeatCount: 120,
  fittedBeatCount: 120,
  runtimeLineCount: 120,
  runtimeMatchedBeatCount: 118,
  runtimeUnmatchedLineCount: 2,
  runtimeUnmatchedEvidenceCount: 2,
  runtimeHeadExtrapolatedLineCount: 0,
  runtimeTailExtrapolatedLineCount: 0,
  runtimeDownbeatMismatchCount: 0,
  runtimeBoundaryMismatchCount: 0,
  excludedBeatCount: 0,
  inferredMissingBeatCount: 0,
  extraBeatCount: 0,
  gapAnomalyCount: 0,
  unexplainedBeatCount: 2,
  unexplainedBeatRatio: 0.0167,
  overlapComparisonCount: 10,
  overlapMatchedCount: 10,
  overlapMatchRate: 1,
  overlapResidualP95Ms: 5,
  overlapResidualMaxMs: 9,
  residualP50Ms: 2,
  residualP95Ms: 6,
  residualMaxMs: 12,
  cumulativePhaseDeviationMaxMs: 20,
  seamBoundaryErrorMaxMs: 6,
  tailErrorMs: 8,
  downbeatObservedCount: 20,
  downbeatConflictCount: 0,
  clipCount: 2,
  requestedMinBpm: 70,
  requestedMaxBpm: 180
})

const buildSuccessOutcome = () => ({
  status: 'dynamic' as const,
  coordinate: 'audio' as const,
  beatGridMap: MAP,
  durationAudioSec: 60,
  policyVersion: 'p1',
  metrics: buildMetrics()
})

describe('readDynamicGridOutcome', () => {
  it('accepts a success outcome carrying a complete map, duration and metrics', () => {
    const parsed = readDynamicGridOutcome(buildSuccessOutcome())
    expect(parsed?.status).toBe('dynamic')
    if (parsed?.status !== 'dynamic') return
    expect(parsed.metrics.runtimeLineCount).toBe(120)
    expect(parsed.metrics.clipCount).toBe(2)
  })

  it('rejects a success outcome without metrics instead of passing it through', () => {
    const withoutMetrics: Record<string, unknown> = { ...buildSuccessOutcome() }
    delete withoutMetrics.metrics
    expect(readDynamicGridOutcome(withoutMetrics)).toBeUndefined()
  })

  it('rejects metrics missing denominator fields', () => {
    const metrics: Record<string, unknown> = { ...buildMetrics() }
    delete metrics.overlapMatchRate
    expect(readDynamicGridOutcome({ ...buildSuccessOutcome(), metrics })).toBeUndefined()
  })

  it('rejects metrics with impossible counts or ratios', () => {
    const badWindowCount = { ...buildMetrics(), noBeatWindowCount: 3 }
    expect(
      readDynamicGridOutcome({ ...buildSuccessOutcome(), metrics: badWindowCount })
    ).toBeUndefined()

    const badRatio = { ...buildMetrics(), scannedCoverageRatio: 1.4 }
    expect(readDynamicGridOutcome({ ...buildSuccessOutcome(), metrics: badRatio })).toBeUndefined()

    const badMatch = { ...buildMetrics(), overlapMatchedCount: 11 }
    expect(readDynamicGridOutcome({ ...buildSuccessOutcome(), metrics: badMatch })).toBeUndefined()
  })

  it('keeps head/tail extrapolated line counts and enforces their sum invariant', () => {
    const withExtrapolation = {
      ...buildMetrics(),
      fittedBeatCount: 119,
      runtimeHeadExtrapolatedLineCount: 1,
      runtimeTailExtrapolatedLineCount: 0
    }
    const parsed = readDynamicGridOutcome({
      ...buildSuccessOutcome(),
      metrics: withExtrapolation
    })
    expect(parsed?.status).toBe('dynamic')
    if (parsed?.status !== 'dynamic') return
    expect(parsed.metrics.runtimeHeadExtrapolatedLineCount).toBe(1)
    expect(parsed.metrics.runtimeTailExtrapolatedLineCount).toBe(0)

    const brokenSum = {
      ...buildMetrics(),
      runtimeHeadExtrapolatedLineCount: 1,
      runtimeTailExtrapolatedLineCount: 1
    }
    expect(readDynamicGridOutcome({ ...buildSuccessOutcome(), metrics: brokenSum })).toBeUndefined()
  })

  it('rejects a clip count that disagrees with the map', () => {
    const metrics = { ...buildMetrics(), clipCount: 3 }
    expect(readDynamicGridOutcome({ ...buildSuccessOutcome(), metrics })).toBeUndefined()
  })

  it('rejects a fixed outcome that claims multiple clips', () => {
    expect(readDynamicGridOutcome({ ...buildSuccessOutcome(), status: 'fixed' })).toBeUndefined()
    const singleClipMap = createSongBeatGridMapV2FromClips(
      [{ startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 }],
      'analysis',
      { allowSingleClip: true }
    )!
    expect(
      readDynamicGridOutcome({
        status: 'fixed',
        coordinate: 'audio',
        beatGridMap: singleClipMap,
        durationAudioSec: 60,
        policyVersion: 'p1',
        metrics: { ...buildMetrics(), clipCount: 2 }
      })
    ).toBeUndefined()
  })

  it('rejects a success outcome in timeline coordinates or with foreign source', () => {
    expect(
      readDynamicGridOutcome({ ...buildSuccessOutcome(), coordinate: 'timeline' })
    ).toBeUndefined()
    const manualMap = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 },
        { startSec: 30, anchorSec: 30, bpm: 124, downbeatBeatOffset: 0 }
      ],
      'manual',
      { allowSingleClip: true }
    )!
    expect(
      readDynamicGridOutcome({ ...buildSuccessOutcome(), beatGridMap: manualMap })
    ).toBeUndefined()
  })

  it('keeps failure outcomes but normalizes empty reasons', () => {
    expect(readDynamicGridOutcome({ status: 'unresolved', reason: '  ' })).toEqual({
      status: 'unresolved',
      reason: 'unknown'
    })
  })
})

describe('readAnalysisGridMode', () => {
  it('reads only explicit modes', () => {
    expect(readAnalysisGridMode({ analysisGridMode: 'dynamic' })).toBe('dynamic')
    expect(readAnalysisGridMode({ analysisGridMode: 'normal' })).toBe('normal')
    expect(readAnalysisGridMode({})).toBeUndefined()
    expect(readAnalysisGridMode(null)).toBeUndefined()
  })
})

describe('structured clone boundary strictness', () => {
  it('keeps an explicit null pid as the real process-exit signal', () => {
    expect(readDynamicGridSidecarPid({ sidecarPid: null })).toBeNull()
  })

  it('accepts only positive integer numbers as a pid', () => {
    expect(readDynamicGridSidecarPid({ sidecarPid: 4242 })).toBe(4242)
    const invalidPids: unknown[] = [
      true,
      '4242',
      1.5,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      {},
      []
    ]
    for (const pid of invalidPids) {
      expect(readDynamicGridSidecarPid({ sidecarPid: pid })).toBeUndefined()
    }
    expect(readDynamicGridSidecarPid({})).toBeUndefined()
    expect(readDynamicGridSidecarPid(null)).toBeUndefined()
  })

  it('rejects non-number duration values instead of coercing them', () => {
    const invalidDurations: unknown[] = ['60', true, null, Number.NaN, Number.POSITIVE_INFINITY]
    for (const durationAudioSec of invalidDurations) {
      expect(readDynamicGridOutcome({ ...buildSuccessOutcome(), durationAudioSec })).toBeUndefined()
    }
  })

  it('rejects non-number metrics values instead of coercing them', () => {
    const invalidValues: unknown[] = [null, '0', false, Number.NaN, Number.POSITIVE_INFINITY]
    for (const invalid of invalidValues) {
      expect(
        readDynamicGridOutcome({
          ...buildSuccessOutcome(),
          metrics: { ...buildMetrics(), windowCount: invalid }
        })
      ).toBeUndefined()
    }
  })

  it('still accepts the real numeric fixture', () => {
    const parsed = readDynamicGridOutcome(buildSuccessOutcome())
    expect(parsed?.status).toBe('dynamic')
  })
})
