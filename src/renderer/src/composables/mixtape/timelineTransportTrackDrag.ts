import { ref } from 'vue'
import {
  DEFAULT_LANE_COUNT,
  GRID_BEAT_LINE_ZOOM,
  GRID_DOWNBEAT_LINE_ZOOM,
  normalizeMixtapeLaneIndex,
  resolveMixtapeStoredLaneIndex
} from '@renderer/composables/mixtape/constants'
import { buildMixtapeDisplayLaneMap } from '@renderer/composables/mixtape/mixtapeLaneCount'
import {
  resolveBeatSecByBpm,
  resolveGridAnchorSec
} from '@renderer/composables/mixtape/beatSyncModel'
import { createMixtapeMasterGrid } from '@renderer/composables/mixtape/mixtapeMasterGrid'
import {
  resolveMixtapeAudioBeatGridMap,
  resolveMixtapeAudioFirstBeatSec
} from '@renderer/composables/mixtape/mixtapeAudioGridBasis'
import {
  isMixtapeGlobalTempoReady,
  mixtapeGlobalTempoEnvelope,
  mixtapeGlobalTempoPhaseOffsetSec
} from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import { resolveSnappedStartSecByVisibleGrid } from '@renderer/composables/mixtape/trackGridSnap'
import { buildTrackRuntimeTempoSnapshot } from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import { createDynamicSourceBeatMap } from '@renderer/composables/mixtape/trackTimeMapCore'
import {
  BPM_POINT_SEC_EPSILON,
  roundTrackTempoSec,
  resolveTrackGridSourceBpm
} from '@renderer/composables/mixtape/trackTempoModel'
import type { MixtapeTrack, TimelineTrackLayout } from '@renderer/composables/mixtape/types'

type ValueRef<T> = {
  value: T
}

type TrackTimingItem = {
  id: string
  laneIndex: number
  startSec: number
  endSec: number
  durationSec: number
}

type TimelineTransportTrackDragContext = {
  tracks: ValueRef<MixtapeTrack[]>
  laneCount?: ValueRef<number>
  normalizedRenderZoom: ValueRef<number>
  resolveRenderPxPerSec: (zoomValue: number) => number
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack, targetBpm?: number) => number
  resolveTimelineSecByX: (x: number, pxPerSec: number) => number
  stopTransportForTrackChange: () => void
  scheduleFullPreRender: () => void
  scheduleWorkerPreRender: () => void
  persistTrackStartSec: (
    entries: Array<{
      itemId: string
      startSec?: number
      bpm?: number
      masterTempo?: boolean
      originalBpm?: number
      laneIndex?: number
    }>
  ) => Promise<void>
  persistTrackVolumeMuteSegments?: (
    entries: Array<{ itemId: string; segments: Array<{ startSec: number; endSec: number }> }>
  ) => Promise<void>
  remapVolumeMuteSegmentsForBpm?: (
    track: MixtapeTrack,
    targetBpm: number
  ) => Array<{ startSec: number; endSec: number }>
  normalizeStartSec: (value: unknown) => number | null
  clampNumber: (value: number, min: number, max: number) => number
  normalizeBeatOffset: (value: unknown, interval: number) => number
}

export const createTimelineTransportTrackDragModule = (ctx: TimelineTransportTrackDragContext) => {
  const {
    tracks,
    laneCount,
    normalizedRenderZoom,
    resolveRenderPxPerSec,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatSeconds,
    resolveTimelineSecByX,
    stopTransportForTrackChange,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    persistTrackStartSec,
    normalizeStartSec,
    clampNumber,
    normalizeBeatOffset
  } = ctx

  const isTrackDragging = ref(false)

  let trackDragState: {
    trackId: string
    startClientX: number
    initialStartSec: number
    initialLaneIndex: number
    currentLaneIndex: number
    laneRects: Array<{ laneIndex: number; top: number; bottom: number }>
    snapshotTracks: MixtapeTrack[]
  } | null = null

  const findTrack = (trackId: string) =>
    tracks.value.find((item: MixtapeTrack) => item.id === trackId) || null

  const resolveActiveLaneCount = () => {
    const numeric = Number(laneCount?.value)
    return Number.isFinite(numeric) && numeric >= DEFAULT_LANE_COUNT
      ? Math.max(DEFAULT_LANE_COUNT, Math.floor(numeric))
      : DEFAULT_LANE_COUNT
  }

  const resolveDragLaneRects = (event: MouseEvent) => {
    const eventTarget = event.currentTarget || event.target
    const targetElement = eventTarget instanceof HTMLElement ? eventTarget : null
    const laneRoot = targetElement?.closest('.timeline-lanes')
    if (!laneRoot) return [] as Array<{ laneIndex: number; top: number; bottom: number }>
    return Array.from(laneRoot.querySelectorAll('.timeline-lane'))
      .map((element, index) => {
        const rect = element.getBoundingClientRect()
        return {
          laneIndex: normalizeMixtapeLaneIndex(index, 0, resolveActiveLaneCount()),
          top: rect.top,
          bottom: rect.bottom
        }
      })
      .filter((rect) => Number.isFinite(rect.top) && Number.isFinite(rect.bottom))
  }

  const resolvePointerLaneIndex = (clientY: number) => {
    if (!trackDragState) return 0
    const laneRects = trackDragState.laneRects
    if (!laneRects.length) return trackDragState.currentLaneIndex
    const hit = laneRects.find((rect) => clientY >= rect.top && clientY <= rect.bottom)
    if (hit) return hit.laneIndex
    const first = laneRects[0]
    const last = laneRects[laneRects.length - 1]
    if (first && clientY < first.top) return first.laneIndex
    if (last && clientY > last.bottom) return last.laneIndex
    return trackDragState.currentLaneIndex
  }

  const buildTrackTimingSnapshot = (inputTracks: MixtapeTrack[]) => {
    let cursorSec = 0
    const timings = inputTracks.map((track, index) => {
      // 用存起来的泳道号参与折叠，显示泳道由 buildMixtapeDisplayLaneMap 统一决定。
      const laneIndex = resolveMixtapeStoredLaneIndex(track?.laneIndex, index)
      const duration = resolveTrackDurationSeconds(track)
      const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
      const rawStartSec = Number(track.startSec)
      const startSec =
        Number.isFinite(rawStartSec) && rawStartSec >= 0 ? Math.max(0, rawStartSec) : cursorSec
      const endSec = startSec + safeDuration
      cursorSec = Math.max(cursorSec, endSec)
      return {
        id: track.id,
        laneIndex,
        startSec,
        endSec,
        durationSec: safeDuration
      }
    }) satisfies TrackTimingItem[]
    // 泳道收起时，碰撞判定必须按“显示出来的泳道”算，否则会和用户看到的排布不一致。
    const displayLaneByTrackId = buildMixtapeDisplayLaneMap(timings, resolveActiveLaneCount())
    return timings.map((item) => {
      const displayLaneIndex = displayLaneByTrackId.get(item.id)
      return typeof displayLaneIndex === 'number' ? { ...item, laneIndex: displayLaneIndex } : item
    }) satisfies TrackTimingItem[]
  }

  const resolveLanePlacement = (payload: {
    trackId: string
    laneIndex: number
    rawStartSec: number
    durationSec: number
    inputTracks?: MixtapeTrack[]
    excludeTrackIds?: Set<string>
  }) => {
    const rawStartSec = Math.max(0, Number(payload.rawStartSec) || 0)
    const durationSec = Math.max(0, Number(payload.durationSec) || 0)
    const timings = buildTrackTimingSnapshot(payload.inputTracks || tracks.value)
    const occupied = timings
      .filter(
        (item) =>
          item.id !== payload.trackId &&
          !payload.excludeTrackIds?.has(item.id) &&
          item.laneIndex === payload.laneIndex &&
          item.endSec > item.startSec + BPM_POINT_SEC_EPSILON
      )
      .sort((a, b) => a.startSec - b.startSec)
    const merged: Array<{ startSec: number; endSec: number }> = []
    for (const item of occupied) {
      const startSec = Math.max(0, Number(item.startSec) || 0)
      const endSec = Math.max(startSec, Number(item.endSec) || startSec)
      const last = merged[merged.length - 1]
      if (last && startSec <= last.endSec + BPM_POINT_SEC_EPSILON) {
        last.endSec = Math.max(last.endSec, endSec)
      } else {
        merged.push({ startSec, endSec })
      }
    }
    const boundaryCandidates = [0]
    const candidates: number[] = []
    let previousEndSec = 0
    for (const item of merged) {
      const gapStartSec = previousEndSec
      const gapEndSec = Math.max(gapStartSec, item.startSec)
      if (gapEndSec - gapStartSec + BPM_POINT_SEC_EPSILON >= durationSec) {
        const maxStartSec = Math.max(gapStartSec, gapEndSec - durationSec)
        candidates.push(clampNumber(rawStartSec, gapStartSec, maxStartSec))
        boundaryCandidates.push(gapStartSec, maxStartSec)
      }
      previousEndSec = Math.max(previousEndSec, item.endSec)
    }
    candidates.push(Math.max(rawStartSec, previousEndSec))
    boundaryCandidates.push(previousEndSec)
    let nearestStartSec = candidates[0] ?? rawStartSec
    let nearestDiffSec = Math.abs(nearestStartSec - rawStartSec)
    for (let index = 1; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const diffSec = Math.abs(candidate - rawStartSec)
      if (diffSec < nearestDiffSec - BPM_POINT_SEC_EPSILON) {
        nearestStartSec = candidate
        nearestDiffSec = diffSec
      }
    }
    return {
      startSec: roundTrackTempoSec(Math.max(0, nearestStartSec)),
      boundaryCandidates: Array.from(
        new Set(
          boundaryCandidates
            .map((candidate) => roundTrackTempoSec(Math.max(0, Number(candidate) || 0)))
            .filter((candidate) => Number.isFinite(candidate))
        )
      )
    }
  }

  const buildTimingById = (inputTracks: MixtapeTrack[]) =>
    new Map(buildTrackTimingSnapshot(inputTracks).map((item) => [item.id, item]))

  const resolveRippleTrackIdSet = (snapshotTracks: MixtapeTrack[], trackId: string) => {
    const targetIndex = snapshotTracks.findIndex((item) => item.id === trackId)
    if (targetIndex < 0) return new Set<string>([trackId])
    return new Set(
      snapshotTracks
        .slice(targetIndex)
        .map((item) => item.id)
        .filter(Boolean)
    )
  }

  const subtractForbiddenDeltaInterval = (
    intervals: Array<{ min: number; max: number }>,
    forbiddenMin: number,
    forbiddenMax: number
  ) => {
    if (!Number.isFinite(forbiddenMin) || !Number.isFinite(forbiddenMax)) return intervals
    if (forbiddenMax <= forbiddenMin + BPM_POINT_SEC_EPSILON) return intervals
    const nextIntervals: Array<{ min: number; max: number }> = []
    for (const interval of intervals) {
      if (forbiddenMax <= interval.min || forbiddenMin >= interval.max) {
        nextIntervals.push(interval)
        continue
      }
      const leftMax = Math.min(interval.max, forbiddenMin)
      if (leftMax > interval.min + BPM_POINT_SEC_EPSILON) {
        nextIntervals.push({ min: interval.min, max: leftMax })
      }
      const rightMin = Math.max(interval.min, forbiddenMax)
      if (interval.max > rightMin + BPM_POINT_SEC_EPSILON) {
        nextIntervals.push({ min: rightMin, max: interval.max })
      }
    }
    return nextIntervals
  }

  const resolveRippleDeltaSec = (payload: {
    trackId: string
    targetLaneIndex: number
    requestedDeltaSec: number
    rippleTrackIds: Set<string>
    snapshotTracks: MixtapeTrack[]
  }) => {
    const snapshotTimings = buildTrackTimingSnapshot(payload.snapshotTracks)
    const movingItems = snapshotTimings
      .filter((item) => payload.rippleTrackIds.has(item.id))
      .map((item) => ({
        ...item,
        laneIndex: item.id === payload.trackId ? payload.targetLaneIndex : item.laneIndex
      }))
    if (!movingItems.length) return 0
    const fixedItems = snapshotTimings.filter((item) => !payload.rippleTrackIds.has(item.id))
    const minDeltaSec = movingItems.reduce(
      (minDelta, item) => Math.max(minDelta, -Math.max(0, Number(item.startSec) || 0)),
      Number.NEGATIVE_INFINITY
    )
    let intervals = [{ min: Math.max(0, minDeltaSec), max: Number.POSITIVE_INFINITY }]
    if (minDeltaSec < 0) {
      intervals = [{ min: minDeltaSec, max: Number.POSITIVE_INFINITY }]
    }
    for (const movingItem of movingItems) {
      for (const fixedItem of fixedItems) {
        if (movingItem.laneIndex !== fixedItem.laneIndex) continue
        const forbiddenMin = fixedItem.startSec - movingItem.endSec + BPM_POINT_SEC_EPSILON
        const forbiddenMax = fixedItem.endSec - movingItem.startSec - BPM_POINT_SEC_EPSILON
        intervals = subtractForbiddenDeltaInterval(intervals, forbiddenMin, forbiddenMax)
        if (!intervals.length) return 0
      }
    }
    const requestedDeltaSec = Number(payload.requestedDeltaSec) || 0
    let nearestDeltaSec = intervals[0]
      ? clampNumber(requestedDeltaSec, intervals[0].min, intervals[0].max)
      : 0
    let nearestDiffSec = Math.abs(nearestDeltaSec - requestedDeltaSec)
    for (let index = 1; index < intervals.length; index += 1) {
      const interval = intervals[index]
      const candidate = clampNumber(requestedDeltaSec, interval.min, interval.max)
      const diffSec = Math.abs(candidate - requestedDeltaSec)
      if (diffSec < nearestDiffSec - BPM_POINT_SEC_EPSILON) {
        nearestDeltaSec = candidate
        nearestDiffSec = diffSec
      }
    }
    return roundTrackTempoSec(nearestDeltaSec)
  }

  const resolveVisibleGridSnapStepBeats = () =>
    Number(normalizedRenderZoom.value) >= GRID_BEAT_LINE_ZOOM
      ? 1
      : Number(normalizedRenderZoom.value) >= GRID_DOWNBEAT_LINE_ZOOM
        ? 4
        : 4

  const buildGlobalTimelineGridSecs = (
    snapshotTracks: MixtapeTrack[],
    options?: { minSec?: number; maxSec?: number; fullDetail?: boolean; downbeatsOnly?: boolean }
  ) => {
    if (!isMixtapeGlobalTempoReady()) return [] as number[]
    const fallbackBpm =
      Number(mixtapeGlobalTempoEnvelope.value[0]?.bpm) ||
      snapshotTracks.find((track) => Number(track.bpm) > 0)?.bpm ||
      128
    const grid = createMixtapeMasterGrid({
      points: mixtapeGlobalTempoEnvelope.value,
      phaseOffsetSec: mixtapeGlobalTempoPhaseOffsetSec.value,
      fallbackBpm
    })
    const timelineEndSec = buildTrackTimingSnapshot(snapshotTracks).reduce(
      (maxSec, item) => Math.max(maxSec, Number(item.endSec) || 0),
      0
    )
    const maxSec =
      Number.isFinite(Number(options?.maxSec)) && Number(options?.maxSec) > 0
        ? Number(options?.maxSec)
        : timelineEndSec
    const beatBufferSec = (32 * 60) / Math.max(1, fallbackBpm)
    return grid
      .buildVisibleGridLines(
        options?.fullDetail ? Number.POSITIVE_INFINITY : Number(normalizedRenderZoom.value) || 0,
        {
          minSec: Math.max(0, (Number(options?.minSec) || 0) - beatBufferSec),
          maxSec: Math.max(0, maxSec + beatBufferSec)
        }
      )
      .filter((line) => options?.downbeatsOnly !== true || line.level === 'downbeat')
      .map((line) => Number(line.sec.toFixed(4)))
  }

  const buildTrackVisibleLocalGridSecs = (
    track: MixtapeTrack,
    options?: { startSec?: number; fullDetail?: boolean; downbeatsOnly?: boolean }
  ) => {
    const projectedTrack =
      typeof options?.startSec === 'number' && Number.isFinite(options.startSec)
        ? ({ ...track, startSec: options.startSec } satisfies MixtapeTrack)
        : track
    const durationSec = resolveTrackDurationSeconds(projectedTrack)
    const sourceDurationSec = resolveTrackSourceDurationSeconds(projectedTrack)
    if (!Number.isFinite(durationSec) || durationSec <= 0) return [] as number[]
    if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) return [] as number[]
    const lines = buildTrackRuntimeTempoSnapshot({
      track: projectedTrack,
      sourceDurationSec,
      durationSec,
      zoom: options?.fullDetail ? Number.POSITIVE_INFINITY : Number(normalizedRenderZoom.value) || 0
    }).visibleGridLines
    return lines
      .filter((line) => options?.downbeatsOnly !== true || line.level === 'downbeat')
      .map((line) => Number(line.sec.toFixed(4)))
  }

  const resolveStrictVisibleGridSnappedStartSec = (payload: {
    track: MixtapeTrack
    rawStartSec: number
    minStartSec: number
    maxStartSec: number
    snapshotTracks: MixtapeTrack[]
  }) => {
    if (!isMixtapeGlobalTempoReady()) return null
    const intervalBeats = resolveVisibleGridSnapStepBeats()
    if (![1, 4].includes(intervalBeats)) return null
    const gridSourceBpm = resolveTrackGridSourceBpm(payload.track)
    const beatSourceSec = resolveBeatSecByBpm(gridSourceBpm)
    if (!Number.isFinite(beatSourceSec) || beatSourceSec <= BPM_POINT_SEC_EPSILON) return null
    const sourceDurationSec = Math.max(
      0,
      Number(resolveTrackSourceDurationSeconds(payload.track)) || 0
    )
    const dynamicSourceBeatMap = createDynamicSourceBeatMap(
      resolveMixtapeAudioBeatGridMap(payload.track, sourceDurationSec),
      sourceDurationSec
    )
    const sourceDurationBeats = dynamicSourceBeatMap
      ? dynamicSourceBeatMap.beatSpan
      : sourceDurationSec / beatSourceSec
    const firstBeatSourceSec = resolveMixtapeAudioFirstBeatSec(payload.track)
    const firstBeatSourceBeats = dynamicSourceBeatMap
      ? dynamicSourceBeatMap.firstBeatDelta
      : firstBeatSourceSec / beatSourceSec
    const downbeatBeatOffset = normalizeBeatOffset(payload.track.downbeatBeatOffset, 4)
    let phaseOffsetBeats = firstBeatSourceBeats
    let hasVisibleFamily = true
    if (intervalBeats === 4) {
      phaseOffsetBeats =
        dynamicSourceBeatMap?.firstDownbeatBeatDelta ?? firstBeatSourceBeats + downbeatBeatOffset
      hasVisibleFamily = dynamicSourceBeatMap
        ? dynamicSourceBeatMap.firstDownbeatBeatDelta !== null &&
          phaseOffsetBeats <= sourceDurationBeats + BPM_POINT_SEC_EPSILON
        : phaseOffsetBeats <= sourceDurationBeats + BPM_POINT_SEC_EPSILON
    }
    if (!hasVisibleFamily) return null
    const fallbackBpm =
      Number(mixtapeGlobalTempoEnvelope.value[0]?.bpm) ||
      payload.snapshotTracks.find((track) => Number(track.bpm) > 0)?.bpm ||
      128
    const masterGrid = createMixtapeMasterGrid({
      points: mixtapeGlobalTempoEnvelope.value,
      phaseOffsetSec: mixtapeGlobalTempoPhaseOffsetSec.value,
      fallbackBpm
    })
    const rawStartSec = Math.max(0, Number(payload.rawStartSec) || 0)
    const minStartSec = Math.max(0, Number(payload.minStartSec) || 0)
    const maxStartSec = Number.isFinite(Number(payload.maxStartSec))
      ? Math.max(minStartSec, Number(payload.maxStartSec))
      : Number.POSITIVE_INFINITY
    const rawStartBeat = masterGrid.mapSecToBeats(rawStartSec)
    const minStartBeat = masterGrid.mapSecToBeats(minStartSec)
    const maxStartBeat = Number.isFinite(maxStartSec)
      ? masterGrid.mapSecToBeats(maxStartSec)
      : Number.POSITIVE_INFINITY
    const minFamilyIndex = Math.ceil(
      (minStartBeat + phaseOffsetBeats - BPM_POINT_SEC_EPSILON) / intervalBeats
    )
    const maxFamilyIndex = Number.isFinite(maxStartBeat)
      ? Math.floor((maxStartBeat + phaseOffsetBeats + BPM_POINT_SEC_EPSILON) / intervalBeats)
      : Number.POSITIVE_INFINITY
    if (minFamilyIndex > maxFamilyIndex) return null
    const approxFamilyIndex = Math.round((rawStartBeat + phaseOffsetBeats) / intervalBeats)
    const boundedFamilyIndex = Number.isFinite(maxFamilyIndex)
      ? clampNumber(approxFamilyIndex, minFamilyIndex, maxFamilyIndex)
      : Math.max(minFamilyIndex, approxFamilyIndex)
    const familyCandidates = new Set<number>([boundedFamilyIndex])
    if (boundedFamilyIndex - 1 >= minFamilyIndex) familyCandidates.add(boundedFamilyIndex - 1)
    if (!Number.isFinite(maxFamilyIndex) || boundedFamilyIndex + 1 <= maxFamilyIndex) {
      familyCandidates.add(boundedFamilyIndex + 1)
    }
    if (Number.isFinite(maxFamilyIndex)) {
      familyCandidates.add(minFamilyIndex)
      familyCandidates.add(maxFamilyIndex)
    }
    let bestStartSec: number | null = null
    let bestDiffSec = Number.POSITIVE_INFINITY
    for (const familyIndex of familyCandidates) {
      if (familyIndex < minFamilyIndex) continue
      if (Number.isFinite(maxFamilyIndex) && familyIndex > maxFamilyIndex) continue
      const startBeat = familyIndex * intervalBeats - phaseOffsetBeats
      if (!Number.isFinite(startBeat)) continue
      const candidateStartSec = roundTrackTempoSec(masterGrid.mapBeatsToSec(startBeat))
      if (candidateStartSec < minStartSec - BPM_POINT_SEC_EPSILON) continue
      if (Number.isFinite(maxStartSec) && candidateStartSec > maxStartSec + BPM_POINT_SEC_EPSILON) {
        continue
      }
      const diffSec = Math.abs(candidateStartSec - rawStartSec)
      if (diffSec < bestDiffSec - BPM_POINT_SEC_EPSILON) {
        bestStartSec = candidateStartSec
        bestDiffSec = diffSec
      }
    }
    return bestStartSec
  }

  const resolveSnappedStartSecByProjectedGrid = (payload: {
    track: MixtapeTrack
    rawStartSec: number
    minStartSec: number
    maxStartSec: number
    targetTimelineGridSecs: number[]
    downbeatsOnly: boolean
    boundaryCandidates?: number[]
  }) => {
    let candidateStartSec = clampNumber(
      Number(payload.rawStartSec) || 0,
      payload.minStartSec,
      payload.maxStartSec
    )
    let currentLocalGridSecs = buildTrackVisibleLocalGridSecs(payload.track, {
      startSec: candidateStartSec,
      fullDetail: payload.downbeatsOnly,
      downbeatsOnly: payload.downbeatsOnly
    })
    let snappedStartSec = resolveSnappedStartSecByVisibleGrid({
      rawStartSec: candidateStartSec,
      minStartSec: payload.minStartSec,
      maxStartSec: payload.maxStartSec,
      currentLocalGridSecs,
      targetTimelineGridSecs: payload.targetTimelineGridSecs,
      boundaryCandidates: payload.boundaryCandidates
    })
    for (let iteration = 0; iteration < 3; iteration += 1) {
      if (typeof snappedStartSec !== 'number') break
      const stabilizedStartSec = clampNumber(
        snappedStartSec,
        payload.minStartSec,
        payload.maxStartSec
      )
      if (Math.abs(stabilizedStartSec - candidateStartSec) <= 0.0001) {
        candidateStartSec = stabilizedStartSec
        currentLocalGridSecs = buildTrackVisibleLocalGridSecs(payload.track, {
          startSec: candidateStartSec,
          fullDetail: payload.downbeatsOnly,
          downbeatsOnly: payload.downbeatsOnly
        })
        snappedStartSec = stabilizedStartSec
        break
      }
      candidateStartSec = stabilizedStartSec
      currentLocalGridSecs = buildTrackVisibleLocalGridSecs(payload.track, {
        startSec: candidateStartSec,
        fullDetail: payload.downbeatsOnly,
        downbeatsOnly: payload.downbeatsOnly
      })
      snappedStartSec = resolveSnappedStartSecByVisibleGrid({
        rawStartSec: candidateStartSec,
        minStartSec: payload.minStartSec,
        maxStartSec: payload.maxStartSec,
        currentLocalGridSecs,
        targetTimelineGridSecs: payload.targetTimelineGridSecs,
        boundaryCandidates: payload.boundaryCandidates
      })
    }
    return {
      snappedStartSec: typeof snappedStartSec === 'number' ? snappedStartSec : null,
      currentLocalGridSecs,
      candidateStartSec
    }
  }

  const resolveSnappedStartSec = (payload: {
    rawStartSec: number
    minStartSec: number
    maxStartSec: number
    snapAnchorSec: number
    currentAnchorRawSec: number
    stepSec: number
    boundaryCandidates?: number[]
  }) => {
    const stepSec = Number(payload.stepSec)
    if (!Number.isFinite(stepSec) || stepSec <= 0) return null
    const rawStartSec = Math.max(0, Number(payload.rawStartSec) || 0)
    const minStartSec = Math.max(0, Number(payload.minStartSec) || 0)
    const maxStartSec = Number.isFinite(Number(payload.maxStartSec))
      ? Math.max(minStartSec, Number(payload.maxStartSec))
      : Number.POSITIVE_INFINITY
    const snapAnchorSec = Number(payload.snapAnchorSec)
    const currentAnchorRawSec = Number(payload.currentAnchorRawSec)
    if (!Number.isFinite(snapAnchorSec) || !Number.isFinite(currentAnchorRawSec)) return null

    const startOffsetSec = rawStartSec - currentAnchorRawSec
    const rawIndex = (currentAnchorRawSec - snapAnchorSec) / stepSec
    if (!Number.isFinite(rawIndex)) return null

    let nearestIndex = Math.round(rawIndex)
    const minIndex = Math.ceil((minStartSec - startOffsetSec - snapAnchorSec) / stepSec)
    const maxIndex = Number.isFinite(maxStartSec)
      ? Math.floor((maxStartSec - startOffsetSec - snapAnchorSec) / stepSec)
      : Number.POSITIVE_INFINITY
    if (minIndex > maxIndex) return null
    nearestIndex = Math.max(minIndex, Math.min(maxIndex, nearestIndex))

    const snappedStartSec = startOffsetSec + snapAnchorSec + nearestIndex * stepSec
    if (!Number.isFinite(snappedStartSec)) return null
    const candidates = [
      clampNumber(snappedStartSec, minStartSec, maxStartSec),
      ...(Array.isArray(payload.boundaryCandidates)
        ? payload.boundaryCandidates
            .map((candidate) => Number(candidate))
            .filter((candidate) => Number.isFinite(candidate))
            .map((candidate) => clampNumber(candidate, minStartSec, maxStartSec))
        : [])
    ]
    let nearestSec = candidates[0]
    let nearestDiff = Math.abs(nearestSec - rawStartSec)
    for (let index = 1; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const diff = Math.abs(candidate - rawStartSec)
      if (diff < nearestDiff) {
        nearestSec = candidate
        nearestDiff = diff
      }
    }
    return nearestSec
  }

  const handleTrackDragMove = (event: MouseEvent) => {
    if (!trackDragState) return
    const targetIndex = tracks.value.findIndex(
      (item: MixtapeTrack) => item.id === trackDragState?.trackId
    )
    if (targetIndex < 0) return
    const currentTrackForSnap = tracks.value[targetIndex]
    if (!currentTrackForSnap) return
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const deltaSec = (event.clientX - trackDragState.startClientX) / pxPerSec
    const rawStartSec = Math.max(0, trackDragState.initialStartSec + deltaSec)
    const targetLaneIndex = resolvePointerLaneIndex(event.clientY)
    trackDragState.currentLaneIndex = targetLaneIndex
    const trackDurationSec = resolveTrackDurationSeconds(currentTrackForSnap)
    const rippleTrackIds = resolveRippleTrackIdSet(
      trackDragState.snapshotTracks,
      trackDragState.trackId
    )
    const rippleActive = event.shiftKey && rippleTrackIds.size > 1
    const initialPlacement = resolveLanePlacement({
      trackId: trackDragState.trackId,
      laneIndex: targetLaneIndex,
      rawStartSec,
      durationSec: trackDurationSec,
      inputTracks: trackDragState.snapshotTracks,
      excludeTrackIds: rippleActive ? rippleTrackIds : undefined
    })
    let nextStartSec = rawStartSec
    const snapStepBeats = resolveVisibleGridSnapStepBeats()
    if (isMixtapeGlobalTempoReady()) {
      const previousTimelineGridSecs = buildGlobalTimelineGridSecs(trackDragState.snapshotTracks, {
        minSec: 0,
        maxSec: rawStartSec + trackDurationSec,
        fullDetail: snapStepBeats === 4,
        downbeatsOnly: snapStepBeats === 4
      })
      const strictSnappedStartSec = resolveStrictVisibleGridSnappedStartSec({
        track: currentTrackForSnap,
        rawStartSec,
        minStartSec: 0,
        maxStartSec: Number.POSITIVE_INFINITY,
        snapshotTracks: trackDragState.snapshotTracks
      })
      const projectedSnap =
        typeof strictSnappedStartSec === 'number'
          ? {
              snappedStartSec: strictSnappedStartSec,
              currentLocalGridSecs: buildTrackVisibleLocalGridSecs(currentTrackForSnap, {
                startSec: strictSnappedStartSec,
                fullDetail: snapStepBeats === 4,
                downbeatsOnly: snapStepBeats === 4
              }),
              candidateStartSec: strictSnappedStartSec
            }
          : resolveSnappedStartSecByProjectedGrid({
              track: currentTrackForSnap,
              rawStartSec,
              minStartSec: 0,
              maxStartSec: Number.POSITIVE_INFINITY,
              targetTimelineGridSecs: previousTimelineGridSecs,
              downbeatsOnly: snapStepBeats === 4,
              boundaryCandidates: initialPlacement.boundaryCandidates
            })
      if (typeof projectedSnap.snappedStartSec === 'number') {
        nextStartSec = projectedSnap.snappedStartSec
      }
    }
    if (!isMixtapeGlobalTempoReady()) {
      const currentBpm = Number(currentTrackForSnap.bpm)
      if (Number.isFinite(currentBpm) && currentBpm > 0) {
        const beatSec = resolveBeatSecByBpm(currentBpm)
        const snapStepSec = beatSec * snapStepBeats
        const currentFirstBeatSec = resolveTrackFirstBeatSeconds(currentTrackForSnap, currentBpm)
        const currentAnchorRawSec = resolveGridAnchorSec({
          startSec: rawStartSec,
          firstBeatSec: currentFirstBeatSec,
          beatSec,
          downbeatBeatOffset: normalizeBeatOffset(currentTrackForSnap.downbeatBeatOffset, 4)
        })
        const snappedStartSec = resolveSnappedStartSec({
          rawStartSec,
          minStartSec: 0,
          maxStartSec: Number.POSITIVE_INFINITY,
          snapAnchorSec: 0,
          currentAnchorRawSec,
          stepSec: snapStepSec,
          boundaryCandidates: initialPlacement.boundaryCandidates
        })
        if (typeof snappedStartSec === 'number') {
          nextStartSec = snappedStartSec
        }
      }
    }
    const finalPlacement = resolveLanePlacement({
      trackId: trackDragState.trackId,
      laneIndex: targetLaneIndex,
      rawStartSec: nextStartSec,
      durationSec: trackDurationSec,
      inputTracks: trackDragState.snapshotTracks,
      excludeTrackIds: rippleActive ? rippleTrackIds : undefined
    })
    nextStartSec = finalPlacement.startSec

    const currentTrack = tracks.value[targetIndex]
    if (!currentTrack) return
    const snapshotTimingById = buildTimingById(trackDragState.snapshotTracks)
    const snapshotTrackById = new Map(
      trackDragState.snapshotTracks.map((track) => [track.id, track])
    )
    const targetSnapshotTiming = snapshotTimingById.get(trackDragState.trackId)
    const requestedRippleDeltaSec =
      nextStartSec - (targetSnapshotTiming?.startSec ?? trackDragState.initialStartSec)
    const rippleDeltaSec = rippleActive
      ? resolveRippleDeltaSec({
          trackId: trackDragState.trackId,
          targetLaneIndex,
          requestedDeltaSec: requestedRippleDeltaSec,
          rippleTrackIds,
          snapshotTracks: trackDragState.snapshotTracks
        })
      : 0
    const nextTracks = tracks.value.map((track, index) => {
      const snapshotTrack = snapshotTrackById.get(track.id)
      const snapshotTiming = snapshotTimingById.get(track.id)
      if (!snapshotTrack || !snapshotTiming) return track
      if (track.id === trackDragState?.trackId) {
        const targetStartSec = rippleActive
          ? roundTrackTempoSec(Math.max(0, snapshotTiming.startSec + rippleDeltaSec))
          : nextStartSec
        return {
          ...track,
          startSec: targetStartSec,
          laneIndex: targetLaneIndex
        }
      }
      if (!rippleTrackIds.has(track.id)) return track
      // Shift 带动只挪时间、不换轨。这里必须还原“存起来的”泳道号：
      // 用按可见泳道夹取的值会把收起状态下被折回显示的曲目永久压到前两轨。
      const restoredLaneIndex = resolveMixtapeStoredLaneIndex(snapshotTrack?.laneIndex, index)
      const restoredStartSec = roundTrackTempoSec(Math.max(0, snapshotTiming.startSec))
      if (!rippleActive) {
        return {
          ...track,
          startSec: restoredStartSec,
          laneIndex: restoredLaneIndex
        }
      }
      return {
        ...track,
        startSec: roundTrackTempoSec(Math.max(0, snapshotTiming.startSec + rippleDeltaSec)),
        laneIndex: restoredLaneIndex
      }
    })
    const anyTrackChanged = nextTracks.some((track, index) => {
      const previousTrack = tracks.value[index]
      if (!previousTrack || previousTrack.id !== track.id) return true
      const previousStartSec = normalizeStartSec(previousTrack.startSec) ?? 0
      const nextStartSecValue = normalizeStartSec(track.startSec) ?? 0
      const previousLaneIndex = resolveMixtapeStoredLaneIndex(previousTrack?.laneIndex, index)
      const nextLaneIndex = resolveMixtapeStoredLaneIndex(track.laneIndex, index)
      return (
        Math.abs(previousStartSec - nextStartSecValue) > 0.0001 ||
        previousLaneIndex !== nextLaneIndex
      )
    })
    if (!anyTrackChanged) return
    tracks.value = nextTracks
    event.preventDefault()
  }

  const handleTrackDragEnd = () => {
    if (!trackDragState) return
    const targetTrackId = trackDragState.trackId
    const currentTrack = findTrack(targetTrackId)
    const snapshotTracks = trackDragState.snapshotTracks
    isTrackDragging.value = false
    trackDragState = null
    window.removeEventListener('mousemove', handleTrackDragMove as EventListener)
    window.removeEventListener('mouseup', handleTrackDragEnd as EventListener)
    scheduleFullPreRender()
    scheduleWorkerPreRender()
    if (!currentTrack) return
    const previousTimingById = buildTimingById(snapshotTracks)
    const currentTimingById = buildTimingById(tracks.value)
    const previousTrackById = new Map(snapshotTracks.map((track) => [track.id, track]))
    const changedEntries = tracks.value
      .map((track, index) => {
        const previousTrack = previousTrackById.get(track.id)
        const previousTiming = previousTimingById.get(track.id)
        const currentTiming = currentTimingById.get(track.id)
        if (!previousTrack || !previousTiming || !currentTiming) return null
        // 比较“存起来的”泳道号：内存里的 laneIndex 若已被本次拖拽改写，
        // 必须同步落盘，否则界面和磁盘会各说一套（重开又跳回第 3/4 轨）。
        const previousLaneIndex = resolveMixtapeStoredLaneIndex(previousTrack?.laneIndex, index)
        const currentLaneIndex = resolveMixtapeStoredLaneIndex(track.laneIndex, index)
        const startChanged =
          Math.abs(Number(previousTiming.startSec) - Number(currentTiming.startSec)) > 0.0001
        const laneChanged = previousLaneIndex !== currentLaneIndex
        if (!startChanged && !laneChanged) return null
        return {
          itemId: track.id,
          startSec: Number(currentTiming.startSec),
          ...(laneChanged ? { laneIndex: currentLaneIndex } : {})
        }
      })
      .filter((entry): entry is { itemId: string; startSec: number; laneIndex?: number } => !!entry)
    if (!changedEntries.length) return
    void persistTrackStartSec(changedEntries)
  }

  const handleTrackDragStart = (item: TimelineTrackLayout, event: MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    stopTransportForTrackChange()
    const trackId = item?.track?.id || ''
    if (!trackId) return
    const track = findTrack(trackId)
    if (!track) return
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    trackDragState = {
      trackId,
      startClientX: event.clientX,
      initialStartSec: Number.isFinite(Number(item.startSec))
        ? Number(item.startSec)
        : resolveTimelineSecByX(item.startX, pxPerSec),
      initialLaneIndex: normalizeMixtapeLaneIndex(item.laneIndex),
      currentLaneIndex: normalizeMixtapeLaneIndex(item.laneIndex),
      laneRects: resolveDragLaneRects(event),
      snapshotTracks: tracks.value.map((trackItem: MixtapeTrack) => ({ ...trackItem }))
    }
    isTrackDragging.value = true
    window.addEventListener('mousemove', handleTrackDragMove, { passive: false })
    window.addEventListener('mouseup', handleTrackDragEnd, { passive: true })
  }

  const cleanupTrackDrag = () => {
    isTrackDragging.value = false
    trackDragState = null
    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', handleTrackDragMove as EventListener)
      window.removeEventListener('mouseup', handleTrackDragEnd as EventListener)
    }
  }

  return {
    isTrackDragging,
    handleTrackDragStart,
    cleanupTrackDrag
  }
}
