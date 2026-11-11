import { computed, shallowRef } from 'vue'
import { MIX_PARAM_UNDO_STACK_LIMIT } from './gainEnvelopeEditorConstants'
import type { MixParamUndoEntry } from './gainEnvelopeEditorTypes'

export const createGainEnvelopeHistory = (options: {
  inverse: (entry: MixParamUndoEntry) => MixParamUndoEntry | null
  restore: (entry: MixParamUndoEntry) => boolean
  cancel: () => boolean
}) => {
  const undo = shallowRef<MixParamUndoEntry[]>([])
  const redo = shallowRef<MixParamUndoEntry[]>([])
  const push = (entry: MixParamUndoEntry) => {
    undo.value = [...undo.value, entry].slice(-MIX_PARAM_UNDO_STACK_LIMIT)
    redo.value = []
  }
  const travel = (forward: boolean) => {
    if (options.cancel()) return true
    const source = forward ? redo : undo
    const target = forward ? undo : redo
    while (source.value.length) {
      const entry = source.value[source.value.length - 1]
      source.value = source.value.slice(0, -1)
      const inverse = options.inverse(entry)
      if (!options.restore(entry)) continue
      // Existing arrangement actions supply undo only; they form a redo boundary.
      target.value = inverse ? [...target.value, inverse].slice(-MIX_PARAM_UNDO_STACK_LIMIT) : []
      return true
    }
    return false
  }
  return {
    push,
    canUndoMixParam: computed(() => undo.value.length > 0),
    canRedoMixParam: computed(() => redo.value.length > 0),
    undoLastMixParamChange: () => travel(false),
    redoLastMixParamChange: () => travel(true),
    clear: () => {
      undo.value = []
      redo.value = []
    }
  }
}
