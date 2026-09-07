import {
  MAX_SECTIONS,
  clamp,
  clamp01,
  ramp,
  toFixedNumber,
  type SongStructureSection,
  type SongStructureSectionKind
} from './songStructureCommon'
import {
  resolveSongStructureBuildRampScore,
  SONG_STRUCTURE_BUILD_RAMP_MIN_SCORE,
  type SongStructureSpectralBoundary,
  type SongStructureSpectralClusteringResult
} from './songStructureSpectralClustering'
import {
  refineTerminalOutroRanges,
  type SongStructureSemanticRange as SemanticRange
} from './songStructureSemanticOutro'
import { refineContextualBuildRanges } from './songStructureSemanticBuild'
import { refineFoundationLandingBuildRanges } from './songStructureSemanticFoundationLanding'
import {
  isDecisiveActiveReentry,
  positiveSongStructureActivityDifference as positiveDifference,
  resolveActiveSemanticScore,
  resolveInactiveSemanticScore,
  resolveSongStructureSemanticActivity as resolveSemanticActivity
} from './songStructureSemanticActivity'
import { resolveSongStructureMacroActivityKinds } from './songStructureSemanticMacroActivity'
import { refineSongStructureSemanticStateKinds } from './songStructureSemanticStateGuards'
import { stabilizeSongStructureSemanticRanges } from './songStructureSemanticStability'
import { refinePostBreakdownStructuralReentries } from './songStructureSemanticReentry'
import { refineSongStructureSemanticBoundaryAlignment } from './songStructureSemanticBoundaryAlignment'
import { resolveSongStructureSoftMotifRepetition } from './songStructureStructuralEvidence'
import * as inactiveValley from './songStructureSemanticInactiveValley'
import {
  SONG_STRUCTURE_SPECTRAL_VALUE_KEYS,
  cosineSimilarity,
  type SongStructureSpectralBarFeature,
  type SongStructureSpectralValues
} from './songStructureSpectralFeatures'

const SECTION_KINDS: readonly SongStructureSectionKind[] = [
  'intro',
  'groove',
  'breakdown',
  'build',
  'drop',
  'outro'
]

export type SongStructureSemanticScores = Record<SongStructureSectionKind, number>

type SemanticSegment = {
  startIndex: number
  endIndex: number
  clusterId: number
  boundaryScore: number
  bars: number
  startProgress: number
  endProgress: number
  values: SongStructureSpectralValues
  normalized: SongStructureSpectralValues
  trend: SongStructureSpectralValues
  entryRise: number
  entryTimbre: number
  nextRise: number
  relativeReduction: number
  stability: number
  repetition: number
  buildRamp: number
  scores: SongStructureSemanticScores
}

export type SongStructureSemanticDiagnostic = {
  startIndex: number
  endIndex: number
  decodedKind: SongStructureSectionKind
  guardedKind: SongStructureSectionKind
  entryRise: number
  entryTimbre: number
  nextRise: number
  relativeReduction: number
  activity: number
  stability: number
  buildRamp: number
  normalized: SongStructureSpectralValues
  scores: SongStructureSemanticScores
}

const createEmptyValues = (): SongStructureSpectralValues => ({
  energy: 0,
  low: 0,
  mid: 0,
  high: 0,
  attack: 0,
  attackDensity: 0,
  density: 0,
  brightness: 0,
  crest: 0,
  lowShare: 0,
  midShare: 0,
  highShare: 0
})

const averageValues = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number,
  field: 'values' | 'normalized'
) => {
  const start = clamp(Math.floor(startIndex), 0, bars.length)
  const end = clamp(Math.ceil(endIndex), start, bars.length)
  const result = createEmptyValues()
  if (end <= start) return result
  for (let index = start; index < end; index += 1) {
    const values = bars[index]?.[field]
    if (!values) continue
    for (const key of SONG_STRUCTURE_SPECTRAL_VALUE_KEYS) {
      result[key] += values[key] / (end - start)
    }
  }
  return result
}

const resolveModeCluster = (
  clusterIds: readonly number[],
  startIndex: number,
  endIndex: number
) => {
  const counts = new Map<number, number>()
  for (let index = startIndex; index < endIndex; index += 1) {
    const clusterId = clusterIds[index] ?? 0
    counts.set(clusterId, (counts.get(clusterId) ?? 0) + 1)
  }
  let bestCluster = 0
  let bestCount = -1
  for (const [clusterId, count] of counts) {
    if (count > bestCount || (count === bestCount && clusterId < bestCluster)) {
      bestCluster = clusterId
      bestCount = count
    }
  }
  return bestCluster
}

const resolveTrend = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number
) => {
  const midpoint = startIndex + Math.max(1, Math.floor((endIndex - startIndex) / 2))
  const first = averageValues(bars, startIndex, midpoint, 'normalized')
  const second = averageValues(bars, midpoint, endIndex, 'normalized')
  const result = createEmptyValues()
  for (const key of SONG_STRUCTURE_SPECTRAL_VALUE_KEYS) {
    result[key] = clamp(second[key] - first[key], -1, 1)
  }
  return result
}

const averageLocalVector = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number
) => {
  const start = clamp(startIndex, 0, bars.length)
  const end = clamp(endIndex, start, bars.length)
  const dimensions = bars[0]?.localVector.length ?? 0
  const result = new Array(dimensions).fill(0)
  if (end <= start) return result
  for (let index = start; index < end; index += 1) {
    const vector = bars[index]?.localVector
    if (!vector) continue
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      result[dimension] += (vector[dimension] ?? 0) / (end - start)
    }
  }
  return result
}

const resolveStability = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number
) => {
  if (endIndex - startIndex <= 1) return 0.5
  let distanceSum = 0
  let count = 0
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const previous = bars[index - 1]?.localVector ?? []
    const current = bars[index]?.localVector ?? []
    distanceSum += clamp01((1 - cosineSimilarity(previous, current)) / 2)
    count += 1
  }
  return 1 - ramp(distanceSum / Math.max(1, count), 0.08, 0.52)
}

const toRank = (value: number) => clamp01(value * 0.5 + 0.5)

const createEmptyScores = (): SongStructureSemanticScores => ({
  intro: 0,
  groove: 0,
  breakdown: 0,
  build: 0,
  drop: 0,
  outro: 0
})

const scoreSegment = (
  segment: Omit<SemanticSegment, 'scores'>,
  segmentIndex: number,
  segmentCount: number
): SongStructureSemanticScores => {
  const scores = createEmptyScores()
  const energy = toRank(segment.normalized.energy)
  const low = toRank(segment.normalized.low)
  const mid = toRank(segment.normalized.mid)
  const attack = toRank(segment.normalized.attackDensity)
  const density = toRank(segment.normalized.density)
  const active = resolveSemanticActivity(segment.normalized)
  const thin = clamp01(
    (1 - density) * 0.34 +
      (1 - low) * 0.2 +
      (1 - mid) * 0.16 +
      (1 - attack) * 0.2 +
      (1 - energy) * 0.1
  )
  const early = 1 - ramp(segment.startProgress, 0.08, 0.38)
  const late = ramp(segment.endProgress, 0.68, 0.94)
  const corePosition =
    ramp(segment.startProgress, 0.1, 0.26) * (1 - ramp(segment.endProgress, 0.82, 0.97))
  const risingHigh = clamp01(
    Math.max(0, segment.trend.high) * 0.34 +
      Math.max(0, segment.trend.mid) * 0.2 +
      Math.max(0, segment.trend.brightness) * 0.16 +
      Math.max(0, segment.trend.attackDensity) * 0.3
  )
  const risingDensity = clamp01(
    Math.max(0, segment.trend.density) * 0.52 +
      Math.max(0, segment.trend.attackDensity) * 0.3 +
      Math.max(0, segment.trend.energy) * 0.18
  )
  const fallingDensity = clamp01(
    Math.max(0, -segment.trend.density) * 0.45 +
      Math.max(0, -segment.trend.attackDensity) * 0.25 +
      Math.max(0, -segment.trend.low) * 0.18 +
      Math.max(0, -segment.trend.energy) * 0.12
  )
  const reduced = clamp01(
    segment.relativeReduction * 0.58 + (1 - density) * 0.24 + (1 - low) * 0.18
  )
  const transitionStrength = clamp01(
    segment.entryRise * 0.58 + segment.entryTimbre * 0.3 + segment.nextRise * 0.12
  )
  const buildMomentum = Math.max(risingHigh, risingDensity)
  const buildRampEvidence = ramp(
    segment.buildRamp,
    SONG_STRUCTURE_BUILD_RAMP_MIN_SCORE - 0.04,
    0.62
  )

  scores.intro = clamp01(
    early * 0.3 +
      thin * 0.2 +
      risingDensity * 0.12 +
      (segmentIndex === 0 ? 1 : 0) * 0.2 +
      (1 - segment.entryRise) * 0.06
  )
  scores.outro = clamp01(
    late * 0.31 +
      thin * 0.16 +
      fallingDensity * 0.17 +
      (segmentIndex === segmentCount - 1 ? 1 : 0) * 0.2 +
      (1 - segment.nextRise) * 0.04
  )
  scores.breakdown = clamp01(
    reduced * 0.34 +
      (1 - low) * 0.14 +
      (1 - attack) * 0.13 +
      mid * 0.07 +
      segment.entryTimbre * 0.1 +
      corePosition * 0.1
  )
  scores.build = clamp01(
    buildRampEvidence * 0.32 +
      risingHigh * 0.2 +
      risingDensity * 0.28 +
      segment.nextRise * 0.05 +
      (1 - low) * 0.04 +
      segment.entryTimbre * 0.05 +
      corePosition * 0.04 +
      (1 - segment.stability) * 0.02
  )
  scores.drop = clamp01(
    active * 0.25 +
      low * 0.13 +
      attack * 0.1 +
      segment.entryRise * 0.2 +
      segment.entryTimbre * 0.08 +
      segment.stability * 0.08 +
      segment.repetition * 0.06 +
      corePosition * 0.04
  )
  scores.groove =
    clamp01(
      active * 0.29 +
        segment.stability * 0.21 +
        segment.repetition * 0.17 +
        (1 - transitionStrength) * 0.12 +
        corePosition * 0.08
    ) *
    (1 - Math.max(buildMomentum, buildRampEvidence) * 0.32)
  scores.breakdown *= 1 - Math.max(buildMomentum, buildRampEvidence) * 0.18
  return scores
}

const buildSemanticSegments = (
  bars: readonly SongStructureSpectralBarFeature[],
  clustering: SongStructureSpectralClusteringResult
) => {
  const rawSegments: Array<Omit<SemanticSegment, 'repetition' | 'scores'>> = []
  for (let index = 0; index < clustering.boundaries.length - 1; index += 1) {
    const boundary = clustering.boundaries[index]
    const nextBoundary = clustering.boundaries[index + 1]
    if (!boundary || !nextBoundary || nextBoundary.index <= boundary.index) continue
    const startIndex = boundary.index
    const endIndex = nextBoundary.index
    const normalized = averageValues(bars, startIndex, endIndex, 'normalized')
    const hasPrevious = startIndex > 0
    const hasNext = endIndex < bars.length
    const currentStart = averageValues(
      bars,
      startIndex,
      Math.min(endIndex, startIndex + 4),
      'normalized'
    )
    const currentEnd = averageValues(
      bars,
      Math.max(startIndex, endIndex - 4),
      endIndex,
      'normalized'
    )
    const previous = hasPrevious
      ? averageValues(bars, Math.max(0, startIndex - 4), startIndex, 'normalized')
      : currentStart
    const next = hasNext
      ? averageValues(bars, endIndex, Math.min(bars.length, endIndex + 4), 'normalized')
      : currentEnd
    const entryLeft = averageLocalVector(bars, Math.max(0, startIndex - 4), startIndex)
    const entryRight = averageLocalVector(bars, startIndex, Math.min(endIndex, startIndex + 4))
    const previousDensityReduction = hasPrevious
      ? Math.max(0, previous.density - normalized.density, previous.low - normalized.low)
      : 0
    const nextDensityReduction = hasNext
      ? Math.max(0, next.density - normalized.density, next.low - normalized.low)
      : 0
    rawSegments.push({
      startIndex,
      endIndex,
      clusterId: resolveModeCluster(clustering.clusterIds, startIndex, endIndex),
      boundaryScore: boundary.score,
      bars: endIndex - startIndex,
      startProgress: startIndex / Math.max(1, bars.length),
      endProgress: endIndex / Math.max(1, bars.length),
      values: averageValues(bars, startIndex, endIndex, 'values'),
      normalized,
      trend: resolveTrend(bars, startIndex, endIndex),
      entryRise: hasPrevious ? positiveDifference(currentStart, previous) : 0,
      entryTimbre: hasPrevious ? clamp01((1 - cosineSimilarity(entryLeft, entryRight)) / 2) : 0,
      nextRise: hasNext ? positiveDifference(next, currentEnd) : 0,
      relativeReduction: clamp01(Math.max(previousDensityReduction, nextDensityReduction)),
      stability: resolveStability(bars, startIndex, endIndex),
      buildRamp: resolveSongStructureBuildRampScore(bars, startIndex, endIndex)
    })
  }

  const clusterCounts = new Map<number, { segments: number; bars: number }>()
  for (const segment of rawSegments) {
    const current = clusterCounts.get(segment.clusterId) ?? { segments: 0, bars: 0 }
    current.segments += 1
    current.bars += segment.bars
    clusterCounts.set(segment.clusterId, current)
  }
  const softMotifRepetition = resolveSongStructureSoftMotifRepetition(bars, rawSegments)
  return rawSegments.map((segment, index): SemanticSegment => {
    const cluster = clusterCounts.get(segment.clusterId) ?? { segments: 1, bars: segment.bars }
    const clusterRepetition = clamp01(
      ramp(cluster.segments, 1, 3) * 0.72 +
        ramp(cluster.bars / Math.max(1, bars.length), 0.08, 0.38) * 0.28
    )
    const repetition = Math.max(clusterRepetition, (softMotifRepetition[index] ?? 0) * 0.9)
    const withRepetition = {
      ...segment,
      repetition
    }
    return {
      ...withRepetition,
      scores: scoreSegment(withRepetition, index, rawSegments.length)
    }
  })
}

export const buildSongStructureSemanticDiagnostics = (
  bars: readonly SongStructureSpectralBarFeature[],
  clustering: SongStructureSpectralClusteringResult
): SongStructureSemanticDiagnostic[] => {
  const segments = buildSemanticSegments(bars, clustering)
  const decoded = decodeSemanticKinds(segments)
  const guarded = applySemanticGuards(segments, decoded)
  return segments.map((segment, index) => ({
    startIndex: segment.startIndex,
    endIndex: segment.endIndex,
    decodedKind: decoded[index] ?? 'groove',
    guardedKind: guarded[index] ?? 'groove',
    entryRise: segment.entryRise,
    entryTimbre: segment.entryTimbre,
    nextRise: segment.nextRise,
    relativeReduction: segment.relativeReduction,
    activity: resolveSemanticActivity(segment.normalized),
    stability: segment.stability,
    buildRamp: segment.buildRamp,
    normalized: { ...segment.normalized },
    scores: { ...segment.scores }
  }))
}

const resolveTransitionScore = (
  previous: SongStructureSectionKind,
  current: SongStructureSectionKind
) => {
  if (previous === current) return 0.04
  if (previous === 'intro') {
    if (current === 'groove' || current === 'build') return 0.09
    if (current === 'drop') return 0.04
    if (current === 'outro') return -0.28
  }
  if (previous === 'groove') {
    if (current === 'breakdown' || current === 'build') return 0.08
    if (current === 'outro') return 0.07
  }
  if (previous === 'breakdown') {
    if (current === 'build') return 0.14
    if (current === 'drop') return 0.26
    if (current === 'groove') return 0.06
  }
  if (previous === 'build') {
    if (current === 'drop') return 0.24
    if (current === 'groove') return 0.06
    if (current === 'breakdown') return -0.08
  }
  if (previous === 'drop') {
    if (current === 'breakdown') return 0.11
    if (current === 'groove' || current === 'outro') return 0.07
    if (current === 'build') return -0.06
  }
  if (previous === 'outro') return -0.42
  return -0.025
}

const decodeSemanticKinds = (segments: readonly SemanticSegment[]) => {
  if (!segments.length) return []
  if (segments.length === 1) return ['groove'] satisfies SongStructureSectionKind[]
  const scores = segments.map(() => new Array(SECTION_KINDS.length).fill(-Infinity))
  const previousKinds = segments.map(() => new Array(SECTION_KINDS.length).fill(-1))

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex]
    if (!segment) continue
    for (let kindIndex = 0; kindIndex < SECTION_KINDS.length; kindIndex += 1) {
      const kind = SECTION_KINDS[kindIndex]
      if (!kind) continue
      let emission = segment.scores[kind]
      if (kind === 'intro' && segmentIndex > 1) emission -= 0.34
      if (kind === 'outro' && segmentIndex < segments.length - 2) emission -= 0.34
      if (segmentIndex === 0) {
        const startPrior = kind === 'intro' ? 0.18 : kind === 'groove' ? 0.03 : -0.08
        scores[segmentIndex]![kindIndex] = emission + startPrior
        continue
      }
      for (
        let previousKindIndex = 0;
        previousKindIndex < SECTION_KINDS.length;
        previousKindIndex += 1
      ) {
        const previousKind = SECTION_KINDS[previousKindIndex]
        if (!previousKind) continue
        const candidate =
          (scores[segmentIndex - 1]?.[previousKindIndex] ?? -Infinity) +
          emission +
          resolveTransitionScore(previousKind, kind)
        if (candidate > (scores[segmentIndex]?.[kindIndex] ?? -Infinity)) {
          scores[segmentIndex]![kindIndex] = candidate
          previousKinds[segmentIndex]![kindIndex] = previousKindIndex
        }
      }
    }
  }

  const lastIndex = segments.length - 1
  let bestKindIndex = 0
  let bestScore = -Infinity
  for (let kindIndex = 0; kindIndex < SECTION_KINDS.length; kindIndex += 1) {
    const kind = SECTION_KINDS[kindIndex]
    if (!kind) continue
    const endPrior = kind === 'outro' ? 0.18 : kind === 'intro' ? -0.4 : 0
    const candidate = (scores[lastIndex]?.[kindIndex] ?? -Infinity) + endPrior
    if (candidate > bestScore) {
      bestScore = candidate
      bestKindIndex = kindIndex
    }
  }

  const result = new Array<SongStructureSectionKind>(segments.length)
  for (let segmentIndex = lastIndex; segmentIndex >= 0; segmentIndex -= 1) {
    result[segmentIndex] = SECTION_KINDS[bestKindIndex] ?? 'groove'
    bestKindIndex = previousKinds[segmentIndex]?.[bestKindIndex] ?? 0
    if (bestKindIndex < 0 && segmentIndex > 0) bestKindIndex = 0
  }
  return result
}

const MAX_PENDING_BREAKDOWN_BARS = 24
const MAX_CONTEXTUAL_DROP_GROOVE_ADVANTAGE = 0.14

const isLowActivityContext = (segment: SemanticSegment) =>
  segment.scores.breakdown >= resolveActiveSemanticScore(segment) - 0.04 &&
  resolveSemanticActivity(segment.normalized) <= 0.58

const isDropCompetitiveAtContextualReentry = (segment: SemanticSegment) =>
  segment.scores.drop >= segment.scores.groove - MAX_CONTEXTUAL_DROP_GROOVE_ADVANTAGE

const isDirectDropLanding = (previous: SemanticSegment, current: SemanticSegment) => {
  const previousActivity = resolveSemanticActivity(previous.normalized)
  const currentActivity = resolveSemanticActivity(current.normalized)
  const hasStrongStructuralBoundary = current.boundaryScore >= 0.5 && current.scores.drop >= 0.5
  return (
    current.entryRise >= 0.22 &&
    current.entryTimbre >= 0.45 &&
    currentActivity - previousActivity >= 0.06 &&
    currentActivity >= 0.52 &&
    (current.scores.drop >= 0.58 || hasStrongStructuralBoundary) &&
    isDropCompetitiveAtContextualReentry(current)
  )
}

const isPreDropRecoveryPlateau = (
  previousKind: SongStructureSectionKind | undefined,
  current: SemanticSegment,
  next: SemanticSegment | undefined
) =>
  previousKind === 'breakdown' &&
  current.scores.groove >= current.scores.drop + 0.14 &&
  resolveSemanticActivity(current.normalized) < 0.5 &&
  !!next &&
  isDirectDropLanding(current, next)

const applyBuildContextGuards = (
  segments: readonly SemanticSegment[],
  decoded: readonly SongStructureSectionKind[]
) => {
  const result = [...decoded]
  for (let index = 0; index < result.length; index += 1) {
    const segment = segments[index]
    if (!segment) continue
    const previousSegment = segments[index - 1]
    const nextSegment = segments[index + 1]
    const previousLowContext =
      result[index - 1] === 'breakdown' ||
      (!!previousSegment && isLowActivityContext(previousSegment))
    const nextActiveReentry =
      !!nextSegment &&
      (isDecisiveActiveReentry(segment, nextSegment) ||
        resolveActiveSemanticScore(nextSegment) >= resolveInactiveSemanticScore(nextSegment) + 0.06)
    const explicitBuildRamp =
      previousLowContext &&
      nextActiveReentry &&
      !isDecisiveActiveReentry(previousSegment, segment) &&
      segment.buildRamp >= SONG_STRUCTURE_BUILD_RAMP_MIN_SCORE &&
      segment.bars <= 16 &&
      segment.scores.build >= 0.22
    if (explicitBuildRamp) {
      result[index] = 'build'
      continue
    }
    if (result[index] !== 'build') continue
    if (result[index - 1] === 'drop') {
      result[index] = 'drop'
    } else {
      result[index] = isLowActivityContext(segment) ? 'breakdown' : 'groove'
    }
  }
  return result
}

const resolveSegmentRangeAverage = (
  segments: readonly SemanticSegment[],
  startIndex: number,
  endIndex: number,
  resolveValue: (segment: SemanticSegment) => number
) => {
  let weightedTotal = 0
  let totalBars = 0
  for (let index = startIndex; index < endIndex; index += 1) {
    const segment = segments[index]
    if (!segment) continue
    weightedTotal += resolveValue(segment) * segment.bars
    totalBars += segment.bars
  }
  return totalBars > 0 ? weightedTotal / totalBars : 0
}

const isConfirmedBreakdownRange = (
  segments: readonly SemanticSegment[],
  startIndex: number,
  endIndex: number,
  dropBaseline: number
) => {
  const bars = segments
    .slice(startIndex, endIndex)
    .reduce((total, segment) => total + segment.bars, 0)
  const activity = resolveSegmentRangeAverage(segments, startIndex, endIndex, (segment) =>
    resolveSemanticActivity(segment.normalized)
  )
  const breakdownScore = resolveSegmentRangeAverage(
    segments,
    startIndex,
    endIndex,
    (segment) => segment.scores.breakdown
  )
  const activeScore = resolveSegmentRangeAverage(segments, startIndex, endIndex, (segment) =>
    resolveActiveSemanticScore(segment)
  )
  const previous = segments[startIndex - 1]
  const next = segments[endIndex]
  const surroundingPeak = Math.max(
    previous ? resolveSemanticActivity(previous.normalized) : 0,
    next ? resolveSemanticActivity(next.normalized) : 0
  )
  const baselineReduction = dropBaseline - activity
  const surroundingReduction = surroundingPeak - activity
  const scoreMargin = breakdownScore - activeScore
  const entryBoundaryScore = segments[startIndex]?.boundaryScore ?? 0

  if (bars < 4) return false
  if (bars < 8) {
    return (
      (baselineReduction >= 0.065 && entryBoundaryScore >= 0.34) ||
      surroundingReduction >= 0.12 ||
      scoreMargin >= 0.1 ||
      breakdownScore >= 0.82
    )
  }
  if (
    breakdownScore < activeScore - 0.08 &&
    baselineReduction < 0.12 &&
    surroundingReduction < 0.14
  ) {
    return false
  }
  return (
    baselineReduction >= 0.055 ||
    surroundingReduction >= 0.075 ||
    scoreMargin >= 0.055 ||
    breakdownScore >= 0.76
  )
}

const isConfirmedTerminalOutroSegment = (segment: SemanticSegment, dropBaseline: number) => {
  const activity = resolveSemanticActivity(segment.normalized)
  const activityDrop = dropBaseline - activity
  const semanticMargin = segment.scores.outro - resolveActiveSemanticScore(segment)
  return (
    segment.relativeReduction >= 0.12 ||
    activityDrop >= 0.12 ||
    (segment.entryRise < 0.065 &&
      semanticMargin >= 0.14 &&
      Math.max(segment.relativeReduction, activityDrop) >= 0.055)
  )
}

const isContinuousDropCore = (segment: SemanticSegment, dropBaseline: number) => {
  const activity = resolveSemanticActivity(segment.normalized)
  return segment.relativeReduction < 0.2 && activity >= dropBaseline - 0.085
}

const isShortDropBridge = (segment: SemanticSegment, dropBaseline: number) =>
  segment.bars <= 4 && resolveSemanticActivity(segment.normalized) >= dropBaseline - 0.1

const propagateMacroSemanticStates = (
  segments: readonly SemanticSegment[],
  kinds: readonly SongStructureSectionKind[]
) => {
  const result = [...kinds]
  let inDrop = false
  let dropBaseline = 0
  let pendingBreakdownBars: number | null = null
  for (let index = 0; index < result.length; index += 1) {
    const segment = segments[index]
    const kind = result[index]
    if (!segment || !kind) continue
    if (kind === 'intro') {
      inDrop = false
      dropBaseline = 0
      pendingBreakdownBars = null
      continue
    }
    if (kind === 'outro') {
      if (inDrop && !isConfirmedTerminalOutroSegment(segment, dropBaseline)) {
        result[index] = 'drop'
        dropBaseline = Math.max(dropBaseline * 0.985, resolveSemanticActivity(segment.normalized))
        pendingBreakdownBars = null
        continue
      }
      inDrop = false
      dropBaseline = 0
      pendingBreakdownBars = null
      continue
    }
    const previous = segments[index - 1]
    if (previous && kind !== 'build' && isDirectDropLanding(previous, segment)) {
      result[index] = 'drop'
      inDrop = true
      dropBaseline = resolveSemanticActivity(segment.normalized)
      pendingBreakdownBars = null
      continue
    }
    if (kind === 'breakdown') {
      let endIndex = index + 1
      while (endIndex < result.length && result[endIndex] === 'breakdown') endIndex += 1
      if (inDrop && !isConfirmedBreakdownRange(segments, index, endIndex, dropBaseline)) {
        for (let fillIndex = index; fillIndex < endIndex; fillIndex += 1) {
          result[fillIndex] = 'drop'
        }
        index = endIndex - 1
        continue
      }
      inDrop = false
      dropBaseline = 0
      pendingBreakdownBars = 0
      index = endIndex - 1
      continue
    }

    const previousKind = result[index - 1]
    const next = segments[index + 1]
    if (kind === 'drop' && isPreDropRecoveryPlateau(previousKind, segment, next)) {
      result[index] = 'groove'
      inDrop = false
      dropBaseline = 0
      pendingBreakdownBars = null
      continue
    }
    const contextualDrop =
      !!previous &&
      kind !== 'build' &&
      (previousKind === 'breakdown' || previousKind === 'build' || pendingBreakdownBars !== null) &&
      isDecisiveActiveReentry(previous, segment) &&
      (kind !== 'groove' ||
        previousKind === 'build' ||
        isDropCompetitiveAtContextualReentry(segment))
    if (contextualDrop) {
      result[index] = 'drop'
      inDrop = true
      dropBaseline = resolveSemanticActivity(segment.normalized)
      pendingBreakdownBars = null
      continue
    }
    if (
      inDrop &&
      (kind === 'drop' ||
        (kind === 'groove' &&
          (isContinuousDropCore(segment, dropBaseline) ||
            (isShortDropBridge(segment, dropBaseline) && result[index + 1] !== 'breakdown'))))
    ) {
      result[index] = 'drop'
      dropBaseline = Math.max(dropBaseline * 0.985, resolveSemanticActivity(segment.normalized))
      pendingBreakdownBars = null
      continue
    }
    if (inDrop && (kind === 'groove' || kind === 'build')) {
      inDrop = false
      dropBaseline = 0
      pendingBreakdownBars = null
    }
    if (kind === 'drop') {
      const weakIsolatedDrop =
        segment.scores.drop < 0.48 &&
        segment.scores.drop <= segment.scores.groove + 0.015 &&
        segment.entryRise < 0.075 &&
        (segment.bars <= 8 || resolveSemanticActivity(segment.normalized) < 0.5)
      if (weakIsolatedDrop) {
        result[index] = 'groove'
        continue
      }
      inDrop = true
      dropBaseline = resolveSemanticActivity(segment.normalized)
      pendingBreakdownBars = null
      continue
    }
    if (pendingBreakdownBars !== null) {
      pendingBreakdownBars += segment.bars
      if (pendingBreakdownBars > MAX_PENDING_BREAKDOWN_BARS) pendingBreakdownBars = null
    }
  }
  return result
}

const smoothSemanticKinds = (
  segments: readonly SemanticSegment[],
  kinds: readonly SongStructureSectionKind[]
) => {
  const result = [...kinds]
  for (let iteration = 0; iteration < result.length; iteration += 1) {
    let changed = false
    for (let index = 1; index < result.length - 1; index += 1) {
      const previousKind = result[index - 1]
      const currentKind = result[index]
      const nextKind = result[index + 1]
      const segment = segments[index]
      if (!segment || previousKind !== nextKind || previousKind === currentKind) continue
      if (
        previousKind === 'drop' &&
        currentKind !== 'intro' &&
        currentKind !== 'outro' &&
        segment.bars <= 8
      ) {
        const previousActivity = resolveSemanticActivity(segments[index - 1]!.normalized)
        if (
          currentKind !== 'breakdown' ||
          !isConfirmedBreakdownRange(segments, index, index + 1, previousActivity)
        ) {
          result[index] = 'drop'
          changed = true
        }
      } else if (
        previousKind === 'breakdown' &&
        (currentKind === 'groove' || currentKind === 'build') &&
        segment.bars <= 8 &&
        !isDecisiveActiveReentry(segments[index - 1]!, segment)
      ) {
        result[index] = 'breakdown'
        changed = true
      }
    }
    if (!changed) break
  }
  return result
}

const applySemanticGuards = (
  segments: readonly SemanticSegment[],
  decoded: readonly SongStructureSectionKind[]
) => {
  const buildGuarded = applyBuildContextGuards(segments, decoded)
  const bridgedBreakdowns = resolveSongStructureMacroActivityKinds(segments, buildGuarded)
  const propagated = propagateMacroSemanticStates(segments, bridgedBreakdowns)
  const macroResolved = resolveSongStructureMacroActivityKinds(segments, propagated)
  const stateRefined = refineSongStructureSemanticStateKinds(segments, macroResolved)
  return smoothSemanticKinds(segments, stateRefined)
}

const resolveSemanticConfidence = (segment: SemanticSegment, kind: SongStructureSectionKind) => {
  const selected = segment.scores[kind]
  const strongestAlternative = Math.max(
    ...SECTION_KINDS.filter((candidate) => candidate !== kind).map(
      (candidate) => segment.scores[candidate]
    )
  )
  const margin = Math.max(0, selected - strongestAlternative)
  return clamp01(
    0.38 + ramp(margin, 0.015, 0.22) * 0.3 + segment.boundaryScore * 0.18 + segment.stability * 0.14
  )
}

const mergeSemanticRanges = (
  segments: readonly SemanticSegment[],
  kinds: readonly SongStructureSectionKind[]
) => {
  const ranges: SemanticRange[] = []
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const kind = kinds[index] ?? 'groove'
    if (!segment) continue
    const confidence = resolveSemanticConfidence(segment, kind)
    const previous = ranges[ranges.length - 1]
    const previousBars = previous ? previous.endIndex - previous.startIndex : 0
    if (previous?.kind === kind && previous.endIndex === segment.startIndex) {
      previous.confidence =
        (previous.confidence * previousBars + confidence * segment.bars) /
        Math.max(1, previousBars + segment.bars)
      previous.endIndex = segment.endIndex
      continue
    }
    ranges.push({
      startIndex: segment.startIndex,
      endIndex: segment.endIndex,
      kind,
      confidence,
      clusterId: segment.clusterId,
      entryBoundaryScore: segment.boundaryScore
    })
  }
  return ranges
}

const findBoundaryScore = (boundaries: readonly SongStructureSpectralBoundary[], index: number) =>
  boundaries.find((boundary) => boundary.index === index)?.score ?? 0

const buildSection = (
  bars: readonly SongStructureSpectralBarFeature[],
  boundaries: readonly SongStructureSpectralBoundary[],
  range: SemanticRange
): SongStructureSection | null => {
  const first = bars[range.startIndex]
  const last = bars[range.endIndex - 1]
  if (!first || !last || range.endIndex <= range.startIndex) return null
  const values = averageValues(bars, range.startIndex, range.endIndex, 'values')
  const novelty = Math.max(
    findBoundaryScore(boundaries, range.startIndex),
    findBoundaryScore(boundaries, range.endIndex),
    range.entryBoundaryScore
  )
  return {
    startSec: toFixedNumber(first.startSec, 3),
    endSec: toFixedNumber(last.endSec, 3),
    startBar: first.startBar,
    endBar: last.startBar,
    phraseIndex: first.phraseIndex,
    kind: range.kind,
    confidence: toFixedNumber(clamp01(range.confidence), 3),
    energy: toFixedNumber(values.energy, 3),
    low: toFixedNumber(values.low, 3),
    high: toFixedNumber(values.high, 3),
    novelty: toFixedNumber(novelty, 3)
  }
}

export const labelSongStructureSpectralSegments = (
  bars: readonly SongStructureSpectralBarFeature[],
  clustering: SongStructureSpectralClusteringResult
) => {
  const segments = buildSemanticSegments(bars, clustering)
  if (!segments.length) return null
  const decoded = decodeSemanticKinds(segments)
  const guarded = applySemanticGuards(segments, decoded)
  const activeReentryIndexes = segments.flatMap((segment, index) => {
    const previous = segments[index - 1]
    return previous && isDecisiveActiveReentry(previous, segment) ? [segment.startIndex] : []
  })
  const inactiveValleyRefinedRanges = inactiveValley.refineInactiveDropValleyRanges(
    bars,
    mergeSemanticRanges(segments, guarded),
    clustering.boundaries
  )
  const buildRefinedRanges = refineContextualBuildRanges(
    bars,
    inactiveValleyRefinedRanges,
    activeReentryIndexes
  )
  const foundationLandingRefinedRanges = refineFoundationLandingBuildRanges(
    bars,
    buildRefinedRanges,
    clustering.boundaries,
    inactiveValleyRefinedRanges
  )
  const reentryRefinedRanges = refinePostBreakdownStructuralReentries(
    bars,
    foundationLandingRefinedRanges,
    clustering.boundaries
  )
  const terminalRefinedRanges = refineTerminalOutroRanges(
    bars,
    reentryRefinedRanges,
    activeReentryIndexes,
    clustering.boundaries
  )
  const initialRefinedRanges = inactiveValley.refineInitialGrooveDropRanges(
    bars,
    terminalRefinedRanges,
    clustering.boundaries
  )
  const stabilizedRanges = stabilizeSongStructureSemanticRanges(
    refineTerminalOutroRanges(
      bars,
      initialRefinedRanges,
      activeReentryIndexes,
      clustering.boundaries
    )
  )
  const ranges = refineSongStructureSemanticBoundaryAlignment(bars, stabilizedRanges)
  const sections = ranges
    .map((range) => buildSection(bars, clustering.boundaries, range))
    .filter((section): section is SongStructureSection => section !== null)
    .slice(0, MAX_SECTIONS)
  if (!sections.length) return null
  const confidence =
    sections.reduce((total, section) => total + section.confidence, 0) / sections.length
  return {
    sections,
    confidence: clamp01(confidence)
  }
}
