// Run: pnpm exec vitest run src/renderer/src/composables/mixtape/timelineLaneLayout.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { createTimelineHelpersModule } from './timelineHelpers'
import { resolveMixtapeTrackLaneBaseHeight } from './constants'
import { resolveTimelineScalableBaseHeightByTrackCount } from './timelineVisualScaleConfig'
import type { MixtapeTrack } from './types'

const createTrack = (id: string, laneIndex?: number): MixtapeTrack => ({
  id,
  mixOrder: 1,
  title: id,
  artist: '',
  duration: '4:00',
  filePath: `E:/Music/${id}.mp3`,
  originPath: '',
  originPlaylistUuid: null,
  startSec: 0,
  laneIndex
})

const createHelpers = (laneCount: Ref<number>, tracks: MixtapeTrack[] = []) => {
  const libraryUtils = {
    getLibraryTreeByUUID: vi.fn(() => null),
    findDirPathByUuid: vi.fn(() => '')
  }
  return createTimelineHelpersModule({
    zoom: { value: 1 },
    renderZoom: { value: 1 },
    tracks: { value: tracks },
    laneCount,
    mixtapeMixMode: { value: 'eq' },
    t: (key) => key,
    libraryUtils,
    waveformDataMap: new Map(),
    rawWaveformDataMap: new Map(),
    waveformInflight: new Set(),
    rawWaveformInflight: new Set(),
    waveformMinMaxCache: new Map(),
    rawWaveformPyramidMap: new Map(),
    timelineLayoutCache: new Map(),
    timelineLayoutVersion: { value: 0 },
    waveformVersion: { value: 0 },
    overviewWidth: { value: 0 },
    timelineVisualScale: { value: 1 },
    waveformTileCache: new Map(),
    waveformTileCacheIndex: new Map(),
    waveformTileCacheTickRef: { value: 0 },
    waveformTileCacheLimitRef: { value: 100 }
  })
}

const resolveLayoutLanes = (
  laneCount: Ref<number>,
  tracks: MixtapeTrack[]
): Array<[string, number]> => {
  const helpers = createHelpers(laneCount, tracks)
  return helpers
    .buildSequentialLayoutForZoom(1)
    .layout.map((item) => [item.track.id, item.laneIndex] as [string, number])
}

describe('Mixtape 泳道数切换', () => {
  it('默认双轨，展开后是四条泳道', () => {
    const laneCount = ref(2)
    const helpers = createHelpers(laneCount)
    expect(helpers.laneIndices.value).toEqual([0, 1])
    laneCount.value = 4
    expect(helpers.laneIndices.value).toEqual([0, 1, 2, 3])
  })

  it('没有持久化泳道的曲目仍按双轨交替落位', () => {
    const tracks = [createTrack('a'), createTrack('b'), createTrack('c')]
    expect(resolveLayoutLanes(ref(2), tracks)).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 0]
    ])
    expect(resolveLayoutLanes(ref(4), tracks)).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 0]
    ])
  })

  it('四首真同时叠时收起成双轨会重新分配到两条泳道，而不是全堆在最后一条', () => {
    const tracks = [
      createTrack('a', 0),
      createTrack('b', 1),
      createTrack('c', 2),
      createTrack('d', 3)
    ]
    expect(resolveLayoutLanes(ref(2), tracks)).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 0],
      ['d', 1]
    ])
    expect(resolveLayoutLanes(ref(4), tracks)).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3]
    ])
  })

  it('收起成双轨只改显示，再展开回四轨能回到原位', () => {
    const tracks = [createTrack('a'), createTrack('d', 3)]
    expect(resolveLayoutLanes(ref(4), tracks)).toEqual([
      ['a', 0],
      ['d', 3]
    ])
    expect(resolveLayoutLanes(ref(2), tracks)).toEqual([
      ['a', 0],
      ['d', 1]
    ])
    // 模型里的 laneIndex 从未被改写，所以展开回 4 轨时 d 回到第 4 轨
    expect(tracks[1].laneIndex).toBe(3)
    expect(resolveLayoutLanes(ref(4), tracks)).toEqual([
      ['a', 0],
      ['d', 3]
    ])
  })

  it('展开成四轨时压缩单轨高度，不把时间线撑出视口', () => {
    const laneCount = ref(2)
    const helpers = createHelpers(laneCount)
    const twoLaneHeight = helpers.laneHeight.value
    laneCount.value = 4
    const fourLaneHeight = helpers.laneHeight.value
    expect(twoLaneHeight).toBe(resolveMixtapeTrackLaneBaseHeight(2))
    expect(fourLaneHeight).toBe(resolveMixtapeTrackLaneBaseHeight(4))
    expect(fourLaneHeight * 4).toBeLessThanOrEqual(twoLaneHeight * 2 + 50)
  })

  it('轨道区基准高度不会随泳道数暴涨', () => {
    const twoLane = resolveTimelineScalableBaseHeightByTrackCount(4, 2)
    const fourLane = resolveTimelineScalableBaseHeightByTrackCount(4, 4)
    expect(fourLane).toBeGreaterThan(twoLane)
    expect(fourLane - twoLane).toBeLessThan(220)
  })
})
