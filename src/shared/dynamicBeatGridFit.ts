import type { DynamicBeatGridPolicy } from './dynamicBeatGridTypes'

const TIME_EPSILON_SEC = 1e-9
const BPM_EPSILON = 1e-6

export type DynamicFitPoint = {
  ordinal: number
  timeSec: number
  isDownbeat: boolean
}

export type DynamicSegmentFit = {
  startIndex: number
  endIndexExclusive: number
  beatCount: number
  bpm: number
  periodSec: number
  anchorTimeSec: number
  anchorOrdinal: number
  firstBeatTimeSec: number
  lastBeatTimeSec: number
  lastGridTimeSec: number
  residualP50Ms: number
  residualP95Ms: number
  residualMaxMs: number
  residualSamplesMs: number[]
  rmsMs: number
  excludedCount: number
  excludedRatio: number
  tailErrorMs: number
  boundaryErrorMs: number
}

export type DynamicSingleFitResult =
  { status: 'ok'; fit: DynamicSegmentFit } | { status: 'fail'; reason: string }

export type DynamicSegmentedFitResult =
  | { status: 'ok'; fits: DynamicSegmentFit[]; clipCount: number }
  | { status: 'unresolved'; reason: string }
  | { status: 'unsupported'; reason: string }

type LinearFit = {
  periodSec: number
  interceptSec: number
  sse: number
  rmsMs: number
  bpm: number
}

type PrefixSums = {
  ordinal: Float64Array
  time: Float64Array
  ordinalSquared: Float64Array
  ordinalTime: Float64Array
  timeSquared: Float64Array
}

type SegmentRange = {
  startIndex: number
  endIndexExclusive: number
}

type RangeEvaluation =
  | { status: 'ok'; fits: DynamicSegmentFit[] }
  | { status: 'fail'; fits: DynamicSegmentFit[]; failingIndex: number; reason: string }

const isUsableBpm = (bpm: number, minBpm: number, maxBpm: number): boolean =>
  Number.isFinite(bpm) && bpm >= minBpm - BPM_EPSILON && bpm <= maxBpm + BPM_EPSILON

const nearestRankPercentile = (values: readonly number[], percentile: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1))
  return sorted[index]
}

const median = (values: readonly number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const fitPointsDirect = (points: readonly DynamicFitPoint[]): LinearFit | null => {
  if (points.length < 2) return null
  let sumOrdinal = 0
  let sumTime = 0
  let sumOrdinalSquared = 0
  let sumOrdinalTime = 0
  let sumTimeSquared = 0
  for (const point of points) {
    sumOrdinal += point.ordinal
    sumTime += point.timeSec
    sumOrdinalSquared += point.ordinal * point.ordinal
    sumOrdinalTime += point.ordinal * point.timeSec
    sumTimeSquared += point.timeSec * point.timeSec
  }
  const count = points.length
  const sxx = sumOrdinalSquared - (sumOrdinal * sumOrdinal) / count
  if (sxx <= TIME_EPSILON_SEC) return null
  const sxy = sumOrdinalTime - (sumOrdinal * sumTime) / count
  const periodSec = sxy / sxx
  if (!Number.isFinite(periodSec) || periodSec <= 0) return null
  const interceptSec = (sumTime - periodSec * sumOrdinal) / count
  const syy = sumTimeSquared - (sumTime * sumTime) / count
  const sse = Math.max(0, syy - periodSec * sxy)
  return {
    periodSec,
    interceptSec,
    sse,
    rmsMs: Math.sqrt(sse / count) * 1000,
    bpm: 60 / periodSec
  }
}

const buildPrefixSums = (points: readonly DynamicFitPoint[]): PrefixSums => {
  const size = points.length + 1
  const ordinal = new Float64Array(size)
  const time = new Float64Array(size)
  const ordinalSquared = new Float64Array(size)
  const ordinalTime = new Float64Array(size)
  const timeSquared = new Float64Array(size)
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    ordinal[index + 1] = ordinal[index] + point.ordinal
    time[index + 1] = time[index] + point.timeSec
    ordinalSquared[index + 1] = ordinalSquared[index] + point.ordinal * point.ordinal
    ordinalTime[index + 1] = ordinalTime[index] + point.ordinal * point.timeSec
    timeSquared[index + 1] = timeSquared[index] + point.timeSec * point.timeSec
  }
  return { ordinal, time, ordinalSquared, ordinalTime, timeSquared }
}

const fitRangeWithPrefix = (
  prefix: PrefixSums,
  startIndex: number,
  endIndexExclusive: number
): LinearFit | null => {
  const count = endIndexExclusive - startIndex
  if (count < 2) return null
  const sumOrdinal = prefix.ordinal[endIndexExclusive] - prefix.ordinal[startIndex]
  const sumTime = prefix.time[endIndexExclusive] - prefix.time[startIndex]
  const sumOrdinalSquared =
    prefix.ordinalSquared[endIndexExclusive] - prefix.ordinalSquared[startIndex]
  const sumOrdinalTime = prefix.ordinalTime[endIndexExclusive] - prefix.ordinalTime[startIndex]
  const sumTimeSquared = prefix.timeSquared[endIndexExclusive] - prefix.timeSquared[startIndex]
  const sxx = sumOrdinalSquared - (sumOrdinal * sumOrdinal) / count
  if (sxx <= TIME_EPSILON_SEC) return null
  const sxy = sumOrdinalTime - (sumOrdinal * sumTime) / count
  const periodSec = sxy / sxx
  if (!Number.isFinite(periodSec) || periodSec <= 0) return null
  const interceptSec = (sumTime - periodSec * sumOrdinal) / count
  const syy = sumTimeSquared - (sumTime * sumTime) / count
  const sse = Math.max(0, syy - periodSec * sxy)
  return {
    periodSec,
    interceptSec,
    sse,
    rmsMs: Math.sqrt(sse / count) * 1000,
    bpm: 60 / periodSec
  }
}

const evaluateFit = (params: {
  points: readonly DynamicFitPoint[]
  startIndex: number
  endIndexExclusive: number
  fit: LinearFit
  policy: DynamicBeatGridPolicy
  minBpm: number
  maxBpm: number
}): { status: 'ok'; fit: DynamicSegmentFit } | { status: 'fail'; reason: string } => {
  const { points, startIndex, endIndexExclusive, fit, policy, minBpm, maxBpm } = params
  if (!isUsableBpm(fit.bpm, minBpm, maxBpm)) {
    return { status: 'fail', reason: `bpm-out-of-range:${fit.bpm.toFixed(6)}` }
  }
  const slice = points.slice(startIndex, endIndexExclusive)
  const residualsMs = slice.map(
    (point) => (point.timeSec - (fit.interceptSec + fit.periodSec * point.ordinal)) * 1000
  )
  const absResiduals = residualsMs.map((value) => Math.abs(value))
  const outlierIndices: number[] = []
  for (let index = 0; index < absResiduals.length; index += 1) {
    if (absResiduals[index] > policy.maxResidualMs) outlierIndices.push(index)
  }
  const excludedRatio = slice.length ? outlierIndices.length / slice.length : 1
  if (excludedRatio > policy.maxUnexplainedBeatRatio + 1e-9) {
    return {
      status: 'fail',
      reason: `unexplained-beats:${outlierIndices.length}/${slice.length}`
    }
  }
  const inlierSet = new Set<number>()
  for (let index = 0; index < slice.length; index += 1) {
    if (!outlierIndices.includes(index)) inlierSet.add(index)
  }
  const inliers = slice.filter((_, index) => inlierSet.has(index))
  const refined = inliers.length >= 2 ? fitPointsDirect(inliers) : null
  const usableFit = refined ?? fit
  if (!isUsableBpm(usableFit.bpm, minBpm, maxBpm)) {
    return { status: 'fail', reason: `bpm-out-of-range:${usableFit.bpm.toFixed(6)}` }
  }
  const inlierResiduals: number[] = []
  let inlierMax = 0
  for (let index = 0; index < slice.length; index += 1) {
    if (!inlierSet.has(index)) continue
    const residual =
      (slice[index].timeSec -
        (usableFit.interceptSec + usableFit.periodSec * slice[index].ordinal)) *
      1000
    const absResidual = Math.abs(residual)
    inlierResiduals.push(absResidual)
    if (absResidual > inlierMax) inlierMax = absResidual
  }
  if (!inlierResiduals.length) {
    return { status: 'fail', reason: 'no-inlier-beats' }
  }
  const p95 = nearestRankPercentile(inlierResiduals, 0.95)
  if (p95 > policy.p95ResidualMs + 1e-9) {
    return { status: 'fail', reason: `residual-p95:${p95.toFixed(3)}` }
  }
  if (inlierMax > policy.maxResidualMs + 1e-9) {
    return { status: 'fail', reason: `residual-max:${inlierMax.toFixed(3)}` }
  }

  const firstPoint = slice[0]
  const lastPoint = slice[slice.length - 1]
  const anchorTimeSec = usableFit.interceptSec + usableFit.periodSec * firstPoint.ordinal
  const lastFitSec = usableFit.interceptSec + usableFit.periodSec * lastPoint.ordinal
  const tailErrorMs = Math.abs(lastPoint.timeSec - lastFitSec) * 1000
  if (tailErrorMs > policy.maxResidualMs + 1e-9) {
    return { status: 'fail', reason: `tail-error:${tailErrorMs.toFixed(3)}` }
  }
  const boundaryErrorMs = Math.abs(firstPoint.timeSec - anchorTimeSec) * 1000

  return {
    status: 'ok',
    fit: {
      startIndex,
      endIndexExclusive,
      beatCount: slice.length,
      bpm: usableFit.bpm,
      periodSec: usableFit.periodSec,
      anchorTimeSec,
      anchorOrdinal: firstPoint.ordinal,
      firstBeatTimeSec: firstPoint.timeSec,
      lastBeatTimeSec: lastPoint.timeSec,
      lastGridTimeSec: lastFitSec,
      residualP50Ms: median(inlierResiduals),
      residualP95Ms: p95,
      residualMaxMs: inlierMax,
      residualSamplesMs: inlierResiduals,
      rmsMs: Math.sqrt(
        inlierResiduals.reduce((total, value) => total + value * value, 0) / inlierResiduals.length
      ),
      excludedCount: outlierIndices.length,
      excludedRatio,
      tailErrorMs,
      boundaryErrorMs
    }
  }
}

export const fitSingleDynamicBeatGrid = (params: {
  points: readonly DynamicFitPoint[]
  policy: DynamicBeatGridPolicy
  minBpm: number
  maxBpm: number
}): DynamicSingleFitResult => {
  const { points, policy, minBpm, maxBpm } = params
  if (points.length < 2) return { status: 'fail', reason: 'insufficient-beats' }
  const fit = fitPointsDirect(points)
  if (!fit) return { status: 'fail', reason: 'linear-fit-failed' }
  return evaluateFit({
    points,
    startIndex: 0,
    endIndexExclusive: points.length,
    fit,
    policy,
    minBpm,
    maxBpm
  })
}

const evaluateRanges = (params: {
  points: readonly DynamicFitPoint[]
  prefix: PrefixSums
  ranges: readonly SegmentRange[]
  policy: DynamicBeatGridPolicy
  minBpm: number
  maxBpm: number
}): RangeEvaluation => {
  const { points, prefix, ranges, policy, minBpm, maxBpm } = params
  const fits: DynamicSegmentFit[] = []
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]
    const fit = fitRangeWithPrefix(prefix, range.startIndex, range.endIndexExclusive)
    if (!fit) {
      return { status: 'fail', fits, failingIndex: index, reason: 'segment-linear-fit-failed' }
    }
    const evaluated = evaluateFit({
      points,
      startIndex: range.startIndex,
      endIndexExclusive: range.endIndexExclusive,
      fit,
      policy,
      minBpm,
      maxBpm
    })
    if (evaluated.status !== 'ok') {
      return { status: 'fail', fits, failingIndex: index, reason: evaluated.reason }
    }
    fits.push(evaluated.fit)
  }
  return { status: 'ok', fits }
}

const buildDpRanges = (params: {
  points: readonly DynamicFitPoint[]
  prefix: PrefixSums
  policy: DynamicBeatGridPolicy
  minBpm: number
  maxBpm: number
  rmsLimitMs: number
}):
  | { status: 'ok'; ranges: SegmentRange[] }
  | { status: 'none' }
  | { status: 'clip-limit'; count: number } => {
  const { points, prefix, policy, minBpm, maxBpm, rmsLimitMs } = params
  const totalPoints = points.length
  const minSegmentBeats = policy.minSegmentBeats
  if (totalPoints < minSegmentBeats * 2) return { status: 'none' }
  const unreachable = Number.POSITIVE_INFINITY
  const bestSegments = new Array<number>(totalPoints + 1).fill(unreachable)
  const bestCost = new Array<number>(totalPoints + 1).fill(unreachable)
  const previousIndex = new Array<number>(totalPoints + 1).fill(-1)
  bestSegments[0] = 0
  bestCost[0] = 0

  for (let endIndex = minSegmentBeats; endIndex <= totalPoints; endIndex += 1) {
    for (let startIndex = 0; startIndex <= endIndex - minSegmentBeats; startIndex += 1) {
      if (!Number.isFinite(bestSegments[startIndex])) continue
      const fit = fitRangeWithPrefix(prefix, startIndex, endIndex)
      if (!fit) continue
      if (!isUsableBpm(fit.bpm, minBpm, maxBpm)) continue
      if (fit.rmsMs > rmsLimitMs + 1e-9) continue
      const candidateSegments = bestSegments[startIndex] + 1
      const candidateCost = bestCost[startIndex] + fit.sse
      if (
        candidateSegments < bestSegments[endIndex] ||
        (candidateSegments === bestSegments[endIndex] && candidateCost < bestCost[endIndex] - 1e-12)
      ) {
        bestSegments[endIndex] = candidateSegments
        bestCost[endIndex] = candidateCost
        previousIndex[endIndex] = startIndex
      }
    }
  }

  if (!Number.isFinite(bestSegments[totalPoints])) return { status: 'none' }
  if (bestSegments[totalPoints] > policy.maxClips) {
    return { status: 'clip-limit', count: bestSegments[totalPoints] }
  }
  const ranges: SegmentRange[] = []
  let cursor = totalPoints
  while (cursor > 0) {
    const startIndex = previousIndex[cursor]
    if (startIndex < 0) return { status: 'none' }
    ranges.push({ startIndex, endIndexExclusive: cursor })
    cursor = startIndex
  }
  ranges.reverse()
  if (ranges.length < 2) return { status: 'none' }
  return { status: 'ok', ranges }
}

const splitFailingRange = (params: {
  points: readonly DynamicFitPoint[]
  range: SegmentRange
  policy: DynamicBeatGridPolicy
}): SegmentRange[] | null => {
  const { points, range, policy } = params
  const slice = points.slice(range.startIndex, range.endIndexExclusive)
  const fit = fitPointsDirect(slice)
  if (!fit) return null
  const minIndex = range.startIndex + policy.minSegmentBeats
  const maxIndex = range.endIndexExclusive - policy.minSegmentBeats
  if (minIndex > maxIndex) return null
  let splitIndex = minIndex
  let maxResidual = -1
  for (let index = minIndex; index <= maxIndex; index += 1) {
    const point = points[index]
    const residual = Math.abs(point.timeSec - (fit.interceptSec + fit.periodSec * point.ordinal))
    if (residual > maxResidual) {
      maxResidual = residual
      splitIndex = index
    }
  }
  return [
    { startIndex: range.startIndex, endIndexExclusive: splitIndex },
    { startIndex: splitIndex, endIndexExclusive: range.endIndexExclusive }
  ]
}

export const fitSegmentedDynamicBeatGrid = (params: {
  points: readonly DynamicFitPoint[]
  policy: DynamicBeatGridPolicy
  minBpm: number
  maxBpm: number
}): DynamicSegmentedFitResult => {
  const { points, policy, minBpm, maxBpm } = params
  const totalPoints = points.length
  if (totalPoints < policy.minSegmentBeats * 2) {
    return { status: 'unresolved', reason: `insufficient-beats-for-segments:${totalPoints}` }
  }
  const prefix = buildPrefixSums(points)
  let fallbackRanges: SegmentRange[] | null = null
  let fallbackReason = 'no-valid-segmentation'

  for (let attempt = 0; attempt < policy.segmentRmsRetryCount; attempt += 1) {
    const rmsLimitMs = Math.max(
      policy.segmentMinRmsMs,
      policy.segmentMaxRmsMs * policy.segmentRmsRetryFactor ** attempt
    )
    const solution = buildDpRanges({
      points,
      prefix,
      policy,
      minBpm,
      maxBpm,
      rmsLimitMs
    })
    if (solution.status === 'clip-limit') {
      return { status: 'unsupported', reason: `clip-limit:${solution.count}>${policy.maxClips}` }
    }
    if (solution.status === 'none') break
    const evaluated = evaluateRanges({
      points,
      prefix,
      ranges: solution.ranges,
      policy,
      minBpm,
      maxBpm
    })
    if (evaluated.status === 'ok') {
      const fits = evaluated.fits
      for (let index = 1; index < fits.length; index += 1) {
        if (fits[index].anchorTimeSec <= fits[index - 1].anchorTimeSec + TIME_EPSILON_SEC) {
          return { status: 'unresolved', reason: 'segment-boundary-order' }
        }
      }
      return { status: 'ok', fits, clipCount: fits.length }
    }
    fallbackRanges = solution.ranges
    fallbackReason = `segment-fit-failed:${evaluated.reason}`
  }

  if (!fallbackRanges) return { status: 'unresolved', reason: fallbackReason }
  let ranges = [...fallbackRanges]
  let evaluated = evaluateRanges({ points, prefix, ranges, policy, minBpm, maxBpm })
  while (evaluated.status !== 'ok') {
    if (ranges.length >= policy.maxClips) {
      return { status: 'unsupported', reason: `clip-limit:${ranges.length + 1}>${policy.maxClips}` }
    }
    const failingIndex = evaluated.failingIndex
    const failingRange = ranges[failingIndex]
    const split = splitFailingRange({ points, range: failingRange, policy })
    if (!split) {
      return {
        status: 'unresolved',
        reason: `segment-cannot-split:${failingRange.startIndex}-${failingRange.endIndexExclusive}:${evaluated.reason}`
      }
    }
    ranges = [...ranges.slice(0, failingIndex), ...split, ...ranges.slice(failingIndex + 1)]
    evaluated = evaluateRanges({ points, prefix, ranges, policy, minBpm, maxBpm })
  }
  for (let index = 1; index < evaluated.fits.length; index += 1) {
    if (
      evaluated.fits[index].anchorTimeSec <=
      evaluated.fits[index - 1].anchorTimeSec + TIME_EPSILON_SEC
    ) {
      return { status: 'unresolved', reason: 'segment-boundary-order' }
    }
  }
  return { status: 'ok', fits: evaluated.fits, clipCount: evaluated.fits.length }
}
