import { EventEmitter } from 'node:events'
import type { SharedSongGridDefinition } from './sharedSongGrid'

export const songGridEvents = new EventEmitter()

const normalizeSongGridUpdate = (
  payload: SharedSongGridDefinition | null | undefined
): SharedSongGridDefinition | null => {
  const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
  if (!filePath) return null
  return {
    filePath,
    timeBasisOffsetMs: payload?.timeBasisOffsetMs,
    rekordboxGridEntries: payload?.rekordboxGridEntries,
    beatGridMap: Object.prototype.hasOwnProperty.call(payload, 'beatGridMap')
      ? payload?.beatGridMap
      : undefined,
    beatGridAlgorithmVersion: payload?.beatGridAlgorithmVersion
  } satisfies SharedSongGridDefinition
}

export const emitSongGridUpdated = (payload: SharedSongGridDefinition | null | undefined) => {
  const normalized = normalizeSongGridUpdate(payload)
  if (!normalized) return
  songGridEvents.emit('grid-updated', normalized)
}

export const emitSongGridBatchUpdated = (
  payloads: Array<SharedSongGridDefinition | null | undefined>
) => {
  const normalized = payloads
    .map((payload) => normalizeSongGridUpdate(payload))
    .filter((payload): payload is SharedSongGridDefinition => payload !== null)
  if (normalized.length === 0) return
  songGridEvents.emit('grid-batch-updated', normalized)
}
