import { computed, type ComputedRef } from 'vue'
import type { ISongsAreaPaneRuntimeState, SongsAreaPaneKey } from '@renderer/stores/runtime'

export const useSongsAreaPaneViews = (
  panes: Record<SongsAreaPaneKey, ISongsAreaPaneRuntimeState>,
  split: ComputedRef<boolean>
) => {
  const ids = new WeakMap<ISongsAreaPaneRuntimeState, number>()
  let nextId = 0
  return computed(() => {
    const keys: SongsAreaPaneKey[] = split.value ? ['left', 'right'] : ['single']
    return keys.map((pane) => {
      const state = panes[pane]
      if (!ids.has(state)) ids.set(state, ++nextId)
      return { pane, viewId: ids.get(state)! }
    })
  })
}
