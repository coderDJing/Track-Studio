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
      state?.owner === 'seek' ||
      state?.owner === 'drag' ||
      state?.owner === 'linked-drag'
    ) {
      lastPresentationStableRenderRevision = presentationRevision
      return presentationRevision
    }
    if (
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
