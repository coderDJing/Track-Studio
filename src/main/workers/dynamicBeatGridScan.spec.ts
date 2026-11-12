import { describe, expect, it } from 'vitest'
import {
  DYNAMIC_BEAT_GRID_POLICY_VERSION,
  type DynamicBeatWindowEvidence
} from '../../shared/dynamicBeatGridTypes'
import { createDynamicBeatGridWindowPlan } from '../../shared/dynamicBeatGridAnalysis'
import type { BeatThisWindowSession, BeatWindowAnalyzeParams } from './beatThisAnalyzer'
import {
  DynamicGridScanError,
  planCoarseBeatWindows,
  planDecodeChunks,
  planRefinedBeatWindows,
  scanDynamicBeatGrid,
  type DynamicGridDecodedPcm,
  type DynamicGridDecodeRequest,
  type DynamicGridScanCoverage
} from './dynamicBeatGridScanner'

type AnalyzeCall = BeatWindowAnalyzeParams & { evidence: DynamicBeatWindowEvidence[] }

const buildEvidence = (params: BeatWindowAnalyzeParams): DynamicBeatWindowEvidence[] =>
  params.windows.map((window) => {
    const startAudioSec = Number((params.chunkStartAudioSec + window.localStartSec).toFixed(6))
    return {
      windowId: window.windowId,
      startAudioSec,
      analyzedDurationSec: window.durationSec,
      status: 'ok',
      beatsAudioSec: [
        Number((startAudioSec + 0.5).toFixed(6)),
        Number((startAudioSec + 1.5).toFixed(6))
      ],
      downbeatsAudioSec: []
    }
  })

const createFakeSession = (options: {
  calls: AnalyzeCall[]
  overrideEvidence?: (
    params: BeatWindowAnalyzeParams,
    evidence: DynamicBeatWindowEvidence[]
  ) => DynamicBeatWindowEvidence[]
}) => {
  let closed = false
  const session: BeatThisWindowSession = {
    pid: 4242,
    async analyzeWindows(params) {
      const evidence = options.overrideEvidence
        ? options.overrideEvidence(params, buildEvidence(params))
        : buildEvidence(params)
      options.calls.push({ ...params, evidence })
      return evidence
    },
    async close() {
      closed = true
    }
  }
  return {
    session,
    isClosed: () => closed
  }
}

const decodeFrames = (
  request: DynamicGridDecodeRequest,
  durationSec = request.maxDurationSec
): DynamicGridDecodedPcm => {
  const frames = Math.floor(durationSec * request.sampleRate)
  return {
    pcmData: Buffer.alloc(frames * request.channels * 4),
    sampleRate: request.sampleRate,
    channels: request.channels,
    totalFrames: frames,
    actualStartSec: request.startSec
  }
}

const scan = (
  overrides: Partial<Parameters<typeof scanDynamicBeatGrid>[0]> & {
    calls?: AnalyzeCall[]
    decodeCalls?: DynamicGridDecodeRequest[]
    overrideEvidence?: (
      params: BeatWindowAnalyzeParams,
      evidence: DynamicBeatWindowEvidence[]
    ) => DynamicBeatWindowEvidence[]
    decodedFactory?: (request: DynamicGridDecodeRequest) => DynamicGridDecodedPcm
    now?: () => number
  } = {}
) => {
  const calls = overrides.calls ?? []
  const decodeCalls = overrides.decodeCalls ?? []
  const fake = createFakeSession({
    calls,
    overrideEvidence: overrides.overrideEvidence
  })
  const run = scanDynamicBeatGrid({
    filePath: 'fixture.wav',
    durationAudioSec: 300,
    sampleRate: 8000,
    channels: 1,
    ...overrides,
    deps: {
      createSession: () => fake.session,
      now: overrides.now,
      decodeChunk: (request) => {
        decodeCalls.push(request)
        return overrides.decodedFactory ? overrides.decodedFactory(request) : decodeFrames(request)
      }
    }
  })
  return { run, calls, decodeCalls, fake }
}

describe('dynamic grid window planning', () => {
  it('plans absolute coarse windows with 30s length and 15s step', () => {
    const windows = planCoarseBeatWindows(100)

    expect(windows.slice(0, 3)).toEqual([
      { windowId: 'dynamic-window-0', startAudioSec: 0, durationSec: 30, source: 'coarse' },
      { windowId: 'dynamic-window-1', startAudioSec: 15, durationSec: 30, source: 'coarse' },
      { windowId: 'dynamic-window-2', startAudioSec: 30, durationSec: 30, source: 'coarse' }
    ])
    const last = windows[windows.length - 1]
    expect(last.startAudioSec + last.durationSec).toBeCloseTo(100, 6)
    expect(windows.every((window) => window.durationSec >= 8)).toBe(true)
  })

  it('reuses task A window plan without adding an extra tail window', () => {
    expect(createDynamicBeatGridWindowPlan(300).map((entry) => entry.startAudioSec)).toEqual(
      planCoarseBeatWindows(300).map((window) => window.startAudioSec)
    )
    expect(planCoarseBeatWindows(300)).toHaveLength(19)
    expect(planCoarseBeatWindows(68).at(-1)).toMatchObject({
      startAudioSec: 45,
      durationSec: 23
    })
  })

  it('merges a short tail into the previous window instead of keeping a sub-8s window', () => {
    const windows = planCoarseBeatWindows(35)
    expect(windows.map((window) => [window.startAudioSec, window.durationSec])).toEqual([
      [0, 30],
      [15, 20]
    ])
  })

  it('rejects tracks shorter than the inference floor', () => {
    expect(() => planCoarseBeatWindows(7.5)).toThrowError(DynamicGridScanError)
    try {
      planCoarseBeatWindows(7.5)
    } catch (error) {
      expect((error as DynamicGridScanError).code).toBe('unsupported-short-duration')
    }
  })

  it('plans 10s refined windows around a local region with context', () => {
    const windows = planRefinedBeatWindows([{ startAudioSec: 120, endAudioSec: 130 }], 300)

    expect(windows.map((window) => window.startAudioSec)).toEqual([115, 120, 125])
    expect(windows.every((window) => window.source === 'refined')).toBe(true)
    expect(windows.every((window) => window.durationSec >= 8)).toBe(true)
  })

  it('groups 30s windows into <=120s chunks so each window is inferred once', () => {
    const windows = planCoarseBeatWindows(300)
    const chunks = planDecodeChunks(300, windows)

    expect(chunks.map((chunk) => chunk.startAudioSec)).toEqual([0, 105, 210])
    expect(chunks.every((chunk) => chunk.durationSec <= 120)).toBe(true)
    const plannedIds = chunks.flatMap((chunk) => chunk.windows.map((window) => window.windowId))
    expect(plannedIds.sort()).toEqual(windows.map((window) => window.windowId).sort())
  })

  it('keeps at least 15s block overlap for dense refined windows', () => {
    const refined = planRefinedBeatWindows([{ startAudioSec: 0, endAudioSec: 200 }], 300)
    const chunks = planDecodeChunks(300, refined)

    expect(chunks.length).toBeGreaterThan(1)
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index].startAudioSec - chunks[index - 1].startAudioSec).toBeLessThanOrEqual(105)
    }
    const plannedIds = chunks.flatMap((chunk) => chunk.windows.map((window) => window.windowId))
    expect(new Set(plannedIds).size).toBe(refined.length)
  })
})

describe('dynamic grid scan orchestration', () => {
  it('decodes bounded chunks, analyzes every window once and keeps absolute offsets', async () => {
    const { run, calls, decodeCalls, fake } = scan()

    const result = await run

    expect(decodeCalls.map((call) => call.startSec)).toEqual([0, 105, 210])
    expect(decodeCalls.every((call) => call.maxDurationSec <= 120)).toBe(true)
    expect(decodeCalls.every((call) => call.startSec + call.maxDurationSec <= 300 + 1e-6)).toBe(
      true
    )
    expect(fake.isClosed()).toBe(true)
    expect(result.windows).toHaveLength(planCoarseBeatWindows(300).length)

    const analyzedIds = calls.flatMap((call) => call.windows.map((window) => window.windowId))
    expect(new Set(analyzedIds).size).toBe(analyzedIds.length)
    expect(analyzedIds.sort()).toEqual(
      planCoarseBeatWindows(300)
        .map((window) => window.windowId)
        .sort()
    )
    expect(result.windows[0]).toMatchObject({ windowId: 'dynamic-window-0', startAudioSec: 0 })
    expect(result.windows[1]).toMatchObject({ windowId: 'dynamic-window-1', startAudioSec: 15 })
    expect(result.windows[1].beatsAudioSec[0]).toBeCloseTo(15.5, 6)
    expect(result.coverage.gaps).toEqual([])
    expect(result.scanScope).toBe('full')
    expect(result.coverage.scope).toBe('full')
    expect(result.coverage.analyzedRanges).toEqual([{ startAudioSec: 0, endAudioSec: 300 }])
    expect(result.chunkBoundaries).toHaveLength(3)
    expect(result.runtime).toEqual({ sidecarPid: null })
    expect(result.policyVersion).toBe(`${DYNAMIC_BEAT_GRID_POLICY_VERSION}:scan-v1`)
  })

  it('passes PCM to the session once per decoded chunk and never puts PCM in the result', async () => {
    const { run, calls, decodeCalls } = scan()
    const result = await run

    expect(decodeCalls).toHaveLength(3)
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(Buffer.isBuffer(call.pcmData)).toBe(true)
      expect(call.pcmData.byteLength).toBeGreaterThan(0)
    }
    expect(result).not.toHaveProperty('pcmData')
    expect(JSON.stringify(result)).not.toContain('pcmData')
  })

  it('runs local 10s refinement windows after the coarse scan', async () => {
    const { run, calls } = scan({
      refineRegions: [{ startAudioSec: 120, endAudioSec: 130 }]
    })

    const result = await run
    const refinedCalls = calls.filter((call) =>
      call.windows.some((window) => window.windowId.startsWith('r'))
    )

    expect(refinedCalls.length).toBeGreaterThan(0)
    expect(result.coverage.refinedWindows).toBe(3)
    expect(result.windows.filter((window) => window.windowId.startsWith('r'))).toHaveLength(3)
  })

  it('onlyRefine decodes and analyzes just the refined windows', async () => {
    const { run, calls, decodeCalls } = scan({
      onlyRefine: true,
      refineRegions: [{ startAudioSec: 120, endAudioSec: 130 }]
    })

    const result = await run

    expect(decodeCalls).toHaveLength(1)
    expect(decodeCalls[0].startSec).toBe(115)
    expect(
      calls.every((call) => call.windows.every((window) => window.windowId.startsWith('r')))
    ).toBe(true)
    expect(result.windows).toHaveLength(3)
    expect(result.scanScope).toBe('refine-only')
    expect(result.coverage.scope).toBe('refine-only')
    expect(result.coverage.coarseWindows).toBe(0)
    expect(result.coverage.refinedWindows).toBe(3)
    expect(result.coverage.analyzedRanges).toEqual([{ startAudioSec: 115, endAudioSec: 135 }])
    expect(result.coverage.gaps.length).toBeGreaterThan(0)
  })

  it('onlyRefine without regions fails instead of silently scanning the whole track', async () => {
    const { run } = scan({ onlyRefine: true })
    await expect(run).rejects.toMatchObject({ code: 'invalid-plan' })
  })

  it('forwards the early sidecar PID callback to the session factory', async () => {
    const events: Array<number | null> = []
    let receivedCallback = false
    const fake = createFakeSession({ calls: [] })

    await scanDynamicBeatGrid({
      filePath: 'fixture.wav',
      durationAudioSec: 300,
      sampleRate: 8000,
      channels: 1,
      onSidecarChange: (pid) => events.push(pid),
      deps: {
        createSession: (options) => {
          receivedCallback = typeof options?.onProcessChange === 'function'
          options?.onProcessChange?.(4242)
          return fake.session
        },
        decodeChunk: decodeFrames
      }
    })

    expect(receivedCallback).toBe(true)
    expect(events).toEqual([4242])
  })

  it('rejects a truncated decode instead of shrinking windows', async () => {
    const { run } = scan({
      decodedFactory: (request) =>
        decodeFrames(request, request.startSec === 0 ? 60 : request.maxDurationSec)
    })

    await expect(run).rejects.toMatchObject({ code: 'decode-truncated' })
  })

  it('rejects a decode that does not report its actual audible start', async () => {
    const { run } = scan({
      decodedFactory: (request) => {
        const decoded = decodeFrames(request)
        delete decoded.actualStartSec
        return decoded
      }
    })

    await expect(run).rejects.toMatchObject({ code: 'decode-inconsistent' })
  })

  it('rejects a decode whose actual start violates the audible-origin contract', async () => {
    const { run } = scan({
      decodedFactory: (request) => ({
        ...decodeFrames(request),
        actualStartSec: request.startSec - 0.05
      })
    })

    await expect(run).rejects.toMatchObject({ code: 'decode-range-mismatch' })
  })

  it('rejects a session response whose absolute offset was applied twice', async () => {
    const { run } = scan({
      overrideEvidence: (_params, evidence) =>
        evidence.map((item) => ({ ...item, startAudioSec: item.startAudioSec + 5 }))
    })

    await expect(run).rejects.toMatchObject({ code: 'evidence-mismatch' })
  })

  it('surfaces no-beats windows as explicit no-evidence ranges', async () => {
    const { run } = scan({
      overrideEvidence: (_params, evidence) =>
        evidence.map((item) =>
          item.windowId === 'dynamic-window-0'
            ? { ...item, status: 'no-beats' as const, beatsAudioSec: [] }
            : item
        )
    })

    const result = await run
    expect(result.coverage.noBeatsWindows).toBe(1)
    expect(result.coverage.noBeatsRanges[0]).toMatchObject({
      windowId: 'dynamic-window-0'
    })
  })

  it('cancels between chunks, closes the owned session and rejects late work', async () => {
    const controller = new AbortController()
    let decodedChunks = 0
    const { run, decodeCalls, fake } = scan({
      signal: controller.signal,
      decodedFactory: (request) => {
        decodedChunks += 1
        if (decodedChunks === 2) controller.abort()
        return decodeFrames(request)
      }
    })

    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    expect(decodeCalls).toHaveLength(2)
    expect(fake.isClosed()).toBe(true)
  })

  it('enforces the absolute total deadline between chunks', async () => {
    let clockMs = 0
    const { run, decodeCalls, fake } = scan({
      maxTotalMs: 1_000,
      now: () => clockMs,
      decodedFactory: (request) => {
        clockMs += 2_000
        return decodeFrames(request)
      }
    })

    await expect(run).rejects.toMatchObject({ code: 'timeout' })
    expect(decodeCalls).toHaveLength(1)
    expect(fake.isClosed()).toBe(true)
  })

  it('enforces the no-progress budget across chunk completions', async () => {
    let clockMs = 0
    const { run } = scan({
      maxNoProgressMs: 100,
      now: () => clockMs,
      onProgress: () => {
        clockMs += 500
      }
    })

    await expect(run).rejects.toMatchObject({ code: 'timeout' })
  })

  it('does not create a sidecar session when cancelled before scanning', async () => {
    const controller = new AbortController()
    controller.abort()
    let sessionCount = 0
    let decodeCount = 0

    await expect(
      scanDynamicBeatGrid({
        filePath: 'fixture.wav',
        durationAudioSec: 300,
        sampleRate: 8000,
        channels: 1,
        signal: controller.signal,
        deps: {
          createSession: () => {
            sessionCount += 1
            throw new Error('must not create a session')
          },
          decodeChunk: () => {
            decodeCount += 1
            throw new Error('must not decode')
          }
        }
      })
    ).rejects.toMatchObject({ code: 'cancelled' })

    expect(sessionCount).toBe(0)
    expect(decodeCount).toBe(0)
  })

  it('reports coverage progress without claiming 100% before completion', async () => {
    const progress: Array<{ phase: string; completed: number; total: number }> = []
    const { run } = scan({
      onProgress: (item) =>
        progress.push({
          phase: item.phase,
          completed: item.completedWindows,
          total: item.totalWindows
        })
    })

    await run

    const totalWindows = progress[0].total
    expect(progress.length).toBeGreaterThan(1)
    expect(progress[0].completed).toBeLessThan(totalWindows)
    expect(progress[progress.length - 1]).toEqual({
      phase: 'complete',
      completed: totalWindows,
      total: totalWindows
    })
  })
})

describe('dynamic grid coverage typing', () => {
  it('reports the verified audible-origin decode basis without promising sample accuracy', () => {
    const timing: DynamicGridScanCoverage['timing'] = {
      decodeApi: 'decodeAudioFileNativePcm',
      decodeStartBasis: 'audible-origin-verified',
      sampleAccurateSeek: false,
      seekAlignmentToleranceSec: 0.005,
      chunkSec: 120,
      chunkOverlapSec: 15,
      coarseWindowSec: 30,
      coarseStepSec: 15,
      refineWindowSec: 10,
      refineStepSec: 5
    }
    expect(timing.decodeStartBasis).toBe('audible-origin-verified')
    expect(timing.sampleAccurateSeek).toBe(false)
  })
})
