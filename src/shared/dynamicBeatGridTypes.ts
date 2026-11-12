import type { SongBeatGridFixedProjectionV2, SongBeatGridMapV2 } from './songBeatGridMapV2'

export type DynamicBeatWindowStatus = 'ok' | 'no-beats'

/**
 * 单个窗口的拍点证据。时间全部是整曲 audio 坐标（秒），由 Python bridge 完成
 * “窗口局部时间 + 块内起点 + 实际块 audio 起点”的转换后返回；TS 不再重复加偏移。
 */
export type DynamicBeatWindowEvidence = {
  windowId: string
  startAudioSec: number
  analyzedDurationSec: number
  status: DynamicBeatWindowStatus
  beatsAudioSec: number[]
  downbeatsAudioSec: number[]
}

export type DynamicBeatGridWindowPlanEntry = {
  windowId: string
  startAudioSec: number
  durationSec: number
}

export const DYNAMIC_BEAT_GRID_POLICY_VERSION = 'dynamic-grid-experimental-2026-11-12.2'

export const DYNAMIC_BEAT_GRID_EXPERIMENTAL_CALIBRATION = 'experimental-uncalibrated' as const

/**
 * 这里的阈值全部是合成/离线 fixture 上的实验起点。真实音频尚未标定，
 * 不得把本 policy 当成生产准确率、发布门槛或已验收能力。
 */
export type DynamicBeatGridPolicy = {
  version: string
  calibrationStatus: typeof DYNAMIC_BEAT_GRID_EXPERIMENTAL_CALIBRATION
  calibrationNote: string
  windowDurationSec: number
  windowStepSec: number
  blockDurationSec: number
  blockOverlapSec: number
  minInferenceWindowSec: number
  minOverlapToleranceSec: number
  maxOverlapToleranceSec: number
  overlapToleranceIntervalRatio: number
  p95ResidualMs: number
  maxResidualMs: number
  maxUnexplainedBeatRatio: number
  minOverlapMatchRate: number
  minOverlapComparisonCount: number
  minScannedCoverageRatio: number
  minTotalBeats: number
  minDownbeatEvidenceCount: number
  minSegmentBeats: number
  segmentMaxRmsMs: number
  segmentMinRmsMs: number
  segmentRmsRetryFactor: number
  segmentRmsRetryCount: number
  segmentBoundaryEpsilonSec: number
  maxHeadTailExtrapolatedBeats: number
  maxClips: number
  maxWindows: number
  maxBeats: number
  maxObservations: number
  maxBeatsPerWindow: number
  maxInferredGapBeats: number
  downbeatMatchToleranceSec: number
  defaultMinBpm: number
  defaultMaxBpm: number
}

export const DYNAMIC_BEAT_GRID_POLICY: DynamicBeatGridPolicy = {
  version: DYNAMIC_BEAT_GRID_POLICY_VERSION,
  calibrationStatus: DYNAMIC_BEAT_GRID_EXPERIMENTAL_CALIBRATION,
  calibrationNote:
    'Experimental thresholds; not calibrated against real audio. Do not treat as production accuracy.',
  windowDurationSec: 30,
  windowStepSec: 15,
  blockDurationSec: 120,
  blockOverlapSec: 15,
  minInferenceWindowSec: 8,
  minOverlapToleranceSec: 0.03,
  maxOverlapToleranceSec: 0.12,
  overlapToleranceIntervalRatio: 0.35,
  p95ResidualMs: 15,
  maxResidualMs: 40,
  maxUnexplainedBeatRatio: 0.02,
  minOverlapMatchRate: 0.95,
  minOverlapComparisonCount: 4,
  minScannedCoverageRatio: 0.98,
  minTotalBeats: 8,
  minDownbeatEvidenceCount: 2,
  minSegmentBeats: 16,
  segmentMaxRmsMs: 5,
  segmentMinRmsMs: 0.05,
  segmentRmsRetryFactor: 0.5,
  segmentRmsRetryCount: 4,
  segmentBoundaryEpsilonSec: 0.0001,
  maxHeadTailExtrapolatedBeats: 1,
  maxClips: 128,
  maxWindows: 512,
  maxBeats: 4000,
  maxObservations: 20000,
  maxBeatsPerWindow: 2048,
  maxInferredGapBeats: 8,
  downbeatMatchToleranceSec: 0.03,
  defaultMinBpm: 70,
  defaultMaxBpm: 180
}

/**
 * 分析成功指标。所有比例都能从同一结构里的分子/分母字段复算，不包含概率或
 * 未定义置信度。扫描覆盖与“有拍点证据的跨度”分开记录，残差和漏/多拍来自
 * 最终 runtime.lines 对证据的一对一校验，而不是只看分段拟合对象。
 */
export type DynamicGridMetrics = {
  policyVersion: string
  windowCount: number
  okWindowCount: number
  noBeatWindowCount: number
  scannedDurationAudioSec: number
  scannedCoverageRatio: number
  noBeatWindowDurationAudioSec: number
  beatEvidenceSpanDurationAudioSec: number
  beatEvidenceSpanRatio: number
  evidenceBeatCount: number
  fittedBeatCount: number
  runtimeLineCount: number
  runtimeMatchedBeatCount: number
  runtimeUnmatchedLineCount: number
  runtimeUnmatchedEvidenceCount: number
  runtimeHeadExtrapolatedLineCount: number
  runtimeTailExtrapolatedLineCount: number
  runtimeDownbeatMismatchCount: number
  runtimeBoundaryMismatchCount: number
  excludedBeatCount: number
  inferredMissingBeatCount: number
  extraBeatCount: number
  gapAnomalyCount: number
  unexplainedBeatCount: number
  unexplainedBeatRatio: number
  overlapComparisonCount: number
  overlapMatchedCount: number
  overlapMatchRate: number
  overlapResidualP95Ms: number
  overlapResidualMaxMs: number
  residualP50Ms: number
  residualP95Ms: number
  residualMaxMs: number
  cumulativePhaseDeviationMaxMs: number
  seamBoundaryErrorMaxMs: number
  tailErrorMs: number
  downbeatObservedCount: number
  downbeatConflictCount: number
  clipCount: number
  requestedMinBpm: number
  requestedMaxBpm: number
}

export type DynamicGridSuccessOutcome = {
  status: 'fixed' | 'dynamic'
  coordinate: 'audio'
  beatGridMap: SongBeatGridMapV2
  durationAudioSec: number
  policyVersion: string
  metrics: DynamicGridMetrics
}

export type DynamicGridFailureStatus = 'unresolved' | 'unsupported' | 'cancelled' | 'error'

export type DynamicGridFailureOutcome = {
  status: DynamicGridFailureStatus
  reason: string
}

export type DynamicGridOutcome = DynamicGridSuccessOutcome | DynamicGridFailureOutcome

export type DynamicGridCoordinateConversionResult =
  | {
      status: 'ok'
      map: SongBeatGridMapV2
      durationSec: number
      projection: SongBeatGridFixedProjectionV2
    }
  | {
      status: 'error'
      reason: string
    }
