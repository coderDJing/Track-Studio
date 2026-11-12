import { describe, expect, it } from 'vitest'
import {
  analyzeDynamicBeatGridEvidence,
  createDynamicBeatGridWindowPlan
} from './dynamicBeatGridAnalysis'
import { createSongBeatGridRuntimeV2 } from './songBeatGridMapV2'
import {
  DYNAMIC_BEAT_GRID_POLICY_VERSION,
  type DynamicBeatGridWindowPlanEntry
} from './dynamicBeatGridTypes'
import type { DynamicGridSuccessOutcome } from './dynamicBeatGridTypes'

type TruthSegment = {
  endSec: number
  bpm: number
  phaseShiftSec?: number
}

type BeatEntry = {
  timeSec: number
  ordinal: number
}

type EvidenceOptions = {
  forceNoBeats?: boolean
  omitDownbeats?: boolean
  dropEvery?: number
  addExtraEvery?: number
  shiftWindow?: { index: number; shiftSec: number }
  halfTempoWindowParity?: 0 | 1
}

const roundSec = (value: number) => Number(value.toFixed(9))

const buildTruthBeats = (segments: readonly TruthSegment[], durationSec: number): BeatEntry[] => {
  const entries: BeatEntry[] = []
  let timeSec = 0
  let ordinal = 0
  for (const segment of segments) {
    if (segment.phaseShiftSec) timeSec += segment.phaseShiftSec
    const intervalSec = 60 / segment.bpm
    while (timeSec < segment.endSec - 1e-9) {
      if (timeSec >= 0 && timeSec < durationSec - 1e-9) {
        entries.push({ timeSec: roundSec(timeSec), ordinal })
        ordinal += 1
      }
      timeSec += intervalSec
    }
  }
  return entries
}

const buildPeriodBeats = (
  durationSec: number,
  periodSec: (timeSec: number, ordinal: number) => number,
  startSec = 0.2
): BeatEntry[] => {
  const entries: BeatEntry[] = []
  let timeSec = startSec
  let ordinal = 0
  while (timeSec < durationSec - 1e-9) {
    entries.push({ timeSec: roundSec(timeSec), ordinal })
    timeSec += periodSec(timeSec, ordinal)
    ordinal += 1
  }
  return entries
}

const buildEvidence = (
  entries: readonly BeatEntry[],
  plan: readonly DynamicBeatGridWindowPlanEntry[],
  options: EvidenceOptions = {}
) => {
  return plan.map((window, windowIndex) => {
    if (options.forceNoBeats) {
      return {
        windowId: window.windowId,
        startAudioSec: window.startAudioSec,
        analyzedDurationSec: window.durationSec,
        status: 'no-beats' as const,
        beatsAudioSec: [],
        downbeatsAudioSec: []
      }
    }
    const shiftSec = options.shiftWindow?.index === windowIndex ? options.shiftWindow.shiftSec : 0
    const inWindow = entries.filter((entry) => {
      const timeSec = entry.timeSec + shiftSec
      return (
        timeSec >= window.startAudioSec - 1e-9 &&
        timeSec < window.startAudioSec + window.durationSec - 1e-9
      )
    })
    const filtered = inWindow.filter((entry) => {
      if (options.dropEvery && entry.ordinal % options.dropEvery === 0) {
        return false
      }
      if (
        options.halfTempoWindowParity !== undefined &&
        windowIndex % 2 === options.halfTempoWindowParity &&
        entry.ordinal % 2 !== 0
      ) {
        return false
      }
      return true
    })
    const beats: number[] = filtered.map((entry) => roundSec(entry.timeSec + shiftSec))
    if (options.addExtraEvery) {
      const intervalSec = 60 / 120
      for (const entry of filtered) {
        if (entry.ordinal % options.addExtraEvery !== 0) continue
        const extraSec = roundSec(entry.timeSec + shiftSec + intervalSec / 2)
        if (
          extraSec < window.startAudioSec + window.durationSec - 1e-9 &&
          extraSec > window.startAudioSec - 1e-9 &&
          !beats.includes(extraSec)
        ) {
          beats.push(extraSec)
        }
      }
    }
    beats.sort((left, right) => left - right)
    const downbeats = options.omitDownbeats
      ? []
      : filtered
          .filter((entry) => entry.ordinal % 4 === 0)
          .map((entry) => roundSec(entry.timeSec + shiftSec))
          .filter((timeSec) => beats.includes(timeSec))
    return {
      windowId: window.windowId,
      startAudioSec: window.startAudioSec,
      analyzedDurationSec: window.durationSec,
      status: beats.length ? ('ok' as const) : ('no-beats' as const),
      beatsAudioSec: beats,
      downbeatsAudioSec: downbeats
    }
  })
}

const analyze = (
  segments: readonly TruthSegment[],
  durationSec: number,
  options: EvidenceOptions = {},
  bpmRange: { minBpm?: number; maxBpm?: number } = {}
) => {
  const entries = buildTruthBeats(segments, durationSec)
  const plan = createDynamicBeatGridWindowPlan(durationSec)
  const windows = buildEvidence(entries, plan, options)
  return analyzeDynamicBeatGridEvidence({
    windows,
    durationAudioSec: durationSec,
    ...bpmRange
  })
}

const analyzeEntries = (
  entries: readonly BeatEntry[],
  durationSec: number,
  options: EvidenceOptions = {},
  bpmRange: { minBpm?: number; maxBpm?: number } = {}
) => {
  const plan = createDynamicBeatGridWindowPlan(durationSec)
  const windows = buildEvidence(entries, plan, options)
  return analyzeDynamicBeatGridEvidence({
    windows,
    durationAudioSec: durationSec,
    ...bpmRange
  })
}

const expectSuccess = (outcome: ReturnType<typeof analyze>): DynamicGridSuccessOutcome => {
  if (outcome.status !== 'fixed' && outcome.status !== 'dynamic') {
    const reason = 'reason' in outcome ? outcome.reason : 'unknown'
    throw new Error(`expected success outcome, got ${outcome.status}: ${reason}`)
  }
  return outcome
}

describe('createDynamicBeatGridWindowPlan', () => {
  it('uses 30s windows and 15s steps for a whole song', () => {
    const plan = createDynamicBeatGridWindowPlan(120)
    expect(plan.map((window) => window.startAudioSec)).toEqual([0, 15, 30, 45, 60, 75, 90])
    expect(plan.every((window) => window.durationSec === 30)).toBe(true)
    expect(new Set(plan.map((window) => window.windowId)).size).toBe(plan.length)
  })

  it('covers the exact tail with a grid-aligned tail window', () => {
    const plan = createDynamicBeatGridWindowPlan(68)
    expect(plan.map((window) => window.startAudioSec)).toEqual([0, 15, 30, 45])
    expect(plan[plan.length - 1]).toMatchObject({ startAudioSec: 45, durationSec: 23 })
    expect(plan[plan.length - 1].startAudioSec % 15).toBe(0)
    expect(plan[plan.length - 1].durationSec).toBeGreaterThanOrEqual(8)
    expect(plan[plan.length - 1].startAudioSec + plan[plan.length - 1].durationSec).toBeCloseTo(
      68,
      6
    )
  })

  it('returns one bounded window for short-but-supported audio and none below the inference floor', () => {
    expect(createDynamicBeatGridWindowPlan(20)).toEqual([
      { windowId: 'dynamic-window-0', startAudioSec: 0, durationSec: 20 }
    ])
    expect(createDynamicBeatGridWindowPlan(7.9)).toEqual([])
    expect(createDynamicBeatGridWindowPlan(Number.NaN)).toEqual([])
  })

  it('never produces duplicate starts and keeps every window inside its 120s/15s block capacity', () => {
    const plan = createDynamicBeatGridWindowPlan(305)
    const starts = plan.map((window) => window.startAudioSec)
    expect(new Set(starts).size).toBe(starts.length)
    for (const window of plan) {
      expect(window.startAudioSec % 15).toBeCloseTo(0, 6)
      expect(window.durationSec).toBeGreaterThanOrEqual(8)
      expect(window.durationSec).toBeLessThanOrEqual(30)
      const blockStart = Math.floor(window.startAudioSec / 105) * 105
      expect(window.startAudioSec).toBeGreaterThanOrEqual(blockStart)
      expect(window.startAudioSec + window.durationSec).toBeLessThanOrEqual(blockStart + 120 + 1e-6)
    }
  })
})

describe('analyzeDynamicBeatGridEvidence', () => {
  it('accepts a stable whole-song grid as one fixed clip before trying segmentation', () => {
    const outcome = analyze([{ endSec: 180, bpm: 120 }], 180)
    const success = expectSuccess(outcome)
    expect(success.status).toBe('fixed')
    expect(success.coordinate).toBe('audio')
    expect(success.policyVersion).toBe(DYNAMIC_BEAT_GRID_POLICY_VERSION)
    expect(success.durationAudioSec).toBe(180)
    expect(success.beatGridMap.clips).toHaveLength(1)
    expect(success.beatGridMap.clips[0].bpm).toBeCloseTo(120, 3)
    expect(success.metrics.scannedCoverageRatio).toBeCloseTo(1, 6)
    expect(success.metrics.beatEvidenceSpanRatio).toBeGreaterThan(0.98)
    expect(success.metrics.residualP95Ms).toBeLessThan(1)
    expect(success.metrics.overlapMatchRate).toBe(1)
    expect(success.metrics.downbeatConflictCount).toBe(0)
  })

  it('keeps one runtime line per real beat across a speed-up seam', () => {
    const durationSec = 240
    const entries = buildPeriodBeats(durationSec, (timeSec) =>
      timeSec < 60 ? 0.5 : timeSec < 150 ? 60 / 140 : 0.6
    )
    const outcome = analyzeEntries(entries, durationSec)
    const success = expectSuccess(outcome)
    expect(success.status).toBe('dynamic')
    expect(entries).toHaveLength(480)
    const runtime = createSongBeatGridRuntimeV2(success.beatGridMap, durationSec)
    expect(runtime).not.toBeNull()
    if (!runtime) return
    expect(runtime.lines).toHaveLength(entries.length)
    expect(success.metrics.runtimeLineCount).toBe(entries.length)
    expect(success.metrics.runtimeUnmatchedLineCount).toBe(0)
    expect(success.metrics.runtimeUnmatchedEvidenceCount).toBe(0)
    expect(success.metrics.runtimeBoundaryMismatchCount).toBe(0)
    const seamDeltas = runtime.lines.flatMap((line, index) =>
      index > 0 && line.clipIndex !== runtime.lines[index - 1].clipIndex
        ? [line.sec - runtime.lines[index - 1].sec]
        : []
    )
    expect(seamDeltas).toHaveLength(2)
    expect(Math.min(...seamDeltas)).toBeGreaterThan(0.4)
  })

  it('keeps one runtime line per real beat across a forward phase reset', () => {
    const durationSec = 180
    const entries = buildPeriodBeats(durationSec, (_timeSec, ordinal) =>
      ordinal === 120 ? 0.58 : 0.5
    )
    const outcome = analyzeEntries(entries, durationSec)
    const success = expectSuccess(outcome)
    expect(success.status).toBe('dynamic')
    expect(entries).toHaveLength(360)
    const runtime = createSongBeatGridRuntimeV2(success.beatGridMap, durationSec)
    expect(runtime).not.toBeNull()
    if (!runtime) return
    expect(runtime.lines).toHaveLength(entries.length)
    expect(success.metrics.runtimeLineCount).toBe(entries.length)
    expect(success.metrics.runtimeUnmatchedLineCount).toBe(0)
    const seamDeltas = runtime.lines.flatMap((line, index) =>
      index > 0 && line.clipIndex !== runtime.lines[index - 1].clipIndex
        ? [line.sec - runtime.lines[index - 1].sec]
        : []
    )
    expect(seamDeltas).toHaveLength(1)
    expect(seamDeltas[0]).toBeCloseTo(0.58, 3)
  })

  it('returns unresolved when no downbeat evidence exists instead of inventing phase zero', () => {
    const entries = buildPeriodBeats(180, () => 0.5)
    const outcome = analyzeEntries(entries, 180, { omitDownbeats: true })
    expect(outcome.status).toBe('unresolved')
    if (outcome.status === 'unresolved') {
      expect(outcome.reason).toMatch(/downbeat/)
    }
  })

  it('returns unresolved for a local bar-phase reset instead of using one global phase', () => {
    const durationSec = 180
    const entries = buildPeriodBeats(durationSec, () => 0.5)
    const plan = createDynamicBeatGridWindowPlan(durationSec)
    const windows = buildEvidence(entries, plan).map((window) => {
      const inWindow = entries.filter(
        (entry) =>
          entry.timeSec >= window.startAudioSec &&
          entry.timeSec < window.startAudioSec + window.analyzedDurationSec
      )
      const downbeatsAudioSec = inWindow
        .filter((entry) => (entry.timeSec < 90 ? entry.ordinal % 4 === 0 : entry.ordinal % 4 === 1))
        .map((entry) => entry.timeSec)
      return { ...window, downbeatsAudioSec }
    })
    const outcome = analyzeDynamicBeatGridEvidence({
      windows,
      durationAudioSec: durationSec
    })
    expect(outcome.status).toBe('unresolved')
    if (outcome.status === 'unresolved') {
      expect(outcome.reason).toMatch(/downbeat-phase-conflict/)
    }
  })

  it('accepts a stable grid with small deterministic jitter and still matches every beat', () => {
    const durationSec = 180
    const entries = buildPeriodBeats(durationSec, () => 0.5).map((entry) => ({
      timeSec: roundSec(entry.timeSec + (((entry.ordinal * 37) % 11) - 5) * 0.001),
      ordinal: entry.ordinal
    }))
    const outcome = analyzeEntries(entries, durationSec)
    const success = expectSuccess(outcome)
    expect(success.status).toBe('fixed')
    expect(success.metrics.residualP95Ms).toBeLessThan(10)
    expect(success.metrics.runtimeLineCount).toBe(entries.length)
    expect(success.metrics.runtimeUnmatchedEvidenceCount).toBe(0)
  })

  it('handles a tempo cut between downbeats without adding or dropping a line', () => {
    const durationSec = 137.3
    const entries = buildPeriodBeats(durationSec, (_timeSec, ordinal) =>
      ordinal < 37 ? 0.5 : 0.55
    )
    const outcome = analyzeEntries(entries, durationSec)
    const success = expectSuccess(outcome)
    expect(success.status).toBe('dynamic')
    expect(success.beatGridMap.clips).toHaveLength(2)
    expect(success.beatGridMap.clips[1].anchorSec).toBeGreaterThan(entries[36].timeSec)
    expect(success.beatGridMap.clips[1].anchorSec).toBeLessThanOrEqual(entries[38].timeSec)
    expect(success.metrics.runtimeLineCount).toBe(entries.length)
    expect(success.metrics.runtimeBoundaryMismatchCount).toBe(0)
    const runtime = createSongBeatGridRuntimeV2(success.beatGridMap, durationSec)
    expect(runtime).not.toBeNull()
    if (!runtime) return
    const seamDeltas = runtime.lines.flatMap((line, index) =>
      index > 0 && line.clipIndex !== runtime.lines[index - 1].clipIndex
        ? [line.sec - runtime.lines[index - 1].sec]
        : []
    )
    expect(seamDeltas).toHaveLength(1)
    expect([0.5, 0.55]).toContain(Number(seamDeltas[0].toFixed(3)))
  })

  it('uses the minimum feasible segment count for a valid 16-beat middle run', () => {
    const outcome = analyze(
      [
        { endSec: 30, bpm: 120 },
        { endSec: 36, bpm: 160 },
        { endSec: 120, bpm: 120 }
      ],
      120
    )
    const success = expectSuccess(outcome)
    expect(success.status).toBe('dynamic')
    expect(success.beatGridMap.clips).toHaveLength(3)
    expect(success.metrics.clipCount).toBe(3)
  })

  it('splits a three-step tempo song into three clips', () => {
    const outcome = analyze(
      [
        { endSec: 60, bpm: 120 },
        { endSec: 120, bpm: 128 },
        { endSec: 180, bpm: 126 }
      ],
      180
    )
    const success = expectSuccess(outcome)
    expect(success.status).toBe('dynamic')
    expect(success.beatGridMap.clips).toHaveLength(3)
    const bpms = success.beatGridMap.clips.map((clip) => clip.bpm)
    expect(bpms[0]).toBeCloseTo(120, 2)
    expect(bpms[1]).toBeCloseTo(128, 2)
    expect(bpms[2]).toBeCloseTo(126, 2)
    expect(success.beatGridMap.clips[1].anchorSec).toBeCloseTo(60, 3)
    expect(success.beatGridMap.clips[2].anchorSec).toBeCloseTo(120, 3)
    expect(success.beatGridMap.clips[1].startSec).toBeGreaterThan(59.5)
    expect(success.beatGridMap.clips[1].startSec).toBeLessThan(60)
    expect(success.metrics.seamBoundaryErrorMaxMs).toBeLessThan(5)
  })

  it('approximates continuous drift with bounded residual and multiple clips', () => {
    const durationSec = 240
    const bpmStart = 110
    const bpmEnd = 130
    const entries: BeatEntry[] = []
    let timeSec = 0
    for (let ordinal = 0; timeSec < durationSec - 1e-9; ordinal += 1) {
      const progress = Math.min(1, timeSec / durationSec)
      const bpm = bpmStart + (bpmEnd - bpmStart) * progress
      entries.push({ timeSec: roundSec(timeSec), ordinal })
      timeSec += 60 / bpm
    }
    const plan = createDynamicBeatGridWindowPlan(durationSec)
    const windows = buildEvidence(entries, plan)
    const outcome = analyzeDynamicBeatGridEvidence({ windows, durationAudioSec: durationSec })
    const success = expectSuccess(outcome)
    expect(success.status).toBe('dynamic')
    expect(success.beatGridMap.clips.length).toBeGreaterThan(1)
    expect(success.beatGridMap.clips.length).toBeLessThanOrEqual(128)
    expect(success.metrics.residualP95Ms).toBeLessThanOrEqual(15)
    expect(success.metrics.residualMaxMs).toBeLessThanOrEqual(40)
  })

  it('detects a tiny long-horizon tempo step that a single fit would hide', () => {
    const outcome = analyze(
      [
        { endSec: 150, bpm: 120 },
        { endSec: 449.750207, bpm: 120.1 }
      ],
      449.750207
    )
    const success = expectSuccess(outcome)
    expect(success.status).toBe('dynamic')
    expect(success.beatGridMap.clips).toHaveLength(2)
    expect(success.beatGridMap.clips[1].bpm).toBeCloseTo(120.1, 2)
    expect(success.metrics.residualMaxMs).toBeLessThan(5)
  })

  it('handles a phase reset without pretending it is a tempo change', () => {
    const outcome = analyze(
      [
        { endSec: 150, bpm: 120 },
        { endSec: 300.2, bpm: 120, phaseShiftSec: 0.2 }
      ],
      300.2
    )
    const success = expectSuccess(outcome)
    expect(success.status).toBe('dynamic')
    expect(success.beatGridMap.clips).toHaveLength(2)
    expect(success.beatGridMap.clips[0].bpm).toBeCloseTo(120, 3)
    expect(success.beatGridMap.clips[1].bpm).toBeCloseTo(120, 3)
    expect(success.beatGridMap.clips[1].anchorSec).toBeCloseTo(150.2, 3)
    expect(success.beatGridMap.clips[1].startSec).toBeGreaterThan(149.5)
    expect(success.beatGridMap.clips[1].startSec).toBeLessThan(150.2)
  })

  it('rejects a misaligned window instead of silently shifting the whole grid', () => {
    const outcome = analyze([{ endSec: 180, bpm: 120 }], 180, {
      shiftWindow: { index: 3, shiftSec: 0.15 }
    })
    expect(outcome.status).toBe('unresolved')
    if (outcome.status === 'unresolved') {
      expect(outcome.reason).toMatch(/overlap|gap|ambig|seam/)
    }
  })

  it('reports inferred missing beats and still fits the underlying fixed grid', () => {
    const outcome = analyze([{ endSec: 180, bpm: 120 }], 180, { dropEvery: 10 })
    const success = expectSuccess(outcome)
    expect(success.status).toBe('fixed')
    expect(success.metrics.inferredMissingBeatCount).toBeGreaterThan(10)
    expect(success.metrics.residualP95Ms).toBeLessThan(1)
  })

  it('does not turn extra beats into a normal grid', () => {
    const outcome = analyze([{ endSec: 180, bpm: 120 }], 180, { addExtraEvery: 20 })
    expect(outcome.status).toBe('unresolved')
  })

  it('refuses to resolve an octave ambiguity by guessing', () => {
    const outcome = analyze([{ endSec: 180, bpm: 120 }], 180, {
      halfTempoWindowParity: 1
    })
    expect(outcome.status).toBe('unresolved')
    if (outcome.status === 'unresolved') {
      expect(outcome.reason).toMatch(/octave|overlap|gap|ambig|seam/)
    }
  })

  it('covers a short tail window and reports a small tail error', () => {
    const outcome = analyze([{ endSec: 68, bpm: 120 }], 68)
    const success = expectSuccess(outcome)
    expect(success.status).toBe('fixed')
    expect(success.metrics.scannedCoverageRatio).toBeCloseTo(1, 6)
    expect(success.metrics.tailErrorMs).toBeLessThan(2)
  })

  it('returns unresolved for explicit no-beat evidence and for missing windows', () => {
    const noBeats = analyze([{ endSec: 120, bpm: 120 }], 120, { forceNoBeats: true })
    expect(noBeats.status).toBe('unresolved')
    const noWindows = analyzeDynamicBeatGridEvidence({ windows: [], durationAudioSec: 120 })
    expect(noWindows.status).toBe('unresolved')
  })

  it('returns unsupported for audio shorter than the inference floor', () => {
    const outcome = analyzeDynamicBeatGridEvidence({ windows: [], durationAudioSec: 7 })
    expect(outcome.status).toBe('unsupported')
  })

  it('refuses to represent a real change that only lasts fewer than the minimum segment beats', () => {
    const durationSec = 104.285714
    const outcome = analyze(
      [
        { endSec: 50, bpm: 120 },
        { endSec: 54.285714, bpm: 140 },
        { endSec: durationSec, bpm: 120 }
      ],
      durationSec
    )
    expect(outcome.status).toBe('unresolved')
  })

  it('rejects evidence beyond the resource limits', () => {
    const windowLimited = analyzeDynamicBeatGridEvidence({
      windows: Array.from({ length: 513 }, (_, index) => ({
        windowId: `limit-${index}`,
        startAudioSec: index * 0.001,
        analyzedDurationSec: 30,
        status: 'no-beats' as const,
        beatsAudioSec: [],
        downbeatsAudioSec: []
      })),
      durationAudioSec: 1000
    })
    expect(windowLimited.status).toBe('unsupported')

    const observationLimited = analyzeDynamicBeatGridEvidence({
      windows: Array.from({ length: 400 }, (_, index) => ({
        windowId: `obs-${index}`,
        startAudioSec: index * 15,
        analyzedDurationSec: 30,
        status: 'ok' as const,
        beatsAudioSec: Array.from(
          { length: 60 },
          (_unused, beatIndex) => index * 15 + beatIndex * 0.5
        ),
        downbeatsAudioSec: Array.from(
          { length: 15 },
          (_unused, beatIndex) => index * 15 + beatIndex * 2
        )
      })),
      durationAudioSec: 7000
    })
    expect(observationLimited.status).toBe('unsupported')
  })

  it('rejects a merged beat count above the DP resource budget', () => {
    const outcome = analyze([{ endSec: 1100, bpm: 240 }], 1100, {}, { minBpm: 200, maxBpm: 260 })
    expect(outcome.status).toBe('unsupported')
    if (outcome.status === 'unsupported') {
      expect(outcome.reason).toMatch(/beat-limit/)
    }
  })

  it('returns unsupported instead of breaking the clip limit when 150 short tempo runs are real', () => {
    const segments: TruthSegment[] = []
    let cursorSec = 0
    for (let index = 0; index < 150; index += 1) {
      const bpm = index % 2 === 0 ? 100 : 160
      cursorSec += (20 * 60) / bpm
      segments.push({ endSec: cursorSec, bpm })
    }
    const outcome = analyze(segments, cursorSec)
    expect(outcome.status).toBe('unsupported')
    if (outcome.status === 'unsupported') {
      expect(outcome.reason).toMatch(/clip-limit/)
    }
  })
})
