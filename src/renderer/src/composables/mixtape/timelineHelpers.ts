import { RendererFilePathSet } from '@renderer/utils/filePathComparison'
import { computed } from 'vue'
import {
  BASE_PX_PER_SEC,
  FALLBACK_TRACK_WIDTH,
  GRID_BEAT_LINE_WIDTH,
  LANE_COUNT,
  MIXTAPE_BASE_TRACK_LANE_HEIGHT,
  MIXTAPE_WAVEFORM_HEIGHT_SCALE,
  MIN_TRACK_WIDTH,
  TIMELINE_END_EXTENSION_PX,
  TIMELINE_SIDE_PADDING_PX,
  MIXTAPE_WIDTH_SCALE,
  RAW_WAVEFORM_MIN_ZOOM,
  RENDER_ZOOM_STEP,
  normalizeMixtapeLaneIndex,
  resolveTimelineGridBarWidth,
  WAVEFORM_TILE_WIDTH,
  ZOOM_MAX,
  ZOOM_MIN
} from '@renderer/composables/mixtape/constants'
import {
  resolveFirstBeatTimelineSec,
  resolveTempoRatioByBpm
} from '@renderer/composables/mixtape/beatSyncModel'
import { resolveMixtapeAudioFirstBeatSec } from '@renderer/composables/mixtape/mixtapeAudioGridBasis'
import { resolveRoundedTrackLocalPx } from '@renderer/composables/mixtape/timelinePixelMath'
import { buildTrackRuntimeTempoSnapshot } from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import {
  buildFlatTrackBpmEnvelope,
  formatTrackBpmDisplay
} from '@renderer/composables/mixtape/trackTempoModel'
import {
  buildGainEnvelopePolylineByControlPoints,
  normalizeGainEnvelopePoints,
  MIXTAPE_GAIN_KNOB_MAX_DB,
  MIXTAPE_GAIN_KNOB_MIN_DB
} from '@renderer/composables/mixtape/gainEnvelope'
import { resolveRawWaveformLevel as resolveRawWaveformLevelByMap } from '@renderer/composables/mixtape/waveformPyramid'
import type { UnifiedDisplayWaveformDetailData } from '@shared/unifiedDisplayWaveform'
import type {
  MinMaxSample,
  MixtapeMixMode,
  MixtapeTrack,
  MixtapeWaveformStemId,
  RawWaveformData,
  RawWaveformLevel,
  StemWaveformData,
  TimelineLayoutSnapshot,
  TimelineTrackLayout,
  WaveformTile
} from '@renderer/composables/mixtape/types'

type TrackWaveformSource = {
  filePath: string
  listRoot: string
  laneIndex: number
  laneCount: number
  stemId: MixtapeWaveformStemId
}

type ValueRef<T> = {
  value: T
}

type WaveformCacheEntry = {
  source: CanvasImageSource
  used: number
}

type TimelineGridLineLevel = 'downbeat' | 'beat'

type TimelineGridLineStyle = {
  haloColor: string
  coreColor: string
  haloExtraWidth: number
}

type TimelineHelpersContext = {
  zoom: ValueRef<number>
  renderZoom: ValueRef<number>
  tracks: ValueRef<MixtapeTrack[]>
  mixtapeMixMode: ValueRef<MixtapeMixMode>
  mixtapeStemMode?: ValueRef<unknown>
  t: (key: string) => string
  libraryUtils: {
    findDirPathByUuid: (uuid: string) => string
  }
  waveformDataMap: Map<string, StemWaveformData | UnifiedDisplayWaveformDetailData | null>
  rawWaveformDataMap: Map<string, RawWaveformData | null>
  waveformInflight: Set<string>
  rawWaveformInflight: Set<string>
  waveformMinMaxCache: Map<
    string,
    { source: StemWaveformData | UnifiedDisplayWaveformDetailData; samples: MinMaxSample[] }
  >
  rawWaveformPyramidMap: Map<string, RawWaveformLevel[]>
  timelineLayoutCache: Map<number, TimelineLayoutSnapshot>
  timelineLayoutVersion: ValueRef<number>
  waveformVersion: ValueRef<number>
  overviewWidth: ValueRef<number>
  timelineVisualScale: ValueRef<number>
  waveformTileCache: Map<string, WaveformCacheEntry>
  waveformTileCacheIndex: Map<string, Set<string>>
  waveformTileCacheTickRef: ValueRef<number>
  waveformTileCacheLimitRef: ValueRef<number>
}

export const createTimelineHelpersModule = (ctx: TimelineHelpersContext) => {
  const {
    zoom,
    renderZoom,
    tracks,
    mixtapeMixMode,
    t,
    libraryUtils,
    waveformDataMap,
    rawWaveformDataMap,
    waveformInflight,
    rawWaveformInflight,
    waveformMinMaxCache,
    rawWaveformPyramidMap,
    timelineLayoutCache,
    timelineLayoutVersion,
    waveformVersion,
    timelineVisualScale,
    waveformTileCache,
    waveformTileCacheIndex,
    waveformTileCacheTickRef,
    waveformTileCacheLimitRef
  } = ctx

  const getWaveformTileCacheTick = () => Number(waveformTileCacheTickRef.value || 0)
  const setWaveformTileCacheTick = (value: number) => {
    waveformTileCacheTickRef.value = value
  }
  const getWaveformTileCacheLimit = () => Number(waveformTileCacheLimitRef.value || 0)

  const clampZoomValue = (value: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value))

  const buildZoomLevels = () => {
    const levels: number[] = []
    const min = ZOOM_MIN
    const max = ZOOM_MAX
    const step = RENDER_ZOOM_STEP
    const extra = min + step / 2
    const pushLevel = (value: number) => {
      if (value < min - 0.0001 || value > max + 0.0001) return
      const rounded = Number(value.toFixed(3))
      if (levels.some((item) => Math.abs(item - rounded) < 0.0001)) return
      levels.push(rounded)
    }
    pushLevel(min)
    if (extra > min && extra < min + step - 0.0001) pushLevel(extra)
    for (let cursor = min + step; cursor <= max + 0.0001; cursor += step) {
      pushLevel(cursor)
    }
    pushLevel(max)
    levels.sort((a, b) => a - b)
    return levels
  }

  const ZOOM_LEVELS = buildZoomLevels()

  const quantizeRenderZoom = (value: number) => {
    const clamped = clampZoomValue(value)
    if (!ZOOM_LEVELS.length) return clamped
    let nearest = ZOOM_LEVELS[0]
    let bestDiff = Math.abs(clamped - nearest)
    for (let i = 1; i < ZOOM_LEVELS.length; i += 1) {
      const candidate = ZOOM_LEVELS[i]
      const diff = Math.abs(clamped - candidate)
      if (diff < bestDiff) {
        bestDiff = diff
        nearest = candidate
      }
    }
    return clampZoomValue(Number(nearest.toFixed(3)))
  }

  const normalizedZoom = computed(() => {
    const value = Number.isFinite(zoom.value) ? zoom.value : 1
    return clampZoomValue(value)
  })

  const normalizedRenderZoom = computed(() => {
    const value = Number.isFinite(renderZoom.value) ? renderZoom.value : normalizedZoom.value
    return clampZoomValue(value)
  })

  const resolveRenderZoomLevel = (value: number) => quantizeRenderZoom(value)

  const alignZoomToRenderLevel = (value: number) => resolveRenderZoomLevel(value)

  const resolveGridBarWidth = (zoomValue: number) => {
    return resolveTimelineGridBarWidth(zoomValue)
  }

  const resolveTimelineVisualScale = () => {
    const numeric = Number(timelineVisualScale?.value)
    if (!Number.isFinite(numeric) || numeric <= 0) return 1
    return Math.max(0.56, numeric)
  }

  const resolveLaneHeightForZoom = (_value: number) =>
    Math.round(MIXTAPE_BASE_TRACK_LANE_HEIGHT * resolveTimelineVisualScale())

  const resolveTimelineBufferId = (zoomValue: number) => `z:${Math.round(zoomValue * 1000)}`

  const laneHeight = computed(() => resolveLaneHeightForZoom(normalizedRenderZoom.value))

  const laneIndices = Array.from({ length: LANE_COUNT }, (_, index) => index)
  const resolveTrackLaneIndex = (track: MixtapeTrack, fallbackIndex: number) =>
    normalizeMixtapeLaneIndex(track?.laneIndex, fallbackIndex % LANE_COUNT)
  const STEM_IDS_4STEMS: MixtapeWaveformStemId[] = ['vocal', 'inst', 'bass', 'drums']
  const isStemMixMode = (): boolean =>
    (mixtapeMixMode?.value as MixtapeMixMode | undefined) !== 'eq'

  const resolveWaveformStemIds = (): MixtapeWaveformStemId[] => STEM_IDS_4STEMS

  const resolveTrackStemFilePath = (track: MixtapeTrack, stemId: MixtapeWaveformStemId): string => {
    if (stemId === 'vocal') return String(track.stemVocalPath || '').trim()
    if (stemId === 'inst') return String(track.stemInstPath || '').trim()
    if (stemId === 'bass') return String(track.stemBassPath || '').trim()
    return String(track.stemDrumsPath || '').trim()
  }

  const resolveWaveformSubLaneMetrics = (
    laneHeightValue: number,
    laneIndexValue: number,
    laneCountValue: number
  ) => {
    const safeHeight = Math.max(1, Math.round(Number(laneHeightValue) || 0))
    const safeCount = Math.max(1, Math.floor(Number(laneCountValue) || 1))
    const safeIndex = Math.max(0, Math.min(safeCount - 1, Math.floor(Number(laneIndexValue) || 0)))
    const start = Math.floor((safeHeight * safeIndex) / safeCount)
    const end = Math.floor((safeHeight * (safeIndex + 1)) / safeCount)
    return {
      offset: start,
      height: Math.max(1, end - start)
    }
  }

  const resolveTrackTitle = (track: MixtapeTrack) => {
    const title = String(track?.title || '').trim()
    if (title) return title
    const filePath = String(track?.filePath || '')
    if (!filePath) return ''
    return filePath.split(/[\\/]/).pop() || filePath
  }

  const formatTrackBpm = (value?: number) => {
    return formatTrackBpmDisplay(value)
  }

  const useHalfWaveform = () => false

  const resolveRenderPxPerSec = (value: number) =>
    BASE_PX_PER_SEC * MIXTAPE_WIDTH_SCALE * clampZoomValue(value)

  const pxPerSec = computed(() => resolveRenderPxPerSec(normalizedZoom.value))

  const renderPxPerSec = computed(() => resolveRenderPxPerSec(normalizedRenderZoom.value))

  const useRawWaveform = computed(
    () => isStemMixMode() && normalizedZoom.value >= RAW_WAVEFORM_MIN_ZOOM
  )

  const parseDurationToSeconds = (input: string) => {
    if (!input) return 0
    const parts = String(input)
      .trim()
      .split(':')
      .map((part) => Number(part))
      .filter((value) => Number.isFinite(value))
    if (!parts.length) return 0
    if (parts.length === 1) return Math.max(0, parts[0])
    if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1])
    return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2])
  }

  const resolveValidBpm = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return null
    return numeric
  }

  const resolveTrackTempoRatio = (track: MixtapeTrack, targetBpm?: number) => {
    const target = resolveValidBpm(targetBpm ?? track.bpm)
    const original = resolveValidBpm(track.originalBpm)
    if (!target || !original) return 1
    return resolveTempoRatioByBpm(target, original)
  }

  const resolveTrackTimeMapSignature = (track: MixtapeTrack, durationSec?: number) => {
    const sourceDurationSec = resolveTrackSourceDurationSeconds(track)
    return buildTrackRuntimeTempoSnapshot({
      track,
      sourceDurationSec,
      durationSec
    }).signature
  }

  const resolveTrackGridSignature = (track: MixtapeTrack, durationSec?: number) =>
    [
      resolveTrackTimeMapSignature(track, durationSec),
      Math.round(
        (Number.isFinite(Number(track.firstBeatMs)) ? Number(track.firstBeatMs) : 0) * 1000
      ),
      Math.round(Number(track.downbeatBeatOffset) || 0)
    ].join('|')

  const resolveTrackFirstBeatSeconds = (track: MixtapeTrack, targetBpm?: number) => {
    const firstBeatSourceSec = resolveMixtapeAudioFirstBeatSec(track)
    if (!Number.isFinite(firstBeatSourceSec) || firstBeatSourceSec <= 0) return 0

    const hasTargetBpm =
      typeof targetBpm === 'number' && Number.isFinite(targetBpm) && Number(targetBpm) > 0
    const sourceDurationSec = resolveTrackSourceDurationSeconds(track)
    const effectiveTrack = hasTargetBpm
      ? ({ ...track, bpm: Number(targetBpm) } satisfies MixtapeTrack)
      : track
    const explicitRawPoints =
      hasTargetBpm && sourceDurationSec > 0
        ? buildFlatTrackBpmEnvelope(
            sourceDurationSec / Math.max(0.01, resolveTrackTempoRatio(track, Number(targetBpm))),
            Number(targetBpm)
          )
        : undefined
    const snapshot = buildTrackRuntimeTempoSnapshot({
      track: effectiveTrack,
      sourceDurationSec,
      rawPoints: explicitRawPoints
    })
    if (
      sourceDurationSec > 0 &&
      snapshot.durationSec > 0 &&
      snapshot.timeMap.renderPoints.length >= 2
    ) {
      return snapshot.timeMap.mapSourceToLocal(firstBeatSourceSec)
    }
    const ratio = resolveTrackTempoRatio(
      effectiveTrack,
      hasTargetBpm ? Number(targetBpm) : undefined
    )
    return resolveFirstBeatTimelineSec(firstBeatSourceSec * 1000, ratio)
  }

  const resolveTrackFirstBeatMs = (track: MixtapeTrack, targetBpm?: number) => {
    const firstBeatSec = resolveTrackFirstBeatSeconds(track, targetBpm)
    if (!Number.isFinite(firstBeatSec) || firstBeatSec <= 0) return 0
    return firstBeatSec * 1000
  }

  const resolveTrackSourceDurationSeconds = (track: MixtapeTrack) => {
    void waveformVersion?.value
    const candidateFilePaths = [String(track.filePath || '').trim()].filter(Boolean)
    for (const filePath of candidateFilePaths) {
      const data = waveformDataMap.get(filePath) || null
      if (data && Number.isFinite(data.duration) && data.duration > 0) {
        return data.duration
      }
      const rawData = rawWaveformDataMap.get(filePath) || null
      if (rawData && Number.isFinite(rawData.duration) && rawData.duration > 0) {
        return rawData.duration
      }
    }
    return parseDurationToSeconds(track.duration)
  }

  const resolveTrackDurationSeconds = (track: MixtapeTrack) => {
    void waveformVersion?.value
    const sourceDuration = resolveTrackSourceDurationSeconds(track)
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) return 0
    return buildTrackRuntimeTempoSnapshot({
      track,
      sourceDurationSec: sourceDuration
    }).durationSec
  }

  const resolveTrackRenderWidthPx = (track: MixtapeTrack, zoomValue?: number) => {
    const duration = resolveTrackDurationSeconds(track)
    if (!duration || !Number.isFinite(duration)) return FALLBACK_TRACK_WIDTH
    const px = resolveRenderPxPerSec(
      typeof zoomValue === 'number' ? zoomValue : normalizedRenderZoom.value
    )
    return Math.max(MIN_TRACK_WIDTH, Math.round(duration * px))
  }

  const clearTimelineLayoutCache = () => {
    timelineLayoutCache.clear()
    if (timelineLayoutVersion && typeof timelineLayoutVersion.value === 'number') {
      timelineLayoutVersion.value += 1
    }
  }

  const resolveFirstVisibleLayoutIndex = (endOffsets: number[], minX: number) => {
    if (!endOffsets.length) return -1
    let left = 0
    let right = endOffsets.length - 1
    let answer = -1
    while (left <= right) {
      const middle = (left + right) >> 1
      const endX = endOffsets[middle] || 0
      if (endX >= minX) {
        answer = middle
        right = middle - 1
      } else {
        left = middle + 1
      }
    }
    return answer
  }

  const forEachVisibleLayoutItem = (
    snapshot: TimelineLayoutSnapshot,
    visibleStart: number,
    visibleEnd: number,
    visitor: (item: TimelineTrackLayout) => void
  ) => {
    if (!snapshot.layout.length) return
    if (visibleEnd < visibleStart) return
    const first = resolveFirstVisibleLayoutIndex(snapshot.endOffsets, visibleStart)
    if (first < 0) return
    for (let index = first; index < snapshot.layout.length; index += 1) {
      const startX = snapshot.startOffsets[index] || 0
      if (startX > visibleEnd) break
      const item = snapshot.layout[index]
      if (!item) continue
      visitor(item)
    }
  }

  const buildSequentialLayoutForZoom = (zoomValue: number): TimelineLayoutSnapshot => {
    const resolvedZoom = resolveRenderZoomLevel(zoomValue)
    const cacheKey = Math.round(resolvedZoom * 1000)
    const cached = timelineLayoutCache.get(cacheKey)
    if (cached) return cached

    const px = resolveRenderPxPerSec(resolvedZoom)
    let cursorPx = TIMELINE_SIDE_PADDING_PX
    let cursorSec = 0
    const layout: TimelineTrackLayout[] = []

    for (let i = 0; i < tracks.value.length; i += 1) {
      const track = tracks.value[i]
      if (!track) continue
      const width = resolveTrackRenderWidthPx(track, resolvedZoom)
      const durationSec = resolveTrackDurationSeconds(track)
      const rawStartSec = Number(track.startSec)
      const startSec = Number.isFinite(rawStartSec) ? rawStartSec : cursorSec
      const startX = TIMELINE_SIDE_PADDING_PX + Math.round(startSec * px)
      const endX = startX + width
      cursorPx = Math.max(cursorPx, endX)
      if (Number.isFinite(durationSec) && durationSec > 0) {
        cursorSec = Math.max(cursorSec, startSec + durationSec)
      } else {
        cursorSec = Math.max(cursorSec, endX / Math.max(0.0001, px))
      }
      layout.push({
        track,
        laneIndex: resolveTrackLaneIndex(track, i),
        startSec,
        startX,
        width
      })
    }

    layout.sort((a, b) => a.startX - b.startX)
    const startOffsets: number[] = []
    const endOffsets: number[] = []
    let runningEnd = 0
    for (const item of layout) {
      startOffsets.push(item.startX)
      runningEnd = Math.max(runningEnd, item.startX + item.width)
      endOffsets.push(runningEnd)
    }
    const lastEnd = endOffsets[endOffsets.length - 1] || 0

    const timelineEndX = Math.max(cursorPx, lastEnd)
    const snapshot = {
      layout,
      totalWidth: Math.max(
        TIMELINE_SIDE_PADDING_PX * 2,
        timelineEndX + TIMELINE_SIDE_PADDING_PX + TIMELINE_END_EXTENSION_PX
      ),
      startOffsets,
      endOffsets
    }
    timelineLayoutCache.set(cacheKey, snapshot)
    return snapshot
  }

  const resolveTrackBlockStyle = (item: TimelineTrackLayout) => ({
    width: `${Math.max(0, Math.round(item.width))}px`,
    left: `${Math.round(item.startX)}px`,
    '--track-start': `${Math.round(item.startX)}px`
  })

  const resolveGainEnvelopePolyline = (item: TimelineTrackLayout) => {
    const currentTrack =
      tracks.value.find((track: MixtapeTrack) => track.id === item.track.id) || item.track
    const trackDurationSec = resolveTrackDurationSeconds(currentTrack)
    const safeDuration = Math.max(0, Number(trackDurationSec) || 0)
    const envelope = normalizeGainEnvelopePoints(currentTrack.gainEnvelope, safeDuration)
    return buildGainEnvelopePolylineByControlPoints({
      points: envelope,
      durationSec: safeDuration,
      minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
      maxDb: MIXTAPE_GAIN_KNOB_MAX_DB
    })
  }

  const resolveOverviewTrackStyle = (item: TimelineTrackLayout) => {
    const totalWidth = Math.max(
      1,
      buildSequentialLayoutForZoom(normalizedRenderZoom.value).totalWidth
    )
    return {
      width: `${Math.max(0, (item.width / totalWidth) * 100)}%`,
      left: `${Math.max(0, (item.startX / totalWidth) * 100)}%`
    }
  }

  const resolveTrackTilesForWidth = (trackWidth: number): WaveformTile[] => {
    if (!trackWidth || !Number.isFinite(trackWidth)) return []
    const count = Math.max(1, Math.ceil(trackWidth / WAVEFORM_TILE_WIDTH))
    const tiles: WaveformTile[] = []
    for (let i = 0; i < count; i += 1) {
      const start = i * WAVEFORM_TILE_WIDTH
      const width = Math.max(0, Math.min(WAVEFORM_TILE_WIDTH, trackWidth - start))
      if (width <= 0) continue
      tiles.push({ index: i, start, width })
    }
    return tiles
  }

  const isLightTheme = () => {
    if (typeof document === 'undefined') return false
    const htmlEl = document.documentElement
    const bodyEl = document.body
    return (
      Boolean(htmlEl?.classList.contains('theme-light')) ||
      Boolean(bodyEl?.classList.contains('theme-light'))
    )
  }

  const resolveGridLineStyle = (level: TimelineGridLineLevel): TimelineGridLineStyle => {
    const light = isLightTheme()
    if (level === 'downbeat') {
      return light
        ? {
            haloColor: 'rgba(255, 255, 255, 0.72)',
            coreColor: 'rgba(15, 23, 42, 0.68)',
            haloExtraWidth: 2.4
          }
        : {
            haloColor: 'rgba(0, 0, 0, 0.62)',
            coreColor: 'rgba(245, 247, 250, 0.84)',
            haloExtraWidth: 2.4
          }
    }
    return light
      ? {
          haloColor: 'rgba(255, 255, 255, 0.34)',
          coreColor: 'rgba(15, 23, 42, 0.24)',
          haloExtraWidth: 1
        }
      : {
          haloColor: 'rgba(0, 0, 0, 0.3)',
          coreColor: 'rgba(226, 232, 240, 0.28)',
          haloExtraWidth: 1
        }
  }

  const drawNeutralGridLine = (
    context: CanvasRenderingContext2D,
    x: number,
    width: number,
    height: number,
    level: TimelineGridLineLevel
  ) => {
    const coreWidth = Math.max(1, width)
    const style = resolveGridLineStyle(level)
    const haloWidth = Math.max(coreWidth, coreWidth + style.haloExtraWidth)
    const centerX = x + coreWidth / 2
    context.fillStyle = style.haloColor
    context.fillRect(centerX - haloWidth / 2, 0, haloWidth, height)
    context.fillStyle = style.coreColor
    context.fillRect(centerX - coreWidth / 2, 0, coreWidth, height)
  }

  const drawTrackGridLines = (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    track: MixtapeTrack,
    trackStartSec: number,
    renderPxPerSec: number,
    _downbeatBeatOffset: number,
    range: { start: number; end: number },
    barWidth: number
  ) => {
    const startX = range.start
    const endX = range.end
    const safeTrackStartSec = Math.max(0, Number(trackStartSec) || 0)
    const safeRenderPxPerSec = Math.max(0, Number(renderPxPerSec) || 0)
    const safeDurationSec = Math.max(0, Number(resolveTrackDurationSeconds(track)) || 0)
    if (safeDurationSec <= 0) return
    const sourceDurationSec = Math.max(0, Number(resolveTrackSourceDurationSeconds(track)) || 0)
    const snapshot = buildTrackRuntimeTempoSnapshot({
      track,
      sourceDurationSec,
      durationSec: safeDurationSec,
      zoom: normalizedRenderZoom.value
    })
    const visibleGridLines = snapshot.visibleGridLines
    if (endX <= startX || width <= 0 || height <= 0 || !visibleGridLines.length) return

    context.save()
    for (const line of visibleGridLines) {
      const rawX = resolveRoundedTrackLocalPx({
        trackStartSec: safeTrackStartSec,
        localSec: line.sec,
        pxPerSec: safeRenderPxPerSec
      })
      if (rawX < startX - 64 || rawX > endX + 64) continue
      const level: TimelineGridLineLevel = line.level
      const lineWidth = level === 'downbeat' ? barWidth : GRID_BEAT_LINE_WIDTH
      const x = rawX - startX - lineWidth / 2
      drawNeutralGridLine(context, x, lineWidth, height, level)
    }
    context.restore()
  }

  const resolveWaveformListRoot = (track: MixtapeTrack) => {
    const originUuid = track.originPlaylistUuid
    if (!originUuid) return ''
    return libraryUtils.findDirPathByUuid(originUuid) || ''
  }

  const resolveTrackWaveformSources = (track: MixtapeTrack): TrackWaveformSource[] => {
    const listRoot = resolveWaveformListRoot(track)
    const fallbackFilePath = String(track.filePath || '').trim()
    if (!isStemMixMode()) {
      if (!fallbackFilePath) return []
      return [
        {
          filePath: fallbackFilePath,
          listRoot,
          laneIndex: 0,
          laneCount: 1,
          stemId: 'inst'
        }
      ]
    }
    const stemIds = resolveWaveformStemIds()
    const stemSources: Array<{ stemId: MixtapeWaveformStemId; filePath: string }> = []
    for (const stemId of stemIds) {
      const filePath = resolveTrackStemFilePath(track, stemId)
      if (!filePath) {
        if (!fallbackFilePath) return []
        return [
          {
            filePath: fallbackFilePath,
            listRoot,
            laneIndex: 0,
            laneCount: 1,
            stemId: 'inst'
          }
        ]
      }
      stemSources.push({ stemId, filePath })
    }
    const laneCount = stemSources.length
    return stemSources.map((item, laneIndex) => ({
      filePath: item.filePath,
      listRoot,
      laneIndex,
      laneCount,
      stemId: item.stemId
    }))
  }

  const resolveTrackWaveformFilePaths = (track: MixtapeTrack) =>
    Array.from(
      new RendererFilePathSet(resolveTrackWaveformSources(track).map((item) => item.filePath))
    )

  const isWaveformReady = (track: MixtapeTrack) => {
    void waveformVersion?.value
    const sources = resolveTrackWaveformSources(track)
    if (!sources.length) return false
    for (const source of sources) {
      const filePath = source.filePath
      if (!filePath) return false
      if (waveformInflight.has(filePath)) return false
      const waveformData = waveformDataMap.get(filePath)
      if (waveformData) continue
      const rawData = rawWaveformDataMap.get(filePath)
      if (rawData) continue
      return false
    }
    return true
  }

  const isRawWaveformLoading = (track: MixtapeTrack) => {
    void waveformVersion?.value
    if (!useRawWaveform.value) return false
    const sources = resolveTrackWaveformSources(track)
    if (!sources.length) return false
    for (const source of sources) {
      const filePath = source.filePath
      if (!filePath) continue
      const hasPreviewWaveform = Boolean(waveformDataMap.get(filePath))
      if (rawWaveformInflight.has(filePath) && !hasPreviewWaveform) return true
      if (!rawWaveformDataMap.has(filePath) && !hasPreviewWaveform) return true
    }
    return false
  }

  const resolveWaveformTitle = (track: MixtapeTrack) => {
    if (isWaveformReady(track)) return resolveTrackTitle(track)
    const loading = typeof t === 'function' ? t('mixtape.waveformLoading') : ''
    const base = resolveTrackTitle(track)
    return loading ? `${base} ${loading}` : base
  }

  const computeTimelineDuration = () => {
    void waveformVersion?.value
    let cursor = 0
    let maxEnd = 0
    for (const track of tracks.value) {
      const duration = resolveTrackDurationSeconds(track)
      if (!Number.isFinite(duration) || duration <= 0) continue
      const startSec = Number(track.startSec)
      const start = Number.isFinite(startSec) ? startSec : cursor
      const end = start + duration
      maxEnd = Math.max(maxEnd, end)
      cursor = Math.max(cursor, end)
    }
    return maxEnd
  }

  const buildMinMaxDataFromStemWaveform = (waveformData: StemWaveformData): MinMaxSample[] => {
    const all = waveformData.all
    const frameCount = Math.min(all.left.length, all.right.length)
    if (!frameCount) return []

    const samples = new Array<MinMaxSample>(frameCount)
    for (let i = 0; i < frameCount; i += 1) {
      const leftPeak = all.peakLeft ? all.peakLeft[i] : all.left[i]
      const rightPeak = all.peakRight ? all.peakRight[i] : all.right[i]
      const leftAmp = Math.min(1, leftPeak / 255)
      const rightAmp = Math.min(1, rightPeak / 255)
      samples[i] = { min: -rightAmp, max: leftAmp }
    }
    return samples
  }

  const buildMinMaxDataFromUnifiedWaveform = (
    waveformData: UnifiedDisplayWaveformDetailData
  ): MinMaxSample[] => {
    const frameCount = waveformData.height?.length || 0
    const samples = new Array<MinMaxSample>(frameCount)
    for (let i = 0; i < frameCount; i += 1) {
      const amp = Math.min(1, Math.max(0, (waveformData.height[i] || 0) / 255))
      samples[i] = { min: -amp, max: amp }
    }
    return samples
  }

  const isValidStemWaveformData = (data: unknown): data is StemWaveformData => {
    if (!data || typeof data !== 'object') return false
    const all = (data as StemWaveformData).all
    if (!all) return false
    const frameCount =
      all.left?.length || all.right?.length || all.peakLeft?.length || all.peakRight?.length || 0
    if (!frameCount) return false
    const isMatch = (arr?: Uint8Array) => (arr ? arr.length === frameCount : true)
    return (
      isMatch(all.left) && isMatch(all.right) && isMatch(all.peakLeft) && isMatch(all.peakRight)
    )
  }

  const isValidUnifiedWaveformData = (data: unknown): data is UnifiedDisplayWaveformDetailData => {
    if (!data || typeof data !== 'object') return false
    const waveformData = data as UnifiedDisplayWaveformDetailData
    const frameCount = waveformData.height?.length || 0
    if (!frameCount) return false
    const isMatch = (arr?: Uint8Array) => Boolean(arr && arr.length === frameCount)
    return (
      Number(waveformData.duration) > 0 &&
      Number(waveformData.sampleRate) > 0 &&
      Number(waveformData.detailRate) > 0 &&
      isMatch(waveformData.attack) &&
      isMatch(waveformData.colorIndex) &&
      isMatch(waveformData.colorLow) &&
      isMatch(waveformData.colorMid) &&
      isMatch(waveformData.colorHigh) &&
      isMatch(waveformData.colorRed) &&
      isMatch(waveformData.colorGreen) &&
      isMatch(waveformData.colorBlue) &&
      Boolean(waveformData.body?.length)
    )
  }

  const isValidWaveformData = (
    data: StemWaveformData | UnifiedDisplayWaveformDetailData | null
  ): data is StemWaveformData | UnifiedDisplayWaveformDetailData => {
    if (!data) return false
    if (isValidStemWaveformData(data)) return true
    if (isValidUnifiedWaveformData(data)) return true
    return false
  }

  const getMinMaxSamples = (
    filePath: string,
    data: StemWaveformData | UnifiedDisplayWaveformDetailData
  ): MinMaxSample[] => {
    const cached = waveformMinMaxCache.get(filePath)
    if (cached && cached.source === data) return cached.samples
    const samples = isValidStemWaveformData(data)
      ? buildMinMaxDataFromStemWaveform(data)
      : buildMinMaxDataFromUnifiedWaveform(data)
    waveformMinMaxCache.set(filePath, { source: data, samples })
    return samples
  }

  const decodeRawFloatArray = (input: unknown): Float32Array | null => {
    if (!input) return null
    if (input instanceof Float32Array) return input

    if (ArrayBuffer.isView(input)) {
      const view = input as ArrayBufferView
      return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
    }

    if (input instanceof ArrayBuffer) {
      return new Float32Array(input)
    }

    if (typeof input === 'string') {
      try {
        const bytes = Uint8Array.from(atob(input), (char) => char.charCodeAt(0))
        return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
      } catch {
        return null
      }
    }

    return null
  }

  const decodeRawWaveformData = (
    payload: Record<string, unknown> | null | undefined
  ): RawWaveformData | null => {
    if (!payload) return null
    const minLeft = decodeRawFloatArray(payload.minLeft ?? payload.min)
    const maxLeft = decodeRawFloatArray(payload.maxLeft ?? payload.max)
    const minRight = decodeRawFloatArray(payload.minRight ?? payload.min)
    const maxRight = decodeRawFloatArray(payload.maxRight ?? payload.max)
    const meanLeft = decodeRawFloatArray(payload.meanLeft)
    const meanRight = decodeRawFloatArray(payload.meanRight)
    const rmsLeft = decodeRawFloatArray(payload.rmsLeft)
    const rmsRight = decodeRawFloatArray(payload.rmsRight)
    if (!minLeft || !maxLeft || !minRight || !maxRight) return null

    const frames = Math.max(
      0,
      Math.min(
        Number(payload.frames) || Number.POSITIVE_INFINITY,
        minLeft.length,
        maxLeft.length,
        minRight.length,
        maxRight.length
      )
    )

    const normalized: RawWaveformData = {
      duration: Number(payload.duration) || 0,
      sampleRate: Number(payload.sampleRate) || 0,
      rate: Number(payload.rate) || 0,
      frames,
      minLeft,
      maxLeft,
      minRight,
      maxRight
    }
    if (meanLeft && meanRight && meanLeft.length >= frames && meanRight.length >= frames) {
      normalized.meanLeft = meanLeft
      normalized.meanRight = meanRight
    }
    if (rmsLeft && rmsRight && rmsLeft.length >= frames && rmsRight.length >= frames) {
      normalized.rmsLeft = rmsLeft
      normalized.rmsRight = rmsRight
    }

    return normalized
  }

  const resolveRawWaveformLevel = (
    filePath: string,
    raw: RawWaveformData | null,
    samplesPerPixel: number
  ): RawWaveformData | null =>
    resolveRawWaveformLevelByMap(rawWaveformPyramidMap, filePath, raw, samplesPerPixel)

  const buildWaveformTileCacheKey = (
    filePath: string,
    stemId: MixtapeWaveformStemId,
    tileIndex: number,
    zoomValue: number,
    width: number,
    height: number,
    pixelRatio: number,
    timeMapSignature?: string
  ) => {
    const zoomKey = Math.round(zoomValue * 1000)
    const ratioKey = Math.round(pixelRatio * 100)
    const waveformHeightScaleKey = Math.round(MIXTAPE_WAVEFORM_HEIGHT_SCALE * 1000)
    const normalizedTimeMapSignature =
      typeof timeMapSignature === 'string' && timeMapSignature ? timeMapSignature : 'default'
    return `${filePath}::${stemId}::${tileIndex}::${zoomKey}::${width}x${height}@${ratioKey}::h${waveformHeightScaleKey}::tm:${normalizedTimeMapSignature}`
  }

  const touchWaveformTileCache = (key: string) => {
    const entry = waveformTileCache.get(key)
    if (!entry) return
    const tick = getWaveformTileCacheTick() + 1
    setWaveformTileCacheTick(tick)
    entry.used = tick
  }

  const registerWaveformTileCacheKey = (filePath: string, key: string) => {
    const set = waveformTileCacheIndex.get(filePath) || new Set<string>()
    set.add(key)
    waveformTileCacheIndex.set(filePath, set)
  }

  const disposeWaveformCacheEntry = (
    entry?: { source: CanvasImageSource; used: number } | null
  ) => {
    if (!entry) return
    const source = entry.source as ImageBitmap | null
    if (source && typeof source.close === 'function') {
      source.close()
    }
  }

  const pruneWaveformTileCache = () => {
    const cacheLimit = getWaveformTileCacheLimit()
    if (waveformTileCache.size <= cacheLimit) return

    const entries = Array.from(waveformTileCache.entries()) as Array<
      [string, { source: CanvasImageSource; used: number }]
    >
    entries.sort((a, b) => a[1].used - b[1].used)
    const removeCount = Math.max(0, waveformTileCache.size - cacheLimit)

    for (let i = 0; i < removeCount; i += 1) {
      const [key] = entries[i]
      const entry = waveformTileCache.get(key)
      disposeWaveformCacheEntry(entry || null)
      waveformTileCache.delete(key)

      const filePath = key.split('::')[0] || ''
      if (!filePath) continue
      const set = waveformTileCacheIndex.get(filePath)
      if (!set) continue
      set.delete(key)
      if (!set.size) {
        waveformTileCacheIndex.delete(filePath)
      }
    }
  }

  return {
    clampZoomValue,
    buildZoomLevels,
    quantizeRenderZoom,
    normalizedZoom,
    normalizedRenderZoom,
    resolveRenderZoomLevel,
    alignZoomToRenderLevel,
    resolveGridBarWidth,
    resolveLaneHeightForZoom,
    resolveTimelineBufferId,
    laneHeight,
    laneIndices,
    resolveTrackTitle,
    formatTrackBpm,
    useHalfWaveform,
    resolveRenderPxPerSec,
    pxPerSec,
    renderPxPerSec,
    useRawWaveform,
    parseDurationToSeconds,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackTempoRatio,
    resolveTrackFirstBeatSeconds,
    resolveTrackFirstBeatMs,
    resolveTrackTimeMapSignature,
    resolveTrackGridSignature,
    resolveTrackRenderWidthPx,
    clearTimelineLayoutCache,
    resolveFirstVisibleLayoutIndex,
    forEachVisibleLayoutItem,
    buildSequentialLayoutForZoom,
    resolveTrackBlockStyle,
    resolveGainEnvelopePolyline,
    resolveOverviewTrackStyle,
    resolveTrackTilesForWidth,
    drawTrackGridLines,
    resolveWaveformListRoot,
    resolveTrackWaveformSources,
    resolveTrackWaveformFilePaths,
    resolveWaveformSubLaneMetrics,
    isWaveformReady,
    isRawWaveformLoading,
    resolveWaveformTitle,
    computeTimelineDuration,
    buildMinMaxDataFromStemWaveform,
    isValidWaveformData,
    getMinMaxSamples,
    decodeRawFloatArray,
    decodeRawWaveformData,
    resolveRawWaveformLevel,
    buildWaveformTileCacheKey,
    touchWaveformTileCache,
    registerWaveformTileCacheKey,
    disposeWaveformCacheEntry,
    pruneWaveformTileCache
  }
}
