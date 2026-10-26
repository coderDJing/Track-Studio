import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { createKeyAnalysisWorkerPool } from './workerPool'
import { normalizePath, type KeyAnalysisJob } from './types'
import {
  enqueueManualKeyAnalysisBatch,
  getManualKeyAnalysisPendingFilePaths,
  keyAnalysisEvents
} from '../keyAnalysisQueue'

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

vi.mock('../../log', () => ({ log: { error: vi.fn() } }))
vi.mock('../../libraryCacheDb', () => ({}))
vi.mock('../libraryMerge/mutationGate', () => ({ isLibraryMergeMutationLocked: () => false }))
// 此测试使用真实 worker 生命周期和手动批次结算；不启动扫描、解码和调度线程。
vi.mock('./queue', () => ({
  KeyAnalysisQueue: class {
    enqueueList = vi.fn()
    setGlobalConcurrency = vi.fn()
    hasTrackedPath = () => true
  }
}))

type PoolDeps = Parameters<typeof createKeyAnalysisWorkerPool>[0]

const createHarness = (events = new EventEmitter()) => {
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
    persistence: {
      persistKey: vi.fn<PoolDeps['persistence']['persistKey']>(),
      persistBpm: vi.fn<PoolDeps['persistence']['persistBpm']>(),
      persistNoBpm: vi.fn<PoolDeps['persistence']['persistNoBpm']>(),
      persistEnergy: vi.fn<PoolDeps['persistence']['persistEnergy']>(),
      persistWaveform: vi.fn<PoolDeps['persistence']['persistWaveform']>(),
      persistSongStructure: vi.fn<PoolDeps['persistence']['persistSongStructure']>(),
      prepareJob: vi.fn<PoolDeps['persistence']['prepareJob']>(),
      removeCoverCacheForMissingTrack:
        vi.fn<PoolDeps['persistence']['removeCoverCacheForMissingTrack']>()
    },
    background: {
      cancelBackgroundWork: vi.fn(),
      clearBackgroundTimer: vi.fn(),
      emitBackgroundStatus: vi.fn(),
      getBackgroundStatusSnapshot: vi.fn<PoolDeps['background']['getBackgroundStatusSnapshot']>(),
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
  const progress = vi.fn()
  deps.events.on('analysis-stage-update', progress)
  const begin = (jobId: number) => {
    const worker = deps.idle[0] ?? pool.createWorker()
    if (!deps.workers.includes(worker)) deps.workers.push(worker)
    deps.idle.splice(deps.idle.indexOf(worker), 1)
    const filePath = `D:/music/track-${jobId}.wav`
    const job: KeyAnalysisJob = {
      jobId,
      filePath,
      normalizedPath: normalizePath(filePath),
      priority: 'medium',
      source: 'foreground',
      fastAnalysis: false,
      manualBatchIds: ['manual-seven'],
      trace: { lastStage: 'analyze-start', elapsedMs: 20 }
    }
    deps.busy.set(worker, jobId)
    deps.inFlight.set(jobId, job)
    deps.activeByPath.set(job.normalizedPath, job)
    return { worker, job }
  }
  return { deps, pool, progress, begin }
}

describe('analysis worker lifecycle', () => {
  it('settles all seven timed-out tracks and releases their progress and batch ownership', () => {
    const { deps, begin, progress } = createHarness(keyAnalysisEvents)
    const batchProgress = vi.fn()
    const batchEnd = vi.fn()
    keyAnalysisEvents.on('manual-batch-progress', batchProgress)
    keyAnalysisEvents.on('manual-batch-end', batchEnd)
    const { batchId } = enqueueManualKeyAnalysisBatch(
      Array.from({ length: 7 }, (_, index) => `D:/music/track-${index + 1}.wav`)
    )
    expect(batchProgress).toHaveBeenLastCalledWith(expect.objectContaining({ now: 0, total: 7 }))
    for (let id = 1; id <= 7; id++) {
      // 每次使用退出后补建的空闲 worker，模拟同一批任务逐首失败。
      const { worker, job } = begin(id)
      job.manualBatchIds = [batchId]
      job.trace = { ...job.trace, timedOutAt: Date.now() }
      deps.markExpectedWorkerTermination(worker, 'timeout')
      worker.emit('exit', 1)
      expect(progress).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filePath: job.filePath,
          stage: 'job-error',
          manualBatchIds: [batchId]
        })
      )
      expect(deps.activeByPath.has(job.normalizedPath)).toBe(false)
      expect(deps.inFlight.has(id)).toBe(false)
      expect(deps.workers).toHaveLength(1)
      expect(batchProgress).toHaveBeenLastCalledWith(expect.objectContaining({ now: id, total: 7 }))
      expect(getManualKeyAnalysisPendingFilePaths()).toHaveLength(7 - id)
    }
    expect(progress).toHaveBeenCalledTimes(7)
    expect(deps.onJobFailure).not.toHaveBeenCalled() // 超时已由队列登记，不能重复计失败。
    expect(batchEnd).toHaveBeenCalledWith(expect.objectContaining({ batchId, canceled: false }))
    keyAnalysisEvents.off('manual-batch-progress', batchProgress)
    keyAnalysisEvents.off('manual-batch-end', batchEnd)
    keyAnalysisEvents.off('analysis-stage-update', progress)
  })

  it('cleans up an error followed by exit once, without multiplying replacement workers', () => {
    const { deps, begin, progress } = createHarness()
    const { worker } = begin(1)
    worker.emit('error', new Error('worker crashed'))
    worker.emit('exit', 1)
    expect(deps.workers).toHaveLength(1)
    expect(deps.idle).toHaveLength(1)
    expect(deps.inFlight.size).toBe(0)
    expect(deps.onJobFailure).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledTimes(1)
  })

  it('keeps a second active track when the first worker fails and is replaced', () => {
    const { deps, begin, progress } = createHarness()
    const first = begin(1)
    const second = begin(2)
    first.worker.emit('error', new Error('worker crashed'))
    first.worker.emit('exit', 1)
    expect(deps.workers).toHaveLength(2)
    expect(deps.busy.get(second.worker)).toBe(2)
    expect(deps.activeByPath.get(second.job.normalizedPath)).toBe(second.job)
    expect(progress).toHaveBeenCalledTimes(1)
  })

  it.each(['manual-batch-cancel', 'library-merge-cancel', 'background-cancel'])(
    'leaves explicit cancellation to its owner instead of counting it as failure (%s)',
    (reason) => {
      const { deps, begin, progress } = createHarness()
      const { worker, job } = begin(1)
      job.manualBatchIds = undefined
      deps.markExpectedWorkerTermination(worker, reason)
      worker.emit('exit', 1)
      expect(progress).not.toHaveBeenCalled()
      expect(deps.onJobFailure).not.toHaveBeenCalled()
    }
  )

  it('treats a clean exit before delivering a result as a failed job', () => {
    const { deps, begin, progress } = createHarness()
    const { worker } = begin(1)
    worker.emit('exit', 0)
    expect(deps.busy.size).toBe(0)
    expect(deps.workers).toHaveLength(1)
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'job-error' }))
  })

  it.each(['background-resume', 'lower-priority-resume'] as const)(
    'preserves batch ownership when a preempted job resumes (%s)',
    (kind) => {
      const { deps, begin, progress } = createHarness()
      const { worker, job } = begin(1)
      deps.preemptedJobs.set(job.jobId, kind)
      deps.markExpectedWorkerTermination(worker, 'preempt')
      worker.emit('exit', 1)
      expect(progress).not.toHaveBeenCalled()
      expect(deps.enqueue).toHaveBeenCalledWith(
        job.filePath,
        expect.any(String),
        expect.objectContaining({
          manualBatchIds: ['manual-seven']
        })
      )
    }
  )

  it('completes bookkeeping before terminal events can reenter the queue', () => {
    const { deps, begin } = createHarness()
    const { worker, job } = begin(1)
    deps.events.on('analysis-stage-update', () => {
      expect(deps.workers).not.toContain(worker)
      expect(deps.busy.has(worker)).toBe(false)
      expect(deps.activeByPath.has(job.normalizedPath)).toBe(false)
      expect(deps.inFlight.has(job.jobId)).toBe(false)
    })
    worker.emit('exit', 1)
  })

  it('does not replenish or retain a worker already removed by concurrency downscaling', () => {
    const { deps, pool, progress } = createHarness()
    const worker = pool.createWorker()
    deps.idle.splice(0)
    deps.markExpectedWorkerTermination(worker, 'concurrency-downscale')
    worker.emit('exit', 1)
    expect(deps.workers).toHaveLength(0)
    expect(deps.hasExpectedWorkerTermination(worker)).toBe(false)
    expect(progress).not.toHaveBeenCalled()
  })
})
