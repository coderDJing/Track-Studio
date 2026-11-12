import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizePath, type KeyAnalysisJob, type KeyAnalysisProgress } from './types'

const mocks = vi.hoisted(() => ({
  stat: vi.fn(async () => ({ size: 999, mtimeMs: 999 }))
}))

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Worker: class extends EventEmitter {
      threadId = 1
      postMessage = vi.fn()
      terminate = vi.fn(async () => {
        this.emit('exit', 1)
        return 1
      })
    }
  }
})

vi.mock('../../log', () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}))
vi.mock('node:fs/promises', () => ({ default: { stat: mocks.stat } }))

import { createKeyAnalysisWorkerPool } from './workerPool'

type PoolDeps = Parameters<typeof createKeyAnalysisWorkerPool>[0]
type StageEvent = KeyAnalysisProgress & { filePath: string; manualBatchIds?: string[] }

const createHarness = (options?: { isCurrentGridRequest?: (job: KeyAnalysisJob) => boolean }) => {
  const events = new EventEmitter()
  const stageEvents: StageEvent[] = []
  events.on('analysis-stage-update', (payload: StageEvent) => stageEvents.push(payload))
  const expected = new Map<Worker, string>()
  const deps: PoolDeps = {
    workers: [],
    idle: [],
    busy: new Map(),
    inFlight: new Map(),
    activeByPath: new Map(),
    preemptedJobs: new Map(),
    retiringWorkers: new Set(),
    getGlobalConcurrencyLimit: () => 2,
    getForegroundWorker: () => null,
    setForegroundWorker: vi.fn(),
    markExpectedWorkerTermination: (worker, reason) => {
      expected.set(worker, reason)
    },
    clearExpectedWorkerTermination: (worker) => {
      expected.delete(worker)
    },
    hasExpectedWorkerTermination: (worker) => expected.has(worker),
    consumeExpectedWorkerTermination: (worker) => {
      const reason = expected.get(worker) ?? null
      expected.delete(worker)
      return reason
    },
    isCurrentGridRequest: (job) => options?.isCurrentGridRequest?.(job) ?? true,
    persistence: {
      persistKey: vi.fn(),
      persistBpm: vi.fn(),
      persistNoBpm: vi.fn(),
      persistEnergy: vi.fn(),
      persistWaveform: vi.fn(),
      persistSongStructure: vi.fn(),
      prepareJob: vi.fn(),
      removeCoverCacheForMissingTrack: vi.fn()
    },
    background: {
      cancelBackgroundWork: vi.fn(),
      clearBackgroundTimer: vi.fn(),
      emitBackgroundStatus: vi.fn(),
      getBackgroundStatusSnapshot: vi.fn(),
      isEnabled: () => false,
      canUseAggressiveConcurrency: () => false,
      markProcessing: vi.fn(),
      scheduleBackgroundScan: vi.fn(),
      startBackgroundSweep: vi.fn(),
      touchForeground: vi.fn(),
      unmarkProcessing: vi.fn()
    },
    enqueue: vi.fn(),
    onJobProgress: vi.fn(),
    onJobFailure: vi.fn(),
    onJobSuccess: vi.fn(),
    drain: vi.fn(),
    events
  }
  const pool = createKeyAnalysisWorkerPool(deps)
  const worker = pool.createWorker()
  deps.workers.push(worker)

  const startJob = (overrides: Partial<KeyAnalysisJob> = {}): KeyAnalysisJob => {
    const filePath = overrides.filePath ?? 'D:/music/dynamic.mp3'
    const job: KeyAnalysisJob = {
      jobId: 1,
      filePath,
      normalizedPath: normalizePath(filePath),
      priority: 'medium',
      source: 'foreground',
      fastAnalysis: false,
      needsBpm: true,
      manualBatchIds: ['batch-1'],
      fileSize: 1,
      fileMtimeMs: 1,
      ...overrides
    }
    deps.busy.set(worker, job.jobId)
    deps.inFlight.set(job.jobId, job)
    deps.activeByPath.set(job.normalizedPath, job)
    const idleIndex = deps.idle.indexOf(worker)
    if (idleIndex !== -1) deps.idle.splice(idleIndex, 1)
    return job
  }

  const sendProgress = async (
    job: KeyAnalysisJob,
    progress: KeyAnalysisProgress
  ): Promise<void> => {
    ;(worker as unknown as EventEmitter).emit('message', { jobId: job.jobId, progress })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const sendResult = async (job: KeyAnalysisJob, result: Record<string, unknown>) => {
    ;(worker as unknown as EventEmitter).emit('message', { jobId: job.jobId, result })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  return { deps, pool, worker, stageEvents, startJob, sendProgress, sendResult }
}

describe('worker pool dynamic progress publishing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('publishes only the public dynamic grid contract without sidecarPid', async () => {
    const harness = createHarness()
    const job = harness.startJob()

    for (const phase of ['scan', 'refine', 'fit', 'persist'] as const) {
      await harness.sendProgress(job, {
        stage: 'analyze-start',
        elapsedMs: 0,
        dynamicGrid: {
          phase,
          completedWindows: 2,
          totalWindows: 4,
          coveredAudioSec: 30,
          sidecarPid: 4242
        }
      })
    }

    const dynamicEvents = harness.stageEvents.filter((event) => event.dynamicGrid)
    expect(dynamicEvents.map((event) => event.dynamicGrid?.phase)).toEqual([
      'scan',
      'refine',
      'fit',
      'persist'
    ])
    for (const event of dynamicEvents) {
      expect(event.dynamicGrid).toEqual({
        phase: event.dynamicGrid?.phase,
        completedWindows: 2,
        totalWindows: 4,
        coveredAudioSec: 30
      })
      expect(Object.prototype.hasOwnProperty.call(event.dynamicGrid, 'sidecarPid')).toBe(false)
    }
  })

  it('keeps the legacy payload shape for normal analysis progress', async () => {
    const harness = createHarness()
    const job = harness.startJob()

    await harness.sendProgress(job, { stage: 'analyze-start', elapsedMs: 0, detail: 'beat-this' })

    const [event] = harness.stageEvents
    expect(event).toMatchObject({ stage: 'analyze-start', filePath: job.filePath })
    expect(Object.prototype.hasOwnProperty.call(event, 'dynamicGrid')).toBe(false)
  })

  it('does not leak sidecarPid through the internal progress hook payload', async () => {
    const harness = createHarness()
    const job = harness.startJob()

    await harness.sendProgress(job, {
      stage: 'analyze-start',
      elapsedMs: 0,
      dynamicGrid: { phase: 'scan', sidecarPid: 4242 }
    })

    // 主进程内部仍可拿到 PID（用于清理），但不进入 renderer 事件。
    expect(harness.deps.onJobProgress).toHaveBeenCalledWith(
      harness.worker,
      job,
      expect.objectContaining({ dynamicGrid: expect.objectContaining({ sidecarPid: 4242 }) })
    )
    const event = harness.stageEvents[harness.stageEvents.length - 1]
    expect(JSON.stringify(event)).not.toContain('sidecarPid')
  })
})

describe('worker pool discarded result settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('settles the old job UI and manual batch when the audio identity changed', async () => {
    const harness = createHarness()
    const job = harness.startJob()

    await harness.sendResult(job, { bpm: 120, firstBeatMs: 0 })

    expect(harness.deps.persistence.persistBpm).not.toHaveBeenCalled()
    expect(harness.deps.onJobSuccess).not.toHaveBeenCalled()
    const terminal = harness.stageEvents[harness.stageEvents.length - 1]
    expect(terminal).toMatchObject({
      filePath: job.filePath,
      stage: 'job-error',
      manualBatchIds: ['batch-1']
    })
    expect(terminal.stage).not.toBe('job-done')
  })

  it('settles when a newer grid request superseded the running job', async () => {
    const harness = createHarness({ isCurrentGridRequest: () => false })
    // 该用例只验证代次失效：不提供音频身份，避免与身份校验混在一起。
    const job = harness.startJob({
      fileSize: undefined,
      fileMtimeMs: undefined,
      gridRequestGeneration: 7
    })

    await harness.sendResult(job, { bpm: 120, firstBeatMs: 0 })

    expect(harness.deps.persistence.persistBpm).not.toHaveBeenCalled()
    expect(harness.deps.onJobSuccess).not.toHaveBeenCalled()
    expect(harness.stageEvents.some((event) => event.stage === 'job-done')).toBe(false)
    expect(harness.stageEvents[harness.stageEvents.length - 1]).toMatchObject({
      stage: 'job-error',
      manualBatchIds: ['batch-1']
    })
  })
})
