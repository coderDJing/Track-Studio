import path from 'node:path'
import fs from 'node:fs/promises'
import type { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { log } from '../../log'
import { resolveMainWorkerPath } from '../../workerPath'
import type { KeyAnalysisBackground } from './background'
import type { KeyAnalysisPersistence } from './persistence'
import type { AnalysisBpmRangePresetId } from '../../../shared/analysisBpmRange'
import { hasCurrentKeyAnalysisJobOwnership } from './jobOwnership'
import { getKeyAnalysisJobDiagnostics, recordKeyAnalysisDiagnosticPhase } from './diagnostics'
import { createStageDiagnostics } from '../stageDiagnostics'
import {
  readAnalysisGridMode,
  readDynamicGridOutcomeFromResult,
  readDynamicGridSidecarPid,
  DYNAMIC_GRID_DEFERRED_STRUCTURE_ERROR
} from './dynamicGridIntegration'
import { terminateOwnedPidExact } from '../childProcessRegistry'
import { createDynamicSidecarTracker } from './dynamicSidecarTracker'
import { normalizeDynamicGridPublicProgress } from '../../../shared/dynamicGridProgress'
import { createWorkerPersistGuard } from './persistGuard'
import type { AudioIdentity } from './persistGuard'
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
  /** 只用于提交资格：路径最新网格请求代次是否仍是该 job。 */
  isCurrentGridRequest: (job: KeyAnalysisJob) => boolean
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

export const getDeferredStructureGridDetail = (
  job: KeyAnalysisJob | undefined,
  payloadResult?: WorkerPayload['result'],
  payloadError?: string
): string | null => {
  if (
    job?.needsStructure !== true ||
    payloadError ||
    payloadResult?.songStructureError !== 'missing v2 beat grid for v23 structure analysis'
  ) {
    return null
  }
  return 'structure: missing v2 beat grid for v23 structure analysis'
}

export const collectKeyAnalysisJobResultErrors = (
  job: KeyAnalysisJob | undefined,
  payloadResult?: WorkerPayload['result'],
  payloadError?: string
): string[] => {
  const errors: string[] = []
  if (payloadResult?.keyError) errors.push(`key: ${payloadResult.keyError}`)
  if (payloadResult?.bpmError && !isNoBpmBeatGridResultError(payloadResult.bpmError)) {
    errors.push(`bpm: ${payloadResult.bpmError}`)
  }
  if (
    payloadResult &&
    !payloadResult.bpmError &&
    readAnalysisGridMode(job) === 'dynamic' &&
    !readDynamicGridOutcomeFromResult(payloadResult)
  ) {
    // 请求 dynamic 但结果没有可校验的 outcome：不能按固定网格提交。
    errors.push('bpm: dynamic grid outcome missing or invalid')
  }
  if (
    job?.needsEnergy === true &&
    payloadResult?.energyScore === undefined &&
    !payloadResult?.bpmError
  ) {
    errors.push(`energy: ${payloadResult?.energyError || 'missing energy score from analyzer'}`)
  }
  if (job?.needsStructure === true) {
    if (payloadResult?.songStructureError) {
      // Dynamic 网格本期不启动段落分析，未执行项不作为任务失败。
      if (payloadResult.songStructureError !== DYNAMIC_GRID_DEFERRED_STRUCTURE_ERROR) {
        errors.push(`structure: ${payloadResult.songStructureError}`)
      }
    } else if (!payloadResult?.songStructure) {
      errors.push('structure: missing v23 structure result from analyzer')
    }
  }
  if (payloadError) errors.push(`worker错误: ${payloadError}`)
  return errors
}

export const createKeyAnalysisWorkerPool = (deps: KeyAnalysisWorkerPoolDeps) => {
  let consecutiveWorkerStartFailures = 0

  const isCurrentWorkerJob = (worker: Worker, job: KeyAnalysisJob) =>
    hasCurrentKeyAnalysisJobOwnership(job, {
      terminationExpected: deps.hasExpectedWorkerTermination(worker),
      busyJobId: deps.busy.get(worker),
      inFlightJob: deps.inFlight.get(job.jobId),
      activeJob: deps.activeByPath.get(job.normalizedPath)
    })

  // Dynamic 推理 sidecar 由 worker 拥有；硬终止 worker 不会触发其 process exit hook，
  // 因此主进程按“本任务上报过的精确 PID”清理，绝不按进程名批量终止。
  const dynamicSidecarTracker = createDynamicSidecarTracker({
    terminatePid: (pid) => terminateOwnedPidExact(pid, 'dynamic-grid-sidecar')
  })

  const releaseDynamicSidecar = (worker: Worker, kill: boolean) => {
    dynamicSidecarTracker.release(worker, kill)
  }

  const trackDynamicSidecar = (
    worker: Worker,
    job: KeyAnalysisJob,
    progress: KeyAnalysisProgress
  ) => {
    if (!progress.dynamicGrid) return
    if (deps.busy.get(worker) === job.jobId) {
      // 只有确认该 job 真的占着这个 worker 时才开启新生命周期。
      dynamicSidecarTracker.begin(worker, job)
    }
    dynamicSidecarTracker.track({
      workerKey: worker,
      jobKey: job,
      pid: readDynamicGridSidecarPid(progress.dynamicGrid),
      canCommit: () => isCurrentWorkerJob(worker, job) && !deps.hasExpectedWorkerTermination(worker)
    })
  }

  /**
   * 取消/失去资格后仍可能收到 progress；此时同样要读取 PID，把迟到的 sidecar 精确终止，
   * 不能因为整条进度被丢弃而永久泄漏子进程。
   */
  const absorbLateDynamicSidecar = (
    worker: Worker,
    job: KeyAnalysisJob | undefined,
    progress: KeyAnalysisProgress
  ) => {
    if (!progress.dynamicGrid) return
    const busyJobId = deps.busy.get(worker)
    const busyJob = typeof busyJobId === 'number' ? deps.inFlight.get(busyJobId) : undefined
    if (busyJob) dynamicSidecarTracker.begin(worker, busyJob)
    dynamicSidecarTracker.track({
      workerKey: worker,
      jobKey: job ?? null,
      pid: readDynamicGridSidecarPid(progress.dynamicGrid),
      canCommit: () => false
    })
  }

  const terminateWorker = (worker: Worker, reason: string) => {
    deps.markExpectedWorkerTermination(worker, reason)
    releaseDynamicSidecar(worker, true)
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
    progress: KeyAnalysisProgress,
    /**
     * 非空表示这是“真失败”的终态。手动批次按它统计失败数，
     * 不能用 job-error 阶段直接判断：结果作废（stale）也会发 job-error，但那不算失败。
     */
    manualBatchFailureDetail = ''
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

    trackDynamicSidecar(worker, job, progress)
    deps.onJobProgress(worker, job, progress)

    // 推送分析阶段到 renderer，用于 UI 进度显示。
    // dynamicGrid 只发 shared 公开契约字段，sidecarPid 等实现细节绝不跨 IPC。
    const publicDynamicGrid = normalizeDynamicGridPublicProgress(progress.dynamicGrid)
    deps.events.emit('analysis-stage-update', {
      filePath: job.filePath,
      stage: progress.stage,
      needsKey: job.needsKey,
      needsBpm: job.needsBpm,
      needsWaveform: job.needsWaveform,
      needsEnergy: job.needsEnergy,
      needsStructure: job.needsStructure,
      manualBatchIds: job.manualBatchIds,
      ...(manualBatchFailureDetail
        ? {
            manualBatchFailed: true,
            manualBatchFailureDetail: manualBatchFailureDetail.slice(0, 200)
          }
        : {}),
      ...(publicDynamicGrid ? { dynamicGrid: publicDynamicGrid } : {})
    })
  }

  const collectFatalJobResultErrors = (
    job: KeyAnalysisJob | undefined,
    payloadResult?: WorkerPayload['result'],
    payloadError?: string
  ): string[] => {
    const deferredStructureGridDetail = getDeferredStructureGridDetail(
      job,
      payloadResult,
      payloadError
    )
    return collectKeyAnalysisJobResultErrors(job, payloadResult, payloadError).filter(
      (error) => error !== deferredStructureGridDetail
    )
  }

  const logCompletedJobErrors = (
    worker: Worker,
    job: KeyAnalysisJob,
    payloadResult?: WorkerPayload['result'],
    payloadError?: string
  ) => {
    const errors = collectFatalJobResultErrors(job, payloadResult, payloadError)
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
      errors,
      diagnostic: getKeyAnalysisJobDiagnostics([job])[0]
    })
  }

  const getJobResultErrorDetail = (
    job: KeyAnalysisJob | undefined,
    payloadResult?: WorkerPayload['result'],
    payloadError?: string
  ): string =>
    collectFatalJobResultErrors(job, payloadResult, payloadError).join('; ').slice(0, 300)

  const readCurrentAudioIdentity = async (filePath: string): Promise<AudioIdentity | null> => {
    try {
      const stat = await fs.stat(filePath)
      return { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return null
    }
  }

  /**
   * 提交资格 = 当前请求代次 + worker 归属 + 音频身份未变化。
   * 生成代次由 queue 提供，仅用于提交，不影响 worker 清理所有权。
   * 人工网格修订竞争由持久化层按磁盘定义再次校验。
   */
  const resolveJobAudioIdentity = (job: KeyAnalysisJob): AudioIdentity | undefined =>
    typeof job.fileSize === 'number' && typeof job.fileMtimeMs === 'number'
      ? { size: job.fileSize, mtimeMs: job.fileMtimeMs }
      : undefined

  // 入队时探测到的时长与 outcome 自带时长互相校验；缺探针时才退回 outcome 值。
  const resolveExpectedAudioDurationSec = (job: KeyAnalysisJob, fallback?: number) => {
    const probeDurationSec = Number(job.probe?.durationSec)
    if (Number.isFinite(probeDurationSec) && probeDurationSec > 0) return probeDurationSec
    return fallback
  }

  const createPersistGuard = (worker: Worker, job: KeyAnalysisJob) => {
    // 只有真正带代次的新请求才检查 gridRequestGeneration；旧 Normal 任务没有该字段，
    // 继续以 worker 归属判定，避免把历史入口整体拒绝。
    const hasGridGeneration = typeof job.gridRequestGeneration === 'number'
    return createWorkerPersistGuard({
      isCurrentJob: () =>
        (!hasGridGeneration || deps.isCurrentGridRequest(job)) && isCurrentWorkerJob(worker, job),
      expectedAudioIdentity: resolveJobAudioIdentity(job) ?? null,
      readCurrentAudioIdentity: () => readCurrentAudioIdentity(job.filePath)
    })
  }

  const readSuccessfulDynamicGridOutcome = (value: unknown) => {
    const outcome = readDynamicGridOutcomeFromResult(value)
    if (!outcome) return { outcome: undefined, durationAudioSec: undefined }
    if (outcome.status !== 'fixed' && outcome.status !== 'dynamic') {
      return { outcome, durationAudioSec: undefined }
    }
    return { outcome, durationAudioSec: outcome.durationAudioSec }
  }

  const persistAnalyzePartialResult = async (
    worker: Worker,
    job: KeyAnalysisJob,
    progress: KeyAnalysisProgress
  ) => {
    if (progress.stage !== 'analyze-done') return
    const partialResult = progress.partialResult
    if (!partialResult) return
    const shouldPersist = await createPersistGuard(worker, job)
    const { outcome: dynamicGridOutcome, durationAudioSec } =
      readSuccessfulDynamicGridOutcome(partialResult)
    const expectedAudioIdentity = resolveJobAudioIdentity(job)
    const isDynamicJob = readAnalysisGridMode(job) === 'dynamic'
    const dynamicOutcomeMissing = isDynamicJob && !dynamicGridOutcome
    const expectedDurationSec = resolveExpectedAudioDurationSec(job, durationAudioSec)

    let keyPersisted = false
    let bpmPersisted = false

    if (shouldPersist() && !partialResult.keyError && isValidKeyText(partialResult.keyText)) {
      await deps.persistence.persistKey(job.filePath, partialResult.keyText)
      keyPersisted = shouldPersist()
    }

    if (
      shouldPersist() &&
      !dynamicOutcomeMissing &&
      !partialResult.bpmError &&
      isValidBpm(partialResult.bpm)
    ) {
      await deps.persistence.persistBpm(
        job.filePath,
        partialResult.bpm,
        partialResult.firstBeatMs,
        partialResult.downbeatBeatOffset,
        partialResult.timeBasisOffsetMs,
        {
          firstBeatCoordinate: 'audio',
          shouldPersist,
          ...(dynamicGridOutcome ? { dynamicGridOutcome } : {}),
          ...(expectedDurationSec === undefined
            ? {}
            : { expectedAudioDurationSec: expectedDurationSec }),
          ...(expectedAudioIdentity ? { expectedAudioIdentity } : {})
        }
      )
      bpmPersisted = shouldPersist()
    } else if (
      shouldPersist() &&
      !isDynamicJob &&
      isNoBpmBeatGridResultError(partialResult.bpmError)
    ) {
      // 只有真正的 Normal 模型 no-bpm 才落 no-bpm；Dynamic 失败不进入这里。
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
    // error 后还会收到 exit；同一个 worker 只能清理并补建一次。
    if (!deps.workers.includes(worker)) {
      deps.clearExpectedWorkerTermination(worker)
      return
    }
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
    // worker 异常/退出不会执行其内部 process exit hook，按记录的精确 PID 清理 sidecar。
    releaseDynamicSidecar(worker, true)

    const isConcurrencyShrink =
      expectedTerminationReason === 'concurrency-retire' ||
      expectedTerminationReason === 'concurrency-downscale'
    if (!wasRetiring && !isConcurrencyShrink) {
      if (!wasExpectedTermination && (!job || job.trace?.lastStage === 'job-received')) {
        // 启动依赖损坏时，无任务 worker 也会退出；禁止以创建线程的速度无限补建。
        consecutiveWorkerStartFailures = Math.min(consecutiveWorkerStartFailures + 1, 6)
        const retryDelayMs = Math.min(1000 * 2 ** (consecutiveWorkerStartFailures - 1), 30_000)
        const retryTimer = setTimeout(() => {
          // 等待期间可能已缩容或手动扩容，按最新并发限制补建，避免超额线程。
          if (deps.workers.length >= deps.getGlobalConcurrencyLimit()) return
          const replacement = createWorker()
          deps.workers.push(replacement)
          refreshForegroundWorker()
          deps.drain()
        }, retryDelayMs)
        retryTimer.unref()
      } else {
        const replacement = createWorker()
        deps.workers.push(replacement)
        if (wasForegroundWorker) {
          deps.setForegroundWorker(replacement)
        }
      }
    }
    refreshForegroundWorker()
    // 超时/崩溃必须结算 UI 和手动批次；取消与可恢复抢占仍由原入口处理归属。
    // 在释放路径、移除旧 worker 后发事件，避免批次结束触发并发调整时重入半清理状态。
    if (
      job &&
      !preemptedJob &&
      (!wasExpectedTermination || expectedTerminationReason === 'timeout')
    ) {
      applyWorkerProgress(
        worker,
        job,
        {
          stage: 'job-error',
          elapsedMs: job.trace?.elapsedMs ?? 0
        },
        // 超时与崩溃是用户需要知道的真失败，必须计入手动批次失败数。
        expectedTerminationReason === 'timeout'
          ? 'timeout'
          : String(error?.message || 'worker terminated').slice(0, 200)
      )
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
    if (job && isCurrentWorkerJob(worker, job)) {
      consecutiveWorkerStartFailures = 0
    }
    const payloadProgress = payload?.progress
    const payloadResult = payload?.result
    const payloadError = payload?.error
    const workerTerminationExpected = deps.hasExpectedWorkerTermination(worker)

    if (payload.diagnostic) {
      if (job && isCurrentWorkerJob(worker, job)) {
        recordKeyAnalysisDiagnosticPhase(job, payload.diagnostic)
      }
      return
    }

    if (payloadProgress) {
      if (job && isCurrentWorkerJob(worker, job)) {
        applyWorkerProgress(worker, job, payloadProgress)
        await persistAnalyzePartialResult(worker, job, payloadProgress)
      } else {
        absorbLateDynamicSidecar(worker, job, payloadProgress)
        if (!workerTerminationExpected) {
          log.error('[闲时分析] 收到进度但任务不存在', {
            jobId,
            filePath: payload?.filePath,
            workerThreadId: worker.threadId,
            stage: payloadProgress.stage
          })
        }
      }
      return
    }

    if (!job || !isCurrentWorkerJob(worker, job)) {
      if (!workerTerminationExpected && deps.workers.includes(worker)) {
        terminateWorker(worker, 'orphan-result')
      }
      return
    }

    const shouldPersist = await createPersistGuard(worker, job)
    // worker 已交付终态结果，sidecar 会话由 scanner 关闭；只清记录，不按 PID 击杀。
    releaseDynamicSidecar(worker, false)
    const { outcome: dynamicGridOutcome, durationAudioSec } =
      readSuccessfulDynamicGridOutcome(payloadResult)
    const expectedAudioIdentity = resolveJobAudioIdentity(job)
    const isDynamicJob = readAnalysisGridMode(job) === 'dynamic'
    const dynamicOutcomeMissing = isDynamicJob && !dynamicGridOutcome
    const expectedDurationSec = resolveExpectedAudioDurationSec(job, durationAudioSec)

    let terminalProgress: KeyAnalysisProgress | null = null
    let resultErrorDetail = ''
    let deferredStructureGridDetail: string | null = null

    if (job) {
      deferredStructureGridDetail = getDeferredStructureGridDetail(job, payloadResult, payloadError)
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
        if (!isDynamicJob && isNoBpmBeatGridResultError(payloadResult.bpmError)) {
          // 只有真正的 Normal 模型 no-bpm 才落 no-bpm；Dynamic 失败不进入这里。
          await deps.persistence.persistNoBpm(job.filePath, { shouldPersist })
        } else if (!dynamicOutcomeMissing && !payloadResult.bpmError) {
          const bpmValue = payloadResult.bpm
          if (isValidBpm(bpmValue)) {
            await deps.persistence.persistBpm(
              job.filePath,
              bpmValue,
              payloadResult.firstBeatMs,
              payloadResult.downbeatBeatOffset,
              payloadResult.timeBasisOffsetMs,
              {
                firstBeatCoordinate: 'audio',
                shouldPersist,
                ...(dynamicGridOutcome ? { dynamicGridOutcome } : {}),
                ...(expectedDurationSec === undefined
                  ? {}
                  : { expectedAudioDurationSec: expectedDurationSec }),
                ...(expectedAudioIdentity ? { expectedAudioIdentity } : {})
              }
            )
          }
        }
      }

      if (shouldPersist() && payloadResult?.energyScore !== undefined) {
        const sourceGridSignature = payloadResult.energySourceGridSignature
        await deps.persistence.persistEnergy(
          job.filePath,
          payloadResult.energyScore,
          payloadResult.energyAlgorithmVersion,
          payloadResult.energyAnalysis,
          {
            shouldPersist,
            ...(sourceGridSignature ? { sourceGridSignature } : {}),
            ...(expectedAudioIdentity ? { expectedAudioIdentity } : {})
          }
        )
      }

      if (shouldPersist() && payloadResult?.mixxxWaveformData && job.needsWaveform) {
        const waveformData = payloadResult.mixxxWaveformData
        await createStageDiagnostics('analysis-persist-perf', { filePath: job.filePath }).measure(
          'waveform',
          () =>
            deps.persistence.persistWaveform(
              job.filePath,
              waveformData,
              payloadResult.unifiedDisplayWaveformData ?? null
            )
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

    // 结果不再有提交资格（新代次/文件被替换）时跳过写库与成功通知，
    // 但仍要完成 worker/inFlight 清理，避免占用并发额度或让批次永久等待。
    const canCommit = shouldPersist()

    if (!canCommit && terminalProgress) {
      // stale 任务也必须发带 manualBatchIds 的终态事件，否则 UI 与手动批次会永久 pending。
      // 这里只发 job-error（携带旧 job 自己的 filePath/manualBatchIds），绝不冒用新任务成功。
      applyWorkerProgress(worker, job, {
        stage: 'job-error',
        elapsedMs: terminalProgress.elapsedMs,
        detail: '分析结果已作废（请求代次更新或音频被替换）'
      })
    }

    if (canCommit && terminalProgress) {
      // 失败详情必须在发终态之前算好，手动批次才能在同一个事件里把它计入失败。
      // 段落延后（deferredStructureGridDetail）是正常结果，不计入批次失败。
      applyWorkerProgress(
        worker,
        job,
        terminalProgress,
        payloadError || resultErrorDetail || persistenceErrorDetail
      )
      if (payloadError) {
        deps.onJobFailure(job, 'worker-error', String(payloadError).slice(0, 300))
      } else if (resultErrorDetail || persistenceErrorDetail) {
        deps.onJobFailure(job, 'analysis-error', resultErrorDetail || persistenceErrorDetail)
      } else if (deferredStructureGridDetail) {
        // 节拍分析本轮只给出了 BPM，尚未给出 v2 网格锚点；保留失败记录以节流后台补算，
        // 但不要把已成功写入的其它分析项向前端宣告成整任务失败。
        deps.onJobFailure(job, 'analysis-error', deferredStructureGridDetail)
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
      // 即使退出码为 0，尚未交付结果的任务也不能永久占着队列。
      handleWorkerFailure(worker, new Error(`worker exited: ${code}`))
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
    refreshForegroundWorker,
    /** 供 queue 的直接终止路径调用：只清理该 worker 上报过的 sidecar PID。 */
    cleanupDynamicSidecar: (worker: Worker) => releaseDynamicSidecar(worker, true)
  }
}

export type KeyAnalysisWorkerPool = ReturnType<typeof createKeyAnalysisWorkerPool>
