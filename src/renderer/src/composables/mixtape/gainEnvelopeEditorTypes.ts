import type { Ref } from 'vue'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'

export type EnvelopePointDot = {
  index: number
  x: number
  y: number
  gainDb: number
  sec: number
  isActive: boolean
  isSelected: boolean
  isHovered: boolean
  isBoundary: boolean
}

export type MixSegmentMask = {
  key: string
  left: number
  width: number
}

export type MixParamUndoEntry =
  | {
      type: 'envelope'
      trackId: string
      param: MixtapeEnvelopeParamId
      points: MixtapeGainPoint[]
    }
  | {
      type: 'segment'
      trackId: string
      param: MixtapeEnvelopeParamId
      segments: MixtapeMuteSegment[]
    }
  | {
      type: 'external'
      undo: () => boolean
    }

export type CreateMixtapeGainEnvelopeEditorParams = {
  tracks: Ref<MixtapeTrack[]>
  renderZoomLevel: Ref<number>
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack) => number
  resolveActiveParam: () => MixtapeEnvelopeParamId | null
  isSegmentSelectionMode: () => boolean
  isEditable: () => boolean
  onGestureActiveChange?: (active: boolean) => void
}
