import { EventEmitter } from 'node:events'
import type { SharedSongGridDefinition } from './sharedSongGrid'
import { normalizeSongBeatGridQuality } from '../../shared/beatGridQuality'

export const songGridEvents = new EventEmitter()

const normalizeSongGridUpdate = (
  payload: SharedSongGridDefinition | null | undefined
): SharedSongGridDefinition | null => {
  const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
  if (!filePath) return null
  // 显式带 beatGridQuality 键（哪怕是 null）表示「质量标记要清掉」；
  // 不带这个键表示质量标记保持原样（比如人工网格被保护时）。
  // 用 null 而不是 undefined：null 不会被 IPC 序列化丢掉。
  const hasBeatGridQuality = Object.prototype.hasOwnProperty.call(payload, 'beatGridQuality')
  const beatGridQuality = normalizeSongBeatGridQuality(payload?.beatGridQuality) ?? null
  return {
    filePath,
    timeBasisOffsetMs: payload?.timeBasisOffsetMs,
    rekordboxGridEntries: payload?.rekordboxGridEntries,
    beatGridMap: Object.prototype.hasOwnProperty.call(payload, 'beatGridMap')
      ? payload?.beatGridMap
      : undefined,
    beatGridAlgorithmVersion: payload?.beatGridAlgorithmVersion,
    ...(hasBeatGridQuality ? { beatGridQuality } : {})
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
