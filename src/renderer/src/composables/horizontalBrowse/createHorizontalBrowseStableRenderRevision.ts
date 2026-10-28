import { computed } from 'vue'
import type { HorizontalBrowseRawWaveformDetailProps } from './horizontalBrowseRawWaveformDetailTypes'

export const createHorizontalBrowseStableRenderRevision = (
  props: HorizontalBrowseRawWaveformDetailProps
) => {
  let lastPresentationStableRenderRevision = 0
  return computed(() => {
    const state = props.presentationState
    const presentationRevision = Math.max(0, Math.floor(Number(state?.revision) || 0))
    if (
      state?.owner === 'linked-playback' ||
      state?.owner === 'drag' ||
      state?.owner === 'linked-drag'
    ) {
      lastPresentationStableRenderRevision = presentationRevision
      return presentationRevision
    }
    // Seek/Cue 只改变视口位置，不改变已经绘制的波形内容。保留画布版本，
    // 让覆盖目标位置的稳定帧直接平移复用；越出覆盖范围仍由 seek watcher 请求新帧。
    // 若把 seek 的展示事务版本作为内容版本，每次松开 Cue 都会清空块池并重画整片波形。
    if (
      state?.owner === 'seek' ||
      state?.owner === 'sync-transaction' ||
      (state?.owner === 'playback' &&
        state.sourceDeck === null &&
        state.visualPending === false &&
        lastPresentationStableRenderRevision > 0) ||
      state?.visualPending === true ||
      props.linkedGridVisualPending === true
    ) {
      return lastPresentationStableRenderRevision
    }
    lastPresentationStableRenderRevision = 0
    return 0
  })
}
