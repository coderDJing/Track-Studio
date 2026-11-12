import type { DynamicBeatGridPolicy, DynamicBeatWindowEvidence } from './dynamicBeatGridTypes'

const TIME_EPSILON_SEC = 1e-6
const MIN_CLUSTER_TOLERANCE_SEC = 0.03
const MAX_CLUSTER_TOLERANCE_SEC = 0.08
const EXTRA_BEAT_INTERVAL_RATIO = 0.6
const MISSING_BEAT_INTERVAL_RATIO = 1.5
const MISSING_BEAT_ROUND_TOLERANCE = 0.3

export type DynamicMergedBeat = {
  ordinal: number
  timeSec: number
  isDownbeat: boolean
  support: number
  sourceWindowIds: string[]
  downbeatVotes: number
}

export type DynamicEvidenceMetrics = {
  windowCount: number
  okWindowCount: number
  noBeatWindowCount: number
  noBeatWindowDurationAudioSec: number
  scannedDurationAudioSec: number
  scannedCoverageRatio: number
  evidenceBeatCount: number
  fittedBeatCount: number
  inferredMissingBeatCount: number
  extraBeatCount: number
  gapAnomalyCount: number
  overlapComparisonCount: number
  overlapMatchedCount: number
  overlapMatchRate: number
  overlapResidualP95Ms: number
  overlapResidualMaxMs: number
  downbeatObservedCount: number
  downbeatConflictCount: number
  octaveConflictCount: number
}

export type DynamicEvidenceSequence = {
  beats: DynamicMergedBeat[]
  downbeatPhase: number
  downbeatObservedCount: number
  metrics: DynamicEvidenceMetrics
}

export type DynamicEvidenceResult =
  | { status: 'ok'; sequence: DynamicEvidenceSequence }
  | { status: 'unresolved'; reason: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; reason: string }

type NormalizedWindow = {
  windowId: string
  startSec: number
  endSec: number
  beats: number[]
  downbeats: number[]
  status: 'ok' | 'no-beats'
}

type BeatObservation = {
  timeSec: number
  windowId: string
  centralitySec: number
  isDownbeat: boolean
}

type BeatCluster = {
  observations: BeatObservation[]
  representative: BeatObservation
  medianTimeSec: number
  isDownbeat: boolean
  downbeatVotes: number
  support: number
  sourceWindowIds: string[]
}

type SeamMetrics = {
  comparisonCount: number
  matchedCount: number
  residualsMs: number[]
  octaveConflictCount: number
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const median = (values: readonly number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const nearestRankPercentile = (values: readonly number[], percentile: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1))
  return sorted[index]
}

const computeIntervalMedian = (beats: readonly number[]): number => {
  const intervals: number[] = []
  for (let index = 1; index < beats.length; index += 1) {
    const interval = beats[index] - beats[index - 1]
    if (interval > 0.05 && interval < 5) intervals.push(interval)
  }
  return intervals.length ? median(intervals) : 0.5
}

const computeLocalInterval = (intervals: readonly number[], index: number, fallback: number) => {
  const local: number[] = []
  for (let offset = -3; offset <= 3; offset += 1) {
    if (offset === 0) continue
    const target = index + offset
    if (target < 0 || target >= intervals.length) continue
    const value = intervals[target]
    if (value > 0.05 && value < 5) local.push(value)
  }
  return local.length ? median(local) : fallback
}

const normalizeWindows = (
  windows: readonly DynamicBeatWindowEvidence[],
  durationAudioSec: number,
  policy: DynamicBeatGridPolicy
):
  | { status: 'ok'; windows: NormalizedWindow[] }
  | { status: 'error'; reason: string }
  | { status: 'unsupported'; reason: string } => {
  if (!Array.isArray(windows)) return { status: 'error', reason: 'windows-must-be-array' }
  if (windows.length > policy.maxWindows) {
    return { status: 'unsupported', reason: `window-limit:${windows.length}>${policy.maxWindows}` }
  }
  if (!windows.length) return { status: 'error', reason: 'windows-empty' }

  const seenIds = new Set<string>()
  const seenIntervals = new Set<string>()
  const normalized: NormalizedWindow[] = []
  let totalObservations = 0

  for (const windowEvidence of windows) {
    if (!windowEvidence || typeof windowEvidence !== 'object') {
      return { status: 'error', reason: 'window-evidence-invalid' }
    }
    const windowId =
      typeof windowEvidence.windowId === 'string' ? windowEvidence.windowId.trim() : ''
    if (!windowId) return { status: 'error', reason: 'window-id-empty' }
    if (seenIds.has(windowId)) return { status: 'error', reason: `window-id-duplicate:${windowId}` }
    seenIds.add(windowId)

    const startSec = Number(windowEvidence.startAudioSec)
    const analyzedDurationSec = Number(windowEvidence.analyzedDurationSec)
    if (!Number.isFinite(startSec) || startSec < -TIME_EPSILON_SEC) {
      return { status: 'error', reason: `window-start-invalid:${windowId}` }
    }
    if (!Number.isFinite(analyzedDurationSec) || analyzedDurationSec <= 0) {
      return { status: 'error', reason: `window-duration-invalid:${windowId}` }
    }
    const endSec = startSec + analyzedDurationSec
    if (endSec > durationAudioSec + TIME_EPSILON_SEC) {
      return { status: 'error', reason: `window-exceeds-duration:${windowId}` }
    }
    const intervalKey = `${startSec.toFixed(6)}:${analyzedDurationSec.toFixed(6)}`
    if (seenIntervals.has(intervalKey)) {
      return { status: 'error', reason: `window-interval-duplicate:${windowId}` }
    }
    seenIntervals.add(intervalKey)

    const status = windowEvidence.status
    if (status !== 'ok' && status !== 'no-beats') {
      return { status: 'error', reason: `window-status-invalid:${windowId}` }
    }
    if (
      !Array.isArray(windowEvidence.beatsAudioSec) ||
      !Array.isArray(windowEvidence.downbeatsAudioSec)
    ) {
      return { status: 'error', reason: `window-beats-invalid:${windowId}` }
    }
    if (windowEvidence.beatsAudioSec.length > policy.maxBeatsPerWindow) {
      return {
        status: 'unsupported',
        reason: `window-beat-limit:${windowId}:${windowEvidence.beatsAudioSec.length}`
      }
    }
    if (status === 'no-beats') {
      if (windowEvidence.beatsAudioSec.length || windowEvidence.downbeatsAudioSec.length) {
        return { status: 'error', reason: `no-beats-window-has-beats:${windowId}` }
      }
      normalized.push({
        windowId,
        startSec,
        endSec,
        beats: [],
        downbeats: [],
        status
      })
      continue
    }

    const beats: number[] = []
    for (const beatValue of windowEvidence.beatsAudioSec) {
      const beatSec = Number(beatValue)
      if (!Number.isFinite(beatSec)) {
        return { status: 'error', reason: `beat-not-finite:${windowId}` }
      }
      if (beatSec < startSec - TIME_EPSILON_SEC || beatSec > endSec + TIME_EPSILON_SEC) {
        return { status: 'error', reason: `beat-outside-window:${windowId}` }
      }
      if (beats.length && beatSec <= beats[beats.length - 1] + TIME_EPSILON_SEC) {
        return { status: 'error', reason: `beats-not-strictly-increasing:${windowId}` }
      }
      beats.push(beatSec)
    }

    const downbeats: number[] = []
    let beatCursor = 0
    for (const downbeatValue of windowEvidence.downbeatsAudioSec) {
      const downbeatSec = Number(downbeatValue)
      if (!Number.isFinite(downbeatSec)) {
        return { status: 'error', reason: `downbeat-not-finite:${windowId}` }
      }
      if (downbeatSec < startSec - TIME_EPSILON_SEC || downbeatSec > endSec + TIME_EPSILON_SEC) {
        return { status: 'error', reason: `downbeat-outside-window:${windowId}` }
      }
      if (downbeats.length && downbeatSec <= downbeats[downbeats.length - 1] + TIME_EPSILON_SEC) {
        return { status: 'error', reason: `downbeats-not-strictly-increasing:${windowId}` }
      }
      while (
        beatCursor < beats.length &&
        beats[beatCursor] < downbeatSec - policy.downbeatMatchToleranceSec
      ) {
        beatCursor += 1
      }
      const matchedBeat = beats[beatCursor]
      if (
        matchedBeat === undefined ||
        Math.abs(matchedBeat - downbeatSec) > policy.downbeatMatchToleranceSec
      ) {
        return { status: 'error', reason: `downbeat-does-not-match-beat:${windowId}` }
      }
      downbeats.push(downbeatSec)
    }

    totalObservations += beats.length
    if (totalObservations > policy.maxObservations) {
      return { status: 'unsupported', reason: `observation-limit:${totalObservations}` }
    }

    normalized.push({ windowId, startSec, endSec, beats, downbeats, status })
  }

  normalized.sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec)
  return { status: 'ok', windows: normalized }
}

const computeCoverage = (
  windows: readonly NormalizedWindow[],
  durationAudioSec: number
): number => {
  let covered = 0
  let cursor = 0
  for (const windowEvidence of windows) {
    const startSec = Math.max(0, windowEvidence.startSec)
    const endSec = Math.min(durationAudioSec, windowEvidence.endSec)
    if (endSec <= startSec) continue
    const from = Math.max(cursor, startSec)
    if (endSec > from) {
      covered += endSec - from
      cursor = endSec
    } else if (endSec > cursor) {
      cursor = endSec
    }
  }
  return covered
}

const matchBeatTimes = (
  truthBeats: readonly number[],
  candidateBeats: readonly number[],
  toleranceSec: number
): { matchedCount: number; residualsMs: number[] } => {
  let candidateIndex = 0
  let matchedCount = 0
  const residualsMs: number[] = []
  for (const truthSec of truthBeats) {
    while (
      candidateIndex < candidateBeats.length &&
      candidateBeats[candidateIndex] < truthSec - toleranceSec
    ) {
      candidateIndex += 1
    }
    if (candidateIndex >= candidateBeats.length) break
    const candidateSec = candidateBeats[candidateIndex]
    if (Math.abs(candidateSec - truthSec) <= toleranceSec) {
      matchedCount += 1
      residualsMs.push(Math.abs(candidateSec - truthSec) * 1000)
      candidateIndex += 1
    }
  }
  return { matchedCount, residualsMs }
}

const detectOctaveConflict = (
  leftBeats: readonly number[],
  rightBeats: readonly number[],
  toleranceSec: number
): boolean => {
  if (leftBeats.length < 4 || rightBeats.length < 4) return false
  for (const phase of [0, 1]) {
    const rightSubset = rightBeats.filter((_, index) => index % 2 === phase)
    const rightMatch = matchBeatTimes(leftBeats, rightSubset, toleranceSec)
    if (rightMatch.matchedCount / leftBeats.length >= 0.95) return true
    const leftSubset = leftBeats.filter((_, index) => index % 2 === phase)
    const leftMatch = matchBeatTimes(leftSubset, rightBeats, toleranceSec)
    if (leftMatch.matchedCount / leftSubset.length >= 0.95) return true
  }
  return false
}

const collectSeamMetrics = (
  windows: readonly NormalizedWindow[],
  policy: DynamicBeatGridPolicy
): SeamMetrics => {
  let comparisonCount = 0
  let matchedCount = 0
  let octaveConflictCount = 0
  const residualsMs: number[] = []

  for (let index = 1; index < windows.length; index += 1) {
    const left = windows[index - 1]
    const right = windows[index]
    const overlapStartSec = Math.max(left.startSec, right.startSec)
    const overlapEndSec = Math.min(left.endSec, right.endSec)
    if (overlapEndSec - overlapStartSec <= TIME_EPSILON_SEC) continue
    if (left.status !== 'ok' || right.status !== 'ok') continue

    const leftBeats = left.beats.filter(
      (beatSec) =>
        beatSec >= overlapStartSec - TIME_EPSILON_SEC && beatSec <= overlapEndSec + TIME_EPSILON_SEC
    )
    const rightBeats = right.beats.filter(
      (beatSec) =>
        beatSec >= overlapStartSec - TIME_EPSILON_SEC && beatSec <= overlapEndSec + TIME_EPSILON_SEC
    )
    if (!leftBeats.length || !rightBeats.length) continue

    const localIntervalSec = Math.min(
      computeIntervalMedian(leftBeats),
      computeIntervalMedian(rightBeats)
    )
    const toleranceSec = Math.min(
      policy.maxOverlapToleranceSec,
      Math.max(
        policy.minOverlapToleranceSec,
        localIntervalSec * policy.overlapToleranceIntervalRatio
      )
    )
    const match = matchBeatTimes(leftBeats, rightBeats, toleranceSec)
    comparisonCount += leftBeats.length
    matchedCount += match.matchedCount
    residualsMs.push(...match.residualsMs)
    if (match.matchedCount / leftBeats.length < policy.minOverlapMatchRate) {
      if (detectOctaveConflict(leftBeats, rightBeats, toleranceSec)) octaveConflictCount += 1
    }
  }

  return { comparisonCount, matchedCount, residualsMs, octaveConflictCount }
}

const buildClusters = (
  windows: readonly NormalizedWindow[],
  policy: DynamicBeatGridPolicy
): BeatCluster[] => {
  const globalIntervals: number[] = []
  for (const windowEvidence of windows) {
    if (windowEvidence.status !== 'ok') continue
    for (let index = 1; index < windowEvidence.beats.length; index += 1) {
      const interval = windowEvidence.beats[index] - windowEvidence.beats[index - 1]
      if (interval > 0.05 && interval < 5) globalIntervals.push(interval)
    }
  }
  const globalIntervalSec = globalIntervals.length ? median(globalIntervals) : 0.5
  const clusterToleranceSec = Math.min(
    MAX_CLUSTER_TOLERANCE_SEC,
    Math.max(MIN_CLUSTER_TOLERANCE_SEC, globalIntervalSec * 0.25)
  )

  const observations: BeatObservation[] = []
  for (const windowEvidence of windows) {
    if (windowEvidence.status !== 'ok') continue
    const downbeatSet = windowEvidence.downbeats
    let downbeatCursor = 0
    for (const beatSec of windowEvidence.beats) {
      const centralitySec = Math.min(
        beatSec - windowEvidence.startSec,
        windowEvidence.endSec - beatSec
      )
      let isDownbeat = false
      while (
        downbeatCursor < downbeatSet.length &&
        downbeatSet[downbeatCursor] < beatSec - policy.downbeatMatchToleranceSec
      ) {
        downbeatCursor += 1
      }
      const downbeatSec = downbeatSet[downbeatCursor]
      if (
        downbeatSec !== undefined &&
        Math.abs(downbeatSec - beatSec) <= policy.downbeatMatchToleranceSec
      ) {
        isDownbeat = true
      }
      observations.push({
        timeSec: beatSec,
        windowId: windowEvidence.windowId,
        centralitySec,
        isDownbeat
      })
    }
  }
  observations.sort(
    (left, right) => left.timeSec - right.timeSec || right.centralitySec - left.centralitySec
  )

  const grouped: BeatObservation[][] = []
  let currentGroup: BeatObservation[] = []
  for (const observation of observations) {
    const currentMedian = currentGroup.length
      ? median(currentGroup.map((item) => item.timeSec))
      : Number.NaN
    if (
      currentGroup.length &&
      Math.abs(observation.timeSec - currentMedian) <= clusterToleranceSec
    ) {
      currentGroup.push(observation)
      continue
    }
    if (currentGroup.length) grouped.push(currentGroup)
    currentGroup = [observation]
  }
  if (currentGroup.length) grouped.push(currentGroup)

  return grouped.map((group) => {
    const times = group.map((item) => item.timeSec)
    const groupMedianSec = median(times)
    let representative = group[0]
    for (const observation of group) {
      if (observation.centralitySec > representative.centralitySec + TIME_EPSILON_SEC) {
        representative = observation
        continue
      }
      if (
        Math.abs(observation.centralitySec - representative.centralitySec) <= TIME_EPSILON_SEC &&
        Math.abs(observation.timeSec - groupMedianSec) <
          Math.abs(representative.timeSec - groupMedianSec)
      ) {
        representative = observation
      }
    }
    const sourceWindowIds = Array.from(new Set(group.map((item) => item.windowId)))
    const downbeatVotes = group.filter((item) => item.isDownbeat).length
    return {
      observations: group,
      representative,
      medianTimeSec: groupMedianSec,
      isDownbeat: downbeatVotes > 0 && downbeatVotes * 2 >= group.length,
      downbeatVotes,
      support: sourceWindowIds.length,
      sourceWindowIds
    }
  })
}

const resolveDownbeatPhase = (
  clusters: readonly BeatCluster[],
  ordinals: readonly number[]
): { phase: number; conflictCount: number; observedCount: number } => {
  const observed = clusters
    .map((cluster, index) => ({ cluster, ordinal: ordinals[index] }))
    .filter((item) => item.cluster.isDownbeat)
  if (!observed.length) return { phase: 0, conflictCount: 0, observedCount: 0 }
  let bestPhase = 0
  let bestConflicts = Number.POSITIVE_INFINITY
  for (let phase = 0; phase < 4; phase += 1) {
    let conflicts = 0
    for (const item of observed) {
      if (item.ordinal % 4 !== phase) conflicts += 1
    }
    if (conflicts < bestConflicts) {
      bestConflicts = conflicts
      bestPhase = phase
    }
  }
  return { phase: bestPhase, conflictCount: bestConflicts, observedCount: observed.length }
}

export const mergeDynamicBeatGridWindowEvidence = (params: {
  windows: readonly DynamicBeatWindowEvidence[]
  durationAudioSec: number
  policy: DynamicBeatGridPolicy
}): DynamicEvidenceResult => {
  const { durationAudioSec, policy } = params
  if (!Number.isFinite(durationAudioSec) || durationAudioSec <= 0) {
    return { status: 'error', reason: 'duration-invalid' }
  }
  const normalized = normalizeWindows(params.windows, durationAudioSec, policy)
  if (normalized.status !== 'ok') return normalized
  const windows = normalized.windows

  const okWindowCount = windows.filter((item) => item.status === 'ok').length
  const noBeatWindowCount = windows.length - okWindowCount
  const noBeatWindowDurationAudioSec = computeCoverage(
    windows.filter((item) => item.status === 'no-beats'),
    durationAudioSec
  )
  const scannedDurationAudioSec = computeCoverage(windows, durationAudioSec)
  const scannedCoverageRatio = scannedDurationAudioSec / durationAudioSec
  if (scannedCoverageRatio < policy.minScannedCoverageRatio - 1e-9) {
    return {
      status: 'unresolved',
      reason: `insufficient-scanned-coverage:${scannedCoverageRatio.toFixed(6)}<${policy.minScannedCoverageRatio}`
    }
  }

  const seamMetrics = collectSeamMetrics(windows, policy)
  if (seamMetrics.octaveConflictCount > 0) {
    return { status: 'unresolved', reason: `octave-ambiguity:${seamMetrics.octaveConflictCount}` }
  }
  const overlapMatchRate = seamMetrics.comparisonCount
    ? seamMetrics.matchedCount / seamMetrics.comparisonCount
    : 1
  if (
    seamMetrics.comparisonCount >= policy.minOverlapComparisonCount &&
    overlapMatchRate < policy.minOverlapMatchRate - 1e-9
  ) {
    return {
      status: 'unresolved',
      reason: `overlap-seam-mismatch:${overlapMatchRate.toFixed(6)}<${policy.minOverlapMatchRate}`
    }
  }

  const clusters = buildClusters(windows, policy)
  if (!clusters.length) {
    return { status: 'unresolved', reason: 'no-beat-evidence' }
  }

  const intervals: number[] = []
  for (let index = 1; index < clusters.length; index += 1) {
    intervals.push(clusters[index].medianTimeSec - clusters[index - 1].medianTimeSec)
  }
  const globalIntervalSec = intervals.length ? median(intervals) : 0.5

  let extraBeatCount = 0
  for (let index = 1; index < intervals.length; index += 1) {
    const previousInterval = intervals[index - 1]
    const nextInterval = intervals[index]
    const localPrevious = computeLocalInterval(intervals, index - 1, globalIntervalSec)
    const localNext = computeLocalInterval(intervals, index, globalIntervalSec)
    if (
      previousInterval < localPrevious * EXTRA_BEAT_INTERVAL_RATIO &&
      nextInterval < localNext * EXTRA_BEAT_INTERVAL_RATIO
    ) {
      extraBeatCount += 1
    }
  }

  let inferredMissingBeatCount = 0
  let gapAnomalyCount = 0
  const ordinals: number[] = [0]
  for (let index = 0; index < intervals.length; index += 1) {
    const interval = intervals[index]
    const localInterval = computeLocalInterval(intervals, index, globalIntervalSec)
    const ratio = localInterval > 0 ? interval / localInterval : 1
    let increment = 1
    if (ratio >= MISSING_BEAT_INTERVAL_RATIO) {
      const rounded = Math.round(ratio)
      if (
        rounded >= 2 &&
        rounded <= policy.maxInferredGapBeats &&
        Math.abs(ratio - rounded) <= MISSING_BEAT_ROUND_TOLERANCE
      ) {
        increment = rounded
        inferredMissingBeatCount += rounded - 1
      } else {
        gapAnomalyCount += 1
        increment = Math.max(1, rounded)
      }
    } else if (ratio < EXTRA_BEAT_INTERVAL_RATIO) {
      gapAnomalyCount += 1
    }
    ordinals.push(ordinals[ordinals.length - 1] + increment)
  }

  if (gapAnomalyCount > 0) {
    return { status: 'unresolved', reason: `ambiguous-beat-ordinal-gap:${gapAnomalyCount}` }
  }

  const downbeat = resolveDownbeatPhase(clusters, ordinals)
  const beats: DynamicMergedBeat[] = clusters.map((cluster, index) => ({
    ordinal: ordinals[index],
    timeSec: cluster.representative.timeSec,
    isDownbeat: cluster.isDownbeat,
    support: cluster.support,
    sourceWindowIds: cluster.sourceWindowIds,
    downbeatVotes: cluster.downbeatVotes
  }))

  const metrics: DynamicEvidenceMetrics = {
    windowCount: windows.length,
    okWindowCount,
    noBeatWindowCount,
    noBeatWindowDurationAudioSec,
    scannedDurationAudioSec,
    scannedCoverageRatio,
    evidenceBeatCount: windows.reduce((total, item) => total + item.beats.length, 0),
    fittedBeatCount: clusters.length,
    inferredMissingBeatCount,
    extraBeatCount,
    gapAnomalyCount,
    overlapComparisonCount: seamMetrics.comparisonCount,
    overlapMatchedCount: seamMetrics.matchedCount,
    overlapMatchRate,
    overlapResidualP95Ms: nearestRankPercentile(seamMetrics.residualsMs, 0.95),
    overlapResidualMaxMs: seamMetrics.residualsMs.length ? Math.max(...seamMetrics.residualsMs) : 0,
    downbeatObservedCount: downbeat.observedCount,
    downbeatConflictCount: downbeat.conflictCount,
    octaveConflictCount: seamMetrics.octaveConflictCount
  }

  return {
    status: 'ok',
    sequence: {
      beats,
      downbeatPhase: downbeat.phase,
      downbeatObservedCount: downbeat.observedCount,
      metrics
    }
  }
}
