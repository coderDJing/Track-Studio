import { watch, type Ref } from 'vue'
import type { HorizontalBrowseStableCanvasPresentationMeasureResult } from '@renderer/composables/horizontalBrowse/horizontalBrowseStableCanvasPresentation'

type PlaybackToggleWatchParams = {
  playbackActive: () => boolean
  previewPlaying: Ref<boolean>
  linkedGridVisualPending: () => boolean
  dragging: Ref<boolean>
  compactVisualWaveformActive: Ref<boolean>
  resolveStableWaveformSource: () => boolean
  dragPresentationReleaseActive: Ref<boolean>
  resolveCurrentSeconds: () => number
  resolvePlaybackRate: () => number
  stopLiveWaveformPlayback: (stableWaveformSource: boolean) => void
  stopStableCanvasPlayback: () => void
  suppressStablePlaybackReanchor: () => void
  holdStablePlaybackToggleRender: () => void
  measureStableCanvasPresentation: (
    seconds?: number
  ) => HorizontalBrowseStableCanvasPresentationMeasureResult
  shouldRenderStableCanvasForPlaybackToggle: (
    measureResult: HorizontalBrowseStableCanvasPresentationMeasureResult
  ) => boolean
  applyPreviewPlaybackPosition: (
    seconds: number,
    scheduleFrame?: boolean,
    resetDiscontinuity?: boolean,
    forcePlaybackStart?: boolean
  ) => void
  freezeStableCanvasPlaybackTogglePosition: (seconds: number) => number
  startStableCanvasPlayback: (seconds: number, playbackRate: number) => void
  maybeContinueWaveformSource: (anchorSec?: number) => void
}

export const watchHorizontalBrowseRawWaveformPlaybackToggle = (params: PlaybackToggleWatchParams) =>
  watch(
    params.playbackActive,
    (playing, previousPlaying) => {
      params.previewPlaying.value = playing
      if (params.linkedGridVisualPending()) return
      if (params.dragging.value) {
        if (!playing && previousPlaying === true) {
          const stableWaveformSource = params.compactVisualWaveformActive.value
          params.stopLiveWaveformPlayback(stableWaveformSource)
          if (stableWaveformSource) params.stopStableCanvasPlayback()
        }
        return
      }
      const toggleAnchorSec = params.resolveCurrentSeconds()
      if (playing) {
        if (params.compactVisualWaveformActive.value) {
          if (params.dragPresentationReleaseActive.value) {
            params.suppressStablePlaybackReanchor()
            params.holdStablePlaybackToggleRender()
            if (!params.resolveStableWaveformSource()) {
              params.applyPreviewPlaybackPosition(toggleAnchorSec)
            }
            return
          }
          params.suppressStablePlaybackReanchor()
          const measured = params.measureStableCanvasPresentation(toggleAnchorSec)
          if (params.shouldRenderStableCanvasForPlaybackToggle(measured)) {
            params.holdStablePlaybackToggleRender()
            params.applyPreviewPlaybackPosition(toggleAnchorSec, true, true, false)
            return
          }
          const visualAnchorSec = params.freezeStableCanvasPlaybackTogglePosition(toggleAnchorSec)
          params.holdStablePlaybackToggleRender()
          params.startStableCanvasPlayback(visualAnchorSec, params.resolvePlaybackRate())
          return
        }
        params.applyPreviewPlaybackPosition(toggleAnchorSec, true)
        params.maybeContinueWaveformSource(toggleAnchorSec)
        return
      }
      const stableWaveformSource = params.compactVisualWaveformActive.value
      if (previousPlaying === true) params.stopLiveWaveformPlayback(stableWaveformSource)
      if (stableWaveformSource) {
        params.stopStableCanvasPlayback()
        const measured = params.measureStableCanvasPresentation(toggleAnchorSec)
        if (params.shouldRenderStableCanvasForPlaybackToggle(measured)) {
          params.holdStablePlaybackToggleRender()
          params.applyPreviewPlaybackPosition(toggleAnchorSec, true, true, false)
          return
        }
        params.freezeStableCanvasPlaybackTogglePosition(toggleAnchorSec)
        params.holdStablePlaybackToggleRender()
        return
      }
      params.applyPreviewPlaybackPosition(toggleAnchorSec, true)
      params.maybeContinueWaveformSource(toggleAnchorSec)
    },
    { immediate: true, flush: 'sync' }
  )
