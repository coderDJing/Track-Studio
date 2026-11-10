import { computed, ref, type Ref } from 'vue'
import {
  PROJECT_GAIN_STEP_DB,
  canShiftProjectGain,
  readProjectGainState,
  shiftProjectGain,
  type ProjectGainEntry
} from './projectGainEnvelope'
import type { MixtapeTrack } from './types'

export type ProjectGainUnavailableReason = 'saving' | 'empty' | 'blocked' | 'notReady' | null

type Options = {
  busy?: Ref<boolean>
  tracks: Ref<MixtapeTrack[]>
  playlistId: Readonly<Ref<string>>
  isBlocked: () => boolean
  resolveDuration: (track: MixtapeTrack) => number
  flushPending: () => Promise<void>
  pushUndo: (undo: () => boolean) => void
  refresh: () => void
  showError: () => Promise<void>
  onAdjusted?: (deltaDb: number, trackCount: number) => void
  onUndone?: (trackCount: number) => void
  persist?: (entries: ProjectGainEntry[]) => Promise<void>
}

const persistProjectGain = async (entries: ProjectGainEntry[]) => {
  await window.electron.ipcRenderer.invoke('mixtape:update-gain-envelope', {
    entries,
    requireAll: true
  })
}

export const useMixtapeProjectGain = (options: Options) => {
  const busy = options.busy ?? ref(false)
  const state = computed(() => readProjectGainState(options.tracks.value, options.resolveDuration))
  const unavailableReason = computed<ProjectGainUnavailableReason>(() => {
    if (busy.value) return 'saving'
    if (!options.tracks.value.length) return 'empty'
    if (options.isBlocked()) return 'blocked'
    if (!state.value) return 'notReady'
    return null
  })
  const canAdjust = (deltaDb: number) =>
    !unavailableReason.value && canShiftProjectGain(state.value, deltaDb)
  const canDecrease = computed(() => canAdjust(-PROJECT_GAIN_STEP_DB))
  const canIncrease = computed(() => canAdjust(PROJECT_GAIN_STEP_DB))
  const persist = options.persist ?? persistProjectGain

  const applyToView = (playlistId: string, entries: ProjectGainEntry[]) => {
    if (options.playlistId.value !== playlistId) return
    const byId = new Map(entries.map((entry) => [entry.itemId, entry.gainEnvelope]))
    options.tracks.value = options.tracks.value.map((track) => {
      const gainEnvelope = byId.get(track.id)
      return gainEnvelope ? { ...track, gainEnvelope } : track
    })
    options.refresh()
  }

  const adjust = async (direction: -1 | 1) => {
    const deltaDb = direction * PROJECT_GAIN_STEP_DB
    if (!canAdjust(deltaDb)) return
    const playlistId = options.playlistId.value
    busy.value = true
    try {
      // 先清空单点编辑的防抖写入，避免旧包络在整批调整后覆盖新值。
      await options.flushPending()
      if (options.playlistId.value !== playlistId || options.isBlocked()) return
      const before = readProjectGainState(options.tracks.value, options.resolveDuration)
      if (!before || !canShiftProjectGain(before, deltaDb)) return
      const after = shiftProjectGain(before, deltaDb)
      await persist(after)
      if (options.playlistId.value !== playlistId) return
      applyToView(playlistId, after)
      const undo = () => {
        if (busy.value || options.playlistId.value !== playlistId) return false
        busy.value = true
        void (async () => {
          await options.flushPending()
          if (options.playlistId.value !== playlistId) return
          const ids = new Set(options.tracks.value.map((track) => track.id))
          const entries = before.entries.filter((entry) => ids.has(entry.itemId))
          if (!entries.length) return
          await persist(entries)
          applyToView(playlistId, entries)
          if (options.playlistId.value === playlistId) options.onUndone?.(entries.length)
        })()
          .catch(async (error: unknown) => {
            if (options.playlistId.value === playlistId) options.pushUndo(undo)
            console.error('[mixtape] undo project gain failed', error)
            await options.showError()
          })
          .finally(() => {
            busy.value = false
          })
        return true
      }
      options.pushUndo(undo)
      options.onAdjusted?.(deltaDb, after.length)
    } catch (error) {
      console.error('[mixtape] adjust project gain failed', error)
      await options.showError()
    } finally {
      busy.value = false
    }
  }

  return { busy, canDecrease, canIncrease, unavailableReason, adjust }
}
