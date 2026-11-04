import {
  buildTrackTargetBeatIntegralCache,
  buildTrackVisibleGridLinesFromDynamicSourceGrid,
  buildTempoRatioIntegralCache,
  buildTrackVisibleGridLines,
  createDynamicSourceBeatMap,
  resolveTrackBpmEnvelopeRenderablePoints,
  resolveTrackLocalSecAtSourceTime,
  resolveTrackSourceTimeAtLocalSec,
  resolveLocalSecAtTargetBeatDelta,
  resolveTargetBeatDeltaAtLocalSec,
  sampleTrackBpmEnvelopeAtSec,
  type TrackTimeMap,
  type TrackTimeMapInput,
  type TrackVisibleGridLine
} from '@renderer/composables/mixtape/trackTimeMapCore'
import {
  buildTrackVisibleGridLinesOnMasterGrid,
  createMixtapeMasterGrid,
  mapTrackLocalToSourceOnMasterGrid,
  mapTrackSourceToLocalOnMasterGrid
} from '@renderer/composables/mixtape/mixtapeMasterGrid'
import {
  buildMixtapeTrackLoopSignature,
  expandVisibleGridLinesByTrackLoop,
  mapBaseTrackLocalToFirstLoopedLocal,
  mapLoopedTrackLocalToBaseLocal,
  resolveMixtapeTrackTimelineDuration
} from '@renderer/composables/mixtape/mixtapeTrackLoop'
import {
  BPM_POINT_SEC_EPSILON,
  clampTrackTempoNumber,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import type { SerializedTrackTempoSnapshot } from '@renderer/composables/mixtape/types'

const TRACK_TIME_MAP_SNAPSHOT_CACHE_LIMIT = 180
const trackTimeMapSnapshotCache = new Map<string, TrackTimeMap>()

// Callers derive a base map by removing loops from a serialized snapshot. Its
// signature stays the same, so all mapping inputs must participate in the key.
// Keep sub-millisecond phase values intact for highly zoomed waveform rendering.
const buildSerializedTrackTimeMapCacheKey = (snapshot: SerializedTrackTempoSnapshot) =>
  JSON.stringify(snapshot)

const readTrackTimeMapSnapshotCache = (key: string) => {
  const cached = trackTimeMapSnapshotCache.get(key)
  if (!cached) return null
  trackTimeMapSnapshotCache.delete(key)
  trackTimeMapSnapshotCache.set(key, cached)
  return cached
}

const writeTrackTimeMapSnapshotCache = (key: string, value: TrackTimeMap) => {
  trackTimeMapSnapshotCache.set(key, value)
  if (trackTimeMapSnapshotCache.size <= TRACK_TIME_MAP_SNAPSHOT_CACHE_LIMIT) return
  const oldestKey = trackTimeMapSnapshotCache.keys().next().value
  if (typeof oldestKey === 'string') {
    trackTimeMapSnapshotCache.delete(oldestKey)
  }
}

const createFilterLinesByRange = (
  durationSec: number,
  linesFactory: (zoom: number) => TrackVisibleGridLine[]
) => {
  return (
    zoom: number,
    range?: { minLocalSec?: number; maxLocalSec?: number }
  ): TrackVisibleGridLine[] => {
    const minLocalSec = clampTrackTempoNumber(Number(range?.minLocalSec) || 0, 0, durationSec)
    const maxLocalSec = clampTrackTempoNumber(
      Number.isFinite(Number(range?.maxLocalSec)) ? Number(range?.maxLocalSec) : durationSec,
      minLocalSec,
      durationSec
    )
    return linesFactory(zoom).filter(
      (line) =>
        line.sec >= minLocalSec - BPM_POINT_SEC_EPSILON &&
        line.sec <= maxLocalSec + BPM_POINT_SEC_EPSILON
    )
  }
}

const createGridResolvers = (params: {
  durationSec: number
  buildLines: (zoom: number) => TrackVisibleGridLine[]
}) => {
  const filterLinesByRange = createFilterLinesByRange(params.durationSec, params.buildLines)
  return {
    buildSnapCandidates: (zoom: number) => params.buildLines(zoom).map((line) => line.sec),
    resolveNearestGridLine: (
      localSec: number,
      zoom: number,
      range?: { minLocalSec?: number; maxLocalSec?: number }
    ) => {
      const safeLocalSec = clampTrackTempoNumber(Number(localSec) || 0, 0, params.durationSec)
      const visibleGridLines = filterLinesByRange(zoom, range)
      if (!visibleGridLines.length) return null
      let nearest = visibleGridLines[0]
      let minDiff = Math.abs(nearest.sec - safeLocalSec)
      for (let index = 1; index < visibleGridLines.length; index += 1) {
        const candidate = visibleGridLines[index]
        const diff = Math.abs(candidate.sec - safeLocalSec)
        if (diff < minDiff) {
          nearest = candidate
          minDiff = diff
        }
      }
      return nearest
    },
    snapLocalSec: (
      localSec: number,
      zoom: number,
      range?: { minLocalSec?: number; maxLocalSec?: number }
    ) => {
      const safeLocalSec = clampTrackTempoNumber(Number(localSec) || 0, 0, params.durationSec)
      if (safeLocalSec <= BPM_POINT_SEC_EPSILON) return 0
      if (safeLocalSec >= params.durationSec - BPM_POINT_SEC_EPSILON) {
        return roundTrackTempoSec(params.durationSec)
      }
      const visibleGridLines = filterLinesByRange(zoom, range)
      if (!visibleGridLines.length) return roundTrackTempoSec(safeLocalSec)
      let nearest = visibleGridLines[0]!.sec
      let minDiff = Math.abs(nearest - safeLocalSec)
      for (let index = 1; index < visibleGridLines.length; index += 1) {
        const candidate = visibleGridLines[index]!.sec
        const diff = Math.abs(candidate - safeLocalSec)
        if (diff < minDiff) {
          nearest = candidate
          minDiff = diff
        }
      }
      return roundTrackTempoSec(nearest)
    }
  }
}

const createLoopedTrackTimeMap = (
  baseMap: TrackTimeMap,
  input: TrackTimeMapInput
): TrackTimeMap => {
  const baseDurationSec = Math.max(0, Number(baseMap.durationSec) || 0)
  const loopValue =
    Array.isArray(input.loopSegments) && input.loopSegments.length
      ? input.loopSegments
      : input.loopSegment
  const hasLoop = buildMixtapeTrackLoopSignature(loopValue) !== 'none'
  if (!hasLoop) return baseMap
  const durationSec = resolveMixtapeTrackTimelineDuration(baseDurationSec, loopValue)
  const buildLines = (zoom: number) =>
    expandVisibleGridLinesByTrackLoop(
      baseMap.buildVisibleGridLines(zoom),
      baseDurationSec,
      loopValue
    )
  const gridResolvers = createGridResolvers({ durationSec, buildLines })

  return {
    ...baseMap,
    durationSec,
    mapLocalToSource: (localSec: number) =>
      baseMap.mapLocalToSource(
        mapLoopedTrackLocalToBaseLocal(localSec, baseDurationSec, loopValue)
      ),
    mapSourceToLocal: (sourceSec: number) =>
      mapBaseTrackLocalToFirstLoopedLocal(
        baseMap.mapSourceToLocal(sourceSec),
        baseDurationSec,
        loopValue
      ),
    sampleBpmAtLocal: (localSec: number) =>
      baseMap.sampleBpmAtLocal(
        mapLoopedTrackLocalToBaseLocal(localSec, baseDurationSec, loopValue)
      ),
    buildVisibleGridLines: (zoom: number) => buildLines(zoom),
    buildSnapCandidates: gridResolvers.buildSnapCandidates,
    resolveNearestGridLine: gridResolvers.resolveNearestGridLine,
    snapLocalSec: gridResolvers.snapLocalSec
  }
}

const createLegacyTrackTimeMap = (input: TrackTimeMapInput): TrackTimeMap => {
  let durationSec = Math.max(0, Number(input.durationSec) || 0)
  const sourceDurationSec = Math.max(0, Number(input.sourceDurationSec) || 0)
  const inputFirstBeatSourceSec = Number(input.firstBeatSourceSec)
  const firstBeatSourceSec = Number.isFinite(inputFirstBeatSourceSec) ? inputFirstBeatSourceSec : 0
  const beatSourceSec = Math.max(0, Number(input.beatSourceSec) || 0)
  const downbeatBeatOffset = Number(input.downbeatBeatOffset) || 0
  const renderPoints = resolveTrackBpmEnvelopeRenderablePoints({
    points: input.controlPoints,
    durationSec,
    sourceDurationSec,
    originalBpm: input.originalBpm,
    fallbackBpm: input.fallbackBpm
  })
  const tempoRatioIntegralCache = buildTempoRatioIntegralCache({
    points: renderPoints,
    durationSec,
    originalBpm: input.originalBpm,
    fallbackBpm: input.fallbackBpm
  })
  const dynamicSourceBeatMap = createDynamicSourceBeatMap(
    input.sourceBeatGridMap,
    sourceDurationSec
  )
  const targetBeatIntegralCache = dynamicSourceBeatMap
    ? buildTrackTargetBeatIntegralCache({
        points: renderPoints,
        durationSec,
        fallbackBpm: input.fallbackBpm
      })
    : null
  const mapLocalToSource = (localSec: number) => {
    if (
      dynamicSourceBeatMap &&
      targetBeatIntegralCache &&
      targetBeatIntegralCache.totalBeats > BPM_POINT_SEC_EPSILON
    ) {
      const targetBeatDelta = resolveTargetBeatDeltaAtLocalSec(targetBeatIntegralCache, localSec)
      const sourceBeatDelta =
        targetBeatDelta * (dynamicSourceBeatMap.beatSpan / targetBeatIntegralCache.totalBeats)
      return dynamicSourceBeatMap.mapBeatOrdinalToSource(
        dynamicSourceBeatMap.startBeatOrdinal + sourceBeatDelta
      )
    }
    return resolveTrackSourceTimeAtLocalSec({
      points: renderPoints,
      localSec,
      durationSec,
      sourceDurationSec,
      originalBpm: input.originalBpm,
      fallbackBpm: input.fallbackBpm,
      integralCache: tempoRatioIntegralCache
    })
  }
  const mapSourceToLocal = (sourceSec: number) => {
    if (
      dynamicSourceBeatMap &&
      targetBeatIntegralCache &&
      dynamicSourceBeatMap.beatSpan > BPM_POINT_SEC_EPSILON
    ) {
      const sourceBeatDelta =
        dynamicSourceBeatMap.mapSourceToBeatOrdinal(sourceSec) -
        dynamicSourceBeatMap.startBeatOrdinal
      const targetBeatDelta =
        sourceBeatDelta * (targetBeatIntegralCache.totalBeats / dynamicSourceBeatMap.beatSpan)
      return resolveLocalSecAtTargetBeatDelta(targetBeatIntegralCache, targetBeatDelta)
    }
    return resolveTrackLocalSecAtSourceTime({
      points: renderPoints,
      sourceSec,
      durationSec,
      sourceDurationSec,
      originalBpm: input.originalBpm,
      fallbackBpm: input.fallbackBpm,
      integralCache: tempoRatioIntegralCache
    })
  }

  const buildLines = (zoom: number) =>
    dynamicSourceBeatMap
      ? buildTrackVisibleGridLinesFromDynamicSourceGrid({
          sourceBeatGridMap: input.sourceBeatGridMap,
          sourceDurationSec,
          zoom,
          mapSourceToLocal
        }) || []
      : buildTrackVisibleGridLines({
          points: renderPoints,
          durationSec,
          sourceDurationSec,
          firstBeatSourceSec,
          beatSourceSec,
          downbeatBeatOffset,
          zoom,
          originalBpm: input.originalBpm,
          fallbackBpm: input.fallbackBpm
        })
  const gridResolvers = createGridResolvers({ durationSec, buildLines })

  return {
    controlPoints: input.controlPoints,
    renderPoints,
    durationSec,
    sourceDurationSec,
    firstBeatSourceSec,
    beatSourceSec,
    downbeatBeatOffset,
    mapLocalToSource,
    mapSourceToLocal,
    sampleBpmAtLocal: (localSec: number) =>
      sampleTrackBpmEnvelopeAtSec(renderPoints, localSec, input.fallbackBpm),
    sampleBpmAtSource: (sourceSec: number) =>
      sampleTrackBpmEnvelopeAtSec(renderPoints, mapSourceToLocal(sourceSec), input.fallbackBpm),
    buildVisibleGridLines: (zoom: number) => buildLines(zoom),
    buildSnapCandidates: gridResolvers.buildSnapCandidates,
    resolveNearestGridLine: gridResolvers.resolveNearestGridLine,
    snapLocalSec: gridResolvers.snapLocalSec
  }
}

const createMasterGridTrackTimeMap = (input: TrackTimeMapInput): TrackTimeMap => {
  let durationSec = Math.max(0, Number(input.durationSec) || 0)
  const sourceDurationSec = Math.max(0, Number(input.sourceDurationSec) || 0)
  const inputFirstBeatSourceSec = Number(input.firstBeatSourceSec)
  const firstBeatSourceSec = Number.isFinite(inputFirstBeatSourceSec) ? inputFirstBeatSourceSec : 0
  const beatSourceSec = Math.max(BPM_POINT_SEC_EPSILON, Number(input.beatSourceSec) || 0)
  const downbeatBeatOffset = Number(input.downbeatBeatOffset) || 0
  const trackStartSec = Math.max(0, Number(input.trackStartSec) || 0)
  const masterGrid = createMixtapeMasterGrid({
    points: input.masterGridPoints || [],
    phaseOffsetSec: input.masterGridPhaseOffsetSec,
    fallbackBpm: Number(input.masterGridFallbackBpm) || Number(input.fallbackBpm) || 128
  })
  const dynamicSourceBeatMap = createDynamicSourceBeatMap(
    input.sourceBeatGridMap,
    sourceDurationSec
  )
  const trackStartBeat = masterGrid.mapSecToBeats(trackStartSec)
  if (dynamicSourceBeatMap) {
    durationSec = roundTrackTempoSec(
      Math.max(
        0,
        masterGrid.mapBeatsToSec(trackStartBeat + dynamicSourceBeatMap.beatSpan) - trackStartSec
      )
    )
  }
  const renderPoints = input.controlPoints.map((point) => ({
    sec: Number(point.sec),
    bpm: Number(point.bpm),
    sourceSec:
      Number.isFinite(Number(point.sourceSec)) && Number(point.sourceSec) >= 0
        ? Number(point.sourceSec)
        : undefined,
    allowOffGrid: point.allowOffGrid === true ? true : undefined
  }))
  const mapSourceToLocal = (sourceSec: number) => {
    if (dynamicSourceBeatMap) {
      const sourceBeatDelta =
        dynamicSourceBeatMap.mapSourceToBeatOrdinal(sourceSec) -
        dynamicSourceBeatMap.startBeatOrdinal
      const localSec = masterGrid.mapBeatsToSec(trackStartBeat + sourceBeatDelta) - trackStartSec
      return roundTrackTempoSec(clampTrackTempoNumber(localSec, 0, durationSec))
    }
    return mapTrackSourceToLocalOnMasterGrid({
      grid: masterGrid,
      trackStartSec,
      sourceSec,
      sourceDurationSec,
      beatSourceSec,
      durationSec
    })
  }
  const mapLocalToSource = (localSec: number) => {
    if (dynamicSourceBeatMap) {
      const safeLocalSec = clampTrackTempoNumber(Number(localSec) || 0, 0, durationSec)
      const timelineBeat = masterGrid.mapSecToBeats(trackStartSec + safeLocalSec)
      return dynamicSourceBeatMap.mapBeatOrdinalToSource(
        dynamicSourceBeatMap.startBeatOrdinal + (timelineBeat - trackStartBeat)
      )
    }
    return mapTrackLocalToSourceOnMasterGrid({
      grid: masterGrid,
      trackStartSec,
      localSec,
      sourceDurationSec,
      beatSourceSec,
      durationSec
    })
  }
  const buildLines = (zoom: number) =>
    buildTrackVisibleGridLinesFromDynamicSourceGrid({
      sourceBeatGridMap: input.sourceBeatGridMap,
      sourceDurationSec,
      zoom,
      mapSourceToLocal
    }) ??
    buildTrackVisibleGridLinesOnMasterGrid({
      grid: masterGrid,
      trackStartSec,
      durationSec,
      sourceDurationSec,
      firstBeatSourceSec,
      beatSourceSec,
      downbeatBeatOffset,
      zoom
    })
  const gridResolvers = createGridResolvers({ durationSec, buildLines })

  return {
    controlPoints: renderPoints,
    renderPoints,
    durationSec,
    sourceDurationSec,
    firstBeatSourceSec,
    beatSourceSec,
    downbeatBeatOffset,
    mapLocalToSource,
    mapSourceToLocal,
    sampleBpmAtLocal: (localSec: number) =>
      masterGrid.sampleBpmAtSec(trackStartSec + Number(localSec || 0)),
    sampleBpmAtSource: (sourceSec: number) =>
      masterGrid.sampleBpmAtSec(trackStartSec + mapSourceToLocal(sourceSec)),
    buildVisibleGridLines: (zoom: number) => buildLines(zoom),
    buildSnapCandidates: gridResolvers.buildSnapCandidates,
    resolveNearestGridLine: gridResolvers.resolveNearestGridLine,
    snapLocalSec: gridResolvers.snapLocalSec
  }
}

export const createTrackTimeMap = (input: TrackTimeMapInput): TrackTimeMap => {
  const shouldUseMasterGrid =
    input.mappingMode === 'masterGrid' &&
    Array.isArray(input.masterGridPoints) &&
    input.masterGridPoints.length >= 2
  const baseMap = shouldUseMasterGrid
    ? createMasterGridTrackTimeMap(input)
    : createLegacyTrackTimeMap(input)
  return createLoopedTrackTimeMap(baseMap, input)
}

export const createTrackTimeMapFromSnapshotPayload = (
  snapshot: SerializedTrackTempoSnapshot
): TrackTimeMap => {
  const cacheKey = buildSerializedTrackTimeMapCacheKey(snapshot)
  const cached = readTrackTimeMapSnapshotCache(cacheKey)
  if (cached) return cached
  const next = createTrackTimeMap({
    controlPoints: snapshot.controlPoints.map((point) => ({
      sec: Number(point.sec),
      bpm: Number(point.bpm),
      sourceSec:
        Number.isFinite(Number(point.sourceSec)) && Number(point.sourceSec) >= 0
          ? Number(point.sourceSec)
          : undefined,
      allowOffGrid: point.allowOffGrid === true ? true : undefined
    })),
    durationSec: Number(snapshot.baseDurationSec) || Number(snapshot.durationSec) || 0,
    sourceDurationSec: Number(snapshot.sourceDurationSec) || 0,
    originalBpm: Number(snapshot.originalBpm) || 0,
    fallbackBpm: Number(snapshot.baseBpm) || 128,
    firstBeatSourceSec: Number(snapshot.firstBeatSourceSec) || 0,
    beatSourceSec: Number(snapshot.beatSourceSec) || 0,
    downbeatBeatOffset: Number(snapshot.downbeatBeatOffset) || 0,
    sourceBeatGridMap: snapshot.sourceBeatGridMap,
    loopSegments: Array.isArray(snapshot.loopSegments)
      ? snapshot.loopSegments.map((segment) => ({
          startSec: Number(segment.startSec),
          endSec: Number(segment.endSec),
          repeatCount: Number(segment.repeatCount)
        }))
      : undefined,
    loopSegment: snapshot.loopSegment
      ? {
          startSec: Number(snapshot.loopSegment.startSec),
          endSec: Number(snapshot.loopSegment.endSec),
          repeatCount: Number(snapshot.loopSegment.repeatCount)
        }
      : undefined,
    mappingMode: snapshot.mappingMode,
    trackStartSec: Number(snapshot.trackStartSec) || 0,
    masterGridFallbackBpm:
      Number(snapshot.masterGridFallbackBpm) || Number(snapshot.baseBpm) || 128,
    masterGridPhaseOffsetSec: Number(snapshot.masterGridPhaseOffsetSec) || 0,
    masterGridPoints: Array.isArray(snapshot.masterGridPoints)
      ? snapshot.masterGridPoints.map((point) => ({
          sec: Number(point.sec),
          bpm: Number(point.bpm)
        }))
      : undefined
  })
  writeTrackTimeMapSnapshotCache(cacheKey, next)
  return next
}
