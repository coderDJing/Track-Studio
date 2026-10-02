import type { Ref } from 'vue'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type {
  HorizontalBrowseLinkedGridVisualTransactionCommitOptions,
  HorizontalBrowseLinkedGridVisualTransactionDeckState,
  HorizontalBrowseLinkedGridVisualTransactionGridTimeBasis,
  HorizontalBrowseLinkedGridVisualTransactionResult
} from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedGridVisualTransaction'
import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { clampHorizontalBrowsePreviewStartByVisibleDuration } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailMath'

const STABLE_FRAME_PREPARE_TIMEOUT_MS = 700
const STABLE_FRAME_PREPARE_ANCHOR_EPSILON_SEC = 0.08
const PLAYBACK_STABLE_FRAME_RENDER_DEBOUNCE_MS = 180

type HorizontalBrowseDetailPresentationActionsParams = {
  deck: () => HorizontalBrowseDeckKey
  currentSeconds: () => number | undefined
  compactVisualWaveformActive: Ref<boolean>
  previewStartSec: Ref<number>
  localGridShiftPhaseOffsetSec: Ref<number>
  waveformPlaybackActive: () => boolean
  linkedGridVisualPending: () => boolean
  normalizePreviewTimelineSeconds: (seconds: number) => number
  resolveVisibleDurationSec: () => number
  resolvePreviewDurationSec: () => number
  resolveWaveformCurrentSeconds: () => number
  allowNegativeTimeline: () => boolean
  clampPreviewStart: (seconds: number) => number
  stopStableCanvasPlayback: () => void
  drawWaveformNow: (options?: { preferPreviewStart?: boolean; viewportOnly?: boolean }) => void
  measureStableCanvasPresentation: (seconds?: number) => { frame: { anchorSec: number } | null }
  getLastAppliedPreviewTimeScale: () => number
  setLastAppliedPreviewTimeScale: (value: number) => void
  resolveIncomingPreviewTimeScale: (playbackRate?: number) => number
  resolveWaveformPlaybackRate: () => number
  resolveGridTimeBasis: () => HorizontalBrowseLinkedGridVisualTransactionGridTimeBasis
  invalidateWaveformTiles: (options?: { preserveDisplay?: boolean }) => void
  resetGridRenderer: () => void
  maybeContinueWaveformSource: (anchorSec?: number) => void
  scheduleDraw: (options?: { preferPreviewStart?: boolean; viewportOnly?: boolean }) => void
  syncGridStateFromSong: () => void
  syncVisualGridStateFromPreview: () => void
  applyPreviewPlaybackPosition: (seconds: number, resetDiscontinuity?: boolean) => void
  publishLinkedGridVisualPhaseSample: () => void
  markLinkedGridVisualTransactionCommitted: () => void
}

export const createHorizontalBrowseDetailPresentationActions = (
  params: HorizontalBrowseDetailPresentationActionsParams
) => {
  let playbackStableFrameRenderTimer: ReturnType<typeof setTimeout> | null = null

  const clearPlaybackStableFrameRenderTimer = () => {
    if (!playbackStableFrameRenderTimer) return
    clearTimeout(playbackStableFrameRenderTimer)
    playbackStableFrameRenderTimer = null
  }

  const schedulePlaybackStableFrameRender = () => {
    clearPlaybackStableFrameRenderTimer()
    playbackStableFrameRenderTimer = setTimeout(() => {
      playbackStableFrameRenderTimer = null
      params.scheduleDraw({ preferPreviewStart: true, viewportOnly: true })
    }, PLAYBACK_STABLE_FRAME_RENDER_DEBOUNCE_MS)
  }

  const waitForStableFrameAnchor = async (
    seconds: number,
    timeoutMs = STABLE_FRAME_PREPARE_TIMEOUT_MS
  ) => {
    if (!params.compactVisualWaveformActive.value) return true
    const safeSeconds = params.normalizePreviewTimelineSeconds(seconds)
    const startedAt = performance.now()
    const safeTimeoutMs = Math.max(0, Number(timeoutMs) || 0)
    while (performance.now() - startedAt < safeTimeoutMs) {
      const frame = params.measureStableCanvasPresentation(safeSeconds).frame
      if (
        frame &&
        Math.abs(Number(frame.anchorSec) - safeSeconds) <= STABLE_FRAME_PREPARE_ANCHOR_EPSILON_SEC
      ) {
        return true
      }
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    return false
  }

  const prepareStableFrameForAnchor = async (
    seconds: number,
    options: { timeoutMs?: number } = {}
  ) => {
    if (!params.compactVisualWaveformActive.value) return true
    const safeSeconds = params.normalizePreviewTimelineSeconds(seconds)
    const timeoutMs = Math.max(0, Number(options.timeoutMs ?? STABLE_FRAME_PREPARE_TIMEOUT_MS) || 0)
    params.previewStartSec.value = params.clampPreviewStart(
      safeSeconds - params.resolveVisibleDurationSec() * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    )
    params.stopStableCanvasPlayback()
    params.drawWaveformNow({ preferPreviewStart: true })
    return waitForStableFrameAnchor(safeSeconds, timeoutMs)
  }

  const applyIncomingPreviewTimeScale = (
    scheduleFrame = true,
    options: { keepCurrentFrame?: boolean; forceFrameWhenUnchanged?: boolean } = {}
  ) => {
    const keepCurrentFrame = options.keepCurrentFrame === true
    const safeNextScale = Math.max(0.25, Number(params.resolveIncomingPreviewTimeScale()) || 1)
    const safePreviousScale = Math.max(
      0.25,
      Number(params.getLastAppliedPreviewTimeScale()) || safeNextScale
    )
    const nextVisible = params.resolveVisibleDurationSec()
    const previousVisible = Math.max(0.001, nextVisible * (safePreviousScale / safeNextScale))
    if (
      Math.abs(safeNextScale - safePreviousScale) <= 0.000001 &&
      Math.abs(nextVisible - previousVisible) <= 0.0001
    ) {
      if (options.forceFrameWhenUnchanged && scheduleFrame) {
        params.maybeContinueWaveformSource(params.resolveWaveformCurrentSeconds())
        clearPlaybackStableFrameRenderTimer()
        params.scheduleDraw({ preferPreviewStart: true, viewportOnly: true })
        return true
      }
      return false
    }
    params.setLastAppliedPreviewTimeScale(safeNextScale)
    const playbackTimeScaleActive = params.waveformPlaybackActive()
    // 播放头（暂停态=currentSeconds，播放态同理）锚定在屏幕固定比例 RATIO，波形绕播放头缩放，
    // 保证换密度时播放头屏幕位置不动。横向跳的真凶在 canvas translate 层，不在此处 rangeStart。
    const anchorSec = playbackTimeScaleActive
      ? params.resolveWaveformCurrentSeconds()
      : params.previewStartSec.value + previousVisible * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    params.previewStartSec.value = params.clampPreviewStart(
      anchorSec - nextVisible * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    )
    if (!keepCurrentFrame) {
      params.invalidateWaveformTiles({ preserveDisplay: params.compactVisualWaveformActive.value })
      params.resetGridRenderer()
    }
    params.maybeContinueWaveformSource(anchorSec)
    if (scheduleFrame) {
      clearPlaybackStableFrameRenderTimer()
      params.scheduleDraw({ preferPreviewStart: true, viewportOnly: true })
      if (
        !keepCurrentFrame &&
        playbackTimeScaleActive &&
        params.compactVisualWaveformActive.value
      ) {
        schedulePlaybackStableFrameRender()
      }
    }
    return true
  }

  const resolveVisibleDurationSecForTimeScale = (timeScale: number) => {
    const safeNextScale = Math.max(0.25, Number(timeScale) || 1)
    const safePreviousScale = Math.max(
      0.25,
      Number(params.getLastAppliedPreviewTimeScale()) || safeNextScale
    )
    const currentVisibleDurationSec = Math.max(
      0.001,
      Number(params.resolveVisibleDurationSec()) || 0
    )
    return Math.max(0.001, currentVisibleDurationSec * (safeNextScale / safePreviousScale))
  }

  const clampPreviewStartForVisibleDuration = (value: number, visibleDurationSec: number) =>
    clampHorizontalBrowsePreviewStartByVisibleDuration(
      value,
      params.resolvePreviewDurationSec(),
      visibleDurationSec,
      params.allowNegativeTimeline()
    )

  const commitLinkedGridVisualTransaction = (
    deckState: HorizontalBrowseLinkedGridVisualTransactionDeckState = {},
    options: HorizontalBrowseLinkedGridVisualTransactionCommitOptions = {}
  ): HorizontalBrowseLinkedGridVisualTransactionResult => {
    const targetSeconds = Number(deckState.currentSeconds ?? params.currentSeconds()) || 0
    const playbackActive = deckState.playbackActive ?? params.waveformPlaybackActive()
    const playbackRate = Math.max(
      0.25,
      Number(deckState.playbackRate ?? params.resolveWaveformPlaybackRate()) || 1
    )
    const playbackStartedAtMs =
      Number.isFinite(Number(deckState.startedAtMs)) && Number(deckState.startedAtMs) >= 0
        ? Number(deckState.startedAtMs)
        : performance.now()
    const safeSeconds = params.normalizePreviewTimelineSeconds(targetSeconds)
    const linkedGridVisualPending = params.linkedGridVisualPending()
    const shouldMutatePresentation = options.mutate !== false
    if (shouldMutatePresentation) {
      clearPlaybackStableFrameRenderTimer()
    }
    if (linkedGridVisualPending || !shouldMutatePresentation) {
      if (shouldMutatePresentation) {
        params.syncGridStateFromSong()
      }
      const timeScale = Math.max(
        0.25,
        Number(params.resolveIncomingPreviewTimeScale(deckState.playbackRate)) || 1
      )
      const visibleDurationSec = resolveVisibleDurationSecForTimeScale(timeScale)
      const viewportStartSec = clampPreviewStartForVisibleDuration(
        safeSeconds - visibleDurationSec * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
        visibleDurationSec
      )
      const gridTimeBasis = params.resolveGridTimeBasis()
      if (shouldMutatePresentation) {
        params.markLinkedGridVisualTransactionCommitted()
      }
      return {
        deck: params.deck(),
        committed: true,
        anchorSec: safeSeconds,
        viewportStartSec,
        visibleDurationSec,
        anchorRatio: HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
        timeScale,
        gridTimeBasis,
        playbackClock: playbackActive
          ? {
              seconds: safeSeconds,
              startedAtMs: playbackStartedAtMs,
              playbackRate
            }
          : null
      }
    }
    params.localGridShiftPhaseOffsetSec.value = 0
    params.syncGridStateFromSong()
    params.syncVisualGridStateFromPreview()
    applyIncomingPreviewTimeScale(false)
    params.applyPreviewPlaybackPosition(safeSeconds, false)
    params.resetGridRenderer()
    params.maybeContinueWaveformSource(safeSeconds)
    if (!linkedGridVisualPending) {
      if (params.waveformPlaybackActive()) {
        schedulePlaybackStableFrameRender()
      } else {
        params.scheduleDraw({ preferPreviewStart: true, viewportOnly: true })
      }
      params.publishLinkedGridVisualPhaseSample()
    }
    params.markLinkedGridVisualTransactionCommitted()
    const visibleDurationSec = params.resolveVisibleDurationSec()
    const timeScale = Math.max(
      0.25,
      Number(params.getLastAppliedPreviewTimeScale()) ||
        Number(params.resolveIncomingPreviewTimeScale()) ||
        1
    )
    return {
      deck: params.deck(),
      committed: true,
      anchorSec: safeSeconds,
      viewportStartSec: params.previewStartSec.value,
      visibleDurationSec,
      anchorRatio: HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
      timeScale,
      gridTimeBasis: params.resolveGridTimeBasis(),
      playbackClock: playbackActive
        ? {
            seconds: safeSeconds,
            startedAtMs: playbackStartedAtMs,
            playbackRate
          }
        : null
    }
  }

  return {
    clearPlaybackStableFrameRenderTimer,
    schedulePlaybackStableFrameRender,
    prepareStableFrameForAnchor,
    applyIncomingPreviewTimeScale,
    commitLinkedGridVisualTransaction
  }
}
