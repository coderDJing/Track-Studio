import { computed, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { TIMELINE_SIDE_PADDING_PX } from './constants'
import { createTimelineHelpersModule } from './timelineHelpers'
import { createTimelineTransportResolversModule } from './timelineTransportResolvers'
import type { MixtapeTrack } from './types'

const track = (id: string, startSec: number, duration = '02:00'): MixtapeTrack => ({
  id,
  title: id,
  artist: '',
  mixOrder: 1,
  filePath: `${id}.mp3`,
  originPath: '',
  duration,
  bpm: 120,
  originalBpm: 120,
  startSec
})

const createScene = (
  initialTracks = [track('a', 0), track('b', 80), track('last', 160)],
  zoom = 1
) => {
  const tracks = ref(initialTracks)
  const renderZoom = ref(zoom)
  const layoutVersion = ref(0)
  const helpers = createTimelineHelpersModule({
    tracks,
    zoom: renderZoom,
    renderZoom,
    mixtapeMixMode: ref('eq'),
    t: (key) => key,
    libraryUtils: { getLibraryTreeByUUID: () => null, findDirPathByUuid: () => '' },
    waveformDataMap: new Map(),
    rawWaveformDataMap: new Map(),
    waveformInflight: new Set(),
    rawWaveformInflight: new Set(),
    waveformMinMaxCache: new Map(),
    rawWaveformPyramidMap: new Map(),
    timelineLayoutCache: new Map(),
    timelineLayoutVersion: layoutVersion,
    waveformVersion: ref(0),
    overviewWidth: ref(1000),
    timelineVisualScale: ref(1),
    waveformTileCache: new Map(),
    waveformTileCacheIndex: new Map(),
    waveformTileCacheTickRef: ref(0),
    waveformTileCacheLimitRef: ref(100)
  })
  const layout = computed(() => {
    void layoutVersion.value
    return helpers.buildSequentialLayoutForZoom(renderZoom.value)
  })
  const playheadSec = ref(0)
  const playing = ref(true)
  const visible = ref(true)
  const transportDuration = ref(helpers.computeTimelineDuration())
  const scrollLeft = ref(0)
  const resolvers = createTimelineTransportResolversModule({
    tracks,
    timelineLayout: layout,
    normalizedRenderZoom: helpers.normalizedRenderZoom,
    timelineScrollLeft: scrollLeft,
    timelineViewportWidth: ref(800),
    rulerRef: ref(null),
    playheadSec,
    playheadVisible: visible,
    transportPlaying: playing,
    transportPreloadDone: ref(0),
    transportPreloadTotal: ref(0),
    transportDurationSecRef: transportDuration,
    computeTimelineDuration: helpers.computeTimelineDuration,
    resolveRenderPxPerSec: helpers.resolveRenderPxPerSec,
    buildSequentialLayoutForZoom: helpers.buildSequentialLayoutForZoom,
    clampNumber: (value, min, max) => Math.max(min, Math.min(max, value)),
    segmentMuteGain: 0.0001
  })
  const markerLeft = () => Number.parseFloat(resolvers.overviewPlayheadStyle.value.left)
  const lastRect = () => {
    const last = layout.value.layout.at(-1)!
    const style = helpers.resolveOverviewTrackStyle(last)
    const left = Number.parseFloat(style.left)
    return { left, right: left + Number.parseFloat(style.width) }
  }
  return {
    helpers,
    layout,
    playheadSec,
    playing,
    visible,
    transportDuration,
    scrollLeft,
    renderZoom,
    resolvers,
    markerLeft,
    lastRect
  }
}

describe('mixtape overview playback coordinates', () => {
  it.each([0.1, 1, 20])('stays inside the final rectangle until its end at zoom %s', (zoom) => {
    const scene = createScene(undefined, zoom)
    const last = scene.lastRect()
    let previous = last.left
    for (const sec of [200, 240, 270, 275, 279, 279.9]) {
      scene.playheadSec.value = sec
      const left = scene.markerLeft()
      expect(left).toBeGreaterThan(previous)
      expect(left).toBeLessThan(last.right)
      previous = left
    }
    scene.playheadSec.value = 280
    expect(scene.markerLeft()).toBeCloseTo(last.right, 8)
    // The trailing canvas space stays visible after the last track, with no playback in it.
    expect(scene.markerLeft()).toBeLessThan(100)
  })

  it('starts at the first rectangle rather than at the outside edge of the canvas', () => {
    const scene = createScene()
    const first = scene.layout.value.layout[0]
    expect(scene.markerLeft()).toBeCloseTo(
      Number.parseFloat(scene.helpers.resolveOverviewTrackStyle(first).left),
      8
    )
    expect(scene.markerLeft()).toBeGreaterThan(0)
  })

  it('keeps advancing near the end even when the audio plan duration differs from the display', () => {
    const scene = createScene()
    scene.transportDuration.value = 200
    const positions = [240, 270, 279].map((sec) => {
      scene.playheadSec.value = sec
      return scene.markerLeft()
    })
    expect(positions[1]).toBeGreaterThan(positions[0])
    expect(positions[2]).toBeGreaterThan(positions[1])
    expect(positions[2]).toBeLessThan(scene.lastRect().right)
  })

  it('uses the same position after pause and at the final completed frame', () => {
    const scene = createScene()
    scene.playheadSec.value = 279
    const beforePause = scene.markerLeft()
    scene.playing.value = false
    expect(scene.markerLeft()).toBe(beforePause)
    expect(scene.resolvers.overviewPlayheadStyle.value.opacity).toBe('0.45')
    scene.playheadSec.value = 280
    expect(scene.markerLeft()).toBeCloseTo(scene.lastRect().right, 8)
  })

  it('uses the updated pixel scale after zooming and stays independent of timeline scrolling', () => {
    const scene = createScene()
    scene.playheadSec.value = 279
    scene.renderZoom.value = 3
    scene.helpers.clearTimelineLayoutCache()
    const pxPerSec = scene.helpers.resolveRenderPxPerSec(scene.renderZoom.value)
    const expected =
      ((TIMELINE_SIDE_PADDING_PX + 279 * pxPerSec) / scene.layout.value.totalWidth) * 100
    expect(scene.markerLeft()).toBeCloseTo(expected, 8)
    scene.scrollLeft.value = scene.layout.value.totalWidth - 800
    expect(scene.markerLeft()).toBeCloseTo(expected, 8)
    const primaryBefore = Number.parseFloat(scene.resolvers.timelinePlayheadStyle.value.left)
    scene.playheadSec.value = 279.5
    expect(scene.markerLeft()).toBeGreaterThan(expected)
    expect(Number.parseFloat(scene.resolvers.timelinePlayheadStyle.value.left)).toBeGreaterThan(
      primaryBefore
    )
  })

  it('aligns a short project with its rectangle even with large trailing canvas space', () => {
    const scene = createScene([track('short', 0, '00:10')], 0.1)
    scene.playheadSec.value = 9
    expect(scene.markerLeft()).toBeLessThan(scene.lastRect().right)
    scene.playheadSec.value = 10
    expect(scene.markerLeft()).toBeCloseTo(scene.lastRect().right, 8)
  })

  it('handles an empty timeline without exposing a visible marker', () => {
    const scene = createScene([])
    scene.visible.value = false
    expect(Number.isFinite(scene.markerLeft())).toBe(true)
    expect(scene.resolvers.overviewPlayheadStyle.value.opacity).toBe('0')
  })
})
