import {
  normalizeSongBeatGridMapV2,
  type SongBeatGridFixedProjectionV2,
  type SongBeatGridMapV2
} from '../../../shared/songBeatGridMapV2'
import type {
  DynamicGridMetrics,
  DynamicGridOutcome,
  DynamicGridSuccessOutcome
} from '../../../shared/dynamicBeatGridTypes'
import { convertDynamicAudioGridMapToTimeline } from '../../../shared/dynamicBeatGridCoordinates'

// Dynamic 网格与段落分析本期解耦：worker 只记录未执行原因，不启动首段投影段落。
export const DYNAMIC_GRID_DEFERRED_STRUCTURE_ERROR =
  'structure analysis deferred for dynamic beat grid mode'

const DURATION_MATCH_TOLERANCE_SEC = 0.25
const RATIO_EPSILON = 1e-6

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const toFiniteNumber = (value: unknown): number | undefined => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

/**
 * structured clone / IPC 边界上的原始数值：只接受真正的 number。
 * `Number('4242')`、`Number(true)`、`Number(null)` 都会产生“看起来合法”的假数字，
 * 一旦被当成 PID 或 metrics 会误杀进程 / 误判指标，所以边界不做类型宽松转换。
 */
const readFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const toNonNegativeNumber = (value: unknown): number | undefined => {
  const numeric = toFiniteNumber(value)
  return numeric !== undefined && numeric >= 0 ? numeric : undefined
}

export type DynamicGridPhase = 'scan' | 'refine' | 'fit' | 'persist'

export type DynamicGridProgress = {
  phase: DynamicGridPhase
  completedWindows?: number
  totalWindows?: number
  coveredAudioSec?: number
  canceled?: boolean
  /** 本任务拥有的推理 sidecar PID；main 在 worker 被硬终止时据此精确清理。 */
  sidecarPid?: number | null
}

const isDynamicGridPhase = (value: unknown): value is DynamicGridPhase =>
  value === 'scan' || value === 'refine' || value === 'fit' || value === 'persist'

/** 只读取 sidecar PID 字段：undefined 表示这条进度没有上报，null 表示进程已退出。 */
export const readDynamicGridSidecarPid = (value: unknown): number | null | undefined => {
  if (!isRecord(value) || !('sidecarPid' in value)) return undefined
  // 显式 null 是“进程真实退出”的生命周期信号，必须原样保留。
  if (value.sidecarPid === null) return null
  const numeric = readFiniteNumber(value.sidecarPid)
  if (numeric === undefined || !Number.isInteger(numeric) || numeric <= 0) return undefined
  return numeric
}

export const readDynamicGridProgress = (value: unknown): DynamicGridProgress | undefined => {
  if (!isRecord(value) || !isDynamicGridPhase(value.phase)) return undefined
  const completedWindows = toNonNegativeNumber(value.completedWindows)
  const totalWindows = toNonNegativeNumber(value.totalWindows)
  const coveredAudioSec = toNonNegativeNumber(value.coveredAudioSec)
  const sidecarPid = readDynamicGridSidecarPid(value)
  return {
    phase: value.phase,
    ...(completedWindows === undefined ? {} : { completedWindows }),
    ...(totalWindows === undefined ? {} : { totalWindows }),
    ...(coveredAudioSec === undefined ? {} : { coveredAudioSec }),
    ...(value.canceled === true ? { canceled: true } : {}),
    ...(sidecarPid === undefined ? {} : { sidecarPid })
  }
}

export const isDynamicGridSuccessOutcome = (
  outcome: DynamicGridOutcome
): outcome is DynamicGridSuccessOutcome =>
  outcome.status === 'fixed' || outcome.status === 'dynamic'

const isDynamicGridFailureStatus = (
  value: unknown
): value is 'unresolved' | 'unsupported' | 'cancelled' | 'error' =>
  value === 'unresolved' || value === 'unsupported' || value === 'cancelled' || value === 'error'

const METRIC_COUNT_KEYS = [
  'windowCount',
  'okWindowCount',
  'noBeatWindowCount',
  'evidenceBeatCount',
  'fittedBeatCount',
  'runtimeLineCount',
  'runtimeMatchedBeatCount',
  'runtimeUnmatchedLineCount',
  'runtimeUnmatchedEvidenceCount',
  'runtimeHeadExtrapolatedLineCount',
  'runtimeTailExtrapolatedLineCount',
  'runtimeDownbeatMismatchCount',
  'runtimeBoundaryMismatchCount',
  'excludedBeatCount',
  'inferredMissingBeatCount',
  'extraBeatCount',
  'gapAnomalyCount',
  'unexplainedBeatCount',
  'overlapComparisonCount',
  'overlapMatchedCount',
  'downbeatObservedCount',
  'downbeatConflictCount',
  'clipCount'
] as const

const METRIC_DURATION_KEYS = [
  'scannedDurationAudioSec',
  'noBeatWindowDurationAudioSec',
  'beatEvidenceSpanDurationAudioSec'
] as const

const METRIC_RATIO_KEYS = [
  'scannedCoverageRatio',
  'beatEvidenceSpanRatio',
  'unexplainedBeatRatio',
  'overlapMatchRate'
] as const

const METRIC_MILLISECOND_KEYS = [
  'overlapResidualP95Ms',
  'overlapResidualMaxMs',
  'residualP50Ms',
  'residualP95Ms',
  'residualMaxMs',
  'cumulativePhaseDeviationMaxMs',
  'seamBoundaryErrorMaxMs',
  'tailErrorMs'
] as const

const METRIC_BPM_KEYS = ['requestedMinBpm', 'requestedMaxBpm'] as const

type MetricCountKey = (typeof METRIC_COUNT_KEYS)[number]
type MetricDurationKey = (typeof METRIC_DURATION_KEYS)[number]
type MetricRatioKey = (typeof METRIC_RATIO_KEYS)[number]
type MetricMillisecondKey = (typeof METRIC_MILLISECOND_KEYS)[number]
type MetricBpmKey = (typeof METRIC_BPM_KEYS)[number]

const readMetricGroup = <K extends string>(
  value: Record<string, unknown>,
  keys: readonly K[],
  accept: (numeric: number) => boolean
): Map<K, number> | null => {
  const result = new Map<K, number>()
  for (const key of keys) {
    // metrics 同样来自结构化克隆边界：null / 字符串 / 布尔一律不当作数字。
    const numeric = readFiniteNumber(value[key])
    if (numeric === undefined || !accept(numeric)) return null
    result.set(key, numeric)
  }
  return result
}

/**
 * 指标不是任意键值对象：所有字段必须存在、有限、类型正确，且满足分子/分母关系。
 * 任何一条不满足都返回 undefined，让上层 fail closed。
 */
const readDynamicGridMetrics = (
  value: Record<string, unknown>,
  policyVersion: string,
  status: 'fixed' | 'dynamic'
): DynamicGridMetrics | undefined => {
  const counts = readMetricGroup(
    value,
    METRIC_COUNT_KEYS,
    (numeric) => Number.isInteger(numeric) && numeric >= 0
  )
  if (!counts) return undefined
  const durations = readMetricGroup(value, METRIC_DURATION_KEYS, (numeric) => numeric >= 0)
  if (!durations) return undefined
  const ratios = readMetricGroup(
    value,
    METRIC_RATIO_KEYS,
    (numeric) => numeric >= -RATIO_EPSILON && numeric <= 1 + RATIO_EPSILON
  )
  if (!ratios) return undefined
  const milliseconds = readMetricGroup(value, METRIC_MILLISECOND_KEYS, (numeric) => numeric >= 0)
  if (!milliseconds) return undefined
  const bpms = readMetricGroup(value, METRIC_BPM_KEYS, (numeric) => numeric > 0)
  if (!bpms) return undefined
  if (typeof value.policyVersion === 'string' && value.policyVersion !== policyVersion) {
    return undefined
  }
  const count = (key: MetricCountKey) => counts.get(key) as number
  if (count('okWindowCount') + count('noBeatWindowCount') !== count('windowCount')) return undefined
  if (count('overlapMatchedCount') > count('overlapComparisonCount')) return undefined
  if (count('runtimeMatchedBeatCount') > count('runtimeLineCount')) return undefined
  if (count('runtimeMatchedBeatCount') > count('evidenceBeatCount')) return undefined
  // A 的 runtime 审计不变量：拟合拍 + 推断缺失 + 头/尾外推 = runtime line 总数。
  if (
    count('fittedBeatCount') +
      count('inferredMissingBeatCount') +
      count('runtimeHeadExtrapolatedLineCount') +
      count('runtimeTailExtrapolatedLineCount') !==
    count('runtimeLineCount')
  ) {
    return undefined
  }
  if (count('clipCount') < 1) return undefined
  if (status === 'fixed' && count('clipCount') !== 1) return undefined
  if (status === 'dynamic' && count('clipCount') < 2) return undefined
  const duration = (key: MetricDurationKey) => durations.get(key) as number
  if (duration('scannedDurationAudioSec') < duration('beatEvidenceSpanDurationAudioSec')) {
    return undefined
  }
  const ratio = (key: MetricRatioKey) => ratios.get(key) as number
  const millisecondsOf = (key: MetricMillisecondKey) => milliseconds.get(key) as number
  const bpm = (key: MetricBpmKey) => bpms.get(key) as number
  return {
    policyVersion,
    windowCount: count('windowCount'),
    okWindowCount: count('okWindowCount'),
    noBeatWindowCount: count('noBeatWindowCount'),
    scannedDurationAudioSec: duration('scannedDurationAudioSec'),
    scannedCoverageRatio: ratio('scannedCoverageRatio'),
    noBeatWindowDurationAudioSec: duration('noBeatWindowDurationAudioSec'),
    beatEvidenceSpanDurationAudioSec: duration('beatEvidenceSpanDurationAudioSec'),
    beatEvidenceSpanRatio: ratio('beatEvidenceSpanRatio'),
    evidenceBeatCount: count('evidenceBeatCount'),
    fittedBeatCount: count('fittedBeatCount'),
    runtimeLineCount: count('runtimeLineCount'),
    runtimeMatchedBeatCount: count('runtimeMatchedBeatCount'),
    runtimeUnmatchedLineCount: count('runtimeUnmatchedLineCount'),
    runtimeUnmatchedEvidenceCount: count('runtimeUnmatchedEvidenceCount'),
    runtimeHeadExtrapolatedLineCount: count('runtimeHeadExtrapolatedLineCount'),
    runtimeTailExtrapolatedLineCount: count('runtimeTailExtrapolatedLineCount'),
    runtimeDownbeatMismatchCount: count('runtimeDownbeatMismatchCount'),
    runtimeBoundaryMismatchCount: count('runtimeBoundaryMismatchCount'),
    excludedBeatCount: count('excludedBeatCount'),
    inferredMissingBeatCount: count('inferredMissingBeatCount'),
    extraBeatCount: count('extraBeatCount'),
    gapAnomalyCount: count('gapAnomalyCount'),
    unexplainedBeatCount: count('unexplainedBeatCount'),
    unexplainedBeatRatio: ratio('unexplainedBeatRatio'),
    overlapComparisonCount: count('overlapComparisonCount'),
    overlapMatchedCount: count('overlapMatchedCount'),
    overlapMatchRate: ratio('overlapMatchRate'),
    overlapResidualP95Ms: millisecondsOf('overlapResidualP95Ms'),
    overlapResidualMaxMs: millisecondsOf('overlapResidualMaxMs'),
    residualP50Ms: millisecondsOf('residualP50Ms'),
    residualP95Ms: millisecondsOf('residualP95Ms'),
    residualMaxMs: millisecondsOf('residualMaxMs'),
    cumulativePhaseDeviationMaxMs: millisecondsOf('cumulativePhaseDeviationMaxMs'),
    seamBoundaryErrorMaxMs: millisecondsOf('seamBoundaryErrorMaxMs'),
    tailErrorMs: millisecondsOf('tailErrorMs'),
    downbeatObservedCount: count('downbeatObservedCount'),
    downbeatConflictCount: count('downbeatConflictCount'),
    clipCount: count('clipCount'),
    requestedMinBpm: bpm('requestedMinBpm'),
    requestedMaxBpm: bpm('requestedMaxBpm')
  }
}

/**
 * 跨 worker 的 outcome 来自结构化克隆，这里再做一次边界收敛，
 * 保证持久化不会拿到缺少 map / 时长 / 指标的“成功”结果。
 */
export const readDynamicGridOutcome = (value: unknown): DynamicGridOutcome | undefined => {
  if (!isRecord(value)) return undefined
  if (isDynamicGridFailureStatus(value.status)) {
    const reason =
      typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : 'unknown'
    return { status: value.status, reason }
  }
  if (value.status !== 'fixed' && value.status !== 'dynamic') return undefined
  if (value.coordinate !== 'audio') return undefined
  const beatGridMap = normalizeSongBeatGridMapV2(value.beatGridMap, { allowSingleClip: true })
  if (!beatGridMap) return undefined
  if (beatGridMap.source !== 'analysis') return undefined
  const durationAudioSec = readFiniteNumber(value.durationAudioSec)
  if (durationAudioSec === undefined || durationAudioSec <= 0) return undefined
  const policyVersion = typeof value.policyVersion === 'string' ? value.policyVersion.trim() : ''
  if (!policyVersion) return undefined
  if (!isRecord(value.metrics)) return undefined
  const metrics = readDynamicGridMetrics(value.metrics, policyVersion, value.status)
  if (!metrics) return undefined
  if (metrics.clipCount !== beatGridMap.clips.length) return undefined
  const lastClip = beatGridMap.clips[beatGridMap.clips.length - 1]
  if (lastClip.startSec >= durationAudioSec) return undefined
  if (metrics.scannedDurationAudioSec > durationAudioSec + DURATION_MATCH_TOLERANCE_SEC) {
    return undefined
  }
  return {
    status: value.status,
    coordinate: 'audio',
    beatGridMap,
    durationAudioSec,
    policyVersion,
    metrics
  }
}

export const buildDynamicGridFailureDetail = (outcome: DynamicGridOutcome): string => {
  if (isDynamicGridSuccessOutcome(outcome)) return ''
  return `dynamic-grid ${outcome.status}: ${outcome.reason}`
}

/** 从 worker result / 中途 partialResult 中读取完整 outcome。 */
export const readDynamicGridOutcomeFromResult = (
  value: unknown
): DynamicGridOutcome | undefined => {
  if (!isRecord(value)) return undefined
  return readDynamicGridOutcome(value.dynamicGridOutcome)
}

/** job 上的请求模式；字段由 queue/workerDispatch 透传。 */
export const readAnalysisGridMode = (value: unknown): 'normal' | 'dynamic' | undefined => {
  if (!isRecord(value)) return undefined
  const mode = value.analysisGridMode
  return mode === 'normal' || mode === 'dynamic' ? mode : undefined
}

export type DynamicGridTimelineDefinition = {
  status: 'fixed' | 'dynamic'
  policyVersion: string
  map: SongBeatGridMapV2
  projection: SongBeatGridFixedProjectionV2
  durationAudioSec: number
  timelineDurationSec: number
  timeBasisOffsetMs: number
}

export type DynamicGridTimelineResult =
  { ok: true; value: DynamicGridTimelineDefinition } | { ok: false; reason: string }

/**
 * audio outcome → timeline 定义。转换只发生在 shared 的同源 helper 中，
 * 非法/缺失偏移不会被静默归零。
 */
export const resolveDynamicGridTimelineDefinition = (params: {
  outcome: DynamicGridOutcome
  timeBasisOffsetMs?: number
  expectedDurationAudioSec?: number
}): DynamicGridTimelineResult => {
  const outcome = params.outcome
  if (!isDynamicGridSuccessOutcome(outcome)) {
    return { ok: false, reason: `status:${outcome.status}:${outcome.reason}` }
  }
  const audioMap = normalizeSongBeatGridMapV2(outcome.beatGridMap, { allowSingleClip: true })
  if (!audioMap) return { ok: false, reason: 'invalid-audio-map' }
  const durationAudioSec = Number(outcome.durationAudioSec)
  if (!Number.isFinite(durationAudioSec) || durationAudioSec <= 0) {
    return { ok: false, reason: 'invalid-audio-duration' }
  }
  const expectedDuration = Number(params.expectedDurationAudioSec)
  if (
    Number.isFinite(expectedDuration) &&
    expectedDuration > 0 &&
    Math.abs(expectedDuration - durationAudioSec) > DURATION_MATCH_TOLERANCE_SEC
  ) {
    return { ok: false, reason: 'audio-duration-mismatch' }
  }
  if (outcome.status === 'fixed' && audioMap.clips.length !== 1) {
    return { ok: false, reason: 'fixed-requires-single-clip' }
  }
  if (outcome.status === 'dynamic' && audioMap.clips.length < 2) {
    return { ok: false, reason: 'dynamic-requires-multi-clip' }
  }
  const lastClip = audioMap.clips[audioMap.clips.length - 1]
  if (lastClip.startSec >= durationAudioSec) {
    return { ok: false, reason: 'audio-clip-out-of-range' }
  }
  const timeBasisOffsetMs = Number(params.timeBasisOffsetMs)
  if (!Number.isFinite(timeBasisOffsetMs) || timeBasisOffsetMs < 0) {
    return { ok: false, reason: 'invalid-time-basis-offset' }
  }
  const conversion = convertDynamicAudioGridMapToTimeline({
    beatGridMap: audioMap,
    audioDurationSec: durationAudioSec,
    timeBasisOffsetMs
  })
  if (conversion.status === 'error') return { ok: false, reason: conversion.reason }
  if (conversion.projection.firstBeatMs >= conversion.durationSec * 1000) {
    return { ok: false, reason: 'timeline-first-beat-out-of-range' }
  }
  return {
    ok: true,
    value: {
      status: outcome.status,
      policyVersion: outcome.policyVersion,
      map: conversion.map,
      projection: conversion.projection,
      durationAudioSec,
      timelineDurationSec: conversion.durationSec,
      timeBasisOffsetMs
    }
  }
}
