import { computed } from 'vue'
import { TIMELINE_SIDE_PADDING_PX } from '@renderer/composables/mixtape/constants'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  MIXTAPE_GAIN_KNOB_MAX_DB,
  MIXTAPE_GAIN_KNOB_MIN_DB,
  buildFlatMixEnvelope,
  linearGainToDb,
  normalizeMixEnvelopePoints,
  sampleMixEnvelopeAtSec
} from '@renderer/composables/mixtape/gainEnvelope'
import {
  isSecMutedBySegments,
  normalizeVolumeMuteSegments
} from '@renderer/composables/mixtape/volumeMuteSegments'
import { mapLoopedTrackLocalToBaseLocal } from '@renderer/composables/mixtape/mixtapeTrackLoop'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
  MixtapeTrack,
  MixtapeTrackLoopSegment,
  TimelineLayoutSnapshot,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'

type TransportEntryLike = {
  trackId: string
  duration: number
  trackDuration?: number
  localStartSec?: number
  tempoSnapshot?: {
    baseDurationSec?: number
    loopSegments?: MixtapeTrackLoopSegment[]
    loopSegment?: MixtapeTrackLoopSegment
  }
  mixEnvelopes: Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[]>>
  mixEnvelopeSources: Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[] | undefined>>
  volumeMuteSegments: MixtapeMuteSegment[]
  volumeMuteSegmentsSource?: MixtapeMuteSegment[]
}

type ValueRef<T> = {
  value: T
}

type TimelineTransportResolversContext = {
  tracks: ValueRef<MixtapeTrack[]>
  timelineLayout: ValueRef<TimelineLayoutSnapshot>
  normalizedRenderZoom: ValueRef<number>
  timelineScrollLeft: ValueRef<number>
  timelineViewportWidth: ValueRef<number>
  rulerRef: ValueRef<HTMLElement | null>
  playheadSec: ValueRef<number>
  playheadVisible: ValueRef<boolean>
  transportPlaying: ValueRef<boolean>
  transportPreloadDone: ValueRef<number>
  transportPreloadTotal: ValueRef<number>
  transportDurationSecRef: ValueRef<number>
  computeTimelineDuration: () => number
  resolveRenderPxPerSec: (zoomValue: number) => number
  buildSequentialLayoutForZoom: (zoomValue: number) => TimelineLayoutSnapshot
  clampNumber: (value: number, min: number, max: number) => number
  segmentMuteGain: number
}

type RulerTickAlign = 'start' | 'center' | 'end'
type RulerMinuteTick = {
  left: string
  sec: number
  label: string
  align: RulerTickAlign
}
const RULER_TICK_STEPS_SEC = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1200, 1800] as const
const RULER_TICK_LABEL_MIN_PX = 30
const RULER_TICK_MAX_COUNT = 280

export const createTimelineTransportResolversModule = (ctx: TimelineTransportResolversContext) => {
  const {
    tracks,
    timelineLayout,
    normalizedRenderZoom,
    timelineScrollLeft,
    timelineViewportWidth,
    rulerRef,
    playheadSec,
    playheadVisible,
    transportPlaying,
    transportPreloadDone,
    transportPreloadTotal,
    transportDurationSecRef,
    computeTimelineDuration,
    resolveRenderPxPerSec,
    buildSequentialLayoutForZoom,
    clampNumber,
    segmentMuteGain
  } = ctx

  const timelineDurationSec = computed(() => computeTimelineDuration())
  const transportPreloadPercent = computed(() => {
    if (!transportPreloadTotal.value) return 0
    return clampNumber(
      Math.round((transportPreloadDone.value / transportPreloadTotal.value) * 100),
      0,
      100
    )
  })

  const resolveTimelineDisplayX = (sec: number, pxPerSec: number, maxX: number) => {
    const x = TIMELINE_SIDE_PADDING_PX + sec * pxPerSec
    return clampNumber(x, TIMELINE_SIDE_PADDING_PX, maxX)
  }

  const resolveTimelineSecByX = (x: number, pxPerSec: number) => {
    if (!Number.isFinite(pxPerSec) || pxPerSec <= 0) return 0
    const timelineX = Math.max(0, x - TIMELINE_SIDE_PADDING_PX)
    return Math.max(0, timelineX / pxPerSec)
  }

  const resolveRulerLeftInset = () => {
    const rulerEl = (rulerRef?.value as HTMLElement | null) || null
    if (!rulerEl) return 0
    const inset = Number(rulerEl.clientLeft || 0)
    if (!Number.isFinite(inset) || inset <= 0) return 0
    return inset
  }

  const snapViewportX = (value: number) => {
    const safe = Math.max(0, Number(value) || 0)
    if (typeof window === 'undefined') return safe
    const dpr = Number(window.devicePixelRatio || 1)
    if (!Number.isFinite(dpr) || dpr <= 0) return safe
    return Math.round(safe * dpr) / dpr
  }

  const resolveTransportDuration = () => {
    const total =
      Number(transportDurationSecRef.value) > 0
        ? Number(transportDurationSecRef.value)
        : timelineDurationSec.value
    if (!Number.isFinite(total) || total <= 0) return 0
    return total
  }

  const overviewPlayheadStyle = computed(() => {
    const totalWidth = Math.max(0, timelineLayout.value.totalWidth)
    const pxPerSec = Math.max(0, resolveRenderPxPerSec(normalizedRenderZoom.value))
    // 概览矩形包含画布两端留白，播放线必须使用同一像素坐标和画布宽度。
    // 音频计划的时长只负责播放调度，不能作为概览的位置分母。
    const x = totalWidth > 0 ? resolveTimelineDisplayX(playheadSec.value, pxPerSec, totalWidth) : 0
    return {
      left: `${totalWidth > 0 ? (x / totalWidth) * 100 : 0}%`,
      opacity: playheadVisible.value ? (transportPlaying.value ? '1' : '0.45') : '0'
    }
  })

  const playheadViewportX = computed(() => {
    const totalWidth = Math.max(0, timelineLayout.value.totalWidth)
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const totalSec = resolveTransportDuration()
    if (!totalSec || !totalWidth) return TIMELINE_SIDE_PADDING_PX
    const maxX = Math.max(TIMELINE_SIDE_PADDING_PX, totalWidth + TIMELINE_SIDE_PADDING_PX)
    const x = resolveTimelineDisplayX(playheadSec.value, pxPerSec, maxX)
    const scrollLeft = Math.max(0, Number(timelineScrollLeft.value) || 0)
    return x - scrollLeft
  })

  const playheadViewportVisible = computed(() => {
    const viewportWidth = Math.max(1, Number(timelineViewportWidth.value) || 0)
    const x = Number(playheadViewportX.value) || 0
    return x >= 0 && x <= viewportWidth
  })

  const playheadViewportStyle = computed(() => ({
    left: `${snapViewportX(playheadViewportX.value)}px`,
    opacity:
      playheadVisible.value && playheadViewportVisible.value
        ? transportPlaying.value
          ? '1'
          : '0.45'
        : '0'
  }))

  const rulerPlayheadStyle = computed(() => {
    const rulerInset = resolveRulerLeftInset()
    const rulerX = playheadViewportX.value - rulerInset
    const rulerWidth = Math.max(1, Number(rulerRef?.value?.clientWidth || 0))
    return {
      left: `${snapViewportX(rulerX)}px`,
      opacity:
        playheadVisible.value && rulerX >= 0 && rulerX <= rulerWidth
          ? transportPlaying.value
            ? '1'
            : '0.45'
          : '0'
    }
  })

  const timelinePlayheadStyle = computed(() => {
    return playheadViewportStyle.value
  })

  const formatTransportTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00.00'
    const total = Math.floor(seconds)
    const min = Math.floor(total / 60)
    const sec = total % 60
    const fraction = Math.floor((seconds - total) * 100)
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`
  }

  const formatRulerTickLabel = (seconds: number) => {
    const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0))
    const minute = Math.floor(safeSeconds / 60)
    const sec = safeSeconds % 60
    return `${minute}:${String(sec).padStart(2, '0')}`
  }

  const playheadTimeLabel = computed(() => formatTransportTime(playheadSec.value))
  const timelineDurationLabel = computed(() => formatTransportTime(timelineDurationSec.value))

  type RulerViewportMetrics = {
    pxPerSec: number
    totalWidth: number
    viewportWidth: number
    viewportStartX: number
    viewportStartSec: number
    viewportEndSec: number
    timelineEndSec: number
  }

  const resolveRulerViewportMetrics = (): RulerViewportMetrics => {
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const totalWidth = Math.max(1, timelineLayout.value.totalWidth)
    const viewportWidth = Math.max(1, Number(timelineViewportWidth.value) || totalWidth)
    const maxScroll = Math.max(0, totalWidth - viewportWidth)
    const viewportStartX = clampNumber(Number(timelineScrollLeft.value) || 0, 0, maxScroll)
    const viewportEndX = viewportStartX + viewportWidth
    const viewportStartSec = resolveTimelineSecByX(viewportStartX, pxPerSec)
    const viewportEndSec = Math.max(viewportStartSec, resolveTimelineSecByX(viewportEndX, pxPerSec))
    const timelineEndSec = Math.max(0, timelineDurationSec.value)
    return {
      pxPerSec,
      totalWidth,
      viewportWidth,
      viewportStartX,
      viewportStartSec,
      viewportEndSec,
      timelineEndSec
    }
  }

  const resolveAdaptiveRulerStepSec = (pxPerSec: number, visibleSec: number) => {
    const safeVisibleSec = Math.max(0, Number(visibleSec) || 0)
    const minStepByCount = safeVisibleSec / RULER_TICK_MAX_COUNT
    const candidateSteps = RULER_TICK_STEPS_SEC.filter((stepSec) => stepSec >= minStepByCount)
    const fallbackStep =
      candidateSteps[0] || RULER_TICK_STEPS_SEC[RULER_TICK_STEPS_SEC.length - 1] || 60
    for (const stepSec of candidateSteps) {
      if (stepSec * pxPerSec >= RULER_TICK_LABEL_MIN_PX) return stepSec
    }
    return fallbackStep
  }

  const rulerMinuteTicks = computed<RulerMinuteTick[]>(() => {
    const metrics = resolveRulerViewportMetrics()
    const {
      pxPerSec,
      totalWidth,
      viewportWidth,
      viewportStartX,
      viewportStartSec,
      viewportEndSec,
      timelineEndSec
    } = metrics
    if (viewportWidth <= 0 || timelineEndSec <= 0) {
      return []
    }
    const safeViewportEndSec = Math.min(viewportEndSec, timelineEndSec)
    const visibleSec = Math.max(0, safeViewportEndSec - viewportStartSec)
    if (visibleSec <= 0) return []
    const stepSec = Math.max(1, resolveAdaptiveRulerStepSec(pxPerSec, visibleSec))

    const firstTick = Math.ceil(viewportStartSec / stepSec)
    const endTick = Math.floor(safeViewportEndSec / stepSec)
    const ticks: RulerMinuteTick[] = []
    for (let index = firstTick; index <= endTick; index += 1) {
      const sec = index * stepSec
      const x = resolveTimelineDisplayX(sec, pxPerSec, totalWidth)
      const localX = x - viewportStartX
      const ratio = clampNumber(localX / viewportWidth, 0, 1)
      const left = `${(ratio * 100).toFixed(4)}%`
      let align: RulerTickAlign = 'center'
      if (ratio <= 0.0001 || sec <= 0.0001) {
        align = 'start'
      } else if (ratio >= 0.9999 || Math.abs(sec - timelineEndSec) <= 0.0001) {
        align = 'end'
      }
      ticks.push({
        left,
        sec: Number(sec.toFixed(3)),
        label: formatRulerTickLabel(sec),
        align
      })
      if (ticks.length >= RULER_TICK_MAX_COUNT) break
    }
    return ticks
  })

  const rulerInactiveStyle = computed<Record<string, string> | null>(() => {
    const totalWidth = Math.max(0, timelineLayout.value.totalWidth)
    const viewportWidth = Math.max(1, Number(timelineViewportWidth.value) || 0)
    if (totalWidth <= 0 || viewportWidth <= 0 || totalWidth >= viewportWidth) return null
    const activeRatio = clampNumber(totalWidth / viewportWidth, 0, 1)
    const inactiveRatio = 1 - activeRatio
    if (inactiveRatio <= 0.0001) return null
    return {
      left: `${(activeRatio * 100).toFixed(4)}%`,
      width: `${(inactiveRatio * 100).toFixed(4)}%`
    }
  })

  const resolveTrackStartSec = (track: MixtapeTrack) => {
    const numeric = Number(track.startSec)
    if (Number.isFinite(numeric)) return numeric
    return 0
  }

  const resolveTrackStartSecById = (trackId: string) => {
    if (!trackId) return 0
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const snapshot = buildSequentialLayoutForZoom(normalizedRenderZoom.value)
    const item = snapshot.layout.find(
      (candidate: TimelineTrackLayout) => candidate.track.id === trackId
    )
    if (!item) return 0
    const layoutStartSec = Number(item.startSec)
    if (Number.isFinite(layoutStartSec)) return layoutStartSec
    return resolveTimelineSecByX(item.startX, pxPerSec)
  }

  const resolveTrackMixEnvelope = (
    track: MixtapeTrack,
    durationSec: number,
    param: MixtapeEnvelopeParamId
  ) => {
    const safeDuration = Math.max(0, Number(durationSec) || 0)
    const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
    const normalized = normalizeMixEnvelopePoints(param, track[envelopeField], safeDuration)
    if (normalized.length > 0) return normalized
    return buildFlatMixEnvelope(param, safeDuration, 1)
  }

  const resolveEntryEnvelopeValue = (
    entry: TransportEntryLike,
    param: MixtapeEnvelopeParamId,
    timelineOffsetSec: number
  ) => {
    const latestTrack = tracks.value.find((track: MixtapeTrack) => track.id === entry.trackId)
    const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
    const latestEnvelopeSource = latestTrack ? latestTrack[envelopeField] : undefined
    const baseDuration = Math.max(
      0,
      Number(entry.tempoSnapshot?.baseDurationSec ?? entry.trackDuration ?? entry.duration) || 0
    )
    if (latestTrack && latestEnvelopeSource !== entry.mixEnvelopeSources[param]) {
      entry.mixEnvelopes[param] = resolveTrackMixEnvelope(latestTrack, baseDuration, param)
      entry.mixEnvelopeSources[param] = latestEnvelopeSource
    }
    if (param === 'volume' && latestTrack) {
      const latestMuteSource = latestTrack.volumeMuteSegments
      if (latestMuteSource !== entry.volumeMuteSegmentsSource) {
        entry.volumeMuteSegments = normalizeVolumeMuteSegments(latestMuteSource, baseDuration)
        entry.volumeMuteSegmentsSource = latestMuteSource
      }
    }
    const trackDuration = Math.max(0, Number(entry.trackDuration ?? entry.duration) || 0)
    const localStartSec = Math.max(0, Number(entry.localStartSec) || 0)
    const safeOffset = clampNumber(timelineOffsetSec, 0, Math.max(0, entry.duration))
    const localSec = clampNumber(localStartSec + safeOffset, 0, Math.max(0, trackDuration))
    const baseLocalSec = mapLoopedTrackLocalToBaseLocal(
      localSec,
      baseDuration,
      entry.tempoSnapshot?.loopSegments ?? entry.tempoSnapshot?.loopSegment
    )
    const envelopeGain = sampleMixEnvelopeAtSec(param, entry.mixEnvelopes[param], baseLocalSec, 1)
    if (param !== 'volume') return envelopeGain
    const muted = isSecMutedBySegments(entry.volumeMuteSegments, baseLocalSec)
    return muted ? segmentMuteGain : envelopeGain
  }

  const resolveEntryEqDbValue = (
    entry: TransportEntryLike,
    param: 'high' | 'mid' | 'low',
    timelineOffsetSec: number
  ) => {
    const gain = resolveEntryEnvelopeValue(entry, param, timelineOffsetSec)
    return clampNumber(linearGainToDb(gain), MIXTAPE_GAIN_KNOB_MIN_DB, MIXTAPE_GAIN_KNOB_MAX_DB)
  }

  return {
    timelineDurationSec,
    transportPreloadPercent,
    resolveTimelineDisplayX,
    resolveTimelineSecByX,
    overviewPlayheadStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    playheadTimeLabel,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    resolveTrackStartSec,
    resolveTrackStartSecById,
    resolveTrackMixEnvelope,
    resolveEntryEnvelopeValue,
    resolveEntryEqDbValue
  }
}
