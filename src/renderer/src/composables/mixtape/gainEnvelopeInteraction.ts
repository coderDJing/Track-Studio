import { computed, ref, shallowRef, watch } from 'vue'
import {
  buildMixEnvelopePolylineByControlPoints,
  dbToLinearGain,
  linearGainToDb,
  mapMixEnvelopeGainToYPercent,
  mapMixEnvelopeYPercentToGain,
  sampleMixEnvelopeAtSec
} from './gainEnvelope'
import {
  buildEnvelopeRamp,
  clampEnvelopeValue,
  cloneEnvelope,
  ENVELOPE_POINT_HIT_PX,
  ENVELOPE_TIME_EPSILON,
  moveEnvelopeDb,
  replaceEnvelopeRange,
  resolveEnvelopeDbLimits,
  resolveMagneticEnvelopeTime,
  shiftEnvelopePointsDb,
  shiftEnvelopeRange
} from './gainEnvelopeEditing'
import type {
  CreateMixtapeGainEnvelopeEditorParams,
  EnvelopePointDot
} from './gainEnvelopeEditorTypes'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeTrack,
  TimelineTrackLayout
} from './types'

export type EnvelopeTool = 'edit' | 'line' | 'range' | 'curve'
type PointSelection = { trackId: string; param: MixtapeEnvelopeParamId; index: number }
type TimeRange = { trackId: string; param: MixtapeEnvelopeParamId; start: number; end: number }
type EnvelopeState = { track: MixtapeTrack | null; durationSec: number; points: MixtapeGainPoint[] }
type Hit = { type: 'point'; index: number } | { type: 'segment'; index: number }
type Drag = {
  kind: 'point' | 'segment' | 'line' | 'select' | 'range' | 'curve'
  trackId: string
  param: MixtapeEnvelopeParamId
  stage: HTMLElement
  pointerId: number
  rect: DOMRect
  duration: number
  base: MixtapeGainPoint[]
  grid: readonly { sec: number }[]
  index: number
  firstX: number
  firstY: number
  lastX: number
  lastY: number
  rawSec: number
  bend: number
  rawDb: number
  originDb: number
  startSec: number
  endSec: number
  startGain: number
  latched: number | null
  horizontal: boolean
  moved: boolean
  alt: boolean
  fine: boolean
  previousRange: TimeRange | null
}

export const createGainEnvelopeInteraction = (options: {
  params: CreateMixtapeGainEnvelopeEditorParams
  resolve: (trackId: string, param: MixtapeEnvelopeParamId) => EnvelopeState
  grid: (track: MixtapeTrack, duration: number) => readonly { sec: number }[]
  update: (
    param: MixtapeEnvelopeParamId,
    trackId: string,
    points: MixtapeGainPoint[],
    persist?: boolean
  ) => void
  commit: (param: MixtapeEnvelopeParamId, trackId: string, base: MixtapeGainPoint[]) => void
}) => {
  const { params, resolve, update, commit } = options
  const envelopeTool = ref<EnvelopeTool>('edit')
  const envelopeSnapEnabled = ref(true)
  const selectedEnvelopePoint = ref<PointSelection | null>(null)
  const envelopeRange = ref<TimeRange | null>(null)
  const envelopeContextMenu = ref<{ trackId: string; x: number; y: number } | null>(null)
  const hover = ref<{ trackId: string; hit: Hit | null; sec: number; gain: number } | null>(null)
  const drag = shallowRef<Drag | null>(null)
  const snapGuide = ref<{ trackId: string; x: number } | null>(null)
  let frame: number | null = null
  const isEnvelopeGestureActive = computed(() => drag.value !== null)
  const selectedEnvelopeValue = computed(() => {
    const selected = selectedEnvelopePoint.value
    if (!selected || selected.param !== params.resolveActiveParam()) return null
    const state = resolve(selected.trackId, selected.param)
    const point = state.points[selected.index]
    if (!state.track || !point) return null
    return {
      ...selected,
      ...point,
      db: linearGainToDb(point.gain),
      removable: selected.index > 0 && selected.index < state.points.length - 1,
      ...resolveEnvelopeDbLimits(selected.param)
    }
  })
  const editableParam = () => {
    const param = params.resolveActiveParam()
    return params.isEditable() &&
      !params.isSegmentSelectionMode() &&
      param &&
      !['vocal', 'inst', 'bass', 'drums'].includes(param)
      ? param
      : null
  }
  const stageFor = (event: MouseEvent) => {
    const element = event.currentTarget as HTMLElement | null
    return element?.classList.contains('lane-track__envelope-points')
      ? element
      : (element
          ?.closest('.lane-track')
          ?.querySelector<HTMLElement>('.lane-track__envelope-points') ?? null)
  }
  const pointer = (event: MouseEvent, rect: DOMRect, duration: number) => ({
    sec: clampEnvelopeValue((event.clientX - rect.left) / rect.width, 0, 1) * duration,
    y: clampEnvelopeValue((event.clientY - rect.top) / rect.height, 0, 1) * 100
  })
  const hitTest = (
    event: MouseEvent,
    rect: DOMRect,
    state: EnvelopeState,
    param: MixtapeEnvelopeParamId
  ): Hit | null => {
    const x = event.clientX - rect.left,
      y = event.clientY - rect.top
    let distance = ENVELOPE_POINT_HIT_PX,
      found: Hit | null = null
    state.points.forEach((point, index) => {
      const dx = (point.sec / state.durationSec) * rect.width - x
      const dy = (mapMixEnvelopeGainToYPercent(param, point.gain) / 100) * rect.height - y
      const d = Math.hypot(dx, dy)
      if (d < distance) {
        distance = d
        found = { type: 'point', index }
      }
    })
    if (found) return found
    const sec = pointer(event, rect, state.durationSec).sec
    const lineY =
      (mapMixEnvelopeGainToYPercent(param, sampleMixEnvelopeAtSec(param, state.points, sec)) /
        100) *
      rect.height
    if (Math.abs(y - lineY) > 8) return null
    const index = state.points.findIndex(
      (point, i) => i < state.points.length - 1 && sec >= point.sec && sec < state.points[i + 1].sec
    )
    return index >= 0 ? { type: 'segment', index } : null
  }
  const magnetic = (state: Drag, sec: number, min = 0, max = state.duration) => {
    const result = resolveMagneticEnvelopeTime({
      sec,
      grid: state.grid,
      pxPerSec: state.rect.width / state.duration,
      enabled: envelopeSnapEnabled.value && !state.alt,
      latched: state.latched,
      min,
      max
    })
    state.latched = result.latched
    snapGuide.value =
      result.latched === null
        ? null
        : { trackId: state.trackId, x: (result.latched / state.duration) * 100 }
    return Number(result.sec.toFixed(4))
  }
  const clearFrame = () => {
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
  }
  const applyDrag = () => {
    frame = null
    const state = drag.value
    if (!state || !state.moved) return
    const { kind, base, param, trackId, duration, index } = state
    if (!params.isEditable() || param !== params.resolveActiveParam()) {
      cancelEnvelopeGesture()
      return
    }
    let next = cloneEnvelope(base)
    if (kind === 'point') {
      const point = base[index]
      if (state.horizontal && index > 0 && index < base.length - 1) {
        next[index].sec = magnetic(
          state,
          state.rawSec,
          Math.min(point.sec, base[index - 1].sec + ENVELOPE_TIME_EPSILON),
          Math.max(point.sec, base[index + 1].sec - ENVELOPE_TIME_EPSILON)
        )
      }
      let gain = dbToLinearGain(state.rawDb)
      const y = mapMixEnvelopeGainToYPercent(param, gain)
      const zero = mapMixEnvelopeGainToYPercent(param, 1)
      if (!state.fine && !state.alt && (Math.abs(y - zero) / 100) * state.rect.height < 5) gain = 1
      next[index].gain = gain
    } else if (kind === 'segment') {
      next = shiftEnvelopePointsDb(param, base, [index, index + 1], state.rawDb - state.originDb)
    } else if (kind === 'select') {
      const end = magnetic(state, state.rawSec)
      envelopeRange.value = {
        trackId,
        param,
        start: Math.min(state.startSec, end),
        end: Math.max(state.startSec, end)
      }
      return
    } else if (kind === 'range') {
      next = shiftEnvelopeRange(
        param,
        base,
        state.startSec,
        state.endSec,
        state.rawDb - state.originDb,
        duration
      )
    } else if (kind === 'line') {
      const endSec = magnetic(state, state.rawSec)
      const start = { sec: state.startSec, gain: state.startGain }
      const end = { sec: endSec, gain: dbToLinearGain(state.rawDb) }
      const left = start.sec <= end.sec ? start : end,
        right = start.sec <= end.sec ? end : start
      if (right.sec - left.sec < ENVELOPE_TIME_EPSILON) return
      next = replaceEnvelopeRange(
        param,
        base,
        left.sec,
        right.sec,
        buildEnvelopeRamp(param, left, right),
        duration
      )
    } else {
      const a = { sec: state.startSec, gain: sampleMixEnvelopeAtSec(param, base, state.startSec) }
      const b = { sec: state.endSec, gain: sampleMixEnvelopeAtSec(param, base, state.endSec) }
      const bend = clampEnvelopeValue(state.bend, -2, 2)
      if (Math.abs(bend) < 0.005) next = cloneEnvelope(base)
      else
        next = replaceEnvelopeRange(
          param,
          base,
          a.sec,
          b.sec,
          buildEnvelopeRamp(param, a, b, bend),
          duration
        )
    }
    update(param, trackId, next, false)
  }
  const move = (event: PointerEvent) => {
    const state = drag.value
    if (!state || event.pointerId !== state.pointerId) return
    event.preventDefault()
    const dx = event.clientX - state.lastX,
      dy = event.clientY - state.lastY
    state.lastX = event.clientX
    state.lastY = event.clientY
    if (Math.hypot(event.clientX - state.firstX, event.clientY - state.firstY) >= 3)
      state.moved = true
    if (Math.abs(event.clientX - state.firstX) >= 4) state.horizontal = true
    state.bend += (dy * (event.shiftKey ? 0.1 : 1)) / 100
    state.rawSec += (dx / state.rect.width) * state.duration
    state.rawDb = moveEnvelopeDb(
      state.param,
      state.rawDb,
      dy * (event.shiftKey ? 0.1 : 1),
      state.rect.height
    )
    state.alt = event.altKey
    state.fine = event.shiftKey
    if (frame === null) frame = window.requestAnimationFrame(applyDrag)
  }
  const blockWheel = (event: WheelEvent) => event.preventDefault()
  const detach = () => {
    const state = drag.value
    clearFrame()
    drag.value = null
    snapGuide.value = null
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('blur', cancel)
    window.removeEventListener('keydown', gestureKeydown, true)
    window.removeEventListener('wheel', blockWheel, true)
    if (state) {
      state.stage.removeEventListener('lostpointercapture', cancel)
      if (state.stage.hasPointerCapture(state.pointerId))
        state.stage.releasePointerCapture(state.pointerId)
    }
    params.onGestureActiveChange?.(false)
    return state
  }
  function cancelEnvelopeGesture() {
    const state = detach()
    if (!state) return false
    update(state.param, state.trackId, state.base, false)
    envelopeRange.value = state.previousRange
    return true
  }
  function cancel() {
    cancelEnvelopeGesture()
  }
  function end(event: PointerEvent) {
    if (!drag.value || event.pointerId !== drag.value.pointerId) return
    move(event)
    clearFrame()
    applyDrag()
    const state = detach()
    if (!state) return
    if (!state.moved) update(state.param, state.trackId, state.base, false)
    if (state.kind !== 'select') commit(state.param, state.trackId, state.base)
  }
  function gestureKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancelEnvelopeGesture()
  }
  const begin = (item: TimelineTrackLayout, event: PointerEvent, explicit?: Hit) => {
    const param = editableParam(),
      stage = stageFor(event)
    if (!param || !stage || event.button !== 0 || event.isPrimary === false) return
    cancelEnvelopeGesture()
    envelopeContextMenu.value = null
    const state = resolve(item.track.id, param),
      rect = stage.getBoundingClientRect()
    if (!state.track || !state.durationSec || !rect.width || !rect.height) return
    const at = pointer(event, rect, state.durationSec),
      hit = explicit ?? hitTest(event, rect, state, param)
    const range = envelopeRange.value
    const ownRange = range?.trackId === item.track.id && range.param === param ? range : null
    const inside = ownRange && at.sec >= ownRange.start && at.sec <= ownRange.end
    const tool = envelopeTool.value
    let kind: Drag['kind']
    if (tool === 'line') kind = 'line'
    else if (tool === 'range')
      kind = inside && !event.ctrlKey && !event.metaKey ? 'range' : 'select'
    else if (tool === 'curve') {
      if (!inside && hit?.type !== 'segment') return
      kind = 'curve'
    } else if (hit) kind = hit.type
    else {
      selectedEnvelopePoint.value = null
      envelopeRange.value = null
      return
    }
    const index = hit?.index ?? 0
    const point = state.points[index]
    if (kind === 'point') selectedEnvelopePoint.value = { trackId: item.track.id, param, index }
    else selectedEnvelopePoint.value = null
    const gain = kind === 'point' ? point.gain : mapMixEnvelopeYPercentToGain(param, at.y)
    const db = linearGainToDb(gain)
    const next: Drag = {
      kind,
      param,
      trackId: item.track.id,
      stage,
      rect,
      pointerId: event.pointerId,
      duration: state.durationSec,
      base: cloneEnvelope(state.points),
      grid: options.grid(state.track, state.durationSec),
      index,
      firstX: event.clientX,
      firstY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      rawSec: kind === 'point' ? point.sec : at.sec,
      bend: 0,
      rawDb: db,
      originDb: db,
      startSec:
        inside && (kind === 'range' || kind === 'curve')
          ? ownRange.start
          : kind === 'curve'
            ? point.sec
            : at.sec,
      endSec:
        inside && (kind === 'range' || kind === 'curve')
          ? ownRange.end
          : (state.points[index + 1]?.sec ?? state.durationSec),
      startGain: gain,
      latched: null,
      horizontal: false,
      moved: false,
      fine: event.shiftKey,
      alt: event.altKey,
      previousRange: range ? { ...range } : null
    }
    if (kind === 'line' || kind === 'select') next.startSec = magnetic(next, at.sec)
    drag.value = next
    hover.value = null
    event.preventDefault()
    stage.setPointerCapture(event.pointerId)
    stage.addEventListener('lostpointercapture', cancel)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', gestureKeydown, true)
    window.addEventListener('wheel', blockWheel, { passive: false, capture: true })
    params.onGestureActiveChange?.(true)
  }
  const handleEnvelopeStageDoubleClick = (item: TimelineTrackLayout, event: MouseEvent) => {
    const param = editableParam(),
      stage = stageFor(event)
    if (!param || !stage || envelopeTool.value !== 'edit') return
    cancelEnvelopeGesture()
    const state = resolve(item.track.id, param),
      rect = stage.getBoundingClientRect()
    if (!state.track || !rect.width || !rect.height || !state.durationSec) return
    const at = pointer(event, rect, state.durationSec)
    const snap = resolveMagneticEnvelopeTime({
      sec: at.sec,
      grid: options.grid(state.track, state.durationSec),
      pxPerSec: rect.width / state.durationSec,
      enabled: envelopeSnapEnabled.value && !event.altKey,
      latched: null,
      min: 0,
      max: state.durationSec
    })
    const sec = Number(snap.sec.toFixed(4))
    let nearest = -1,
      distance = ENVELOPE_POINT_HIT_PX
    state.points.forEach((point, index) => {
      const px = (Math.abs(point.sec - sec) / state.durationSec) * rect.width
      if (px < distance) {
        nearest = index
        distance = px
      }
    })
    if (nearest >= 0) {
      selectedEnvelopePoint.value = { trackId: item.track.id, param, index: nearest }
      return
    }
    const index = state.points.findIndex((point) => point.sec > sec)
    if (index <= 0) return
    const next = cloneEnvelope(state.points)
    next.splice(index, 0, { sec, gain: sampleMixEnvelopeAtSec(param, state.points, sec) })
    update(param, item.track.id, next, false)
    selectedEnvelopePoint.value = { trackId: item.track.id, param, index }
    commit(param, item.track.id, state.points)
  }
  const handleEnvelopeStageMouseMove = (item: TimelineTrackLayout, event: PointerEvent) => {
    if (drag.value) return
    const param = editableParam(),
      stage = stageFor(event)
    if (!param || !stage) return
    const state = resolve(item.track.id, param),
      rect = stage.getBoundingClientRect()
    if (!state.track || !state.durationSec || !rect.width || !rect.height) return
    const at = pointer(event, rect, state.durationSec)
    const snap = resolveMagneticEnvelopeTime({
      sec: at.sec,
      grid: options.grid(state.track, state.durationSec),
      pxPerSec: rect.width / state.durationSec,
      enabled: envelopeSnapEnabled.value && !event.altKey,
      latched: null,
      min: 0,
      max: state.durationSec
    })
    hover.value = {
      trackId: item.track.id,
      hit: hitTest(event, rect, state, param),
      sec: snap.sec,
      gain: sampleMixEnvelopeAtSec(param, state.points, snap.sec)
    }
  }
  const deleteSelectedEnvelopePoint = () => {
    if (!editableParam()) return false
    cancelEnvelopeGesture()
    const selected = selectedEnvelopeValue.value
    if (!selected?.removable) return false
    const state = resolve(selected.trackId, selected.param)
    update(
      selected.param,
      selected.trackId,
      state.points.filter((_, index) => index !== selected.index),
      false
    )
    commit(selected.param, selected.trackId, state.points)
    selectedEnvelopePoint.value = null
    envelopeContextMenu.value = null
    return true
  }
  const setSelectedEnvelopeDb = (db: number) => {
    if (!editableParam() || !Number.isFinite(db)) return
    const selected = selectedEnvelopeValue.value
    if (!selected) return
    const state = resolve(selected.trackId, selected.param),
      next = cloneEnvelope(state.points)
    next[selected.index].gain = dbToLinearGain(clampEnvelopeValue(db, selected.min, selected.max))
    update(selected.param, selected.trackId, next, false)
    commit(selected.param, selected.trackId, state.points)
  }
  const handleEnvelopeKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || !editableParam()) return
    if (event.key === 'Escape') {
      if (!cancelEnvelopeGesture() && !envelopeRange.value && !envelopeContextMenu.value) return
      envelopeRange.value = null
      envelopeContextMenu.value = null
      event.preventDefault()
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (deleteSelectedEnvelopePoint()) event.preventDefault()
    } else if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      selectedEnvelopeValue.value
    ) {
      event.preventDefault()
      setSelectedEnvelopeDb(
        selectedEnvelopeValue.value.db +
          (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 0.1 : 1)
      )
    }
  }
  const stopWatch = watch(
    () => [params.resolveActiveParam(), params.isSegmentSelectionMode(), params.isEditable()],
    () => {
      cancelEnvelopeGesture()
      selectedEnvelopePoint.value = null
      envelopeRange.value = null
      hover.value = null
      envelopeContextMenu.value = null
    },
    { flush: 'sync' }
  )
  const setEnvelopeTool = (tool: EnvelopeTool) => {
    cancelEnvelopeGesture()
    envelopeTool.value = tool
    hover.value = null
    envelopeContextMenu.value = null
  }
  const resolveActiveEnvelopePointDots = (item: TimelineTrackLayout): EnvelopePointDot[] => {
    const param = editableParam()
    if (!param) return []
    const { durationSec, points } = resolve(item.track.id, param)
    if (!durationSec) return []
    return points.map((point, index) => ({
      index,
      x: (point.sec / durationSec) * 100,
      y: mapMixEnvelopeGainToYPercent(param, point.gain),
      gainDb: linearGainToDb(point.gain),
      sec: point.sec,
      isActive:
        drag.value?.trackId === item.track.id &&
        (drag.value.kind === 'point'
          ? drag.value.index === index
          : drag.value.kind === 'segment' &&
            [drag.value.index, drag.value.index + 1].includes(index)),
      isSelected:
        selectedEnvelopePoint.value?.trackId === item.track.id &&
        selectedEnvelopePoint.value.index === index,
      isHovered:
        hover.value?.trackId === item.track.id &&
        hover.value.hit?.type === 'point' &&
        hover.value.hit.index === index,
      isBoundary: index === 0 || index === points.length - 1
    }))
  }
  const resolveActiveEnvelopePolyline = (item: TimelineTrackLayout) => {
    const param = params.resolveActiveParam()
    if (!param) return ''
    const state = resolve(item.track.id, param)
    return buildMixEnvelopePolylineByControlPoints({
      param,
      points: state.points,
      durationSec: state.durationSec
    })
  }
  const resolveEnvelopeHoverLine = (item: TimelineTrackLayout) => {
    const h = hover.value,
      param = editableParam()
    if (!param || h?.trackId !== item.track.id || h.hit?.type !== 'segment' || drag.value) return ''
    const state = resolve(item.track.id, param)
    const line = state.points.slice(h.hit.index, h.hit.index + 2)
    return buildMixEnvelopePolylineByControlPoints({
      param,
      points: line,
      durationSec: state.durationSec,
      normalize: false
    })
  }
  const resolveEnvelopeRangeStyle = (item: TimelineTrackLayout) => {
    const range = envelopeRange.value
    if (!range || range.trackId !== item.track.id || range.param !== params.resolveActiveParam())
      return null
    const { durationSec } = resolve(item.track.id, range.param)
    return {
      left: `${(range.start / durationSec) * 100}%`,
      width: `${((range.end - range.start) / durationSec) * 100}%`
    }
  }
  const resolveEnvelopeCursor = (item: TimelineTrackLayout) => {
    if (drag.value?.trackId === item.track.id) return 'grabbing'
    if (envelopeTool.value !== 'edit')
      return envelopeTool.value === 'curve' ? 'ns-resize' : 'crosshair'
    const hit = hover.value?.trackId === item.track.id ? hover.value.hit : null
    return hit?.type === 'point' ? 'grab' : hit ? 'ns-resize' : 'default'
  }
  return {
    envelopeTool,
    envelopeSnapEnabled,
    selectedEnvelopePoint,
    selectedEnvelopeValue,
    envelopeRange,
    envelopeContextMenu,
    snapGuide,
    isEnvelopeGestureActive,
    toggleEnvelopeSnap: () => {
      envelopeSnapEnabled.value = !envelopeSnapEnabled.value
    },
    setEnvelopeTool,
    cancelEnvelopeGesture,
    deleteSelectedEnvelopePoint,
    setSelectedEnvelopeDb,
    handleEnvelopeKeydown,
    handleEnvelopeStageDoubleClick,
    resolveActiveEnvelopePointDots,
    resolveActiveEnvelopePolyline,
    resolveEnvelopeHoverLine,
    resolveEnvelopeRangeStyle,
    resolveEnvelopeCursor,
    resolveActiveEnvelopePolygon: (item: TimelineTrackLayout) =>
      `0,100 ${resolveActiveEnvelopePolyline(item)} 100,100`,
    resolveActiveGhostPointDot: (item: TimelineTrackLayout) => {
      const h = hover.value,
        param = editableParam()
      if (
        !h ||
        !param ||
        h.trackId !== item.track.id ||
        h.hit?.type === 'point' ||
        envelopeTool.value !== 'edit'
      )
        return null
      const { durationSec } = resolve(item.track.id, param)
      return { x: (h.sec / durationSec) * 100, y: mapMixEnvelopeGainToYPercent(param, h.gain) }
    },
    handleEnvelopePointMouseDown: (item: TimelineTrackLayout, index: number, event: PointerEvent) =>
      begin(item, event, { type: 'point', index }),
    handleEnvelopeSegmentMouseDown: (item: TimelineTrackLayout, event: PointerEvent) =>
      begin(item, event),
    handleEnvelopeStageMouseDown: (item: TimelineTrackLayout, event: PointerEvent) =>
      begin(item, event),
    handleEnvelopeStageMouseMove,
    handleEnvelopeStageMouseLeave: () => {
      hover.value = null
    },
    handleEnvelopePointContextMenu: (
      item: TimelineTrackLayout,
      index: number,
      event: MouseEvent
    ) => {
      const param = editableParam(),
        stage = stageFor(event)
      if (!param || !stage) return
      cancelEnvelopeGesture()
      selectedEnvelopePoint.value = { trackId: item.track.id, param, index }
      const rect = stage.getBoundingClientRect()
      envelopeContextMenu.value = {
        trackId: item.track.id,
        x: clampEnvelopeValue(event.clientX - rect.left, 0, Math.max(0, rect.width - 130)),
        y: clampEnvelopeValue(event.clientY - rect.top, 0, Math.max(0, rect.height - 34))
      }
    },
    cleanup: () => {
      cancelEnvelopeGesture()
      stopWatch()
      hover.value = null
    }
  }
}
