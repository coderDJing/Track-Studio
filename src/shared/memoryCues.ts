import type { ISongMemoryCue } from '../types/globals'
import { normalizePioneerUsbLoopBeatFields } from './pioneerUsbLoopBeats'

const REKORDBOX_DEFAULT_MEMORY_CUE_COLOR = '#df4d4d'

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const MEMORY_CUE_EPSILON_SEC = 0.0001
const normalizeCueText = (value: unknown) => {
  const text = String(value || '').trim()
  return text || undefined
}
const normalizeCueOrder = (value: unknown) => {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined
}

export const normalizeSongMemoryCueSec = (value: unknown, durationSec?: number) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return null
  const bounded =
    Number.isFinite(Number(durationSec)) && Number(durationSec) > 0
      ? clampNumber(numeric, 0, Number(durationSec))
      : Math.max(0, numeric)
  return Number(bounded.toFixed(3))
}

export const resolveSongMemoryCueDisplayColor = (cue: ISongMemoryCue) =>
  normalizeCueText(cue?.color) ||
  (normalizeCueText(cue?.source) === 'rekordbox'
    ? REKORDBOX_DEFAULT_MEMORY_CUE_COLOR
    : REKORDBOX_DEFAULT_MEMORY_CUE_COLOR)

const buildNormalizedSongMemoryCue = (
  value: unknown,
  durationSec?: number
): ISongMemoryCue | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as {
    sec?: unknown
    order?: unknown
    comment?: unknown
    colorIndex?: unknown
    colorName?: unknown
    color?: unknown
    isLoop?: unknown
    loopEndSec?: unknown
    loopNumerator?: unknown
    loopDenominator?: unknown
    activeLoop?: unknown
    source?: unknown
  }
  const sec = normalizeSongMemoryCueSec(item.sec, durationSec)
  if (sec === null) return null
  const loopEndSec = normalizeSongMemoryCueSec(item.loopEndSec, durationSec)
  const isLoop =
    Boolean(item.isLoop) && loopEndSec !== null && loopEndSec > sec + MEMORY_CUE_EPSILON_SEC
  return {
    sec,
    order: normalizeCueOrder(item.order),
    comment: normalizeCueText(item.comment),
    colorIndex: normalizeCueOrder(item.colorIndex),
    colorName: normalizeCueText(item.colorName),
    color: normalizeCueText(item.color),
    isLoop,
    loopEndSec: isLoop ? (loopEndSec ?? undefined) : undefined,
    ...normalizePioneerUsbLoopBeatFields(item, isLoop),
    activeLoop: typeof item.activeLoop === 'boolean' ? isLoop && item.activeLoop : undefined,
    source: normalizeCueText(item.source)
  }
}

const isSameMemoryCueIdentity = (left: ISongMemoryCue, right: ISongMemoryCue) => {
  const leftLoopEndSec = left.loopEndSec || 0
  const rightLoopEndSec = right.loopEndSec || 0
  return (
    Math.abs(left.sec - right.sec) <= MEMORY_CUE_EPSILON_SEC &&
    Math.abs(leftLoopEndSec - rightLoopEndSec) <= MEMORY_CUE_EPSILON_SEC
  )
}

const compareMemoryCue = (left: ISongMemoryCue, right: ISongMemoryCue) => {
  const leftOrder = normalizeCueOrder(left.order)
  const rightOrder = normalizeCueOrder(right.order)
  if (leftOrder !== undefined || rightOrder !== undefined) {
    if (leftOrder === undefined) return 1
    if (rightOrder === undefined) return -1
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
  }
  return left.sec - right.sec
}

export const normalizeSongMemoryCues = (value: unknown, durationSec?: number): ISongMemoryCue[] => {
  if (!Array.isArray(value)) return []
  const normalized: ISongMemoryCue[] = []
  for (const item of value) {
    const nextCue = buildNormalizedSongMemoryCue(item, durationSec)
    if (!nextCue) continue
    if (normalized.some((entry) => isSameMemoryCueIdentity(entry, nextCue))) continue
    normalized.push(nextCue)
  }
  return normalized.sort(compareMemoryCue)
}

export const upsertSongMemoryCue = (value: unknown, sec: number, durationSec?: number) => {
  const normalizedSec = normalizeSongMemoryCueSec(sec, durationSec)
  if (normalizedSec === null) return normalizeSongMemoryCues(value, durationSec)
  const next = normalizeSongMemoryCues(value, durationSec)
  if (next.some((item) => Math.abs(item.sec - normalizedSec) <= MEMORY_CUE_EPSILON_SEC)) {
    return next
  }
  next.push({ sec: normalizedSec })
  return next.sort(compareMemoryCue)
}

export const upsertSongMemoryCueDefinition = (
  value: unknown,
  input: Partial<ISongMemoryCue> & { sec?: unknown },
  durationSec?: number
) => {
  const normalizedSec = normalizeSongMemoryCueSec(input?.sec, durationSec)
  if (normalizedSec === null) return normalizeSongMemoryCues(value, durationSec)
  const next = normalizeSongMemoryCues(value, durationSec)
  const normalizedLoopEndSec = normalizeSongMemoryCueSec(input?.loopEndSec, durationSec)
  const isLoop =
    Boolean(input?.isLoop) &&
    normalizedLoopEndSec !== null &&
    normalizedLoopEndSec > normalizedSec + MEMORY_CUE_EPSILON_SEC
  const nextCue: ISongMemoryCue = {
    sec: normalizedSec,
    order: normalizeCueOrder(input?.order),
    comment: normalizeCueText(input?.comment),
    colorIndex: normalizeCueOrder(input?.colorIndex),
    colorName: normalizeCueText(input?.colorName),
    color: normalizeCueText(input?.color),
    isLoop,
    loopEndSec: isLoop ? (normalizedLoopEndSec ?? undefined) : undefined,
    ...normalizePioneerUsbLoopBeatFields(input, isLoop),
    activeLoop: typeof input.activeLoop === 'boolean' ? isLoop && input.activeLoop : undefined,
    source: normalizeCueText(input?.source)
  }
  const matchingIndex = next.findIndex((item) => isSameMemoryCueIdentity(item, nextCue))
  if (matchingIndex >= 0) {
    const previous = next[matchingIndex]
    if (nextCue.activeLoop !== undefined || nextCue.loopNumerator !== undefined)
      next[matchingIndex] = {
        ...previous,
        ...(nextCue.activeLoop === undefined ? {} : { activeLoop: nextCue.activeLoop }),
        ...normalizePioneerUsbLoopBeatFields(nextCue, isLoop)
      }
    return next
  }
  next.push(nextCue)
  return next.sort(compareMemoryCue)
}

export const removeSongMemoryCue = (value: unknown, sec: number, durationSec?: number) => {
  const normalizedSec = normalizeSongMemoryCueSec(sec, durationSec)
  if (normalizedSec === null) return normalizeSongMemoryCues(value, durationSec)
  return normalizeSongMemoryCues(value, durationSec).filter(
    (item) => Math.abs(item.sec - normalizedSec) > MEMORY_CUE_EPSILON_SEC
  )
}

export const areSongMemoryCuesEqual = (left: unknown, right: unknown, durationSec?: number) => {
  const normalizedLeft = normalizeSongMemoryCues(left, durationSec)
  const normalizedRight = normalizeSongMemoryCues(right, durationSec)
  if (normalizedLeft.length !== normalizedRight.length) return false
  return normalizedLeft.every((item, index) => {
    const next = normalizedRight[index]
    return (
      !!next &&
      Math.abs(next.sec - item.sec) <= MEMORY_CUE_EPSILON_SEC &&
      Math.abs((next.loopEndSec || 0) - (item.loopEndSec || 0)) <= MEMORY_CUE_EPSILON_SEC &&
      Boolean(next.isLoop) === Boolean(item.isLoop) &&
      next.activeLoop === item.activeLoop &&
      next.loopNumerator === item.loopNumerator &&
      next.loopDenominator === item.loopDenominator &&
      Number(next.order ?? -1) === Number(item.order ?? -1) &&
      (next.comment || '') === (item.comment || '') &&
      (next.color || '') === (item.color || '') &&
      (next.colorName || '') === (item.colorName || '') &&
      Number(next.colorIndex ?? -1) === Number(item.colorIndex ?? -1) &&
      (next.source || '') === (item.source || '')
    )
  })
}

export const formatSongMemoryCueTime = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return '--:--.---'
  const totalMs = Math.round(numeric * 1000)
  const hours = Math.floor(totalMs / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const seconds = Math.floor((totalMs % 60_000) / 1000)
  const milliseconds = totalMs % 1000
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`
}
