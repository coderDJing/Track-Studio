import {
  clampMixEnvelopeGain,
  dbToLinearGain,
  linearGainToDb,
  mapMixEnvelopeGainToYPercent,
  mapMixEnvelopeYPercentToGain,
  sampleMixEnvelopeAtSec
} from './gainEnvelope'
import type { MixtapeEnvelopeParamId, MixtapeGainPoint } from './types'

export const ENVELOPE_POINT_HIT_PX = 12
export const ENVELOPE_SNAP_PX = 7
export const ENVELOPE_SNAP_RELEASE_PX = 12
export const ENVELOPE_TIME_EPSILON = 0.0002
export const cloneEnvelope = (points: MixtapeGainPoint[]) => points.map((point) => ({ ...point }))
export const clampEnvelopeValue = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

export const resolveMagneticEnvelopeTime = (options: {
  sec: number
  grid: readonly { sec: number }[]
  pxPerSec: number
  enabled: boolean
  latched: number | null
  min: number
  max: number
}) => {
  const { sec, grid, pxPerSec, enabled, latched, min, max } = options
  const free = clampEnvelopeValue(sec, min, max)
  if (!enabled) return { sec: free, latched: null }
  if (
    latched !== null &&
    latched >= min &&
    latched <= max &&
    Math.abs(sec - latched) * pxPerSec <= ENVELOPE_SNAP_RELEASE_PX
  )
    return { sec: latched, latched }
  let best: number | null = null
  let distance = ENVELOPE_SNAP_PX
  for (const line of grid) {
    const target = Number(line.sec.toFixed(4))
    if (target < min || target > max) continue
    const pixels = Math.abs(sec - target) * pxPerSec
    if (pixels <= distance) {
      best = target
      distance = pixels
    }
  }
  return { sec: best ?? free, latched: best }
}

export const resolveEnvelopeDbLimits = (param: MixtapeEnvelopeParamId) => ({
  min: linearGainToDb(mapMixEnvelopeYPercentToGain(param, 100)),
  max: linearGainToDb(mapMixEnvelopeYPercentToGain(param, 0))
})

// Translate screen movement in the displayed dB domain, including crossing the 0 dB line.
export const moveEnvelopeDb = (
  param: MixtapeEnvelopeParamId,
  db: number,
  deltaY: number,
  height: number
) => {
  if (deltaY === 0) return db
  const y = mapMixEnvelopeGainToYPercent(param, dbToLinearGain(db))
  const next = mapMixEnvelopeYPercentToGain(param, y + (deltaY / height) * 100)
  return linearGainToDb(next)
}

export const shiftEnvelopePointsDb = (
  param: MixtapeEnvelopeParamId,
  points: MixtapeGainPoint[],
  indices: number[],
  deltaDb: number
) => {
  const selected = new Set(indices)
  const values = points.filter((_, i) => selected.has(i)).map((point) => linearGainToDb(point.gain))
  if (!values.length) return cloneEnvelope(points)
  const limits = resolveEnvelopeDbLimits(param)
  // Limit the group as a whole so its shape survives contact with either bound.
  const delta = clampEnvelopeValue(
    deltaDb,
    Math.min(0, limits.min - Math.min(...values)),
    Math.max(0, limits.max - Math.max(...values))
  )
  return points.map((point, i) =>
    selected.has(i)
      ? {
          sec: point.sec,
          gain: clampMixEnvelopeGain(param, dbToLinearGain(linearGainToDb(point.gain) + delta))
        }
      : { ...point }
  )
}

const boundaryGain = (
  param: MixtapeEnvelopeParamId,
  points: MixtapeGainPoint[],
  sec: number,
  side: 'left' | 'right'
) => {
  const same = points.filter((point) => Math.abs(point.sec - sec) < 0.00005)
  return same.length
    ? same[side === 'left' ? 0 : same.length - 1].gain
    : sampleMixEnvelopeAtSec(param, points, sec)
}

// Paired boundary points preserve the original envelope on both sides of a local edit.
export const replaceEnvelopeRange = (
  param: MixtapeEnvelopeParamId,
  base: MixtapeGainPoint[],
  start: number,
  end: number,
  replacement: MixtapeGainPoint[],
  duration: number
) => {
  const left = Number(start.toFixed(4)),
    right = Number(end.toFixed(4))
  if (right - left < ENVELOPE_TIME_EPSILON || !replacement.length) return cloneEnvelope(base)
  const before = base.filter((point) => point.sec < left)
  const after = base.filter((point) => point.sec > right)
  return [
    ...cloneEnvelope(before),
    ...(left > 0 ? [{ sec: left, gain: boundaryGain(param, base, left, 'left') }] : []),
    ...cloneEnvelope(replacement),
    ...(right < duration ? [{ sec: right, gain: boundaryGain(param, base, right, 'right') }] : []),
    ...cloneEnvelope(after)
  ]
}

export const shiftEnvelopeRange = (
  param: MixtapeEnvelopeParamId,
  base: MixtapeGainPoint[],
  start: number,
  end: number,
  deltaDb: number,
  duration: number
) => {
  if (Math.abs(deltaDb) < 0.00001) return cloneEnvelope(base)
  const inner = [
    { sec: start, gain: boundaryGain(param, base, start, 'right') },
    ...base.filter((point) => point.sec > start && point.sec < end),
    { sec: end, gain: boundaryGain(param, base, end, 'left') }
  ]
  return replaceEnvelopeRange(
    param,
    base,
    start,
    end,
    shiftEnvelopePointsDb(
      param,
      inner,
      inner.map((_, index) => index),
      deltaDb
    ),
    duration
  )
}

// Bake the drawn dB shape into the existing linear-gain format used by playback and export.
// Adaptive subdivision limits audible/visual error to 0.08 dB without per-pixel nodes.
export const buildEnvelopeRamp = (
  param: MixtapeEnvelopeParamId,
  start: MixtapeGainPoint,
  end: MixtapeGainPoint,
  bend = 0
) => {
  if (end.sec - start.sec < ENVELOPE_TIME_EPSILON) return [start, end]
  const a = linearGainToDb(start.gain),
    b = linearGainToDb(end.gain)
  const sample = (ratio: number): MixtapeGainPoint => {
    const shaped = Math.abs(bend) < 0.001 ? ratio : Math.pow(ratio, Math.pow(4, bend))
    return {
      sec: start.sec + (end.sec - start.sec) * ratio,
      gain: dbToLinearGain(a + (b - a) * shaped)
    }
  }
  const points: MixtapeGainPoint[] = [{ ...start }]
  const split = (left: number, right: number, depth: number) => {
    const p = sample(left),
      q = sample(right),
      middle = sample((left + right) / 2)
    const error = Math.abs(linearGainToDb((p.gain + q.gain) / 2) - linearGainToDb(middle.gain))
    if (error > 0.08 && depth < 7 && q.sec - p.sec > 0.001) {
      split(left, (left + right) / 2, depth + 1)
      split((left + right) / 2, right, depth + 1)
    } else points.push({ sec: Number(q.sec.toFixed(4)), gain: clampMixEnvelopeGain(param, q.gain) })
  }
  split(0, 1, 0)
  return points
}
