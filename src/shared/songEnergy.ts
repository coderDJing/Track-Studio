export const CURRENT_SONG_ENERGY_ALGORITHM_VERSION = 11

export const SONG_ENERGY_AROUSAL_MIN = 1
export const SONG_ENERGY_AROUSAL_MAX = 9

export type SongEnergyScorePayload = {
  energyScore: number
  energyAlgorithmVersion: number
}

export type SongEnergyAnalysisV5 = {
  version: 5 | 6 | 7 | 8 | 9 | 10 | 11
  model:
    | 'musicnn-deam-emomusic'
    | 'musicnn-deam-emomusic-acoustic-v6'
    | 'musicnn-deam-emomusic-beatphrase-v7'
    | 'musicnn-deam-emomusic-segment-v8'
    | 'musicnn-deam-emomusic-structure-v9'
    | 'musicnn-deam-emomusic-structure-v10'
    | 'musicnn-deam-emomusic-structure-v11'
  sustainedScore: number
  averageScore: number
  medianScore: number
  peakScore: number
  rangeScore: number
  confidence: number
  patchCount: number
  danceabilityScore?: number
  dancefloorScore?: number
  dropScore?: number
  breakdownScore?: number
  rhythmicScore?: number
  mainSectionScore?: number
  highEnergyCoverageScore?: number
  dropCount?: number
  breakdownCount?: number
  drivingScore?: number
  energyCurve?: SongEnergyCurvePoint[]
}

export type SongEnergyCurveRole =
  | 'intro'
  | 'build'
  | 'drop'
  | 'high'
  | 'breakdown'
  | 'steady'
  | 'outro'

export type SongEnergyCurvePoint = {
  timeMs: number
  score: number
  role: SongEnergyCurveRole
}

export const SONG_ENERGY_ANALYSIS_SCORE_KEYS = [
  'dancefloorScore',
  'danceabilityScore',
  'rhythmicScore',
  'drivingScore',
  'mainSectionScore',
  'highEnergyCoverageScore',
  'dropScore',
  'breakdownScore',
  'peakScore',
  'rangeScore',
  'confidence'
] as const

export type SongEnergyAnalysisScoreKey = (typeof SONG_ENERGY_ANALYSIS_SCORE_KEYS)[number]

const songEnergyAnalysisScoreKeySet = new Set<string>(SONG_ENERGY_ANALYSIS_SCORE_KEYS)

export const isSongEnergyAnalysisScoreKey = (value: string): value is SongEnergyAnalysisScoreKey =>
  songEnergyAnalysisScoreKeySet.has(value)

export const getSongEnergyAnalysisScore = (
  analysis: SongEnergyAnalysisV5 | null | undefined,
  key: string
): number | undefined => {
  if (!analysis || !isSongEnergyAnalysisScoreKey(key)) return undefined
  const value = analysis[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export const normalizeSongEnergyAnalysis = (value: unknown): SongEnergyAnalysisV5 | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Partial<SongEnergyAnalysisV5>
  const isV5 = candidate.version === 5 && candidate.model === 'musicnn-deam-emomusic'
  const isV6 = candidate.version === 6 && candidate.model === 'musicnn-deam-emomusic-acoustic-v6'
  const isV7 = candidate.version === 7 && candidate.model === 'musicnn-deam-emomusic-beatphrase-v7'
  const isV8 = candidate.version === 8 && candidate.model === 'musicnn-deam-emomusic-segment-v8'
  const isV9 = candidate.version === 9 && candidate.model === 'musicnn-deam-emomusic-structure-v9'
  const isV10 =
    candidate.version === 10 && candidate.model === 'musicnn-deam-emomusic-structure-v10'
  const isV11 =
    candidate.version === 11 && candidate.model === 'musicnn-deam-emomusic-structure-v11'
  if (!isV5 && !isV6 && !isV7 && !isV8 && !isV9 && !isV10 && !isV11) return undefined
  const scores = [
    candidate.sustainedScore,
    candidate.averageScore,
    candidate.medianScore,
    candidate.peakScore,
    candidate.rangeScore,
    candidate.confidence
  ]
  if (
    scores.some(
      (score) => typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100
    ) ||
    typeof candidate.patchCount !== 'number' ||
    !Number.isInteger(candidate.patchCount) ||
    candidate.patchCount <= 0
  ) {
    return undefined
  }
  const optionalScores = [
    candidate.danceabilityScore,
    candidate.dancefloorScore,
    candidate.dropScore,
    candidate.breakdownScore,
    candidate.rhythmicScore,
    candidate.mainSectionScore,
    candidate.highEnergyCoverageScore,
    candidate.drivingScore
  ]
  if (
    optionalScores.some(
      (score) =>
        score !== undefined &&
        (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100)
    )
  ) {
    return undefined
  }
  const optionalCounts = [candidate.dropCount, candidate.breakdownCount]
  if (
    optionalCounts.some(
      (count) =>
        count !== undefined &&
        (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 100)
    )
  ) {
    return undefined
  }
  const allowedCurveRoles = new Set<SongEnergyCurveRole>([
    'intro',
    'build',
    'drop',
    'high',
    'breakdown',
    'steady',
    'outro'
  ])
  const energyCurve = Array.isArray(candidate.energyCurve)
    ? candidate.energyCurve
        .map((point): SongEnergyCurvePoint | null => {
          if (!point || typeof point !== 'object' || Array.isArray(point)) return null
          const curvePoint = point as Partial<SongEnergyCurvePoint>
          if (
            typeof curvePoint.timeMs !== 'number' ||
            !Number.isFinite(curvePoint.timeMs) ||
            curvePoint.timeMs < 0 ||
            typeof curvePoint.score !== 'number' ||
            !Number.isFinite(curvePoint.score) ||
            curvePoint.score < 0 ||
            curvePoint.score > 100 ||
            typeof curvePoint.role !== 'string' ||
            !allowedCurveRoles.has(curvePoint.role as SongEnergyCurveRole)
          ) {
            return null
          }
          return {
            timeMs: Math.round(curvePoint.timeMs),
            score: Math.round(curvePoint.score),
            role: curvePoint.role as SongEnergyCurveRole
          }
        })
        .filter((point): point is SongEnergyCurvePoint => point !== null)
    : undefined
  if (candidate.energyCurve !== undefined && (!energyCurve || energyCurve.length === 0)) {
    return undefined
  }
  return {
    version: isV11 ? 11 : isV10 ? 10 : isV9 ? 9 : isV8 ? 8 : isV7 ? 7 : isV6 ? 6 : 5,
    model: isV11
      ? 'musicnn-deam-emomusic-structure-v11'
      : isV10
        ? 'musicnn-deam-emomusic-structure-v10'
        : isV9
          ? 'musicnn-deam-emomusic-structure-v9'
          : isV8
            ? 'musicnn-deam-emomusic-segment-v8'
            : isV7
              ? 'musicnn-deam-emomusic-beatphrase-v7'
              : isV6
                ? 'musicnn-deam-emomusic-acoustic-v6'
                : 'musicnn-deam-emomusic',
    sustainedScore: Math.round(Number(candidate.sustainedScore)),
    averageScore: Math.round(Number(candidate.averageScore)),
    medianScore: Math.round(Number(candidate.medianScore)),
    peakScore: Math.round(Number(candidate.peakScore)),
    rangeScore: Math.round(Number(candidate.rangeScore)),
    confidence: Math.round(Number(candidate.confidence)),
    patchCount: Number(candidate.patchCount),
    ...(candidate.danceabilityScore === undefined
      ? {}
      : { danceabilityScore: Math.round(candidate.danceabilityScore) }),
    ...(candidate.dancefloorScore === undefined
      ? {}
      : { dancefloorScore: Math.round(candidate.dancefloorScore) }),
    ...(candidate.dropScore === undefined ? {} : { dropScore: Math.round(candidate.dropScore) }),
    ...(candidate.breakdownScore === undefined
      ? {}
      : { breakdownScore: Math.round(candidate.breakdownScore) }),
    ...(candidate.rhythmicScore === undefined
      ? {}
      : { rhythmicScore: Math.round(candidate.rhythmicScore) }),
    ...(candidate.mainSectionScore === undefined
      ? {}
      : { mainSectionScore: Math.round(candidate.mainSectionScore) }),
    ...(candidate.highEnergyCoverageScore === undefined
      ? {}
      : { highEnergyCoverageScore: Math.round(candidate.highEnergyCoverageScore) }),
    ...(candidate.dropCount === undefined ? {} : { dropCount: candidate.dropCount }),
    ...(candidate.breakdownCount === undefined ? {} : { breakdownCount: candidate.breakdownCount }),
    ...(candidate.drivingScore === undefined
      ? {}
      : { drivingScore: Math.round(candidate.drivingScore) }),
    ...(energyCurve === undefined ? {} : { energyCurve })
  }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const normalizeSongEnergyScore = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  return clamp(Math.round(numeric), 0, 100)
}

export const buildSongEnergyScoreFromArousal = (
  arousal: unknown
): SongEnergyScorePayload | null => {
  const numeric = Number(arousal)
  if (!Number.isFinite(numeric)) return null
  const normalized =
    (clamp(numeric, SONG_ENERGY_AROUSAL_MIN, SONG_ENERGY_AROUSAL_MAX) - SONG_ENERGY_AROUSAL_MIN) /
    (SONG_ENERGY_AROUSAL_MAX - SONG_ENERGY_AROUSAL_MIN)
  return {
    energyScore: normalizeSongEnergyScore(normalized * 100) ?? 0,
    energyAlgorithmVersion: CURRENT_SONG_ENERGY_ALGORITHM_VERSION
  }
}

export const hasCurrentSongEnergyAnalysis = (
  info: { energyScore?: unknown; energyAlgorithmVersion?: unknown } | null | undefined
) =>
  normalizeSongEnergyScore(info?.energyScore) !== undefined &&
  Number(info?.energyAlgorithmVersion) === CURRENT_SONG_ENERGY_ALGORITHM_VERSION

export const hasUsableSongEnergyAnalysis = (info: { energyScore?: unknown } | null | undefined) =>
  normalizeSongEnergyScore(info?.energyScore) !== undefined
