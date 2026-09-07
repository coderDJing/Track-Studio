import { computed, ref } from 'vue'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  MIXTAPE_STEM_SEGMENT_PARAMS,
  buildMixEnvelopePolylineByControlPoints,
  clampMixEnvelopeGain,
  mapMixEnvelopeGainToYPercent,
  mapMixEnvelopeYPercentToGain,
  normalizeMixEnvelopePoints,
  sampleMixEnvelopeAtSec,
  linearGainToDb
} from '@renderer/composables/mixtape/gainEnvelope'
import {
  GAIN_ENVELOPE_MAX_POINTS_PER_SEC,
  GAIN_ENVELOPE_MIN_GAP_RATIO,
  GAIN_ENVELOPE_SAME_SEC_EPSILON,
  MIX_PARAM_UNDO_STACK_LIMIT
} from '@renderer/composables/mixtape/gainEnvelopeEditorConstants'
import {
  clampNumber,
  resolveVolumeMutePointerSec,
  resolveVolumeMuteSegmentKey,
  resolveVolumeMuteSegmentMasks as resolveVolumeMuteSegmentMasksByUtils,
  resolveVolumeMuteSegmentsByToggle
} from '@renderer/composables/mixtape/gainEnvelopeEditorGrid'
import { buildStemEnvelopeBySegments } from '@renderer/composables/mixtape/gainEnvelopeStemSegments'
import { createGainEnvelopeTrackStateModule } from '@renderer/composables/mixtape/gainEnvelopeTrackState'
import { createGainEnvelopePersistModule } from '@renderer/composables/mixtape/gainEnvelopePersist'
import type {
  CreateMixtapeGainEnvelopeEditorParams,
  EnvelopeDragState,
  EnvelopePointDot,
  EnvelopeUndoSeed,
  MixSegmentMask,
  MixParamUndoEntry,
  SegmentSelectionState
} from '@renderer/composables/mixtape/gainEnvelopeEditorTypes'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
  MixtapeTrack,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'

export const createMixtapeGainEnvelopeEditor = (params: CreateMixtapeGainEnvelopeEditorParams) => {
  const stemSegmentParamSet = new Set<MixtapeEnvelopeParamId>(MIXTAPE_STEM_SEGMENT_PARAMS)
  const segmentModeParamSet = new Set<MixtapeEnvelopeParamId>([
    ...MIXTAPE_STEM_SEGMENT_PARAMS,
    'volume'
  ])
  const envelopeDragState = ref<EnvelopeDragState | null>(null)
  const segmentSelectionState = ref<SegmentSelectionState | null>(null)
  const ghostPointState = ref<{
    trackId: string
    sec: number
    gain: number
  } | null>(null)
  const undoStack = ref<MixParamUndoEntry[]>([])
  const canUndoMixParam = computed(() => undoStack.value.length > 0)
  const envelopeUndoSeed = ref<EnvelopeUndoSeed | null>(null)
  let isApplyingUndo = false

  const resolveCurrentParam = () => params.resolveActiveParam()
  const isStemSegmentParam = (param: MixtapeEnvelopeParamId) => stemSegmentParamSet.has(param)
  const isSegmentModeParam = (param: MixtapeEnvelopeParamId) => segmentModeParamSet.has(param)
  const resolveRenderZoom = () => Number(params.renderZoomLevel.value) || 0
  const trackStateModule = createGainEnvelopeTrackStateModule({
    tracks: params.tracks,
    resolveRenderZoom,
    resolveTrackDurationSeconds: params.resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds: params.resolveTrackSourceDurationSeconds,
    isStemSegmentParam
  })
  const {
    resolveVolumeMuteGrid,
    resolveGridAlignedVolumeMuteSegments,
    resolveVolumeMuteSegmentBySec,
    snapSecToVisibleGrid,
    resolveTrackEnvelopeState,
    resolveTrackVolumeMuteState,
    resolveTrackStemSegmentState
  } = trackStateModule

  const cloneGainPoints = (points: MixtapeGainPoint[]) =>
    points.map((point) => ({
      sec: Number(point.sec),
      gain: Number(point.gain)
    }))

  const cloneMuteSegments = (segments: MixtapeMuteSegment[]) =>
    segments.map((segment) => ({
      startSec: Number(segment.startSec),
      endSec: Number(segment.endSec)
    }))

  const pushUndoEntry = (entry: MixParamUndoEntry) => {
    if (isApplyingUndo) return
    undoStack.value.push(entry)
    if (undoStack.value.length > MIX_PARAM_UNDO_STACK_LIMIT) {
      undoStack.value.splice(0, undoStack.value.length - MIX_PARAM_UNDO_STACK_LIMIT)
    }
  }

  const pushExternalUndoStep = (undo: (() => boolean) | null | undefined) => {
    if (typeof undo !== 'function') return
    pushUndoEntry({
      type: 'external',
      undo
    })
  }

  const beginEnvelopeUndoSeed = (param: MixtapeEnvelopeParamId, trackId: string) => {
    if (isApplyingUndo || envelopeUndoSeed.value) return
    const { track, points } = resolveTrackEnvelopeState(trackId, param)
    if (!track || points.length < 2) return
    envelopeUndoSeed.value = {
      trackId: track.id,
      param,
      points: cloneGainPoints(points)
    }
  }

  const commitEnvelopeUndoSeed = () => {
    const seed = envelopeUndoSeed.value
    envelopeUndoSeed.value = null
    if (!seed || isApplyingUndo) return
    const { track, points } = resolveTrackEnvelopeState(seed.trackId, seed.param)
    if (!track || points.length < 2) return
    if (JSON.stringify(seed.points) === JSON.stringify(points)) return
    pushUndoEntry({
      type: 'envelope',
      trackId: seed.trackId,
      param: seed.param,
      points: cloneGainPoints(seed.points)
    })
  }

  const pushSegmentUndoEntry = (
    trackId: string,
    param: MixtapeEnvelopeParamId,
    baseSegments: MixtapeMuteSegment[]
  ) => {
    if (isApplyingUndo) return
    const segmentState =
      param === 'volume'
        ? resolveTrackVolumeMuteState(trackId)
        : resolveTrackStemSegmentState(trackId, param)
    const { track, segments } = segmentState
    if (!track) return
    const normalizedBase = cloneMuteSegments(baseSegments)
    if (JSON.stringify(normalizedBase) === JSON.stringify(segments)) return
    pushUndoEntry({
      type: 'segment',
      trackId: track.id,
      param,
      segments: normalizedBase
    })
  }

  const resolveActiveEnvelopePolyline = (item: TimelineTrackLayout) => {
    const param = resolveCurrentParam()
    if (!param) return ''
    const { track, durationSec, points } = resolveTrackEnvelopeState(item.track.id, param)
    if (!track || !durationSec || points.length < 2) return ''
    return buildMixEnvelopePolylineByControlPoints({
      param,
      points,
      durationSec
    })
  }

  const resolveActiveEnvelopePointDots = (item: TimelineTrackLayout): EnvelopePointDot[] => {
    const param = resolveCurrentParam()
    if (!param) return []
    if (isStemSegmentParam(param)) return []
    const { durationSec, points } = resolveTrackEnvelopeState(item.track.id, param)
    if (!durationSec || points.length < 2) return []

    const dragState = envelopeDragState.value
    const isDraggingTrack = dragState?.trackId === item.track.id

    return points.map((point, index) => {
      const db = linearGainToDb(point.gain)
      const isDragging = isDraggingTrack && dragState.pointIndices.includes(index)

      return {
        index,
        x: Number((clampNumber(point.sec / durationSec, 0, 1) * 100).toFixed(3)),
        y: Number(mapMixEnvelopeGainToYPercent(param, point.gain).toFixed(3)),
        gainDb: db,
        isActive: isDragging,
        isBoundary: index === 0 || index === points.length - 1
      }
    })
  }

  const resolveActiveSegmentMasks = (item: TimelineTrackLayout): MixSegmentMask[] => {
    const param = resolveCurrentParam()
    if (!param || !isSegmentModeParam(param)) return []
    const { durationSec, segments } =
      param === 'volume'
        ? resolveTrackVolumeMuteState(item.track.id)
        : resolveTrackStemSegmentState(item.track.id, param)
    return resolveVolumeMuteSegmentMasksByUtils(durationSec, segments)
  }

  const {
    scheduleMixEnvelopePersist,
    flushPendingMixEnvelopePersist,
    scheduleVolumeMuteSegmentsPersist,
    flushPendingVolumeMutePersist
  } = createGainEnvelopePersistModule()

  const updateTrackVolumeMuteSegments = (
    trackId: string,
    nextSegments: MixtapeMuteSegment[],
    options?: {
      persist?: boolean
      forcePersist?: boolean
    }
  ) => {
    const { track, durationSec, segments: currentSegments } = resolveTrackVolumeMuteState(trackId)
    if (!track || !durationSec) return
    const normalized = resolveGridAlignedVolumeMuteSegments(track, durationSec, nextSegments)
    const shouldPersist = options?.persist !== false
    const forcePersist = options?.forcePersist === true
    const currentSignature = JSON.stringify(currentSegments)
    const nextSignature = JSON.stringify(normalized)
    if (currentSignature !== nextSignature) {
      params.tracks.value = params.tracks.value.map((item) =>
        item.id === track.id
          ? ({
              ...item,
              volumeMuteSegments: normalized
            } as MixtapeTrack)
          : item
      )
    } else if (!forcePersist) {
      return
    }
    if (shouldPersist) {
      scheduleVolumeMuteSegmentsPersist(track.id, normalized)
    }
  }

  const updateTrackStemSegmentEnvelope = (
    param: MixtapeEnvelopeParamId,
    trackId: string,
    nextSegments: MixtapeMuteSegment[]
  ) => {
    if (!isStemSegmentParam(param)) return
    const {
      track,
      durationSec,
      segments: currentSegments
    } = resolveTrackStemSegmentState(trackId, param)
    if (!track || !durationSec) return
    const normalizedSegments = resolveGridAlignedVolumeMuteSegments(
      track,
      durationSec,
      nextSegments
    )
    const currentSignature = JSON.stringify(currentSegments)
    const nextSignature = JSON.stringify(normalizedSegments)
    if (currentSignature === nextSignature) return
    const nextEnvelope = buildStemEnvelopeBySegments(param, durationSec, normalizedSegments)
    updateTrackMixEnvelope(param, track.id, nextEnvelope)
  }

  const updateTrackMixEnvelope = (
    param: MixtapeEnvelopeParamId,
    trackId: string,
    nextPoints: MixtapeGainPoint[]
  ) => {
    const { track, durationSec, points: currentPoints } = resolveTrackEnvelopeState(trackId, param)
    if (!track || !durationSec) return
    const normalized = normalizeMixEnvelopePoints(param, nextPoints, durationSec)
    if (normalized.length < 2) return
    const currentSignature = JSON.stringify(currentPoints)
    const nextSignature = JSON.stringify(normalized)
    if (currentSignature !== nextSignature) {
      const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
      params.tracks.value = params.tracks.value.map((item) =>
        item.id === track.id
          ? ({
              ...item,
              [envelopeField]: normalized
            } as MixtapeTrack)
          : item
      )
    }
    scheduleMixEnvelopePersist(param, track.id, normalized)
  }

  const resolveEnvelopePointer = (
    param: MixtapeEnvelopeParamId,
    stageEl: HTMLElement,
    event: MouseEvent,
    durationSec: number
  ) => {
    const rect = stageEl.getBoundingClientRect()
    if (!rect.width || !rect.height || !durationSec) return null
    const xRatio = clampNumber((event.clientX - rect.left) / rect.width, 0, 1)
    const yRatio = clampNumber((event.clientY - rect.top) / rect.height, 0, 1)
    return {
      sec: Number((xRatio * durationSec).toFixed(4)),
      gain: Number(mapMixEnvelopeYPercentToGain(param, yRatio * 100).toFixed(6))
    }
  }

  const resolveEnvelopeMinGapSec = (durationSec: number) =>
    Math.max(0.01, durationSec * GAIN_ENVELOPE_MIN_GAP_RATIO)

  function stopEnvelopePointDrag() {
    envelopeDragState.value = null
    window.removeEventListener('mousemove', handleEnvelopePointDragMove)
    window.removeEventListener('mouseup', handleEnvelopePointDragEnd)
  }

  function stopSegmentSelection() {
    segmentSelectionState.value = null
    window.removeEventListener('mousemove', handleSegmentSelectionMove)
    window.removeEventListener('mouseup', handleSegmentSelectionEnd)
  }

  const resolveTrackSegmentState = (trackId: string, param: MixtapeEnvelopeParamId) =>
    param === 'volume'
      ? resolveTrackVolumeMuteState(trackId)
      : resolveTrackStemSegmentState(trackId, param)

  const updateTrackSegmentByParam = (
    param: MixtapeEnvelopeParamId,
    trackId: string,
    nextSegments: MixtapeMuteSegment[],
    options?: {
      persist?: boolean
      forcePersist?: boolean
    }
  ) => {
    if (param === 'volume') {
      updateTrackVolumeMuteSegments(trackId, nextSegments, options)
      return
    }
    updateTrackStemSegmentEnvelope(param, trackId, nextSegments)
  }

  function applySegmentSelectionToggle(state: SegmentSelectionState) {
    if (!state.touched.size) return
    const { track } = resolveTrackSegmentState(state.trackId, state.param)
    if (!track) return
    const nextSegments = resolveVolumeMuteSegmentsByToggle(state.baseSegments, state.touched)
    updateTrackSegmentByParam(state.param, track.id, nextSegments, {
      forcePersist: true
    })
  }

  function handleSegmentSelectionMove(event: MouseEvent) {
    const state = segmentSelectionState.value
    if (!state) return
    event.preventDefault()
    const { track, durationSec } = resolveTrackSegmentState(state.trackId, state.param)
    if (!track || !durationSec) return
    const grid = resolveVolumeMuteGrid(track, durationSec)
    if (!grid) return
    const pointerSec = resolveVolumeMutePointerSec(state.stageEl, event, durationSec)
    if (typeof pointerSec !== 'number') return
    const previousSegment = resolveVolumeMuteSegmentBySec({
      track,
      durationSec,
      sec: state.lastSec
    })
    const currentSegment = resolveVolumeMuteSegmentBySec({
      track,
      durationSec,
      sec: pointerSec
    })
    if (!currentSegment) return
    if (!previousSegment) {
      state.touched.set(resolveVolumeMuteSegmentKey(currentSegment), currentSegment)
      const nextSegments = resolveVolumeMuteSegmentsByToggle(state.baseSegments, state.touched)
      updateTrackSegmentByParam(state.param, track.id, nextSegments, {
        persist: false
      })
      state.lastSec = pointerSec
      return
    }
    const fromIndex = grid.segments.findIndex(
      (segment: MixtapeMuteSegment) =>
        resolveVolumeMuteSegmentKey(segment) === resolveVolumeMuteSegmentKey(previousSegment)
    )
    const toIndex = grid.segments.findIndex(
      (segment: MixtapeMuteSegment) =>
        resolveVolumeMuteSegmentKey(segment) === resolveVolumeMuteSegmentKey(currentSegment)
    )
    if (fromIndex < 0 || toIndex < 0) return
    const minIndex = Math.min(fromIndex, toIndex)
    const maxIndex = Math.max(fromIndex, toIndex)
    for (let index = minIndex; index <= maxIndex; index += 1) {
      const segment = grid.segments[index]
      if (!segment) continue
      state.touched.set(resolveVolumeMuteSegmentKey(segment), segment)
    }
    const nextSegments = resolveVolumeMuteSegmentsByToggle(state.baseSegments, state.touched)
    updateTrackSegmentByParam(state.param, track.id, nextSegments, {
      persist: false
    })
    state.lastSec = pointerSec
  }

  function handleSegmentSelectionEnd() {
    const state = segmentSelectionState.value
    if (!state) return
    const baseSegments = cloneMuteSegments(state.baseSegments)
    stopSegmentSelection()
    applySegmentSelectionToggle(state)
    pushSegmentUndoEntry(state.trackId, state.param, baseSegments)
    if (state.param === 'volume') {
      void flushPendingVolumeMutePersist()
    } else {
      void flushPendingMixEnvelopePersist()
    }
  }

  function startSegmentSelection(
    param: MixtapeEnvelopeParamId,
    trackId: string,
    stageEl: HTMLElement,
    seed: MixtapeMuteSegment
  ) {
    stopSegmentSelection()
    const { track, segments } = resolveTrackSegmentState(trackId, param)
    if (!track) return
    const touched = new Map<string, MixtapeMuteSegment>()
    touched.set(resolveVolumeMuteSegmentKey(seed), seed)
    const nextSegments = resolveVolumeMuteSegmentsByToggle(segments, touched)
    updateTrackSegmentByParam(param, track.id, nextSegments, {
      persist: false
    })
    segmentSelectionState.value = {
      param,
      trackId,
      stageEl,
      baseSegments: segments.map((segment) => ({ ...segment })),
      touched,
      lastSec: Number(((seed.startSec + seed.endSec) / 2).toFixed(4))
    }
    window.addEventListener('mousemove', handleSegmentSelectionMove)
    window.addEventListener('mouseup', handleSegmentSelectionEnd)
  }

  function handleEnvelopePointDragMove(event: MouseEvent) {
    const state = envelopeDragState.value
    if (!state || !state.pointIndices.length) return
    event.preventDefault()
    const { track, durationSec, points } = resolveTrackEnvelopeState(state.trackId, state.param)
    if (!track || !durationSec || points.length < 2) return
    const pointer = resolveEnvelopePointer(state.param, state.stageEl, event, durationSec)
    if (!pointer) return

    const isFineTune = event.shiftKey

    if (state.pointIndices.length === 1) {
      const pointIndex = state.pointIndices[0]
      if (pointIndex < 0 || pointIndex >= points.length) return

      let nextSec = pointer.sec
      if (pointIndex === 0) {
        nextSec = 0
      } else if (pointIndex === points.length - 1) {
        nextSec = durationSec
      } else {
        const currentSec = points[pointIndex]?.sec ?? pointer.sec
        nextSec = currentSec
      }

      let nextGain = pointer.gain
      if (isFineTune && state.startPointer && state.basePoints) {
        const deltaGain = pointer.gain - state.startPointer.gain
        nextGain = state.basePoints[pointIndex].gain + deltaGain * 0.1
      }

      let finalGain = clampMixEnvelopeGain(state.param, nextGain)

      const centerGain = mapMixEnvelopeYPercentToGain(state.param, 50)
      const yPercent = mapMixEnvelopeGainToYPercent(state.param, finalGain)
      if (Math.abs(yPercent - 50) < 2) {
        finalGain = centerGain
      }

      const nextPoints = points.map((point, index) =>
        index === pointIndex
          ? {
              sec: Number(nextSec.toFixed(4)),
              gain: Number(finalGain.toFixed(6))
            }
          : point
      )
      updateTrackMixEnvelope(state.param, track.id, nextPoints)
    } else {
      if (!state.startPointer || !state.basePoints) return
      let deltaGain = pointer.gain - state.startPointer.gain
      if (isFineTune) {
        deltaGain *= 0.1
      }

      const nextPoints = points.map((point, index) => {
        if (state.pointIndices.includes(index)) {
          let rawGain = state.basePoints![index].gain + deltaGain
          let yPercent = mapMixEnvelopeGainToYPercent(state.param, rawGain)
          if (Math.abs(yPercent - 50) < 2) {
            rawGain = mapMixEnvelopeYPercentToGain(state.param, 50)
          }
          return {
            sec: point.sec,
            gain: Number(clampMixEnvelopeGain(state.param, rawGain).toFixed(6))
          }
        }
        return point
      })
      updateTrackMixEnvelope(state.param, track.id, nextPoints)
    }
  }

  function handleEnvelopePointDragEnd() {
    if (!envelopeDragState.value) return
    stopEnvelopePointDrag()
    commitEnvelopeUndoSeed()
    void flushPendingMixEnvelopePersist()
  }

  function startEnvelopePointDrag(
    param: MixtapeEnvelopeParamId,
    trackId: string,
    pointIndices: number[],
    stageEl: HTMLElement,
    startPointer?: { sec: number; gain: number },
    basePoints?: MixtapeGainPoint[]
  ) {
    beginEnvelopeUndoSeed(param, trackId)
    stopEnvelopePointDrag()
    envelopeDragState.value = {
      param,
      trackId,
      pointIndices,
      stageEl,
      startPointer,
      basePoints
    }
    window.addEventListener('mousemove', handleEnvelopePointDragMove)
    window.addEventListener('mouseup', handleEnvelopePointDragEnd)
  }

  const handleEnvelopePointMouseDown = (
    item: TimelineTrackLayout,
    pointIndex: number,
    event: MouseEvent
  ) => {
    const param = resolveCurrentParam()
    if (!params.isEditable() || !param || event.button !== 0) return
    if (isStemSegmentParam(param)) return
    if (param === 'volume' && params.isSegmentSelectionMode()) return
    const currentTarget = event.currentTarget as HTMLElement | null
    const stageEl = currentTarget?.closest('.lane-track__envelope-points') as HTMLElement | null
    if (!stageEl) return

    const { durationSec, points } = resolveTrackEnvelopeState(item.track.id, param)
    const pointer = resolveEnvelopePointer(param, stageEl, event, durationSec) || undefined
    startEnvelopePointDrag(
      param,
      item.track.id,
      [pointIndex],
      stageEl,
      pointer,
      cloneGainPoints(points)
    )
  }

  const handleEnvelopeSegmentMouseDown = (item: TimelineTrackLayout, event: MouseEvent) => {
    const param = resolveCurrentParam()
    if (!params.isEditable() || !param || event.button !== 0) return
    if (isStemSegmentParam(param) || (param === 'volume' && params.isSegmentSelectionMode())) return

    if (event.detail >= 2 || event.altKey) {
      handleEnvelopeStageMouseDown(item, event)
      return
    }

    const stageEl = (event.currentTarget as HTMLElement)
      ?.closest('.lane-track')
      ?.querySelector('.lane-track__envelope-points') as HTMLElement | null
    if (!stageEl) return

    const { track, durationSec, points } = resolveTrackEnvelopeState(item.track.id, param)
    if (!track || !durationSec || points.length < 2) return
    const pointer = resolveEnvelopePointer(param, stageEl, event, durationSec)
    if (!pointer) return

    let leftIndex = -1
    let rightIndex = -1
    for (let i = 0; i < points.length - 1; i++) {
      if (pointer.sec >= points[i].sec && pointer.sec <= points[i + 1].sec) {
        leftIndex = i
        rightIndex = i + 1
        break
      }
    }
    if (leftIndex < 0 || rightIndex < 0) return

    startEnvelopePointDrag(
      param,
      item.track.id,
      [leftIndex, rightIndex],
      stageEl,
      pointer,
      cloneGainPoints(points)
    )
  }

  const handleEnvelopeStageMouseDown = (
    item: TimelineTrackLayout,
    event: MouseEvent,
    overrideStageEl?: HTMLElement
  ) => {
    const param = resolveCurrentParam()
    if (!params.isEditable() || !param || event.button !== 0) return
    let stageEl = overrideStageEl || (event.currentTarget as HTMLElement | null)
    if (stageEl && !stageEl.classList.contains('lane-track__envelope-points')) {
      stageEl = stageEl
        .closest('.lane-track')
        ?.querySelector('.lane-track__envelope-points') as HTMLElement | null
    }
    if (!stageEl) return
    if (isSegmentModeParam(param) && params.isSegmentSelectionMode()) {
      const { track, durationSec } = resolveTrackSegmentState(item.track.id, param)
      if (!track || !durationSec) return
      const pointerSec = resolveVolumeMutePointerSec(stageEl, event, durationSec)
      if (typeof pointerSec !== 'number') return
      const segment = resolveVolumeMuteSegmentBySec({
        track,
        durationSec,
        sec: pointerSec
      })
      if (!segment) return
      startSegmentSelection(param, track.id, stageEl, segment)
      return
    }
    if (isStemSegmentParam(param)) return

    if (event.detail < 2 && !event.altKey) return

    beginEnvelopeUndoSeed(param, item.track.id)
    const { track, durationSec, points } = resolveTrackEnvelopeState(item.track.id, param)
    if (!track || !durationSec || points.length < 2) return
    const pointer = resolveEnvelopePointer(param, stageEl, event, durationSec)
    if (!pointer) return

    const minGapSec = resolveEnvelopeMinGapSec(durationSec)
    const safeSec = snapSecToVisibleGrid({
      track,
      sec: pointer.sec,
      durationSec
    })
    if (typeof safeSec !== 'number') return

    const lineGain = sampleMixEnvelopeAtSec(param, points, safeSec, pointer.gain)
    const safeGain = clampMixEnvelopeGain(param, lineGain)
    const safeSecRounded = Number(safeSec.toFixed(4))
    const safeGainRounded = Number(safeGain.toFixed(6))
    const nextPoints = points.map((point) => ({ ...point }))
    let targetPointIndex = 0
    const instantJumpMode = event.shiftKey
    const resolveSameSecBucket = (insertIndexInput: number) => {
      let insertIndex = insertIndexInput
      if (insertIndex < 0) insertIndex = nextPoints.length
      let sameSecStart = insertIndex - 1
      while (
        sameSecStart >= 0 &&
        Math.abs(nextPoints[sameSecStart].sec - safeSecRounded) <= GAIN_ENVELOPE_SAME_SEC_EPSILON
      ) {
        sameSecStart -= 1
      }
      sameSecStart += 1
      let sameSecEnd = insertIndex
      while (
        sameSecEnd < nextPoints.length &&
        Math.abs(nextPoints[sameSecEnd].sec - safeSecRounded) <= GAIN_ENVELOPE_SAME_SEC_EPSILON
      ) {
        sameSecEnd += 1
      }
      sameSecEnd -= 1
      const sameSecCount = sameSecEnd >= sameSecStart ? sameSecEnd - sameSecStart + 1 : 0
      return {
        insertIndex,
        sameSecStart,
        sameSecCount
      }
    }

    if (instantJumpMode && safeSec > minGapSec && safeSec < durationSec - minGapSec) {
      const bucket = resolveSameSecBucket(
        nextPoints.findIndex((point) => point.sec > safeSecRounded)
      )
      if (bucket.sameSecCount >= GAIN_ENVELOPE_MAX_POINTS_PER_SEC) {
        targetPointIndex = bucket.sameSecStart + GAIN_ENVELOPE_MAX_POINTS_PER_SEC - 1
        nextPoints[targetPointIndex] = {
          ...nextPoints[targetPointIndex],
          gain: safeGainRounded
        }
      } else if (bucket.sameSecCount === 1) {
        targetPointIndex = bucket.sameSecStart + 1
        nextPoints.splice(targetPointIndex, 0, {
          sec: safeSecRounded,
          gain: safeGainRounded
        })
      } else {
        const jumpStartGain = clampMixEnvelopeGain(
          param,
          sampleMixEnvelopeAtSec(param, points, safeSecRounded, safeGain)
        )
        nextPoints.splice(
          bucket.insertIndex,
          0,
          {
            sec: safeSecRounded,
            gain: Number(jumpStartGain.toFixed(6))
          },
          {
            sec: safeSecRounded,
            gain: safeGainRounded
          }
        )
        targetPointIndex = bucket.insertIndex + 1
      }
    } else if (safeSec <= minGapSec) {
      targetPointIndex = 0
      nextPoints[0] = {
        ...nextPoints[0],
        sec: 0,
        gain: safeGainRounded
      }
    } else if (safeSec >= durationSec - minGapSec) {
      targetPointIndex = nextPoints.length - 1
      nextPoints[targetPointIndex] = {
        ...nextPoints[targetPointIndex],
        sec: Number(durationSec.toFixed(4)),
        gain: safeGainRounded
      }
    } else {
      const bucket = resolveSameSecBucket(
        nextPoints.findIndex((point) => point.sec > safeSecRounded)
      )
      if (bucket.sameSecCount === 1) {
        targetPointIndex = bucket.sameSecStart + 1
        nextPoints.splice(targetPointIndex, 0, {
          sec: safeSecRounded,
          gain: safeGainRounded
        })
        updateTrackMixEnvelope(param, track.id, nextPoints)
        startEnvelopePointDrag(
          param,
          track.id,
          [targetPointIndex],
          stageEl,
          pointer,
          cloneGainPoints(nextPoints)
        )
        return
      }
      if (bucket.sameSecCount >= GAIN_ENVELOPE_MAX_POINTS_PER_SEC) {
        targetPointIndex = bucket.sameSecStart + GAIN_ENVELOPE_MAX_POINTS_PER_SEC - 1
        nextPoints[targetPointIndex] = {
          ...nextPoints[targetPointIndex],
          gain: safeGainRounded
        }
        updateTrackMixEnvelope(param, track.id, nextPoints)
        startEnvelopePointDrag(
          param,
          track.id,
          [targetPointIndex],
          stageEl,
          pointer,
          cloneGainPoints(nextPoints)
        )
        return
      }
      let insertIndex = bucket.insertIndex
      if (insertIndex < 0) insertIndex = nextPoints.length - 1
      const prevPoint = nextPoints[Math.max(0, insertIndex - 1)]
      const nextPoint = nextPoints[insertIndex]
      const nearPrev = !!prevPoint && Math.abs(safeSecRounded - prevPoint.sec) <= minGapSec
      const nearNext = !!nextPoint && Math.abs(nextPoint.sec - safeSecRounded) <= minGapSec
      if (nearPrev) {
        targetPointIndex = Math.max(0, insertIndex - 1)
        nextPoints[targetPointIndex] = {
          ...nextPoints[targetPointIndex],
          gain: safeGainRounded
        }
      } else if (nearNext) {
        targetPointIndex = insertIndex
        nextPoints[targetPointIndex] = {
          ...nextPoints[targetPointIndex],
          gain: safeGainRounded
        }
      } else {
        targetPointIndex = insertIndex
        nextPoints.splice(insertIndex, 0, {
          sec: safeSecRounded,
          gain: safeGainRounded
        })
      }
    }

    updateTrackMixEnvelope(param, track.id, nextPoints)
    startEnvelopePointDrag(
      param,
      track.id,
      [targetPointIndex],
      stageEl,
      pointer,
      cloneGainPoints(nextPoints)
    )
  }

  const removeTrackEnvelopePoint = (
    param: MixtapeEnvelopeParamId,
    trackId: string,
    pointIndex: number
  ) => {
    const { track, points } = resolveTrackEnvelopeState(trackId, param)
    if (!track || points.length <= 2) return
    if (pointIndex <= 0 || pointIndex >= points.length - 1) return
    const nextPoints = points.filter((_, index) => index !== pointIndex)
    updateTrackMixEnvelope(param, track.id, nextPoints)
  }

  const handleEnvelopePointDoubleClick = (item: TimelineTrackLayout, pointIndex: number) => {
    const param = resolveCurrentParam()
    if (!params.isEditable() || !param) return
    if (isStemSegmentParam(param)) return
    beginEnvelopeUndoSeed(param, item.track.id)
    removeTrackEnvelopePoint(param, item.track.id, pointIndex)
    commitEnvelopeUndoSeed()
  }

  const handleEnvelopePointContextMenu = (item: TimelineTrackLayout, pointIndex: number) => {
    const param = resolveCurrentParam()
    if (!params.isEditable() || !param) return
    if (isStemSegmentParam(param)) return
    beginEnvelopeUndoSeed(param, item.track.id)
    removeTrackEnvelopePoint(param, item.track.id, pointIndex)
    commitEnvelopeUndoSeed()
  }

  const restoreEnvelopeUndoEntry = (entry: Extract<MixParamUndoEntry, { type: 'envelope' }>) => {
    const { track, durationSec, points } = resolveTrackEnvelopeState(entry.trackId, entry.param)
    if (!track || !durationSec) return false
    const normalized = normalizeMixEnvelopePoints(entry.param, entry.points, durationSec)
    if (normalized.length < 2) return false
    if (JSON.stringify(points) === JSON.stringify(normalized)) return false
    const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[entry.param]
    params.tracks.value = params.tracks.value.map((item) =>
      item.id === track.id
        ? ({
            ...item,
            [envelopeField]: normalized
          } as MixtapeTrack)
        : item
    )
    scheduleMixEnvelopePersist(entry.param, track.id, normalized)
    void flushPendingMixEnvelopePersist()
    return true
  }

  const restoreSegmentUndoEntry = (entry: Extract<MixParamUndoEntry, { type: 'segment' }>) => {
    const { track, durationSec, segments } = resolveTrackSegmentState(entry.trackId, entry.param)
    if (!track || !durationSec) return false
    const normalized = resolveGridAlignedVolumeMuteSegments(track, durationSec, entry.segments)
    if (JSON.stringify(segments) === JSON.stringify(normalized)) return false
    if (entry.param === 'volume') {
      params.tracks.value = params.tracks.value.map((item) =>
        item.id === track.id
          ? ({
              ...item,
              volumeMuteSegments: normalized
            } as MixtapeTrack)
          : item
      )
      scheduleVolumeMuteSegmentsPersist(track.id, normalized)
      void flushPendingVolumeMutePersist()
      return true
    }
    const nextEnvelope = buildStemEnvelopeBySegments(entry.param, durationSec, normalized)
    const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[entry.param]
    params.tracks.value = params.tracks.value.map((item) =>
      item.id === track.id
        ? ({
            ...item,
            [envelopeField]: nextEnvelope
          } as MixtapeTrack)
        : item
    )
    scheduleMixEnvelopePersist(entry.param, track.id, nextEnvelope)
    void flushPendingMixEnvelopePersist()
    return true
  }

  const undoLastMixParamChange = () => {
    stopEnvelopePointDrag()
    stopSegmentSelection()
    envelopeUndoSeed.value = null
    while (undoStack.value.length > 0) {
      const entry = undoStack.value.pop()
      if (!entry) break
      isApplyingUndo = true
      try {
        if (entry.type === 'envelope') {
          if (restoreEnvelopeUndoEntry(entry)) return true
        } else if (entry.type === 'segment') {
          if (restoreSegmentUndoEntry(entry)) return true
        } else if (entry.undo()) {
          return true
        }
      } finally {
        isApplyingUndo = false
      }
    }
    return false
  }

  const cleanupGainEnvelopeEditor = () => {
    stopEnvelopePointDrag()
    stopSegmentSelection()
    envelopeUndoSeed.value = null
    undoStack.value = []
    void flushPendingMixEnvelopePersist()
    void flushPendingVolumeMutePersist()
  }

  const resolveActiveEnvelopePolygon = (item: TimelineTrackLayout) => {
    const polyline = resolveActiveEnvelopePolyline(item)
    if (!polyline) return ''
    return `0,100 ${polyline} 100,100`
  }

  const handleEnvelopeStageMouseMove = (item: TimelineTrackLayout, event: MouseEvent) => {
    const param = resolveCurrentParam()
    if (
      !params.isEditable() ||
      !param ||
      isStemSegmentParam(param) ||
      (param === 'volume' && params.isSegmentSelectionMode())
    ) {
      ghostPointState.value = null
      return
    }
    const stageEl = event.currentTarget as HTMLElement | null
    if (!stageEl) return

    // If Alt key is pressed, we could add visual feedback
    if (event.altKey) {
      stageEl.style.cursor = 'crosshair'
    } else {
      stageEl.style.cursor = ''
    }

    const { track, durationSec, points } = resolveTrackEnvelopeState(item.track.id, param)
    if (!track || !durationSec || points.length < 2) return

    const pointer = resolveEnvelopePointer(param, stageEl, event, durationSec)
    if (!pointer) return

    const lineGain = sampleMixEnvelopeAtSec(param, points, pointer.sec, pointer.gain)

    ghostPointState.value = {
      trackId: item.track.id,
      sec: pointer.sec,
      gain: lineGain
    }
  }

  const handleEnvelopeStageMouseLeave = (event: MouseEvent) => {
    ghostPointState.value = null
    const stageEl = event.currentTarget as HTMLElement | null
    if (stageEl) stageEl.style.cursor = ''
  }

  const resolveActiveGhostPointDot = (item: TimelineTrackLayout): EnvelopePointDot | null => {
    const state = ghostPointState.value
    if (!state || state.trackId !== item.track.id) return null
    const param = resolveCurrentParam()
    if (!param) return null
    const { durationSec } = resolveTrackEnvelopeState(item.track.id, param)
    if (!durationSec) return null

    return {
      index: -1,
      x: Number((clampNumber(state.sec / durationSec, 0, 1) * 100).toFixed(3)),
      y: Number(mapMixEnvelopeGainToYPercent(param, state.gain).toFixed(3)),
      gainDb: linearGainToDb(state.gain),
      isActive: false,
      isBoundary: false
    }
  }

  return {
    resolveActiveEnvelopePolyline,
    resolveActiveEnvelopePolygon,
    resolveActiveGhostPointDot,
    resolveActiveEnvelopePointDots,
    resolveActiveSegmentMasks,
    handleEnvelopeSegmentMouseDown,
    handleEnvelopePointMouseDown,
    handleEnvelopeStageMouseDown,
    handleEnvelopeStageMouseMove,
    handleEnvelopeStageMouseLeave,
    handleEnvelopePointDoubleClick,
    handleEnvelopePointContextMenu,
    canUndoMixParam,
    pushExternalUndoStep,
    undoLastMixParamChange,
    cleanupGainEnvelopeEditor
  }
}
