import type { SongBeatGridQuality } from './beatGridQuality'
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

export const DYNAMIC_BEAT_GRID_POLICY_VERSION = 'dynamic-grid-experimental-2026-11-25.1'

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
  maxDownbeatConflictRatio: number
  maxOctaveConflictRatio: number
  /**
   * 节拍间隔无法解析成 1 或 2 拍的比例上限。
   *
   * 之前是「有一处就作废」，实测正常曲目也有零星模糊间隔。
   */
  maxAmbiguousGapRatio: number
  /** 运行时网格与证据的 downbeat 相位错配占比上限。 */
  maxDownbeatMismatchRatio: number
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
  /**
   * 单段拟合的残差 p95 上限（毫秒）。
   *
   * 实测真实音频的拍点检测抖动在 10ms 量级，15ms 太紧：大量正常曲目会因为
   * p95 落在 15~17ms 之间被判失败。18ms 是按实测分布放宽后的值。
   */
  p95ResidualMs: 18,
  maxResidualMs: 40,
  maxUnexplainedBeatRatio: 0.02,
  /**
   * downbeat 相位冲突占比上限。
   *
   * 之前是「有任何一个 downbeat 相位对不上就整张网格作废」，实测命中值有 1（纯噪声）
   也有 57（相位完全是乱的）。按比例判定才能同时放过噪声、拦住真错。
   */
  maxDownbeatConflictRatio: 0.15,
  /**
   * 相邻窗口八度歧义占比上限。
   *
   * 同样从零容忍改为比例：少量窗口对出现八度歧义是噪声，超过这个比例才说明
   * 整条网格的拍点归属本身不可靠。
   */
  maxOctaveConflictRatio: 0.25,
  /**
   * 节拍间隔无法解析成 1 或 2 拍的比例上限。
   *
   * 之前是「有一处就作废」，实测正常曲目也有零星模糊间隔。
   */
  maxAmbiguousGapRatio: 0.05,
  /**
   * 运行时网格与证据的 downbeat 相位错配占比上限。
   *
   * 之前是「错一个就作废」，实测正常曲目也会偶发错配。
   */
  maxDownbeatMismatchRatio: 0.1,
  minOverlapMatchRate: 0.85,
  minOverlapComparisonCount: 4,
  minScannedCoverageRatio: 0.98,
  minTotalBeats: 8,
  minDownbeatEvidenceCount: 2,
  minSegmentBeats: 16,
  /**
   * 分段 DP 的预筛门槛：段内原始 RMS 的上限（毫秒）。
   *
   * 必须与最终判定（evaluateFit 的 p95ResidualMs）同尺度，否则 DP 会把
   * 「剔掉离群点后完全合格」的段直接拒掉，导致动态网格在真实音频上永远拟合不出
   * 东西——拍点检测本身的抖动就有 10ms 量级，5ms 的门槛低于噪声底噪。
   */
  segmentMaxRmsMs: 18,
  segmentMinRmsMs: 0.05,
  segmentRmsRetryFactor: 0.5,
  segmentRmsRetryCount: 4,
  segmentBoundaryEpsilonSec: 0.0001,
  /**
   * 网格在首尾允许外推的拍数预算。
   *
   * 之前只有 1 拍，且要求每个外推点距最后一个匹配拍不超过 1.5 拍——这会把
   * 「前奏/尾奏本来就没有鼓点」误判成检测器丢拍。改成用拍数预算约束后，
   * 节拍稀疏的首尾能通过，而真的丢拍（外推远超预算）仍然会被拦下。
   */
  maxHeadTailExtrapolatedBeats: 32,
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
  /**
   * 网格质量标记：拟合通过但接近 reject 阈值时标出来，提醒用户听一遍。
   * 落库时会补上 timeline 坐标的 sinceSec。
   */
  quality?: SongBeatGridQuality
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
