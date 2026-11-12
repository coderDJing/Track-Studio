import {
  createSongBeatGridMapV2FromClips,
  createSongBeatGridRuntimeV2,
  type SongBeatGridClipV2,
  type SongBeatGridMapV2
} from './songBeatGridMapV2'
import {
  DYNAMIC_BEAT_GRID_POLICY,
  type DynamicBeatGridPolicy,
  type DynamicBeatGridWindowPlanEntry,
  type DynamicBeatWindowEvidence,
  type DynamicGridMetrics,
  type DynamicGridOutcome
} from './dynamicBeatGridTypes'
import {
  mergeDynamicBeatGridWindowEvidence,
  type DynamicEvidenceMetrics
} from './dynamicBeatGridEvidence'
import {
  fitSegmentedDynamicBeatGrid,
  fitSingleDynamicBeatGrid,
  type DynamicFitPoint,
  type DynamicSegmentFit
} from './dynamicBeatGridFit'
import {
  auditDynamicBeatGridRuntime,
  type DynamicRuntimeAudit
} from './dynamicBeatGridRuntimeAudit'

const TIME_EPSILON_SEC = 1e-6

const roundSec = (value: number): number => Number(value.toFixed(6))

const moduloFour = (value: number): number => ((value % 4) + 4) % 4

const readFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const resolveBpm = (value: unknown, fallback: number): number | null => {
  if (value === undefined) return fallback
  const numeric = readFiniteNumber(value)
  return numeric !== null && numeric > 0 ? numeric : null
}

/**
 * 30s 窗、15s 步长；尾部剩余部分不是单独的小于 8s 窗口，而是从最后一个完整窗
 * 的下一个 15s 网格点开始，生成一个结束于真实曲尾、时长在 (15, 30] 内的尾窗。
 * 所有窗口起点都落在 15s 网格上，因此可被 120s 块 + 15s 重叠的块计划容纳。
 */
export const createDynamicBeatGridWindowPlan = (
  durationAudioSec: number
): DynamicBeatGridWindowPlanEntry[] => {
  const policy = DYNAMIC_BEAT_GRID_POLICY
  const duration = readFiniteNumber(durationAudioSec)
  if (duration === null || duration < policy.minInferenceWindowSec) return []
  const totalDuration = roundSec(duration)

  const entries: DynamicBeatGridWindowPlanEntry[] = []
  if (totalDuration <= policy.windowDurationSec) {
    entries.push({
      windowId: 'dynamic-window-0',
      startAudioSec: 0,
      durationSec: totalDuration
    })
    return entries
  }

  const fullWindowCount =
    Math.floor((totalDuration - policy.windowDurationSec) / policy.windowStepSec) + 1
  for (let index = 0; index < fullWindowCount; index += 1) {
    entries.push({
      windowId: `dynamic-window-${index}`,
      startAudioSec: roundSec(index * policy.windowStepSec),
      durationSec: policy.windowDurationSec
    })
  }

  const lastFullStart = (fullWindowCount - 1) * policy.windowStepSec
  const lastFullEnd = lastFullStart + policy.windowDurationSec
  if (totalDuration - lastFullEnd > TIME_EPSILON_SEC) {
    const tailStart = lastFullStart + policy.windowStepSec
    entries.push({
      windowId: `dynamic-window-${entries.length}`,
      startAudioSec: roundSec(tailStart),
      durationSec: roundSec(totalDuration - tailStart)
    })
  }
  return entries
}

const buildMetrics = (params: {
  evidenceMetrics: DynamicEvidenceMetrics
  fits: readonly DynamicSegmentFit[]
  points: readonly DynamicFitPoint[]
  audit: DynamicRuntimeAudit
  durationAudioSec: number
  minBpm: number
  maxBpm: number
  policy: DynamicBeatGridPolicy
}): DynamicGridMetrics => {
  const { evidenceMetrics, fits, points, audit, durationAudioSec, minBpm, maxBpm, policy } = params
  const excludedBeatCount = fits.reduce((total, fit) => total + fit.excludedCount, 0)
  const firstBeatSec = points.length ? points[0].timeSec : 0
  const lastBeatSec = points.length ? points[points.length - 1].timeSec : 0
  const beatEvidenceSpanDurationAudioSec = points.length
    ? Math.max(0, lastBeatSec - firstBeatSec)
    : 0
  const unexplainedBeatCount =
    excludedBeatCount +
    evidenceMetrics.inferredMissingBeatCount +
    evidenceMetrics.extraBeatCount +
    evidenceMetrics.gapAnomalyCount +
    audit.unmatchedHeadLineCount +
    audit.unmatchedTailLineCount +
    audit.downbeatMismatchCount +
    audit.boundaryMismatchCount
  return {
    policyVersion: policy.version,
    windowCount: evidenceMetrics.windowCount,
    okWindowCount: evidenceMetrics.okWindowCount,
    noBeatWindowCount: evidenceMetrics.noBeatWindowCount,
    scannedDurationAudioSec: evidenceMetrics.scannedDurationAudioSec,
    scannedCoverageRatio: evidenceMetrics.scannedCoverageRatio,
    noBeatWindowDurationAudioSec: evidenceMetrics.noBeatWindowDurationAudioSec,
    beatEvidenceSpanDurationAudioSec,
    beatEvidenceSpanRatio: durationAudioSec
      ? beatEvidenceSpanDurationAudioSec / durationAudioSec
      : 0,
    evidenceBeatCount: evidenceMetrics.evidenceBeatCount,
    fittedBeatCount: points.length,
    runtimeLineCount: audit.runtimeLineCount,
    runtimeMatchedBeatCount: audit.matchedPairs.length,
    runtimeUnmatchedLineCount: audit.unmatchedLineIndices.length,
    runtimeUnmatchedEvidenceCount: audit.unmatchedPointIndices.length,
    runtimeHeadExtrapolatedLineCount: audit.unmatchedHeadLineCount,
    runtimeTailExtrapolatedLineCount: audit.unmatchedTailLineCount,
    runtimeDownbeatMismatchCount: audit.downbeatMismatchCount,
    runtimeBoundaryMismatchCount: audit.boundaryMismatchCount,
    excludedBeatCount,
    inferredMissingBeatCount: evidenceMetrics.inferredMissingBeatCount,
    extraBeatCount: evidenceMetrics.extraBeatCount,
    gapAnomalyCount: evidenceMetrics.gapAnomalyCount,
    unexplainedBeatCount,
    unexplainedBeatRatio: audit.runtimeLineCount
      ? unexplainedBeatCount / audit.runtimeLineCount
      : 1,
    overlapComparisonCount: evidenceMetrics.overlapComparisonCount,
    overlapMatchedCount: evidenceMetrics.overlapMatchedCount,
    overlapMatchRate: evidenceMetrics.overlapMatchRate,
    overlapResidualP95Ms: evidenceMetrics.overlapResidualP95Ms,
    overlapResidualMaxMs: evidenceMetrics.overlapResidualMaxMs,
    residualP50Ms: audit.residualP50Ms,
    residualP95Ms: audit.residualP95Ms,
    residualMaxMs: audit.residualMaxMs,
    cumulativePhaseDeviationMaxMs: audit.residualMaxMs,
    seamBoundaryErrorMaxMs: audit.boundaryErrorMaxMs,
    tailErrorMs: audit.tailErrorMs,
    downbeatObservedCount: evidenceMetrics.downbeatObservedCount,
    downbeatConflictCount: evidenceMetrics.downbeatConflictCount,
    clipCount: fits.length,
    requestedMinBpm: minBpm,
    requestedMaxBpm: maxBpm
  }
}

/**
 * 边界不是“右段首拍”本身，而是左右拍线之间的一段半开区间：
 * - 左裁剪到 left.lastGrid + epsilon，避免左段向接缝外推一根假拍；
 * - 右 start 必须早于 right.firstGrid - epsilon，避免右段向接缝回填一根假拍；
 * - 同时 start 必须落在右段前一根网格线之后，保证 runtime 首线就是右段 anchor。
 * 速度下降、正向相位跳变和普通变速都通过这个可行区间表达；不可表达时才拒绝。
 */
const buildClips = (
  fits: readonly DynamicSegmentFit[],
  downbeatPhase: number,
  durationAudioSec: number,
  policy: DynamicBeatGridPolicy
): { status: 'ok'; clips: SongBeatGridClipV2[] } | { status: 'error'; reason: string } => {
  const clips: SongBeatGridClipV2[] = []
  for (let index = 0; index < fits.length; index += 1) {
    const fit = fits[index]
    let startSec = 0
    if (index > 0) {
      const leftFit = fits[index - 1]
      const marginSec = policy.segmentBoundaryEpsilonSec
      const rightFirstGridSec = fit.anchorTimeSec
      const lowerBoundSec = Math.max(
        leftFit.lastGridTimeSec + marginSec,
        rightFirstGridSec - fit.periodSec + marginSec
      )
      const upperBoundSec = Math.min(
        rightFirstGridSec - marginSec,
        fit.firstBeatTimeSec - marginSec,
        leftFit.lastGridTimeSec + leftFit.periodSec - marginSec
      )
      if (lowerBoundSec > upperBoundSec) {
        return { status: 'error', reason: `segment-boundary-unrepresentable:${index}` }
      }
      startSec = lowerBoundSec + (upperBoundSec - lowerBoundSec) / 2
      if (startSec >= fit.firstBeatTimeSec - 1e-9) {
        return { status: 'error', reason: `segment-boundary-overlap:${index}` }
      }
    }
    let anchorSec = fit.anchorTimeSec
    if (index > 0) {
      if (anchorSec <= startSec + 1e-9) anchorSec = fit.firstBeatTimeSec
      if (anchorSec <= startSec + 1e-9) {
        return { status: 'error', reason: `segment-anchor-not-after-start:${index}` }
      }
    }
    if (anchorSec >= durationAudioSec - TIME_EPSILON_SEC) {
      return { status: 'error', reason: `anchor-outside-duration:${index}` }
    }
    if (index > 0 && startSec <= clips[index - 1].startSec + TIME_EPSILON_SEC) {
      return { status: 'error', reason: `clip-start-not-increasing:${index}` }
    }
    clips.push({
      startSec,
      anchorSec,
      bpm: fit.bpm,
      downbeatBeatOffset: moduloFour(downbeatPhase - fit.anchorOrdinal)
    })
  }
  return { status: 'ok', clips }
}

const validateRuntimeShape = (
  map: SongBeatGridMapV2,
  durationAudioSec: number
): { status: 'ok' } | { status: 'error'; reason: string } => {
  const runtime = createSongBeatGridRuntimeV2(map, durationAudioSec)
  if (!runtime) return { status: 'error', reason: 'runtime-grid-failed' }
  let previousLine: { sec: number; clipIndex: number } | null = null
  for (const line of runtime.lines) {
    if (line.sec < -TIME_EPSILON_SEC || line.sec > durationAudioSec + TIME_EPSILON_SEC) {
      return { status: 'error', reason: 'runtime-line-outside-duration' }
    }
    if (previousLine) {
      const delta = line.sec - previousLine.sec
      if (delta <= TIME_EPSILON_SEC) {
        return { status: 'error', reason: 'runtime-line-duplicate' }
      }
      if (line.clipIndex === previousLine.clipIndex) {
        const expected = 60 / line.bpm
        if (delta > expected * 3 + TIME_EPSILON_SEC) {
          return { status: 'error', reason: 'runtime-line-gap' }
        }
      }
    }
    previousLine = { sec: line.sec, clipIndex: line.clipIndex }
  }
  if (!runtime.lines.length) return { status: 'error', reason: 'runtime-grid-empty' }
  return { status: 'ok' }
}

const auditFailureReason = (params: {
  audit: DynamicRuntimeAudit
  points: readonly DynamicFitPoint[]
  inferredMissingBeatCount: number
  excludedBeatCount: number
  policy: DynamicBeatGridPolicy
}): string | null => {
  const { audit, points, inferredMissingBeatCount, excludedBeatCount, policy } = params
  const expectedRuntimeLineCount =
    points.length +
    inferredMissingBeatCount +
    audit.unmatchedHeadLineCount +
    audit.unmatchedTailLineCount
  if (audit.runtimeLineCount !== expectedRuntimeLineCount) {
    return `runtime-line-count:${audit.runtimeLineCount}!=${expectedRuntimeLineCount}`
  }
  if (audit.unmatchedMiddleLineCount !== inferredMissingBeatCount + excludedBeatCount) {
    return `runtime-unmatched-lines:${audit.unmatchedMiddleLineCount}!=${inferredMissingBeatCount + excludedBeatCount}`
  }
  if (audit.unmatchedPointIndices.length > excludedBeatCount) {
    return `runtime-unmatched-evidence:${audit.unmatchedPointIndices.length}>${excludedBeatCount}`
  }
  if (
    audit.unmatchedHeadLineCount > policy.maxHeadTailExtrapolatedBeats ||
    audit.unmatchedTailLineCount > policy.maxHeadTailExtrapolatedBeats ||
    audit.headTailInvalidCount > 0
  ) {
    return `runtime-head-tail-extrapolation:${audit.unmatchedHeadLineCount}/${audit.unmatchedTailLineCount}/${audit.headTailInvalidCount}`
  }
  if (audit.ordinalMismatchCount > 0) {
    return `runtime-ordinal-mismatch:${audit.ordinalMismatchCount}`
  }
  if (audit.downbeatMismatchCount > 0) {
    return `runtime-downbeat-mismatch:${audit.downbeatMismatchCount}`
  }
  if (audit.boundaryMismatchCount > 0) {
    return `runtime-boundary-mismatch:${audit.boundaryMismatchCount}`
  }
  if (!audit.lastPointMatched) return 'runtime-last-beat-unmatched'
  if (audit.residualP95Ms > policy.p95ResidualMs + 1e-9) {
    return `runtime-residual-p95:${audit.residualP95Ms.toFixed(3)}`
  }
  if (audit.residualMaxMs > policy.maxResidualMs + 1e-9) {
    return `runtime-residual-max:${audit.residualMaxMs.toFixed(3)}`
  }
  if (audit.tailErrorMs > policy.maxResidualMs + 1e-9) {
    return `runtime-tail-error:${audit.tailErrorMs.toFixed(3)}`
  }
  return null
}

const success = (params: {
  fits: readonly DynamicSegmentFit[]
  points: readonly DynamicFitPoint[]
  map: SongBeatGridMapV2
  durationAudioSec: number
  evidenceMetrics: DynamicEvidenceMetrics
  audit: DynamicRuntimeAudit
  minBpm: number
  maxBpm: number
  policy: DynamicBeatGridPolicy
}): DynamicGridOutcome => {
  const { fits, points, map, durationAudioSec, evidenceMetrics, audit, minBpm, maxBpm, policy } =
    params
  return {
    status: fits.length === 1 ? 'fixed' : 'dynamic',
    coordinate: 'audio',
    beatGridMap: map,
    durationAudioSec,
    policyVersion: policy.version,
    metrics: buildMetrics({
      evidenceMetrics,
      fits,
      points,
      audit,
      durationAudioSec,
      minBpm,
      maxBpm,
      policy
    })
  }
}

/**
 * 纯 TS 全曲分析：窗口证据校验 → 重叠多拍匹配/拍序 → 单调拟合 → 分段 → 最终
 * runtime.lines 对证据的一对一审计。输入和输出都是 audio 坐标。
 */
export const analyzeDynamicBeatGridEvidence = (params: {
  windows: DynamicBeatWindowEvidence[]
  durationAudioSec: number
  minBpm?: number
  maxBpm?: number
}): DynamicGridOutcome => {
  const policy = DYNAMIC_BEAT_GRID_POLICY
  const durationAudioSec = readFiniteNumber(params.durationAudioSec)
  if (durationAudioSec === null || durationAudioSec <= 0) {
    return { status: 'error', reason: 'invalid-audio-duration' }
  }
  if (durationAudioSec < policy.minInferenceWindowSec) {
    return {
      status: 'unsupported',
      reason: `audio-too-short:${durationAudioSec}<${policy.minInferenceWindowSec}`
    }
  }
  if (!Array.isArray(params.windows) || !params.windows.length) {
    return { status: 'unresolved', reason: 'no-window-evidence' }
  }
  const minBpm = resolveBpm(params.minBpm, policy.defaultMinBpm)
  const maxBpm = resolveBpm(params.maxBpm, policy.defaultMaxBpm)
  if (minBpm === null || maxBpm === null) {
    return { status: 'error', reason: 'invalid-bpm-range' }
  }
  if (minBpm >= maxBpm) {
    return { status: 'error', reason: `invalid-bpm-range:${minBpm}>=${maxBpm}` }
  }

  const evidence = mergeDynamicBeatGridWindowEvidence({
    windows: params.windows,
    durationAudioSec,
    policy
  })
  if (evidence.status !== 'ok') {
    return { status: evidence.status, reason: evidence.reason }
  }
  const { sequence } = evidence
  if (sequence.beats.length > policy.maxBeats) {
    return {
      status: 'unsupported',
      reason: `beat-limit:${sequence.beats.length}>${policy.maxBeats}`
    }
  }
  if (sequence.beats.length < policy.minTotalBeats) {
    return {
      status: 'unresolved',
      reason: `insufficient-beat-evidence:${sequence.beats.length}<${policy.minTotalBeats}`
    }
  }
  if (sequence.downbeatObservedCount < policy.minDownbeatEvidenceCount) {
    return {
      status: 'unresolved',
      reason: `insufficient-downbeat-evidence:${sequence.downbeatObservedCount}<${policy.minDownbeatEvidenceCount}`
    }
  }
  if (sequence.metrics.downbeatConflictCount > 0) {
    return {
      status: 'unresolved',
      reason: `downbeat-phase-conflict:${sequence.metrics.downbeatConflictCount}`
    }
  }

  const points: DynamicFitPoint[] = sequence.beats.map((beat) => ({
    ordinal: beat.ordinal,
    timeSec: beat.timeSec,
    isDownbeat: beat.isDownbeat
  }))

  const single = fitSingleDynamicBeatGrid({ points, policy, minBpm, maxBpm })
  let fits: DynamicSegmentFit[]
  if (single.status === 'ok') {
    fits = [single.fit]
  } else {
    const segmented = fitSegmentedDynamicBeatGrid({ points, policy, minBpm, maxBpm })
    if (segmented.status !== 'ok') {
      return {
        status: segmented.status,
        reason: `single:${single.reason};segmented:${segmented.reason}`
      }
    }
    fits = segmented.fits
  }

  const clipsResult = buildClips(fits, sequence.downbeatPhase, durationAudioSec, policy)
  if (clipsResult.status !== 'ok') {
    return { status: 'unresolved', reason: clipsResult.reason }
  }
  const map = createSongBeatGridMapV2FromClips(clipsResult.clips, 'analysis', {
    allowSingleClip: true,
    durationSec: durationAudioSec
  })
  if (!map) {
    return { status: 'unresolved', reason: 'grid-map-normalization-failed' }
  }
  if (map.clips.length !== fits.length) {
    return { status: 'unresolved', reason: 'grid-map-clip-count-mismatch' }
  }
  const runtimeShape = validateRuntimeShape(map, durationAudioSec)
  if (runtimeShape.status !== 'ok') {
    return { status: 'unresolved', reason: runtimeShape.reason }
  }
  const runtime = createSongBeatGridRuntimeV2(map, durationAudioSec)
  if (!runtime) return { status: 'unresolved', reason: 'runtime-grid-failed' }
  const auditResult = auditDynamicBeatGridRuntime({
    lines: runtime.lines,
    points,
    policy
  })
  if (auditResult.status !== 'ok') {
    return { status: 'unresolved', reason: auditResult.reason }
  }
  const excludedBeatCount = fits.reduce((total, fit) => total + fit.excludedCount, 0)
  const auditReason = auditFailureReason({
    audit: auditResult.audit,
    points,
    inferredMissingBeatCount: sequence.metrics.inferredMissingBeatCount,
    excludedBeatCount,
    policy
  })
  if (auditReason) return { status: 'unresolved', reason: auditReason }

  return success({
    fits,
    points,
    map,
    durationAudioSec,
    evidenceMetrics: sequence.metrics,
    audit: auditResult.audit,
    minBpm,
    maxBpm,
    policy
  })
}
