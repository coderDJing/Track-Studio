import type { BeatGridStatus } from '../../types/globals'

export const CURRENT_BEAT_GRID_ALGORITHM_VERSION = 10
export const BEAT_GRID_STATUS_NO_BPM: BeatGridStatus = 'no-bpm'

export const normalizeBeatGridAlgorithmVersion = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.max(1, Math.floor(numeric))
}
