import { computed, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { isEditablePioneerUsbSong } from '@renderer/utils/pioneerUsbEditing'

export const useHorizontalBrowseGridCapabilities = (params: {
  song: () => ISongInfo | null
  previewLoading: Ref<boolean>
  previewFirstBeatMs: Ref<number>
  durationSec: () => number
  gridEditMode: () => boolean
  interactionDisabled: () => boolean
  hasWaveform: () => boolean
  playbackRate: () => number | undefined
  seekRevision: () => number | undefined
}) => {
  const isRekordboxReadOnlySong = computed(() =>
    isRekordboxExternalPlaybackSource('', params.song())
  )
  const gridEditingEnabled = computed(
    () => params.gridEditMode() && !params.interactionDisabled() && !isRekordboxReadOnlySong.value
  )
  const canAdjustGrid = computed(
    () =>
      !params.previewLoading.value &&
      Boolean(params.song()?.filePath) &&
      params.durationSec() > 0 &&
      (!isRekordboxExternalPlaybackSource('', params.song()) ||
        (isEditablePioneerUsbSong(params.song()) &&
          Boolean(params.song()?.rekordboxGridEntries?.length)))
  )
  const canAdjustBpmInput = computed(
    () =>
      !isRekordboxReadOnlySong.value &&
      !params.previewLoading.value &&
      (params.gridEditMode()
        ? canAdjustGrid.value
        : Boolean(params.song()?.filePath) && params.durationSec() > 0)
  )
  return {
    isRekordboxReadOnlySong,
    gridEditingEnabled,
    externalDetailWaveformUnavailable: computed(
      () => isRekordboxReadOnlySong.value && !params.hasWaveform()
    ),
    canAdjustGrid,
    canAdjustBpmInput,
    previewFirstBeatMsComputed: computed(() => Number(params.previewFirstBeatMs.value) || 0),
    metronomePlaybackRate: computed(() => Math.max(0.25, Number(params.playbackRate()) || 1)),
    metronomeResetKey: computed(
      () => `${params.song()?.filePath || ''}:${Number(params.seekRevision()) || 0}`
    )
  }
}
