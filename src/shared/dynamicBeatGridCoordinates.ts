import {
  createSongBeatGridMapV2FromClips,
  normalizeSongBeatGridMapV2,
  projectSongBeatGridMapV2ToFixedGrid,
  type SongBeatGridClipV2,
  type SongBeatGridMapV2,
  type SongBeatGridV2Source
} from './songBeatGridMapV2'
import type { DynamicGridCoordinateConversionResult } from './dynamicBeatGridTypes'

const TIME_EPSILON_SEC = 1e-6
const DURATION_TOLERANCE_SEC = 0.001

type ValidatedMap = {
  version: 2
  source: SongBeatGridV2Source
  clips: SongBeatGridClipV2[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const readFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const isSource = (value: unknown): value is SongBeatGridV2Source =>
  value === 'analysis' ||
  value === 'manual' ||
  value === 'rekordbox' ||
  value === 'serato' ||
  value === 'traktor'

const validateRawMap = (
  value: unknown
): { status: 'ok'; map: ValidatedMap } | { status: 'error'; reason: string } => {
  if (!isRecord(value)) return { status: 'error', reason: 'grid-map-must-be-object' }
  if (value.version !== 2) return { status: 'error', reason: 'grid-map-version-invalid' }
  if (!isSource(value.source)) return { status: 'error', reason: 'grid-map-source-invalid' }
  if (!Array.isArray(value.clips) || !value.clips.length) {
    return { status: 'error', reason: 'grid-map-clips-empty' }
  }
  const clips: SongBeatGridClipV2[] = []
  for (let index = 0; index < value.clips.length; index += 1) {
    const rawClip = value.clips[index]
    if (!isRecord(rawClip)) return { status: 'error', reason: `clip-not-object:${index}` }
    const startSec = readFiniteNumber(rawClip.startSec)
    const anchorSec = readFiniteNumber(rawClip.anchorSec)
    const bpm = readFiniteNumber(rawClip.bpm)
    const downbeatBeatOffset = readFiniteNumber(rawClip.downbeatBeatOffset)
    if (startSec === null || anchorSec === null || bpm === null || downbeatBeatOffset === null) {
      return { status: 'error', reason: `clip-field-not-finite:${index}` }
    }
    if (startSec < 0 || bpm <= 0) return { status: 'error', reason: `clip-value-invalid:${index}` }
    if (!Number.isInteger(downbeatBeatOffset) || downbeatBeatOffset < 0 || downbeatBeatOffset > 3) {
      return { status: 'error', reason: `clip-downbeat-offset-invalid:${index}` }
    }
    if (index === 0) {
      if (Math.abs(startSec) > 1e-9) return { status: 'error', reason: 'first-clip-start-not-zero' }
    } else if (startSec <= clips[index - 1].startSec + 1e-9) {
      return { status: 'error', reason: `clip-start-not-strictly-increasing:${index}` }
    }
    clips.push({ startSec, anchorSec, bpm, downbeatBeatOffset })
  }
  return { status: 'ok', map: { version: 2, source: value.source, clips } }
}

const buildResult = (
  clips: readonly SongBeatGridClipV2[],
  source: SongBeatGridMapV2['source'],
  durationSec: number
): DynamicGridCoordinateConversionResult => {
  const map = createSongBeatGridMapV2FromClips(clips, source, {
    allowSingleClip: true,
    durationSec
  })
  if (!map) return { status: 'error', reason: 'grid-normalization-failed' }
  const projection = projectSongBeatGridMapV2ToFixedGrid(map)
  if (!projection) return { status: 'error', reason: 'grid-projection-failed' }
  return { status: 'ok', map, durationSec, projection }
}

const normalizeOffsetSec = (timeBasisOffsetMs: unknown): number | null => {
  const offsetMs = readFiniteNumber(timeBasisOffsetMs)
  if (offsetMs === null || offsetMs < 0) return null
  return offsetMs / 1000
}

const assertDurationsMatch = (providedSec: number, expectedSec: number): string | null =>
  Math.abs(providedSec - expectedSec) > DURATION_TOLERANCE_SEC
    ? 'duration-does-not-match-time-basis-relation'
    : null

/**
 * audio 坐标 map -> timeline 坐标 map。
 *
 * 首段 start 固定为 0；所有 anchor 加 timeBasisOffset，后续 clip 的 start 也加偏移。
 * 输入在 normalize 之前先严格校验有限数、首段 0、严格递增和 downbeat offset；非法规格
 * 直接报错，不依赖 normalize 排序或 Number(null)=0 之类隐式转换。
 */
export const convertDynamicAudioGridMapToTimeline = (params: {
  beatGridMap: unknown
  audioDurationSec: unknown
  timeBasisOffsetMs: unknown
  timelineDurationSec?: unknown
}): DynamicGridCoordinateConversionResult => {
  const validated = validateRawMap(params.beatGridMap)
  if (validated.status !== 'ok') return validated
  const audioDurationSec = readFiniteNumber(params.audioDurationSec)
  if (audioDurationSec === null || audioDurationSec <= 0) {
    return { status: 'error', reason: 'invalid-audio-duration' }
  }
  const offsetSec = normalizeOffsetSec(params.timeBasisOffsetMs)
  if (offsetSec === null) return { status: 'error', reason: 'invalid-time-basis-offset' }
  const expectedDurationSec = audioDurationSec + offsetSec
  const providedTimelineDuration =
    params.timelineDurationSec === undefined
      ? expectedDurationSec
      : readFiniteNumber(params.timelineDurationSec)
  if (providedTimelineDuration === null || providedTimelineDuration <= 0) {
    return { status: 'error', reason: 'invalid-timeline-duration' }
  }
  const durationRelationError = assertDurationsMatch(providedTimelineDuration, expectedDurationSec)
  if (durationRelationError) return { status: 'error', reason: durationRelationError }

  const clips: SongBeatGridClipV2[] = validated.map.clips.map((clip, index) => ({
    startSec: index === 0 ? 0 : clip.startSec + offsetSec,
    anchorSec: clip.anchorSec + offsetSec,
    bpm: clip.bpm,
    downbeatBeatOffset: clip.downbeatBeatOffset
  }))
  for (let index = 1; index < clips.length; index += 1) {
    if (clips[index].startSec >= providedTimelineDuration - TIME_EPSILON_SEC) {
      return { status: 'error', reason: `clip-start-outside-timeline:${index}` }
    }
  }
  if (clips[0].anchorSec >= providedTimelineDuration + TIME_EPSILON_SEC) {
    return { status: 'error', reason: 'first-anchor-outside-timeline' }
  }
  return buildResult(clips, validated.map.source, providedTimelineDuration)
}

/**
 * timeline 坐标 map -> audio 坐标 map。反向转换与正向使用同一个 timeBasisOffset。
 * 后续 start 落到 0 或负数时显式报错，避免把两段静默合并成一段。
 */
export const convertDynamicTimelineGridMapToAudio = (params: {
  beatGridMap: unknown
  timelineDurationSec: unknown
  timeBasisOffsetMs: unknown
  audioDurationSec?: unknown
}): DynamicGridCoordinateConversionResult => {
  const validated = validateRawMap(params.beatGridMap)
  if (validated.status !== 'ok') return validated
  const timelineDurationSec = readFiniteNumber(params.timelineDurationSec)
  if (timelineDurationSec === null || timelineDurationSec <= 0) {
    return { status: 'error', reason: 'invalid-timeline-duration' }
  }
  const offsetSec = normalizeOffsetSec(params.timeBasisOffsetMs)
  if (offsetSec === null) return { status: 'error', reason: 'invalid-time-basis-offset' }
  const expectedAudioDuration = timelineDurationSec - offsetSec
  const audioDurationSec =
    params.audioDurationSec === undefined
      ? expectedAudioDuration
      : readFiniteNumber(params.audioDurationSec)
  if (audioDurationSec === null || audioDurationSec <= 0) {
    return { status: 'error', reason: 'invalid-audio-duration' }
  }
  const durationRelationError = assertDurationsMatch(audioDurationSec, expectedAudioDuration)
  if (durationRelationError) return { status: 'error', reason: durationRelationError }

  const clips: SongBeatGridClipV2[] = validated.map.clips.map((clip, index) => ({
    startSec: index === 0 ? 0 : clip.startSec - offsetSec,
    anchorSec: clip.anchorSec - offsetSec,
    bpm: clip.bpm,
    downbeatBeatOffset: clip.downbeatBeatOffset
  }))
  for (let index = 1; index < clips.length; index += 1) {
    if (clips[index].startSec <= TIME_EPSILON_SEC) {
      return { status: 'error', reason: `timeline-clip-start-collapses:${index}` }
    }
    if (clips[index].startSec >= audioDurationSec - TIME_EPSILON_SEC) {
      return { status: 'error', reason: `clip-start-outside-audio:${index}` }
    }
  }
  return buildResult(clips, validated.map.source, audioDurationSec)
}

/**
 * 从人工共享 map 派生一个独立的、只覆盖有效音频时长的裁剪视图。
 * 不修改输入 map；超出有效时长的 clip 被丢弃，跨越末尾的 clip 只保留有效部分。
 */
export const deriveDynamicAudioGridMapForDuration = (params: {
  beatGridMap: unknown
  audioDurationSec: unknown
}): DynamicGridCoordinateConversionResult => {
  const validated = validateRawMap(params.beatGridMap)
  if (validated.status !== 'ok') return validated
  const audioDurationSec = readFiniteNumber(params.audioDurationSec)
  if (audioDurationSec === null || audioDurationSec <= 0) {
    return { status: 'error', reason: 'invalid-audio-duration' }
  }
  const sourceClips = validated.map.clips
  const derived: SongBeatGridClipV2[] = []
  for (let index = 0; index < sourceClips.length; index += 1) {
    const clip = sourceClips[index]
    const endSec =
      index + 1 < sourceClips.length ? sourceClips[index + 1].startSec : audioDurationSec
    const overlapStart = Math.max(0, clip.startSec)
    const overlapEnd = Math.min(audioDurationSec, endSec)
    if (overlapEnd - overlapStart <= TIME_EPSILON_SEC) continue
    derived.push({
      startSec: derived.length === 0 ? 0 : overlapStart,
      anchorSec: clip.anchorSec,
      bpm: clip.bpm,
      downbeatBeatOffset: clip.downbeatBeatOffset
    })
  }
  if (!derived.length) return { status: 'error', reason: 'derived-range-has-no-clips' }
  if (derived[0].startSec !== 0) derived[0] = { ...derived[0], startSec: 0 }
  for (let index = 1; index < derived.length; index += 1) {
    if (derived[index].startSec <= derived[index - 1].startSec + TIME_EPSILON_SEC) {
      return { status: 'error', reason: `derived-clip-start-not-increasing:${index}` }
    }
  }
  const normalized = normalizeSongBeatGridMapV2(
    { version: 2, source: validated.map.source, clips: derived },
    { allowSingleClip: true, durationSec: audioDurationSec }
  )
  if (!normalized) return { status: 'error', reason: 'derived-grid-normalization-failed' }
  const projection = projectSongBeatGridMapV2ToFixedGrid(normalized)
  if (!projection) return { status: 'error', reason: 'derived-grid-projection-failed' }
  return { status: 'ok', map: normalized, durationSec: audioDurationSec, projection }
}
