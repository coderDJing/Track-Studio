import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  mapMixEnvelopeGainToYPercent,
  mapMixEnvelopeYPercentToGain
} from './gainEnvelope'
import { createMixtapeGainEnvelopeEditor } from './useGainEnvelopeEditor'
import type { MixtapeEnvelopeParamId, MixtapeGainPoint, MixtapeTrack } from './types'

const editors: ReturnType<typeof createMixtapeGainEnvelopeEditor>[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.cleanupGainEnvelopeEditor()
  vi.unstubAllGlobals()
})

const createHarness = (
  options: {
    param?: MixtapeEnvelopeParamId
    zoom?: number
    points?: MixtapeGainPoint[]
    firstBeatMs?: number
  } = {}
) => {
  const param = options.param ?? 'gain'
  const points = options.points ?? [0, 4, 12, 16].map((sec) => ({ sec, gain: 1 }))
  const field = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
  const track: MixtapeTrack = {
    id: 'track',
    mixOrder: 1,
    title: '',
    artist: '',
    duration: '00:16',
    filePath: '',
    originPath: '',
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
  const tracks = ref([track])
  const zoom = ref(options.zoom ?? 99)
  const invoke = vi.fn().mockResolvedValue(undefined)
  const events = Object.assign(new EventTarget(), { electron: { ipcRenderer: { invoke } } })
  vi.stubGlobal('window', events)
  const editor = createMixtapeGainEnvelopeEditor({
    tracks,
    renderZoomLevel: zoom,
    resolveTrackDurationSeconds: () => 16,
    resolveTrackSourceDurationSeconds: () => 16,
    resolveTrackFirstBeatSeconds: () => (options.firstBeatMs ?? 0) / 1000,
    resolveActiveParam: () => param,
    isSegmentSelectionMode: () => false,
    isEditable: () => true
  })
  editors.push(editor)
  // The editor only reads geometry and locates the stage; no DOM renderer is needed.
  const stage = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 100 }),
    closest: () => ({ querySelector: () => stage }),
    classList: { contains: () => true }
  } as unknown as HTMLElement
  const item = { track, laneIndex: 0, startSec: 0, startX: 0, width: 1600 }
  const mouse = (type: string, sec: number, y: number, shiftKey = false) =>
    Object.assign(new Event(type, { cancelable: true }), {
      button: 0,
      clientX: sec * 100,
      clientY: y,
      shiftKey,
      altKey: false,
      detail: 1
    }) as MouseEvent
  const down = (sec: number, y = 50) => {
    const event = mouse('mousedown', sec, y)
    Object.defineProperty(event, 'currentTarget', {
      value: { closest: () => stage }
    })
    return event
  }
  const dots = () => editor.resolveActiveEnvelopePointDots(item)
  const times = () => tracks.value[0][field]?.map((point) => point.sec)
  return {
    editor,
    tracks,
    zoom,
    invoke,
    times,
    dots,
    start: (index: number, sec = points[index].sec, y = 50) =>
      editor.handleEnvelopePointMouseDown(item, index, down(sec, y)),
    startSegment: (sec: number, y = 50) => {
      const event = mouse('mousedown', sec, y)
      Object.defineProperty(event, 'currentTarget', { value: stage })
      editor.handleEnvelopeSegmentMouseDown(item, event)
    },
    add: (sec: number) => {
      const event = mouse('mousedown', sec, 50)
      Object.defineProperty(event, 'currentTarget', { value: stage })
      Object.defineProperty(event, 'detail', { value: 2 })
      editor.handleEnvelopeStageMouseDown(item, event)
    },
    move: (sec: number, y = 50, shiftKey = false) =>
      events.dispatchEvent(mouse('mousemove', sec, y, shiftKey)),
    end: () => events.dispatchEvent(new Event('mouseup'))
  }
}

describe('mixtape envelope point horizontal drag', () => {
  it.each(['gain', 'high', 'mid', 'low', 'volume'] as const)(
    'snaps %s points in both directions and saves an undoable edit',
    (param) => {
      const h = createHarness({ param })
      h.start(1)
      h.move(6.26, 75)
      expect(h.times()).toEqual([0, 6.5, 12, 16])
      expect(h.dots()[1].gainDb).toBeLessThan(0)
      h.move(5.15, 75)
      expect(h.times()).toEqual([0, 5, 12, 16])
      h.end()
      expect(h.invoke).toHaveBeenCalledWith('mixtape:update-mix-envelope', {
        param,
        entries: [
          {
            itemId: 'track',
            gainEnvelope: [
              { sec: 0, gain: 1 },
              { sec: 5, gain: expect.any(Number) },
              { sec: 12, gain: 1 },
              { sec: 16, gain: 1 }
            ]
          }
        ]
      })
      expect(h.editor.undoLastMixParamChange()).toBe(true)
      expect(h.times()).toEqual([0, 4, 12, 16])
      expect(h.dots()[1].gainDb).toBe(0)
      expect(h.editor.canUndoMixParam.value).toBe(false)
    }
  )

  it('uses visible downbeats at coarse zoom and beats at fine zoom', () => {
    const h = createHarness({ zoom: 3 })
    h.start(1)
    h.move(5.15)
    expect(h.times()).toEqual([0, 6, 12, 16])
    h.zoom.value = 99
    h.move(5.15)
    expect(h.times()).toEqual([0, 5, 12, 16])
    h.end()
  })

  it('honors the track grid phase', () => {
    const h = createHarness({ firstBeatMs: 250 })
    h.start(1)
    h.move(6.1)
    expect(h.times()).toEqual([0, 6.25, 12, 16])
    h.end()
  })

  it('stops at valid grid lines before adjacent points without losing points', () => {
    const h = createHarness()
    h.start(1)
    h.move(20)
    expect(h.times()).toEqual([0, 11.5, 12, 16])
    h.move(-2)
    expect(h.times()).toEqual([0, 0.5, 12, 16])
    h.end()
    expect(h.editor.undoLastMixParamChange()).toBe(true)
    expect(h.times()).toEqual([0, 4, 12, 16])
  })

  it.each([0, 3])('keeps boundary point %i anchored while changing its gain', (index) => {
    const h = createHarness()
    h.start(index)
    h.move(8, 75)
    expect(h.times()).toEqual([0, 4, 12, 16])
    expect(h.dots()[index].gainDb).toBeLessThan(0)
    h.end()
  })

  it('preserves vertical editing when there are no visible grid lines', () => {
    const h = createHarness({ zoom: 0 })
    h.start(1)
    h.move(7.12, 75)
    expect(h.times()).toEqual([0, 4, 12, 16])
    expect(h.dots()[1].gainDb).toBeLessThan(0)
    h.end()
  })

  it('keeps the time when no grid line fits between the neighbors', () => {
    const h = createHarness({
      zoom: 3,
      points: [0, 4.1, 4.2, 4.3, 16].map((sec) => ({ sec, gain: 1 }))
    })
    h.start(2)
    h.move(8, 75)
    expect(h.tracks.value[0].gainEnvelope?.map((point) => point.sec)).toEqual([
      0, 4.1, 4.2, 4.3, 16
    ])
    expect(h.dots()[2].gainDb).toBeLessThan(0)
    h.end()
  })

  it('does not snap time during a vertical fine adjustment or a click within the hit area', () => {
    const h = createHarness({
      points: [0, 4.2, 12, 16].map((sec) => ({ sec, gain: sec === 4.2 ? 0.5 : 1 }))
    })
    h.start(1, 4.3)
    h.move(4.32, 75, true)
    expect(h.tracks.value[0].gainEnvelope?.[1].sec).toBe(4.2)
    const deltaGain =
      mapMixEnvelopeYPercentToGain('gain', 75) - mapMixEnvelopeYPercentToGain('gain', 50)
    expect(h.tracks.value[0].gainEnvelope?.[1].gain).toBeCloseTo(0.5 + deltaGain * 0.1, 6)
    h.move(6.5, 75, true)
    // Preserve the initial pointer-to-point offset before snapping.
    expect(h.times()).toEqual([0, 6.5, 12, 16])
    h.end()
  })

  it('preserves jump point ordering and count when either side is dragged', () => {
    const h = createHarness({
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
    expect(h.times()).toEqual([0, 4, 6, 12, 16])
    h.end()
    expect(h.editor.undoLastMixParamChange()).toBe(true)
    h.start(1)
    h.move(8)
    expect(h.times()).toEqual([0, 4, 4, 12, 16])
    h.move(2.1)
    expect(h.times()).toEqual([0, 2, 4, 12, 16])
    h.end()
  })

  it('preserves gain on a horizontal drag started off-center within the point hit area', () => {
    const h = createHarness({
      points: [0, 4, 12, 16].map((sec) => ({ sec, gain: 0.5 }))
    })
    const y = mapMixEnvelopeGainToYPercent('gain', 0.5) + 5
    h.start(1, 4.1, y)
    h.move(6.2, y)
    expect(h.times()).toEqual([0, 6, 12, 16])
    expect(h.tracks.value[0].gainEnvelope?.[1].gain).toBe(0.5)
    h.end()
  })

  it('keeps segment dragging vertical', () => {
    const h = createHarness()
    h.startSegment(8)
    h.move(10.2, 75)
    expect(h.times()).toEqual([0, 4, 12, 16])
    expect(h.dots()[1].gainDb).toBeLessThan(0)
    expect(h.dots()[2].gainDb).toBeLessThan(0)
    h.end()
  })

  it('snaps a newly added point while dragging and undoes insertion and movement together', () => {
    const h = createHarness()
    h.add(6.17)
    expect(h.times()).toEqual([0, 4, 6, 12, 16])
    h.move(7.3)
    expect(h.times()).toEqual([0, 4, 7, 12, 16])
    h.end()
    expect(h.editor.undoLastMixParamChange()).toBe(true)
    expect(h.times()).toEqual([0, 4, 12, 16])
    expect(h.editor.canUndoMixParam.value).toBe(false)
  })
})
