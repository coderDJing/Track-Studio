import { shallowRef } from 'vue'
import {
  resolveVolumeMuteSegmentKey,
  resolveVolumeMuteSegmentsByToggle,
  toggleVolumeMuteIntervals
} from './gainEnvelopeEditorGrid'
import type {
  MixtapeEnvelopeParamId,
  MixtapeMuteSegment,
  MixtapeTrack,
  TimelineTrackLayout
} from './types'

export const createGainEnvelopeMuteInteraction = (options: {
  activeParam: () => MixtapeEnvelopeParamId | null
  resolve: (
    id: string,
    param: MixtapeEnvelopeParamId
  ) => { track: MixtapeTrack | null; durationSec: number; segments: MixtapeMuteSegment[] }
  grid: (track: MixtapeTrack, duration: number) => { segments: MixtapeMuteSegment[] } | null
  update: (
    id: string,
    param: MixtapeEnvelopeParamId,
    segments: MixtapeMuteSegment[],
    persist: boolean
  ) => void
  commit: (id: string, param: MixtapeEnvelopeParamId, before: MixtapeMuteSegment[]) => void
  activeChanged?: (active: boolean) => void
}) => {
  type State = {
    trackId: string
    param: MixtapeEnvelopeParamId
    stage: HTMLElement
    pointerId: number
    base: MixtapeMuteSegment[]
    touched: Map<string, MixtapeMuteSegment>
    grid: MixtapeMuteSegment[]
    rect: DOMRect
    duration: number
    lastIndex: number
  }
  const state = shallowRef<State | null>(null)
  const selectIndex = (s: State, x: number) => {
    const sec = Math.max(
      0,
      Math.min(s.duration - 0.0001, ((x - s.rect.left) / s.rect.width) * s.duration)
    )
    return s.grid.findIndex((segment) => sec >= segment.startSec && sec < segment.endSec)
  }
  const update = (s: State) =>
    options.update(
      s.trackId,
      s.param,
      s.param === 'volume'
        ? toggleVolumeMuteIntervals(s.base, s.touched)
        : resolveVolumeMuteSegmentsByToggle(s.base, s.touched),
      false
    )
  const move = (event: PointerEvent) => {
    const s = state.value
    if (!s || s.pointerId !== event.pointerId) return
    event.preventDefault()
    const next = selectIndex(s, event.clientX)
    if (next < 0 || next === s.lastIndex) return
    for (let i = Math.min(s.lastIndex, next); i <= Math.max(s.lastIndex, next); i++) {
      const segment = s.grid[i]
      s.touched.set(resolveVolumeMuteSegmentKey(segment), segment)
    }
    s.lastIndex = next
    update(s)
  }
  const detach = () => {
    const s = state.value
    state.value = null
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('blur', cancel)
    window.removeEventListener('keydown', keydown, true)
    if (s) {
      s.stage.removeEventListener('lostpointercapture', cancel)
      if (s.stage.hasPointerCapture(s.pointerId)) s.stage.releasePointerCapture(s.pointerId)
      options.activeChanged?.(false)
    }
    return s
  }
  function cancel() {
    const s = detach()
    if (!s) return false
    options.update(s.trackId, s.param, s.base, false)
    return true
  }
  function end(event: PointerEvent) {
    if (state.value?.pointerId !== event.pointerId) return
    move(event)
    const s = detach()
    if (s) options.commit(s.trackId, s.param, s.base)
  }
  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }
  const begin = (item: TimelineTrackLayout, event: PointerEvent) => {
    const param = options.activeParam()
    if (!param || event.button !== 0 || event.isPrimary === false) return
    cancel()
    const stage = event.currentTarget as HTMLElement
    const resolved = options.resolve(item.track.id, param)
    if (!resolved.track || !resolved.durationSec) return
    const grid = options.grid(resolved.track, resolved.durationSec)
    const rect = stage.getBoundingClientRect()
    if (!grid?.segments.length || !rect.width) return
    const s: State = {
      trackId: item.track.id,
      param,
      stage,
      rect,
      pointerId: event.pointerId,
      duration: resolved.durationSec,
      base: resolved.segments.map((segment) => ({ ...segment })),
      touched: new Map(),
      grid: grid.segments,
      lastIndex: 0
    }
    s.lastIndex = selectIndex(s, event.clientX)
    if (s.lastIndex < 0) return
    const seed = s.grid[s.lastIndex]
    s.touched.set(resolveVolumeMuteSegmentKey(seed), seed)
    state.value = s
    update(s)
    stage.setPointerCapture(event.pointerId)
    stage.addEventListener('lostpointercapture', cancel)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', keydown, true)
    options.activeChanged?.(true)
  }
  return { begin, cancel, state }
}
