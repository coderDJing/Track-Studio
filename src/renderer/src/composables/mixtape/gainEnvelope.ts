import type { MixtapeEnvelopeParamId, MixtapeGainPoint } from '@renderer/composables/mixtape/types'

const MIN_VALID_GAIN = 0.0001
const MAX_GAIN_DEFAULT = 16
const ENVELOPE_SAME_SEC_EPSILON = 0.0001
const ENVELOPE_MAX_POINTS_PER_SEC = 2
type GainPointLike = {
  sec?: unknown
  gain?: unknown
}

export const MIXTAPE_GAIN_KNOB_MIN_DB = -26
export const MIXTAPE_GAIN_KNOB_MAX_DB = 12
const MIXTAPE_VOLUME_ENVELOPE_MAX_GAIN = 1
export const MIXTAPE_STEM_SEGMENT_PARAMS: MixtapeEnvelopeParamId[] = [
  'vocal',
  'inst',
  'bass',
  'drums'
]
export const MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL: MixtapeEnvelopeParamId[] = [
  'gain',
  'high',
  'mid',
  'low',
  'volume'
]
export const MIXTAPE_ENVELOPE_PARAMS_STEM: MixtapeEnvelopeParamId[] = [
  'gain',
  'vocal',
  'inst',
  'bass',
  'drums',
  'volume'
]
export const MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM = {
  gain: 'gainEnvelope',
  high: 'highEnvelope',
  mid: 'midEnvelope',
  low: 'lowEnvelope',
  vocal: 'vocalEnvelope',
  inst: 'instEnvelope',
  bass: 'bassEnvelope',
  drums: 'drumsEnvelope',
  volume: 'volumeEnvelope'
} as const

type EnvelopeParamConfig = {
  minDb: number
  maxDb: number
  minGain: number
  maxGain: number
  defaultGain: number
}

const MIXTAPE_ENVELOPE_PARAM_CONFIG: Record<MixtapeEnvelopeParamId, EnvelopeParamConfig> = {
  gain: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MAX_GAIN_DEFAULT,
    defaultGain: 1
  },
  high: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MAX_GAIN_DEFAULT,
    defaultGain: 1
  },
  mid: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MAX_GAIN_DEFAULT,
    defaultGain: 1
  },
  low: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MAX_GAIN_DEFAULT,
    defaultGain: 1
  },
  vocal: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MAX_GAIN_DEFAULT,
    defaultGain: 1
  },
  inst: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MAX_GAIN_DEFAULT,
    defaultGain: 1
  },
  bass: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MAX_GAIN_DEFAULT,
    defaultGain: 1
  },
  drums: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MAX_GAIN_DEFAULT,
    defaultGain: 1
  },
  volume: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MIXTAPE_VOLUME_ENVELOPE_MAX_GAIN,
    defaultGain: 1
  }
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const resolveEnvelopeConfig = (param: MixtapeEnvelopeParamId): EnvelopeParamConfig =>
  MIXTAPE_ENVELOPE_PARAM_CONFIG[param]

export const linearGainToDb = (gain: number) => 20 * Math.log10(Math.max(MIN_VALID_GAIN, gain))

export const dbToLinearGain = (db: number) => Math.pow(10, db / 20)

export const clampMixEnvelopeGain = (param: MixtapeEnvelopeParamId, gain: number) => {
  const config = resolveEnvelopeConfig(param)
  return clampNumber(Number(gain) || config.defaultGain, config.minGain, config.maxGain)
}

export const buildFlatMixEnvelope = (
  param: MixtapeEnvelopeParamId,
  durationSec: number,
  gain?: number
): MixtapeGainPoint[] => {
  const config = resolveEnvelopeConfig(param)
  const safeDuration = Math.max(0, Number(durationSec) || 0)
  const safeGain = clampNumber(Number(gain) || config.defaultGain, config.minGain, config.maxGain)
  return [
    { sec: 0, gain: safeGain },
    { sec: safeDuration, gain: safeGain }
  ]
}

export const buildFlatGainEnvelope = (durationSec: number, gain: number = 1): MixtapeGainPoint[] =>
  buildFlatMixEnvelope('gain', durationSec, gain)

export const normalizeMixEnvelopePoints = (
  param: MixtapeEnvelopeParamId,
  value: unknown,
  durationSec?: number
): MixtapeGainPoint[] => {
  const config = resolveEnvelopeConfig(param)
  const points = Array.isArray(value)
    ? value
        .map((item) => {
          const point = item && typeof item === 'object' ? (item as GainPointLike) : null
          const sec = Number(point?.sec)
          const gain = Number(point?.gain)
          if (!Number.isFinite(sec) || sec < 0) return null
          if (!Number.isFinite(gain) || gain <= 0) return null
          return {
            sec: Number(sec.toFixed(4)),
            gain: clampNumber(Number(gain.toFixed(6)), config.minGain, config.maxGain)
          }
        })
        .filter(Boolean)
    : []
  if (!points.length) {
    if (typeof durationSec !== 'number') return []
    return buildFlatMixEnvelope(param, durationSec, config.defaultGain)
  }
  const sorted = (points as MixtapeGainPoint[]).sort((a, b) => a.sec - b.sec)
  const safeDuration = Math.max(0, Number(durationSec) || 0)
  if (!sorted.length) return buildFlatMixEnvelope(param, safeDuration, config.defaultGain)
  if (sorted[0].sec > 0.0001) {
    sorted.unshift({ sec: 0, gain: sorted[0].gain })
  } else {
    sorted[0].sec = 0
  }
  if (safeDuration > 0) {
    const last = sorted[sorted.length - 1]
    if (!last || safeDuration - last.sec > 0.0001) {
      sorted.push({ sec: safeDuration, gain: last ? last.gain : config.defaultGain })
    } else {
      last.sec = safeDuration
    }
  }
  // 同一时间点最多保留两个点：第一点表示跳变前，第二点表示跳变后。
  const limited: MixtapeGainPoint[] = []
  let bucketStartIndex = -1
  let bucketSec = Number.NaN
  let bucketCount = 0
  for (const point of sorted) {
    if (!bucketCount || Math.abs(point.sec - bucketSec) > ENVELOPE_SAME_SEC_EPSILON) {
      limited.push(point)
      bucketStartIndex = limited.length - 1
      bucketSec = point.sec
      bucketCount = 1
      continue
    }
    bucketCount += 1
    if (bucketCount <= ENVELOPE_MAX_POINTS_PER_SEC) {
      limited.push(point)
      continue
    }
    const replaceIndex = bucketStartIndex + ENVELOPE_MAX_POINTS_PER_SEC - 1
    limited[replaceIndex] = point
  }
  return limited
}

export const normalizeGainEnvelopePoints = (
  value: unknown,
  durationSec?: number
): MixtapeGainPoint[] => normalizeMixEnvelopePoints('gain', value, durationSec)

const sampleEnvelopeAtSec = (
  points: MixtapeGainPoint[] | undefined,
  sec: number,
  fallbackGain: number
) => {
  if (!Array.isArray(points) || points.length === 0) return fallbackGain
  const safeSec = Math.max(0, Number(sec) || 0)
  if (safeSec <= points[0].sec) return points[0].gain
  const last = points[points.length - 1]
  if (safeSec >= last.sec) return last.gain
  let left = 0
  let right = points.length - 1
  while (left <= right) {
    const middle = (left + right) >> 1
    if (points[middle].sec < safeSec) {
      left = middle + 1
    } else {
      right = middle - 1
    }
  }
  const next = points[left] || last
  const prev = points[Math.max(0, left - 1)] || points[0]
  const span = Math.max(0.0001, next.sec - prev.sec)
  const ratio = clampNumber((safeSec - prev.sec) / span, 0, 1)
  return prev.gain + (next.gain - prev.gain) * ratio
}

export const sampleMixEnvelopeAtSec = (
  param: MixtapeEnvelopeParamId,
  points: MixtapeGainPoint[] | undefined,
  sec: number,
  fallbackGain: number = 1
) => {
  const config = resolveEnvelopeConfig(param)
  const sampled = sampleEnvelopeAtSec(points, sec, fallbackGain)
  return clampNumber(sampled, config.minGain, config.maxGain)
}

const mapGainToEnvelopeYPercent = (gain: number, minDb: number, maxDb: number) => {
  const span = Math.max(0.0001, maxDb - minDb)
  const minAbs = Math.max(0.0001, Math.abs(minDb))
  const maxAbs = Math.max(0.0001, Math.abs(maxDb))
  const hasZeroInRange = minDb < -0.0001 && maxDb > 0.0001
  const db = clampNumber(linearGainToDb(gain), minDb, maxDb)
  const yValue = hasZeroInRange
    ? db >= 0
      ? 50 - (db / maxAbs) * 50
      : 50 + (Math.abs(db) / minAbs) * 50
    : ((maxDb - db) / span) * 100
  return clampNumber(yValue, 0, 100)
}

export const mapMixEnvelopeGainToYPercent = (param: MixtapeEnvelopeParamId, gain: number) => {
  const config = resolveEnvelopeConfig(param)
  return mapGainToEnvelopeYPercent(
    clampNumber(gain, config.minGain, config.maxGain),
    config.minDb,
    config.maxDb
  )
}

export const mapMixEnvelopeYPercentToGain = (param: MixtapeEnvelopeParamId, yPercent: number) => {
  const config = resolveEnvelopeConfig(param)
  const minDb = config.minDb
  const maxDb = config.maxDb
  const safeY = clampNumber(yPercent, 0, 100)
  const minAbs = Math.max(0.0001, Math.abs(minDb))
  const maxAbs = Math.max(0.0001, Math.abs(maxDb))
  const hasZeroInRange = minDb < -0.0001 && maxDb > 0.0001
  let db = minDb
  if (hasZeroInRange) {
    if (safeY <= 50) {
      db = ((50 - safeY) / 50) * maxAbs
    } else {
      db = -((safeY - 50) / 50) * minAbs
    }
  } else {
    const span = Math.max(0.0001, maxDb - minDb)
    db = maxDb - (safeY / 100) * span
  }
  return clampNumber(dbToLinearGain(db), config.minGain, config.maxGain)
}

export const buildGainEnvelopePolylineByControlPoints = (params: {
  points?: MixtapeGainPoint[]
  durationSec: number
  minDb: number
  maxDb: number
  normalize?: boolean
}) => {
  const { points, durationSec, minDb, maxDb } = params
  const safeDuration = Math.max(0, Number(durationSec) || 0)
  const normalized =
    params.normalize === false ? (points ?? []) : normalizeGainEnvelopePoints(points, safeDuration)
  if (!normalized.length) return ''
  const segments: string[] = []
  const append = (point: MixtapeGainPoint) => {
    const ratio = safeDuration > 0 ? clampNumber(point.sec / safeDuration, 0, 1) : 0
    const x = (ratio * 100).toFixed(3)
    const y = mapGainToEnvelopeYPercent(point.gain, minDb, maxDb).toFixed(3)
    segments.push(`${x},${y}`)
  }
  append(normalized[0])
  // Playback interpolates linear gain. Sample that same curve before converting to dB pixels,
  // so inserting a point does not change the displayed shape of an existing envelope.
  const subdivide = (left: MixtapeGainPoint, right: MixtapeGainPoint, depth: number) => {
    const middle = { sec: (left.sec + right.sec) / 2, gain: (left.gain + right.gain) / 2 }
    const expected =
      (mapGainToEnvelopeYPercent(left.gain, minDb, maxDb) +
        mapGainToEnvelopeYPercent(right.gain, minDb, maxDb)) /
      2
    const actual = mapGainToEnvelopeYPercent(middle.gain, minDb, maxDb)
    if (right.sec > left.sec && Math.abs(actual - expected) > 0.25 && depth < 7) {
      subdivide(left, middle, depth + 1)
      subdivide(middle, right, depth + 1)
    } else append(right)
  }
  for (let index = 1; index < normalized.length; index++)
    subdivide(normalized[index - 1], normalized[index], 0)
  if (segments.length === 1) {
    segments.push(segments[0])
  }
  return segments.join(' ')
}

export const buildMixEnvelopePolylineByControlPoints = (params: {
  param: MixtapeEnvelopeParamId
  points?: MixtapeGainPoint[]
  durationSec: number
  normalize?: boolean
}) => {
  const { param, points, durationSec } = params
  const config = resolveEnvelopeConfig(param)
  return buildGainEnvelopePolylineByControlPoints({
    points:
      params.normalize === false ? points : normalizeMixEnvelopePoints(param, points, durationSec),
    durationSec,
    minDb: config.minDb,
    maxDb: config.maxDb,
    normalize: params.normalize
  })
}
