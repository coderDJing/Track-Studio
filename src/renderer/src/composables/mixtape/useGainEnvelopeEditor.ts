import { watch } from 'vue'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  MIXTAPE_STEM_SEGMENT_PARAMS,
  normalizeMixEnvelopePoints
} from './gainEnvelope'
import { cloneEnvelope } from './gainEnvelopeEditing'
import { resolveVolumeMuteSegmentMasks } from './gainEnvelopeEditorGrid'
import { buildStemEnvelopeBySegments } from './gainEnvelopeStemSegments'
import { createGainEnvelopeTrackStateModule } from './gainEnvelopeTrackState'
import { createGainEnvelopePersistModule } from './gainEnvelopePersist'
import { createGainEnvelopeHistory } from './gainEnvelopeHistory'
import { createGainEnvelopeInteraction } from './gainEnvelopeInteraction'
import { createGainEnvelopeMuteInteraction } from './gainEnvelopeMuteInteraction'
import { normalizeVolumeMuteSegments } from './volumeMuteSegments'
import type {
  CreateMixtapeGainEnvelopeEditorParams,
  MixParamUndoEntry
} from './gainEnvelopeEditorTypes'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
  TimelineTrackLayout
} from './types'

export const createMixtapeGainEnvelopeEditor = (params: CreateMixtapeGainEnvelopeEditorParams) => {
  const stems = new Set<MixtapeEnvelopeParamId>(MIXTAPE_STEM_SEGMENT_PARAMS)
  const state = createGainEnvelopeTrackStateModule({
    tracks: params.tracks,
    resolveRenderZoom: () => Number(params.renderZoomLevel.value) || 0,
    resolveTrackDurationSeconds: params.resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds: params.resolveTrackSourceDurationSeconds,
    isStemSegmentParam: (param) => stems.has(param)
  })
  const persist = createGainEnvelopePersistModule()
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  const updatePoints = (
    param: MixtapeEnvelopeParamId,
    id: string,
    points: MixtapeGainPoint[],
    save = true
  ) => {
    const current = state.resolveTrackEnvelopeState(id, param)
    if (!current.track || !current.durationSec) return
    const next = normalizeMixEnvelopePoints(param, points, current.durationSec)
    if (!same(current.points, next)) {
      // Preserve track identity and grid caches; only the edited envelope is reactive during a gesture.
      current.track[MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]] = next
    }
    if (save) persist.scheduleMixEnvelopePersist(param, id, next)
  }
  const resolveSegments = (id: string, param: MixtapeEnvelopeParamId) =>
    param === 'volume'
      ? state.resolveTrackVolumeMuteState(id)
      : state.resolveTrackStemSegmentState(id, param)
  const updateSegments = (
    id: string,
    param: MixtapeEnvelopeParamId,
    segments: MixtapeMuteSegment[],
    save: boolean
  ) => {
    const current = resolveSegments(id, param)
    if (!current.track || !current.durationSec) return
    if (param !== 'volume') {
      updatePoints(
        param,
        id,
        buildStemEnvelopeBySegments(param, current.durationSec, segments),
        save
      )
      return
    }
    const next = normalizeVolumeMuteSegments(segments, current.durationSec)
    if (!same(current.segments, next)) current.track.volumeMuteSegments = next
    if (save) persist.scheduleVolumeMuteSegmentsPersist(id, next)
  }
  const flush = () => {
    void persist.flushPendingMixEnvelopePersist()
    void persist.flushPendingVolumeMutePersist()
  }
  const inverse = (entry: MixParamUndoEntry): MixParamUndoEntry | null => {
    if (entry.type === 'external') return null
    if (entry.type === 'envelope') {
      const current = state.resolveTrackEnvelopeState(entry.trackId, entry.param)
      return current.track ? { ...entry, points: cloneEnvelope(current.points) } : null
    }
    const current = resolveSegments(entry.trackId, entry.param)
    return current.track
      ? { ...entry, segments: current.segments.map((segment) => ({ ...segment })) }
      : null
  }
  const restore = (entry: MixParamUndoEntry) => {
    if (entry.type === 'external') return entry.undo()
    interaction.selectedEnvelopePoint.value = null
    interaction.envelopeContextMenu.value = null
    const current = inverse(entry)
    if (!current || same(current, entry)) return false
    if (entry.type === 'envelope') updatePoints(entry.param, entry.trackId, entry.points)
    else updateSegments(entry.trackId, entry.param, entry.segments, true)
    flush()
    return true
  }
  const history = createGainEnvelopeHistory({
    inverse,
    restore,
    cancel: () => cancelEnvelopeGesture()
  })
  const interaction = createGainEnvelopeInteraction({
    params,
    resolve: state.resolveTrackEnvelopeState,
    grid: state.resolveDynamicVisibleGridLines,
    update: updatePoints,
    commit: (param, trackId, before) => {
      const current = state.resolveTrackEnvelopeState(trackId, param)
      if (!current.track || same(before, current.points)) return
      history.push({ type: 'envelope', param, trackId, points: cloneEnvelope(before) })
      updatePoints(param, trackId, current.points)
      flush()
    }
  })
  const mute = createGainEnvelopeMuteInteraction({
    activeParam: () =>
      params.isEditable() && params.isSegmentSelectionMode() ? params.resolveActiveParam() : null,
    resolve: resolveSegments,
    grid: state.resolveVolumeMuteGrid,
    update: updateSegments,
    activeChanged: params.onGestureActiveChange,
    commit: (trackId, param, before) => {
      const current = resolveSegments(trackId, param)
      if (!current.track || same(before, current.segments)) return
      history.push({
        type: 'segment',
        trackId,
        param,
        segments: before.map((segment) => ({ ...segment }))
      })
      updateSegments(trackId, param, current.segments, true)
      flush()
    }
  })
  function cancelEnvelopeGesture() {
    const continuous = interaction.cancelEnvelopeGesture()
    return mute.cancel() || continuous
  }
  const stopModeWatch = watch(
    () => [params.resolveActiveParam(), params.isSegmentSelectionMode(), params.isEditable()],
    () => mute.cancel(),
    { flush: 'sync' }
  )
  return {
    ...interaction,
    cancelEnvelopeGesture,
    canUndoMixParam: history.canUndoMixParam,
    canRedoMixParam: history.canRedoMixParam,
    undoLastMixParamChange: history.undoLastMixParamChange,
    redoLastMixParamChange: history.redoLastMixParamChange,
    pushExternalUndoStep: (undo: (() => boolean) | null | undefined) => {
      if (typeof undo === 'function') history.push({ type: 'external', undo })
    },
    handleEnvelopeStageMouseDown: (item: TimelineTrackLayout, event: PointerEvent) => {
      if (params.isSegmentSelectionMode()) mute.begin(item, event)
      else interaction.handleEnvelopeStageMouseDown(item, event)
    },
    resolveVolumeSegmentMasks: (item: TimelineTrackLayout) => {
      const current = state.resolveTrackVolumeMuteState(item.track.id)
      return resolveVolumeMuteSegmentMasks(current.durationSec, current.segments)
    },
    flushPendingMixEnvelopePersist: persist.flushPendingMixEnvelopePersist,
    cleanupGainEnvelopeEditor: () => {
      interaction.cleanup()
      mute.cancel()
      stopModeWatch()
      history.clear()
      flush()
    }
  }
}

export type MixtapeGainEnvelopeEditor = ReturnType<typeof createMixtapeGainEnvelopeEditor>
