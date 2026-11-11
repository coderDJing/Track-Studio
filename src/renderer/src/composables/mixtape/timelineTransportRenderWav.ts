import { applyTimelineTransportSync } from '@renderer/composables/mixtape/timelineTransportSync'
import { resolveStretchWorkerCount } from '@renderer/composables/mixtape/mixtapeStretchPool'
import { t } from '@renderer/utils/translate'
import {
  createTransportBufferSource,
  type TransportPlayableAudioContext,
  type TransportPlayableSource
} from '@renderer/composables/mixtape/timelineTransportPlayableSource'
import { clampTempo } from '@renderer/composables/mixtape/timelineTransportR3Source'
import { createTransportPlanBuffer } from '@renderer/composables/mixtape/timelineTransportR3Plan'
import { resolveEntryPlaybackOffsetPlanSec } from '@renderer/composables/mixtape/timelineTransportPositionMapping'
import {
  createMixtapeTempoProbe,
  type MixtapeTempoProbe
} from '@renderer/composables/mixtape/mixtapeTempoProbe'
import type { TransportSyncNode } from '@renderer/composables/mixtape/timelineTransportSync'
import type { MixtapeEnvelopeParamId } from '@renderer/composables/mixtape/types'
import type {
  TransportEntry,
  TransportStemAudioRef,
  TransportStemId
} from '@renderer/composables/mixtape/timelineTransportAudioData'
import type {
  TrackGraphNode,
  TrackStemGraphNode
} from '@renderer/composables/mixtape/timelineTransportPlaybackNodes'
import {
  renderMixtapeDeferredSources,
  type DeferredOutputSource
} from '@renderer/composables/mixtape/mixtapeDeferredStretch'
import {
  buildMixtapeOutputProgressPlan,
  estimateMixtapeOutputStageMs,
  type MixtapeOutputProgressBand
} from '@renderer/composables/mixtape/mixtapeOutputProgressPlan'

export type MixtapeOutputProgressPayload = {
  stageKey: string
  done: number
  total: number
  percent: number
}

export type MixtapeRenderedWavResult = {
  wavBytes: Uint8Array
  durationSec: number
  sampleRate: number
  channels: number
  trackCount: number
}

export type RenderTransportEntry = TransportEntry

type TimelineTransportRenderWavCtx = {
  t: (key: string, payload?: Record<string, unknown>) => string
  buildTransportEntries: () => {
    entries: RenderTransportEntry[]
    missingDurationCount: number
    stemNotReadyCount: number
    missingStemAssetCount: number
    decodeFailedCount: number
  }
  readTransportBufferCache: (filePath: string) => AudioBuffer | null
  ensureDecodedTransportEntry: (entry: TransportEntry) => Promise<void>
  ensureDecodedStemAudio?: unknown
  getTransportAudioContext: () => AudioContext | null
  clampNumber: (value: number, min: number, max: number) => number
  resolveEntryEqDbValue: (
    entry: TransportEntry,
    param: 'high' | 'mid' | 'low',
    timelineOffsetSec: number
  ) => number
  resolveEntryEnvelopeValue: (
    entry: TransportEntry,
    param: MixtapeEnvelopeParamId,
    timelineOffsetSec: number
  ) => number
  isStemMode: () => boolean
  applyTransportMixParamsAtTimelineSec: (
    timelineSec: number,
    options?: {
      nodes?: TrackGraphNode[]
      audioCtx?: BaseAudioContext | null
      automationAtSec?: number
    }
  ) => void
  resolveStemIdsForMode: () => TransportStemId[]
  mirrorTransportStemPlaybackRates: (
    nodes: TrackGraphNode[],
    audioCtx: BaseAudioContext | null,
    automationAtSec?: number
  ) => void
}

export const createTimelineTransportRenderWavModule = (ctx: TimelineTransportRenderWavCtx) => {
  const {
    t,
    buildTransportEntries,
    readTransportBufferCache,
    ensureDecodedTransportEntry,
    getTransportAudioContext,
    clampNumber,
    resolveEntryEqDbValue,
    resolveEntryEnvelopeValue,
    isStemMode,
    applyTransportMixParamsAtTimelineSec,
    resolveStemIdsForMode,
    mirrorTransportStemPlaybackRates
  } = ctx

  const SCHEDULING_PROGRESS_STEP = 20
  const SCHEDULING_YIELD_INTERVAL_MS = 12
  const WAV_ENCODE_CHUNK_FRAMES = 8192
  const WAV_ENCODE_YIELD_INTERVAL_MS = 12
  // 进度区间按真实耗时占比分配：并行拉伸与离线混音是两大头，解码/调度/编码是零头。
  // 进度条只用两个固定锚点：准备阶段占 1%，剩余 5%→96% 由各阶段按预估耗时比例瓜分，
  // 最后 96%→100% 是交给主进程写盘。各阶段的宽度不再是写死的常数（见
  // mixtapeOutputProgressPlan，速率来自 tmp/r3-parity 的实测）。
  const PROGRESS_PREPARE = 1
  const PROGRESS_DECODE_START = 5
  const PROGRESS_ENCODE_END = 96
  const RENDER_CHECKPOINT_MIN_COUNT = 8
  const RENDER_CHECKPOINT_MAX_COUNT = 120
  const isStemMixMode = (): boolean => Boolean(isStemMode?.())
  const resolveStemIds = (): TransportStemId[] => resolveStemIdsForMode() as TransportStemId[]

  const getNowMs = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()

  const throwIfAborted = (shouldAbort?: () => boolean) => {
    if (shouldAbort?.()) throw new Error('mixtape.outputCancelled')
  }

  const resolveRenderCheckpointCount = (durationSec: number) => {
    const byInterval = Math.round(durationSec / 3)
    return Math.max(RENDER_CHECKPOINT_MIN_COUNT, Math.min(RENDER_CHECKPOINT_MAX_COUNT, byInterval))
  }

  const yieldMainThread = async () => {
    await new Promise<void>((resolve) => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => resolve())
        return
      }
      setTimeout(() => resolve(), 0)
    })
  }

  const resolveOutputChannels = (_entries: RenderTransportEntry[]) => 2

  const resolveOutputSampleRate = (entries: RenderTransportEntry[]) => {
    const activeTransportSampleRate = Number(getTransportAudioContext()?.sampleRate || 0)
    if (Number.isFinite(activeTransportSampleRate) && activeTransportSampleRate > 0) {
      return activeTransportSampleRate
    }
    for (const entry of entries) {
      if (isStemMixMode()) {
        for (const stemId of resolveStemIds()) {
          const sampleRate = Number(entry.stemAudioById?.[stemId]?.audioBuffer?.sampleRate || 0)
          if (Number.isFinite(sampleRate) && sampleRate > 0) {
            return sampleRate
          }
        }
      } else {
        const sampleRate = Number(entry.audioRef?.audioBuffer?.sampleRate || 0)
        if (Number.isFinite(sampleRate) && sampleRate > 0) {
          return sampleRate
        }
      }
    }
    try {
      const context = new AudioContext()
      const sampleRate = Number(context.sampleRate) || 44100
      void context.close().catch(() => {})
      return sampleRate
    } catch {
      return 44100
    }
  }

  const writeWavText = (view: DataView, offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  const encodeAudioBufferToWav = async (
    audioBuffer: AudioBuffer,
    channels: number,
    options?: {
      onProgress?: (doneFrames: number, totalFrames: number) => void
      shouldAbort?: () => boolean
    }
  ): Promise<Uint8Array> => {
    const sourceChannels = Math.max(1, Math.floor(audioBuffer.numberOfChannels || 1))
    const outputChannels = Math.max(1, Math.min(2, Math.floor(channels || sourceChannels)))
    const frameCount = Math.max(0, Math.floor(audioBuffer.length || 0))
    const sampleRate = Math.max(1, Math.floor(audioBuffer.sampleRate || 44100))
    const bytesPerSample = 2
    const blockAlign = outputChannels * bytesPerSample
    const dataSize = frameCount * blockAlign
    const buffer = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buffer)

    writeWavText(view, 0, 'RIFF')
    view.setUint32(4, 36 + dataSize, true)
    writeWavText(view, 8, 'WAVE')
    writeWavText(view, 12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, outputChannels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * blockAlign, true)
    view.setUint16(32, blockAlign, true)
    view.setUint16(34, bytesPerSample * 8, true)
    writeWavText(view, 36, 'data')
    view.setUint32(40, dataSize, true)

    const channelData: Float32Array[] = []
    for (let channelIndex = 0; channelIndex < sourceChannels; channelIndex += 1) {
      channelData.push(audioBuffer.getChannelData(channelIndex))
    }
    // 直接写 Int16 视图：DataView.setInt16 逐样本调用在整段混音上是编码耗时的主因。
    const pcmView = new Int16Array(buffer, 44, frameCount * outputChannels)
    const monoSource = sourceChannels === 1

    let pcmIndex = 0
    let frameIndex = 0
    let lastYieldAt = getNowMs()
    while (frameIndex < frameCount) {
      const chunkEnd = Math.min(frameCount, frameIndex + WAV_ENCODE_CHUNK_FRAMES)
      for (; frameIndex < chunkEnd; frameIndex += 1) {
        for (let channelIndex = 0; channelIndex < outputChannels; channelIndex += 1) {
          const sourceIndex = monoSource ? 0 : Math.min(sourceChannels - 1, channelIndex)
          const sample = channelData[sourceIndex]?.[frameIndex] ?? 0
          const clamped = clampNumber(sample, -1, 1)
          pcmView[pcmIndex] =
            clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
          pcmIndex += 1
        }
      }
      options?.onProgress?.(frameIndex, frameCount)
      if (frameIndex >= frameCount) break
      throwIfAborted(options?.shouldAbort)
      if (getNowMs() - lastYieldAt < WAV_ENCODE_YIELD_INTERVAL_MS) continue
      await yieldMainThread()
      lastYieldAt = getNowMs()
    }
    if (frameCount <= 0) {
      options?.onProgress?.(0, 0)
    }
    return new Uint8Array(buffer)
  }

  const scheduleOfflineAutomation = async (params: {
    nodes: TrackGraphNode[]
    durationSec: number
    timelineOriginSec: number
    offlineCtx: OfflineAudioContext
    emitProgress: (payload: MixtapeOutputProgressPayload) => void
    progressStart: number
    progressEnd: number
    shouldAbort?: () => boolean
  }) => {
    const {
      nodes,
      durationSec,
      timelineOriginSec,
      offlineCtx,
      emitProgress,
      progressStart,
      progressEnd,
      shouldAbort
    } = params
    let masterTrackId = ''
    const stepSec = 1 / 120
    const totalSteps = Math.max(1, Math.ceil(durationSec / stepSec))
    const schedulingNodes = nodes as unknown as TransportSyncNode[]
    let lastYieldAt = getNowMs()
    for (let step = 0; step <= totalSteps; step += 1) {
      const renderSec = Math.min(durationSec, step * stepSec)
      const timelineSec = timelineOriginSec + renderSec
      applyTransportMixParamsAtTimelineSec(timelineSec, {
        nodes,
        audioCtx: offlineCtx,
        automationAtSec: renderSec
      })
      const syncResult = applyTimelineTransportSync({
        nodes: schedulingNodes,
        timelineSec,
        masterTrackId,
        audioCtx: offlineCtx,
        automationAtSec: renderSec
      })
      masterTrackId = syncResult.masterTrackId
      mirrorTransportStemPlaybackRates(nodes, offlineCtx, renderSec)
      if (step % SCHEDULING_PROGRESS_STEP === 0 || step === totalSteps) {
        emitProgress({
          stageKey: 'mixtape.outputProgressScheduling',
          done: step,
          total: totalSteps,
          percent: Math.round(
            progressStart + (step / Math.max(1, totalSteps)) * (progressEnd - progressStart)
          )
        })
      }
      if (step >= totalSteps) continue
      throwIfAborted(shouldAbort)
      if (getNowMs() - lastYieldAt < SCHEDULING_YIELD_INTERVAL_MS) continue
      await yieldMainThread()
      lastYieldAt = getNowMs()
    }
  }

  const emitEncodeProgress = (
    emitProgress: (payload: MixtapeOutputProgressPayload) => void,
    doneFrames: number,
    totalFrames: number,
    lastPercentRef: { value: number },
    band: MixtapeOutputProgressBand
  ) => {
    const ratio = totalFrames > 0 ? doneFrames / Math.max(1, totalFrames) : 1
    const percent = Math.round(band.start + clampNumber(ratio, 0, 1) * (band.end - band.start))
    if (percent <= lastPercentRef.value) return
    lastPercentRef.value = percent
    emitProgress({
      stageKey: 'mixtape.outputProgressEncoding',
      done: percent,
      total: 100,
      percent
    })
  }

  const resolveDeferredStartTimes = (
    entry: RenderTransportEntry,
    timelineOriginSec: number
  ): { startTimeSec: number; stopTimeSec: number } => {
    const startTimeSec = Math.max(0, entry.startSec - timelineOriginSec)
    return {
      startTimeSec,
      stopTimeSec: startTimeSec + Math.max(0.02, Number(entry.duration) || 0) + 0.02
    }
  }

  const buildOutputTrackNodes = async (
    offlineCtx: OfflineAudioContext,
    entries: RenderTransportEntry[],
    timelineOriginSec: number
  ): Promise<{ nodes: TrackGraphNode[]; deferred: DeferredOutputSource[] }> => {
    const nodes: TrackGraphNode[] = []
    const deferred: DeferredOutputSource[] = []
    const createdSources = new Set<TransportPlayableSource>()
    const useStemMode = isStemMixMode()
    const stemIds = resolveStemIds()
    const playableCtx = offlineCtx as TransportPlayableAudioContext

    const trackSource = (source: TransportPlayableSource) => {
      createdSources.add(source)
      return source
    }

    // master-tempo 轨道：先用记录桩占位，拉伸在 Worker 池里跑完后由 attach 换成真实源。
    const createDeferredSource = (
      entry: RenderTransportEntry,
      buffer: AudioBuffer,
      destination: AudioNode,
      key: string,
      attach: (source: TransportPlayableSource) => void
    ) => {
      const planBuffer = createTransportPlanBuffer(playableCtx, buffer, entry.playbackSequence)
      const usesPlan = Boolean(
        entry.playbackSequence?.segments && entry.playbackSequence.segments.length > 1
      )
      const offsetSec = usesPlan
        ? resolveEntryPlaybackOffsetPlanSec(entry, 0)
        : Math.max(0, Number(entry.sourceOffsetSec) || 0)
      const initialTempo = clampTempo(entry.tempoRatio)
      const probe = createMixtapeTempoProbe({ buffer: planBuffer, initialTempo })
      deferred.push({
        key,
        entry,
        planBuffer,
        offsetSec,
        initialTempo,
        probe,
        destination,
        attach,
        ...resolveDeferredStartTimes(entry, timelineOriginSec)
      })
      return trackSource(probe.source)
    }

    const createImmediateSource = async (
      entry: RenderTransportEntry,
      buffer: AudioBuffer
    ): Promise<TransportPlayableSource> => {
      let source: TransportPlayableSource
      if (entry.playbackSequence?.segments && entry.playbackSequence.segments.length > 1) {
        source = createTransportBufferSource(
          playableCtx,
          createTransportPlanBuffer(playableCtx, buffer, entry.playbackSequence)
        )
        source.startOffsetKind = 'plan'
      } else {
        source = createTransportBufferSource(playableCtx, buffer)
      }
      return trackSource(source)
    }

    const resolveStartOffset = (entry: RenderTransportEntry, source: TransportPlayableSource) =>
      source.startOffsetKind === 'plan'
        ? resolveEntryPlaybackOffsetPlanSec(entry, 0)
        : Math.max(0, Number(entry.sourceOffsetSec) || 0)

    try {
      for (const entry of entries) {
        if (useStemMode) {
          const stemAudios = stemIds
            .map((stemId) => entry.stemAudioById?.[stemId])
            .filter((item): item is TransportStemAudioRef => !!item && !!item.audioBuffer)
          if (!stemAudios.length) continue
          const stemBus = offlineCtx.createGain()
          const volume = offlineCtx.createGain()
          const gain = offlineCtx.createGain()

          const initialTimelineSec = timelineOriginSec
          const initialLocalSec = Math.max(0, initialTimelineSec - entry.startSec)
          volume.gain.value = resolveEntryEnvelopeValue(entry, 'volume', initialLocalSec)
          gain.gain.value = resolveEntryEnvelopeValue(entry, 'gain', initialLocalSec)
          stemBus.gain.value = 1
          stemBus.connect(volume)
          volume.connect(gain)
          gain.connect(offlineCtx.destination)

          const stemNodes: TrackStemGraphNode[] = []
          for (const stemAudio of stemAudios) {
            const stemGain = offlineCtx.createGain()
            stemGain.gain.value = resolveEntryEnvelopeValue(
              entry,
              stemAudio.stemId,
              initialLocalSec
            )
            stemGain.connect(stemBus)
            const stemNode = {
              stemId: stemAudio.stemId,
              stemGain
            } as TrackStemGraphNode
            if (entry.masterTempo) {
              stemNode.source = createDeferredSource(
                entry,
                stemAudio.audioBuffer as AudioBuffer,
                stemGain,
                `${entry.trackId}::${stemAudio.stemId}`,
                (attached) => {
                  stemNode.source = attached
                }
              )
            } else {
              const source = await createImmediateSource(
                entry,
                stemAudio.audioBuffer as AudioBuffer
              )
              source.playbackRate.value = entry.tempoRatio
              source.connect(stemGain)
              await source.start(
                Math.max(0, entry.startSec - timelineOriginSec),
                resolveStartOffset(entry, source)
              )
              source.stop(
                Math.max(0, entry.startSec - timelineOriginSec) +
                  Math.max(0.02, Number(entry.duration) || 0) +
                  0.02
              )
              stemNode.source = source
            }
            stemNodes.push(stemNode)
          }
          const primaryStemNode = stemNodes[0]
          if (!primaryStemNode) continue

          nodes.push({
            trackId: entry.trackId,
            entry,
            source: primaryStemNode.source,
            stemNodes,
            stemBus,
            eqHigh: null,
            eqMid: null,
            eqLow: null,
            volume,
            gain
          })
          continue
        }

        const audioBuffer = entry.audioRef?.audioBuffer
        if (!audioBuffer) continue

        const eqLow = offlineCtx.createBiquadFilter()
        eqLow.type = 'lowshelf'
        eqLow.frequency.value = 220

        const eqMid = offlineCtx.createBiquadFilter()
        eqMid.type = 'peaking'
        eqMid.frequency.value = 1000
        eqMid.Q.value = 0.9

        const eqHigh = offlineCtx.createBiquadFilter()
        eqHigh.type = 'highshelf'
        eqHigh.frequency.value = 3200

        const volume = offlineCtx.createGain()
        const gain = offlineCtx.createGain()
        const initialTimelineSec = timelineOriginSec
        const initialLocalSec = Math.max(0, initialTimelineSec - entry.startSec)
        eqHigh.gain.value = resolveEntryEqDbValue(entry, 'high', initialLocalSec)
        eqMid.gain.value = resolveEntryEqDbValue(entry, 'mid', initialLocalSec)
        eqLow.gain.value = resolveEntryEqDbValue(entry, 'low', initialLocalSec)
        volume.gain.value = resolveEntryEnvelopeValue(entry, 'volume', initialLocalSec)
        gain.gain.value = resolveEntryEnvelopeValue(entry, 'gain', initialLocalSec)

        eqLow.connect(eqMid)
        eqMid.connect(eqHigh)
        eqHigh.connect(volume)
        volume.connect(gain)
        gain.connect(offlineCtx.destination)

        const node: TrackGraphNode = {
          trackId: entry.trackId,
          entry,
          source: null as unknown as TransportPlayableSource,
          stemNodes: [],
          stemBus: null,
          eqHigh,
          eqMid,
          eqLow,
          volume,
          gain
        }

        if (entry.masterTempo) {
          const source = createDeferredSource(
            entry,
            audioBuffer,
            eqLow,
            entry.trackId,
            (attached) => {
              node.source = attached
            }
          )
          node.source = source
        } else {
          const source = await createImmediateSource(entry, audioBuffer)
          source.playbackRate.value = entry.tempoRatio
          source.connect(eqLow)
          await source.start(
            Math.max(0, entry.startSec - timelineOriginSec),
            resolveStartOffset(entry, source)
          )
          source.stop(
            Math.max(0, entry.startSec - timelineOriginSec) +
              Math.max(0.02, Number(entry.duration) || 0) +
              0.02
          )
          node.source = source
        }

        nodes.push(node)
      }
    } catch (error) {
      for (const source of createdSources) {
        try {
          source.disconnect()
        } catch {}
      }
      throw error
    }
    return { nodes, deferred }
  }

  const disposeOutputTrackNodes = (nodes: TrackGraphNode[]) => {
    const disposedSources = new Set<TransportPlayableSource>()
    for (const node of nodes) {
      const sources = node.stemNodes.length
        ? node.stemNodes.map((stemNode) => stemNode.source)
        : [node.source]
      for (const source of sources) {
        if (!source || disposedSources.has(source)) continue
        disposedSources.add(source)
        try {
          source.disconnect()
        } catch {}
      }
    }
  }

  const renderMixtapeOutputWav = async (options?: {
    onProgress?: (payload: MixtapeOutputProgressPayload) => void
    shouldAbort?: () => boolean
  }): Promise<MixtapeRenderedWavResult> => {
    const shouldAbort = options?.shouldAbort
    const emitProgress = (payload: MixtapeOutputProgressPayload) => {
      options?.onProgress?.(payload)
    }
    emitProgress({
      stageKey: 'mixtape.outputProgressPreparing',
      done: PROGRESS_PREPARE,
      total: 100,
      percent: PROGRESS_PREPARE
    })

    const plan = buildTransportEntries()
    const entries = plan.entries as RenderTransportEntry[]
    if (!entries.length) {
      throw new Error(t('mixtape.outputNoTracks'))
    }
    if (plan.missingDurationCount > 0) {
      throw new Error(t('mixtape.transportMissingDuration', { count: plan.missingDurationCount }))
    }
    if (isStemMixMode() && plan.stemNotReadyCount > 0) {
      throw new Error(t('mixtape.stemNotReadyForExport', { count: plan.stemNotReadyCount }))
    }
    if (isStemMixMode() && plan.missingStemAssetCount > 0) {
      throw new Error(t('mixtape.stemNotReadyForExport', { count: plan.missingStemAssetCount }))
    }

    // 进度条各段宽度按「预估耗时」分配，不再写死常数。这里只有解码前已知的信息：
    // 时间线总长、轨道数、worker 数；曲线节点数要等建图后才知道，先按轨道总数取上界，
    // 多估一点只会让曲线段略宽，不会让进度条倒退。
    const estimatedTimelineSec = entries.reduce(
      (max, entry) => Math.max(max, (Number(entry.startSec) || 0) + (Number(entry.duration) || 0)),
      0
    )
    let progressPlan = buildMixtapeOutputProgressPlan(
      estimateMixtapeOutputStageMs({
        durationSec: estimatedTimelineSec,
        trackCount: entries.length,
        curveTrackCount: entries.length,
        workerCount: resolveStretchWorkerCount(entries.length)
      }),
      { start: PROGRESS_DECODE_START, end: PROGRESS_ENCODE_END }
    )

    const decodeQueue: TransportEntry[] = []
    const requiredStemIds = resolveStemIds()
    if (isStemMixMode()) {
      for (const entry of entries) {
        let needsDecode = false
        for (const stemId of requiredStemIds) {
          const stemAudio = entry.stemAudioById?.[stemId]
          if (!stemAudio) continue
          const cached = readTransportBufferCache(stemAudio.filePath)
          if (cached) {
            stemAudio.audioBuffer = cached
            continue
          }
          needsDecode = true
        }
        if (needsDecode) {
          decodeQueue.push(entry)
        }
      }
    } else {
      for (const entry of entries) {
        const audioRef = entry.audioRef
        if (!audioRef) continue
        const cached = readTransportBufferCache(audioRef.filePath)
        if (cached) {
          audioRef.audioBuffer = cached
          continue
        }
        decodeQueue.push(entry)
      }
    }

    const decodeTotal = Math.max(1, decodeQueue.length)
    emitProgress({
      stageKey: 'mixtape.outputProgressDecoding',
      done: 0,
      total: decodeTotal,
      percent: progressPlan.decode.start
    })
    if (decodeQueue.length > 0) {
      let decodeDone = 0
      const workerCount = Math.max(1, Math.min(3, decodeQueue.length))
      let cursor = 0
      let failCount = 0
      const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
          const currentIndex = cursor
          cursor += 1
          if (currentIndex >= decodeQueue.length) return
          const entry = decodeQueue[currentIndex]
          try {
            await ensureDecodedTransportEntry(entry)
          } catch (error) {
            console.error('[mixtape-output] decode failed:', entry.filePath, error)
            failCount += 1
          } finally {
            decodeDone += 1
            emitProgress({
              stageKey: 'mixtape.outputProgressDecoding',
              done: decodeDone,
              total: decodeTotal,
              percent: Math.round(
                progressPlan.decode.start +
                  (decodeDone / decodeTotal) * (progressPlan.decode.end - progressPlan.decode.start)
              )
            })
          }
        }
      })
      await Promise.all(workers)
      if (failCount > 0) {
        throw new Error(t('mixtape.transportDecodeFailed', { count: failCount }))
      }
    }

    if (isStemMixMode()) {
      for (const entry of entries) {
        const allDecoded = requiredStemIds.every(
          (stemId) => !!entry.stemAudioById?.[stemId]?.audioBuffer
        )
        if (!allDecoded) {
          throw new Error(t('mixtape.transportDecodeFailed', { count: 1 }))
        }
      }
    } else {
      for (const entry of entries) {
        if (!entry.audioRef?.audioBuffer) {
          throw new Error(t('mixtape.transportDecodeFailed', { count: 1 }))
        }
      }
    }

    const playableEntries = entries.filter((entry) =>
      isStemMixMode()
        ? requiredStemIds.every((stemId) => !!entry.stemAudioById?.[stemId]?.audioBuffer)
        : Boolean(entry.audioRef?.audioBuffer)
    )
    const timelineOriginSec = playableEntries.reduce(
      (min, entry) => Math.min(min, Number(entry.startSec) || 0),
      0
    )
    const durationSec = playableEntries.reduce(
      (max, entry) => Math.max(max, entry.startSec + entry.duration - timelineOriginSec),
      0
    )
    if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error(t('mixtape.transportNoPlayableTracks'))
    }

    const sampleRate = resolveOutputSampleRate(playableEntries)
    const outputChannels = resolveOutputChannels(playableEntries)
    const frameCount = Math.max(1, Math.ceil(durationSec * sampleRate))
    const offlineCtx = new OfflineAudioContext(outputChannels, frameCount, sampleRate)
    const playableCtx = offlineCtx as TransportPlayableAudioContext
    let nodes: TrackGraphNode[] = []
    let deferred: DeferredOutputSource[] = []
    try {
      const graph = await buildOutputTrackNodes(offlineCtx, playableEntries, timelineOriginSec)
      nodes = graph.nodes
      deferred = graph.deferred
      // 建图后才知道真正要走 Worker 池的轨道数、以及真实的 render 总长，用它们重算
      // 剩余阶段的宽度。解码段已经走完，所以新区间从它的右端开始接。
      progressPlan = buildMixtapeOutputProgressPlan(
        estimateMixtapeOutputStageMs({
          durationSec,
          trackCount: playableEntries.length,
          curveTrackCount: deferred.length,
          workerCount: resolveStretchWorkerCount(deferred.length)
        }),
        { start: progressPlan.decode.end, end: PROGRESS_ENCODE_END }
      )
    } catch (error) {
      disposeOutputTrackNodes(nodes)
      console.error('[mixtape-output] track graph initialisation failed, export aborted', error)
      throw new Error(t('mixtape.transportPlaybackInitializeFailed'))
    }

    try {
      throwIfAborted(shouldAbort)
      emitProgress({
        stageKey: 'mixtape.outputProgressScheduling',
        done: 0,
        total: 100,
        percent: progressPlan.schedule.start
      })
      await scheduleOfflineAutomation({
        nodes,
        durationSec,
        timelineOriginSec,
        offlineCtx,
        emitProgress,
        progressStart: progressPlan.schedule.start,
        progressEnd: progressPlan.schedule.end,
        shouldAbort
      })

      await renderMixtapeDeferredSources({
        offlineCtx,
        playableCtx,
        frameCount,
        outputSampleRate: sampleRate,
        nodes,
        deferred,
        emitProgress,
        shouldAbort,
        clampNumber,
        progressBand: {
          start: progressPlan.curve.start,
          curveEnd: progressPlan.stretch.start,
          end: progressPlan.stretch.end
        }
      })

      const renderSecondsTotal = Math.max(1, Math.round(durationSec))
      emitProgress({
        stageKey: 'mixtape.outputProgressRendering',
        done: 0,
        total: renderSecondsTotal,
        percent: progressPlan.render.start
      })
      // startRendering() 本身不提供进度，用 suspend 在时间线上打点，渲染推进到每个点就回报一次真实进度。
      // 取消时不再 resume：离线渲染线程会停在挂起点，立刻把 CPU 让出来，不必等整段混音跑完。
      const abortHandle: { reject: ((error: Error) => void) | null } = { reject: null }
      const abortPromise = new Promise<never>((_resolve, reject) => {
        abortHandle.reject = reject
      })
      const abandonRender = () => {
        abortHandle.reject?.(new Error('mixtape.outputCancelled'))
        abortHandle.reject = null
      }
      // 渲染线程一次要跑几十秒音频才到下一个打点，靠打点感知取消太慢，单独轮询让取消即时生效。
      const abortPoller =
        typeof window !== 'undefined' && shouldAbort
          ? window.setInterval(() => {
              if (shouldAbort()) abandonRender()
            }, 200)
          : null
      if (typeof offlineCtx.suspend === 'function') {
        const checkpointCount = resolveRenderCheckpointCount(durationSec)
        for (let index = 1; index <= checkpointCount; index += 1) {
          const checkpointSec = (durationSec * index) / (checkpointCount + 1)
          if (!(checkpointSec > 0) || checkpointSec >= durationSec) continue
          void offlineCtx
            .suspend(checkpointSec)
            .then(() => {
              if (shouldAbort?.()) {
                abandonRender()
                return
              }
              const ratio = clampNumber(checkpointSec / durationSec, 0, 1)
              emitProgress({
                stageKey: 'mixtape.outputProgressRendering',
                done: Math.min(renderSecondsTotal, Math.round(checkpointSec)),
                total: renderSecondsTotal,
                percent: Math.round(
                  progressPlan.render.start +
                    ratio * (progressPlan.render.end - progressPlan.render.start)
                )
              })
              return offlineCtx.resume()
            })
            .catch(() => {})
        }
      }
      let renderedBuffer: AudioBuffer | null = null
      try {
        renderedBuffer = await Promise.race([offlineCtx.startRendering(), abortPromise])
      } finally {
        if (abortPoller !== null) window.clearInterval(abortPoller)
      }
      if (shouldAbort?.()) {
        throw new Error('mixtape.outputCancelled')
      }
      if (!renderedBuffer) {
        throw new Error(t('mixtape.outputProgressFailed'))
      }
      emitProgress({
        stageKey: 'mixtape.outputProgressRendering',
        done: renderSecondsTotal,
        total: renderSecondsTotal,
        percent: progressPlan.render.end
      })

      emitProgress({
        stageKey: 'mixtape.outputProgressEncoding',
        done: progressPlan.encode.start,
        total: 100,
        percent: progressPlan.encode.start
      })
      const lastEncodePercentRef = { value: progressPlan.encode.start }
      const wavBytes = await encodeAudioBufferToWav(renderedBuffer, outputChannels, {
        onProgress: (doneFrames, totalFrames) =>
          emitEncodeProgress(
            emitProgress,
            doneFrames,
            totalFrames,
            lastEncodePercentRef,
            progressPlan.encode
          ),
        shouldAbort
      })
      emitProgress({
        stageKey: 'mixtape.outputProgressEncoding',
        done: Math.max(progressPlan.encode.end, lastEncodePercentRef.value),
        total: 100,
        percent: Math.max(progressPlan.encode.end, lastEncodePercentRef.value)
      })

      return {
        wavBytes,
        durationSec,
        sampleRate: renderedBuffer.sampleRate,
        channels: outputChannels,
        trackCount: new Set(playableEntries.map((entry) => entry.trackId)).size
      }
    } finally {
      disposeOutputTrackNodes(nodes)
    }
  }

  return {
    renderMixtapeOutputWav
  }
}
