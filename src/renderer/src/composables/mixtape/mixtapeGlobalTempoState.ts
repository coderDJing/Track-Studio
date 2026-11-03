import { ref } from 'vue'
import type {
  MixtapeBpmPoint,
  MixtapeProjectBpmEnvelopeSnapshot
} from '@renderer/composables/mixtape/types'

export type MixtapeGlobalTempoSource = 'empty' | 'persisted' | 'generated' | 'user'

export const mixtapeGlobalTempoPlaylistId = ref('')
export const mixtapeGlobalTempoEnvelope = ref<MixtapeBpmPoint[]>([])
const mixtapeGlobalTempoDurationSec = ref(0)
export const mixtapeGlobalTempoPhaseOffsetSec = ref(0)
export const mixtapeGlobalTempoSource = ref<MixtapeGlobalTempoSource>('empty')

export const resetMixtapeGlobalTempoState = (playlistId: string = '') => {
  mixtapeGlobalTempoPlaylistId.value = typeof playlistId === 'string' ? playlistId.trim() : ''
  mixtapeGlobalTempoEnvelope.value = []
  mixtapeGlobalTempoDurationSec.value = 0
  mixtapeGlobalTempoPhaseOffsetSec.value = 0
  mixtapeGlobalTempoSource.value = 'empty'
}

export const applyMixtapeGlobalTempoSnapshot = (params: {
  playlistId: string
  snapshot: MixtapeProjectBpmEnvelopeSnapshot
  source: MixtapeGlobalTempoSource
}) => {
  mixtapeGlobalTempoPlaylistId.value =
    typeof params.playlistId === 'string' ? params.playlistId.trim() : ''
  mixtapeGlobalTempoEnvelope.value = Array.isArray(params.snapshot?.bpmEnvelope)
    ? params.snapshot.bpmEnvelope.map((point) => ({
        sec: Number(point.sec),
        bpm: Number(point.bpm),
        source: point.source === 'auto' || point.source === 'manual' ? point.source : undefined
      }))
    : []
  mixtapeGlobalTempoDurationSec.value = Math.max(
    0,
    Number(params.snapshot?.bpmEnvelopeDurationSec) || 0
  )
  mixtapeGlobalTempoPhaseOffsetSec.value = Math.max(
    0,
    Number(params.snapshot?.gridPhaseOffsetSec) || 0
  )
  mixtapeGlobalTempoSource.value = params.source
}

export const isMixtapeGlobalTempoReady = () => mixtapeGlobalTempoEnvelope.value.length >= 2

export const readMixtapeGlobalTempoSnapshot = (): MixtapeProjectBpmEnvelopeSnapshot => ({
  bpmEnvelope: mixtapeGlobalTempoEnvelope.value.map((point) => ({ ...point })),
  bpmEnvelopeDurationSec: mixtapeGlobalTempoDurationSec.value,
  gridPhaseOffsetSec: mixtapeGlobalTempoPhaseOffsetSec.value
})
