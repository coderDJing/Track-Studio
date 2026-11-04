import { RubberBandNode, RubberBandOption } from '@ainsej/rubberband-wasm'
import r3WasmDataUrl from '@ainsej/rubberband-wasm/dist/rubberband.wasm?inline'
import type {
  TransportPlayableAudioContext,
  TransportPlayableSource
} from './timelineTransportPlayableSource'
import type { TransportPlaybackSequence } from './timelineTransportPlaybackSequence'
import { createTransportPlanBuffer } from './timelineTransportR3Plan'

const R3_MW_OPTIONS =
  RubberBandOption.RubberBandOptionProcessRealTime |
  RubberBandOption.RubberBandOptionChannelsTogether |
  RubberBandOption.RubberBandOptionEngineFiner
const clampTempo = (value: number) => Math.max(0.25, Math.min(4, Number(value) || 1))

let r3WasmBinaryPromise: Promise<Uint8Array> | null = null

const loadR3WasmBinary = async () => {
  if (!r3WasmBinaryPromise) {
    r3WasmBinaryPromise = fetch(r3WasmDataUrl).then(async (response) => {
      if (!response.ok) {
        throw new Error(`R3 WASM load failed: ${response.status}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    })
  }
  return await r3WasmBinaryPromise
}

export const createTransportR3Source = async (
  audioCtx: TransportPlayableAudioContext,
  buffer: AudioBuffer,
  sequence?: TransportPlaybackSequence
): Promise<TransportPlayableSource> => {
  const planBuffer = createTransportPlanBuffer(audioCtx, buffer, sequence)
  const channels = Math.max(1, Math.min(2, planBuffer.numberOfChannels || 1))
  const wasmBinary = await loadR3WasmBinary()
  const processorUrl = new URL('../../workers/mixtapeTransportR3.worklet.js', import.meta.url).href
  const node = await RubberBandNode.create(audioCtx, {
    processorUrl,
    wasmBinary: wasmBinary.slice(),
    channelCount: channels,
    options: R3_MW_OPTIONS
  })
  node.setBuffer(planBuffer)
  node.setPitchScale(1)

  const tempoParam = node.parameters.get('tempo')
  if (!tempoParam) {
    node.close()
    throw new Error('R3 tempo AudioParam is unavailable')
  }

  let tempoValue = 1
  const playbackRate = {
    get value() {
      return tempoValue
    },
    set value(value: number) {
      tempoValue = clampTempo(value)
      tempoParam.value = tempoValue
    },
    setTargetAtTime(value: number, startTime: number, timeConstant: number) {
      tempoValue = clampTempo(value)
      tempoParam.setTargetAtTime(tempoValue, startTime, timeConstant)
    }
  }

  let endedHandler: (() => void) | null = null
  let latestPositionSec: number | null = null
  let preparedOffsetSec: number | null = null
  node.onended = () => endedHandler?.()
  node.onposition = (seconds) => {
    latestPositionSec = Math.max(0, Number(seconds) || 0)
  }

  const waitForWorkletMessage = (expected: 'prepared' | 'scheduled', send: () => void) => {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout)
        node.port.removeEventListener('message', onMessage)
      }
      const onMessage = (event: MessageEvent<{ type?: string; error?: string }>) => {
        if (event.data?.type === expected) {
          cleanup()
          resolve()
        } else if (event.data?.type === 'error') {
          cleanup()
          reject(new Error(event.data.error || 'R3 preparation failed'))
        }
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`R3 ${expected} timed out`))
      }, 10000)
      node.port.addEventListener('message', onMessage)
      try {
        send()
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }

  return {
    buffer: planBuffer,
    startOffsetKind: sequence && sequence.segments.length > 1 ? 'plan' : 'source',
    // Worklet removes the stretcher's start delay before emitting audio. The ring
    // buffer is look-ahead capacity, not an extra delay on the scheduled output.
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
      endedHandler = null
      node.onended = null
      node.onposition = null
      node.close()
    },
    start(when?: number, offset?: number) {
      const startTimeSec = Number.isFinite(Number(when))
        ? Math.max(audioCtx.currentTime, Number(when))
        : audioCtx.currentTime
      const safeOffset = Math.max(0, Number(offset) || 0)
      latestPositionSec = safeOffset
      node.setTempo(playbackRate.value)
      if (preparedOffsetSec !== safeOffset) node.seek(safeOffset)
      preparedOffsetSec = null
      return waitForWorkletMessage('scheduled', () =>
        node.port.postMessage({ type: 'play', startTimeSec })
      )
    },
    stop(when?: number) {
      const stopTimeSec =
        Number.isFinite(Number(when)) && Number(when) > audioCtx.currentTime
          ? Number(when)
          : audioCtx.currentTime
      node.port.postMessage({ type: 'stop', stopTimeSec })
    },
    async prepareStart(offset: number) {
      const safeOffset = Math.max(0, Number(offset) || 0)
      await waitForWorkletMessage('prepared', () =>
        node.port.postMessage({ type: 'prepare', seconds: safeOffset, speed: tempoValue })
      )
      preparedOffsetSec = safeOffset
    }
  }
}
