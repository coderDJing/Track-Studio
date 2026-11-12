import { describe, expect, it } from 'vitest'
import { KeyAnalysisDeferredQueue } from './deferredQueue'
import { KeyAnalysisGridRequestTracker } from './gridRequestTracking'
import { hasCurrentKeyAnalysisJobOwnership } from './jobOwnership'
import {
  applyKeyAnalysisReRequestOptions,
  applyPendingAnalysisGridModeReRequest,
  buildKeyAnalysisGridCommitCheck,
  isCurrentKeyAnalysisGridRequestGeneration,
  narrowKeyAnalysisNeedsForDynamicGrid,
  requiresAnalysisGridModeFollowUp
} from './queueJobOptions'
import { normalizePath, type KeyAnalysisJob } from './types'

const FILE_PATH = 'D:/music/grid-mode.mp3'
const NORMALIZED_PATH = normalizePath(FILE_PATH)

const createJob = (overrides: Partial<KeyAnalysisJob> = {}): KeyAnalysisJob => ({
  jobId: 1,
  filePath: FILE_PATH,
  normalizedPath: NORMALIZED_PATH,
  priority: 'medium',
  fastAnalysis: false,
  source: 'foreground',
  category: 'manual-batch',
  includeStructure: false,
  ...overrides
})

const createDeferredHelpers = () => {
  let nextJobId = 100
  let generation = 0
  return {
    nextJobId: () => ++nextJobId,
    isHigherPriority: (next: KeyAnalysisJob['priority'], current: KeyAnalysisJob['priority']) => {
      const rank = { high: 4, medium: 3, low: 2, background: 1 }
      return rank[next] > rank[current]
    },
    applyQueueCategory: (job: KeyAnalysisJob, category?: KeyAnalysisJob['category']) => {
      if (category) job.category = category
    },
    applyWaveformOnlyOption: (job: KeyAnalysisJob, waveformOnly?: boolean) => {
      if (waveformOnly !== undefined) job.waveformOnly = waveformOnly
    },
    applyIncludeStructureOption: (job: KeyAnalysisJob, includeStructure?: boolean) => {
      if (includeStructure === true) job.includeStructure = true
    },
    applyRequestFlags: (job: KeyAnalysisJob, flags: { forceAnalysis?: boolean }) => {
      if (flags.forceAnalysis === true) job.forceAnalysis = true
    },
    addManualBatchIdsToJob: (job: KeyAnalysisJob, batchIds: string[]) => {
      job.manualBatchIds = Array.from(new Set([...(job.manualBatchIds || []), ...batchIds]))
    },
    addFocusSlotToJob: (job: KeyAnalysisJob, focusSlot?: string) => {
      if (focusSlot) job.focusSlots = Array.from(new Set([...(job.focusSlots || []), focusSlot]))
    },
    removeManualBatchIdFromJob: (job: KeyAnalysisJob, batchId: string) => {
      if (!job.manualBatchIds?.includes(batchId)) return false
      const next = job.manualBatchIds.filter((id) => id !== batchId)
      job.manualBatchIds = next.length ? next : undefined
      return true
    },
    isManualOnlyJob: (job: KeyAnalysisJob) =>
      job.category === 'manual-batch' && !job.focusSlots?.length,
    resolveGridMode: (fallback?: unknown) =>
      fallback === 'dynamic' ? ('dynamic' as const) : ('normal' as const),
    nextGridRequestGeneration: () => ++generation
  }
}

describe('analysis grid mode queue semantics', () => {
  it('updates a pending job in place when a newer explicit mode arrives', () => {
    const job = createJob({ analysisGridMode: 'normal', gridRequestGeneration: 2 })
    let generation = 2
    const replaced = applyPendingAnalysisGridModeReRequest(
      job,
      { analysisGridMode: 'dynamic', forceAnalysis: true },
      () => ++generation
    )

    expect(replaced).toBe(true)
    expect(job.analysisGridMode).toBe('dynamic')
    expect(job.gridRequestGeneration).toBe(3)

    // 非网格请求或同模式不会推进代次。
    expect(
      applyPendingAnalysisGridModeReRequest(
        job,
        { analysisGridMode: 'dynamic' },
        () => ++generation
      )
    ).toBe(false)
    expect(job.gridRequestGeneration).toBe(3)
  })

  it('keeps old waiters when a pending job switches mode', () => {
    const job = createJob({ manualBatchIds: ['batch-old'], focusSlots: ['deck-a'] })
    applyKeyAnalysisReRequestOptions(
      job,
      { analysisGridMode: 'dynamic', forceAnalysis: true, analysisTargets: { bpm: true } },
      'low',
      'background',
      ['batch-new']
    )

    expect(job.manualBatchIds).toEqual(['batch-old', 'batch-new'])
    expect(job.focusSlots).toEqual(['deck-a'])
    // 低优先级请求不能把已有等待任务降级。
    expect(job.priority).toBe('medium')
    expect(job.forceAnalysis).toBe(true)
    expect(job.analysisTargets).toEqual({
      key: false,
      bpm: true,
      waveform: false,
      energy: false,
      structure: false
    })
  })

  it('only follows up when an explicit request really recomputes the grid', () => {
    const active = createJob({ analysisGridMode: 'normal' })
    expect(
      requiresAnalysisGridModeFollowUp(active, { analysisGridMode: 'dynamic', forceAnalysis: true })
    ).toBe(true)
    expect(
      requiresAnalysisGridModeFollowUp(active, {
        analysisGridMode: 'dynamic',
        analysisTargets: { bpm: true }
      })
    ).toBe(true)
    expect(requiresAnalysisGridModeFollowUp(active, { analysisGridMode: 'dynamic' })).toBe(false)
    expect(
      requiresAnalysisGridModeFollowUp(active, {
        analysisGridMode: 'normal',
        forceAnalysis: true
      })
    ).toBe(false)
    expect(requiresAnalysisGridModeFollowUp(active, { forceAnalysis: true })).toBe(false)
  })

  it('isolates structure but keeps selected energy for dynamic grids', () => {
    const job = createJob({
      analysisGridMode: 'dynamic',
      needsKey: true,
      needsBpm: true,
      needsWaveform: true,
      needsEnergy: true,
      needsStructure: true,
      analysisTargets: { bpm: true, energy: true }
    })

    expect(narrowKeyAnalysisNeedsForDynamicGrid(job)).toBe(true)
    expect(job.needsStructure).toBe(false)
    expect(job.needsEnergy).toBe(true)
    expect(job.needsKey).toBe(false)
    expect(job.needsWaveform).toBe(false)
  })

  it('does not narrow normal jobs', () => {
    const job = createJob({ analysisGridMode: 'normal', needsBpm: true, needsEnergy: true })
    expect(narrowKeyAnalysisNeedsForDynamicGrid(job)).toBe(false)
    expect(job.needsEnergy).toBe(true)
  })

  it('keeps every allowed target for a forced full dynamic analysis', () => {
    const job = createJob({
      analysisGridMode: 'dynamic',
      forceAnalysis: true,
      needsKey: true,
      needsBpm: true,
      needsWaveform: true,
      needsEnergy: true,
      needsStructure: true
    })

    expect(narrowKeyAnalysisNeedsForDynamicGrid(job)).toBe(true)
    expect(job.needsStructure).toBe(false)
    expect({ key: job.needsKey, waveform: job.needsWaveform, energy: job.needsEnergy }).toEqual({
      key: true,
      waveform: true,
      energy: true
    })
  })

  it('tracks generations and consumes the frozen mode only for the same batch', () => {
    const tracker = new KeyAnalysisGridRequestTracker()
    const first = tracker.nextGeneration(NORMALIZED_PATH)
    tracker.rememberFrozenMode(NORMALIZED_PATH, 'dynamic', ['batch-1'])

    expect(tracker.consumeFrozenMode(NORMALIZED_PATH, ['batch-2'])).toBeUndefined()
    const second = tracker.nextGeneration(NORMALIZED_PATH)
    expect(tracker.consumeFrozenMode(NORMALIZED_PATH, ['batch-1'])).toBe('dynamic')
    // 一次性快照：不会影响之后的独立请求。
    expect(tracker.consumeFrozenMode(NORMALIZED_PATH, ['batch-1'])).toBeUndefined()

    expect(
      tracker.isCurrent({ normalizedPath: NORMALIZED_PATH, gridRequestGeneration: second })
    ).toBe(true)
    expect(
      tracker.isCurrent({ normalizedPath: NORMALIZED_PATH, gridRequestGeneration: first })
    ).toBe(false)

    tracker.forget(NORMALIZED_PATH)
    expect(tracker.getGeneration(NORMALIZED_PATH)).toBe(0)
  })

  it('reports a stable commit check for the integration layer', () => {
    expect(
      buildKeyAnalysisGridCommitCheck(
        { analysisGridMode: 'dynamic', gridRequestGeneration: 4 },
        { generation: 4 }
      )
    ).toEqual({ mode: 'dynamic', generation: 4, isCurrent: true })
    expect(isCurrentKeyAnalysisGridRequestGeneration({ gridRequestGeneration: 3 }, 4)).toBe(false)
    expect(isCurrentKeyAnalysisGridRequestGeneration({}, 4)).toBe(false)
  })

  it('keeps worker ownership independent from the grid request generation', () => {
    const job = createJob({ gridRequestGeneration: 1 })
    const state = {
      terminationExpected: false,
      busyJobId: job.jobId,
      inFlightJob: job,
      activeJob: job
    }

    expect(hasCurrentKeyAnalysisJobOwnership(job, state)).toBe(true)
    expect(buildKeyAnalysisGridCommitCheck(job, { generation: 2 }).isCurrent).toBe(false)
    // 代次失效只影响提交资格，不影响 worker 归属与正常清理。
    expect(hasCurrentKeyAnalysisJobOwnership(job, state)).toBe(true)
  })

  it('replaces the deferred mode without dropping waiters, focus slots or priority', () => {
    const queue = new KeyAnalysisDeferredQueue()
    const helpers = createDeferredHelpers()
    const active = createJob({ analysisGridMode: 'normal', includeStructure: true })

    queue.defer(
      active,
      'medium',
      'foreground',
      {
        analysisGridMode: 'dynamic',
        forceAnalysis: true,
        analysisTargets: { bpm: true, energy: true },
        includeStructure: true
      },
      'deck-a',
      ['batch-1'],
      helpers
    )
    const deferred = queue.get(active.normalizedPath)
    expect(deferred).toMatchObject({
      analysisGridMode: 'dynamic',
      priority: 'medium',
      manualBatchIds: ['batch-1'],
      focusSlots: ['deck-a'],
      forceAnalysis: true
    })
    expect(deferred?.analysisTargets).toMatchObject({ bpm: true, energy: true })

    // 第二次显式请求切回 normal：沿用同一个等待任务，等待方全部保留。
    queue.defer(
      active,
      'low',
      'background',
      { analysisGridMode: 'normal', forceAnalysis: true, analysisTargets: { bpm: true } },
      '',
      ['batch-2'],
      helpers
    )
    const merged = queue.get(active.normalizedPath)
    expect(merged).toMatchObject({
      analysisGridMode: 'normal',
      priority: 'medium',
      manualBatchIds: ['batch-1', 'batch-2'],
      focusSlots: ['deck-a'],
      forceAnalysis: true
    })
  })
})
