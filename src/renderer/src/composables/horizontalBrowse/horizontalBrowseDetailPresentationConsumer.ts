import type { Ref } from 'vue'
import {
  HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
  HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC
} from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { normalizeHorizontalBrowseSharedZoom } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailMath'
import type { HorizontalBrowseSharedZoomState } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailTypes'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseWaveformPresentationState } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformPresentationCoordinator'
import {
  resolveHorizontalBrowseLoopPlaybackSeconds,
  type HorizontalBrowseLoopClockRange
} from '@shared/horizontalBrowseLoopClock'

type DeckKey = HorizontalBrowseDeckKey

type DetailPresentationConsumerParams = {
  deck: () => DeckKey
  direction: () => 'up' | 'down'
  presentationState: () => HorizontalBrowseWaveformPresentationState | undefined
  previewZoom: Ref<number>
  previewMaxZoom: Ref<number>
  previewStartSec: Ref<number>
  waveformPlaybackActive: () => boolean
  loopRange?: () => HorizontalBrowseLoopClockRange | null | undefined
  resolveWaveformCurrentSeconds: () => number
  resolveWaveformPlaybackRate: () => number
  resolveVisibleDurationSec: () => number
  clampPreviewStart: (seconds: number) => number
  resetGridRenderer: () => void
  maybeContinueWaveformSource: (anchorSec?: number) => void
  setLastAppliedPreviewTimeScale: (value: number) => void
  applyGridTimeBasis: (
    gridTimeBasis: NonNullable<HorizontalBrowseWaveformPresentationState['gridTimeBasis']>
  ) => void
  drawWaveformNow: (options?: { preferPreviewStart?: boolean; viewportOnly?: boolean }) => void
  schedulePlaybackStableFrameRender: () => void
  clearPlaybackStableFrameRenderTimer: () => void
  reanchorStableCanvasPlayback: (
    seconds: number,
    playbackRate: number,
    options?: { startedAtMs?: number }
  ) => void
  scheduleDraw: (options?: { preferPreviewStart?: boolean; viewportOnly?: boolean }) => void
  applyPresentationSeekTarget: (seconds: number, revision: number) => void
}

type ZoomTarget = {
  value: number | null | undefined
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  anchorSec?: number | null
  viewportStartSec?: number | null
  presentationState?: HorizontalBrowseWaveformPresentationState
}

const isFiniteNumber = (value: unknown): value is number =>
  value !== null && value !== undefined && Number.isFinite(Number(value))

const isZoomOwner = (state: HorizontalBrowseWaveformPresentationState | undefined) =>
  state?.owner === 'zoom' || state?.owner === 'linked-zoom'

const isDragOwner = (state: HorizontalBrowseWaveformPresentationState | undefined) =>
  state?.owner === 'drag' || state?.owner === 'linked-drag'

const isCommittedLinkedPlaybackOwner = (
  state: HorizontalBrowseWaveformPresentationState | undefined
) => state?.owner === 'linked-playback' && state.linked === true && state.visualPending === false

const isPlaybackHandoffOwner = (
  state: HorizontalBrowseWaveformPresentationState | undefined,
  deck: DeckKey
) =>
  state?.owner === 'playback' &&
  state.linked === false &&
  state.visualPending === false &&
  state.sourceDeck === null &&
  state.affectedDecks.includes(deck)

const resolveDeckDirection = (deck: DeckKey | null): 'up' | 'down' | null =>
  deck === 'top' ? 'up' : deck === 'bottom' ? 'down' : null

const resolvePlaybackClockSeconds = (
  playbackClock: HorizontalBrowseWaveformPresentationState['playbackClock'],
  loopRange?: HorizontalBrowseLoopClockRange | null
) => {
  if (!playbackClock) return null
  const seconds = Number(playbackClock.seconds)
  const startedAtMs = Number(playbackClock.startedAtMs)
  if (!Number.isFinite(seconds) || !Number.isFinite(startedAtMs)) return null
  const elapsedSec = Math.max(0, performance.now() - startedAtMs) / 1000
  const playbackRate = Math.max(0.25, Number(playbackClock.playbackRate) || 1)
  return resolveHorizontalBrowseLoopPlaybackSeconds(seconds + elapsedSec * playbackRate, loopRange)
}

const PLAYBACK_ZOOM_CLOCK_DRIFT_TOLERANCE_SEC = 0.25

export const createHorizontalBrowseDetailPresentationConsumer = (
  params: DetailPresentationConsumerParams
) => {
  let consumedPresentationRevision = 0

  const applyZoomTarget = (target: ZoomTarget) => {
    const numeric = Number(target.value)
    if (!Number.isFinite(numeric) || numeric <= 0) return
    const direction = params.direction()
    const nextZoom = normalizeHorizontalBrowseSharedZoom(
      {
        value: numeric,
        anchorRatio: target.anchorRatio,
        sourceDirection: target.sourceDirection,
        revision: 0
      },
      params.previewMaxZoom.value
    )
    const sameSourceZoom =
      target.sourceDirection === direction &&
      Math.abs(nextZoom - params.previewZoom.value) <= 0.000001
    if (sameSourceZoom && !params.waveformPlaybackActive()) return
    const playbackZoomActive = params.waveformPlaybackActive()
    const anchorRatio = Math.max(0, Math.min(1, Number(target.anchorRatio) || 0))
    const sourceOwnsDeck = target.sourceDirection === direction
    const playbackClock = target.presentationState?.playbackClock ?? null
    const rawPlaybackClockSeconds = playbackZoomActive
      ? resolvePlaybackClockSeconds(playbackClock, params.loopRange?.())
      : null
    const waveformCurrentSeconds = params.resolveWaveformCurrentSeconds()
    const playbackClockDriftSec =
      rawPlaybackClockSeconds !== null ? rawPlaybackClockSeconds - waveformCurrentSeconds : null
    const playbackClockTrusted =
      rawPlaybackClockSeconds !== null &&
      Math.abs(playbackClockDriftSec ?? 0) <= PLAYBACK_ZOOM_CLOCK_DRIFT_TOLERANCE_SEC
    const playbackClockSeconds = playbackClockTrusted ? rawPlaybackClockSeconds : null
    const targetAnchorSec =
      !playbackZoomActive && sourceOwnsDeck && isFiniteNumber(target.anchorSec)
        ? Number(target.anchorSec)
        : null
    const targetViewportStartSec =
      !playbackZoomActive && sourceOwnsDeck && isFiniteNumber(target.viewportStartSec)
        ? Number(target.viewportStartSec)
        : null
    const previousVisible = params.resolveVisibleDurationSec()
    const anchorSec = playbackZoomActive
      ? (playbackClockSeconds ?? waveformCurrentSeconds)
      : targetAnchorSec !== null
        ? targetAnchorSec
        : params.previewStartSec.value + previousVisible * anchorRatio
    params.previewZoom.value = nextZoom
    const nextVisible = params.resolveVisibleDurationSec()
    const nextAnchorRatio = playbackZoomActive
      ? HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
      : anchorRatio
    params.previewStartSec.value = params.clampPreviewStart(
      targetViewportStartSec ?? anchorSec - nextVisible * nextAnchorRatio
    )
    params.resetGridRenderer()
    params.maybeContinueWaveformSource(anchorSec)
    if (playbackZoomActive) {
      params.clearPlaybackStableFrameRenderTimer()
      params.drawWaveformNow({ preferPreviewStart: true })
      if (playbackClockTrusted && playbackClock) {
        params.reanchorStableCanvasPlayback(playbackClock.seconds, playbackClock.playbackRate, {
          startedAtMs: playbackClock.startedAtMs
        })
      } else {
        params.reanchorStableCanvasPlayback(anchorSec, params.resolveWaveformPlaybackRate())
      }
    } else {
      params.clearPlaybackStableFrameRenderTimer()
      params.scheduleDraw({ preferPreviewStart: true, viewportOnly: true })
    }
  }

  const applyCommittedLinkedPlaybackState = (state: HorizontalBrowseWaveformPresentationState) => {
    if (state.gridTimeBasis) {
      params.applyGridTimeBasis(state.gridTimeBasis)
    }
    const stateTimeScale = Math.max(0.25, Number(state.timeScale) || 1)
    params.setLastAppliedPreviewTimeScale(stateTimeScale)
    if (isFiniteNumber(state.visibleDurationSec) && Number(state.visibleDurationSec) > 0) {
      const targetZoom =
        (HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC * stateTimeScale) /
        Number(state.visibleDurationSec)
      params.previewZoom.value = normalizeHorizontalBrowseSharedZoom(
        targetZoom,
        params.previewMaxZoom.value
      )
    }
    const nextVisible = params.resolveVisibleDurationSec()
    const anchorRatio = Math.max(0, Math.min(1, Number(state.anchorRatio) || 0.5))
    const playbackClockSeconds = params.waveformPlaybackActive()
      ? resolvePlaybackClockSeconds(state.playbackClock, params.loopRange?.())
      : null
    const anchorSec =
      playbackClockSeconds !== null
        ? playbackClockSeconds
        : isFiniteNumber(state.anchorSec)
          ? Number(state.anchorSec)
          : params.resolveWaveformCurrentSeconds()
    const viewportStartSec =
      playbackClockSeconds === null && isFiniteNumber(state.viewportStartSec)
        ? Number(state.viewportStartSec)
        : anchorSec - nextVisible * anchorRatio
    params.previewStartSec.value = params.clampPreviewStart(viewportStartSec)
    params.resetGridRenderer()
    params.maybeContinueWaveformSource(anchorSec)
    if (params.waveformPlaybackActive()) {
      params.clearPlaybackStableFrameRenderTimer()
      params.drawWaveformNow({ preferPreviewStart: true })
      if (state.playbackClock) {
        params.reanchorStableCanvasPlayback(
          state.playbackClock.seconds,
          state.playbackClock.playbackRate,
          { startedAtMs: state.playbackClock.startedAtMs }
        )
      }
    } else {
      params.clearPlaybackStableFrameRenderTimer()
      params.scheduleDraw({ preferPreviewStart: true, viewportOnly: true })
    }
  }

  const applyPlaybackHandoffState = (state: HorizontalBrowseWaveformPresentationState) => {
    const playbackActive = params.waveformPlaybackActive()
    const anchorSec = playbackActive
      ? params.resolveWaveformCurrentSeconds()
      : isFiniteNumber(state.anchorSec)
        ? Number(state.anchorSec)
        : params.resolveWaveformCurrentSeconds()
    const nextVisible = params.resolveVisibleDurationSec()
    params.previewStartSec.value = params.clampPreviewStart(
      anchorSec - nextVisible * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    )
    params.resetGridRenderer()
    params.maybeContinueWaveformSource(anchorSec)
    params.clearPlaybackStableFrameRenderTimer()
    if (playbackActive) {
      params.drawWaveformNow({ preferPreviewStart: true })
      params.reanchorStableCanvasPlayback(anchorSec, params.resolveWaveformPlaybackRate())
      return
    }
    params.scheduleDraw({ preferPreviewStart: true, viewportOnly: true })
  }

  const handleSharedZoomState = (state: HorizontalBrowseSharedZoomState | undefined) => {
    if (isZoomOwner(params.presentationState())) return
    applyZoomTarget({
      value: state?.value,
      anchorRatio: Number(state?.anchorRatio ?? HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO),
      sourceDirection: state?.sourceDirection ?? null
    })
  }

  const handlePresentationState = (
    state: HorizontalBrowseWaveformPresentationState | undefined
  ) => {
    if (!state || state.revision <= consumedPresentationRevision) return
    consumedPresentationRevision = state.revision
    if (
      state.owner === 'seek' &&
      state.sourceDeck === params.deck() &&
      isFiniteNumber(state.anchorSec)
    ) {
      params.applyPresentationSeekTarget(Number(state.anchorSec), state.revision)
      return
    }
    if (isZoomOwner(state)) {
      applyZoomTarget({
        value: state.zoom,
        anchorRatio: state.anchorRatio,
        sourceDirection: resolveDeckDirection(state.sourceDeck),
        anchorSec: state.anchorSec,
        viewportStartSec: state.viewportStartSec,
        presentationState: state
      })
      return
    }
    if (state.owner === 'sync-transaction' && state.visualPending) {
      return
    }
    if (isCommittedLinkedPlaybackOwner(state)) {
      applyCommittedLinkedPlaybackState(state)
      return
    }
    if (isPlaybackHandoffOwner(state, params.deck())) {
      applyPlaybackHandoffState(state)
      return
    }
    if (isDragOwner(state)) {
      return
    }
    if (state.owner === 'idle' || state.owner === 'playback') {
      return
    }
  }

  return {
    handleSharedZoomState,
    handlePresentationState
  }
}
