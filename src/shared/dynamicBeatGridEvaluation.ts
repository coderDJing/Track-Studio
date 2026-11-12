import {
  createSongBeatGridRuntimeV2,
  type SongBeatGridLineV2,
  type SongBeatGridMapV2
} from './songBeatGridMapV2'

const DEFAULT_MATCH_TOLERANCE_SEC = 0.08
const TIME_EPSILON_SEC = 1e-6

export type DynamicBeatGridEvaluationCandidate = {
  beatGridMap: unknown
  durationSec: number
  coordinate: 'audio' | 'timeline'
  identity?: string
  policyVersion?: string
  audioIdentity?: string
}

export type DynamicBeatGridEvaluationTruth = {
  durationSec: number
  coordinate: 'audio' | 'timeline'
  beatGridMap?: unknown
  beatTimesSec?: number[]
  downbeatTimesSec?: number[]
  boundarySecs?: number[]
  clipCount?: number
  identity?: string
  audioIdentity?: string
}

export type DynamicBeatGridEvaluationOptions = {
  matchToleranceSec?: number
}

export type DynamicBeatGridMsSummary = {
  p50Ms: number | null
  p95Ms: number | null
  maxMs: number | null
}

export type DynamicBeatGridEvaluationReport =
  | {
      status: 'ok'
      input: {
        candidateIdentity: string | null
        truthIdentity: string | null
        candidateSignature: string
        candidatePolicyVersion: string | null
        coordinate: 'audio' | 'timeline'
        candidateDurationSec: number
        truthDurationSec: number
        matchToleranceMs: number
        audioIdentityMatched: boolean | null
      }
      qualification: {
        executionSucceeded: true
        scientificValidationEligible: false
        syntheticOrDevelopmentOnly: true
        centralRegistryUsed: false
        audioIdentityPresent: boolean
        note: string
      }
      beats: {
        truthCount: number
        candidateCount: number
        matchedCount: number
        missingCount: number
        extraCount: number
        truthMatchRate: number
        candidateMatchRate: number
        error: DynamicBeatGridMsSummary
      }
      downbeats: {
        truthCount: number
        candidateCount: number
        matchedCount: number
        missingCount: number
        extraCount: number
        misplacedCount: number
        error: DynamicBeatGridMsSummary
      }
      boundaries: {
        truthCount: number
        candidateCount: number
        boundaryErrorMs: number[]
        boundaryLineErrorMs: number[]
        maxBoundaryErrorMs: number | null
        maxBoundaryLineErrorMs: number | null
      }
      tail: {
        lastTruthBeatSec: number | null
        lastCandidateBeatSec: number | null
        tailErrorMs: number | null
        tailLineErrorMs: number | null
      }
      segments: {
        candidateClipCount: number
        truthClipCount: number | null
        extraClipCount: number | null
        overSegmented: boolean | null
      }
    }
  | {
      status: 'error'
      reason: string
    }

type BeatLineLike = {
  sec: number
  level: SongBeatGridLineV2['level']
}

type MatchResult = {
  matchedTruthIndices: number[]
  matchedCandidateIndices: number[]
  matchedErrorsMs: number[]
  missingCount: number
  extraCount: number
}

const isValidDuration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

const validateAscendingTimes = (values: readonly number[], label: string): string | null => {
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) return `${label}-not-finite`
    if (index > 0 && values[index] <= values[index - 1] + TIME_EPSILON_SEC) {
      return `${label}-not-strictly-increasing`
    }
  }
  return null
}

const matchMonotonic = (
  truthTimes: readonly number[],
  candidateTimes: readonly number[],
  toleranceSec: number
): MatchResult => {
  const matchedTruthIndices: number[] = []
  const matchedCandidateIndices: number[] = []
  const matchedErrorsMs: number[] = []
  let truthIndex = 0
  let candidateIndex = 0
  while (truthIndex < truthTimes.length && candidateIndex < candidateTimes.length) {
    const difference = truthTimes[truthIndex] - candidateTimes[candidateIndex]
    if (Math.abs(difference) <= toleranceSec) {
      matchedTruthIndices.push(truthIndex)
      matchedCandidateIndices.push(candidateIndex)
      matchedErrorsMs.push(Math.abs(difference) * 1000)
      truthIndex += 1
      candidateIndex += 1
      continue
    }
    if (difference < -toleranceSec) {
      truthIndex += 1
      continue
    }
    candidateIndex += 1
  }
  return {
    matchedTruthIndices,
    matchedCandidateIndices,
    matchedErrorsMs,
    missingCount: truthTimes.length - matchedTruthIndices.length,
    extraCount: candidateTimes.length - matchedCandidateIndices.length
  }
}

const summarizeMs = (values: readonly number[]): DynamicBeatGridMsSummary => {
  if (!values.length) return { p50Ms: null, p95Ms: null, maxMs: null }
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (value: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(value * sorted.length) - 1))]
  return {
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted[sorted.length - 1]
  }
}

const nearestDistanceMs = (timeSec: number, candidateTimes: readonly number[]): number | null => {
  if (!candidateTimes.length) return null
  let low = 0
  let high = candidateTimes.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (candidateTimes[middle] < timeSec) low = middle + 1
    else high = middle
  }
  const right = candidateTimes[low]
  const left = low > 0 ? candidateTimes[low - 1] : right
  return Math.min(Math.abs(right - timeSec), Math.abs(left - timeSec)) * 1000
}

const expandTruth = (
  truth: DynamicBeatGridEvaluationTruth
):
  | {
      status: 'ok'
      lines: BeatLineLike[]
      times: number[]
      downbeats: number[]
      boundaries: number[]
      clipCount: number | null
    }
  | { status: 'error'; reason: string } => {
  let lines: BeatLineLike[] = []
  let times: number[] = []
  let downbeats: number[] = []
  let boundaries: number[] = []
  let clipCount: number | null = truth.clipCount ?? null

  if (truth.beatGridMap !== undefined) {
    const runtime = createSongBeatGridRuntimeV2(truth.beatGridMap, truth.durationSec)
    if (!runtime) return { status: 'error', reason: 'invalid-truth-grid-map' }
    lines = runtime.lines.map((line) => ({ sec: line.sec, level: line.level }))
    times = runtime.lines.map((line) => line.sec)
    downbeats = runtime.lines.filter((line) => line.level === 'downbeat').map((line) => line.sec)
    boundaries = [...runtime.clipBoundaries]
    clipCount = runtime.clips.length
  }

  if (truth.beatTimesSec !== undefined) {
    if (!Array.isArray(truth.beatTimesSec))
      return { status: 'error', reason: 'truth-beats-must-be-array' }
    const invalid = validateAscendingTimes(truth.beatTimesSec, 'truth-beats')
    if (invalid) return { status: 'error', reason: invalid }
    times = [...truth.beatTimesSec]
    if (!lines.length) lines = times.map((sec) => ({ sec, level: 'beat' }))
  }
  if (!times.length) return { status: 'error', reason: 'truth-beats-empty' }

  if (truth.downbeatTimesSec !== undefined) {
    if (!Array.isArray(truth.downbeatTimesSec)) {
      return { status: 'error', reason: 'truth-downbeats-must-be-array' }
    }
    const invalid = validateAscendingTimes(truth.downbeatTimesSec, 'truth-downbeats')
    if (invalid) return { status: 'error', reason: invalid }
    downbeats = [...truth.downbeatTimesSec]
  }

  if (truth.boundarySecs !== undefined) {
    if (!Array.isArray(truth.boundarySecs)) {
      return { status: 'error', reason: 'truth-boundaries-must-be-array' }
    }
    const invalid = validateAscendingTimes(truth.boundarySecs, 'truth-boundaries')
    if (invalid) return { status: 'error', reason: invalid }
    boundaries = [...truth.boundarySecs]
  }

  return { status: 'ok', lines, times, downbeats, boundaries, clipCount }
}

/**
 * 离线评测：完整候选 map + 逐拍/多 clip truth。
 * 使用全曲单调一对一匹配；漏拍、多拍、downbeat 错位与边界/曲尾误差分别计分。
 * 本函数不读写歌曲库、registry 或共享网格。
 */
export const evaluateDynamicBeatGrid = (
  candidate: DynamicBeatGridEvaluationCandidate,
  truth: DynamicBeatGridEvaluationTruth,
  options: DynamicBeatGridEvaluationOptions = {}
): DynamicBeatGridEvaluationReport => {
  if (!isValidDuration(candidate.durationSec)) {
    return { status: 'error', reason: 'invalid-candidate-duration' }
  }
  if (!isValidDuration(truth.durationSec)) {
    return { status: 'error', reason: 'invalid-truth-duration' }
  }
  if (candidate.coordinate !== 'audio' && candidate.coordinate !== 'timeline') {
    return { status: 'error', reason: 'candidate-coordinate-required' }
  }
  if (truth.coordinate !== 'audio' && truth.coordinate !== 'timeline') {
    return { status: 'error', reason: 'truth-coordinate-required' }
  }
  if (candidate.coordinate !== truth.coordinate) {
    return {
      status: 'error',
      reason: `coordinate-mismatch:${candidate.coordinate}!=${truth.coordinate}`
    }
  }
  const candidateAudioIdentity = candidate.audioIdentity?.trim() || null
  const truthAudioIdentity = truth.audioIdentity?.trim() || null
  if (
    candidateAudioIdentity &&
    truthAudioIdentity &&
    candidateAudioIdentity !== truthAudioIdentity
  ) {
    return { status: 'error', reason: 'audio-identity-mismatch' }
  }
  const audioIdentityMatched =
    candidateAudioIdentity && truthAudioIdentity
      ? candidateAudioIdentity === truthAudioIdentity
      : null
  const toleranceSec =
    options.matchToleranceSec === undefined
      ? DEFAULT_MATCH_TOLERANCE_SEC
      : Number(options.matchToleranceSec)
  if (!Number.isFinite(toleranceSec) || toleranceSec <= 0 || toleranceSec > 0.5) {
    return { status: 'error', reason: 'invalid-match-tolerance' }
  }

  const candidateRuntime = createSongBeatGridRuntimeV2(candidate.beatGridMap, candidate.durationSec)
  if (!candidateRuntime) return { status: 'error', reason: 'invalid-candidate-grid-map' }
  const truthExpanded = expandTruth(truth)
  if (truthExpanded.status !== 'ok') return truthExpanded

  const candidateLines: BeatLineLike[] = candidateRuntime.lines.map((line) => ({
    sec: line.sec,
    level: line.level
  }))
  const candidateTimes = candidateRuntime.lines.map((line) => line.sec)
  const candidateDownbeats = candidateRuntime.lines
    .filter((line) => line.level === 'downbeat')
    .map((line) => line.sec)
  const candidateBoundaries = [...candidateRuntime.clipBoundaries]

  const beatMatch = matchMonotonic(truthExpanded.times, candidateTimes, toleranceSec)
  const downbeatMatch = matchMonotonic(truthExpanded.downbeats, candidateDownbeats, toleranceSec)

  let misplacedDownbeats = 0
  for (const truthDownbeatSec of truthExpanded.downbeats) {
    const matchedCandidateDownbeat = candidateDownbeats.some(
      (candidateSec) => Math.abs(candidateSec - truthDownbeatSec) <= toleranceSec
    )
    if (matchedCandidateDownbeat) continue
    const matchedAnyLine = candidateLines.some(
      (line) => Math.abs(line.sec - truthDownbeatSec) <= toleranceSec
    )
    if (matchedAnyLine) misplacedDownbeats += 1
  }

  const boundaryErrorsMs: number[] = []
  const boundaryLineErrorsMs: number[] = []
  for (const boundarySec of truthExpanded.boundaries) {
    const clipError = nearestDistanceMs(boundarySec, candidateBoundaries)
    if (clipError !== null) boundaryErrorsMs.push(clipError)
    const lineError = nearestDistanceMs(boundarySec, candidateTimes)
    if (lineError !== null) boundaryLineErrorsMs.push(lineError)
  }

  const lastTruthBeatSec = truthExpanded.times.length
    ? truthExpanded.times[truthExpanded.times.length - 1]
    : null
  const lastCandidateBeatSec = candidateTimes.length
    ? candidateTimes[candidateTimes.length - 1]
    : null
  const tailErrorMs =
    lastTruthBeatSec !== null && lastCandidateBeatSec !== null
      ? Math.abs(lastCandidateBeatSec - lastTruthBeatSec) * 1000
      : null
  const tailLineErrorMs =
    lastTruthBeatSec !== null ? nearestDistanceMs(lastTruthBeatSec, candidateTimes) : null

  const truthClipCount = truthExpanded.clipCount
  const candidateClipCount = candidateRuntime.clips.length
  const extraClipCount =
    truthClipCount === null ? null : Math.max(0, candidateClipCount - truthClipCount)
  const overSegmented = truthClipCount === null ? null : candidateClipCount > truthClipCount

  return {
    status: 'ok',
    input: {
      candidateIdentity: candidate.identity ?? null,
      truthIdentity: truth.identity ?? null,
      candidateSignature: candidateRuntime.signature,
      candidatePolicyVersion: candidate.policyVersion ?? null,
      coordinate: candidate.coordinate,
      candidateDurationSec: candidate.durationSec,
      truthDurationSec: truth.durationSec,
      matchToleranceMs: toleranceSec * 1000,
      audioIdentityMatched
    },
    qualification: {
      executionSucceeded: true,
      scientificValidationEligible: false,
      syntheticOrDevelopmentOnly: true,
      centralRegistryUsed: false,
      audioIdentityPresent: Boolean(candidateAudioIdentity && truthAudioIdentity),
      note: 'Offline explicit-file evaluation only. ok means execution succeeded, not independent scientific validation. No central registry, audio SHA roster, or frozen holdout qualification is implied.'
    },
    beats: {
      truthCount: truthExpanded.times.length,
      candidateCount: candidateTimes.length,
      matchedCount: beatMatch.matchedTruthIndices.length,
      missingCount: beatMatch.missingCount,
      extraCount: beatMatch.extraCount,
      truthMatchRate: truthExpanded.times.length
        ? beatMatch.matchedTruthIndices.length / truthExpanded.times.length
        : 0,
      candidateMatchRate: candidateTimes.length
        ? beatMatch.matchedTruthIndices.length / candidateTimes.length
        : 0,
      error: summarizeMs(beatMatch.matchedErrorsMs)
    },
    downbeats: {
      truthCount: truthExpanded.downbeats.length,
      candidateCount: candidateDownbeats.length,
      matchedCount: downbeatMatch.matchedTruthIndices.length,
      missingCount: downbeatMatch.missingCount,
      extraCount: downbeatMatch.extraCount,
      misplacedCount: misplacedDownbeats,
      error: summarizeMs(downbeatMatch.matchedErrorsMs)
    },
    boundaries: {
      truthCount: truthExpanded.boundaries.length,
      candidateCount: candidateBoundaries.length,
      boundaryErrorMs: boundaryErrorsMs,
      boundaryLineErrorMs: boundaryLineErrorsMs,
      maxBoundaryErrorMs: boundaryErrorsMs.length ? Math.max(...boundaryErrorsMs) : null,
      maxBoundaryLineErrorMs: boundaryLineErrorsMs.length ? Math.max(...boundaryLineErrorsMs) : null
    },
    tail: {
      lastTruthBeatSec,
      lastCandidateBeatSec,
      tailErrorMs,
      tailLineErrorMs
    },
    segments: {
      candidateClipCount,
      truthClipCount,
      extraClipCount,
      overSegmented
    }
  }
}

export const resolveDynamicBeatGridEvaluationCandidateMap = (
  candidate: DynamicBeatGridEvaluationCandidate
): SongBeatGridMapV2 | null => {
  const runtime = createSongBeatGridRuntimeV2(candidate.beatGridMap, candidate.durationSec)
  return runtime?.map ?? null
}
