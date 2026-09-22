import type { Ref } from 'vue'
import { canPlayHtmlAudio, toPreviewUrl } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import { t } from '@renderer/utils/translate'
import { createTrackTimeMapFromSnapshotPayload } from '@renderer/composables/mixtape/trackTimeMapFactory'
import {
  normalizeBeatOffset as normalizeBeatOffsetByGrid,
  resolveBeatSecByBpm,
  resolveGridAnchorSec
} from '@renderer/composables/mixtape/beatSyncModel'
import { MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM } from '@renderer/composables/mixtape/gainEnvelope'
import { resolveMixtapeAudioBeatGridMap } from '@renderer/composables/mixtape/mixtapeAudioGridBasis'
import {
  buildTrackRuntimeTempoSnapshot,
  serializeTrackRuntimeTempoSnapshot
} from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import {
  buildMixtapeTrackLoopSections,
  normalizeMixtapeTrackLoopSegment
} from '@renderer/composables/mixtape/mixtapeTrackLoop'
import {
  buildTransportPlaybackSequence,
  type TransportPlaybackSequence
} from '@renderer/composables/mixtape/timelineTransportPlaybackSequence'
import {
  buildTransportDynamicTempoSegments,
  resolveTransportDynamicTempoSegmentAtLocalSec,
  type TransportDynamicTempoSegment
} from '@renderer/composables/mixtape/timelineTransportDynamicTempoSegments'
import { normalizeVolumeMuteSegments } from '@renderer/composables/mixtape/volumeMuteSegments'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
  SerializedTrackTempoSnapshot,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'

type MixtapeStemStatusValue = 'idle' | 'pending' | 'running' | 'ready' | 'failed'

type TimelineSequentialLayoutEntry = {
  track: MixtapeTrack
  startSec: number
  startX: number
}

type TimelineTransportAudioDataCtx = {
  tracks: Ref<MixtapeTrack[]>
  playheadSec: Ref<number>
  normalizedRenderZoom: Ref<number>
  timelineLayout: Ref<{ totalWidth: number }>
  resolveRenderPxPerSec: (zoom: number) => number
  buildSequentialLayoutForZoom: (zoom: number) => {
    layout: TimelineSequentialLayoutEntry[]
  }
  resolveTimelineSecByX: (x: number, pxPerSec: number) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackTempoRatio: (track: MixtapeTrack, targetBpm?: number) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack, bpm?: number) => number
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackStartSec: (track: MixtapeTrack) => number
  resolveTrackMixEnvelope: (
    track: MixtapeTrack,
    duration: number,
    param: MixtapeEnvelopeParamId
  ) => MixtapeGainPoint[]
  resolveMixEnvelopeParams: () => MixtapeEnvelopeParamId[]
  resolveStemIdsForMode: () => TransportStemId[]
  resolveTrackStemFilePath: (track: MixtapeTrack, stemId: TransportStemId) => string
  isStemMixMode: () => boolean
  normalizeMixtapeStemStatus: (value: unknown) => MixtapeStemStatusValue
  ensureTransportAudioContext: (sampleRate?: number) => AudioContext
  transportPreloading: Ref<boolean>
  transportPreloadDone: Ref<number>
  transportPreloadTotal: Ref<number>
  transportPreloadFailed: Ref<number>
}

export type TransportStemId = 'vocal' | 'inst' | 'bass' | 'drums'

export type TransportAudioRef = {
  filePath: string
  decodeMode: 'browser' | 'ipc'
  audioBuffer: AudioBuffer | null
}

export type TransportStemAudioRef = {
  stemId: TransportStemId
  filePath: string
  decodeMode: 'browser' | 'ipc'
  audioBuffer: AudioBuffer | null
}

type PreloadAudioRef = TransportAudioRef | TransportStemAudioRef

export type TransportEntry = {
  trackId: string
  filePath: string
  startSec: number
  bpm: number
  originalBpm: number
  tempoSnapshot: SerializedTrackTempoSnapshot
  beatSec: number
  firstBeatSec: number
  downbeatBeatOffset: number
  masterTempo: boolean
  syncAnchorSec: number
  sourceDuration: number
  sourceOffsetSec: number
  sourceSegmentDuration: number
  duration: number
  trackDuration: number
  localStartSec: number
  baseLocalStartSec: number
  tempoRatio: number
  mixEnvelopes: Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[]>>
  mixEnvelopeSources: Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[] | undefined>>
  volumeMuteSegments: MixtapeMuteSegment[]
  volumeMuteSegmentsSource?: MixtapeMuteSegment[]
  dynamicTempoSegments?: TransportDynamicTempoSegment[]
  playbackSequence?: TransportPlaybackSequence
  audioRef?: TransportAudioRef
  stemAudioById?: Partial<Record<TransportStemId, TransportStemAudioRef>>
}

const TRANSPORT_PRELOAD_PRIORITY_TRACK_LIMIT = 3

const normalizePcmData = (pcmData: unknown): Float32Array => {
  if (!pcmData) return new Float32Array(0)
  if (pcmData instanceof Float32Array) return pcmData
  if (pcmData instanceof ArrayBuffer) return new Float32Array(pcmData)
  if (ArrayBuffer.isView(pcmData)) {
    const view = pcmData as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}

const fillAudioBufferFromInterleavedPcm = (
  buffer: AudioBuffer,
  pcmData: Float32Array,
  channels: number,
  frameCount: number
) => {
  if (channels <= 1) {
    buffer.getChannelData(0).set(pcmData.subarray(0, frameCount))
    return
  }

  if (channels === 2) {
    const left = buffer.getChannelData(0)
    const right = buffer.getChannelData(1)
    let readIndex = 0
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      left[frameIndex] = pcmData[readIndex]
      right[frameIndex] = pcmData[readIndex + 1]
      readIndex += 2
    }
    return
  }

  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const channelData = buffer.getChannelData(channelIndex)
    let readIndex = channelIndex
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      channelData[frameIndex] = pcmData[readIndex]
      readIndex += channels
    }
  }
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const normalizeBeatOffset = (value: unknown, interval: number) => {
  return normalizeBeatOffsetByGrid(value, interval)
}

export const createTimelineTransportAudioDataModule = (ctx: TimelineTransportAudioDataCtx) => {
  const transportDecodedBufferCache = new Map<string, AudioBuffer>()
  const transportDecodeInflight = new Map<string, Promise<AudioBuffer>>()
  let transportPreloadVersion = 0
  let transportPreloadTimer: ReturnType<typeof setTimeout> | null = null

  const resolveTrackDurationByBpm = (track: MixtapeTrack, targetBpm: number) => {
    const sourceDuration = ctx.resolveTrackSourceDurationSeconds(track)
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) return 0
    const tempoRatio = ctx.resolveTrackTempoRatio(track, targetBpm)
    if (!Number.isFinite(tempoRatio) || tempoRatio <= 0) return sourceDuration
    return sourceDuration / Math.max(0.01, tempoRatio)
  }

  const remapVolumeMuteSegmentsForBpm = (track: MixtapeTrack, targetBpm: number) => {
    const sourceDuration = ctx.resolveTrackDurationSeconds(track)
    const targetDuration = resolveTrackDurationByBpm(track, targetBpm)
    const sourceSegments = normalizeVolumeMuteSegments(track.volumeMuteSegments, sourceDuration)
    if (!sourceSegments.length) return [] as MixtapeMuteSegment[]
    const sourceBpm = Number(track.bpm)
    const sourceBeatSec = resolveBeatSecByBpm(sourceBpm)
    const targetBeatSec = resolveBeatSecByBpm(targetBpm)
    if (
      !Number.isFinite(sourceBeatSec) ||
      !sourceBeatSec ||
      !Number.isFinite(targetBeatSec) ||
      !targetBeatSec ||
      !targetDuration
    ) {
      return normalizeVolumeMuteSegments(sourceSegments, targetDuration || sourceDuration)
    }
    const sourceFirstBeatSec = ctx.resolveTrackFirstBeatSeconds(track, sourceBpm)
    const targetFirstBeatSec = ctx.resolveTrackFirstBeatSeconds(track, targetBpm)
    const beatSnapEpsilon = 0.0005
    const remapped = sourceSegments
      .map((segment) => {
        const startBeatRaw = (segment.startSec - sourceFirstBeatSec) / sourceBeatSec
        const endBeatRaw = (segment.endSec - sourceFirstBeatSec) / sourceBeatSec
        const startBeatNearest = Math.round(startBeatRaw)
        const endBeatNearest = Math.round(endBeatRaw)
        const startBeat =
          Math.abs(startBeatRaw - startBeatNearest) <= beatSnapEpsilon
            ? startBeatNearest
            : startBeatRaw
        const endBeat =
          Math.abs(endBeatRaw - endBeatNearest) <= beatSnapEpsilon ? endBeatNearest : endBeatRaw
        const remappedStart = clampNumber(
          targetFirstBeatSec + startBeat * targetBeatSec,
          0,
          targetDuration
        )
        const remappedEnd = clampNumber(
          targetFirstBeatSec + endBeat * targetBeatSec,
          0,
          targetDuration
        )
        if (remappedEnd - remappedStart <= 0.0001) return null
        return {
          startSec: Number(remappedStart.toFixed(4)),
          endSec: Number(remappedEnd.toFixed(4))
        }
      })
      .filter((segment): segment is MixtapeMuteSegment => segment !== null)
    return normalizeVolumeMuteSegments(remapped, targetDuration)
  }

  const readTransportBufferCache = (filePath: string): AudioBuffer | null => {
    const key = String(filePath || '').trim()
    if (!key) return null
    const cached = transportDecodedBufferCache.get(key) || null
    if (!cached) return null
    transportDecodedBufferCache.delete(key)
    transportDecodedBufferCache.set(key, cached)
    return cached
  }

  const writeTransportBufferCache = (filePath: string, buffer: AudioBuffer) => {
    const key = String(filePath || '').trim()
    if (!key || !buffer) return
    if (transportDecodedBufferCache.has(key)) {
      transportDecodedBufferCache.delete(key)
    }
    transportDecodedBufferCache.set(key, buffer)
  }

  const clearTransportPreloadTimer = () => {
    if (!transportPreloadTimer) return
    clearTimeout(transportPreloadTimer)
    transportPreloadTimer = null
  }

  const resetTransportPreloadProgress = () => {
    ctx.transportPreloadTotal.value = 0
    ctx.transportPreloadDone.value = 0
    ctx.transportPreloadFailed.value = 0
  }

  const resolveTransportPreloadConcurrencyCap = () => {
    const logicalCpuCount =
      typeof navigator !== 'undefined' ? Math.max(1, Number(navigator.hardwareConcurrency) || 1) : 4
    return logicalCpuCount >= 16
      ? 8
      : logicalCpuCount >= 12
        ? 6
        : logicalCpuCount >= 8
          ? 5
          : logicalCpuCount >= 4
            ? 4
            : 3
  }

  const cancelTransportPreload = () => {
    transportPreloadVersion += 1
    ctx.transportPreloading.value = false
    clearTransportPreloadTimer()
  }

  const buildTransportEntriesInternal = (splitLoopSections: boolean) => {
    const pxPerSec = Math.max(0.0001, ctx.resolveRenderPxPerSec(ctx.normalizedRenderZoom.value))
    const snapshot = ctx.buildSequentialLayoutForZoom(ctx.normalizedRenderZoom.value)
    const startSecById = new Map<string, number>()
    for (const item of snapshot.layout) {
      const layoutStartSec = Number(item.startSec)
      startSecById.set(
        item.track.id,
        Number.isFinite(layoutStartSec)
          ? layoutStartSec
          : ctx.resolveTimelineSecByX(item.startX, pxPerSec)
      )
    }
    let missingDurationCount = 0
    let stemNotReadyCount = 0
    let missingStemAssetCount = 0
    const useStemMode = ctx.isStemMixMode()
    const entries: TransportEntry[] = []
    for (const track of ctx.tracks.value) {
      const stemStatus = useStemMode ? ctx.normalizeMixtapeStemStatus(track.stemStatus) : 'ready'
      const stemReadyForPlayback = !useStemMode || stemStatus === 'ready'
      if (useStemMode && !stemReadyForPlayback) {
        stemNotReadyCount += 1
      }
      const filePath = String(track.filePath || '').trim()
      if (!filePath) continue
      const sourceDuration = ctx.resolveTrackSourceDurationSeconds(track)
      if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
        missingDurationCount += 1
        continue
      }
      const bpm = Number(track.bpm)
      const originalBpm = Number(track.originalBpm) || bpm
      const runtimeTempoSnapshot = buildTrackRuntimeTempoSnapshot({
        track,
        sourceDurationSec: sourceDuration
      })
      const tempoSnapshot = serializeTrackRuntimeTempoSnapshot(runtimeTempoSnapshot)
      const beatSec = resolveBeatSecByBpm(bpm)
      const tempoRatio =
        sourceDuration > 0 ? sourceDuration / Math.max(0.01, runtimeTempoSnapshot.durationSec) : 1
      const trackDuration = tempoSnapshot.durationSec
      const firstBeatSec = runtimeTempoSnapshot.timeMap.mapSourceToLocal(
        runtimeTempoSnapshot.firstBeatSourceSec
      )
      const downbeatBeatOffset = normalizeBeatOffset(track.downbeatBeatOffset, 4)
      const masterTempo = track.masterTempo !== false
      const trackStartSec = startSecById.get(track.id) ?? ctx.resolveTrackStartSec(track)
      const visibleDownbeatLines = runtimeTempoSnapshot.timeMap
        .buildVisibleGridLines(Number.POSITIVE_INFINITY)
        .filter((line) => line.level === 'downbeat')
      const activeParams = ctx.resolveMixEnvelopeParams()
      const mixEnvelopes = activeParams.reduce(
        (acc, param) => {
          acc[param] = ctx.resolveTrackMixEnvelope(track, trackDuration, param)
          return acc
        },
        {} as Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[]>>
      )
      const mixEnvelopeSources = activeParams.reduce(
        (acc, param) => {
          const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
          acc[param] = track[envelopeField]
          return acc
        },
        {} as Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[] | undefined>>
      )
      const volumeMuteSegmentsSource = track.volumeMuteSegments
      const volumeMuteSegments = normalizeVolumeMuteSegments(
        volumeMuteSegmentsSource,
        trackDuration
      )
      const decodeMode: 'browser' | 'ipc' = canPlayHtmlAudio(filePath) ? 'browser' : 'ipc'
      const audioRef = useStemMode
        ? undefined
        : {
            filePath,
            decodeMode,
            audioBuffer: null
          }
      const stemIds = ctx.resolveStemIdsForMode()
      let stemAudioById: Partial<Record<TransportStemId, TransportStemAudioRef>> | undefined
      if (useStemMode && stemReadyForPlayback) {
        const nextStemAudioById: Partial<Record<TransportStemId, TransportStemAudioRef>> = {}
        let stemAssetsMissing = false
        for (const stemId of stemIds) {
          const stemFilePath = ctx.resolveTrackStemFilePath(track, stemId)
          if (!stemFilePath) {
            missingStemAssetCount += 1
            stemAssetsMissing = true
            break
          }
          nextStemAudioById[stemId] = {
            stemId,
            filePath: stemFilePath,
            decodeMode: canPlayHtmlAudio(stemFilePath) ? 'browser' : 'ipc',
            audioBuffer: null
          }
        }
        if (!stemAssetsMissing) {
          stemAudioById = nextStemAudioById
        }
      }
      const loopValue =
        Array.isArray(track.loopSegments) && track.loopSegments.length
          ? track.loopSegments
          : normalizeMixtapeTrackLoopSegment(track.loopSegment, tempoSnapshot.baseDurationSec)
      const baseTimeMap = createTrackTimeMapFromSnapshotPayload({
        ...tempoSnapshot,
        durationSec: tempoSnapshot.baseDurationSec,
        loopSegments: undefined,
        loopSegment: undefined
      })
      const playbackSequence = buildTransportPlaybackSequence({
        baseDurationSec: tempoSnapshot.baseDurationSec,
        loopSegments: Array.isArray(loopValue) ? loopValue : undefined,
        loopSegment: Array.isArray(loopValue) ? undefined : loopValue,
        mapBaseLocalToSource: (localSec: number) => baseTimeMap.mapLocalToSource(localSec)
      })
      const dynamicTempoSegments = buildTransportDynamicTempoSegments({
        sourceBeatGridMap: resolveMixtapeAudioBeatGridMap(track, sourceDuration),
        sourceDurationSec: sourceDuration,
        trackStartSec,
        playbackSequence,
        mapSourceToBaseLocal: (sourceSec: number) => baseTimeMap.mapSourceToLocal(sourceSec)
      })
      const resolveSegmentTempoRatio = (localSec: number) => {
        const segment = resolveTransportDynamicTempoSegmentAtLocalSec(
          dynamicTempoSegments,
          localSec
        )
        if (!segment) return tempoRatio
        const targetBpm = runtimeTempoSnapshot.timeMap.sampleBpmAtLocal(localSec)
        if (!Number.isFinite(targetBpm) || targetBpm <= 0) return tempoRatio
        const sourceBpm = Number(segment.sourceBpm)
        if (!Number.isFinite(sourceBpm) || sourceBpm <= 0) return tempoRatio
        return targetBpm / sourceBpm
      }
      const sectionList = splitLoopSections
        ? buildMixtapeTrackLoopSections(tempoSnapshot.baseDurationSec, loopValue)
        : [
            {
              key: 'track',
              loopKey: null,
              kind: 'head' as const,
              displayStartSec: 0,
              displayEndSec: trackDuration,
              baseStartSec: 0,
              baseEndSec: tempoSnapshot.baseDurationSec,
              repeatIndex: 0
            }
          ]
      for (const section of sectionList) {
        const duration = Number((section.displayEndSec - section.displayStartSec).toFixed(4))
        if (!Number.isFinite(duration) || duration <= 0.0001) continue
        const localStartSec = splitLoopSections ? Number(section.displayStartSec.toFixed(4)) : 0
        const sourceOffsetSec = Number(
          (splitLoopSections
            ? runtimeTempoSnapshot.timeMap.mapLocalToSource(localStartSec)
            : playbackSequence.segments[0]?.sourceStartSec || 0
          ).toFixed(4)
        )
        const sourceSegmentDuration = splitLoopSections
          ? Math.max(
              0,
              Number(
                (
                  runtimeTempoSnapshot.timeMap.mapLocalToSource(section.displayEndSec) -
                  sourceOffsetSec
                ).toFixed(4)
              )
            )
          : sourceDuration
        const firstDownbeatLine =
          visibleDownbeatLines.find(
            (line) =>
              line.sec >= (splitLoopSections ? section.displayStartSec : 0) - 0.0001 &&
              line.sec < (splitLoopSections ? section.displayEndSec : trackDuration) - 0.0001
          ) || null
        const startSec = Number(
          (trackStartSec + (splitLoopSections ? section.displayStartSec : 0)).toFixed(4)
        )
        const syncAnchorSec =
          typeof firstDownbeatLine?.sec === 'number'
            ? Number((trackStartSec + firstDownbeatLine.sec).toFixed(4))
            : resolveGridAnchorSec({
                startSec,
                firstBeatSec: Math.max(0, firstBeatSec - (splitLoopSections ? localStartSec : 0)),
                beatSec,
                downbeatBeatOffset
              })
        entries.push({
          trackId: track.id,
          filePath,
          startSec,
          bpm,
          originalBpm,
          tempoSnapshot,
          beatSec,
          firstBeatSec,
          downbeatBeatOffset,
          masterTempo,
          syncAnchorSec,
          sourceDuration,
          sourceOffsetSec,
          sourceSegmentDuration,
          duration,
          trackDuration,
          localStartSec,
          baseLocalStartSec: splitLoopSections ? Number(section.baseStartSec.toFixed(4)) : 0,
          tempoRatio: Math.max(0.25, Math.min(4, resolveSegmentTempoRatio(localStartSec))),
          mixEnvelopes,
          mixEnvelopeSources,
          volumeMuteSegments,
          volumeMuteSegmentsSource,
          dynamicTempoSegments: dynamicTempoSegments.length ? dynamicTempoSegments : undefined,
          playbackSequence: splitLoopSections ? undefined : playbackSequence,
          audioRef,
          stemAudioById
        })
      }
    }
    entries.sort((a, b) => a.startSec - b.startSec)
    return {
      entries,
      decodeFailedCount: 0,
      missingDurationCount,
      stemNotReadyCount,
      missingStemAssetCount
    }
  }

  const buildTransportEntries = () => buildTransportEntriesInternal(true)

  const buildTransportPlaybackEntries = () => buildTransportEntriesInternal(false)

  const decodeBrowser = async (filePath: string): Promise<AudioBuffer> => {
    const url = toPreviewUrl(filePath)
    const response = await fetch(url)
    if (!response.ok) throw new Error(t('mixtape.transportFetchFailed', { status: response.status }))
    const arrayBuffer = await response.arrayBuffer()
    if (!arrayBuffer.byteLength) throw new Error(t('mixtape.transportFetchEmpty'))
    const audioCtx = ctx.ensureTransportAudioContext()
    return await audioCtx.decodeAudioData(arrayBuffer)
  }

  const decodeIpc = async (filePath: string): Promise<AudioBuffer> => {
    const result = await window.electron.ipcRenderer.invoke(
      'mixtape:decode-for-transport',
      filePath
    )
    const pcmData = normalizePcmData(result?.pcmData)
    const sampleRate = Number(result?.sampleRate) || 44100
    const channels = Math.max(1, Number(result?.channels) || 1)
    const totalFrames = Number(result?.totalFrames) || 0
    const frameCount =
      totalFrames > 0
        ? Math.min(totalFrames, Math.floor(pcmData.length / channels))
        : Math.floor(pcmData.length / channels)
    if (frameCount <= 0 || !pcmData.length) throw new Error(t('mixtape.transportDecodeEmpty'))
    const audioCtx = ctx.ensureTransportAudioContext(sampleRate)
    const buffer = audioCtx.createBuffer(channels, frameCount, sampleRate)
    fillAudioBufferFromInterleavedPcm(buffer, pcmData, channels, frameCount)
    return buffer
  }

  const ensureDecodedAudio = async (audioRef: PreloadAudioRef): Promise<void> => {
    const cached = readTransportBufferCache(audioRef.filePath)
    if (cached) {
      audioRef.audioBuffer = cached
      return
    }
    const filePath = audioRef.filePath
    let inflight = transportDecodeInflight.get(filePath)
    if (!inflight) {
      inflight = (async () => {
        const buffer =
          audioRef.decodeMode === 'browser'
            ? await decodeBrowser(filePath).catch(async () => await decodeIpc(filePath))
            : await decodeIpc(filePath)
        writeTransportBufferCache(filePath, buffer)
        return buffer
      })().finally(() => {
        transportDecodeInflight.delete(filePath)
      })
      transportDecodeInflight.set(filePath, inflight)
    }
    audioRef.audioBuffer = await inflight
  }

  const ensureDecodedStemAudio = async (stemAudio: TransportStemAudioRef): Promise<void> => {
    await ensureDecodedAudio(stemAudio)
  }

  const ensureDecodedAudioRef = async (audioRef: TransportAudioRef): Promise<void> => {
    await ensureDecodedAudio(audioRef)
  }

  const ensureDecodedTransportEntry = async (entry: TransportEntry): Promise<void> => {
    if (ctx.isStemMixMode()) {
      const stemIds = ctx.resolveStemIdsForMode()
      await Promise.all(
        stemIds.map(async (stemId) => {
          const stemAudio = entry.stemAudioById?.[stemId]
          if (!stemAudio) return
          await ensureDecodedStemAudio(stemAudio)
        })
      )
      return
    }
    if (!entry.audioRef) return
    await ensureDecodedAudioRef(entry.audioRef)
  }

  const decodeAllTransportEntries = async (entries: TransportEntry[]): Promise<number> => {
    if (!entries.length) return 0
    const failedTrackKeys = new Set<string>()
    const markEntryDecodeFailed = (entry: Pick<TransportEntry, 'trackId' | 'filePath'>) => {
      const key = String(entry.trackId || entry.filePath || '').trim()
      if (key) failedTrackKeys.add(key)
    }
    if (ctx.isStemMixMode()) {
      const stemAudioByPath = new Map<
        string,
        {
          audio: TransportStemAudioRef
          entries: Array<Pick<TransportEntry, 'trackId' | 'filePath'>>
        }
      >()
      for (const entry of entries) {
        for (const stemId of ctx.resolveStemIdsForMode()) {
          const stemAudio = entry.stemAudioById?.[stemId]
          if (!stemAudio) continue
          const filePath = String(stemAudio.filePath || '').trim()
          if (!filePath) continue
          const existing = stemAudioByPath.get(filePath)
          if (existing) {
            existing.entries.push(entry)
          } else {
            stemAudioByPath.set(filePath, {
              audio: stemAudio,
              entries: [entry]
            })
          }
        }
      }
      const failedStemPaths = new Set<string>()
      const stemAudioEntries = Array.from(stemAudioByPath.entries())
      await Promise.all(
        stemAudioEntries.map(async ([filePath, item]) => {
          try {
            await ensureDecodedStemAudio(item.audio)
          } catch (error) {
            console.error(
              `[mixtape-transport] 解码失败 (${item.audio.decodeMode}):`,
              item.audio.filePath,
              error
            )
            failedStemPaths.add(filePath)
            item.entries.forEach(markEntryDecodeFailed)
          }
        })
      )
      for (const entry of entries) {
        const hasKnownFailedStem = ctx.resolveStemIdsForMode().some((stemId) => {
          const filePath = String(entry.stemAudioById?.[stemId]?.filePath || '').trim()
          return !!filePath && failedStemPaths.has(filePath)
        })
        if (hasKnownFailedStem) {
          markEntryDecodeFailed(entry)
          continue
        }
        try {
          await ensureDecodedTransportEntry(entry)
        } catch (error) {
          console.error('[mixtape-transport] stem entry preprocess failed:', entry.filePath, error)
          markEntryDecodeFailed(entry)
        }
      }
      return failedTrackKeys.size
    }
    const audioRefByPath = new Map<
      string,
      {
        audio: TransportAudioRef
        entries: Array<Pick<TransportEntry, 'trackId' | 'filePath'>>
      }
    >()
    for (const entry of entries) {
      const audioRef = entry.audioRef
      const filePath = String(audioRef?.filePath || '').trim()
      if (!audioRef || !filePath) continue
      const existing = audioRefByPath.get(filePath)
      if (existing) {
        existing.entries.push(entry)
      } else {
        audioRefByPath.set(filePath, {
          audio: audioRef,
          entries: [entry]
        })
      }
    }
    const failedAudioPaths = new Set<string>()
    await Promise.all(
      Array.from(audioRefByPath.entries()).map(async ([filePath, item]) => {
        try {
          await ensureDecodedAudioRef(item.audio)
        } catch (error) {
          console.error(
            `[mixtape-transport] 解码失败 (${item.audio.decodeMode}):`,
            item.audio.filePath,
            error
          )
          failedAudioPaths.add(filePath)
          item.entries.forEach(markEntryDecodeFailed)
        }
      })
    )
    for (const entry of entries) {
      const filePath = String(entry.audioRef?.filePath || '').trim()
      if (filePath && failedAudioPaths.has(filePath)) {
        markEntryDecodeFailed(entry)
        continue
      }
      try {
        await ensureDecodedTransportEntry(entry)
      } catch (error) {
        console.error('[mixtape-transport] entry preprocess failed:', entry.filePath, error)
        markEntryDecodeFailed(entry)
      }
    }
    return failedTrackKeys.size
  }

  const collectUniqueTransportAudios = (entries: TransportEntry[]): PreloadAudioRef[] => {
    const uniqueAudioRefs = new Map<string, PreloadAudioRef>()
    if (ctx.isStemMixMode()) {
      for (const entry of entries) {
        for (const stemId of ctx.resolveStemIdsForMode()) {
          const stemAudio = entry.stemAudioById?.[stemId]
          const stemPath = String(stemAudio?.filePath || '').trim()
          if (!stemAudio || !stemPath || uniqueAudioRefs.has(stemPath)) continue
          uniqueAudioRefs.set(stemPath, stemAudio)
        }
      }
      return Array.from(uniqueAudioRefs.values())
    }

    for (const entry of entries) {
      const audioRef = entry.audioRef
      const filePath = String(audioRef?.filePath || '').trim()
      if (!audioRef || !filePath || uniqueAudioRefs.has(filePath)) continue
      uniqueAudioRefs.set(filePath, audioRef)
    }
    return Array.from(uniqueAudioRefs.values())
  }

  const collectPriorityPreloadPaths = (entries: TransportEntry[]): Set<string> => {
    const selectedEntries: TransportEntry[] = []
    const selectedTrackIds = new Set<string>()
    const focusSec = Math.max(0, Number(ctx.playheadSec.value) || 0)
    const priorityTrackLimit = ctx.isStemMixMode() ? 2 : TRANSPORT_PRELOAD_PRIORITY_TRACK_LIMIT
    const overlapping: TransportEntry[] = []
    const upcoming: TransportEntry[] = []
    const previous: TransportEntry[] = []

    for (const entry of entries) {
      const startSec = Math.max(0, Number(entry.startSec) || 0)
      const endSec = startSec + Math.max(0, Number(entry.duration) || 0)
      if (focusSec >= startSec && focusSec < endSec) {
        overlapping.push(entry)
        continue
      }
      if (startSec >= focusSec) {
        upcoming.push(entry)
        continue
      }
      previous.push(entry)
    }

    overlapping.sort((a, b) => a.startSec - b.startSec)
    upcoming.sort((a, b) => a.startSec - b.startSec)
    previous.sort((a, b) => b.startSec - a.startSec)

    const appendEntries = (candidates: TransportEntry[]) => {
      for (const entry of candidates) {
        if (selectedEntries.length >= priorityTrackLimit) return
        if (selectedTrackIds.has(entry.trackId)) continue
        selectedTrackIds.add(entry.trackId)
        selectedEntries.push(entry)
      }
    }

    appendEntries(overlapping)
    appendEntries(upcoming)
    appendEntries(previous)
    if (!selectedEntries.length) {
      appendEntries([...entries].sort((a, b) => a.startSec - b.startSec))
    }

    const priorityPaths = new Set<string>()
    for (const entry of selectedEntries) {
      if (ctx.isStemMixMode()) {
        for (const stemId of ctx.resolveStemIdsForMode()) {
          const stemPath = String(entry.stemAudioById?.[stemId]?.filePath || '').trim()
          if (stemPath) {
            priorityPaths.add(stemPath)
          }
        }
        continue
      }
      const filePath = String(entry.audioRef?.filePath || '').trim()
      if (filePath) {
        priorityPaths.add(filePath)
      }
    }
    return priorityPaths
  }

  const runTransportPreloadBatch = async (
    audioRefs: PreloadAudioRef[],
    version: number,
    trackVisibleProgress: boolean
  ) => {
    if (!audioRefs.length) return
    let cursor = 0
    const workerCount = Math.max(
      1,
      Math.min(resolveTransportPreloadConcurrencyCap(), audioRefs.length)
    )
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (version !== transportPreloadVersion) return
        const index = cursor
        cursor += 1
        if (index >= audioRefs.length) return
        const audioRef = audioRefs[index]
        try {
          await ensureDecodedAudio(audioRef)
        } catch (error) {
          console.error('[mixtape-transport] 预解码失败:', audioRef.filePath, error)
          if (trackVisibleProgress && version === transportPreloadVersion) {
            ctx.transportPreloadFailed.value += 1
          }
        } finally {
          if (trackVisibleProgress && version === transportPreloadVersion) {
            ctx.transportPreloadDone.value += 1
          }
        }
      }
    })
    await Promise.all(workers)
  }

  const preloadTransportBuffers = async () => {
    const version = ++transportPreloadVersion
    const plan = buildTransportEntries()
    const uniqueAudios = collectUniqueTransportAudios(plan.entries)
    const keepPaths = new Set(uniqueAudios.map((item) => item.filePath))
    for (const key of Array.from(transportDecodedBufferCache.keys())) {
      if (!keepPaths.has(key)) {
        transportDecodedBufferCache.delete(key)
      }
    }
    if (!uniqueAudios.length) {
      ctx.transportPreloading.value = false
      resetTransportPreloadProgress()
      return
    }
    const priorityPaths = collectPriorityPreloadPaths(plan.entries)
    let visibleDone = 0
    const priorityPending: PreloadAudioRef[] = []
    const backgroundPending: PreloadAudioRef[] = []
    for (const audioRef of uniqueAudios) {
      const cached = readTransportBufferCache(audioRef.filePath)
      if (cached) {
        audioRef.audioBuffer = cached
        if (priorityPaths.has(audioRef.filePath)) {
          visibleDone += 1
        }
        continue
      }
      if (priorityPaths.has(audioRef.filePath)) {
        priorityPending.push(audioRef)
      } else {
        backgroundPending.push(audioRef)
      }
    }
    ctx.transportPreloadTotal.value = visibleDone + priorityPending.length
    ctx.transportPreloadDone.value = visibleDone
    ctx.transportPreloadFailed.value = 0
    if (!priorityPending.length) {
      ctx.transportPreloading.value = false
      resetTransportPreloadProgress()
      if (backgroundPending.length) {
        await runTransportPreloadBatch(backgroundPending, version, false)
      }
      return
    }
    ctx.transportPreloading.value = true
    await runTransportPreloadBatch(priorityPending, version, true)
    if (version !== transportPreloadVersion) return
    ctx.transportPreloading.value = false
    resetTransportPreloadProgress()
    if (!backgroundPending.length) return
    await runTransportPreloadBatch(backgroundPending, version, false)
  }

  const scheduleTransportPreload = () => {
    clearTransportPreloadTimer()
    transportPreloadTimer = setTimeout(() => {
      transportPreloadTimer = null
      void preloadTransportBuffers()
    }, 80)
  }

  const cleanupTransportAudioData = () => {
    cancelTransportPreload()
    transportDecodeInflight.clear()
    transportDecodedBufferCache.clear()
  }

  return {
    buildTransportEntries,
    buildTransportPlaybackEntries,
    remapVolumeMuteSegmentsForBpm,
    readTransportBufferCache,
    ensureDecodedStemAudio,
    ensureDecodedTransportEntry,
    decodeAllTransportEntries,
    scheduleTransportPreload,
    cancelTransportPreload,
    cleanupTransportAudioData
  }
}
