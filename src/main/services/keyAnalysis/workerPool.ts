import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { log } from '../../log'
import { resolveMainWorkerPath } from '../../workerPath'
import type { KeyAnalysisBackground } from './background'
import type { KeyAnalysisPersistence } from './persistence'
import type { AnalysisBpmRangePresetId } from '../../../shared/analysisBpmRange'
import { hasCurrentKeyAnalysisJobOwnership } from './jobOwnership'
import {
  isNoBpmBeatGridResultError,
  isValidBpm,
  isValidKeyText,
  type KeyAnalysisFailureReason,
  type KeyAnalysisJob,
  type KeyAnalysisPreemptionKind,
  type KeyAnalysisProgress,
  type KeyAnalysisQueueCategory,
  type KeyAnalysisPriority,
  type KeyAnalysisRequestFlags,
  type WorkerPayload
} from './types'

type KeyAnalysisWorkerPoolDeps = {
  workers: Worker[]
  idle: Worker[]
  busy: Map<Worker, number>
  inFlight: Map<number, KeyAnalysisJob>
  activeByPath: Map<string, KeyAnalysisJob>
  preemptedJobs: Map<number, KeyAnalysisPreemptionKind>
  retiringWorkers: Set<Worker>
  getGlobalConcurrencyLimit: () => number
  getForegroundWorker: () => Worker | null
  setForegroundWorker: (worker: Worker | null) => void
  markExpectedWorkerTermination: (worker: Worker, reason: string) => void
  clearExpectedWorkerTermination: (worker: Worker) => void
  hasExpectedWorkerTermination: (worker: Worker) => boolean
  consumeExpectedWorkerTermination: (worker: Worker) => string | null
  persistence: KeyAnalysisPersistence
  background: KeyAnalysisBackground
  enqueue: (
    filePath: string,
    priority: KeyAnalysisPriority,
    options?: KeyAnalysisRequestFlags & {
      urgent?: boolean
      source?: 'foreground' | 'background'
      fastAnalysis?: boolean
      preemptible?: boolean
      category?: KeyAnalysisQueueCategory
      waveformOnly?: boolean
      includeStructure?: boolean
      analysisBpmRangeId?: AnalysisBpmRangePresetId
      manualBatchIds?: string[]
    }
  ) => void
  onJobProgress: (worker: Worker, job: KeyAnalysisJob, progress: KeyAnalysisProgress) => void
  onJobFailure: (job: KeyAnalysisJob, reason: KeyAnalysisFailureReason, detail?: string) => void
  onJobSuccess: (job: KeyAnalysisJob) => void
  drain: () => void
  events: EventEmitter
}

export const createKeyAnalysisWorkerPool = (deps: KeyAnalysisWorkerPoolDeps) => {
  const isCurrentWorkerJob = (worker: Worker, job: KeyAnalysisJob) =>
    hasCurrentKeyAnalysisJobOwnership(job, {
      terminationExpected: deps.hasExpectedWorkerTermination(worker),
      busyJobId: deps.busy.get(worker),
      inFlightJob: deps.inFlight.get(job.jobId),
      activeJob: deps.activeByPath.get(job.normalizedPath)
    })

  const terminateWorker = (worker: Worker, reason: string) => {
    deps.markExpectedWorkerTermination(worker, reason)
    void worker.terminate().catch(() => {
      deps.clearExpectedWorkerTermination(worker)
    })
  }

  const removeWorkerFromList = (list: Worker[], worker: Worker) => {
    const idx = list.indexOf(worker)
    if (idx !== -1) list.splice(idx, 1)
  }

  const getReusableWorkers = () =>
    deps.workers.filter((worker) => !deps.retiringWorkers.has(worker))

  const hasReusableIdleWorker = () => deps.idle.some((worker) => !deps.retiringWorkers.has(worker))

  const reenqueuePreemptedJob = (
    job: KeyAnalysisJob,
    preemptionKind: Exclude<KeyAnalysisPreemptionKind, 'focus-superseded' | 'visible-superseded'>
  ) => {
    deps.enqueue(
      job.filePath,
      preemptionKind === 'background-resume' ? 'background' : job.priority,
      {
        source: preemptionKind === 'background-resume' ? 'background' : job.source,
        fastAnalysis: job.fastAnalysis,
        preemptible: job.preemptible,
        category: job.category,
        waveformOnly: job.waveformOnly,
        includeStructure: job.includeStructure,
        analysisBpmRangeId: job.analysisBpmRange?.id,
        forceAnalysis: job.forceAnalysis,
        analysisTargets: job.analysisTargets,
        manualBatchIds: job.manualBatchIds
      }
    )
  }

  const applyWorkerProgress = (
    worker: Worker,
    job: KeyAnalysisJob,
    progress: KeyAnalysisProgress
  ) => {
    const trace = job.trace || {}
    trace.lastStage = progress.stage
    trace.lastUpdateAt = Date.now()
    if (typeof progress.elapsedMs === 'number') trace.elapsedMs = progress.elapsedMs
    if (typeof progress.decodeMs === 'number') trace.decodeMs = progress.decodeMs
    if (typeof progress.analyzeMs === 'number') trace.analyzeMs = progress.analyzeMs
    if (typeof progress.waveformMs === 'number') trace.waveformMs = progress.waveformMs
    if (typeof progress.decodeBackend === 'string' && progress.decodeBackend.trim()) {
      trace.decodeBackend = progress.decodeBackend.trim()
    }
    if (typeof progress.sampleRate === 'number') trace.sampleRate = progress.sampleRate
    if (typeof progress.channels === 'number') trace.channels = progress.channels
    if (typeof progress.totalFrames === 'number') trace.totalFrames = progress.totalFrames
    if (typeof progress.framesToProcess === 'number')
      trace.framesToProcess = progress.framesToProcess
    if (typeof progress.detail === 'string' && progress.detail.trim()) {
      trace.detail = progress.detail.slice(0, 300)
    }
    job.trace = trace

    deps.onJobProgress(worker, job, progress)

    // 推送分析阶段到 renderer，用于 UI 进度显示
    deps.events.emit('analysis-stage-update', {
      filePath: job.filePath,
      stage: progress.stage,
      needsKey: job.needsKey,
      needsBpm: job.needsBpm,
      needsWaveform: job.needsWaveform,
      needsEnergy: job.needsEnergy,
      needsStructure: job.needsStructure,
      manualBatchIds: job.manualBatchIds
    })
  }

  const collectJobResultErrors = (
    job: KeyAnalysisJob | undefined,
    payloadResult?: WorkerPayload['result'],
    payloadError?: string
  ): string[] => {
    const errors: string[] = []
    if (payloadResult?.keyError) errors.push(`key: ${payloadResult.keyError}`)
    if (payloadResult?.bpmError && !isNoBpmBeatGridResultError(payloadResult.bpmError)) {
      errors.push(`bpm: ${payloadResult.bpmError}`)
    }
    if (job?.needsEnergy === true && payloadResult?.energyScore === undefined) {
      errors.push('energy: missing energy score from analyzer')
    }
    if (job?.needsStructure === true) {
      if (payloadResult?.songStructureError) {
        errors.push(`structure: ${payloadResult.songStructureError}`)
      } else if (!payloadResult?.songStructure) {
        errors.push('structure: missing v23 structure result from analyzer')
      }
    }
    if (payloadError) errors.push(`worker错误: ${payloadError}`)
    return errors
  }

  const collectFatalJobResultErrors = (
    job: KeyAnalysisJob | undefined,
    payloadResult?: WorkerPayload['result'],
    payloadError?: string
  ): string[] => collectJobResultErrors(job, payloadResult, payloadError)

  const logCompletedJobErrors = (
    worker: Worker,
    job: KeyAnalysisJob,
    payloadResult?: WorkerPayload['result'],
    payloadError?: string
  ) => {
    const errors = collectJobResultErrors(job, payloadResult, payloadError)
    if (errors.length <= 0) return
    const elapsedMs = job.startTime ? Date.now() - job.startTime : job.trace?.elapsedMs
    log.error('[闲时分析] 任务完成但有错误', {
      filePath: job.filePath,
      fileName: path.basename(job.filePath),
      source: job.source,
      workerThreadId: worker.threadId,
      stage: job.trace?.lastStage || 'unknown',
      elapsedMs,
      decodeBackend: job.trace?.decodeBackend || 'unknown',
      partialKeyPersisted: job.trace?.partialKeyPersisted === true,
      partialBpmPersisted: job.trace?.partialBpmPersisted === true,
      detail: job.trace?.detail,
      errors
    })
  }

  const getJobResultErrorDetail = (
    job: KeyAnalysisJob | undefined,
    payloadResult?: WorkerPayload['result'],
    payloadError?: string
  ): string =>
    collectFatalJobResultErrors(job, payloadResult, payloadError).join('; ').slice(0, 300)

  const persistAnalyzePartialResult = async (
    worker: Worker,
    job: KeyAnalysisJob,
    progress: KeyAnalysisProgress
  ) => {
    if (progress.stage !== 'analyze-done') return
    const partialResult = progress.partialResult
    if (!partialResult) return
    const shouldPersist = () => isCurrentWorkerJob(worker, job)

    let keyPersisted = false
    let bpmPersisted = false

    if (shouldPersist() && !partialResult.keyError && isValidKeyText(partialResult.keyText)) {
      await deps.persistence.persistKey(job.filePath, partialResult.keyText)
      keyPersisted = shouldPersist()
    }

    if (shouldPersist() && !partialResult.bpmError && isValidBpm(partialResult.bpm)) {
      await deps.persistence.persistBpm(
        job.filePath,
        partialResult.bpm,
        partialResult.firstBeatMs,
        partialResult.downbeatBeatOffset,
        partialResult.timeBasisOffsetMs,
        { firstBeatCoordinate: 'audio', shouldPersist }
      )
      bpmPersisted = shouldPersist()
    } else if (shouldPersist() && isNoBpmBeatGridResultError(partialResult.bpmError)) {
      await deps.persistence.persistNoBpm(job.filePath, { shouldPersist })
      bpmPersisted = shouldPersist()
    }

    if (!shouldPersist()) return
    job.trace = {
      ...(job.trace || {}),
      partialKeyPersisted: job.trace?.partialKeyPersisted || keyPersisted,
      partialBpmPersisted: job.trace?.partialBpmPersisted || bpmPersisted
    }
  }

  const handleWorkerFailure = (worker: Worker, error: Error) => {
    const jobId = deps.busy.get(worker)
    const preemptionKind = typeof jobId === 'number' ? deps.preemptedJobs.get(jobId) : undefined
    const expectedTerminationReason = deps.consumeExpectedWorkerTermination(worker)
    const wasPreempted = preemptionKind !== undefined
    const wasExpectedTermination = Boolean(expectedTerminationReason)
    const wasForegroundWorker = deps.getForegroundWorker() === worker
    let preemptedJob: KeyAnalysisJob | null = null
    let job: KeyAnalysisJob | undefined
    let failureReason: KeyAnalysisFailureReason = 'worker-error'
    if (error?.message?.includes('worker exited')) {
      failureReason = 'worker-exit'
    }
    if (typeof jobId === 'number') {
      job = deps.inFlight.get(jobId)
      if (job) {
        const wasTimedOut = typeof job.trace?.timedOutAt === 'number'
        if (!wasPreempted && !wasTimedOut && !wasExpectedTermination) {
          deps.onJobFailure(job, failureReason, String(error?.message || error).slice(0, 300))
        }
        if (job.source === 'background') {
          if (!wasPreempted && !wasExpectedTermination) {
            const errorMsg = `[闲时分析] Worker 崩溃 - ${path.basename(job.filePath)}`
            log.error(errorMsg, error)
          }
          deps.background.unmarkProcessing(job.jobId)
        } else {
          const trace = job.trace
          const stageElapsedMs =
            typeof trace?.lastUpdateAt === 'number' ? Date.now() - trace.lastUpdateAt : undefined
          const logPayload = {
            filePath: job.filePath,
            fileName: path.basename(job.filePath),
            workerThreadId: worker.threadId,
            stage: trace?.lastStage || 'unknown',
            stageElapsedMs,
            elapsedMs: trace?.elapsedMs,
            decodeMs: trace?.decodeMs,
            analyzeMs: trace?.analyzeMs,
            waveformMs: trace?.waveformMs,
            decodeBackend: trace?.decodeBackend || 'unknown',
            partialKeyPersisted: trace?.partialKeyPersisted === true,
            partialBpmPersisted: trace?.partialBpmPersisted === true,
            detail: trace?.detail
          }
          if (!wasPreempted && !wasExpectedTermination) {
            log.error('[闲时分析] 前台任务 worker 异常退出', logPayload)
          }
        }
        if (deps.activeByPath.get(job.normalizedPath) === job) {
          deps.activeByPath.delete(job.normalizedPath)
        }
        deps.inFlight.delete(jobId)
      }
      if (wasPreempted) {
        deps.preemptedJobs.delete(jobId)
        if (
          job &&
          (preemptionKind === 'background-resume' || preemptionKind === 'lower-priority-resume')
        ) {
          preemptedJob = job
        }
      }
      deps.busy.delete(worker)
    } else {
      if (!wasExpectedTermination) {
        const errorMsg = '[闲时分析] Worker 崩溃（无关联任务）'
        log.error(errorMsg, error)
      }
    }

    const wasRetiring = deps.retiringWorkers.has(worker)
    removeWorkerFromList(deps.workers, worker)
    removeWorkerFromList(deps.idle, worker)
    deps.retiringWorkers.delete(worker)

    const isConcurrencyShrink =
      expectedTerminationReason === 'concurrency-retire' ||
      expectedTerminationReason === 'concurrency-downscale'
    if (!wasRetiring && !isConcurrencyShrink) {
      const replacement = createWorker()
      deps.workers.push(replacement)
      if (wasForegroundWorker) {
        deps.setForegroundWorker(replacement)
      }
      refreshForegroundWorker()
    }
    deps.drain()
    if (
      preemptedJob &&
      (preemptionKind === 'background-resume' || preemptionKind === 'lower-priority-resume')
    ) {
      reenqueuePreemptedJob(preemptedJob, preemptionKind)
    }
    deps.background.emitBackgroundStatus()
  }

  const handleWorkerMessage = async (worker: Worker, payload: WorkerPayload) => {
    const jobId = payload?.jobId
    const job = deps.inFlight.get(jobId)
    const payloadProgress = payload?.progress
    const payloadResult = payload?.result
    const payloadError = payload?.error
    const workerTerminationExpected = deps.hasExpectedWorkerTermination(worker)

    if (payloadProgress) {
      if (job && isCurrentWorkerJob(worker, job)) {
        applyWorkerProgress(worker, job, payloadProgress)
        await persistAnalyzePartialResult(worker, job, payloadProgress)
      } else if (!workerTerminationExpected) {
        log.error('[闲时分析] 收到进度但任务不存在', {
          jobId,
          filePath: payload?.filePath,
          workerThreadId: worker.threadId,
          stage: payloadProgress.stage
        })
      }
      return
    }

    if (!job || !isCurrentWorkerJob(worker, job)) {
      if (!workerTerminationExpected && deps.workers.includes(worker)) {
        terminateWorker(worker, 'orphan-result')
      }
      return
    }

    const shouldPersist = () => isCurrentWorkerJob(worker, job)

    let terminalProgress: KeyAnalysisProgress | null = null
    let resultErrorDetail = ''

    if (job) {
      resultErrorDetail = getJobResultErrorDetail(job, payloadResult, payloadError)
      const terminalStage = payloadError || resultErrorDetail ? 'job-error' : 'job-done'
      terminalProgress = {
        stage: terminalStage,
        elapsedMs:
          typeof job.trace?.elapsedMs === 'number'
            ? job.trace.elapsedMs
            : job.startTime
              ? Date.now() - job.startTime
              : 0,
        detail: payloadError ? String(payloadError).slice(0, 300) : resultErrorDetail || undefined
      }
      // 先清掉 worker 阶段超时，但不要向 renderer/manual-batch 宣告终态。
      // 终态必须等 key/BPM/energy/waveform 持久化完成后再发。
      deps.onJobProgress(worker, job, terminalProgress)
    }

    let persistenceErrorDetail = ''
    try {
      if (shouldPersist() && payloadResult && !payloadResult.keyError) {
        const keyText = payloadResult.keyText
        if (isValidKeyText(keyText)) {
          await deps.persistence.persistKey(job.filePath, keyText)
        }
      }

      if (shouldPersist() && payloadResult) {
        if (isNoBpmBeatGridResultError(payloadResult.bpmError)) {
          await deps.persistence.persistNoBpm(job.filePath, { shouldPersist })
        } else if (!payloadResult.bpmError) {
          const bpmValue = payloadResult.bpm
          if (isValidBpm(bpmValue)) {
            await deps.persistence.persistBpm(
              job.filePath,
              bpmValue,
              payloadResult.firstBeatMs,
              payloadResult.downbeatBeatOffset,
              payloadResult.timeBasisOffsetMs,
              { firstBeatCoordinate: 'audio', shouldPersist }
            )
          }
        }
      }

      if (shouldPersist() && payloadResult?.energyScore !== undefined) {
        await deps.persistence.persistEnergy(
          job.filePath,
          payloadResult.energyScore,
          payloadResult.energyAlgorithmVersion
        )
      }

      if (shouldPersist() && payloadResult?.mixxxWaveformData && job.needsWaveform) {
        await deps.persistence.persistWaveform(
          job.filePath,
          payloadResult.mixxxWaveformData,
          payloadResult.unifiedDisplayWaveformData ?? null
        )
        if (shouldPersist()) {
          deps.events.emit('waveform-updated', { filePath: job.filePath })
        }
      }

      if (
        shouldPersist() &&
        job.needsStructure &&
        payloadResult?.songStructure &&
        !payloadResult.songStructureError
      ) {
        await deps.persistence.persistSongStructure(job.filePath, payloadResult.songStructure, {
          shouldPersist,
          beatGridMap: payloadResult.structureBeatGridMap
        })
      }
    } catch (error) {
      persistenceErrorDetail = `persist: ${
        error instanceof Error ? error.message : String(error || 'unknown error')
      }`.slice(0, 300)
      if (terminalProgress) {
        terminalProgress = {
          ...terminalProgress,
          stage: 'job-error',
          detail: [terminalProgress.detail, persistenceErrorDetail].filter(Boolean).join('; ')
        }
      }
      log.error('[闲时分析] 任务结果持久化失败', {
        filePath: job?.filePath,
        fileName: job?.filePath ? path.basename(job.filePath) : '',
        error: persistenceErrorDetail
      })
    }

    if (!shouldPersist()) return

    if (terminalProgress) {
      applyWorkerProgress(worker, job, terminalProgress)
      if (payloadError) {
        deps.onJobFailure(job, 'worker-error', String(payloadError).slice(0, 300))
      } else if (resultErrorDetail || persistenceErrorDetail) {
        deps.onJobFailure(job, 'analysis-error', resultErrorDetail || persistenceErrorDetail)
      } else {
        deps.onJobSuccess(job)
      }
      logCompletedJobErrors(worker, job, payloadResult, payloadError || persistenceErrorDetail)
    }

    if (typeof jobId === 'number') {
      deps.preemptedJobs.delete(jobId)
    }
    if (deps.inFlight.get(jobId) === job) {
      deps.inFlight.delete(jobId)
    }
    if (deps.busy.get(worker) === jobId) {
      deps.busy.delete(worker)
    }

    const isRetiring = deps.retiringWorkers.has(worker)
    if (isRetiring) {
      removeWorkerFromList(deps.workers, worker)
      removeWorkerFromList(deps.idle, worker)
      deps.retiringWorkers.delete(worker)
      deps.markExpectedWorkerTermination(worker, 'concurrency-retire')
      void worker.terminate().catch(() => {
        deps.clearExpectedWorkerTermination(worker)
      })
      deps.background.emitBackgroundStatus()
    } else if (
      !deps.hasExpectedWorkerTermination(worker) &&
      deps.workers.includes(worker) &&
      !deps.idle.includes(worker)
    ) {
      deps.idle.push(worker)
    }

    if (deps.activeByPath.get(job.normalizedPath) === job) {
      deps.activeByPath.delete(job.normalizedPath)
    }
    if (job.source === 'background') {
      deps.background.unmarkProcessing(job.jobId)
      deps.background.emitBackgroundStatus()
    }

    deps.drain()
  }

  const createWorker = (): Worker => {
    const workerPath = resolveMainWorkerPath(__dirname, 'keyAnalysisWorker.js')
    const worker = new Worker(workerPath)

    worker.on('message', (payload: WorkerPayload) => {
      void handleWorkerMessage(worker, payload)
    })

    worker.on('error', (error: Error) => {
      handleWorkerFailure(worker, error)
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        handleWorkerFailure(worker, new Error(`worker exited: ${code}`))
      }
    })

    deps.idle.push(worker)
    return worker
  }

  const refreshForegroundWorker = () => {
    const reusableWorkers = getReusableWorkers()
    if (reusableWorkers.length <= 1) {
      deps.setForegroundWorker(null)
      return
    }
    const current = deps.getForegroundWorker()
    if (current && reusableWorkers.includes(current)) {
      return
    }
    deps.setForegroundWorker(reusableWorkers[0] || null)
  }

  const getReservedWorker = (): Worker | null => {
    const reusableWorkers = getReusableWorkers()
    if (reusableWorkers.length <= 1) return null
    const current = deps.getForegroundWorker()
    if (current && reusableWorkers.includes(current)) return current
    return reusableWorkers[0] || null
  }

  const getIdleWorker = (allowReserved: boolean): Worker | null => {
    if (deps.idle.length === 0) return null
    const reserved = getReservedWorker()
    if (!reserved || allowReserved) {
      const idx = deps.idle.findIndex((item) => !deps.retiringWorkers.has(item))
      if (idx === -1) return null
      const [worker] = deps.idle.splice(idx, 1)
      return worker || null
    }
    const idx = deps.idle.findIndex((item) => item !== reserved && !deps.retiringWorkers.has(item))
    if (idx === -1) return null
    const [worker] = deps.idle.splice(idx, 1)
    return worker || null
  }

  const maybePreemptForJob = (incomingJob: KeyAnalysisJob) => {
    if (incomingJob.priority !== 'high') return
    if (hasReusableIdleWorker() && deps.busy.size < deps.getGlobalConcurrencyLimit()) return
    if (deps.workers.length <= 1) return

    const canPreempt = (job: KeyAnalysisJob | null | undefined) => {
      if (!job) return false
      if (job.priority === 'high') return false
      return job.source === 'background' || job.preemptible === true
    }

    const resolvePreemptionKind = (
      job: KeyAnalysisJob
    ): Exclude<KeyAnalysisPreemptionKind, 'focus-superseded'> =>
      job.source === 'background' ? 'background-resume' : 'lower-priority-resume'

    const foregroundWorker = deps.getForegroundWorker()
    if (foregroundWorker && !deps.busy.has(foregroundWorker)) return

    if (foregroundWorker) {
      const foregroundJobId = deps.busy.get(foregroundWorker)
      const foregroundJob =
        typeof foregroundJobId === 'number' ? deps.inFlight.get(foregroundJobId) : null
      if (typeof foregroundJobId === 'number' && canPreempt(foregroundJob)) {
        deps.preemptedJobs.set(foregroundJobId, resolvePreemptionKind(foregroundJob!))
        terminateWorker(foregroundWorker, resolvePreemptionKind(foregroundJob!))
        return
      }
    }

    for (const [worker, jobId] of deps.busy.entries()) {
      const job = deps.inFlight.get(jobId)
      if (canPreempt(job)) {
        deps.preemptedJobs.set(jobId, resolvePreemptionKind(job!))
        terminateWorker(worker, resolvePreemptionKind(job!))
        return
      }
    }
  }

  const countBackgroundInFlight = (): number => {
    let count = 0
    for (const job of deps.inFlight.values()) {
      if (job.source === 'background') count += 1
    }
    return count
  }

  return {
    countBackgroundInFlight,
    createWorker,
    getIdleWorker,
    getReservedWorker,
    maybePreemptForJob,
    refreshForegroundWorker
  }
}

export type KeyAnalysisWorkerPool = ReturnType<typeof createKeyAnalysisWorkerPool>
