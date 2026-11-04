import type { TransportPlaybackSequence } from './timelineTransportPlaybackSequence'

type TransportPlaybackRateControl = {
  value: number
  setTargetAtTime: (value: number, startTime: number, timeConstant: number) => void
}

export type TransportPlayableSource = {
  buffer: AudioBuffer | null
  startOffsetKind: 'source' | 'plan'
  resolveLatencySec: () => number
  resolvePlaybackPositionSec: () => number | null
  playbackRate: TransportPlaybackRateControl
  onended: (() => void) | null
  connect: (destination: AudioNode) => void
  disconnect: () => void
  start: (when?: number, offset?: number) => void | Promise<void>
  prepareStart?: (offset: number) => Promise<void>
  stop: (when?: number) => void
}

const SEQUENCER_WORKLET_NAME = 'mixtape-transport-sequencer'

export type TransportPlayableAudioContext = BaseAudioContext & {
  createBufferSource: () => AudioBufferSourceNode
  audioWorklet?: AudioWorklet
}

type SequencerWorkletMessage =
  | {
      type: 'position'
      frame?: number
    }
  | {
      type: 'ended'
    }

const sequencerModuleByContext = new WeakMap<TransportPlayableAudioContext, Promise<void>>()

const cloneBufferChannels = (buffer: AudioBuffer) => {
  const channels: Float32Array[] = []
  const outputChannels = Math.max(1, Math.min(2, buffer.numberOfChannels || 1))
  for (let channelIndex = 0; channelIndex < outputChannels; channelIndex += 1) {
    const sourceIndex = Math.min(buffer.numberOfChannels - 1, channelIndex)
    channels.push(new Float32Array(buffer.getChannelData(Math.max(0, sourceIndex))))
  }
  return channels
}

export const ensureTransportSequencerWorkletModule = async (
  audioCtx: TransportPlayableAudioContext
) => {
  if (!audioCtx.audioWorklet) {
    throw new Error('AudioWorklet is unavailable')
  }
  const existing = sequencerModuleByContext.get(audioCtx)
  if (existing) {
    await existing
    return
  }
  const moduleUrl = new URL('../../workers/mixtapeTransportSequencer.worklet.js', import.meta.url)
  const task = audioCtx.audioWorklet.addModule(moduleUrl.href)
  sequencerModuleByContext.set(audioCtx, task)
  await task
}

const postPlaybackSequenceToWorklet = (
  node: AudioWorkletNode,
  buffer: AudioBuffer,
  sequence: TransportPlaybackSequence
) => {
  const segments = sequence.segments
    .map((segment) => {
      const sourceStartFrame = Math.max(
        0,
        Math.floor((Number(segment.sourceStartSec) || 0) * buffer.sampleRate)
      )
      const sourceEndFrame = Math.max(
        sourceStartFrame,
        Math.ceil((Number(segment.sourceEndSec) || 0) * buffer.sampleRate)
      )
      return {
        sourceStartFrame,
        frameCount: Math.max(0, sourceEndFrame - sourceStartFrame)
      }
    })
    .filter((segment) => segment.frameCount > 0)
  node.port.postMessage({ type: 'set-sequence', segments })
}

export const createTransportBufferSource = (
  audioCtx: TransportPlayableAudioContext,
  buffer: AudioBuffer
): TransportPlayableSource => {
  const source = audioCtx.createBufferSource()
  source.buffer = buffer
  const playableSource = source as unknown as TransportPlayableSource
  playableSource.startOffsetKind = 'source'
  playableSource.resolveLatencySec = () => 0
  playableSource.resolvePlaybackPositionSec = () => null
  return playableSource
}

export const createTransportSequencedBufferSource = (
  audioCtx: TransportPlayableAudioContext,
  buffer: AudioBuffer,
  sequence: TransportPlaybackSequence
): TransportPlayableSource => {
  const outputChannels = Math.max(1, Math.min(2, buffer.numberOfChannels || 1))
  const node = new AudioWorkletNode(audioCtx, SEQUENCER_WORKLET_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [outputChannels]
  })
  const channels = cloneBufferChannels(buffer)
  node.port.postMessage(
    {
      type: 'set-source',
      channels,
      sampleRate: buffer.sampleRate,
      frameCount: buffer.length,
      outputChannels
    },
    channels.map((channel) => channel.buffer)
  )
  postPlaybackSequenceToWorklet(node, buffer, sequence)

  let endedHandler: (() => void) | null = null
  let latestPositionSec: number | null = null
  const playbackRate: TransportPlaybackRateControl = {
    value: 1,
    setTargetAtTime(value: number, startTime: number, timeConstant: number) {
      playbackRate.value = Number(value) || 1
      node.port.postMessage({
        type: 'set-rate',
        rate: playbackRate.value,
        startTimeSec: Number(startTime) || audioCtx.currentTime,
        timeConstant: Number(timeConstant) || 0.04
      })
    }
  }

  node.port.onmessage = (event: MessageEvent<SequencerWorkletMessage>) => {
    const data = event.data
    if (!data) return
    if (data.type === 'position') {
      latestPositionSec = Math.max(0, Number(data.frame) || 0) / buffer.sampleRate
      return
    }
    if (data.type === 'ended') endedHandler?.()
  }

  return {
    buffer,
    startOffsetKind: 'plan',
    resolveLatencySec: () => 0,
    resolvePlaybackPositionSec: () => latestPositionSec,
    playbackRate,
    get onended() {
      return endedHandler
    },
    set onended(handler: (() => void) | null) {
      endedHandler = typeof handler === 'function' ? handler : null
    },
    connect(destination: AudioNode) {
      node.connect(destination)
    },
    disconnect() {
      try {
        node.port.postMessage({ type: 'dispose' })
      } catch {}
      node.port.onmessage = null
      node.port.close()
      node.disconnect()
    },
    start(when?: number, offset?: number) {
      const startTimeSec = Number.isFinite(Number(when))
        ? Math.max(audioCtx.currentTime, Number(when))
        : audioCtx.currentTime
      const safeOffset = Math.max(0, Number(offset) || 0)
      latestPositionSec = safeOffset
      node.port.postMessage({
        type: 'start',
        startTimeSec,
        startFrame: safeOffset * buffer.sampleRate,
        rate: playbackRate.value
      })
    },
    stop(when?: number) {
      const stopTimeSec =
        Number.isFinite(Number(when)) && Number(when) > audioCtx.currentTime
          ? Number(when)
          : audioCtx.currentTime
      node.port.postMessage({ type: 'stop', stopTimeSec })
    }
  }
}
