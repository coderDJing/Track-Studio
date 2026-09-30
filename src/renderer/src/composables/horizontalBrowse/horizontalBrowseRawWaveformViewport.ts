import {
  clampHorizontalBrowsePreviewStartByVisibleDuration,
  resolveHorizontalBrowsePlaybackAlignedStart
} from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailMath'
import {
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
  HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC
} from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { parseHorizontalBrowseDurationToSeconds } from '@renderer/composables/horizontalBrowse/horizontalBrowseShellState'
import { clampNumber } from '@renderer/composables/horizontalBrowse/horizontalBrowseMath'
import type {
  HorizontalBrowseWaveformLayout,
  UseHorizontalBrowseRawWaveformCanvasOptions
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasTypes'

type RenderViewportParams = {
  usePreviewStart: boolean
  rangeStartSec: number
  rangeDurationSec: number
  playbackSeconds: number
  playheadCanvasX: number
  renderWidth: number
  renderRangeDurationSec: number
  stableWaveformSource: boolean
  stableOverscanCssPx: number
  viewportLeftCssPx: number
  pixelRatio: number
}

export const resolveHorizontalBrowseRawWaveformRenderViewport = (params: RenderViewportParams) => {
  const renderAnchorSec = params.usePreviewStart
    ? Math.max(
        0,
        params.rangeStartSec + params.rangeDurationSec * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
      )
    : params.playbackSeconds
  const renderWidth = Math.max(1, params.renderWidth)
  const renderDurationSec = Math.max(0.0001, params.renderRangeDurationSec)
  const rawRangeStartSec =
    renderAnchorSec - (params.playheadCanvasX / renderWidth) * renderDurationSec
  let renderRangeStartSec = rawRangeStartSec
  if (params.stableWaveformSource) {
    const pixelRatio = params.pixelRatio > 0 ? params.pixelRatio : 1
    const scaledPxPerSec = (renderWidth * pixelRatio) / renderDurationSec
    const screenOriginScaledPx =
      (params.viewportLeftCssPx - params.stableOverscanCssPx) * pixelRatio
    // 全局块网格的歌曲 0 秒原点必须落在屏幕整数物理像素上。只取整 translate，
    // 或单独取整每块 left，都无法保证两张不同起点的帧在同一播放位置完全重合。
    const songOriginScaledPx = screenOriginScaledPx - rawRangeStartSec * scaledPxPerSec
    renderRangeStartSec = (screenOriginScaledPx - Math.round(songOriginScaledPx)) / scaledPxPerSec
  }
  const viewportRangeStartSec = params.stableWaveformSource
    ? renderRangeStartSec + (params.stableOverscanCssPx * renderDurationSec) / renderWidth
    : renderRangeStartSec
  return { renderAnchorSec, renderRangeStartSec, viewportRangeStartSec }
}

export const createHorizontalBrowseRawWaveformViewport = (
  options: UseHorizontalBrowseRawWaveformCanvasOptions
) => {
  const resolvePreviewTimeScale = () => Math.max(0.25, Number(options.visualTimeScale()) || 1)

  const resolvePreviewDurationSec = () => {
    const duration = Number(
      options.rawData.value?.duration ||
        options.mixxxData.value?.duration ||
        parseHorizontalBrowseDurationToSeconds(options.song()?.duration) ||
        0
    )
    return Number.isFinite(duration) && duration > 0 ? duration : 0
  }

  const canShowTimelinePlaceholder = () => {
    if (!String(options.song()?.filePath || '').trim()) return false
    return resolvePreviewDurationSec() > 0
  }

  const resolveVisibleDurationSec = () =>
    Math.max(
      0.001,
      (HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC * resolvePreviewTimeScale()) /
        Number(options.previewZoom.value || HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
    )

  const resolvePreviewAnchorSec = () => {
    const duration = resolvePreviewDurationSec()
    const visibleDuration = resolveVisibleDurationSec()
    if (!duration || !visibleDuration) return 0
    const anchorSec =
      options.previewStartSec.value + visibleDuration * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    return options.allowNegativeTimeline()
      ? Math.min(Number.isFinite(anchorSec) ? anchorSec : 0, duration)
      : clampNumber(anchorSec, 0, duration)
  }

  const clampPreviewStart = (value: number) =>
    clampHorizontalBrowsePreviewStartByVisibleDuration(
      value,
      resolvePreviewDurationSec(),
      resolveVisibleDurationSec(),
      options.allowNegativeTimeline()
    )

  const resolveSnappedRenderStartSec = (visibleDuration: number) => {
    const clampedStart = clampPreviewStart(options.previewStartSec.value)
    if (visibleDuration <= 0) return clampedStart
    return clampedStart
  }

  const resolvePlaybackDrivenRenderStartSec = (visibleDuration: number) => {
    if (!options.playing.value || options.dragging.value) {
      return resolveSnappedRenderStartSec(visibleDuration)
    }
    return resolvePlaybackAlignedStart(Number(options.currentSeconds()) || 0)
  }

  const resolveWaveformLayout = (): HorizontalBrowseWaveformLayout => options.waveformLayout()

  // visibleDurationOverrideSec：tempo 预览过渡期，stable canvas 需按“当前显示帧自身密度”对应的
  // 可见时长来定位播放头（而非当前 rate 的可见时长），否则旧密度帧被以当前 rate 的 visibleDuration
  // 对齐，屏幕 50% 会偏离真实播放头，松手换新密度帧时回弹成横跳。普通播放两者相等，行为不变。
  const resolvePlaybackAlignedStart = (seconds: number, visibleDurationOverrideSec?: number) => {
    const visibleDuration =
      visibleDurationOverrideSec != null &&
      Number.isFinite(visibleDurationOverrideSec) &&
      visibleDurationOverrideSec > 0
        ? visibleDurationOverrideSec
        : resolveVisibleDurationSec()
    return resolveHorizontalBrowsePlaybackAlignedStart(
      seconds,
      resolvePreviewDurationSec(),
      visibleDuration,
      options.allowNegativeTimeline()
    )
  }

  return {
    resolvePreviewTimeScale,
    resolvePreviewDurationSec,
    canShowTimelinePlaceholder,
    resolveVisibleDurationSec,
    resolvePreviewAnchorSec,
    clampPreviewStart,
    resolveSnappedRenderStartSec,
    resolvePlaybackDrivenRenderStartSec,
    resolveWaveformLayout,
    resolvePlaybackAlignedStart
  }
}
