import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  dbToLinearGain,
  linearGainToDb,
  mapMixEnvelopeGainToYPercent,
  sampleMixEnvelopeAtSec
} from './gainEnvelope'
import { createMixtapeGainEnvelopeEditor } from './useGainEnvelopeEditor'
import type { EnvelopeTool } from './gainEnvelopeInteraction'
import type { MixtapeEnvelopeParamId, MixtapeGainPoint, MixtapeTrack } from './types'

const editors: ReturnType<typeof createMixtapeGainEnvelopeEditor>[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.cleanupGainEnvelopeEditor()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const harness = (
  options: {
    param?: MixtapeEnvelopeParamId
    zoom?: number
    firstBeatMs?: number
    duration?: number
    points?: MixtapeGainPoint[]
    segmentMode?: boolean
  } = {}
) => {
  const param = ref(options.param ?? 'gain')
  const editable = ref(true),
    segmentMode = ref(options.segmentMode ?? false)
  const duration = options.duration ?? 16
  const field = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param.value]
  const points = options.points ?? [0, 4, 12, duration].map((sec) => ({ sec, gain: 1 }))
  const tracks = ref<MixtapeTrack[]>([
    {
      id: 'track',
      title: '',
      artist: '',
      mixOrder: 1,
      filePath: '',
      originPath: '',
      duration: '00:16',
      bpm: 120,
      originalBpm: 120,
      firstBeatMs: options.firstBeatMs ?? 0,
      beatGridMap:
        createSongBeatGridMapV2FromFixedGrid({
          bpm: 120,
          firstBeatMs: options.firstBeatMs ?? 0,
          downbeatBeatOffset: 0,
          source: 'analysis'
        }) ?? undefined,
      [field]: points
    }
  ])
  const invoke = vi.fn().mockResolvedValue(undefined)
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const events = Object.assign(new EventTarget(), {
    electron: { ipcRenderer: { invoke } },
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      const id = ++frameId
      frames.set(id, cb)
      return id
    },
    cancelAnimationFrame: (id: number) => frames.delete(id)
  })
  vi.stubGlobal('window', events)
  const flushFrame = () => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((cb) => cb(0))
  }
  const activeChanged = vi.fn()
  const editor = createMixtapeGainEnvelopeEditor({
    tracks,
    renderZoomLevel: ref(options.zoom ?? 99),
    resolveTrackDurationSeconds: () => duration,
    resolveTrackSourceDurationSeconds: () => duration,
    resolveTrackFirstBeatSeconds: () => (options.firstBeatMs ?? 0) / 1000,
    resolveActiveParam: () => param.value,
    isSegmentSelectionMode: () => segmentMode.value,
    isEditable: () => editable.value,
    onGestureActiveChange: activeChanged
  })
  editors.push(editor)
  let captured = false
  const stage = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: duration * 100, height: 100 }),
    classList: { contains: () => true },
    setPointerCapture: () => {
      captured = true
    },
    hasPointerCapture: () => captured,
    releasePointerCapture: () => {
      captured = false
    }
  }) as unknown as HTMLElement
  const item = {
    track: tracks.value[0],
    laneIndex: 0,
    startSec: 0,
    startX: 0,
    width: duration * 100
  }
  let last = { sec: 0, y: 50, shiftKey: false, altKey: false }
  const event = (
    type: string,
    sec: number,
    y: number,
    mods: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean } = {}
  ) => {
    const e = Object.assign(new Event(type, { cancelable: true }), {
      button: 0,
      clientX: sec * 100,
      clientY: y,
      pointerId: 1,
      detail: 1,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      ...mods
    }) as PointerEvent
    Object.defineProperty(e, 'currentTarget', { value: stage })
    last = { sec, y, shiftKey: e.shiftKey, altKey: e.altKey }
    return e
  }
  const get = () => tracks.value[0][field] ?? []
  const start = (
    index: number,
    sec = get()[index].sec,
    y = mapMixEnvelopeGainToYPercent(param.value, get()[index].gain)
  ) => editor.handleEnvelopePointMouseDown(item, index, event('pointerdown', sec, y))
  const stageStart = (tool: EnvelopeTool, sec: number, y: number, mods = {}) => {
    editor.setEnvelopeTool(tool)
    editor.handleEnvelopeStageMouseDown(item, event('pointerdown', sec, y, mods))
  }
  const move = (sec: number, y = last.y, mods = {}, flush = true) => {
    events.dispatchEvent(event('pointermove', sec, y, mods))
    if (flush) flushFrame()
  }
  const end = () => events.dispatchEvent(event('pointerup', last.sec, last.y, last))
  return {
    editor,
    tracks,
    editable,
    param,
    stage,
    events,
    segmentMode,
    invoke,
    get,
    start,
    stageStart,
    move,
    end,
    flushFrame,
    frames,
    activeChanged,
    times: () => get().map((p) => p.sec),
    add: (sec: number) => editor.handleEnvelopeStageDoubleClick(item, event('dblclick', sec, 50)),
    key: (key: string) =>
      events.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key })),
    hover: (sec: number, y: number) =>
      editor.handleEnvelopeStageMouseMove(item, event('pointermove', sec, y))
  }
}

describe('mixtape envelope direct manipulation', () => {
  it.each(['gain', 'high', 'mid', 'low', 'volume'] as const)(
    'magnetically snaps %s near the grid and allows movement between grid lines',
    (param) => {
      const h = harness({ param })
      h.start(1)
      h.move(6.26, 75)
      expect(h.times()[1]).toBe(6.26)
      h.move(6.46, 75)
      expect(h.times()[1]).toBe(6.5)
      h.move(6.59, 75)
      expect(h.times()[1]).toBe(6.5)
      h.move(6.7, 75)
      expect(h.times()[1]).toBe(6.7)
      expect(h.invoke).not.toHaveBeenCalled()
      h.end()
      expect(h.invoke).toHaveBeenCalledTimes(1)
      expect(h.editor.undoLastMixParamChange()).toBe(true)
      expect(h.times()).toEqual([0, 4, 12, 16])
      expect(h.editor.redoLastMixParamChange()).toBe(true)
      expect(h.times()[1]).toBe(6.7)
    }
  )

  it('honors phase, visible grid density, Alt bypass and the snap toggle', () => {
    const h = harness({ firstBeatMs: 250, zoom: 3 })
    h.start(1)
    h.move(6.21)
    expect(h.times()[1]).toBe(6.25)
    h.move(6.21, 50, { altKey: true })
    expect(h.times()[1]).toBe(6.21)
    h.editor.envelopeSnapEnabled.value = false
    h.move(4.23)
    expect(h.times()[1]).toBe(4.23)
    h.end()
  })

  it('allows free movement without visible grid lines', () => {
    const h = harness({ zoom: 0 })
    h.start(1)
    h.move(7.12, 75)
    h.end()
    expect(h.times()[1]).toBe(7.12)
  })

  it('does not jump on grab, or when Shift is pressed and released mid-drag', () => {
    const h = harness({ points: [0, 4.2, 12, 16].map((sec) => ({ sec, gain: 0.5 })) })
    const y = mapMixEnvelopeGainToYPercent('gain', 0.5) + 5
    h.start(1, 4.3, y)
    h.move(4.31, y)
    expect(h.get()[1]).toEqual({ sec: 4.2, gain: 0.5 })
    h.move(4.31, y + 10)
    const before = h.get()[1].gain
    h.move(4.31, y + 10, { shiftKey: true })
    expect(h.get()[1].gain).toBe(before)
    h.move(4.31, y + 11, { shiftKey: true })
    const fine = h.get()[1].gain
    expect(linearGainToDb(fine)).toBeCloseTo(linearGainToDb(before) - 0.052, 4)
    h.move(4.31, y + 11)
    expect(h.get()[1].gain).toBe(fine)
    h.end()
  })

  it.each([0, 3])('anchors endpoint %i in time', (index) => {
    const h = harness()
    h.start(index)
    h.move(8, 75)
    h.end()
    expect(h.times()).toEqual([0, 4, 12, 16])
    expect(h.get()[index].gain).toBeLessThan(1)
  })

  it('does not cross or delete neighboring jump points', () => {
    const h = harness({
      points: [
        { sec: 0, gain: 1 },
        { sec: 4, gain: 0.5 },
        { sec: 4, gain: 1 },
        { sec: 12, gain: 1 },
        { sec: 16, gain: 1 }
      ]
    })
    h.start(2)
    h.move(2)
    expect(h.times()).toEqual([0, 4, 4, 12, 16])
    h.move(6.1)
    expect(h.times()).toEqual([0, 4, 6.1, 12, 16])
    h.move(20)
    expect(h.times()[2]).toBe(11.9998)
    expect(h.get()).toHaveLength(5)
    h.end()
  })

  it('shifts a segment equally in dB and preserves its slope at limits', () => {
    const h = harness({
      points: [
        { sec: 0, gain: 1 },
        { sec: 4, gain: 0.5 },
        { sec: 12, gain: 1 },
        { sec: 16, gain: 1 }
      ]
    })
    const y = mapMixEnvelopeGainToYPercent('gain', 0.75)
    h.stageStart('edit', 8, y)
    h.move(9, y - 90)
    h.end()
    expect(h.times()).toEqual([0, 4, 12, 16])
    expect(linearGainToDb(h.get()[2].gain) - linearGainToDb(h.get()[1].gain)).toBeCloseTo(
      20 * Math.log10(2),
      4
    )
    expect(linearGainToDb(h.get()[2].gain)).toBeCloseTo(12, 4)
  })

  it.each(['Escape', 'blur', 'pointercancel', 'lostpointercapture'])(
    'rolls back %s without persisting a partial gesture',
    (reason) => {
      const h = harness()
      const before = JSON.stringify(h.get())
      h.start(1)
      h.move(6, 75)
      if (reason === 'Escape') h.key(reason)
      else if (reason === 'lostpointercapture') h.stage.dispatchEvent(new Event(reason))
      else h.events.dispatchEvent(new Event(reason))
      expect(JSON.stringify(h.get())).toBe(before)
      expect(h.invoke).not.toHaveBeenCalled()
      expect(h.editor.canUndoMixParam.value).toBe(false)
      expect(h.editor.isEnvelopeGestureActive.value).toBe(false)
    }
  )

  it('cancels on parameter change and applies only one preview per animation frame', () => {
    const h = harness()
    h.start(1)
    h.move(6, 70, {}, false)
    h.move(7, 75, {}, false)
    expect(h.frames.size).toBe(1)
    expect(h.times()[1]).toBe(4)
    h.flushFrame()
    expect(h.times()[1]).toBe(7)
    h.param.value = 'high'
    expect(h.times()[1]).toBe(4)
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('adds closely spaced points in a long track without altering the original interpolation', () => {
    const h = harness({
      duration: 300,
      points: [
        { sec: 0, gain: 1 },
        { sec: 5, gain: 0.5 },
        { sec: 10, gain: 1 },
        { sec: 300, gain: 1 }
      ]
    })
    const before = h.get().map((p) => ({ ...p }))
    h.add(5.2)
    expect(h.times()).toEqual([0, 5, 5.2, 10, 300])
    for (const sec of [2, 5.1, 5.2, 7, 100])
      expect(sampleMixEnvelopeAtSec('gain', h.get(), sec)).toBeCloseTo(
        sampleMixEnvelopeAtSec('gain', before, sec),
        5
      )
    h.editor.undoLastMixParamChange()
    expect(h.get()).toEqual(before)
    h.editor.redoLastMixParamChange()
    expect(h.times()).toContain(5.2)
  })

  it('selects an existing point on double click and deletes only explicitly', () => {
    const h = harness()
    h.add(4)
    expect(h.get()).toHaveLength(4)
    expect(h.editor.deleteSelectedEnvelopePoint()).toBe(true)
    expect(h.times()).toEqual([0, 12, 16])
    h.editor.undoLastMixParamChange()
    expect(h.times()).toEqual([0, 4, 12, 16])
    h.add(0)
    expect(h.editor.deleteSelectedEnvelopePoint()).toBe(false)
  })

  it('supports exact values and clears redo after a new edit', () => {
    const h = harness()
    h.add(4)
    h.editor.setSelectedEnvelopeDb(-6)
    expect(h.get()[1].gain).toBeCloseTo(dbToLinearGain(-6), 5)
    h.editor.undoLastMixParamChange()
    expect(h.editor.canRedoMixParam.value).toBe(true)
    expect(h.editor.selectedEnvelopeValue.value).toBeNull()
    h.add(4)
    h.editor.setSelectedEnvelopeDb(-3)
    expect(h.editor.canRedoMixParam.value).toBe(false)
  })

  it('draws a reversible ramp while protecting both outside regions', () => {
    const h = harness()
    const before = h.get().map((p) => ({ ...p }))
    h.stageStart('line', 3, 50)
    h.move(10, 90)
    h.end()
    expect(sampleMixEnvelopeAtSec('gain', h.get(), 6)).toBeLessThan(1)
    for (const sec of [0, 2, 2.999, 10.001, 14, 16])
      expect(sampleMixEnvelopeAtSec('gain', h.get(), sec)).toBeCloseTo(
        sampleMixEnvelopeAtSec('gain', before, sec),
        5
      )
    expect(h.invoke).toHaveBeenCalledTimes(1)
    h.editor.undoLastMixParamChange()
    expect(h.get()).toEqual(before)
  })

  it('selects a range without writing, then adjusts it without changing its surroundings', () => {
    const h = harness()
    h.stageStart('range', 3, 30)
    h.move(10, 30)
    h.end()
    expect(h.invoke).not.toHaveBeenCalled()
    h.stageStart('range', 6, 50)
    h.move(6, 75)
    h.end()
    expect(sampleMixEnvelopeAtSec('gain', h.get(), 6)).toBeLessThan(1)
    expect(sampleMixEnvelopeAtSec('gain', h.get(), 2.999)).toBe(1)
    expect(sampleMixEnvelopeAtSec('gain', h.get(), 10.001)).toBe(1)
    expect(h.invoke).toHaveBeenCalledTimes(1)
    h.editor.undoLastMixParamChange()
    expect(h.times()).toEqual([0, 4, 12, 16])
  })

  it('bends a sloped segment while retaining its endpoints', () => {
    const h = harness({
      points: [
        { sec: 0, gain: 1 },
        { sec: 4, gain: 1 },
        { sec: 12, gain: 0.1 },
        { sec: 16, gain: 0.1 }
      ]
    })
    h.stageStart('curve', 8, mapMixEnvelopeGainToYPercent('gain', 0.55))
    h.move(8, 80)
    h.end()
    expect(h.get().length).toBeGreaterThan(4)
    expect(sampleMixEnvelopeAtSec('gain', h.get(), 4)).toBe(1)
    expect(sampleMixEnvelopeAtSec('gain', h.get(), 12.001)).toBeCloseTo(0.1, 5)
    h.editor.undoLastMixParamChange()
    expect(h.get()).toHaveLength(4)
  })

  it('preserves segment mute interactions and cancels their preview', () => {
    const h = harness({ param: 'volume', segmentMode: true })
    h.stageStart('edit', 3, 50)
    h.move(6, 50)
    expect(h.tracks.value[0].volumeMuteSegments?.length).toBeGreaterThan(0)
    expect(h.invoke).not.toHaveBeenCalled()
    h.key('Escape')
    expect(h.tracks.value[0].volumeMuteSegments).toEqual([])
    h.stageStart('edit', 3, 50)
    h.end()
    expect(h.invoke).toHaveBeenCalledWith('mixtape:update-volume-mute-segments', expect.any(Object))
    h.editor.undoLastMixParamChange()
    expect(h.tracks.value[0].volumeMuteSegments).toEqual([])
    h.editor.redoLastMixParamChange()
    expect(h.tracks.value[0].volumeMuteSegments?.length).toBeGreaterThan(0)
  })
})
