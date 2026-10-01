import type { Ref } from 'vue'
import {
  applyHorizontalBrowseLiveTempoPreviewTransform,
  resolveHorizontalBrowseLiveTempoPreviewReleasePlan,
  shouldFinishHorizontalBrowseLiveTempoPreviewRelease
} from './horizontalBrowseLiveTempoPreview'
import { resolveHorizontalBrowseWaveformTimeScale } from './horizontalBrowseWaveformTimeScale'

type LiveTempoPreviewControllerParams = {
  livePlaybackRate: Ref<number | null>
  initialTimeScale: number
  activeBufferIndex: () => 0 | 1
  scalers: (bufferIndex: 0 | 1) => Array<HTMLElement | null | undefined>
  getLastAppliedTimeScale: () => number
  resolveIncomingTimeScale: () => number
  linkedGridVisualPending: () => boolean
  stablePlaybackActive: () => boolean
  currentSeconds: () => number
  reanchorPlayback: (seconds: number, playbackRate: number) => void
  applyIncomingTimeScale: (
    scheduleFrame: boolean,
    options: { keepCurrentFrame: boolean; forceFrameWhenUnchanged?: boolean }
  ) => boolean
}

// 拖动中仅缩放旧帧；松手后保留缩放，直到最终密度帧完成 buffer 交接。
export const createHorizontalBrowseLiveTempoPreviewController = (
  params: LiveTempoPreviewControllerParams
) => {
  let displayedTimeScale = params.initialTimeScale
  let targetTimeScale: number | null = null
  let releasePendingScale: number | null = null

  const prepareBuffer = (bufferIndex: 0 | 1, bufferTimeScale: number) => {
    applyHorizontalBrowseLiveTempoPreviewTransform(
      params.scalers(bufferIndex),
      bufferTimeScale,
      targetTimeScale ?? params.getLastAppliedTimeScale()
    )
  }

  const syncTransform = () => {
    if (targetTimeScale === null) {
      applyHorizontalBrowseLiveTempoPreviewTransform(
        [...params.scalers(0), ...params.scalers(1)],
        1,
        1
      )
      return
    }
    prepareBuffer(params.activeBufferIndex(), displayedTimeScale)
  }

  const clearRelease = () => {
    releasePendingScale = null
    targetTimeScale = null
    syncTransform()
  }

  const presented = (timeScale: number) => {
    displayedTimeScale = resolveHorizontalBrowseWaveformTimeScale(timeScale)
    if (
      shouldFinishHorizontalBrowseLiveTempoPreviewRelease(displayedTimeScale, releasePendingScale)
    ) {
      releasePendingScale = null
      targetTimeScale = null
    }
    syncTransform()
  }

  const setPlaybackRate = (liveRate: number | null | undefined) => {
    const leavingLive = targetTimeScale !== null
    const nextRate =
      liveRate != null && Number.isFinite(Number(liveRate)) && Number(liveRate) > 0
        ? resolveHorizontalBrowseWaveformTimeScale(liveRate)
        : null
    params.livePlaybackRate.value = nextRate
    if (nextRate !== null) {
      releasePendingScale = null
      // imperative 预览先于 native 快照到达，必须使用本次请求倍率。
      targetTimeScale = nextRate
      syncTransform()
      if (params.stablePlaybackActive()) {
        params.reanchorPlayback(params.currentSeconds(), nextRate)
      }
      return
    }
    if (!leavingLive || params.linkedGridVisualPending()) {
      clearRelease()
      return
    }
    const incomingTimeScale = resolveHorizontalBrowseWaveformTimeScale(
      params.resolveIncomingTimeScale()
    )
    const releasePlan = resolveHorizontalBrowseLiveTempoPreviewReleasePlan(
      displayedTimeScale,
      incomingTimeScale
    )
    if (releasePlan.mode === 'immediate') {
      clearRelease()
      params.applyIncomingTimeScale(true, { keepCurrentFrame: true })
      return
    }
    releasePendingScale = releasePlan.pendingScale
    targetTimeScale = releasePlan.pendingScale
    syncTransform()
    const scheduled = params.applyIncomingTimeScale(true, {
      keepCurrentFrame: true,
      forceFrameWhenUnchanged: true
    })
    if (!scheduled) clearRelease()
  }

  return { prepareBuffer, presented, setPlaybackRate }
}
