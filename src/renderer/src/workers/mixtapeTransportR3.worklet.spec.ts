import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

type ProbeProcessor = {
  onMessage: (message: Record<string, unknown>) => Promise<void>
  process: (
    inputs: unknown[],
    outputs: Float32Array[][],
    parameters: { tempo: Float32Array }
  ) => void
}

// Render through the shipped WASM and worklet, including start-pad removal and scheduled starts.
// Run: npx vitest run src/renderer/src/workers/mixtapeTransportR3.worklet.spec.ts
const renderBeats = async (bpm: number, anchorSec: number, seconds = 35, offset = 0) => {
  const sampleRate = 44100
  const targetBpm = 126
  const speed = targetBpm / bpm
  let Processor: (new () => ProbeProcessor) | undefined
  const errors: unknown[] = []
  const messages: string[] = []
  const scope = {
    sampleRate,
    currentTime: 0,
    console,
    WebAssembly,
    Float32Array,
    Uint8Array,
    Int32Array,
    Math,
    AudioWorkletProcessor: class {
      port = {
        postMessage: (message: { type: string; error?: unknown }) => {
          messages.push(message.type)
          if (message.type === 'error') errors.push(message.error)
        }
      }
    },
    registerProcessor: (_name: string, constructor: new () => ProbeProcessor) => {
      Processor = constructor
    }
  }
  vm.createContext(scope)
  vm.runInContext(
    readFileSync('src/renderer/src/workers/mixtapeTransportR3.worklet.js', 'utf8'),
    scope
  )
  if (!Processor) throw new Error('R3 processor did not register')
  const processor = new Processor()
  await processor.onMessage({
    type: 'initialise',
    channels: 1,
    wasm: new Uint8Array(readFileSync('node_modules/@ainsej/rubberband-wasm/dist/rubberband.wasm')),
    options: 536870913
  })
  expect(errors).toEqual([])
  const source = new Float32Array(sampleRate * seconds)
  for (let beat = 0; anchorSec + (beat * 60) / bpm < seconds; beat++) {
    const start = Math.round((anchorSec + (beat * 60) / bpm) * sampleRate)
    if (start < 0) continue
    for (let frame = 0; frame < 400 && start + frame < source.length; frame++) {
      source[start + frame] = Math.exp(-frame / 60) * Math.cos(frame * 0.2)
    }
  }
  await processor.onMessage({ type: 'buffer', channels: [source], sampleRate })
  await processor.onMessage({ type: 'speed', value: speed })
  await processor.onMessage({ type: 'prepare', seconds: offset, speed })
  expect(messages).toContain('prepared')
  await processor.onMessage({ type: 'play', startTimeSec: 0.5 - anchorSec / speed })
  expect(messages).toContain('scheduled')
  const output = new Float32Array(Math.ceil((seconds / speed + 0.6) * sampleRate))
  const block = new Float32Array(128)
  const tempo = new Float32Array([speed])
  for (let frame = 0; frame < output.length; frame += 128) {
    scope.currentTime = frame / sampleRate
    processor.process([], [[block]], { tempo })
    output.set(block.subarray(0, Math.min(128, output.length - frame)), frame)
  }
  await processor.onMessage({ type: 'close' })
  const peaks: number[] = []
  let previous = -sampleRate
  for (let frame = 0; frame < output.length; frame++) {
    if (Math.abs(output[frame]) > 0.1 && frame - previous > sampleRate * 0.3) {
      peaks.push(frame / sampleRate)
      previous = frame
    }
  }
  return peaks
}

describe('R3 scheduled audio beat alignment', () => {
  it('does not restart a short prewarmed tail from the beginning', async () => {
    const peaks = await renderBeats(126, 0.2, 0.3, 0.25)
    // The only transient is at 0.2s, before the seek position.
    expect(peaks).toEqual([])
  })
  it('keeps aiSet-style 124/125 BPM grids aligned at 126 BPM through 32 seconds', async () => {
    const outgoing = await renderBeats(124, 0.00275)
    const incoming = await renderBeats(125, -0.0155)
    for (const beat of [1, 8, 32, 64]) {
      const expected = 0.5 + (beat * 60) / 126
      const nearest = (peaks: number[]) => Math.min(...peaks.map((sec) => Math.abs(sec - expected)))
      expect(nearest(outgoing)).toBeLessThan(0.001)
      expect(nearest(incoming)).toBeLessThan(0.001)
    }
  })
})
