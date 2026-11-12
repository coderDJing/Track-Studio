import type {
  DynamicGridMetrics,
  DynamicGridSuccessOutcome
} from '../../../shared/dynamicBeatGridTypes'
import type { SongBeatGridMapV2 } from '../../../shared/songBeatGridMapV2'

export const DYNAMIC_TEST_METRICS: DynamicGridMetrics = {
  policyVersion: 'dynamic-test-policy',
  windowCount: 2,
  okWindowCount: 2,
  noBeatWindowCount: 0,
  scannedDurationAudioSec: 120,
  scannedCoverageRatio: 1,
  noBeatWindowDurationAudioSec: 0,
  beatEvidenceSpanDurationAudioSec: 120,
  beatEvidenceSpanRatio: 1,
  evidenceBeatCount: 8,
  fittedBeatCount: 8,
  runtimeLineCount: 8,
  runtimeMatchedBeatCount: 8,
  runtimeUnmatchedLineCount: 0,
  runtimeUnmatchedEvidenceCount: 0,
  runtimeHeadExtrapolatedLineCount: 0,
  runtimeTailExtrapolatedLineCount: 0,
  runtimeDownbeatMismatchCount: 0,
  runtimeBoundaryMismatchCount: 0,
  excludedBeatCount: 0,
  inferredMissingBeatCount: 0,
  extraBeatCount: 0,
  gapAnomalyCount: 0,
  unexplainedBeatCount: 0,
  unexplainedBeatRatio: 0,
  overlapComparisonCount: 0,
  overlapMatchedCount: 0,
  overlapMatchRate: 1,
  overlapResidualP95Ms: 0,
  overlapResidualMaxMs: 0,
  residualP50Ms: 0,
  residualP95Ms: 0,
  residualMaxMs: 0,
  cumulativePhaseDeviationMaxMs: 0,
  seamBoundaryErrorMaxMs: 0,
  tailErrorMs: 0,
  downbeatObservedCount: 4,
  downbeatConflictCount: 0,
  clipCount: 2,
  requestedMinBpm: 70,
  requestedMaxBpm: 180
}

export const buildDynamicSuccessOutcome = (
  beatGridMap: SongBeatGridMapV2,
  durationAudioSec = 120
): DynamicGridSuccessOutcome => ({
  status: 'dynamic',
  coordinate: 'audio',
  beatGridMap,
  durationAudioSec,
  policyVersion: 'dynamic-test-policy',
  metrics: DYNAMIC_TEST_METRICS
})
