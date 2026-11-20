import { computed, type CSSProperties, type Ref } from 'vue'
import {
  DEFAULT_LANE_COUNT,
  resolveMixtapeEnvelopePreviewLaneBaseHeight,
  resolveMixtapeOverviewLaneBaseHeight
} from '@renderer/composables/mixtape/constants'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  buildMixEnvelopePolylineByControlPoints,
  normalizeMixEnvelopePoints
} from '@renderer/composables/mixtape/gainEnvelope'
import { createGainEnvelopeTrackStateModule } from '@renderer/composables/mixtape/gainEnvelopeTrackState'
import { resolveVolumeMuteSegmentMasks } from '@renderer/composables/mixtape/gainEnvelopeEditorGrid'
import { resolveStemWaveformColor } from '@renderer/composables/mixtape/waveformDraw'
import type { MixSegmentMask } from '@renderer/composables/mixtape/gainEnvelopeEditorTypes'
import type {
  MixtapeEnvelopeParamId,
  MixtapeTrack,
  MixtapeWaveformStemId,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'

type MaybeRef<T> = Readonly<Ref<T>> | T

type UseMixtapeEnvelopePreviewOptions = {
  laneIndices: MaybeRef<number[]>
  laneHeight: MaybeRef<number>
  renderZoomLevel: MaybeRef<number>
  previewParams?: MaybeRef<MixtapeEnvelopeParamId[]>
  showStemPreviewRows: MaybeRef<boolean>
  timelineVisualScale: MaybeRef<number>
  timelineContentWidth: MaybeRef<number>
  timelineScrollLeft: MaybeRef<number>
  tracks: Readonly<Ref<MixtapeTrack[]>>
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
}

export type TrackEnvelopePreviewLine = {
  key: MixtapeEnvelopeParamId
  points: string
  color: string
  strokeWidth: number
}

export type TrackStemPreviewRow = {
  key: MixtapeWaveformStemId
  fillColor: string
  muteSegments: MixSegmentMask[]
}

type TrackEnvelopePreviewLegendItem = {
  key: string
  label: string
  color: string
  dotStyle?: CSSProperties
}

type TrackPreviewCacheEntry = {
  lines: TrackEnvelopePreviewLine[]
  stemRows: TrackStemPreviewRow[]
}

const DEFAULT_TRACK_ENVELOPE_PREVIEW_PARAMS: MixtapeEnvelopeParamId[] = ['gain', 'volume']
const STEM_PREVIEW_ROW_ORDER: MixtapeWaveformStemId[] = ['vocal', 'inst', 'bass', 'drums']
const STEM_PREVIEW_FILL_ALPHA = 0.18
const LOOP_PREVIEW_SOURCE_COLOR = 'rgba(255, 214, 102, 0.78)'
const LOOP_PREVIEW_REPEAT_COLOR = 'rgba(255, 214, 102, 0.72)'

const TRACK_ENVELOPE_PREVIEW_COLORS: Record<MixtapeEnvelopeParamId, string> = {
  gain: '#f2f6ff',
  high: '#4f8bff',
  mid: '#45d07e',
  low: '#a56eff',
  vocal: '#3b82f6',
  inst: '#14b8a6',
  bass: '#a855f7',
  drums: '#f97316',
  volume: '#ffc94a'
}

const TRACK_ENVELOPE_PREVIEW_STROKES: Record<MixtapeEnvelopeParamId, number> = {
  gain: 2.4,
  high: 1.08,
  mid: 1.08,
  low: 1.08,
  vocal: 1.08,
  inst: 1.08,
  bass: 1.08,
  drums: 1.08,
  volume: 1.85
}

const TRACK_ENVELOPE_PREVIEW_EDGE_INSET_PERCENT = 1.2

const TIMELINE_TRACK_LANE_GAP_PX = 8
const TIMELINE_TRACK_VERTICAL_PADDING_PX = 10
const TIMELINE_TRACK_LANE_BORDER_PX = 2

const normalizeEnvelopePreviewPolyline = (points: string) =>
  points.replace(
    /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g,
    (_matched, xText: string, yText: string) => {
      const y = Number(yText)
      if (!Number.isFinite(y)) return `${xText},${yText}`
      const safeY = Math.max(
        TRACK_ENVELOPE_PREVIEW_EDGE_INSET_PERCENT,
        Math.min(100 - TRACK_ENVELOPE_PREVIEW_EDGE_INSET_PERCENT, y)
      )
      return `${xText},${safeY.toFixed(3)}`
    }
  )

const unwrapMaybeRef = <T>(value: MaybeRef<T>): T => {
  if (value && typeof value === 'object' && 'value' in value) {
    return (value as Readonly<Ref<T>>).value
  }
  return value as T
}

export const useMixtapeEnvelopePreview = (options: UseMixtapeEnvelopePreviewOptions) => {
  const EMPTY_TRACK_LINES: TrackEnvelopePreviewLine[] = []
  const EMPTY_STEM_ROWS: TrackStemPreviewRow[] = []
  const previewParams = computed<MixtapeEnvelopeParamId[]>(() => {
    const params = options.previewParams
      ? unwrapMaybeRef(options.previewParams)
      : DEFAULT_TRACK_ENVELOPE_PREVIEW_PARAMS
    if (!Array.isArray(params) || params.length === 0) {
      return DEFAULT_TRACK_ENVELOPE_PREVIEW_PARAMS
    }
    return params
  })
  const trackEnvelopePreviewLegend = computed<TrackEnvelopePreviewLegendItem[]>(() => [
    ...previewParams.value.map((param) => ({
      key: param,
      label: param.toUpperCase(),
      color: TRACK_ENVELOPE_PREVIEW_COLORS[param],
      dotStyle: {
        backgroundColor: TRACK_ENVELOPE_PREVIEW_COLORS[param]
      }
    })),
    {
      key: 'loop-source',
      label: 'LOOP',
      color: LOOP_PREVIEW_SOURCE_COLOR,
      dotStyle: {
        borderRadius: '0',
        background: 'rgba(255, 214, 102, 0.34)',
        boxShadow: '0 0 0 1px rgba(255, 244, 182, 0.3) inset'
      }
    },
    {
      key: 'loop-repeat',
      label: 'REPEAT',
      color: LOOP_PREVIEW_REPEAT_COLOR,
      dotStyle: {
        borderRadius: '0',
        background:
          'repeating-linear-gradient(-58deg, rgba(255, 218, 92, 0.34) 0, rgba(255, 218, 92, 0.34) 3px, rgba(255, 218, 92, 0.12) 3px, rgba(255, 218, 92, 0.12) 6px)',
        boxShadow: '0 0 0 1px rgba(255, 244, 182, 0.22) inset'
      }
    }
  ])
  const trackStateModule = createGainEnvelopeTrackStateModule({
    tracks: options.tracks,
    resolveRenderZoom: () => Math.max(0, Number(unwrapMaybeRef(options.renderZoomLevel)) || 0),
    resolveTrackDurationSeconds: options.resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds: options.resolveTrackSourceDurationSeconds,
    isStemSegmentParam: (param) => STEM_PREVIEW_ROW_ORDER.includes(param as MixtapeWaveformStemId)
  })
  const { resolveTrackStemSegmentState } = trackStateModule

  const toStemPreviewColor = (stemId: MixtapeWaveformStemId, alpha: number) => {
    const { r, g, b } = resolveStemWaveformColor(stemId)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  const showStemPreviewRows = computed(() => Boolean(unwrapMaybeRef(options.showStemPreviewRows)))

  const timelineTrackAreaHeight = computed(() => {
    const laneIndices = unwrapMaybeRef(options.laneIndices)
    const laneHeight = unwrapMaybeRef(options.laneHeight)
    const laneCount = Math.max(0, Array.isArray(laneIndices) ? laneIndices.length : 0)
    const safeLaneHeight = Math.max(0, Number(laneHeight) || 0)
    if (!laneCount || !safeLaneHeight) return 0
    const laneOuterHeight = safeLaneHeight + TIMELINE_TRACK_LANE_BORDER_PX
    const gaps = Math.max(0, laneCount - 1) * TIMELINE_TRACK_LANE_GAP_PX
    const verticalPadding = TIMELINE_TRACK_VERTICAL_PADDING_PX * 2
    return Math.round(laneOuterHeight * laneCount + gaps + verticalPadding)
  })

  const timelineAdaptiveStyle = computed(() => {
    const scale = Math.max(1, Number(unwrapMaybeRef(options.timelineVisualScale)) || 1)
    const laneIndices = unwrapMaybeRef(options.laneIndices)
    const laneCount = Array.isArray(laneIndices) ? laneIndices.length : DEFAULT_LANE_COUNT
    return {
      '--timeline-envelope-preview-lane-height': `${Math.max(
        1,
        Math.round(resolveMixtapeEnvelopePreviewLaneBaseHeight(laneCount) * scale)
      )}px`,
      '--timeline-overview-lane-height': `${Math.max(
        1,
        Math.round(resolveMixtapeOverviewLaneBaseHeight(laneCount) * scale)
      )}px`
    }
  })

  const trackPreviewCache = computed(() => {
    const cache = new Map<string, TrackPreviewCacheEntry>()
    const showStemRows = showStemPreviewRows.value
    for (const track of options.tracks.value) {
      const trackId = String(track?.id || '').trim()
      if (!trackId) continue
      const durationSec = Math.max(0, Number(options.resolveTrackDurationSeconds(track)) || 0)
      if (!durationSec) {
        cache.set(trackId, { lines: EMPTY_TRACK_LINES, stemRows: EMPTY_STEM_ROWS })
        continue
      }
      const lines = previewParams.value
        .map((param) => {
          const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
          const normalizedPoints = normalizeMixEnvelopePoints(
            param,
            (track as Record<string, unknown>)[envelopeField],
            durationSec
          )
          if (normalizedPoints.length < 2) return null
          const points = buildMixEnvelopePolylineByControlPoints({
            param,
            points: normalizedPoints,
            durationSec
          })
          if (!points) return null
          return {
            key: param,
            points: normalizeEnvelopePreviewPolyline(points),
            color: TRACK_ENVELOPE_PREVIEW_COLORS[param],
            strokeWidth: TRACK_ENVELOPE_PREVIEW_STROKES[param]
          }
        })
        .filter((line): line is TrackEnvelopePreviewLine => line !== null)
      const stemRows = showStemRows
        ? STEM_PREVIEW_ROW_ORDER.map((stemId) => {
            const { durationSec: stemDurationSec, segments } = resolveTrackStemSegmentState(
              trackId,
              stemId
            )
            return {
              key: stemId,
              fillColor: toStemPreviewColor(stemId, STEM_PREVIEW_FILL_ALPHA),
              muteSegments: resolveVolumeMuteSegmentMasks(stemDurationSec, segments)
            }
          })
        : EMPTY_STEM_ROWS
      cache.set(trackId, {
        lines: lines.length ? lines : EMPTY_TRACK_LINES,
        stemRows
      })
    }
    return cache
  })

  const resolveTrackEnvelopePreviewLines = (
    item: TimelineTrackLayout
  ): TrackEnvelopePreviewLine[] =>
    trackPreviewCache.value.get(item.track.id)?.lines || EMPTY_TRACK_LINES

  const resolveTrackStemPreviewRows = (item: TimelineTrackLayout): TrackStemPreviewRow[] =>
    trackPreviewCache.value.get(item.track.id)?.stemRows || EMPTY_STEM_ROWS

  const trackEnvelopePreviewViewportStyle = computed(() => {
    const safeWidth = Math.max(0, Number(unwrapMaybeRef(options.timelineContentWidth)) || 0)
    const safeScrollLeft = Math.max(0, Number(unwrapMaybeRef(options.timelineScrollLeft)) || 0)
    return {
      width: `${safeWidth}px`,
      transform: `translate3d(${-safeScrollLeft}px, 0, 0)`
    }
  })

  return {
    trackEnvelopePreviewLegend,
    timelineTrackAreaHeight,
    timelineAdaptiveStyle,
    resolveTrackEnvelopePreviewLines,
    resolveTrackStemPreviewRows,
    trackEnvelopePreviewViewportStyle
  }
}
