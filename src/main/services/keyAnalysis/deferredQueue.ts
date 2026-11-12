import type {
  KeyAnalysisJob,
  KeyAnalysisPriority,
  KeyAnalysisQueueCategory,
  KeyAnalysisRequestFlags,
  KeyAnalysisSource
} from './types'
import {
  resolveAnalysisBpmRange,
  type AnalysisBpmRangePresetId
} from '../../../shared/analysisBpmRange'
import type { AnalysisGridMode } from '../../../shared/analysisGridMode'
import {
  hasAnyKeyAnalysisTarget,
  hasUncoveredForcedReanalysisTarget,
  normalizeKeyAnalysisTargets
} from './analysisTargets'
import {
  requiresAnalysisGridModeFollowUp,
  resolveRequestedAnalysisGridMode
} from './queueJobOptions'

type DeferredRequestOptions = KeyAnalysisRequestFlags & {
  fastAnalysis?: boolean
  preemptible?: boolean
  category?: KeyAnalysisQueueCategory
  waveformOnly?: boolean
  includeStructure?: boolean
  analysisBpmRangeId?: AnalysisBpmRangePresetId
  analysisGridMode?: AnalysisGridMode
}

type DeferredQueueHelpers = {
  nextJobId: () => number
  isHigherPriority: (next: KeyAnalysisPriority, current: KeyAnalysisPriority) => boolean
  applyQueueCategory: (job: KeyAnalysisJob, category?: KeyAnalysisQueueCategory) => void
  applyWaveformOnlyOption: (job: KeyAnalysisJob, waveformOnly?: boolean) => void
  applyIncludeStructureOption: (job: KeyAnalysisJob, includeStructure?: boolean) => void
  applyRequestFlags: (job: KeyAnalysisJob, flags: KeyAnalysisRequestFlags) => void
  addManualBatchIdsToJob: (job: KeyAnalysisJob, batchIds: string[]) => void
  addFocusSlotToJob: (job: KeyAnalysisJob, focusSlot?: string) => void
  removeManualBatchIdFromJob: (job: KeyAnalysisJob, batchId: string) => boolean
  isManualOnlyJob: (job: KeyAnalysisJob) => boolean
  resolveGridMode: (fallback?: unknown) => AnalysisGridMode
  nextGridRequestGeneration: (normalizedPath: string) => number
}

export class KeyAnalysisDeferredQueue {
  private jobsByPath = new Map<string, KeyAnalysisJob>()

  get size() {
    return this.jobsByPath.size
  }

  has(normalizedPath: string) {
    return this.jobsByPath.has(normalizedPath)
  }

  get(normalizedPath: string) {
    return this.jobsByPath.get(normalizedPath)
  }

  delete(normalizedPath: string) {
    return this.jobsByPath.delete(normalizedPath)
  }

  requiresFollowUp(active: KeyAnalysisJob, options: DeferredRequestOptions) {
    const activeIsPartial =
      hasAnyKeyAnalysisTarget(active.analysisTargets) && active.forceAnalysis !== true
    const incomingIsUntargeted =
      !hasAnyKeyAnalysisTarget(options.analysisTargets) && options.forceAnalysis !== true
    // 分项任务不能被未指定分项的可见类请求升级成全量分析；闲时分析仍应在之后补全。
    if (activeIsPartial && incomingIsUntargeted && options.category === 'visible') return false
    const requiresStructureUpgrade =
      options.includeStructure === true && active.includeStructure !== true
    const requiresFullAnalysisUpgrade =
      options.waveformOnly !== true && active.waveformOnly === true
    const requiresForcedAnalysisUpgrade =
      (options.forceAnalysis === true && active.forceAnalysis !== true) ||
      hasUncoveredForcedReanalysisTarget(active, options)
    const requiresGridModeUpgrade = requiresAnalysisGridModeFollowUp(active, options)
    return (
      requiresStructureUpgrade ||
      requiresFullAnalysisUpgrade ||
      requiresForcedAnalysisUpgrade ||
      requiresGridModeUpgrade
    )
  }

  defer(
    active: KeyAnalysisJob,
    priority: KeyAnalysisPriority,
    source: KeyAnalysisSource,
    options: DeferredRequestOptions,
    focusSlot: string,
    manualBatchIds: string[],
    helpers: DeferredQueueHelpers
  ) {
    const existing = this.jobsByPath.get(active.normalizedPath)
    if (existing) {
      if (requiresAnalysisGridModeFollowUp(existing, options)) {
        // 最新显式模式优先，但复用同一个等待任务：原有 batch / focus / 优先级全部保留。
        const requestedMode = resolveRequestedAnalysisGridMode(options.analysisGridMode)
        if (requestedMode) {
          existing.analysisGridMode = requestedMode
          existing.gridRequestGeneration = helpers.nextGridRequestGeneration(active.normalizedPath)
        }
      }
      if (helpers.isHigherPriority(priority, existing.priority)) {
        existing.priority = priority
        existing.source = source
        if (options.fastAnalysis !== undefined) existing.fastAnalysis = options.fastAnalysis
        if (options.preemptible !== undefined) existing.preemptible = options.preemptible
      }
      helpers.applyQueueCategory(existing, options.category)
      helpers.applyWaveformOnlyOption(existing, options.waveformOnly)
      helpers.applyIncludeStructureOption(existing, options.includeStructure)
      helpers.applyRequestFlags(existing, options)
      helpers.addManualBatchIdsToJob(existing, manualBatchIds)
      helpers.addFocusSlotToJob(existing, focusSlot)
      return
    }

    const deferred = this.buildDeferredJob(
      active,
      priority,
      source,
      options,
      focusSlot,
      manualBatchIds,
      helpers
    )
    this.jobsByPath.set(active.normalizedPath, deferred)
  }

  private buildDeferredJob(
    active: KeyAnalysisJob,
    priority: KeyAnalysisPriority,
    source: KeyAnalysisSource,
    options: DeferredRequestOptions,
    focusSlot: string,
    manualBatchIds: string[],
    helpers: DeferredQueueHelpers
  ): KeyAnalysisJob {
    const explicitMode = resolveRequestedAnalysisGridMode(options.analysisGridMode)
    const job: KeyAnalysisJob = {
      jobId: helpers.nextJobId(),
      filePath: active.filePath,
      normalizedPath: active.normalizedPath,
      priority,
      fastAnalysis: options.fastAnalysis ?? false,
      source,
      preemptible: options.preemptible === true,
      category: options.category,
      waveformOnly: options.waveformOnly === true,
      includeStructure: options.includeStructure === true,
      analysisBpmRange: resolveAnalysisBpmRange(
        options.analysisBpmRangeId,
        active.analysisBpmRange?.id
      ),
      analysisGridMode: explicitMode
        ? explicitMode
        : helpers.resolveGridMode(active.analysisGridMode),
      gridRequestGeneration: helpers.nextGridRequestGeneration(active.normalizedPath),
      forceAnalysis: options.forceAnalysis === true,
      analysisTargets: normalizeKeyAnalysisTargets(options.analysisTargets),
      manualBatchIds: manualBatchIds.length ? manualBatchIds : undefined
    }
    helpers.addFocusSlotToJob(job, focusSlot)
    helpers.applyWaveformOnlyOption(job, options.waveformOnly)
    helpers.applyQueueCategory(job, options.category)
    return job
  }

  promote(
    isBlocked: (normalizedPath: string) => boolean,
    addPending: (job: KeyAnalysisJob) => void
  ) {
    for (const [normalizedPath, job] of Array.from(this.jobsByPath.entries())) {
      if (isBlocked(normalizedPath)) continue
      this.jobsByPath.delete(normalizedPath)
      addPending(job)
    }
  }

  removeManualBatch(batchId: string, helpers: DeferredQueueHelpers) {
    for (const [normalizedPath, job] of Array.from(this.jobsByPath.entries())) {
      if (!helpers.removeManualBatchIdFromJob(job, batchId)) continue
      if (!job.manualBatchIds && helpers.isManualOnlyJob(job)) {
        this.jobsByPath.delete(normalizedPath)
      }
    }
  }

  clearBackground() {
    for (const [normalizedPath, job] of Array.from(this.jobsByPath.entries())) {
      if (job.priority === 'background') this.jobsByPath.delete(normalizedPath)
    }
  }

  clearAll() {
    this.jobsByPath.clear()
  }

  hasForegroundWork() {
    for (const job of this.jobsByPath.values()) {
      if (job.source === 'foreground') return true
    }
    return false
  }

  remap(
    fromNormalizedPath: string,
    toNormalizedPath: string,
    rebindJobPath: (job: KeyAnalysisJob) => void,
    helpers: DeferredQueueHelpers
  ) {
    const deferredJob = this.jobsByPath.get(fromNormalizedPath)
    if (!deferredJob) return
    this.jobsByPath.delete(fromNormalizedPath)
    rebindJobPath(deferredJob)
    const existing = this.jobsByPath.get(toNormalizedPath)
    if (!existing) {
      this.jobsByPath.set(toNormalizedPath, deferredJob)
      return
    }
    helpers.applyIncludeStructureOption(existing, deferredJob.includeStructure)
    helpers.applyWaveformOnlyOption(existing, deferredJob.waveformOnly)
    helpers.applyQueueCategory(existing, deferredJob.category)
    helpers.applyRequestFlags(existing, deferredJob)
    helpers.addManualBatchIdsToJob(existing, deferredJob.manualBatchIds || [])
    for (const focusSlot of deferredJob.focusSlots || []) {
      helpers.addFocusSlotToJob(existing, focusSlot)
    }
  }
}
