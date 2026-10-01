import { onMounted, onUnmounted, watch } from 'vue'
import { clampNumber } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import type {
  HorizontalBrowseRawWaveformDetailProps,
  HorizontalBrowseSharedZoomState
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailTypes'
import type { HorizontalBrowseWaveformPresentationState } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformPresentationCoordinator'
import { watchHorizontalBrowseDetailPlaybackPosition } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailPlaybackPositionWatch'
import { watchHorizontalBrowseRawWaveformPlaybackToggle } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformPlaybackToggleWatch'

type ReadonlyValue<T> = Readonly<{ value: T }>
type PlaybackToggleWatchParams = Parameters<
  typeof watchHorizontalBrowseRawWaveformPlaybackToggle
>[0]
type PlaybackPositionWatchParams = Parameters<typeof watchHorizontalBrowseDetailPlaybackPosition>[0]

type HorizontalBrowseRawWaveformDetailLifecycleState = {
  presentationLinkedGridVisualPending: ReadonlyValue<boolean>
  presentationLinkedGridActive: ReadonlyValue<boolean>
  visualGridRenderBpm: ReadonlyValue<number>
  visualGridFirstBeatMs: ReadonlyValue<number>
  visualGridDownbeatBeatOffset: ReadonlyValue<number>
  waveformPlaybackActive: ReadonlyValue<boolean>
  compactVisualWaveformActive: ReadonlyValue<boolean>
  canAdjustGrid: ReadonlyValue<boolean>
  canAdjustBpmInput: ReadonlyValue<boolean>
  previewBpm: ReadonlyValue<number>
  previewRenderBpm: ReadonlyValue<number>
  previewFirstBeatMs: ReadonlyValue<number>
  previewDownbeatBeatOffset: ReadonlyValue<number>
  previewTimeBasisOffsetMs: ReadonlyValue<number>
  metronomeEnabled: ReadonlyValue<boolean>
  metronomeVolumeLevel: ReadonlyValue<number>
  canToggleMetronome: ReadonlyValue<boolean>
}

type HorizontalBrowseRawWaveformDetailMountActions = {
  mountWaveformCanvasWorker: () => void
  resolveWrapElement: () => Element | null
  invalidateWaveformTiles: (options?: { preserveDisplay?: boolean }) => void
  resetGridRenderer: () => void
  emitToolbarState: () => void
  scheduleDraw: () => void
}

type HorizontalBrowseRawWaveformDetailUnmountActions = {
  invalidateLoad: () => void
  resetCompactVisualWaveformStrip: () => void
  clearPersistTimer: () => void
  clearBpmTapResetTimer: () => void
  clearPlaybackStableFrameRenderTimer: () => void
  clearStableSeekRenderRaf: () => void
  stopDragging: (commit: boolean, emitEvent: boolean) => void
  disposeWaveformCanvas: () => void
  disposeCompactVisualWaveformStrip: () => void
}

type HorizontalBrowseRawWaveformDetailLifecycleParams = {
  props: Readonly<HorizontalBrowseRawWaveformDetailProps>
  state: HorizontalBrowseRawWaveformDetailLifecycleState
  runtimeThemeMode: () => unknown
  resolveWaveformLayout: () => string
  resolveWaveformRenderStyle: () => string
  resolveDetailDeck: () => 'top' | 'bottom'
  loadWaveform: () => Promise<void>
  buildSongGridSignature: () => string
  shouldDeferSongGridSync: (songGridSignature?: string) => boolean
  syncGridStateFromSongForDisplay: () => void
  emitToolbarState: () => void
  scheduleGridOverlayDraw: () => void
  scheduleDraw: () => void
  invalidateWaveformTiles: (options?: { preserveDisplay?: boolean }) => void
  resetGridRenderer: () => void
  publishLinkedGridVisualPhaseSample: () => void
  resolveIncomingPreviewTimeScale: () => number
  liveTempoPreviewActive: () => boolean
  applyIncomingPreviewTimeScale: () => void
  handleSharedZoomState: (state: HorizontalBrowseSharedZoomState | undefined) => void
  handlePresentationState: (state: HorizontalBrowseWaveformPresentationState | undefined) => void
  applyPresentationSeekTarget: (targetSeconds: number, revision: number) => void
  syncVisualGridStateFromPreview: () => void
  playbackToggleWatch: PlaybackToggleWatchParams
  playbackPositionWatch: PlaybackPositionWatchParams
  mount: HorizontalBrowseRawWaveformDetailMountActions
  unmount: HorizontalBrowseRawWaveformDetailUnmountActions
}

type HorizontalBrowseRawWaveformLoadingWatchParams = {
  previewLoading: ReadonlyValue<boolean>
  emitLoadingChange: (loading: boolean) => void
}

export const watchHorizontalBrowseRawWaveformLoadingChange = (
  params: HorizontalBrowseRawWaveformLoadingWatchParams
) =>
  watch(
    () => params.previewLoading.value,
    () => params.emitLoadingChange(false),
    {
      immediate: true
    }
  )

export const useHorizontalBrowseRawWaveformDetailLifecycle = (
  params: HorizontalBrowseRawWaveformDetailLifecycleParams
) => {
  const { props, state } = params
  let resizeObserver: ResizeObserver | null = null

  watch(
    () => props.song?.filePath ?? '',
    () => {
      void params.loadWaveform()
    },
    { immediate: true }
  )

  watch(
    () => [params.resolveWaveformLayout(), params.resolveWaveformRenderStyle()] as const,
    ([layout, renderStyle], previous) => {
      if (previous && layout === previous[0] && renderStyle === previous[1]) return
      void params.loadWaveform()
    }
  )

  watch(
    () =>
      [
        props.song?.bpm,
        props.song?.firstBeatMs,
        props.song?.downbeatBeatOffset,
        props.song?.beatGridMap?.signature,
        props.song?.timeBasisOffsetMs,
        state.presentationLinkedGridVisualPending.value
      ] as const,
    ([, , , , , linkedGridVisualPending]) => {
      if (linkedGridVisualPending) {
        params.emitToolbarState()
        return
      }
      const songGridSignature = params.buildSongGridSignature()
      if (params.shouldDeferSongGridSync(songGridSignature)) return
      params.syncGridStateFromSongForDisplay()
      if (!linkedGridVisualPending) {
        params.scheduleGridOverlayDraw()
      }
    }
  )

  watch(
    () =>
      [
        Number(props.cueSeconds) || 0,
        props.loopRange?.startSec ?? null,
        props.loopRange?.endSec ?? null,
        props.audioEditSelection?.startSec ?? null,
        props.audioEditSelection?.endSec ?? null,
        props.audioEditPendingStartSec ?? null,
        props.audioEditPendingEndSec ?? null
      ] as const,
    () => {
      params.scheduleDraw()
    }
  )

  watch(
    () => props.hotCues,
    () => {
      params.scheduleDraw()
    },
    { deep: true }
  )

  watch(
    () => props.memoryCues,
    () => {
      params.scheduleDraw()
    },
    { deep: true }
  )

  watch(
    () => props.direction,
    () => {
      params.invalidateWaveformTiles()
      params.resetGridRenderer()
      params.scheduleDraw()
    }
  )

  watch(
    () =>
      [
        state.presentationLinkedGridActive.value,
        props.direction,
        props.song?.filePath ?? '',
        state.visualGridRenderBpm.value,
        state.visualGridFirstBeatMs.value,
        state.visualGridDownbeatBeatOffset.value,
        props.currentSeconds,
        props.playbackRate,
        state.waveformPlaybackActive.value,
        params.resolveWaveformLayout()
      ] as const,
    () => {
      params.publishLinkedGridVisualPhaseSample()
    },
    { immediate: true, flush: 'sync' }
  )

  watch(
    () =>
      [
        params.resolveIncomingPreviewTimeScale(),
        state.presentationLinkedGridVisualPending.value,
        params.liveTempoPreviewActive()
      ] as const,
    ([, linkedGridVisualPending, liveTempoPreviewActive]) => {
      if (linkedGridVisualPending || liveTempoPreviewActive) {
        return
      }
      params.applyIncomingPreviewTimeScale()
    }
  )

  watch(
    () => {
      const numeric = Number(props.waveformGain)
      if (!Number.isFinite(numeric)) return 1
      return clampNumber(numeric, 0, 16)
    },
    () => {
      params.invalidateWaveformTiles({
        preserveDisplay: state.compactVisualWaveformActive.value
      })
      params.scheduleDraw()
    }
  )

  watch(
    () => props.sharedZoomState,
    (sharedZoomState) => {
      params.handleSharedZoomState(sharedZoomState)
    },
    { immediate: true }
  )

  watch(
    () => props.presentationState?.revision ?? 0,
    () => {
      params.handlePresentationState(props.presentationState)
    },
    { immediate: true, flush: 'sync' }
  )

  watchHorizontalBrowseRawWaveformPlaybackToggle(params.playbackToggleWatch)
  watchHorizontalBrowseDetailPlaybackPosition(params.playbackPositionWatch)

  watch(
    () => [Number(props.seekRevision) || 0, Number(props.seekTargetSeconds) || 0] as const,
    ([revision, targetSeconds]) => {
      if (!revision) return
      const presentationState = props.presentationState
      if (
        presentationState?.owner === 'seek' &&
        presentationState.sourceDeck === params.resolveDetailDeck()
      ) {
        return
      }
      params.applyPresentationSeekTarget(targetSeconds, revision)
    }
  )

  watch(
    () => [state.canAdjustGrid.value, state.canAdjustBpmInput.value] as const,
    () => {
      params.emitToolbarState()
    }
  )

  watch(
    () =>
      [
        state.previewBpm.value,
        state.previewRenderBpm.value,
        state.previewFirstBeatMs.value,
        state.previewDownbeatBeatOffset.value,
        state.previewTimeBasisOffsetMs.value,
        state.presentationLinkedGridVisualPending.value
      ] as const,
    ([, , , , , linkedGridVisualPending]) => {
      if (linkedGridVisualPending) {
        params.emitToolbarState()
        return
      }
      params.syncVisualGridStateFromPreview()
      params.scheduleGridOverlayDraw()
      params.emitToolbarState()
    }
  )

  watch(
    () =>
      [
        state.metronomeEnabled.value,
        state.metronomeVolumeLevel.value,
        state.canToggleMetronome.value
      ] as const,
    () => {
      params.emitToolbarState()
    }
  )

  watch(params.runtimeThemeMode, () => {
    params.invalidateWaveformTiles({
      preserveDisplay: state.compactVisualWaveformActive.value
    })
    params.resetGridRenderer()
    params.scheduleDraw()
  })

  onMounted(() => {
    params.mount.mountWaveformCanvasWorker()
    const wrapElement = params.mount.resolveWrapElement()
    if (wrapElement) {
      resizeObserver = new ResizeObserver(() => {
        params.mount.invalidateWaveformTiles()
        params.mount.resetGridRenderer()
        params.mount.scheduleDraw()
      })
      resizeObserver.observe(wrapElement)
    }
    params.mount.emitToolbarState()
    params.mount.scheduleDraw()
  })

  onUnmounted(() => {
    params.unmount.invalidateLoad()
    params.unmount.resetCompactVisualWaveformStrip()
    params.unmount.clearPersistTimer()
    params.unmount.clearBpmTapResetTimer()
    params.unmount.clearPlaybackStableFrameRenderTimer()
    params.unmount.clearStableSeekRenderRaf()
    params.unmount.stopDragging(false, false)
    params.unmount.disposeWaveformCanvas()
    params.unmount.disposeCompactVisualWaveformStrip()
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }
  })
}
