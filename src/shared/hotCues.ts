import type { ISongHotCue } from '../types/globals'
import { resolveNearestUnifiedSongBeatGridLine } from './songBeatGridRuntime'
import { normalizePioneerUsbLoopBeatFields } from './pioneerUsbLoopBeats'

export const HOT_CUE_SLOT_COUNT = 8
const HOT_CUE_SLOT_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const
const HOT_CUE_SLOT_COLORS = [
  '#20c997',
  '#2f80ed',
  '#9b51e0',
  '#eb5757',
  '#f2c94c',
  '#ff6b9a',
  '#27ae60',
  '#56ccf2'
] as const
const REKORDBOX_DEFAULT_HOT_CUE_COLOR = '#30d26e'
const REKORDBOX_LOOP_HOT_CUE_COLOR = '#f2994a'

const HOT_CUE_EPSILON_SEC = 0.0001
const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const normalizeCueText = (value: unknown) => {
  const text = String(value || '').trim()
  return text || undefined
}
const normalizeCueColor = (value: unknown) => {
  const text = String(value || '').trim()
  return text || undefined
}
const normalizeCueSource = (value: unknown) => {
  const text = String(value || '').trim()
  return text || undefined
}
const normalizeCueOrder = (value: unknown) => {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined
}

export const resolveSongHotCueLabel = (slot: number) =>
  HOT_CUE_SLOT_LABELS[clampNumber(Math.floor(Number(slot) || 0), 0, HOT_CUE_SLOT_COUNT - 1)] || ''

const resolveSongHotCueColor = (slot: number) =>
  HOT_CUE_SLOT_COLORS[clampNumber(Math.floor(Number(slot) || 0), 0, HOT_CUE_SLOT_COUNT - 1)] ||
  HOT_CUE_SLOT_COLORS[0]

export const resolveSongHotCueDisplayLabel = (cue: ISongHotCue) =>
  normalizeCueText(cue?.label) || resolveSongHotCueLabel(cue?.slot ?? 0)

export const resolveSongHotCueDisplayColor = (cue: ISongHotCue) =>
  cue?.isLoop
    ? REKORDBOX_LOOP_HOT_CUE_COLOR
    : normalizeCueColor(cue?.color) ||
      (normalizeCueSource(cue?.source) === 'rekordbox'
        ? REKORDBOX_DEFAULT_HOT_CUE_COLOR
        : resolveSongHotCueColor(cue?.slot ?? 0))

export const normalizeSongHotCueSlot = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < 0 || numeric >= HOT_CUE_SLOT_COUNT) return null
  return numeric
}

export const normalizeSongHotCueSec = (value: unknown, durationSec?: number) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return null
  const bounded =
    Number.isFinite(Number(durationSec)) && Number(durationSec) > 0
      ? clampNumber(numeric, 0, Number(durationSec))
      : Math.max(0, numeric)
  return Number(bounded.toFixed(3))
}

const buildNormalizedSongHotCue = (value: unknown, durationSec?: number): ISongHotCue | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as {
    slot?: unknown
    sec?: unknown
    label?: unknown
    comment?: unknown
    colorIndex?: unknown
    colorName?: unknown
    color?: unknown
    isLoop?: unknown
    loopEndSec?: unknown
    loopNumerator?: unknown
    loopDenominator?: unknown
    source?: unknown
  }
  const slot = normalizeSongHotCueSlot(item.slot)
  const sec = normalizeSongHotCueSec(item.sec, durationSec)
  if (slot === null || sec === null) return null
  const loopEndSec = normalizeSongHotCueSec(item.loopEndSec, durationSec)
  const isLoop =
    Boolean(item.isLoop) && loopEndSec !== null && loopEndSec > sec + HOT_CUE_EPSILON_SEC
  return {
    slot,
    sec,
    label: normalizeCueText(item.label) || resolveSongHotCueLabel(slot),
    comment: normalizeCueText(item.comment),
    colorIndex: normalizeCueOrder(item.colorIndex),
    colorName: normalizeCueText(item.colorName),
    color: normalizeCueColor(item.color),
    isLoop,
    loopEndSec: isLoop ? (loopEndSec ?? undefined) : undefined,
    ...normalizePioneerUsbLoopBeatFields(item, isLoop),
    source: normalizeCueSource(item.source)
  }
}

export const normalizeSongHotCues = (value: unknown, durationSec?: number): ISongHotCue[] => {
  if (!Array.isArray(value)) return []
  const normalizedBySlot = new Map<number, ISongHotCue>()
  for (const item of value) {
    const normalized = buildNormalizedSongHotCue(item, durationSec)
    if (!normalized) continue
    normalizedBySlot.set(normalized.slot, normalized)
  }
  return Array.from(normalizedBySlot.values()).sort((left, right) => left.slot - right.slot)
}

export const resolveSongHotCueBySlot = (value: unknown, slot: number, durationSec?: number) =>
  normalizeSongHotCues(value, durationSec).find((item) => item.slot === slot) || null

export const upsertSongHotCue = (
  value: unknown,
  slot: number,
  sec: number,
  durationSec?: number
) => {
  const normalizedSlot = normalizeSongHotCueSlot(slot)
  const normalizedSec = normalizeSongHotCueSec(sec, durationSec)
  if (normalizedSlot === null || normalizedSec === null) {
    return normalizeSongHotCues(value, durationSec)
  }
  const next = normalizeSongHotCues(value, durationSec)
  const nextIndex = next.findIndex((item) => item.slot === normalizedSlot)
  const existing = nextIndex >= 0 ? next[nextIndex] : null
  const nextCue: ISongHotCue = {
    slot: normalizedSlot,
    sec: normalizedSec,
    label: existing?.label || resolveSongHotCueLabel(normalizedSlot),
    comment: existing?.comment,
    colorIndex: existing?.colorIndex,
    colorName: existing?.colorName,
    color: existing?.color,
    isLoop: false,
    loopEndSec: undefined,
    source: existing?.source
  }
  if (nextIndex >= 0) {
    next[nextIndex] = nextCue
  } else {
    next.push(nextCue)
  }
  return next.sort((left, right) => left.slot - right.slot)
}

export const upsertSongHotCueDefinition = (
  value: unknown,
  input: Partial<ISongHotCue> & { slot?: unknown; sec?: unknown },
  durationSec?: number
) => {
  const normalizedSlot = normalizeSongHotCueSlot(input?.slot)
  const normalizedSec = normalizeSongHotCueSec(input?.sec, durationSec)
  if (normalizedSlot === null || normalizedSec === null) {
    return normalizeSongHotCues(value, durationSec)
  }
  const next = normalizeSongHotCues(value, durationSec)
  const nextIndex = next.findIndex((item) => item.slot === normalizedSlot)
  const existing = nextIndex >= 0 ? next[nextIndex] : null
  const normalizedLoopEndSec = normalizeSongHotCueSec(input?.loopEndSec, durationSec)
  const isLoop =
    Boolean(input?.isLoop) &&
    normalizedLoopEndSec !== null &&
    normalizedLoopEndSec > normalizedSec + HOT_CUE_EPSILON_SEC
  const nextCue: ISongHotCue = {
    slot: normalizedSlot,
    sec: normalizedSec,
    label:
      normalizeCueText(input?.label) || existing?.label || resolveSongHotCueLabel(normalizedSlot),
    comment: normalizeCueText(input?.comment) ?? existing?.comment,
    colorIndex: normalizeCueOrder(input?.colorIndex) ?? existing?.colorIndex,
    colorName: normalizeCueText(input?.colorName) ?? existing?.colorName,
    color: normalizeCueColor(input?.color) ?? existing?.color,
    isLoop,
    loopEndSec: isLoop ? (normalizedLoopEndSec ?? undefined) : undefined,
    ...normalizePioneerUsbLoopBeatFields(
      input.loopNumerator === undefined &&
        input.loopDenominator === undefined &&
        existing?.sec === normalizedSec &&
        existing?.loopEndSec === normalizedLoopEndSec
        ? existing
        : input,
      isLoop
    ),
    source: normalizeCueSource(input?.source) ?? existing?.source
  }
  if (nextIndex >= 0) {
    next[nextIndex] = nextCue
  } else {
    next.push(nextCue)
  }
  return next.sort((left, right) => left.slot - right.slot)
}

export const removeSongHotCue = (value: unknown, slot: number, durationSec?: number) => {
  const normalizedSlot = normalizeSongHotCueSlot(slot)
  if (normalizedSlot === null) return normalizeSongHotCues(value, durationSec)
  return normalizeSongHotCues(value, durationSec).filter((item) => item.slot !== normalizedSlot)
}

export const areSongHotCuesEqual = (left: unknown, right: unknown, durationSec?: number) => {
  const normalizedLeft = normalizeSongHotCues(left, durationSec)
  const normalizedRight = normalizeSongHotCues(right, durationSec)
  if (normalizedLeft.length !== normalizedRight.length) return false
  return normalizedLeft.every((item, index) => {
    const next = normalizedRight[index]
    return (
      !!next &&
      next.slot === item.slot &&
      Math.abs(next.sec - item.sec) <= HOT_CUE_EPSILON_SEC &&
      Math.abs((next.loopEndSec || 0) - (item.loopEndSec || 0)) <= HOT_CUE_EPSILON_SEC &&
      Boolean(next.isLoop) === Boolean(item.isLoop) &&
      next.loopNumerator === item.loopNumerator &&
      next.loopDenominator === item.loopDenominator &&
      (next.label || '') === (item.label || '') &&
      (next.comment || '') === (item.comment || '') &&
      (next.color || '') === (item.color || '') &&
      (next.colorName || '') === (item.colorName || '') &&
      Number(next.colorIndex ?? -1) === Number(item.colorIndex ?? -1) &&
      (next.source || '') === (item.source || '')
    )
  })
}

export const formatSongHotCueTime = (value: unknown) => {
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

export const resolveNearestHotCueGridSec = (params: {
  currentSec: number
  durationSec?: number
  bpm?: number
  firstBeatMs?: number
  beatGridMap?: unknown
}) => {
  const durationSec = Number(params.durationSec)
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined
  const safeCurrent = normalizeSongHotCueSec(params.currentSec, safeDuration)
  if (safeCurrent === null) return null
  const nearestDynamicLine = resolveNearestUnifiedSongBeatGridLine(
    params.beatGridMap,
    safeDuration,
    safeCurrent
  )
  if (nearestDynamicLine) {
    const dynamicCandidate = normalizeSongHotCueSec(nearestDynamicLine.sec, safeDuration)
    if (dynamicCandidate !== null) {
      const zeroDistance = Math.abs(safeCurrent)
      const snappedDistance = Math.abs(safeCurrent - dynamicCandidate)
      return zeroDistance <= snappedDistance ? 0 : dynamicCandidate
    }
  }

  const bpm = Number(params.bpm)
  if (!Number.isFinite(bpm) || bpm <= 0) {
    return safeCurrent
  }
  const beatSec = 60 / bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) {
    return safeCurrent
  }

  const firstBeatSec = Math.max(0, Number(params.firstBeatMs) || 0) / 1000
  const nearestBeatIndex = Math.round((safeCurrent - firstBeatSec) / beatSec)
  const snapped =
    firstBeatSec + nearestBeatIndex * beatSec < 0 ? 0 : firstBeatSec + nearestBeatIndex * beatSec
  const candidate = normalizeSongHotCueSec(snapped, safeDuration)
  if (candidate === null) return safeCurrent

  const zeroDistance = Math.abs(safeCurrent)
  const snappedDistance = Math.abs(safeCurrent - candidate)
  return zeroDistance <= snappedDistance ? 0 : candidate
}
