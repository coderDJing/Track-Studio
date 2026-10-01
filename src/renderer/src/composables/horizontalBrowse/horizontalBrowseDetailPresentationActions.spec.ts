import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createHorizontalBrowseDetailPresentationActions } from './horizontalBrowseDetailPresentationActions'
import { resolveHorizontalBrowseWaveformTimeScale } from './horizontalBrowseWaveformTimeScale'

describe('双轨时间标尺与 Sync 事务', () => {
  it('事务目标倍率先于 props 快照到达时，按目标倍率准备正确密度和锚点', () => {
    const previousScale = 1
    const previewStartSec = ref(54)
    const setTimeScale = vi.fn()
    const scheduleDraw = vi.fn()
    const applyPlaybackPosition = vi.fn()
    const actions = createHorizontalBrowseDetailPresentationActions({
      deck: () => 'bottom',
      currentSeconds: () => 60,
      compactVisualWaveformActive: ref(true),
      previewStartSec,
      localGridShiftPhaseOffsetSec: ref(0),
      waveformPlaybackActive: () => true,
      linkedGridVisualPending: () => true,
      normalizePreviewTimelineSeconds: (seconds) => seconds,
      // pending 时显示帧仍是一屏 12 源音频秒；native props 仍停在原速。
      resolveVisibleDurationSec: () => 12,
      resolvePreviewDurationSec: () => 300,
      resolveWaveformCurrentSeconds: () => 60,
      allowNegativeTimeline: () => true,
      clampPreviewStart: (seconds) => seconds,
      stopStableCanvasPlayback: vi.fn(),
      drawWaveformNow: vi.fn(),
      measureStableCanvasPresentation: () => ({ frame: null }),
      getLastAppliedPreviewTimeScale: () => previousScale,
      setLastAppliedPreviewTimeScale: setTimeScale,
      resolveIncomingPreviewTimeScale: (rate = 1) => resolveHorizontalBrowseWaveformTimeScale(rate),
      resolveWaveformPlaybackRate: () => 1,
      resolveGridTimeBasis: () => ({
        bpm: 150,
        firstBeatMs: 0,
        downbeatBeatOffset: 0,
        timeBasisOffsetMs: 0
      }),
      invalidateWaveformTiles: vi.fn(),
      resetGridRenderer: vi.fn(),
      maybeContinueWaveformSource: vi.fn(),
      scheduleDraw,
      syncGridStateFromSong: vi.fn(),
      syncVisualGridStateFromPreview: vi.fn(),
      applyPreviewPlaybackPosition: applyPlaybackPosition,
      publishLinkedGridVisualPhaseSample: vi.fn(),
      markLinkedGridVisualTransactionCommitted: vi.fn()
    })
    const result = actions.commitLinkedGridVisualTransaction(
      {
        currentSeconds: 80,
        playbackRate: 0.8,
        playbackActive: true,
        startedAtMs: 1000
      },
      { mutate: false }
    )
    expect(result.timeScale).toBe(0.8)
    expect(result.visibleDurationSec).toBeCloseTo(9.6, 9)
    expect(result.viewportStartSec).toBeCloseTo(75.2, 9)
    expect(result.playbackClock).toEqual({ seconds: 80, playbackRate: 0.8, startedAtMs: 1000 })
    expect(result.gridTimeBasis.bpm).toBe(150)
    expect(previewStartSec.value).toBe(54)
    expect(setTimeScale).not.toHaveBeenCalled()
    expect(scheduleDraw).not.toHaveBeenCalled()
    expect(applyPlaybackPosition).not.toHaveBeenCalled()
  })
})
