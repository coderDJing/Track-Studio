import type {
  KeyAnalysisJob,
  KeyAnalysisPriority,
  KeyAnalysisQueueCategory,
  KeyAnalysisRequestFlags,
  KeyAnalysisSource,
  KeyAnalysisTargets
} from './types'
import type { AnalysisBpmRangePresetId } from '../../../shared/analysisBpmRange'
import {
  DEFAULT_ANALYSIS_GRID_MODE,
  isAnalysisGridMode,
  type AnalysisGridMode
} from '../../../shared/analysisGridMode'
import { mergeKeyAnalysisTargets, normalizeKeyAnalysisTargets } from './analysisTargets'

export type KeyAnalysisEnqueueOptions = KeyAnalysisRequestFlags & {
  urgent?: boolean
  source?: KeyAnalysisSource
  fastAnalysis?: boolean
  focusSlot?: string
  preemptible?: boolean
  category?: KeyAnalysisQueueCategory
  waveformOnly?: boolean
  includeStructure?: boolean
  analysisBpmRangeId?: AnalysisBpmRangePresetId
  /** 显式请求的网格模式；缺省时由队列按“已有任务 → 全局设置 → normal”解析并冻结。 */
  analysisGridMode?: AnalysisGridMode
  manualBatchId?: string
  manualBatchIds?: string[]
}

export const isHigherKeyAnalysisPriority = (
  next: KeyAnalysisPriority,
  current: KeyAnalysisPriority
) => {
  const rank: Record<KeyAnalysisPriority, number> = {
    high: 4,
    medium: 3,
    low: 2,
    background: 1
  }
  return rank[next] > rank[current]
}

export const normalizeKeyAnalysisFocusSlot = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

export const applyKeyAnalysisWaveformOnlyOption = (job: KeyAnalysisJob, waveformOnly?: boolean) => {
  if (waveformOnly !== true) {
    if (waveformOnly === false || job.waveformOnly) job.waveformOnly = false
    return
  }
  if (job.waveformOnly === true) job.waveformOnly = true
}

export const applyKeyAnalysisQueueCategory = (
  job: KeyAnalysisJob,
  category?: KeyAnalysisQueueCategory
) => {
  if (!category) return
  if (job.category === 'manual-batch' && category !== 'manual-batch') return
  if (job.priority === 'high' && category === 'visible') return
  if (job.category === 'visible' && category === 'waveform-preview') return
  job.category = category
}

export const applyKeyAnalysisIncludeStructureOption = (
  job: KeyAnalysisJob,
  includeStructure?: boolean
) => {
  if (includeStructure === true) job.includeStructure = true
}

export const applyKeyAnalysisRequestFlags = (
  job: KeyAnalysisJob,
  flags: KeyAnalysisRequestFlags
) => {
  if (flags.forceAnalysis === true) job.forceAnalysis = true
  if (flags.analysisTargets) {
    job.analysisTargets = mergeKeyAnalysisTargets(job.analysisTargets, flags.analysisTargets)
  }
}

export const normalizeManualBatchIds = (options: {
  manualBatchId?: string
  manualBatchIds?: string[]
}) => {
  const ids = [options.manualBatchId, ...(options.manualBatchIds || [])]
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)))
}

export const addManualBatchIdsToJob = (job: KeyAnalysisJob, batchIds: string[]) => {
  if (!batchIds.length) return
  const current = Array.isArray(job.manualBatchIds) ? job.manualBatchIds.filter(Boolean) : []
  job.manualBatchIds = Array.from(new Set([...current, ...batchIds]))
}

export const removeManualBatchIdFromJob = (job: KeyAnalysisJob, batchId: string) => {
  const current = job.manualBatchIds?.filter(Boolean) || []
  if (!current.includes(batchId)) return false
  const next = current.filter((id) => id !== batchId)
  job.manualBatchIds = next.length ? next : undefined
  return true
}

export const resolveRequestedAnalysisGridMode = (value: unknown): AnalysisGridMode | undefined =>
  isAnalysisGridMode(value) ? value : undefined

/** 本次请求是否明确要求重算 BPM / 网格（模式差异只有在这种请求下才需要跟进任务）。 */
export const requestTargetsGridReanalysis = (options: {
  forceAnalysis?: boolean
  analysisTargets?: KeyAnalysisTargets
}) => options.forceAnalysis === true || options.analysisTargets?.bpm === true

/** 显式模式与在场任务不同且本次确实要重算网格时，需要排队跟进任务。 */
export const requiresAnalysisGridModeFollowUp = (
  active: Pick<KeyAnalysisJob, 'analysisGridMode'>,
  options: Pick<KeyAnalysisEnqueueOptions, 'forceAnalysis' | 'analysisTargets' | 'analysisGridMode'>
) => {
  const requested = resolveRequestedAnalysisGridMode(options.analysisGridMode)
  if (!requested || !requestTargetsGridReanalysis(options)) return false
  return (active.analysisGridMode || DEFAULT_ANALYSIS_GRID_MODE) !== requested
}

/**
 * Dynamic 网格任务只隔离尚未适配的段落阶段，并把强制分析收窄回调用方明确勾选的目标。
 * 能量仍在本期范围，必须保留给适配实现。
 * 返回是否改动了任务 needs。
 */
export const narrowKeyAnalysisNeedsForDynamicGrid = (job: KeyAnalysisJob): boolean => {
  if (job.analysisGridMode !== 'dynamic' || job.needsBpm !== true) return false
  job.needsStructure = false
  const targets = normalizeKeyAnalysisTargets(job.analysisTargets)
  if (targets) {
    if (targets.key !== true) job.needsKey = false
    if (targets.waveform !== true) job.needsWaveform = false
    if (targets.energy !== true) job.needsEnergy = false
  }
  return true
}

/** 待执行任务收到新的显式模式：原地更新，保留全部旧等待方，并推进请求代次。 */
export const applyPendingAnalysisGridModeReRequest = (
  job: KeyAnalysisJob,
  options: Pick<
    KeyAnalysisEnqueueOptions,
    'forceAnalysis' | 'analysisTargets' | 'analysisGridMode'
  >,
  nextGeneration: () => number
): boolean => {
  const requested = resolveRequestedAnalysisGridMode(options.analysisGridMode)
  if (!requested || !requiresAnalysisGridModeFollowUp(job, options)) return false
  job.analysisGridMode = requested
  job.gridRequestGeneration = nextGeneration()
  return true
}

/**
 * 把新的请求选项合并进同路径已有的 pending 任务，保留旧等待方（batch、focus slot、优先级）。
 * 只用于尚未执行的任务；模式与代次由调用方在冻结点更新。
 */
export const applyKeyAnalysisReRequestOptions = (
  job: KeyAnalysisJob,
  options: KeyAnalysisEnqueueOptions,
  priority: KeyAnalysisPriority,
  source: KeyAnalysisSource,
  manualBatchIds: string[]
) => {
  if (options.fastAnalysis !== undefined) job.fastAnalysis = options.fastAnalysis
  if (options.preemptible !== undefined) job.preemptible = options.preemptible
  if (isHigherKeyAnalysisPriority(priority, job.priority)) {
    job.priority = priority
    job.source = source
  }
  applyKeyAnalysisQueueCategory(job, options.category)
  applyKeyAnalysisWaveformOnlyOption(job, options.waveformOnly)
  applyKeyAnalysisIncludeStructureOption(job, options.includeStructure)
  applyKeyAnalysisRequestFlags(job, options)
  addManualBatchIdsToJob(job, manualBatchIds)
}

/** 主集成交接：任务仍对应当前路径代次时才算有效结果。 */
export const isCurrentKeyAnalysisGridRequestGeneration = (
  job: Pick<KeyAnalysisJob, 'gridRequestGeneration'>,
  currentGeneration: number | undefined
) =>
  typeof job.gridRequestGeneration === 'number' &&
  typeof currentGeneration === 'number' &&
  job.gridRequestGeneration === currentGeneration

export type KeyAnalysisGridCommitCheck = {
  mode: AnalysisGridMode
  generation: number | undefined
  isCurrent: boolean
}

/**
 * 提交前检查 API（workerPool / persistence 的 shouldPersist 侧使用）：
 * 只在 mode 与代次都匹配当前路径状态时才允许落库，旧任务/不同模式结果直接丢弃。
 */
export const buildKeyAnalysisGridCommitCheck = (
  job: Pick<KeyAnalysisJob, 'analysisGridMode' | 'gridRequestGeneration'>,
  current: { generation: number | undefined }
): KeyAnalysisGridCommitCheck => ({
  mode: job.analysisGridMode || DEFAULT_ANALYSIS_GRID_MODE,
  generation: job.gridRequestGeneration,
  isCurrent: isCurrentKeyAnalysisGridRequestGeneration(job, current.generation)
})
