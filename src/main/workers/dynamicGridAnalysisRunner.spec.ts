import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { DynamicBeatWindowEvidence } from '../../shared/dynamicBeatGridTypes'
import type { DynamicGridScanProgress } from './dynamicBeatGridScanner'

const mocks = vi.hoisted(() => {
  class FakeScanError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.name = 'DynamicGridScanError'
      this.code = code
    }
  }
  return {
    scanDynamicBeatGrid: vi.fn(),
    analyzeDynamicBeatGridEvidence: vi.fn(),
    probeDynamicGridAudioDuration: vi.fn(),
    FakeScanError
  }
})

vi.mock('./dynamicBeatGridScanner', () => ({
  scanDynamicBeatGrid: mocks.scanDynamicBeatGrid,
  probeDynamicGridAudioDuration: mocks.probeDynamicGridAudioDuration,
  DynamicGridScanError: mocks.FakeScanError
}))

vi.mock('../../shared/dynamicBeatGridAnalysis', () => ({
  analyzeDynamicBeatGridEvidence: mocks.analyzeDynamicBeatGridEvidence
}))

import {
  planDynamicGridRefineRegions,
  runDynamicBeatGridAnalysis
} from './dynamicGridAnalysisRunner'

const DURATION = 180

const buildWindow = (
  windowId: string,
  startAudioSec: number,
  durationSec: number,
  beatsAudioSec: number[],
  status: 'ok' | 'no-beats' = 'ok'
): DynamicBeatWindowEvidence => ({
  windowId,
  startAudioSec,
  analyzedDurationSec: durationSec,
  status,
  beatsAudioSec,
  downbeatsAudioSec: []
})

const buildBeats = (startSec: number, durationSec: number, intervalSec: number) => {
  const beats: number[] = []
  for (let sec = startSec; sec < startSec + durationSec; sec += intervalSec) {
    beats.push(Number(sec.toFixed(4)))
  }
  return beats
}

const buildScanResult = (params: {
  windows: DynamicBeatWindowEvidence[]
  gaps?: Array<{ startAudioSec: number; endAudioSec: number }>
  durationAudioSec?: number
  sidecarPid?: number | null
}) => ({
  windows: params.windows,
  coverage: {
    durationAudioSec: params.durationAudioSec ?? DURATION,
    coarseWindows: params.windows.filter((window) => window.windowId.startsWith('c')).length,
    refinedWindows: params.windows.filter((window) => window.windowId.startsWith('r')).length,
    analyzedWindows: params.windows.length,
    noBeatsWindows: params.windows.filter((window) => window.status === 'no-beats').length,
    decodedAudioSec: DURATION,
    gaps: params.gaps ?? [],
    noBeatsRanges: [],
    timing: {
      decodeApi: 'decodeAudioFileNativePcm' as const,
      decodeStartBasis: 'audible-origin-verified' as const,
      sampleAccurateSeek: false as const,
      chunkSec: 120,
      chunkOverlapSec: 15,
      coarseWindowSec: 30,
      coarseStepSec: 15,
      refineWindowSec: 10,
      refineStepSec: 5
    }
  },
  chunkBoundaries: [],
  policyVersion: 'test-scan',
  runtime: { sidecarPid: params.sidecarPid ?? 4242 }
})

const fixedOutcome = {
  status: 'fixed' as const,
  coordinate: 'audio' as const,
  beatGridMap: {
    version: 2 as const,
    source: 'analysis' as const,
    clips: [{ startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 }],
    signature: 'sbgm_test'
  },
  durationAudioSec: DURATION,
  policyVersion: 'test-policy',
  metrics: {}
}

describe('planDynamicGridRefineRegions', () => {
  it('targets local tempo jumps instead of rescanning the whole track', () => {
    const windows = [
      buildWindow('c0000', 0, 30, buildBeats(0, 30, 0.5)),
      buildWindow('c0001', 15, 30, buildBeats(15, 30, 0.42))
    ]
    const regions = planDynamicGridRefineRegions({ windows, durationAudioSec: DURATION })
    expect(regions).toHaveLength(1)
    expect(regions[0].startAudioSec).toBe(0)
    expect(regions[0].endAudioSec).toBe(45)
  })

  it('targets the boundary between beat and no-beat windows', () => {
    const windows = [
      buildWindow('c0000', 0, 30, buildBeats(0, 30, 0.5)),
      buildWindow('c0001', 30, 30, [], 'no-beats')
    ]
    const regions = planDynamicGridRefineRegions({ windows, durationAudioSec: DURATION })
    expect(regions).toHaveLength(1)
    expect(regions[0].startAudioSec).toBe(0)
    expect(regions[0].endAudioSec).toBe(60)
  })

  it('merges overlapping regions and enforces the budget', () => {
    const windows = [
      buildWindow('c0000', 0, 30, buildBeats(0, 30, 0.5)),
      buildWindow('c0001', 15, 30, buildBeats(15, 30, 0.4)),
      buildWindow('c0002', 30, 30, buildBeats(30, 30, 0.3))
    ]
    const regions = planDynamicGridRefineRegions({
      windows,
      durationAudioSec: DURATION,
      maxRegions: 1
    })
    expect(regions).toHaveLength(1)
  })
})

describe('runDynamicBeatGridAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.probeDynamicGridAudioDuration.mockRejectedValue(new Error('probe unavailable'))
  })

  it('probes the duration and fails closed when the probe is unavailable', async () => {
    const outcome = await runDynamicBeatGridAnalysis({ filePath: 'a.mp3' })
    expect(outcome).toEqual({ status: 'unsupported', reason: 'audio-duration-unavailable' })
    expect(mocks.probeDynamicGridAudioDuration).toHaveBeenCalledTimes(1)
    expect(mocks.scanDynamicBeatGrid).not.toHaveBeenCalled()
  })

  it('uses the probed duration when the job did not carry one', async () => {
    mocks.probeDynamicGridAudioDuration.mockResolvedValue(DURATION)
    mocks.scanDynamicBeatGrid.mockResolvedValue(
      buildScanResult({ windows: [buildWindow('c0000', 0, 30, buildBeats(0, 30, 0.5))] })
    )
    mocks.analyzeDynamicBeatGridEvidence.mockReturnValue(fixedOutcome)

    const outcome = await runDynamicBeatGridAnalysis({ filePath: 'a.mp3' })

    expect(outcome).toBe(fixedOutcome)
    expect(mocks.scanDynamicBeatGrid).toHaveBeenCalledWith(
      expect.objectContaining({ durationAudioSec: DURATION })
    )
  })

  it('rejects coverage whose duration disagrees with the probed duration', async () => {
    mocks.scanDynamicBeatGrid.mockResolvedValue(
      buildScanResult({
        windows: [buildWindow('c0000', 0, 30, buildBeats(0, 30, 0.5))],
        durationAudioSec: DURATION - 5
      })
    )
    const outcome = await runDynamicBeatGridAnalysis({
      filePath: 'a.mp3',
      durationAudioSec: DURATION
    })
    expect(outcome).toEqual({ status: 'error', reason: 'coverage-duration-mismatch' })
    expect(mocks.analyzeDynamicBeatGridEvidence).not.toHaveBeenCalled()
  })

  it('treats uncovered audio as unresolved instead of fitting partial evidence', async () => {
    mocks.scanDynamicBeatGrid.mockResolvedValue(
      buildScanResult({
        windows: [buildWindow('c0000', 0, 30, buildBeats(0, 30, 0.5))],
        gaps: [{ startAudioSec: 30, endAudioSec: DURATION }]
      })
    )
    const outcome = await runDynamicBeatGridAnalysis({
      filePath: 'a.mp3',
      durationAudioSec: DURATION
    })
    expect(outcome.status).toBe('unresolved')
    expect(mocks.analyzeDynamicBeatGridEvidence).not.toHaveBeenCalled()
  })

  it('runs a budgeted refine pass and keeps coarse evidence', async () => {
    const coarse = buildScanResult({
      windows: [
        buildWindow('c0000', 0, 30, buildBeats(0, 30, 0.5)),
        buildWindow('c0001', 15, 30, buildBeats(15, 30, 0.4))
      ]
    })
    const refineWindows: DynamicBeatWindowEvidence[] = []
    for (let index = 0; index < 8; index += 1) {
      refineWindows.push(
        buildWindow(`r0-00${index}`, index * 5, 10, buildBeats(index * 5, 10, 0.45))
      )
    }
    const refined = buildScanResult({ windows: refineWindows })
    mocks.scanDynamicBeatGrid
      .mockResolvedValueOnce(coarse)
      .mockImplementationOnce(
        async (options: {
          onSidecarChange: (pid: number | null) => void
          onProgress: (progress: DynamicGridScanProgress) => void
        }) => {
          options.onSidecarChange(5151)
          options.onProgress({
            phase: 'refine',
            completedWindows: 1,
            totalWindows: 8,
            coveredAudioSec: 10
          })
          return refined
        }
      )
    mocks.analyzeDynamicBeatGridEvidence
      .mockReturnValueOnce({ status: 'unresolved', reason: 'seam-conflict' })
      .mockReturnValueOnce(fixedOutcome)
    const progress: Array<{ phase: string; sidecarPid?: number | null }> = []

    const outcome = await runDynamicBeatGridAnalysis({
      filePath: 'a.mp3',
      durationAudioSec: DURATION,
      onProgress: (update) => progress.push({ phase: update.phase, sidecarPid: update.sidecarPid })
    })

    expect(outcome).toBe(fixedOutcome)
    expect(mocks.scanDynamicBeatGrid).toHaveBeenCalledTimes(2)
    const refineCall = mocks.scanDynamicBeatGrid.mock.calls[1][0] as {
      refineRegions?: Array<{ startAudioSec: number; endAudioSec: number }>
      onlyRefine?: boolean
    }
    expect(refineCall.refineRegions?.length).toBeGreaterThan(0)
    expect(refineCall.onlyRefine).toBe(true)
    const fittedWindows = mocks.analyzeDynamicBeatGridEvidence.mock.calls[1][0] as {
      windows: DynamicBeatWindowEvidence[]
    }
    const ids = fittedWindows.windows.map((window) => window.windowId)
    expect(ids).toContain('c0000')
    expect(ids).toContain('c0001')
    expect(ids.some((id) => id.startsWith('r0-'))).toBe(true)
    expect(progress.some((update) => update.phase === 'refine')).toBe(true)
    expect(progress.some((update) => update.sidecarPid === 5151)).toBe(true)
  })

  it('rejects a refine pass that leaves a requested region uncovered', async () => {
    const coarse = buildScanResult({
      windows: [
        buildWindow('c0000', 0, 30, buildBeats(0, 30, 0.5)),
        buildWindow('c0001', 15, 30, buildBeats(15, 30, 0.4))
      ]
    })
    const refined = buildScanResult({
      windows: [buildWindow('r0-000', 0, 10, buildBeats(0, 10, 0.45))]
    })
    mocks.scanDynamicBeatGrid.mockResolvedValueOnce(coarse).mockResolvedValueOnce(refined)
    mocks.analyzeDynamicBeatGridEvidence.mockReturnValue({
      status: 'unresolved',
      reason: 'seam-conflict'
    })

    const outcome = await runDynamicBeatGridAnalysis({
      filePath: 'a.mp3',
      durationAudioSec: DURATION
    })

    if (outcome.status !== 'unresolved') {
      throw new Error(`expected unresolved, received ${outcome.status}`)
    }
    expect(outcome.reason).toMatch(/refine-region-uncovered/)
  })

  it('does not resurrect a sidecar pid from the scan summary after the close callback', async () => {
    mocks.scanDynamicBeatGrid.mockImplementation(
      async (options: {
        onSidecarChange: (pid: number | null) => void
        onProgress: (progress: {
          phase: 'scan' | 'refine' | 'complete'
          completedWindows: number
          totalWindows: number
          coveredAudioSec: number
          sidecarPid?: number | null
        }) => void
      }) => {
        // onSidecarChange 是唯一生命周期真相：spawn 上报 PID，真实退出上报 null。
        options.onSidecarChange(4242)
        options.onProgress({
          phase: 'scan',
          completedWindows: 1,
          totalWindows: 2,
          coveredAudioSec: 30,
          sidecarPid: 4242
        })
        options.onSidecarChange(null)
        // close 之后的进度与 summary 仍可能残留旧 PID，均不得重新登记。
        options.onProgress({
          phase: 'complete',
          completedWindows: 2,
          totalWindows: 2,
          coveredAudioSec: 60,
          sidecarPid: 4242
        })
        return buildScanResult({
          windows: [buildWindow('c0000', 0, 30, buildBeats(0, 30, 0.5))],
          sidecarPid: 4242
        })
      }
    )
    mocks.analyzeDynamicBeatGridEvidence.mockReturnValue(fixedOutcome)
    const pidReports: Array<number | null | undefined> = []

    const outcome = await runDynamicBeatGridAnalysis({
      filePath: 'a.mp3',
      durationAudioSec: DURATION,
      onProgress: (update) => {
        if (update.sidecarPid !== undefined) pidReports.push(update.sidecarPid)
      }
    })

    expect(outcome).toBe(fixedOutcome)
    // 真实不变量：close(null) 之后不能再出现任何正 PID，最后一次生命周期为 null。
    const closeIndex = pidReports.indexOf(null)
    expect(closeIndex).toBeGreaterThanOrEqual(0)
    expect(pidReports.slice(closeIndex).every((pid) => pid === null)).toBe(true)
    expect(pidReports[pidReports.length - 1]).toBeNull()
    expect(pidReports.some((pid) => pid === 4242)).toBe(true)
  })

  it('forwards the abort signal to the scanner', async () => {
    const controller = new AbortController()
    mocks.scanDynamicBeatGrid.mockResolvedValue(
      buildScanResult({ windows: [buildWindow('c0000', 0, 30, buildBeats(0, 30, 0.5))] })
    )
    mocks.analyzeDynamicBeatGridEvidence.mockReturnValue(fixedOutcome)

    await runDynamicBeatGridAnalysis({
      filePath: 'a.mp3',
      durationAudioSec: DURATION,
      signal: controller.signal
    })

    expect(mocks.scanDynamicBeatGrid).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal })
    )
  })

  it('maps cancellation to cancelled instead of a generic error', async () => {
    mocks.scanDynamicBeatGrid.mockRejectedValue(
      new mocks.FakeScanError('cancelled', 'dynamic grid scan was cancelled')
    )
    const outcome = await runDynamicBeatGridAnalysis({
      filePath: 'a.mp3',
      durationAudioSec: DURATION
    })
    expect(outcome.status).toBe('cancelled')
  })

  it('maps decode failures to error and short tracks to unsupported', async () => {
    mocks.scanDynamicBeatGrid.mockRejectedValueOnce(new mocks.FakeScanError('decode-failed', 'bad'))
    const decodeError = await runDynamicBeatGridAnalysis({
      filePath: 'a.mp3',
      durationAudioSec: DURATION
    })
    expect(decodeError).toEqual({ status: 'error', reason: 'decode-failed: bad' })

    mocks.scanDynamicBeatGrid.mockRejectedValueOnce(
      new mocks.FakeScanError('unsupported-short-duration', 'too short')
    )
    const shortTrack = await runDynamicBeatGridAnalysis({
      filePath: 'a.mp3',
      durationAudioSec: DURATION
    })
    expect(shortTrack.status).toBe('unsupported')
  })
})
