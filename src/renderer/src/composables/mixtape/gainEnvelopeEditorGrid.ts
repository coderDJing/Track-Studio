import type { MixSegmentMask } from '@renderer/composables/mixtape/gainEnvelopeEditorTypes'
import type { MixtapeMuteSegment } from '@renderer/composables/mixtape/types'

export const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

export const resolveVolumeMuteSegmentKey = (segment: MixtapeMuteSegment) =>
  `${Number(segment.startSec).toFixed(4)}:${Number(segment.endSec).toFixed(4)}`

export const resolveVolumeMutePointerSec = (
  stageEl: HTMLElement,
  event: MouseEvent,
  durationSec: number
) => {
  const rect = stageEl.getBoundingClientRect()
  if (!rect.width || !durationSec) return null
  const xRatio = clampNumber((event.clientX - rect.left) / rect.width, 0, 1)
  return Number((xRatio * durationSec).toFixed(4))
}

export const resolveVolumeMuteSegmentMasks = (
  durationSec: number,
  segments: MixtapeMuteSegment[]
): MixSegmentMask[] => {
  if (!durationSec || !segments.length) return []
  return segments
    .map((segment) => {
      const startRatio = clampNumber(segment.startSec / durationSec, 0, 1)
      const endRatio = clampNumber(segment.endSec / durationSec, 0, 1)
      const widthRatio = Math.max(0, endRatio - startRatio)
      if (widthRatio <= 0.0001) return null
      return {
        key: resolveVolumeMuteSegmentKey(segment),
        left: Number((startRatio * 100).toFixed(4)),
        width: Number((widthRatio * 100).toFixed(4))
      }
    })
    .filter((segment): segment is MixSegmentMask => segment !== null)
}

export const resolveVolumeMuteSegmentsByToggle = (
  baseSegments: MixtapeMuteSegment[],
  touched: Map<string, MixtapeMuteSegment>
) => {
  const nextMap = new Map(
    baseSegments.map((segment) => [resolveVolumeMuteSegmentKey(segment), segment])
  )
  for (const [key, segment] of touched.entries()) {
    if (nextMap.has(key)) {
      nextMap.delete(key)
    } else {
      nextMap.set(key, segment)
    }
  }
  return Array.from(nextMap.values())
}

// Toggle only the selected intervals, preserving mute boundaries from other zoom levels.
export const toggleVolumeMuteIntervals = (
  baseSegments: MixtapeMuteSegment[],
  touched: Map<string, MixtapeMuteSegment>
): MixtapeMuteSegment[] => {
  const events: Array<{ sec: number; baseDelta: number; touchedDelta: number }> = []
  const addEvents = (segment: MixtapeMuteSegment, isBase: boolean) => {
    events.push({ sec: segment.startSec, baseDelta: isBase ? 1 : 0, touchedDelta: isBase ? 0 : 1 })
    events.push({ sec: segment.endSec, baseDelta: isBase ? -1 : 0, touchedDelta: isBase ? 0 : -1 })
  }
  baseSegments.forEach((segment) => addEvents(segment, true))
  touched.forEach((segment) => addEvents(segment, false))
  events.sort((a, b) => a.sec - b.sec)
  const result: MixtapeMuteSegment[] = []
  let baseDepth = 0
  let touchedDepth = 0
  for (let index = 0; index < events.length - 1; index += 1) {
    const event = events[index]
    baseDepth += event.baseDelta
    touchedDepth += event.touchedDelta
    const startSec = event.sec
    const endSec = events[index + 1].sec
    if (endSec - startSec <= 0.0001) continue
    if (baseDepth > 0 === touchedDepth > 0) continue
    const last = result[result.length - 1]
    if (last && Math.abs(last.endSec - startSec) <= 0.0001) last.endSec = endSec
    else result.push({ startSec, endSec })
  }
  return result
}
