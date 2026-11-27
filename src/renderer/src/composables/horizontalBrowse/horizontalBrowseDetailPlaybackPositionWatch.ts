import { watch, type Ref } from 'vue'
import { startHorizontalBrowseUserTiming } from '@renderer/composables/horizontalBrowse/horizontalBrowseUserTiming'
import {
  STABLE_PLAYBACK_POSITION_JUMP_SEC,
  prepareHorizontalBrowseStableCanvasJump
} from '@renderer/composables/horizontalBrowse/horizontalBrowseStableCanvasJump'
import type { HorizontalBrowseDragReleaseHandoffKind } from '@renderer/composables/horizontalBrowse/horizontalBrowseDragReleaseHandoff'
import type { HorizontalBrowseStableCanvasPresentationMeasureResult } from '@renderer/composables/horizontalBrowse/horizontalBrowseStableCanvasPresentation'

type PlaybackDiscontinuityDetector = {
  reset: () => void
  check: (
    songKey: string,
    seconds: number,
    playing: boolean,
    playbackRate: number | undefined,
    normalizeSeconds: (seconds: number) => number
  ) => boolean
}

type DragReleaseHandoff = {
  consume: (kind: HorizontalBrowseDragReleaseHandoffKind, seconds: number) => boolean
  matches: (seconds: number) => boolean
}

type DetailPlaybackPositionWatchParams = {
  direction: () => 'up' | 'down'
  currentSeconds: () => number | undefined
  playbackActive: () => boolean
  songKey: () => string
  playbackSyncRevision: () => number
  seekRevision: () => number | undefined
  seekTargetSeconds: () => number | undefined
  playbackRate: () => number | undefined
  linkedGridActive: () => boolean
  linkedGridVisualPending: () => boolean
  linkedGridVisualTransactionCommitted: () => boolean
  setLinkedGridVisualTransactionCommitted: (value: boolean) => void
  dragging: Ref<boolean>
  compactVisualWaveformActive: Ref<boolean>
  dragPresentationReleaseActive: Ref<boolean>
  syncDragPresentationReleaseViewportStart: (seconds: number) => void
  consumeDragPresentationReleaseRequiresFreshFrame: () => boolean
  normalizePreviewTimelineSeconds: (seconds: number) => number
  playbackDiscontinuityDetector: PlaybackDiscontinuityDetector
  applyPreviewPlaybackPosition: (
    seconds: number,
    scheduleFrame?: boolean,
    resetDiscontinuity?: boolean,
    forcePlaybackStart?: boolean
  ) => void
  dragReleaseHandoff: DragReleaseHandoff
  applyStablePresentationSeekTarget: (seconds: number) => boolean
  startStableSeekSyncHandoff: (revision: number, seconds: number) => void
  isStableSeekSyncHandoffActive: (revision: number, seconds: number) => boolean
  forceRenderStableSeekTarget: (seconds: number) => void
  isStablePlaybackToggleRenderHeld: () => boolean
  stopStableCanvasPlayback: () => void
  consumeDragReleaseStablePresentationOffsetLimit: (seconds: number) => number | undefined
  measureStableCanvasPresentation: (
    seconds?: number
  ) => HorizontalBrowseStableCanvasPresentationMeasureResult
  adoptStableCanvasRenderRevision: (seconds: number) => boolean
  hideStableCanvasPresentation: () => void
  applyStableCanvasPresentation: (
    seconds: number,
    options?: {
      allowReanchor?: boolean
      requirePresentable?: boolean
      allowRevisionHandoff?: boolean
    }
  ) => { applied: boolean }
  reanchorStableCanvasPlayback: (seconds: number, playbackRate: number) => void
  resolveWaveformPlaybackRate: () => number
  maybeContinueWaveformSource: (anchorSec?: number) => void
  stablePlaybackReanchorCanReanchor: () => boolean
}

export const watchHorizontalBrowseDetailPlaybackPosition = (
  params: DetailPlaybackPositionWatchParams
) =>
  watch(
    () =>
      [
        Number(params.currentSeconds()) || 0,
        params.playbackActive(),
        params.songKey(),
        params.playbackSyncRevision(),
        Number(params.seekRevision()) || 0,
        Number(params.seekTargetSeconds()) || 0,
        params.linkedGridVisualPending(),
        params.dragPresentationReleaseActive.value
      ] as const,
    (
      [
        seconds,
        playing,
        songKey,
        syncRevision,
        seekRevision,
        seekTargetSeconds,
        linkedGridVisualPending,
        dragPresentationReleaseActive
      ],
      previousValue
    ) => {
      const finishTiming = startHorizontalBrowseUserTiming(
        `frkb:hb:detail:current-seconds:${params.direction()}`
      )
      try {
        if (params.dragging.value) return
        const safeSongKey = String(songKey || '').trim()
        const safeSeconds = params.normalizePreviewTimelineSeconds(seconds)
        if (!safeSongKey) {
          params.playbackDiscontinuityDetector.reset()
          params.applyPreviewPlaybackPosition(0)
          return
        }
        const previousPlaying = Boolean(previousValue?.[1])
        const previousSongKey = String(previousValue?.[2] || '').trim()
        const previousSyncRevision = Math.max(0, Math.floor(Number(previousValue?.[3]) || 0))
        const previousSeekRevision = Math.max(0, Math.floor(Number(previousValue?.[4]) || 0))
        const previousLinkedGridVisualPending = Boolean(previousValue?.[6])
        const previousDragPresentationReleaseActive = Boolean(previousValue?.[7])
        const resumedFromLinkedGridVisualPending =
          previousLinkedGridVisualPending && !linkedGridVisualPending
        const dragPresentationReleaseCompleted =
          previousDragPresentationReleaseActive && !dragPresentationReleaseActive
        let dragPresentationReleaseRequiresFreshFrame = false
        const linkedGridActive = params.linkedGridActive()
        const playbackSyncChanged =
          !linkedGridActive &&
          (syncRevision !== previousSyncRevision || resumedFromLinkedGridVisualPending)
        const safeSeekRevision = Math.max(0, Math.floor(Number(seekRevision) || 0))
        const safeSeekTargetSeconds = params.normalizePreviewTimelineSeconds(seekTargetSeconds)
        const seekRevisionChanged =
          previousValue !== undefined &&
          safeSeekRevision > 0 &&
          safeSeekRevision !== previousSeekRevision
        if (linkedGridVisualPending) {
          return
        }
        if (resumedFromLinkedGridVisualPending && params.linkedGridVisualTransactionCommitted()) {
          params.setLinkedGridVisualTransactionCommitted(false)
          return
        }
        params.setLinkedGridVisualTransactionCommitted(false)
        const songChanged = safeSongKey !== previousSongKey
        const linkedGridPlaybackStarted = linkedGridActive && playing && !previousPlaying
        if (
          playbackSyncChanged &&
          params.dragReleaseHandoff.consume('playback-sync', safeSeconds)
        ) {
          params.applyPreviewPlaybackPosition(safeSeconds, false)
          if (dragPresentationReleaseActive) {
            params.syncDragPresentationReleaseViewportStart(safeSeconds)
          }
          return
        }
        if (
          seekRevisionChanged &&
          params.compactVisualWaveformActive.value &&
          !params.dragReleaseHandoff.matches(safeSeekTargetSeconds)
        ) {
          if (params.applyStablePresentationSeekTarget(safeSeekTargetSeconds)) {
            return
          }
          params.startStableSeekSyncHandoff(safeSeekRevision, safeSeekTargetSeconds)
          params.forceRenderStableSeekTarget(safeSeekTargetSeconds)
          return
        }
        const stableSeekSyncHandoffActive =
          params.compactVisualWaveformActive.value &&
          params.isStableSeekSyncHandoffActive(safeSeekRevision, safeSeconds)
        if (dragPresentationReleaseActive) {
          params.applyPreviewPlaybackPosition(safeSeconds, false)
          params.syncDragPresentationReleaseViewportStart(safeSeconds)
          return
        }
        dragPresentationReleaseRequiresFreshFrame = dragPresentationReleaseCompleted
          ? params.consumeDragPresentationReleaseRequiresFreshFrame()
          : false
        const previousSeconds = params.normalizePreviewTimelineSeconds(
          Number(previousValue?.[0]) || 0
        )
        const playbackPositionChanged =
          previousValue === undefined || Math.abs(safeSeconds - previousSeconds) > 0.0001
        const rawPlaybackClockJumped = params.playbackDiscontinuityDetector.check(
          safeSongKey,
          safeSeconds,
          playing,
          params.playbackRate(),
          params.normalizePreviewTimelineSeconds
        )
        const pausedPositionJumped =
          !playing &&
          previousValue !== undefined &&
          Math.abs(safeSeconds - previousSeconds) > STABLE_PLAYBACK_POSITION_JUMP_SEC
        const playbackPositionJumped =
          (!linkedGridActive && rawPlaybackClockJumped) || pausedPositionJumped
        if (
          stableSeekSyncHandoffActive &&
          (playbackSyncChanged || playbackPositionJumped || songChanged)
        ) {
          params.forceRenderStableSeekTarget(safeSeconds)
          return
        }
        const stablePlaybackToggleHeld =
          params.compactVisualWaveformActive.value && params.isStablePlaybackToggleRenderHeld()
        const shouldBypassStablePlaybackToggleHold =
          playbackSyncChanged || playbackPositionJumped || songChanged || linkedGridPlaybackStarted
        if (
          stablePlaybackToggleHeld &&
          !dragPresentationReleaseCompleted &&
          !shouldBypassStablePlaybackToggleHold
        ) {
          return
        }
        const requirePresentable =
          playbackSyncChanged ||
          playbackPositionJumped ||
          songChanged ||
          linkedGridPlaybackStarted ||
          dragPresentationReleaseCompleted
        if (
          dragPresentationReleaseCompleted &&
          dragPresentationReleaseRequiresFreshFrame &&
          params.compactVisualWaveformActive.value
        ) {
          params.consumeDragReleaseStablePresentationOffsetLimit(safeSeconds)
          if (playing) params.stopStableCanvasPlayback()
          params.hideStableCanvasPresentation()
          params.applyPreviewPlaybackPosition(safeSeconds, true, true)
          return
        }
        if (params.compactVisualWaveformActive.value && requirePresentable) {
          const maxOffsetCssPx = params.consumeDragReleaseStablePresentationOffsetLimit(safeSeconds)
          if (dragPresentationReleaseCompleted && maxOffsetCssPx === Number.POSITIVE_INFINITY) {
            params.adoptStableCanvasRenderRevision(safeSeconds)
          }
          const canReuseStableFrame = prepareHorizontalBrowseStableCanvasJump({
            seconds: safeSeconds,
            measure: params.measureStableCanvasPresentation,
            hide: params.hideStableCanvasPresentation,
            maxOffsetCssPx
          })
          if (!canReuseStableFrame) {
            if (playing) params.stopStableCanvasPlayback()
            params.applyPreviewPlaybackPosition(safeSeconds, true, true)
            return
          }
        }
        if (params.compactVisualWaveformActive.value && playing) {
          if (requirePresentable) {
            const result = params.applyStableCanvasPresentation(safeSeconds, {
              allowReanchor:
                previousPlaying === true &&
                !playbackSyncChanged &&
                !playbackPositionJumped &&
                params.stablePlaybackReanchorCanReanchor(),
              requirePresentable
            })
            if (result.applied) {
              params.reanchorStableCanvasPlayback(safeSeconds, params.resolveWaveformPlaybackRate())
            }
            params.applyPreviewPlaybackPosition(safeSeconds, !result.applied, true)
          }
          return
        }
        if (params.compactVisualWaveformActive.value) {
          params.stopStableCanvasPlayback()
          const result = params.applyStableCanvasPresentation(safeSeconds)
          params.applyPreviewPlaybackPosition(safeSeconds, !result.applied)
          return
        }
        params.maybeContinueWaveformSource(safeSeconds)
        params.applyPreviewPlaybackPosition(
          safeSeconds,
          (!playing && playbackPositionChanged) ||
            params.dragging.value ||
            playing !== previousPlaying ||
            songChanged ||
            playbackSyncChanged ||
            playbackPositionJumped
        )
      } finally {
        finishTiming()
      }
    }
  )
