import { clampMixEnvelopeGain, dbToLinearGain, normalizeGainEnvelopePoints } from './gainEnvelope'
import type { MixtapeGainPoint, MixtapeTrack } from './types'

export const PROJECT_GAIN_STEP_DB = 0.5

export type ProjectGainEntry = { itemId: string; gainEnvelope: MixtapeGainPoint[] }
export type ProjectGainState = {
  entries: ProjectGainEntry[]
  minGain: number
  maxGain: number
}

export const readProjectGainState = (
  tracks: MixtapeTrack[],
  resolveDuration: (track: MixtapeTrack) => number
): ProjectGainState | null => {
  if (!tracks.length) return null
  const entries: ProjectGainEntry[] = []
  let minGain = Number.POSITIVE_INFINITY
  let maxGain = 0
  for (const track of tracks) {
    const durationSec = resolveDuration(track)
    if (!Number.isFinite(durationSec) || durationSec <= 0) return null
    const gainEnvelope = normalizeGainEnvelopePoints(track.gainEnvelope, durationSec)
    entries.push({ itemId: track.id, gainEnvelope })
    for (const point of gainEnvelope) {
      minGain = Math.min(minGain, point.gain)
      maxGain = Math.max(maxGain, point.gain)
    }
  }
  return { entries, minGain, maxGain }
}

export const canShiftProjectGain = (state: ProjectGainState | null, deltaDb: number) => {
  if (!state || !Number.isFinite(deltaDb) || deltaDb === 0) return false
  const ratio = dbToLinearGain(deltaDb)
  return (
    state.minGain * ratio >= clampMixEnvelopeGain('gain', Number.MIN_VALUE) &&
    state.maxGain * ratio <= clampMixEnvelopeGain('gain', Number.MAX_VALUE)
  )
}

export const shiftProjectGain = (state: ProjectGainState, deltaDb: number): ProjectGainEntry[] => {
  if (!canShiftProjectGain(state, deltaDb)) throw new Error('MIXTAPE_GAIN_LIMIT')
  const ratio = dbToLinearGain(deltaDb)
  return state.entries.map(({ itemId, gainEnvelope }) => ({
    itemId,
    gainEnvelope: gainEnvelope.map((point) => ({
      sec: point.sec,
      gain: Number((point.gain * ratio).toFixed(6))
    }))
  }))
}
