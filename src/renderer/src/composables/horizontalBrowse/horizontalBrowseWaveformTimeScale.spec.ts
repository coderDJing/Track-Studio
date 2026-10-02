import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { resolveHorizontalBrowseWaveformTimeScale } from './horizontalBrowseWaveformTimeScale'
import { createHorizontalBrowseRawWaveformViewport } from './horizontalBrowseRawWaveformViewport'
import { resolveHorizontalBrowseLinkedDragTargets } from './horizontalBrowseLinkedDragTargets'
import { createDefaultDeckWaveformDragState } from './horizontalBrowseDeckPlaybackState'
import { createHorizontalBrowseDetailPresentationState } from './horizontalBrowseDetailPresentationState'
import type { ISongInfo } from 'src/types/globals'
import { HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC } from './horizontalBrowseWaveform.constants'

const createHarness = (bpm = 120, rate = 1, zoom = 20) => {
  const playbackRate = ref(rate)
  const densityPlaybackRate = ref<number | null>(null)
  const gridBpm = ref(bpm)
  const linkedPending = ref(false)
  const liveActive = ref(false)
  const song: ISongInfo = {
    filePath: 'test.wav',
    fileName: 'test',
    fileFormat: 'wav',
    cover: null,
    title: undefined,
    artist: undefined,
    album: undefined,
    duration: '300',
    genre: undefined,
    label: undefined,
    bitrate: undefined,
    container: undefined,
    bpm
  }
  const state = createHorizontalBrowseDetailPresentationState({
    song: () => song,
    direction: () => 'up',
    gridBpm: () => gridBpm.value,
    linkedGridActive: () => false,
    linkedGridVisualPending: () => linkedPending.value,
    waveformLayout: () => 'top-half',
    waveformPlaybackActive: () => true,
    resolveWaveformCurrentSeconds: () => 60,
    resolveWaveformPlaybackRate: () => playbackRate.value,
    resolveWaveformDensityPlaybackRate: () => densityPlaybackRate.value ?? playbackRate.value,
    liveTempoPreviewActive: () => liveActive.value,
    previewBpm: ref(bpm),
    previewFirstBeatMs: ref(0),
    previewDownbeatBeatOffset: ref(0),
    previewTimeBasisOffsetMs: ref(0)
  })
  state.setLastAppliedPreviewTimeScale(state.resolveIncomingPreviewTimeScale())
  const previewStartSec = ref(0)
  const viewport = createHorizontalBrowseRawWaveformViewport({
    song: () => song,
    direction: () => 'up',
    cueSeconds: () => undefined,
    hotCues: () => [],
    memoryCues: () => [],
    loopRange: () => null,
    currentSeconds: () => 60,
    playbackRate: () => playbackRate.value,
    visualTimeScale: state.resolveCanvasVisualTimeScale,
    playing: ref(true),
    playbackSyncRevision: ref(0),
    rawData: ref(null),
    mixxxData: ref(null),
    previewStartSec,
    previewZoom: ref(zoom),
    previewBpm: ref(bpm),
    previewFirstBeatMs: ref(0),
    previewDownbeatBeatOffset: ref(0),
    previewTimeBasisOffsetMs: ref(0),
    dragging: ref(false),
    previewLoading: ref(false),
    allowNegativeTimeline: () => true,
    waveformLayout: () => 'top-half',
    waveformRenderStyle: () => 'columns'
  })
  previewStartSec.value = viewport.resolvePlaybackAlignedStart(60)
  return {
    playbackRate,
    densityPlaybackRate,
    gridBpm,
    linkedPending,
    liveActive,
    state,
    previewStartSec,
    viewport
  }
}

describe('双轨大波形实际播放时间标尺', () => {
  it.each([0.8, 1, 1.2])('正式倍率 %s 下临时推拉只改变滚动速度，拍线和波形密度固定', (baseRate) => {
    const h = createHarness(150, baseRate)
    h.densityPlaybackRate.value = baseRate
    const visible = h.viewport.resolveVisibleDurationSec()
    const beatWidth = (960 * 60) / 150 / visible
    const baseSpeed = (baseRate * 960) / visible
    for (const ratio of [1.04, 0.96, 1.04, 1]) {
      h.playbackRate.value = baseRate * ratio
      expect(h.state.resolveIncomingPreviewTimeScale()).toBe(baseRate)
      expect(h.viewport.resolveVisibleDurationSec()).toBe(visible)
      expect((960 * 60) / 150 / h.viewport.resolveVisibleDurationSec()).toBe(beatWidth)
      const delta =
        h.viewport.resolvePlaybackAlignedStart(60 + h.playbackRate.value) -
        h.viewport.resolvePlaybackAlignedStart(60)
      expect((delta * 960) / visible).toBeCloseTo(baseSpeed * ratio, 8)
    }
    // native 恢复完成后撤掉固定值不会引发第二次密度变化。
    h.densityPlaybackRate.value = null
    expect(h.viewport.resolveVisibleDurationSec()).toBe(visible)
    h.playbackRate.value = 1.3
    expect(h.state.resolveIncomingPreviewTimeScale()).toBe(1.3)
  })
  it.each([20, 60, 180])('不同 BPM 和播放倍率的两轨等速滚动 (zoom=%s)', (zoom) => {
    const width = 960
    for (const [bpm, rate] of [
      [120, 1],
      [150, 1],
      [150, 0.8],
      [90, 1.5],
      [180, 0.5]
    ]) {
      const { viewport } = createHarness(bpm, rate, zoom)
      const delta =
        viewport.resolvePlaybackAlignedStart(60 + rate) - viewport.resolvePlaybackAlignedStart(60)
      expect((delta * width) / viewport.resolveVisibleDurationSec()).toBeCloseTo(
        (width * zoom) / HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC,
        8
      )
    }
  })

  it('原速 150 BPM 拍线更密；同步到 120 后两轨拍线间距完全相同', () => {
    const beatWidth = (bpm: number, rate: number) =>
      (960 * 60) / bpm / createHarness(bpm, rate).viewport.resolveVisibleDurationSec()
    expect(beatWidth(150, 1) / beatWidth(120, 1)).toBeCloseTo(0.8, 8)
    expect(beatWidth(150, 0.8)).toBeCloseTo(beatWidth(120, 1), 8)
  })

  it('改网格 BPM 不拉伸波形、不改变播放头位置', () => {
    const { state, gridBpm, viewport } = createHarness()
    const before = viewport.resolvePlaybackAlignedStart(60)
    gridBpm.value = 180
    expect(state.resolveIncomingPreviewTimeScale()).toBe(1)
    expect(viewport.resolvePlaybackAlignedStart(60)).toBe(before)
  })

  it('live 和 Sync 事务期间冻结旧帧密度，目标使用事务提供的倍率', () => {
    const { state, playbackRate, linkedPending, liveActive } = createHarness()
    liveActive.value = true
    playbackRate.value = 1.2
    expect(state.resolveCanvasVisualTimeScale()).toBe(1)
    expect(state.resolveIncomingPreviewTimeScale()).toBe(1.2)
    liveActive.value = false
    linkedPending.value = true
    expect(state.resolveCanvasVisualTimeScale()).toBe(1)
    expect(state.resolveIncomingPreviewTimeScale(0.8)).toBe(0.8)
    state.setLastAppliedPreviewTimeScale(0.8)
    expect(state.resolveCanvasVisualTimeScale()).toBe(0.8)
    linkedPending.value = false
    expect(state.resolveCanvasVisualTimeScale()).toBe(1.2)
  })

  it('不同倍率联动拖拽在两轨移动同样像素距离，暂停态保持播放头锚点', () => {
    const top = createHarness(120, 1)
    const bottom = createHarness(150, 0.8)
    const dragState = (rate: number) => ({
      ...createDefaultDeckWaveformDragState(),
      active: true,
      startAnchorSec: 60,
      anchorSec: 60,
      visualPlaybackRate: rate
    })
    const targets = resolveHorizontalBrowseLinkedDragTargets({
      deck: 'top',
      otherDeck: 'bottom',
      rawSourceTargetSec: 62,
      sourceDragState: dragState(1),
      otherDragState: dragState(0.8),
      resolveDeckDurationSeconds: () => 300
    })
    expect(targets.sourceDeltaSec / top.viewport.resolveVisibleDurationSec()).toBeCloseTo(
      targets.otherDeltaSec / bottom.viewport.resolveVisibleDurationSec(),
      8
    )
    for (const [harness, target] of [
      [top, targets.sourceTargetSec],
      [bottom, targets.otherTargetSec]
    ] as const) {
      harness.previewStartSec.value = harness.viewport.resolvePlaybackAlignedStart(target)
      expect(harness.viewport.resolvePreviewAnchorSec()).toBeCloseTo(target, 8)
    }
  })

  it.each([null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    '无效倍率 %s 使用原速',
    (rate) => {
      expect(resolveHorizontalBrowseWaveformTimeScale(rate)).toBe(1)
    }
  )
})
