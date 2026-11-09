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
  isActive: boolean
  isBoundary: boolean
}

export type EnvelopeDragState = {
  param: MixtapeEnvelopeParamId
  trackId: string
  pointIndices: number[]
  stageEl: HTMLElement
  horizontalDragStarted: boolean
  startPointer?: { sec: number; gain: number }
  basePoints?: MixtapeGainPoint[]
}

export type MixSegmentMask = {
  key: string
  left: number
  width: number
}

export type SegmentSelectionState = {
  param: MixtapeEnvelopeParamId
  trackId: string
  stageEl: HTMLElement
  baseSegments: MixtapeMuteSegment[]
  touched: Map<string, MixtapeMuteSegment>
  lastSec: number
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

export type EnvelopeUndoSeed = {
  trackId: string
  param: MixtapeEnvelopeParamId
  points: MixtapeGainPoint[]
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
}
