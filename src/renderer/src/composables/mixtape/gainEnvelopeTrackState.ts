import { buildTrackRuntimeTempoSnapshot } from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  normalizeMixEnvelopePoints,
  sampleMixEnvelopeAtSec
} from '@renderer/composables/mixtape/gainEnvelope'
import { buildMixtapeTrackLoopSignature } from '@renderer/composables/mixtape/mixtapeTrackLoop'
import {
  STEM_SEGMENT_ACTIVE_GAIN,
  STEM_SEGMENT_MUTE_THRESHOLD
} from '@renderer/composables/mixtape/gainEnvelopeStemSegments'
import { normalizeVolumeMuteSegments } from '@renderer/composables/mixtape/volumeMuteSegments'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'

const VOLUME_MUTE_SEGMENT_EPSILON = 0.0001
const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const createGainEnvelopeTrackStateModule = (params: {
  tracks: { value: MixtapeTrack[] }
  resolveRenderZoom: () => number
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  isStemSegmentParam: (param: MixtapeEnvelopeParamId) => boolean
}) => {
  type TrackGridRuntimeCacheEntry = {
    durationSec: number
    sourceDurationSec: number
    zoom: number
    beatGridMapSignature?: string
    loopSignature: string
    visibleGridLines: ReturnType<
      ReturnType<typeof buildTrackRuntimeTempoSnapshot>['timeMap']['buildVisibleGridLines']
    >
    visibleGridSegments: MixtapeMuteSegment[]
    snapshot: ReturnType<typeof buildTrackRuntimeTempoSnapshot>
  }

  const trackGridRuntimeCache = new WeakMap<MixtapeTrack, TrackGridRuntimeCacheEntry>()
  const ROUND_UNIT = 10000
  const roundSecToUnit = (sec: number, maxUnit?: number) => {
    const rounded = Math.round(Math.max(0, Number(sec) || 0) * ROUND_UNIT)
    if (typeof maxUnit === 'number') {
      return Math.max(0, Math.min(maxUnit, rounded))
    }
    return Math.max(0, rounded)
  }

  const buildVisibleGridSegmentsFromLines = (
    visibleGridLines: TrackGridRuntimeCacheEntry['visibleGridLines'],
    durationSec: number
  ) => {
    const safeDurationSec = Math.max(0, Number(durationSec) || 0)
    if (!safeDurationSec) return [] as MixtapeMuteSegment[]
    const durationUnit = roundSecToUnit(safeDurationSec)
    let previousUnit = 0
    const segments: MixtapeMuteSegment[] = []
    for (const line of visibleGridLines) {
      const nextUnit = roundSecToUnit(line.sec, durationUnit)
      if (nextUnit - previousUnit <= 0) continue
      if ((nextUnit - previousUnit) / ROUND_UNIT > VOLUME_MUTE_SEGMENT_EPSILON) {
        segments.push({
          startSec: previousUnit / ROUND_UNIT,
          endSec: nextUnit / ROUND_UNIT
        })
      }
      previousUnit = nextUnit
    }
    if ((durationUnit - previousUnit) / ROUND_UNIT > VOLUME_MUTE_SEGMENT_EPSILON) {
      segments.push({
        startSec: previousUnit / ROUND_UNIT,
        endSec: durationUnit / ROUND_UNIT
      })
    }
    return segments
  }

  const resolveTrackGridRuntime = (track: MixtapeTrack, durationSec: number) => {
    const safeDurationSec = Math.max(0, Number(durationSec) || 0)
    const sourceDurationSec = Math.max(
      0,
      Number(params.resolveTrackSourceDurationSeconds(track)) || 0
    )
    const zoom = Number(params.resolveRenderZoom()) || 0
    const cached = trackGridRuntimeCache.get(track)
    if (
      cached &&
      cached.durationSec === safeDurationSec &&
      cached.sourceDurationSec === sourceDurationSec &&
      cached.zoom === zoom &&
      cached.beatGridMapSignature === track.beatGridMap?.signature &&
      cached.loopSignature ===
        buildMixtapeTrackLoopSignature(track.loopSegments ?? track.loopSegment)
    ) {
      return cached
    }
    const snapshot = buildTrackRuntimeTempoSnapshot({
      track,
      sourceDurationSec,
      durationSec: safeDurationSec,
      zoom
    })
    const next: TrackGridRuntimeCacheEntry = {
      durationSec: safeDurationSec,
      sourceDurationSec,
      zoom,
      beatGridMapSignature: track.beatGridMap?.signature,
      loopSignature: buildMixtapeTrackLoopSignature(track.loopSegments ?? track.loopSegment),
      visibleGridLines: snapshot.visibleGridLines,
      visibleGridSegments: buildVisibleGridSegmentsFromLines(
        snapshot.visibleGridLines,
        safeDurationSec
      ),
      snapshot
    }
    trackGridRuntimeCache.set(track, next)
    return next
  }

  const resolveDynamicVisibleGridLines = (track: MixtapeTrack, durationSec: number) => {
    return resolveTrackGridRuntime(track, durationSec).visibleGridLines
  }

  const resolveVisibleGridSegments = (track: MixtapeTrack, durationSec: number) => {
    const safeDurationSec = Math.max(0, Number(durationSec) || 0)
    if (!safeDurationSec) return [] as MixtapeMuteSegment[]
    return resolveTrackGridRuntime(track, safeDurationSec).visibleGridSegments
  }

  const resolveVolumeMuteGrid = (track: MixtapeTrack, durationSec: number) => {
    const segments = resolveVisibleGridSegments(track, durationSec)
    if (!segments.length) return null
    return {
      durationSec: Math.max(0, Number(durationSec) || 0),
      segments
    }
  }

  const resolveGridAlignedVolumeMuteSegments = (
    track: MixtapeTrack,
    durationSec: number,
    value: unknown
  ) => {
    const normalized = normalizeVolumeMuteSegments(value, durationSec)
    if (!normalized.length) return [] as MixtapeMuteSegment[]
    const segments = resolveVisibleGridSegments(track, durationSec)
    if (!segments.length) return normalized
    return segments.filter((segment: MixtapeMuteSegment) =>
      normalized.some(
        (item: MixtapeMuteSegment) =>
          Math.min(segment.endSec, item.endSec) - Math.max(segment.startSec, item.startSec) >
          VOLUME_MUTE_SEGMENT_EPSILON
      )
    )
  }

  const resolveVolumeMuteSegmentBySec = (payload: {
    track: MixtapeTrack
    durationSec: number
    sec: number
  }) => {
    const segments = resolveVisibleGridSegments(payload.track, payload.durationSec)
    if (!segments.length) return null
    const maxSelectableSec = Math.max(0, payload.durationSec - VOLUME_MUTE_SEGMENT_EPSILON)
    const safeSec = clampNumber(Number(payload.sec) || 0, 0, maxSelectableSec)
    for (const segment of segments) {
      const isLast =
        Math.abs(segment.endSec - Number(payload.durationSec)) <= VOLUME_MUTE_SEGMENT_EPSILON
      if (safeSec < segment.startSec - VOLUME_MUTE_SEGMENT_EPSILON) continue
      if (safeSec < segment.endSec - VOLUME_MUTE_SEGMENT_EPSILON || isLast) {
        return segment
      }
    }
    return segments[segments.length - 1] || null
  }

  const snapSecToVisibleGrid = (payload: {
    track: MixtapeTrack
    sec: number
    durationSec: number
    minSec?: number
    maxSec?: number
  }) => {
    const snapshot = resolveTrackGridRuntime(payload.track, payload.durationSec).snapshot
    const nearest = snapshot.timeMap.resolveNearestGridLine(
      payload.sec,
      params.resolveRenderZoom(),
      {
        minLocalSec: payload.minSec,
        maxLocalSec: payload.maxSec
      }
    )
    if (nearest) return nearest.sec
    const durationSec = Math.max(0, Number(payload.durationSec) || 0)
    const minSec = clampNumber(Number(payload.minSec) || 0, 0, durationSec)
    const maxSec = clampNumber(
      Number.isFinite(Number(payload.maxSec)) ? Number(payload.maxSec) : durationSec,
      minSec,
      durationSec
    )
    return clampNumber(Number(payload.sec) || 0, minSec, maxSec)
  }

  const resolveTrackEnvelopeState = (trackId: string, param: MixtapeEnvelopeParamId) => {
    const safeTrackId = String(trackId || '').trim()
    const track = params.tracks.value.find((item) => item.id === safeTrackId) || null
    if (!track) {
      return {
        track: null,
        durationSec: 0,
        points: [] as MixtapeGainPoint[]
      }
    }
    const rawDurationSec = params.resolveTrackDurationSeconds(track)
    const durationSec =
      Number.isFinite(rawDurationSec) && rawDurationSec > 0 ? Math.max(0, rawDurationSec) : 0
    const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
    const points = normalizeMixEnvelopePoints(param, track[envelopeField], durationSec)
    return {
      track,
      durationSec,
      points
    }
  }

  const resolveTrackVolumeMuteState = (trackId: string) => {
    const safeTrackId = String(trackId || '').trim()
    const track = params.tracks.value.find((item) => item.id === safeTrackId) || null
    if (!track) {
      return {
        track: null,
        durationSec: 0,
        segments: [] as MixtapeMuteSegment[]
      }
    }
    const rawDurationSec = params.resolveTrackDurationSeconds(track)
    const durationSec =
      Number.isFinite(rawDurationSec) && rawDurationSec > 0 ? Math.max(0, rawDurationSec) : 0
    const segments = normalizeVolumeMuteSegments(track.volumeMuteSegments, durationSec)
    return {
      track,
      durationSec,
      segments
    }
  }

  const resolveTrackStemSegmentState = (trackId: string, param: MixtapeEnvelopeParamId) => {
    const envelopeState = resolveTrackEnvelopeState(trackId, param)
    const { track, durationSec, points } = envelopeState
    if (!track || !durationSec) {
      return {
        track: null,
        durationSec: 0,
        segments: [] as MixtapeMuteSegment[]
      }
    }
    if (!params.isStemSegmentParam(param)) {
      return {
        track,
        durationSec,
        segments: [] as MixtapeMuteSegment[]
      }
    }
    const grid = resolveVolumeMuteGrid(track, durationSec)
    if (!grid) {
      return {
        track,
        durationSec,
        segments: [] as MixtapeMuteSegment[]
      }
    }
    const epsilon = 0.0001
    const maxSelectableSec = Math.max(0, durationSec - epsilon)
    const mutedSegments: MixtapeMuteSegment[] = []
    for (const gridSegment of grid.segments) {
      const centerSec = Number(((gridSegment.startSec + gridSegment.endSec) / 2).toFixed(4))
      if (centerSec > maxSelectableSec + epsilon) continue
      const segment = resolveVolumeMuteSegmentBySec({
        track,
        durationSec,
        sec: centerSec
      })
      if (!segment) continue
      const sampleSec = Number(((segment.startSec + segment.endSec) / 2).toFixed(4))
      const gain = sampleMixEnvelopeAtSec(param, points, sampleSec, STEM_SEGMENT_ACTIVE_GAIN)
      if (gain > STEM_SEGMENT_MUTE_THRESHOLD) continue
      mutedSegments.push(segment)
    }
    const segments = resolveGridAlignedVolumeMuteSegments(track, durationSec, mutedSegments)
    return {
      track,
      durationSec,
      segments
    }
  }

  return {
    resolveDynamicVisibleGridLines,
    resolveVisibleGridSegments,
    resolveVolumeMuteGrid,
    resolveGridAlignedVolumeMuteSegments,
    resolveVolumeMuteSegmentBySec,
    snapSecToVisibleGrid,
    resolveTrackEnvelopeState,
    resolveTrackVolumeMuteState,
    resolveTrackStemSegmentState
  }
}
