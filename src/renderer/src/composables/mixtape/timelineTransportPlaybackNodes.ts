import {
  createTransportBufferSource,
  createTransportSequencedBufferSource,
  type TransportPlayableSource
} from './timelineTransportPlayableSource'
import { createTransportR3Source } from './timelineTransportR3Source'
import { resolveTransportEntryPlaybackRate } from './timelineTransportPlaybackRate'
import type {
  TransportEntry,
  TransportStemAudioRef,
  TransportStemId
} from './timelineTransportAudioData'

export type TrackStemGraphNode = {
  stemId: TransportStemId
  source: TransportPlayableSource
  stemGain: GainNode
}

export type TrackGraphNode = {
  trackId: string
  entry: TransportEntry
  source: TransportPlayableSource
  stemNodes: TrackStemGraphNode[]
  stemBus: GainNode | null
  eqHigh: BiquadFilterNode | null
  eqMid: BiquadFilterNode | null
  eqLow: BiquadFilterNode | null
  volume: GainNode
  gain: GainNode
}

export type TransportPlaybackSourceMode = 'buffer' | 'r3' | 'sequenced-buffer' | 'sequenced-r3'

export type PreparedTransportTrackGraphNode = {
  start: (whenSec: number) => Promise<void>
  dispose: () => void
}

type PrepareTransportTrackGraphNodeParams = {
  entry: TransportEntry
  offsetTimelineSec: number
  offsetPlanSec: number
  offsetSourceSec: number
  transportGraphNodes: TrackGraphNode[]
  isStemMixMode: () => boolean
  resolveStemIdsForMode: () => TransportStemId[]
  ensureTransportAudioContext: (sampleRate?: number) => AudioContext
  resolveTransportOutputNode: (ctx: AudioContext) => AudioNode
  resolvePlaybackSourceMode: (entry: TransportEntry) => TransportPlaybackSourceMode
  resolveEntryEnvelopeValue: (
    entry: TransportEntry,
    param: 'volume' | 'gain' | TransportStemId,
    timelineOffsetSec: number
  ) => number
  resolveEntryEqDbValue: (
    entry: TransportEntry,
    param: 'high' | 'mid' | 'low',
    timelineOffsetSec: number
  ) => number
}

const resolveSourceStartOffset = (params: {
  source: TransportPlayableSource
  entry: TransportEntry
  bufferDuration: number
  offsetPlanSec: number
  offsetSourceSec: number
}) => {
  const { source, entry, bufferDuration, offsetPlanSec, offsetSourceSec } = params
  const baseOffsetSec = source.startOffsetKind === 'plan' ? offsetPlanSec : offsetSourceSec
  const offsetDuration =
    source.startOffsetKind === 'plan'
      ? Math.max(0, Number(entry.playbackSequence?.totalPlanSec) || 0)
      : Math.max(0, bufferDuration)
  return Math.max(0, Math.min(baseOffsetSec, Math.max(0, offsetDuration - 0.02)))
}

const resolveInitialTempoRatio = (entry: TransportEntry, offsetTimelineSec: number) => {
  const localStartSec = Math.max(0, Number(entry.localStartSec) || 0)
  const localSec = localStartSec + Math.max(0, Number(offsetTimelineSec) || 0)
  return resolveTransportEntryPlaybackRate(entry, localSec)
}

const createPlaybackSource = async (
  ctx: AudioContext,
  buffer: AudioBuffer,
  entry: TransportEntry,
  mode: TransportPlaybackSourceMode
) => {
  if (mode === 'sequenced-r3') {
    return await createTransportR3Source(ctx, buffer, entry.playbackSequence)
  }
  if (mode === 'r3') {
    return await createTransportR3Source(ctx, buffer)
  }
  if (mode === 'sequenced-buffer' && entry.playbackSequence) {
    return createTransportSequencedBufferSource(ctx, buffer, entry.playbackSequence)
  }
  return createTransportBufferSource(ctx, buffer)
}

const disconnectSource = (source: TransportPlayableSource) => {
  try {
    source.disconnect()
  } catch {}
}

export const prepareTransportTrackGraphNode = async (
  params: PrepareTransportTrackGraphNodeParams
): Promise<PreparedTransportTrackGraphNode | null> => {
  const {
    entry,
    offsetTimelineSec,
    offsetPlanSec,
    offsetSourceSec,
    transportGraphNodes,
    isStemMixMode,
    resolveStemIdsForMode,
    ensureTransportAudioContext,
    resolveTransportOutputNode,
    resolvePlaybackSourceMode,
    resolveEntryEnvelopeValue,
    resolveEntryEqDbValue
  } = params
  const initialTempoRatio = resolveInitialTempoRatio(entry, offsetTimelineSec)
  const mode = resolvePlaybackSourceMode(entry)

  if (isStemMixMode()) {
    const stemAudios = resolveStemIdsForMode()
      .map((stemId) => entry.stemAudioById?.[stemId])
      .filter((item): item is TransportStemAudioRef => !!item?.audioBuffer)
    if (!stemAudios.length) return null

    const sampleRate = Number(stemAudios[0]?.audioBuffer?.sampleRate || 0) || undefined
    const ctx = ensureTransportAudioContext(sampleRate)
    const stemBus = ctx.createGain()
    const volume = ctx.createGain()
    const gain = ctx.createGain()
    volume.gain.value = resolveEntryEnvelopeValue(entry, 'volume', offsetTimelineSec)
    gain.gain.value = resolveEntryEnvelopeValue(entry, 'gain', offsetTimelineSec)
    stemBus.connect(volume)
    volume.connect(gain)
    gain.connect(resolveTransportOutputNode(ctx))

    const stemNodes: TrackStemGraphNode[] = []
    try {
      for (const stemAudio of stemAudios) {
        const source = await createPlaybackSource(
          ctx,
          stemAudio.audioBuffer as AudioBuffer,
          entry,
          mode
        )
        source.playbackRate.value = initialTempoRatio
        try {
          await source.prepareStart?.(
            resolveSourceStartOffset({
              source,
              entry,
              bufferDuration: Number(source.buffer?.duration || 0),
              offsetPlanSec,
              offsetSourceSec
            })
          )
        } catch (error) {
          disconnectSource(source)
          throw error
        }
        const stemGain = ctx.createGain()
        stemGain.gain.value = resolveEntryEnvelopeValue(entry, stemAudio.stemId, offsetTimelineSec)
        source.connect(stemGain)
        stemGain.connect(stemBus)
        stemNodes.push({ stemId: stemAudio.stemId, source, stemGain })
      }
    } catch (error) {
      for (const stemNode of stemNodes) {
        disconnectSource(stemNode.source)
        stemNode.stemGain.disconnect()
      }
      stemBus.disconnect()
      volume.disconnect()
      gain.disconnect()
      throw error
    }

    const primaryStemNode = stemNodes[0]
    if (!primaryStemNode) return null
    const graphNode: TrackGraphNode = {
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
    }
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      const index = transportGraphNodes.indexOf(graphNode)
      if (index >= 0) transportGraphNodes.splice(index, 1)
      for (const stemNode of stemNodes) {
        disconnectSource(stemNode.source)
        stemNode.stemGain.disconnect()
      }
      stemBus.disconnect()
      volume.disconnect()
      gain.disconnect()
    }
    primaryStemNode.source.onended = dispose

    return {
      dispose,
      async start(whenSec: number) {
        if (disposed) return
        const safeWhen = Math.max(ctx.currentTime, whenSec)
        const stopAt = safeWhen + Math.max(0.02, Number(entry.duration) - offsetTimelineSec) + 0.02
        transportGraphNodes.push(graphNode)
        const scheduled: Array<void | Promise<void>> = []
        for (const stemNode of stemNodes) {
          const safeOffset = resolveSourceStartOffset({
            source: stemNode.source,
            entry,
            bufferDuration: Number(stemNode.source.buffer?.duration || 0),
            offsetPlanSec,
            offsetSourceSec
          })
          stemNode.source.playbackRate.setTargetAtTime(initialTempoRatio, safeWhen, 0.0001)
          scheduled.push(stemNode.source.start(safeWhen, safeOffset))
          stemNode.source.stop(stopAt)
        }
        await Promise.all(scheduled)
      }
    }
  }

  const audioBuffer = entry.audioRef?.audioBuffer
  if (!audioBuffer) return null
  const ctx = ensureTransportAudioContext(audioBuffer.sampleRate)
  const source = await createPlaybackSource(ctx, audioBuffer, entry, mode)
  source.playbackRate.value = initialTempoRatio
  try {
    await source.prepareStart?.(
      resolveSourceStartOffset({
        source,
        entry,
        bufferDuration: audioBuffer.duration,
        offsetPlanSec,
        offsetSourceSec
      })
    )
  } catch (error) {
    disconnectSource(source)
    throw error
  }

  const eqLow = ctx.createBiquadFilter()
  eqLow.type = 'lowshelf'
  eqLow.frequency.value = 220
  const eqMid = ctx.createBiquadFilter()
  eqMid.type = 'peaking'
  eqMid.frequency.value = 1000
  eqMid.Q.value = 0.9
  const eqHigh = ctx.createBiquadFilter()
  eqHigh.type = 'highshelf'
  eqHigh.frequency.value = 3200
  const volume = ctx.createGain()
  const gain = ctx.createGain()
  eqHigh.gain.value = resolveEntryEqDbValue(entry, 'high', offsetTimelineSec)
  eqMid.gain.value = resolveEntryEqDbValue(entry, 'mid', offsetTimelineSec)
  eqLow.gain.value = resolveEntryEqDbValue(entry, 'low', offsetTimelineSec)
  volume.gain.value = resolveEntryEnvelopeValue(entry, 'volume', offsetTimelineSec)
  gain.gain.value = resolveEntryEnvelopeValue(entry, 'gain', offsetTimelineSec)
  source.connect(eqLow)
  eqLow.connect(eqMid)
  eqMid.connect(eqHigh)
  eqHigh.connect(volume)
  volume.connect(gain)
  gain.connect(resolveTransportOutputNode(ctx))

  const graphNode: TrackGraphNode = {
    trackId: entry.trackId,
    entry,
    source,
    stemNodes: [],
    stemBus: null,
    eqHigh,
    eqMid,
    eqLow,
    volume,
    gain
  }
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    const index = transportGraphNodes.indexOf(graphNode)
    if (index >= 0) transportGraphNodes.splice(index, 1)
    disconnectSource(source)
    eqLow.disconnect()
    eqMid.disconnect()
    eqHigh.disconnect()
    volume.disconnect()
    gain.disconnect()
  }
  source.onended = dispose

  return {
    dispose,
    async start(whenSec: number) {
      if (disposed) return
      const safeWhen = Math.max(ctx.currentTime, whenSec)
      const safeOffset = resolveSourceStartOffset({
        source,
        entry,
        bufferDuration: audioBuffer.duration,
        offsetPlanSec,
        offsetSourceSec
      })
      source.playbackRate.setTargetAtTime(initialTempoRatio, safeWhen, 0.0001)
      const scheduled = source.start(safeWhen, safeOffset)
      source.stop(safeWhen + Math.max(0.02, Number(entry.duration) - offsetTimelineSec) + 0.02)
      transportGraphNodes.push(graphNode)
      await scheduled
    }
  }
}
