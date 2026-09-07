import { ref, type Ref } from 'vue'
import type { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import { normalizeBeatOffset as normalizeBeatOffsetByGrid } from '@renderer/composables/mixtape/beatSyncModel'
import { applyTimelineTransportSync } from '@renderer/composables/mixtape/timelineTransportSync'
import {
  configureTitleAudioVisualizerAnalyser,
  registerTitleAudioVisualizerSource,
  unregisterTitleAudioVisualizerSource,
  type TitleAudioVisualizerSource
} from '@renderer/composables/titleAudioVisualizerBridge'
import {
  createTimelineTransportRenderWavModule,
  type MixtapeOutputProgressPayload,
  type MixtapeRenderedWavResult
} from '@renderer/composables/mixtape/timelineTransportRenderWav'
import { createTimelineTransportTrackDragModule } from '@renderer/composables/mixtape/timelineTransportTrackDrag'
import { createTimelineTransportResolversModule } from '@renderer/composables/mixtape/timelineTransportResolvers'
import { ensureTransportSequencerWorkletModule } from '@renderer/composables/mixtape/timelineTransportPlayableSource'
import {
  prepareTransportTrackGraphNode,
  type PreparedTransportTrackGraphNode,
  type TrackGraphNode,
  type TransportPlaybackSourceMode
} from '@renderer/composables/mixtape/timelineTransportPlaybackNodes'
import {
  createTimelineTransportAudioDataModule,
  type TransportAudioRef,
  type TransportEntry,
  type TransportStemId
} from '@renderer/composables/mixtape/timelineTransportAudioData'
import { hasInternalPlaybackSequence } from '@renderer/composables/mixtape/timelineTransportPlaybackSequence'
import {
  resolveEntryPlaybackOffsetSourceSec,
  resolveEntryPlaybackOffsetPlanSec,
  resolveTransportAudibleTimelineSec
} from '@renderer/composables/mixtape/timelineTransportPositionMapping'
import type {
  MixtapeEnvelopeParamId,
  MixtapeMixMode,
  MixtapeMuteSegment,
  TimelineLayoutSnapshot,
  MixtapeTrack,
  MixtapeStemStatus
} from '@renderer/composables/mixtape/types'

export type { MixtapeOutputProgressPayload, MixtapeRenderedWavResult }

const MIX_ENVELOPE_PARAMS_TRADITIONAL: MixtapeEnvelopeParamId[] = [
  'gain',
  'high',
  'mid',
  'low',
  'volume'
]
const MIX_ENVELOPE_PARAMS_4STEMS: MixtapeEnvelopeParamId[] = [
  'gain',
  'vocal',
  'inst',
  'bass',
  'drums',
  'volume'
]
const STEM_IDS_4STEMS: TransportStemId[] = ['vocal', 'inst', 'bass', 'drums']
const MIXTAPE_SEGMENT_MUTE_GAIN = 0.0001
const FOLLOW_PLAYHEAD_LOCK_RATIO = 1 / 3

type ValueRef<T> = Ref<T>
type TimelineScrollHost = InstanceType<typeof OverlayScrollbarsComponent>

type TimelineTransportAndDragContext = {
  tracks: ValueRef<MixtapeTrack[]>
  mixtapeMixMode: ValueRef<MixtapeMixMode>
  mixtapeStemMode: ValueRef<unknown>
  timelineLayout: ValueRef<TimelineLayoutSnapshot>
  normalizedRenderZoom: ValueRef<number>
  timelineScrollRef: ValueRef<TimelineScrollHost | null>
  timelineScrollLeft: ValueRef<number>
  timelineViewportWidth: ValueRef<number>
  isTimelinePanning: ValueRef<boolean>
  isOverviewDragging: ValueRef<boolean>
  rulerRef: ValueRef<HTMLElement | null>
  buildSequentialLayoutForZoom: (zoomValue: number) => TimelineLayoutSnapshot
  resolveRenderPxPerSec: (zoomValue: number) => number
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackTempoRatio: (track: MixtapeTrack, targetBpm?: number) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack, targetBpm?: number) => number
  computeTimelineDuration: () => number
  scheduleFullPreRender: () => void
  scheduleWorkerPreRender: () => void
}

export const createTimelineTransportAndDragModule = (ctx: TimelineTransportAndDragContext) => {
  const {
    tracks,
    mixtapeMixMode,
    timelineLayout,
    normalizedRenderZoom,
    timelineScrollRef,
    timelineScrollLeft,
    timelineViewportWidth,
    isTimelinePanning,
    isOverviewDragging,
    rulerRef,
    buildSequentialLayoutForZoom,
    resolveRenderPxPerSec,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackTempoRatio,
    resolveTrackFirstBeatSeconds,
    computeTimelineDuration,
    scheduleFullPreRender,
    scheduleWorkerPreRender
  } = ctx

  const transportPlaying = ref(false)
  const transportDecoding = ref(false)
  const transportPreloading = ref(false)
  const transportPreloadDone = ref(0)
  const transportPreloadTotal = ref(0)
  const transportPreloadFailed = ref(0)
  const playheadSec = ref(0)
  const playheadVisible = ref(false)
  const transportError = ref('')
  const followPlayheadEnabled = ref(false)

  let transportRaf = 0
  let transportBaseSec = 0
  let transportStartedAt = 0
  let transportAudioStartAt = 0
  let transportDurationSec = 0
  let transportAudioCtx: AudioContext | null = null
  let transportMasterGainNode: GainNode | null = null
  let transportMasterVolume = 0.8
  let transportAnalyserNode: AnalyserNode | null = null
  let transportGraphNodes: TrackGraphNode[] = []
  let transportMasterTrackId = ''
  let transportVersion = 0
  let transportSequencerWorkletReady = false
  const titleAudioVisualizerSource: TitleAudioVisualizerSource = {
    getAnalyser: () => transportAnalyserNode
  }

  registerTitleAudioVisualizerSource('mixtapeWindow', titleAudioVisualizerSource)

  const clampNumber = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value))
  const normalizeBeatOffset = (value: unknown, interval: number) => {
    return normalizeBeatOffsetByGrid(value, interval)
  }
  const normalizeStartSec = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return null
    return Number(numeric.toFixed(4))
  }
  const normalizeMixtapeStemStatus = (value: unknown): MixtapeStemStatus => {
    if (
      value === 'idle' ||
      value === 'pending' ||
      value === 'running' ||
      value === 'ready' ||
      value === 'failed'
    ) {
      return value
    }
    return 'ready'
  }
  const isStemMixMode = (): boolean =>
    (mixtapeMixMode?.value as MixtapeMixMode | undefined) === 'stem'
  const resolveMixEnvelopeParams = (): MixtapeEnvelopeParamId[] =>
    isStemMixMode() ? MIX_ENVELOPE_PARAMS_4STEMS : MIX_ENVELOPE_PARAMS_TRADITIONAL
  const resolveStemIdsForMode = (): TransportStemId[] => STEM_IDS_4STEMS
  const resolveTrackStemFilePath = (track: MixtapeTrack, stemId: TransportStemId): string => {
    if (stemId === 'vocal') return String(track.stemVocalPath || '').trim()
    if (stemId === 'inst') return String(track.stemInstPath || '').trim()
    if (stemId === 'bass') return String(track.stemBassPath || '').trim()
    return String(track.stemDrumsPath || '').trim()
  }
  const hasEntryInternalSequence = (entry: TransportEntry) =>
    hasInternalPlaybackSequence(entry.playbackSequence)
  const resolvePlaybackSourceMode = (entry: TransportEntry): TransportPlaybackSourceMode => {
    const hasSequence = hasEntryInternalSequence(entry)
    if (hasSequence && entry.masterTempo) return 'sequenced-r3'
    if (hasSequence && transportSequencerWorkletReady) {
      return 'sequenced-buffer'
    }
    if (entry.masterTempo) return 'r3'
    return 'buffer'
  }

  const persistTrackStartSec = async (
    entries: Array<{
      itemId: string
      startSec?: number
      bpm?: number
      masterTempo?: boolean
      originalBpm?: number
      laneIndex?: number
    }>
  ) => {
    if (!entries.length || !window?.electron?.ipcRenderer?.invoke) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:update-track-start-sec', { entries })
    } catch (error) {
      console.error('[mixtape] update track timing failed', {
        count: entries.length,
        error
      })
    }
  }

  const persistTrackVolumeMuteSegments = async (
    entries: Array<{ itemId: string; segments: MixtapeMuteSegment[] }>
  ) => {
    if (!entries.length || !window?.electron?.ipcRenderer?.invoke) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:update-volume-mute-segments', {
        entries: entries.map((item) => ({
          itemId: item.itemId,
          segments: item.segments.map((segment) => ({
            startSec: Number(segment.startSec),
            endSec: Number(segment.endSec)
          }))
        }))
      })
    } catch (error) {
      console.error('[mixtape] update volume mute segments failed', {
        count: entries.length,
        error
      })
    }
  }

  const transportDurationSecRef = {
    get value() {
      return transportDurationSec
    },
    set value(value: number) {
      transportDurationSec = value
    }
  }
  const {
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
    resolveTrackMixEnvelope,
    resolveEntryEnvelopeValue,
    resolveEntryEqDbValue
  } = createTimelineTransportResolversModule({
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
    segmentMuteGain: MIXTAPE_SEGMENT_MUTE_GAIN
  })

  const {
    buildTransportEntries,
    buildTransportPlaybackEntries,
    remapVolumeMuteSegmentsForBpm,
    readTransportBufferCache,
    ensureDecodedStemAudio,
    ensureDecodedTransportEntry,
    decodeAllTransportEntries,
    scheduleTransportPreload,
    cleanupTransportAudioData
  } = createTimelineTransportAudioDataModule({
    tracks,
    playheadSec,
    normalizedRenderZoom,
    timelineLayout,
    resolveRenderPxPerSec,
    buildSequentialLayoutForZoom,
    resolveTimelineSecByX,
    resolveTrackSourceDurationSeconds,
    resolveTrackTempoRatio,
    resolveTrackFirstBeatSeconds,
    resolveTrackDurationSeconds,
    resolveTrackStartSec,
    resolveTrackMixEnvelope,
    resolveMixEnvelopeParams,
    resolveStemIdsForMode,
    resolveTrackStemFilePath,
    isStemMixMode,
    normalizeMixtapeStemStatus,
    ensureTransportAudioContext: (sampleRate?: number) => ensureTransportAudioContext(sampleRate),
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadFailed
  })

  const ensureTransportAudioContext = (sampleRate?: number): AudioContext => {
    if (transportAudioCtx && transportAudioCtx.state !== 'closed') {
      return transportAudioCtx
    }
    transportAudioCtx = new AudioContext(sampleRate ? { sampleRate } : undefined)
    // 注册到全局列表，窗口关闭时可立即挂起所有 AudioContext
    const contexts = (window.__FRKB_AUDIO_CONTEXTS__ ??= [])
    contexts.push(transportAudioCtx)
    transportMasterGainNode = null
    transportAnalyserNode = null
    return transportAudioCtx
  }

  const setTransportMasterVolume = (value: number) => {
    const numeric = Number(value)
    transportMasterVolume = clampNumber(Number.isFinite(numeric) ? numeric : 0.8, 0, 1)
    if (transportMasterGainNode && transportAudioCtx && transportAudioCtx.state !== 'closed') {
      try {
        transportMasterGainNode.gain.setTargetAtTime(
          transportMasterVolume,
          transportAudioCtx.currentTime,
          0.03
        )
      } catch {
        transportMasterGainNode.gain.value = transportMasterVolume
      }
    }
    return transportMasterVolume
  }

  const resolveTransportOutputNode = (ctx: AudioContext) => {
    if (!transportMasterGainNode || transportAudioCtx !== ctx) {
      transportMasterGainNode = ctx.createGain()
      transportMasterGainNode.gain.value = transportMasterVolume
      transportMasterGainNode.connect(ctx.destination)
    }
    if (!transportAnalyserNode || transportAnalyserNode.context !== ctx) {
      try {
        transportAnalyserNode?.disconnect()
      } catch {}
      transportAnalyserNode = configureTitleAudioVisualizerAnalyser(ctx.createAnalyser())
      transportAnalyserNode.connect(transportMasterGainNode)
    }
    return transportAnalyserNode
  }

  const clearTransportGraphNodes = () => {
    for (const node of transportGraphNodes) {
      try {
        node.source.stop()
      } catch {}
      for (const stemNode of node.stemNodes) {
        try {
          stemNode.source.stop()
        } catch {}
        try {
          stemNode.source.disconnect()
        } catch {}
        try {
          stemNode.stemGain.disconnect()
        } catch {}
      }
      try {
        node.stemBus?.disconnect()
      } catch {}
      try {
        node.eqHigh?.disconnect()
      } catch {}
      try {
        node.eqMid?.disconnect()
      } catch {}
      try {
        node.eqLow?.disconnect()
      } catch {}
      try {
        node.volume.disconnect()
      } catch {}
      try {
        node.gain.disconnect()
      } catch {}
    }
    transportGraphNodes = []
    transportMasterTrackId = ''
  }

  const stopTransport = () => {
    transportVersion += 1
    if (transportRaf) {
      cancelAnimationFrame(transportRaf)
      transportRaf = 0
    }
    transportPlaying.value = false
    transportDecoding.value = false
    transportStartedAt = 0
    transportAudioStartAt = 0
    clearTransportGraphNodes()
  }

  const resolveTransportDuration = () => {
    const total = transportDurationSec > 0 ? transportDurationSec : timelineDurationSec.value
    if (!Number.isFinite(total) || total <= 0) return 0
    return total
  }

  const resolveTimelineViewportEl = () =>
    ((timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
      null) as HTMLElement | null

  const isTimelineManualScrolling = () =>
    Boolean(isTimelinePanning?.value || isOverviewDragging?.value)

  const syncTimelineScrollByPlayhead = (timelineSec: number) => {
    if (!followPlayheadEnabled.value) return
    if (isTimelineManualScrolling()) return
    const viewport = resolveTimelineViewportEl()
    if (!viewport) return
    const viewportWidth = Math.max(
      1,
      Number(viewport.clientWidth || timelineViewportWidth.value || 0)
    )
    const layoutTotalWidth = Math.max(0, Number(timelineLayout.value.totalWidth || 0))
    const scrollableWidth = Math.max(
      viewportWidth,
      layoutTotalWidth,
      Number(viewport.scrollWidth || 0)
    )
    if (scrollableWidth <= viewportWidth) return
    const maxScrollLeft = Math.max(0, scrollableWidth - viewportWidth)
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const playheadX = clampNumber(
      resolveTimelineDisplayX(timelineSec, pxPerSec, layoutTotalWidth),
      0,
      layoutTotalWidth
    )
    const targetLocalX = viewportWidth * FOLLOW_PLAYHEAD_LOCK_RATIO
    const nextLeft = clampNumber(playheadX - targetLocalX, 0, maxScrollLeft)
    const currentScrollLeft = clampNumber(Number(viewport.scrollLeft || 0), 0, maxScrollLeft)
    if (Math.abs(nextLeft - currentScrollLeft) < 0.5) return
    viewport.scrollLeft = Math.round(nextLeft)
  }

  const finishTransportPlayback = () => {
    const total = resolveTransportDuration()
    stopTransport()
    // 暂停时保持播放中线可见
    playheadSec.value = total
  }

  const resolveTransportMinStartSec = () => {
    const snapshot = buildSequentialLayoutForZoom(normalizedRenderZoom.value)
    if (!snapshot.layout.length) return 0
    return snapshot.layout.reduce((minSec: number, item: { startSec: number }) => {
      const startSec = Number(item.startSec)
      if (!Number.isFinite(startSec)) return minSec
      return Math.min(minSec, startSec)
    }, 0)
  }

  const handleTransportStop = () => {
    stopTransport()
    // 暂停时保持播放中线可见，只在真正停止时隐藏
  }

  const resolveTransportRestartSec = () => {
    const total = resolveTransportDuration()
    if (!total) return 0
    const minStartSec = resolveTransportMinStartSec()
    if (playheadSec.value >= total - 0.05) return minStartSec
    return clampNumber(playheadSec.value, minStartSec, total)
  }

  const resolveRulerSeekSec = (event: MouseEvent) => {
    const target = event.currentTarget as HTMLElement | null
    if (!target) return resolveTransportRestartSec()
    const rect = target.getBoundingClientRect()
    const rulerWidth = rect.width || 0
    if (!rulerWidth) return resolveTransportRestartSec()
    const localRatio = clampNumber((event.clientX - rect.left) / rulerWidth, 0, 1)
    const pxPerSec = Math.max(0.0001, resolveRenderPxPerSec(normalizedRenderZoom.value))
    const totalWidth = Math.max(0, timelineLayout.value.totalWidth)
    if (totalWidth <= 0) return 0
    const viewportWidth = Math.max(1, Number(timelineViewportWidth.value) || rulerWidth)
    const maxScroll = Math.max(0, totalWidth - viewportWidth)
    const viewportStartX = clampNumber(Number(timelineScrollLeft.value) || 0, 0, maxScroll)
    const targetX = clampNumber(viewportStartX + localRatio * viewportWidth, 0, totalWidth)
    const totalSec = Math.max(0, timelineDurationSec.value)
    const sec = resolveTimelineSecByX(targetX, pxPerSec)
    if (!Number.isFinite(sec) || sec <= 0) return 0
    return clampNumber(sec, 0, totalSec)
  }

  const { renderMixtapeOutputWav } = createTimelineTransportRenderWavModule({
    t,
    buildTransportEntries,
    readTransportBufferCache,
    ensureDecodedTransportEntry,
    ensureDecodedStemAudio,
    getTransportAudioContext: () => transportAudioCtx,
    clampNumber,
    resolveEntryEqDbValue,
    resolveEntryEnvelopeValue,
    isStemMode: () => isStemMixMode(),
    applyTransportMixParamsAtTimelineSec: (timelineSec: number, options?) =>
      applyTransportMixParamsAtTimelineSec(timelineSec, options),
    resolveStemIdsForMode,
    mirrorTransportStemPlaybackRates: (
      nodes: TrackGraphNode[],
      audioCtx: BaseAudioContext | null,
      automationAtSec?: number
    ) => mirrorTransportStemPlaybackRates(nodes, audioCtx, automationAtSec)
  })

  const resolveTransportPlanSampleRate = (entries: TransportEntry[]) => {
    for (const entry of entries) {
      if (isStemMixMode()) {
        for (const stemId of resolveStemIdsForMode()) {
          const sampleRate = Number(entry.stemAudioById?.[stemId]?.audioBuffer?.sampleRate || 0)
          if (Number.isFinite(sampleRate) && sampleRate > 0) return sampleRate
        }
        continue
      }
      const sampleRate = Number(entry.audioRef?.audioBuffer?.sampleRate || 0)
      if (Number.isFinite(sampleRate) && sampleRate > 0) return sampleRate
    }
    return undefined
  }

  const applyTransportMixParamsAtTimelineSec = (
    timelineSec: number,
    options?: {
      nodes?: TrackGraphNode[]
      audioCtx?: BaseAudioContext | null
      automationAtSec?: number
    }
  ) => {
    const audioCtx = options?.audioCtx ?? transportAudioCtx
    const nodes = options?.nodes ?? transportGraphNodes
    if (!audioCtx) return
    const now =
      typeof options?.automationAtSec === 'number' && Number.isFinite(options.automationAtSec)
        ? Number(options.automationAtSec)
        : audioCtx.currentTime
    for (const node of nodes) {
      const entry = node.entry
      const localTimelineSec = timelineSec - entry.startSec
      if (localTimelineSec < 0 || localTimelineSec > entry.duration) continue
      const nextVolume = resolveEntryEnvelopeValue(entry, 'volume', localTimelineSec)
      const nextGain = resolveEntryEnvelopeValue(entry, 'gain', localTimelineSec)
      if (isStemMixMode()) {
        for (const stemNode of node.stemNodes) {
          const nextStemGain = resolveEntryEnvelopeValue(entry, stemNode.stemId, localTimelineSec)
          try {
            stemNode.stemGain.gain.setTargetAtTime(nextStemGain, now, 0.04)
          } catch {}
        }
      } else {
        const nextEqHighDb = resolveEntryEqDbValue(entry, 'high', localTimelineSec)
        const nextEqMidDb = resolveEntryEqDbValue(entry, 'mid', localTimelineSec)
        const nextEqLowDb = resolveEntryEqDbValue(entry, 'low', localTimelineSec)
        try {
          node.eqHigh?.gain.setTargetAtTime(nextEqHighDb, now, 0.04)
        } catch {}
        try {
          node.eqMid?.gain.setTargetAtTime(nextEqMidDb, now, 0.04)
        } catch {}
        try {
          node.eqLow?.gain.setTargetAtTime(nextEqLowDb, now, 0.04)
        } catch {}
      }
      try {
        node.volume.gain.setTargetAtTime(nextVolume, now, 0.04)
      } catch {}
      try {
        node.gain.gain.setTargetAtTime(nextGain, now, 0.04)
      } catch {}
    }
  }

  function mirrorTransportStemPlaybackRates(
    nodes: TrackGraphNode[],
    audioCtx: BaseAudioContext | null,
    automationAtSec?: number
  ) {
    if (!audioCtx || !isStemMixMode()) return
    const now =
      typeof automationAtSec === 'number' && Number.isFinite(automationAtSec)
        ? Number(automationAtSec)
        : audioCtx.currentTime
    for (const node of nodes) {
      const primaryRate = clampNumber(Number(node.source.playbackRate.value) || 1, 0.25, 4)
      for (const stemNode of node.stemNodes || []) {
        if (stemNode.source === node.source) continue
        try {
          stemNode.source.playbackRate.setTargetAtTime(primaryRate, now, 0.04)
        } catch {}
      }
    }
  }

  const startTransportFrom = async (rawStartSec: number) => {
    const plan = buildTransportPlaybackEntries()
    stopTransport()
    const version = ++transportVersion
    const entries = plan.entries

    if (entries.length) {
      const useStemMode = isStemMixMode()
      const pendingAudioRefs: TransportAudioRef[] = []
      if (useStemMode) {
        for (const entry of entries) {
          for (const stemId of resolveStemIdsForMode()) {
            const stemAudio = entry.stemAudioById?.[stemId]
            if (!stemAudio) continue
            if (readTransportBufferCache(stemAudio.filePath)) continue
            pendingAudioRefs.push(stemAudio)
          }
        }
      } else {
        for (const entry of entries) {
          const audioRef = entry.audioRef
          if (!audioRef) continue
          if (readTransportBufferCache(audioRef.filePath)) continue
          pendingAudioRefs.push(audioRef)
        }
      }
      if (pendingAudioRefs.length > 0) {
        const hasIpcEntries = pendingAudioRefs.some((e) => e.decodeMode === 'ipc')
        if (hasIpcEntries) transportDecoding.value = true
        const failCount = await decodeAllTransportEntries(entries)
        if (transportVersion !== version) {
          transportDecoding.value = false
          return
        }
        transportDecoding.value = false
        plan.decodeFailedCount = failCount
      } else {
        if (useStemMode) {
          for (const entry of entries) {
            for (const stemId of resolveStemIdsForMode()) {
              const stemAudio = entry.stemAudioById?.[stemId]
              if (!stemAudio) continue
              const cached = readTransportBufferCache(stemAudio.filePath)
              if (!cached) continue
              stemAudio.audioBuffer = cached
            }
          }
        } else {
          for (const entry of entries) {
            const audioRef = entry.audioRef
            if (!audioRef) continue
            const cached = readTransportBufferCache(audioRef.filePath)
            if (!cached) continue
            audioRef.audioBuffer = cached
          }
        }
      }
    }

    const playableEntries = entries.filter((entry) => {
      if (isStemMixMode()) {
        const requiredStemIds = resolveStemIdsForMode()
        return requiredStemIds.every((stemId) => !!entry.stemAudioById?.[stemId]?.audioBuffer)
      }
      return Boolean(entry.audioRef?.audioBuffer)
    })
    const duration = entries.reduce(
      (max, entry) => Math.max(max, entry.startSec + entry.duration),
      0
    )
    transportDurationSec = duration
    const minStartSec = entries.reduce(
      (min, entry) => Math.min(min, Number(entry.startSec) || 0),
      0
    )
    const startSec = clampNumber(rawStartSec, minStartSec, Math.max(minStartSec, duration))
    const silentStemTrackCount = isStemMixMode()
      ? Math.max(0, plan.missingStemAssetCount) + Math.max(0, plan.stemNotReadyCount)
      : 0
    transportError.value = ''

    const hasPlayableTimelineRange = entries.length > 0 && duration > 0 && startSec < duration
    if (!hasPlayableTimelineRange || playableEntries.length <= 0) {
      playheadSec.value = startSec
      playheadVisible.value = hasPlayableTimelineRange && playableEntries.length <= 0
      transportPlaying.value = false
      if (plan.decodeFailedCount > 0) {
        transportError.value = t('mixtape.transportDecodeFailed', {
          count: plan.decodeFailedCount
        })
      } else if (isStemMixMode() && silentStemTrackCount > 0) {
        transportError.value = t('mixtape.transportStemNotReady', {
          count: silentStemTrackCount
        })
      } else if (plan.missingDurationCount > 0) {
        transportError.value = t('mixtape.transportMissingDuration', {
          count: plan.missingDurationCount
        })
      } else {
        transportError.value = t('mixtape.transportNoPlayableTracks')
      }
      return
    }

    transportSequencerWorkletReady = false
    const sampleRate = resolveTransportPlanSampleRate(playableEntries)
    const transportCtx = ensureTransportAudioContext(sampleRate)
    if (transportCtx.state === 'suspended') {
      try {
        await transportCtx.resume()
      } catch {}
    }
    const needsSequencedBuffer = playableEntries.some(
      (entry) => hasEntryInternalSequence(entry) && !entry.masterTempo
    )
    if (needsSequencedBuffer) {
      try {
        await ensureTransportSequencerWorkletModule(transportCtx)
        transportSequencerWorkletReady = true
      } catch (error) {
        console.error('[mixtape-transport] sequencer worklet unavailable', error)
        transportError.value = 'Loop 连续播放引擎不可用'
        playheadVisible.value = false
        transportPlaying.value = false
        return
      }
    }
    if (transportVersion !== version) return

    if (plan.decodeFailedCount > 0) {
      transportError.value = t('mixtape.transportPartialDecodeFailed', {
        count: plan.decodeFailedCount
      })
    } else if (isStemMixMode() && silentStemTrackCount > 0) {
      transportError.value = t('mixtape.transportStemSilentHint', {
        count: silentStemTrackCount
      })
    }

    playheadVisible.value = true
    playheadSec.value = startSec
    syncTimelineScrollByPlayhead(startSec)
    const preparedNodes: Array<{
      delaySec: number
      node: PreparedTransportTrackGraphNode
    }> = []
    try {
      for (const entry of playableEntries) {
        const entryEnd = entry.startSec + entry.duration
        if (entryEnd <= startSec) continue
        const delaySec = Math.max(0, entry.startSec - startSec)
        const offsetTimelineSec = Math.max(0, startSec - entry.startSec)
        const preparedNode = await prepareTransportTrackGraphNode({
          entry,
          offsetTimelineSec,
          offsetPlanSec: resolveEntryPlaybackOffsetPlanSec(entry, offsetTimelineSec),
          offsetSourceSec: resolveEntryPlaybackOffsetSourceSec(entry, offsetTimelineSec),
          transportGraphNodes,
          isStemMixMode,
          resolveStemIdsForMode,
          ensureTransportAudioContext,
          resolveTransportOutputNode,
          resolvePlaybackSourceMode,
          resolveEntryEnvelopeValue,
          resolveEntryEqDbValue
        })
        if (transportVersion !== version) {
          preparedNode?.dispose()
          for (const prepared of preparedNodes) prepared.node.dispose()
          return
        }
        if (preparedNode) preparedNodes.push({ delaySec, node: preparedNode })
      }
    } catch (error) {
      for (const prepared of preparedNodes) prepared.node.dispose()
      console.error('[mixtape-transport] R3 playback initialisation failed', error)
      transportError.value = 'R3 主速度引擎初始化失败'
      playheadVisible.value = false
      transportPlaying.value = false
      return
    }

    const scheduleLeadSec = 0.03
    const scheduleStartAt = transportCtx.currentTime + scheduleLeadSec
    transportBaseSec = startSec
    transportStartedAt = performance.now() + scheduleLeadSec * 1000
    transportAudioStartAt = scheduleStartAt
    transportPlaying.value = true
    try {
      for (const prepared of preparedNodes) {
        prepared.node.start(scheduleStartAt + prepared.delaySec)
      }
    } catch (error) {
      for (const prepared of preparedNodes) prepared.node.dispose()
      console.error('[mixtape-transport] R3 playback scheduling failed', error)
      transportError.value = 'R3 主速度引擎启动失败'
      transportPlaying.value = false
      playheadVisible.value = false
      return
    }

    const tick = () => {
      if (!transportPlaying.value) return
      const elapsed =
        transportAudioCtx && transportAudioCtx.state !== 'closed' && transportAudioStartAt > 0
          ? Math.max(0, transportAudioCtx.currentTime - transportAudioStartAt)
          : Math.max(0, (performance.now() - transportStartedAt) / 1000)
      const current = transportBaseSec + elapsed
      const runtimeCurrent = resolveTransportAudibleTimelineSec(
        current,
        transportGraphNodes,
        transportMasterTrackId
      )
      applyTransportMixParamsAtTimelineSec(runtimeCurrent)
      const syncResult = applyTimelineTransportSync({
        nodes: transportGraphNodes,
        timelineSec: runtimeCurrent,
        masterTrackId: transportMasterTrackId,
        audioCtx: transportAudioCtx
      })
      transportMasterTrackId = syncResult.masterTrackId
      mirrorTransportStemPlaybackRates(transportGraphNodes, transportAudioCtx)
      const audibleCurrent = resolveTransportAudibleTimelineSec(
        runtimeCurrent,
        transportGraphNodes,
        transportMasterTrackId
      )
      playheadSec.value = audibleCurrent
      syncTimelineScrollByPlayhead(audibleCurrent)
      if (current >= transportDurationSec) {
        stopTransport()
        // 播放结束时保持播放中线可见
        playheadSec.value = transportDurationSec
        return
      }
      transportRaf = requestAnimationFrame(tick)
    }
    transportRaf = requestAnimationFrame(tick)
  }

  const handleTransportToggle = () => {
    if (transportPlaying.value || transportDecoding.value) {
      finishTransportPlayback()
      return
    }
    void startTransportFrom(resolveTransportRestartSec())
  }

  const handleTransportPlayFromStart = () => {
    void startTransportFrom(resolveTransportMinStartSec())
  }

  const handleRulerSeek = (event: MouseEvent) => {
    if (event.button !== 0) return
    void startTransportFrom(resolveRulerSeekSec(event))
  }

  const handleToggleFollowPlayhead = () => {
    followPlayheadEnabled.value = !followPlayheadEnabled.value
    if (!followPlayheadEnabled.value) return
    const currentSec = clampNumber(
      playheadSec.value,
      0,
      Math.max(resolveTransportDuration(), timelineDurationSec.value)
    )
    syncTimelineScrollByPlayhead(currentSec)
  }

  const stopTransportForTrackChange = () => {
    if (!transportPlaying.value && !transportDecoding.value) return
    stopTransport()
    playheadVisible.value = false
  }

  const { isTrackDragging, handleTrackDragStart, cleanupTrackDrag } =
    createTimelineTransportTrackDragModule({
      tracks,
      normalizedRenderZoom,
      resolveRenderPxPerSec,
      resolveTrackDurationSeconds,
      resolveTrackSourceDurationSeconds,
      resolveTrackFirstBeatSeconds,
      resolveTimelineSecByX,
      stopTransportForTrackChange,
      scheduleFullPreRender,
      scheduleWorkerPreRender,
      persistTrackStartSec,
      persistTrackVolumeMuteSegments,
      remapVolumeMuteSegmentsForBpm,
      normalizeStartSec,
      clampNumber,
      normalizeBeatOffset
    })

  const cleanupTransportAndDrag = () => {
    cleanupTransportAudioData()
    stopTransport()
    cleanupTrackDrag()
    if (transportMasterGainNode) {
      try {
        transportMasterGainNode.disconnect()
      } catch {}
      transportMasterGainNode = null
    }
    unregisterTitleAudioVisualizerSource('mixtapeWindow', titleAudioVisualizerSource)
    try {
      transportAnalyserNode?.disconnect()
    } catch {}
    transportAnalyserNode = null
    // 关闭 AudioContext 释放资源
    if (transportAudioCtx && transportAudioCtx.state !== 'closed') {
      try {
        void transportAudioCtx.close()
      } catch {}
      transportAudioCtx = null
    }
  }

  return {
    isTrackDragging,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadSec,
    playheadVisible,
    followPlayheadEnabled,
    transportError,
    timelineDurationSec,
    playheadTimeLabel,
    overviewPlayheadStyle,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    handleTransportToggle,
    handleTransportPlayFromStart,
    handleTransportStop,
    handleRulerSeek,
    handleToggleFollowPlayhead,
    stopTransportForTrackChange,
    handleTrackDragStart,
    scheduleTransportPreload,
    cleanupTransportAndDrag,
    renderMixtapeOutputWav,
    setTransportMasterVolume
  }
}
