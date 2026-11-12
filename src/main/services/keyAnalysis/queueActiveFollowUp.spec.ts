import { describe, expect, it } from 'vitest'
import { KeyAnalysisDeferredQueue } from './deferredQueue'
import { normalizePath, type KeyAnalysisJob } from './types'

const createActiveJob = (filePath: string, overrides: Partial<KeyAnalysisJob> = {}) => ({
  jobId: 1,
  filePath,
  normalizedPath: normalizePath(filePath),
  priority: 'low' as const,
  fastAnalysis: false,
  source: 'foreground' as const,
  includeStructure: false,
  ...overrides
})

const createHelpers = () => {
  let nextJobId = 10
  return {
    nextJobId: () => ++nextJobId,
    isHigherPriority: () => true,
    applyQueueCategory: (job: KeyAnalysisJob, category: KeyAnalysisJob['category']) => {
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
    nextGridRequestGeneration: () => ++nextJobId
  }
}

describe('KeyAnalysisDeferredQueue', () => {
  it('creates a follow-up when v23 structure is requested behind an active core-only job', () => {
    const deferredQueue = new KeyAnalysisDeferredQueue()
    const active = createActiveJob('D:/music/active.mp3')
    const options = {
      category: 'manual-batch' as const,
      includeStructure: true,
      preemptible: true
    }

    expect(deferredQueue.requiresFollowUp(active, options)).toBe(true)
    expect(deferredQueue.size).toBe(0)
  })

  it('reuses an active job that already includes v23 structure', () => {
    const deferredQueue = new KeyAnalysisDeferredQueue()
    const active = createActiveJob('D:/music/compatible.mp3', { includeStructure: true })

    expect(deferredQueue.requiresFollowUp(active, { includeStructure: true })).toBe(false)
    expect(deferredQueue.size).toBe(0)
  })

  it('serializes and preserves forced reanalysis behind a normal active job', () => {
    const deferredQueue = new KeyAnalysisDeferredQueue()
    const helpers = createHelpers()
    const active = createActiveJob('D:/music/reanalysis.mp3', { includeStructure: true })
    const options = {
      category: 'manual-batch' as const,
      includeStructure: true,
      forceAnalysis: true
    }

    expect(deferredQueue.requiresFollowUp(active, options)).toBe(true)
    deferredQueue.defer(active, 'medium', 'foreground', options, '', ['manual-force'], helpers)

    expect(deferredQueue.get(active.normalizedPath)).toMatchObject({
      forceAnalysis: true,
      category: 'manual-batch',
      includeStructure: true,
      manualBatchIds: ['manual-force']
    })
  })

  it('reuses an active job that is already forced', () => {
    const deferredQueue = new KeyAnalysisDeferredQueue()
    const active = createActiveJob('D:/music/already-forced.mp3', {
      includeStructure: true,
      forceAnalysis: true
    })

    expect(
      deferredQueue.requiresFollowUp(active, { includeStructure: true, forceAnalysis: true })
    ).toBe(false)
  })

  it('分项任务不会被未指定分项的可见队列升级成全量分析', () => {
    const deferredQueue = new KeyAnalysisDeferredQueue()
    const active = createActiveJob('D:/music/energy-only.mp3', {
      includeStructure: false,
      analysisTargets: { energy: true }
    })
    expect(
      deferredQueue.requiresFollowUp(active, {
        category: 'visible',
        includeStructure: true,
        preemptible: true
      })
    ).toBe(false)
    expect(
      deferredQueue.requiresFollowUp(active, {
        includeStructure: true
      })
    ).toBe(true)
    expect(deferredQueue.requiresFollowUp(active, { preemptible: true })).toBe(false)
  })

  it('removes a deferred manual-only follow-up when its batch is canceled', () => {
    const deferredQueue = new KeyAnalysisDeferredQueue()
    const helpers = createHelpers()
    const active = createActiveJob('D:/music/canceled.mp3')
    deferredQueue.defer(
      active,
      'medium',
      'foreground',
      { category: 'manual-batch', includeStructure: true },
      '',
      ['manual-3'],
      helpers
    )

    expect(deferredQueue.get(active.normalizedPath)?.includeStructure).toBe(true)

    deferredQueue.removeManualBatch('manual-3', helpers)

    expect(deferredQueue.has(active.normalizedPath)).toBe(false)
  })
})
