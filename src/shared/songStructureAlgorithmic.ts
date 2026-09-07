import type { UnifiedDisplayWaveformDetailData } from './unifiedDisplayWaveform'
import {
  BEATS_PER_BAR,
  PHRASE_BARS,
  PHRASE_BEATS,
  clamp,
  clamp01,
  normalizeBeatOffset,
  percentile,
  ramp,
  readByteRatio,
  resolveBassPresence,
  toFixedNumber,
  type SongStructureSection,
  type SongStructureSectionKind
} from './songStructureCommon'

type AlgorithmicBarFeature = {
  index: number
  startSec: number
  endSec: number
  startBar: number
  phraseIndex: number
  energy: number
  attack: number
  low: number
  high: number
  bass: number
  density: number
  tension: number
  novelty: number
  footeNovelty: number
  recurrence: number
  recurrenceNovelty: number
}

type AlgorithmicStats = {
  medianEnergy: number
  p75Energy: number
  medianBass: number
  p75Bass: number
  medianDensity: number
  p75Density: number
  medianTension: number
  p75Tension: number
  medianRecurrence: number
  p75Recurrence: number
}

type AlgorithmicValues = Pick<
  AlgorithmicBarFeature,
  | 'energy'
  | 'attack'
  | 'low'
  | 'high'
  | 'bass'
  | 'density'
  | 'tension'
  | 'novelty'
  | 'footeNovelty'
  | 'recurrence'
  | 'recurrenceNovelty'
>

type AlgorithmicPrefixSums = Record<keyof AlgorithmicValues, number[]>

type AlgorithmicCoreValues = Pick<
  AlgorithmicBarFeature,
  'energy' | 'attack' | 'low' | 'high' | 'bass' | 'density' | 'tension'
>

type AlgorithmicState = {
  kind: SongStructureSectionKind
  minBars: number
  maxBars: number
}

type AlgorithmicCandidate = {
  sections: SongStructureSection[]
  score: number
  phaseBeatOffset: number
}

type AlgorithmicRange = {
  kind: SongStructureSectionKind
  startIndex: number
  endIndex: number
  score: number
}

type AlgorithmicPhaseProbe = {
  phaseBeatOffset: number
  features: AlgorithmicBarFeature[]
  boundaryScores: number[]
}

const ALGORITHMIC_MIN_SCORE = 0.52
const ALGORITHMIC_STRONG_SCORE = 0.6
const ALGORITHMIC_MAX_BARS = 1400
const BAR_SCORE_WINDOW = 4
const FOOTE_RADIUS_BARS = [4, 8, 16] as const
const RECURRENCE_MIN_GAP_BARS = PHRASE_BARS
const RECURRENCE_TOP_MATCHES = 3

const ALGORITHMIC_FEATURE_KEYS: Array<keyof AlgorithmicValues> = [
  'energy',
  'attack',
  'low',
  'high',
  'bass',
  'density',
  'tension',
  'novelty',
  'footeNovelty',
  'recurrence',
  'recurrenceNovelty'
]

const STANDARD_SEQUENCE: readonly AlgorithmicState[] = [
  { kind: 'intro', minBars: 8, maxBars: 64 },
  { kind: 'build', minBars: 4, maxBars: 24 },
  { kind: 'drop', minBars: 16, maxBars: 56 },
  { kind: 'breakdown', minBars: 4, maxBars: 32 },
  { kind: 'build', minBars: 4, maxBars: 32 },
  { kind: 'drop', minBars: 16, maxBars: 64 },
  { kind: 'outro', minBars: 4, maxBars: 56 }
]

const INTRO_BREAK_SEQUENCE: readonly AlgorithmicState[] = [
  { kind: 'intro', minBars: 8, maxBars: 48 },
  { kind: 'breakdown', minBars: 8, maxBars: 32 },
  { kind: 'build', minBars: 4, maxBars: 24 },
  { kind: 'drop', minBars: 16, maxBars: 56 },
  { kind: 'breakdown', minBars: 4, maxBars: 32 },
  { kind: 'build', minBars: 4, maxBars: 32 },
  { kind: 'drop', minBars: 16, maxBars: 64 },
  { kind: 'outro', minBars: 4, maxBars: 56 }
]

const SINGLE_DROP_SEQUENCE: readonly AlgorithmicState[] = [
  { kind: 'intro', minBars: 8, maxBars: 72 },
  { kind: 'build', minBars: 4, maxBars: 32 },
  { kind: 'drop', minBars: 16, maxBars: 80 },
  { kind: 'outro', minBars: 4, maxBars: 64 }
]

const GROOVE_TWO_DROP_SEQUENCE: readonly AlgorithmicState[] = [
  { kind: 'intro', minBars: 8, maxBars: 48 },
  { kind: 'groove', minBars: 8, maxBars: 48 },
  { kind: 'breakdown', minBars: 4, maxBars: 32 },
  { kind: 'build', minBars: 4, maxBars: 24 },
  { kind: 'drop', minBars: 16, maxBars: 56 },
  { kind: 'breakdown', minBars: 4, maxBars: 32 },
  { kind: 'build', minBars: 4, maxBars: 32 },
  { kind: 'drop', minBars: 16, maxBars: 64 },
  { kind: 'outro', minBars: 4, maxBars: 56 }
]

const ALGORITHMIC_SEQUENCES = [
  STANDARD_SEQUENCE,
  INTRO_BREAK_SEQUENCE,
  SINGLE_DROP_SEQUENCE,
  GROOVE_TWO_DROP_SEQUENCE
] as const

const summarizeRange = (values: Uint8Array | undefined, startFrame: number, endFrame: number) => {
  if (!values?.length || endFrame <= startFrame) return 0
  const start = clamp(Math.floor(startFrame), 0, values.length - 1)
  const end = clamp(Math.ceil(endFrame), start + 1, values.length)
  let sum = 0
  let peak = 0
  for (let index = start; index < end; index += 1) {
    const value = readByteRatio(values, index)
    sum += value
    peak = Math.max(peak, value)
  }
  const mean = sum / Math.max(1, end - start)
  return clamp01(mean * 0.74 + peak * 0.26)
}

const summarizeBassRange = (
  heightValues: Uint8Array | undefined,
  lowValues: Uint8Array | undefined,
  startFrame: number,
  endFrame: number
) => {
  if (!heightValues?.length || !lowValues?.length || endFrame <= startFrame) return 0
  const length = Math.min(heightValues.length, lowValues.length)
  const start = clamp(Math.floor(startFrame), 0, length - 1)
  const end = clamp(Math.ceil(endFrame), start + 1, length)
  let sum = 0
  let peak = 0
  for (let index = start; index < end; index += 1) {
    const value = resolveBassPresence({
      energy: readByteRatio(heightValues, index),
      low: readByteRatio(lowValues, index)
    })
    sum += value
    peak = Math.max(peak, value)
  }
  const mean = sum / Math.max(1, end - start)
  return clamp01(mean * 0.84 + peak * 0.16)
}

const resolveCoreFeatureDistance = (left: AlgorithmicCoreValues, right: AlgorithmicCoreValues) =>
  clamp01(
    Math.abs(left.energy - right.energy) * 0.22 +
      Math.abs(left.bass - right.bass) * 0.34 +
      Math.abs(left.attack - right.attack) * 0.14 +
      Math.abs(left.high - right.high) * 0.08 +
      Math.abs(left.density - right.density) * 0.16 +
      Math.abs(left.tension - right.tension) * 0.06
  )

const resolveFeatureDistance = (left: AlgorithmicValues, right: AlgorithmicValues) =>
  resolveCoreFeatureDistance(left, right)

const createEmptyValues = (): AlgorithmicValues => ({
  energy: 0,
  attack: 0,
  low: 0,
  high: 0,
  bass: 0,
  density: 0,
  tension: 0,
  novelty: 0,
  footeNovelty: 0,
  recurrence: 0,
  recurrenceNovelty: 0
})

const resolveFeatureSimilarity = (left: AlgorithmicCoreValues, right: AlgorithmicCoreValues) =>
  1 - resolveCoreFeatureDistance(left, right)

const buildAlgorithmicBarFeatures = (
  data: UnifiedDisplayWaveformDetailData,
  durationSec: number,
  bpm: number,
  firstBeatMs: number,
  phaseBeatOffset: number
) => {
  const detailRate = Math.max(1, Number(data.detailRate) || 1)
  const beatSec = 60 / bpm
  const barSec = beatSec * BEATS_PER_BAR
  if (!Number.isFinite(barSec) || barSec <= 0) return []

  const firstBeatSec = firstBeatMs / 1000
  const normalizedPhase = normalizeBeatOffset(phaseBeatOffset) ?? 0
  const barBeatPhase = normalizedPhase % BEATS_PER_BAR
  const phraseBarShift = Math.floor(normalizedPhase / BEATS_PER_BAR)
  const firstCandidateBarStartSec = firstBeatSec + barBeatPhase * beatSec
  const firstGridIndex = Math.floor((0 - firstCandidateBarStartSec) / barSec) - 1
  const lastGridIndex = Math.ceil((durationSec - firstCandidateBarStartSec) / barSec) + 1
  const features: AlgorithmicBarFeature[] = []

  for (let gridIndex = firstGridIndex; gridIndex < lastGridIndex; gridIndex += 1) {
    const rawStartSec = firstCandidateBarStartSec + gridIndex * barSec
    const rawEndSec = rawStartSec + barSec
    const startSec = Math.max(0, rawStartSec)
    const endSec = Math.min(durationSec, rawEndSec)
    if (endSec - startSec < Math.min(0.5, barSec * 0.25)) continue

    const startFrame = Math.floor(startSec * detailRate)
    const endFrame = Math.ceil(endSec * detailRate)
    const energy = summarizeRange(data.height, startFrame, endFrame)
    const attack = summarizeRange(data.attack, startFrame, endFrame)
    const low = summarizeRange(data.colorLow, startFrame, endFrame)
    const high = summarizeRange(data.colorHigh, startFrame, endFrame)
    const bass = summarizeBassRange(data.height, data.colorLow, startFrame, endFrame)
    const startBar = Math.max(1, gridIndex - phraseBarShift + 1)
    features.push({
      index: features.length,
      startSec,
      endSec,
      startBar,
      phraseIndex: Math.max(0, Math.floor((startBar - 1) / PHRASE_BARS)),
      energy,
      attack,
      low,
      high,
      bass,
      density: clamp01(energy * 0.33 + bass * 0.31 + attack * 0.22 + high * 0.14),
      tension: clamp01(high * 0.42 + attack * 0.3 + energy * 0.16 + (1 - bass) * 0.12),
      novelty: 0,
      footeNovelty: 0,
      recurrence: 0,
      recurrenceNovelty: 0
    })
  }

  for (let index = 1; index < features.length; index += 1) {
    const current = features[index]
    const previous = features[index - 1]
    if (!current || !previous) continue
    current.novelty = resolveFeatureDistance(current, previous)
  }

  if (features.length > ALGORITHMIC_MAX_BARS) return features

  return enrichStructuralFeatures(features)
}

const resolveFooteCheckerboardScore = (
  features: readonly AlgorithmicBarFeature[],
  boundaryIndex: number,
  radius: number
) => {
  if (boundaryIndex <= 0 || boundaryIndex >= features.length) return 0
  const leftStart = Math.max(0, boundaryIndex - radius)
  const rightEnd = Math.min(features.length, boundaryIndex + radius)
  const leftCount = boundaryIndex - leftStart
  const rightCount = rightEnd - boundaryIndex
  if (leftCount < 2 || rightCount < 2) return 0

  let withinSum = 0
  let withinCount = 0
  let crossSum = 0
  let crossCount = 0

  for (let leftIndex = leftStart; leftIndex < boundaryIndex; leftIndex += 1) {
    const left = features[leftIndex]
    if (!left) continue
    for (let cursor = leftIndex + 1; cursor < boundaryIndex; cursor += 1) {
      const other = features[cursor]
      if (!other) continue
      withinSum += resolveFeatureSimilarity(left, other)
      withinCount += 1
    }
    for (let rightIndex = boundaryIndex; rightIndex < rightEnd; rightIndex += 1) {
      const right = features[rightIndex]
      if (!right) continue
      crossSum += resolveFeatureSimilarity(left, right)
      crossCount += 1
    }
  }

  for (let rightIndex = boundaryIndex; rightIndex < rightEnd; rightIndex += 1) {
    const right = features[rightIndex]
    if (!right) continue
    for (let cursor = rightIndex + 1; cursor < rightEnd; cursor += 1) {
      const other = features[cursor]
      if (!other) continue
      withinSum += resolveFeatureSimilarity(right, other)
      withinCount += 1
    }
  }

  const within = withinSum / Math.max(1, withinCount)
  const cross = crossSum / Math.max(1, crossCount)
  return ramp(within - cross, 0.015, 0.24)
}

const resolveMultiScaleFooteNovelty = (
  features: readonly AlgorithmicBarFeature[],
  boundaryIndex: number
) => {
  let weighted = 0
  let weightSum = 0
  for (const radius of FOOTE_RADIUS_BARS) {
    const edgePenalty =
      boundaryIndex < radius || features.length - boundaryIndex < radius ? 0.72 : 1
    const radiusWeight = radius === 4 ? 0.44 : radius === 8 ? 0.38 : 0.18
    weighted +=
      resolveFooteCheckerboardScore(features, boundaryIndex, radius) * radiusWeight * edgePenalty
    weightSum += radiusWeight * edgePenalty
  }
  return clamp01(weighted / Math.max(0.001, weightSum))
}

const insertTopScore = (scores: number[], value: number) => {
  if (value <= 0) return
  scores.push(value)
  scores.sort((left, right) => right - left)
  if (scores.length > RECURRENCE_TOP_MATCHES) scores.pop()
}

const buildRecurrenceScores = (features: readonly AlgorithmicBarFeature[]) => {
  const scores = features.map(() => 0)
  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index]
    if (!feature) continue
    const topMatches: number[] = []
    for (let cursor = 0; cursor < features.length; cursor += 1) {
      if (Math.abs(cursor - index) < RECURRENCE_MIN_GAP_BARS) continue
      const other = features[cursor]
      if (!other) continue
      const phraseAligned = Math.abs(feature.startBar - other.startBar) % PHRASE_BARS === 0
      const similarity = resolveFeatureSimilarity(feature, other) * (phraseAligned ? 1 : 0.82)
      insertTopScore(topMatches, similarity)
    }
    const best = topMatches[0] ?? 0
    const meanTop =
      topMatches.reduce((total, score) => total + score, 0) / Math.max(1, topMatches.length)
    scores[index] = clamp01(best * 0.72 + meanTop * 0.28)
  }
  return scores
}

const averageFeatureField = (
  features: readonly AlgorithmicBarFeature[],
  field: keyof AlgorithmicBarFeature,
  startIndex: number,
  endIndex: number
) => {
  const start = clamp(Math.floor(startIndex), 0, features.length)
  const end = clamp(Math.ceil(endIndex), start + 1, features.length)
  let sum = 0
  for (let index = start; index < end; index += 1) {
    const value = Number(features[index]?.[field])
    if (Number.isFinite(value)) sum += value
  }
  return sum / Math.max(1, end - start)
}

const enrichStructuralFeatures = (
  features: readonly AlgorithmicBarFeature[]
): AlgorithmicBarFeature[] => {
  if (!features.length) return []
  const enriched = features.map((feature) => ({ ...feature }))
  for (let index = 1; index < enriched.length; index += 1) {
    const feature = enriched[index]
    if (!feature) continue
    feature.footeNovelty = resolveMultiScaleFooteNovelty(enriched, index)
  }

  const recurrenceScores = buildRecurrenceScores(enriched)
  for (let index = 0; index < enriched.length; index += 1) {
    const feature = enriched[index]
    if (!feature) continue
    feature.recurrence = recurrenceScores[index] ?? 0
  }

  for (let index = 1; index < enriched.length; index += 1) {
    const feature = enriched[index]
    if (!feature) continue
    const leftRecurrence = averageFeatureField(
      enriched,
      'recurrence',
      index - BAR_SCORE_WINDOW,
      index
    )
    const rightRecurrence = averageFeatureField(
      enriched,
      'recurrence',
      index,
      index + BAR_SCORE_WINDOW
    )
    feature.recurrenceNovelty = clamp01(Math.abs(rightRecurrence - leftRecurrence) * 1.45)
    feature.novelty = clamp01(
      feature.novelty * 0.34 +
        feature.footeNovelty * 0.42 +
        feature.recurrenceNovelty * 0.18 +
        ramp(Math.max(rightRecurrence, leftRecurrence), 0.34, 0.72) * 0.06
    )
  }

  return enriched
}

const applyPhraseBarShift = (
  features: readonly AlgorithmicBarFeature[],
  phraseBarShift: number
): AlgorithmicBarFeature[] => {
  if (phraseBarShift <= 0) return [...features]
  return features.map((feature) => {
    const startBar = Math.max(1, feature.startBar - phraseBarShift)
    return {
      ...feature,
      startBar,
      phraseIndex: Math.max(0, Math.floor((startBar - 1) / PHRASE_BARS))
    }
  })
}

const buildStats = (features: readonly AlgorithmicBarFeature[]): AlgorithmicStats => ({
  medianEnergy: percentile(
    features.map((feature) => feature.energy),
    0.5
  ),
  p75Energy: percentile(
    features.map((feature) => feature.energy),
    0.75
  ),
  medianBass: percentile(
    features.map((feature) => feature.bass),
    0.5
  ),
  p75Bass: percentile(
    features.map((feature) => feature.bass),
    0.75
  ),
  medianDensity: percentile(
    features.map((feature) => feature.density),
    0.5
  ),
  p75Density: percentile(
    features.map((feature) => feature.density),
    0.75
  ),
  medianTension: percentile(
    features.map((feature) => feature.tension),
    0.5
  ),
  p75Tension: percentile(
    features.map((feature) => feature.tension),
    0.75
  ),
  medianRecurrence: percentile(
    features.map((feature) => feature.recurrence),
    0.5
  ),
  p75Recurrence: percentile(
    features.map((feature) => feature.recurrence),
    0.75
  )
})

const buildPrefixSums = (features: readonly AlgorithmicBarFeature[]): AlgorithmicPrefixSums => {
  const sums = Object.fromEntries(
    ALGORITHMIC_FEATURE_KEYS.map((key) => [key, [0]])
  ) as AlgorithmicPrefixSums
  for (const feature of features) {
    for (const key of ALGORITHMIC_FEATURE_KEYS) {
      sums[key].push((sums[key][sums[key].length - 1] ?? 0) + feature[key])
    }
  }
  return sums
}

const averageRange = (
  prefix: AlgorithmicPrefixSums,
  startIndex: number,
  endIndex: number
): AlgorithmicValues => {
  const count = Math.max(1, endIndex - startIndex)
  const values = {} as AlgorithmicValues
  for (const key of ALGORITHMIC_FEATURE_KEYS) {
    values[key] = ((prefix[key][endIndex] ?? 0) - (prefix[key][startIndex] ?? 0)) / count
  }
  return values
}

const durationPrior = (bars: number, preferred: number, tolerance: number) =>
  1 - ramp(Math.abs(bars - preferred), tolerance * 0.35, tolerance)

const boundaryContrastScore = (features: readonly AlgorithmicBarFeature[], index: number) => {
  if (index <= 0 || index >= features.length) return 0
  const leftStart = Math.max(0, index - BAR_SCORE_WINDOW)
  const rightEnd = Math.min(features.length, index + BAR_SCORE_WINDOW)
  const leftCount = Math.max(1, index - leftStart)
  const rightCount = Math.max(1, rightEnd - index)
  const left = createEmptyValues()
  const right: AlgorithmicValues = { ...left }
  for (let cursor = leftStart; cursor < index; cursor += 1) {
    const feature = features[cursor]
    if (!feature) continue
    for (const key of ALGORITHMIC_FEATURE_KEYS) left[key] += feature[key] / leftCount
  }
  for (let cursor = index; cursor < rightEnd; cursor += 1) {
    const feature = features[cursor]
    if (!feature) continue
    for (const key of ALGORITHMIC_FEATURE_KEYS) right[key] += feature[key] / rightCount
  }
  return resolveFeatureDistance(left, right)
}

const boundaryScore = (features: readonly AlgorithmicBarFeature[], index: number) => {
  if (index <= 0 || index >= features.length) return 0
  const feature = features[index]
  const startBar = feature?.startBar ?? index + 1
  const novelty = ramp(feature?.novelty ?? 0, 0.04, 0.34)
  const footeNovelty = ramp(feature?.footeNovelty ?? 0, 0.05, 0.48)
  const recurrenceNovelty = ramp(feature?.recurrenceNovelty ?? 0, 0.035, 0.28)
  const contrast = ramp(boundaryContrastScore(features, index), 0.035, 0.18)
  const eightBar = startBar % PHRASE_BARS === 1 ? 1 : 0
  const fourBar = startBar % BEATS_PER_BAR === 1 ? 1 : 0
  return (
    contrast * 0.1 +
    footeNovelty * 0.145 +
    recurrenceNovelty * 0.06 +
    novelty * 0.065 +
    eightBar * 0.13 +
    fourBar * 0.035
  )
}

const buildBoundaryScores = (features: readonly AlgorithmicBarFeature[]) =>
  features.map((_feature, index) => boundaryScore(features, index))

const scoreSegment = (
  kind: SongStructureSectionKind,
  values: AlgorithmicValues,
  startIndex: number,
  endIndex: number,
  totalBars: number,
  stats: AlgorithmicStats
) => {
  const bars = endIndex - startIndex
  const progress = startIndex / Math.max(1, totalBars)
  const activeBass = ramp(values.bass, stats.medianBass * 0.9, Math.max(stats.p75Bass, 0.16))
  const activeEnergy = ramp(
    values.energy,
    stats.medianEnergy * 0.85,
    Math.max(stats.p75Energy, 0.16)
  )
  const activeDensity = ramp(
    values.density,
    stats.medianDensity * 0.84,
    Math.max(stats.p75Density, 0.16)
  )
  const repeatedStructure = ramp(
    values.recurrence,
    stats.medianRecurrence * 0.86,
    Math.max(stats.p75Recurrence, 0.22)
  )
  const tension = ramp(values.tension, stats.medianTension * 0.86, Math.max(stats.p75Tension, 0.14))
  const reducedBass = 1 - ramp(values.bass, stats.medianBass * 0.8, Math.max(stats.p75Bass, 0.16))
  const reducedDensity =
    1 - ramp(values.density, stats.medianDensity * 0.82, Math.max(stats.p75Density, 0.16))

  if (kind === 'drop') {
    return clamp01(
      activeBass * 0.32 +
        activeEnergy * 0.2 +
        activeDensity * 0.23 +
        repeatedStructure * 0.1 +
        durationPrior(bars, 32, 24) * 0.15
    )
  }
  if (kind === 'build') {
    return clamp01(
      tension * 0.32 +
        ramp(values.attack, stats.medianTension * 0.6, Math.max(stats.p75Tension, 0.12)) * 0.17 +
        reducedBass * 0.17 +
        durationPrior(bars, 8, 16) * 0.21 +
        ramp(values.novelty, 0.025, 0.18) * 0.08 +
        ramp(values.footeNovelty, 0.04, 0.32) * 0.05
    )
  }
  if (kind === 'breakdown') {
    return clamp01(
      reducedBass * 0.3 +
        reducedDensity * 0.3 +
        tension * 0.16 +
        durationPrior(bars, 8, 18) * 0.18 +
        ramp(values.novelty, 0.025, 0.18) * 0.06
    )
  }
  if (kind === 'groove') {
    return clamp01(
      activeBass * 0.22 +
        activeEnergy * 0.18 +
        activeDensity * 0.21 +
        repeatedStructure * 0.1 +
        (1 - tension) * 0.11 +
        durationPrior(bars, 16, 24) * 0.18
    )
  }
  if (kind === 'outro') {
    return clamp01(
      ramp(progress, 0.66, 0.88) * 0.26 +
        reducedDensity * 0.24 +
        reducedBass * 0.18 +
        (1 - tension) * 0.12 +
        durationPrior(bars, 16, 30) * 0.2
    )
  }
  return clamp01(
    (1 - ramp(progress, 0.36, 0.58)) * 0.18 +
      (1 - activeBass) * 0.12 +
      (1 - activeDensity) * 0.1 +
      durationPrior(bars, 32, 38) * 0.6
  )
}

const createSection = (
  features: readonly AlgorithmicBarFeature[],
  range: AlgorithmicRange,
  candidateScore: number
): SongStructureSection | null => {
  const first = features[range.startIndex]
  const last = features[range.endIndex - 1]
  if (!first || !last || range.endIndex <= range.startIndex) return null
  let energy = 0
  let low = 0
  let high = 0
  let novelty = 0
  for (let index = range.startIndex; index < range.endIndex; index += 1) {
    const feature = features[index]
    if (!feature) continue
    energy += feature.energy
    low += feature.low
    high += feature.high
    novelty = Math.max(novelty, feature.novelty)
  }
  const count = Math.max(1, range.endIndex - range.startIndex)
  return {
    startSec: toFixedNumber(first.startSec, 3),
    endSec: toFixedNumber(last.endSec, 3),
    startBar: first.startBar,
    endBar: last.startBar,
    phraseIndex: first.phraseIndex,
    kind: range.kind,
    confidence: toFixedNumber(clamp01(candidateScore * 0.72 + range.score * 0.28), 3),
    energy: toFixedNumber(energy / count, 3),
    low: toFixedNumber(low / count, 3),
    high: toFixedNumber(high / count, 3),
    novelty: toFixedNumber(novelty, 3)
  }
}

const runSequence = (
  features: readonly AlgorithmicBarFeature[],
  prefix: AlgorithmicPrefixSums,
  boundaryScores: readonly number[],
  stats: AlgorithmicStats,
  sequence: readonly AlgorithmicState[]
) => {
  const totalBars = features.length
  const scores: number[][] = sequence.map(() => new Array(totalBars + 1).fill(-Infinity))
  const previousIndexes: number[][] = sequence.map(() => new Array(totalBars + 1).fill(-1))
  const segmentScores: number[][] = sequence.map(() => new Array(totalBars + 1).fill(0))

  sequence.forEach((state, stateIndex) => {
    const minEnd = stateIndex === sequence.length - 1 ? totalBars : 1
    const maxEnd = stateIndex === sequence.length - 1 ? totalBars : totalBars - 1
    for (let endIndex = minEnd; endIndex <= maxEnd; endIndex += 1) {
      const minStart = Math.max(0, endIndex - state.maxBars)
      const maxStart = Math.max(0, endIndex - state.minBars)
      for (let startIndex = minStart; startIndex <= maxStart; startIndex += 1) {
        const previousScore =
          stateIndex === 0
            ? startIndex === 0
              ? 0
              : -Infinity
            : (scores[stateIndex - 1]?.[startIndex] ?? -Infinity)
        if (!Number.isFinite(previousScore)) continue
        const values = averageRange(prefix, startIndex, endIndex)
        const segmentScore = scoreSegment(
          state.kind,
          values,
          startIndex,
          endIndex,
          totalBars,
          stats
        )
        const nextScore = previousScore + segmentScore + (boundaryScores[startIndex] ?? 0)
        if (nextScore > (scores[stateIndex]?.[endIndex] ?? -Infinity)) {
          scores[stateIndex]![endIndex] = nextScore
          previousIndexes[stateIndex]![endIndex] = startIndex
          segmentScores[stateIndex]![endIndex] = segmentScore
        }
      }
    }
  })

  let cursor = totalBars
  const ranges: AlgorithmicRange[] = []
  for (let stateIndex = sequence.length - 1; stateIndex >= 0; stateIndex -= 1) {
    const startIndex = previousIndexes[stateIndex]?.[cursor] ?? -1
    const state = sequence[stateIndex]
    if (!state || startIndex < 0) return null
    ranges.unshift({
      kind: state.kind,
      startIndex,
      endIndex: cursor,
      score: segmentScores[stateIndex]?.[cursor] ?? 0
    })
    cursor = startIndex
  }
  if (cursor !== 0) return null

  const totalScore = scores[sequence.length - 1]?.[totalBars] ?? -Infinity
  if (!Number.isFinite(totalScore)) return null
  const averageScore = totalScore / sequence.length
  const sections = ranges
    .map((range) => createSection(features, range, averageScore))
    .filter((section): section is SongStructureSection => section !== null)
  return sections.length === sequence.length ? { sections, score: averageScore } : null
}

const resolveBaselineConfidence = (sections: readonly SongStructureSection[] | undefined) => {
  if (!sections?.length) return 0
  const sum = sections.reduce((total, section) => total + clamp01(section.confidence), 0)
  return sum / sections.length
}

export const buildAlgorithmicSongStructureSections = (
  data: UnifiedDisplayWaveformDetailData,
  durationSec: number,
  bpm: number,
  firstBeatMs: number,
  barBeatOffset: number,
  baselineSections?: readonly SongStructureSection[]
): AlgorithmicCandidate | null => {
  const beatSec = 60 / bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0 || durationSec <= beatSec * PHRASE_BEATS) {
    return null
  }

  const baselineConfidence = resolveBaselineConfidence(baselineSections)
  const preferredPhase = normalizeBeatOffset(barBeatOffset) ?? 0
  const phaseProbes: AlgorithmicPhaseProbe[] = []
  const barPhaseFeatureCache = new Map<number, AlgorithmicBarFeature[]>()
  let best: AlgorithmicCandidate | null = null

  for (const phaseBeatOffset of [preferredPhase]) {
    const barBeatPhase = phaseBeatOffset % BEATS_PER_BAR
    let baseFeatures = barPhaseFeatureCache.get(barBeatPhase)
    if (!baseFeatures) {
      baseFeatures = buildAlgorithmicBarFeatures(data, durationSec, bpm, firstBeatMs, barBeatPhase)
      barPhaseFeatureCache.set(barBeatPhase, baseFeatures)
    }
    const features = applyPhraseBarShift(baseFeatures, Math.floor(phaseBeatOffset / BEATS_PER_BAR))
    if (features.length < 24 || features.length > ALGORITHMIC_MAX_BARS) continue
    const boundaryScores = buildBoundaryScores(features)
    phaseProbes.push({
      phaseBeatOffset,
      features,
      boundaryScores
    })
  }

  for (const probe of phaseProbes) {
    const stats = buildStats(probe.features)
    const prefix = buildPrefixSums(probe.features)
    for (const sequence of ALGORITHMIC_SEQUENCES) {
      const candidate = runSequence(probe.features, prefix, probe.boundaryScores, stats, sequence)
      if (!candidate) continue
      const score = candidate.score
      if (!best || score > best.score) {
        best = {
          sections: candidate.sections,
          score,
          phaseBeatOffset: probe.phaseBeatOffset
        }
      }
    }
  }

  if (!best || best.score < ALGORITHMIC_MIN_SCORE) return null
  if (baselineConfidence >= ALGORITHMIC_STRONG_SCORE && best.score < baselineConfidence + 0.035) {
    return null
  }
  return {
    ...best,
    score: toFixedNumber(best.score, 6)
  }
}
