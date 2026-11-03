import { computed, ref, type Ref } from 'vue'
import { t } from '@renderer/utils/translate'
import confirmDialog from '@renderer/components/confirmDialog'
import { openMixtapeCueOverlapDialog } from '@renderer/components/mixtape/openMixtapeCueOverlapDialog'
import type {
  MixtapeArrangementResult,
  MixtapeArrangementSnapshot
} from '@shared/mixtapeArrangement'
import {
  applyMixtapeGlobalTempoSnapshot,
  readMixtapeGlobalTempoSnapshot
} from './mixtapeGlobalTempoState'
import { applyMixtapeGlobalTempoTargetsToTracks } from './mixtapeGlobalTempoModel'
import { buildMixtapeCueOverlapPlan, type MixtapeCueOverlapSettings } from './mixtapeCueOverlap'
import type { MixtapeTrack } from './types'

type Options = {
  tracks: Ref<MixtapeTrack[]>
  playlistId: Ref<string>
  isBlocked: () => boolean
  resolveSourceDuration: (track: MixtapeTrack) => number
  pushUndo: (undo: () => boolean) => void
  refresh: () => void
}

export const useMixtapeCueOverlap = (options: Options) => {
  const busy = ref(false),
    dialogOpen = ref(false)
  const canOpen = computed(
    () =>
      options.tracks.value.length >= 2 && !busy.value && !dialogOpen.value && !options.isBlocked()
  )
  const buildPlan = (settings: MixtapeCueOverlapSettings) =>
    buildMixtapeCueOverlapPlan({
      tracks: options.tracks.value,
      settings,
      resolveSourceDuration: options.resolveSourceDuration
    })
  const applyToView = (playlistId: string, snapshot: MixtapeArrangementSnapshot) => {
    if (options.playlistId.value !== playlistId) return
    applyMixtapeGlobalTempoSnapshot({ playlistId, snapshot, source: 'user' })
    const starts = new Map(snapshot.entries.map((entry) => [entry.itemId, entry.startSec]))
    options.tracks.value = applyMixtapeGlobalTempoTargetsToTracks(
      options.tracks.value.map((track) =>
        starts.has(track.id) ? { ...track, startSec: starts.get(track.id) } : track
      ),
      snapshot.bpmEnvelope
    )
    options.refresh()
  }
  const persist = async (playlistId: string, snapshot: MixtapeArrangementSnapshot) => {
    const result = (await window.electron.ipcRenderer.invoke('mixtape:project:apply-arrangement', {
      playlistId,
      ...snapshot
    })) as MixtapeArrangementResult
    if (!result?.snapshot || result.updated !== snapshot.entries.length)
      throw new Error('MIXTAPE_ARRANGEMENT_DATABASE')
    applyToView(playlistId, result.snapshot)
  }
  const confirm = async (settings: MixtapeCueOverlapSettings) => {
    if (busy.value || options.isBlocked()) throw new Error('MIXTAPE_ARRANGEMENT_CHANGED')
    const playlistId = options.playlistId.value
    const plan = buildPlan(settings)
    if (!plan.valid) throw new Error('MIXTAPE_ARRANGEMENT_INVALID')
    const oldTempo = readMixtapeGlobalTempoSnapshot()
    const before: MixtapeArrangementSnapshot = {
      entries: options.tracks.value.map((track) => ({
        itemId: track.id,
        startSec: Number(track.startSec) || 0
      })),
      bpmEnvelope: oldTempo.bpmEnvelope.map((point) => ({ sec: point.sec, bpm: point.bpm })),
      bpmEnvelopeDurationSec: oldTempo.bpmEnvelopeDurationSec,
      gridPhaseOffsetSec: oldTempo.gridPhaseOffsetSec || 0
    }
    if (before.bpmEnvelope.length < 2 || before.bpmEnvelopeDurationSec <= 0)
      throw new Error('MIXTAPE_ARRANGEMENT_CHANGED')
    busy.value = true
    try {
      await persist(playlistId, plan.snapshot)
      const undo = () => {
        if (busy.value || options.isBlocked() || options.playlistId.value !== playlistId)
          return false
        busy.value = true
        void persist(playlistId, before)
          .catch(async (error) => {
            options.pushUndo(undo)
            console.error('[mixtape] undo cue overlap failed', error)
            await confirmDialog({
              title: t('common.error'),
              content: [t('mixtape.cueOverlapFailed')],
              confirmShow: false
            })
          })
          .finally(() => {
            busy.value = false
          })
        return true
      }
      options.pushUndo(undo)
    } finally {
      busy.value = false
    }
  }
  const open = async () => {
    if (!canOpen.value) return
    dialogOpen.value = true
    const initialBpm =
      Number(readMixtapeGlobalTempoSnapshot().bpmEnvelope[0]?.bpm) ||
      Number(options.tracks.value[0]?.bpm) ||
      128
    try {
      await openMixtapeCueOverlapDialog({ initialBpm, buildPlan, confirm })
    } finally {
      dialogOpen.value = false
    }
  }
  return { canOpen, open, busy }
}
