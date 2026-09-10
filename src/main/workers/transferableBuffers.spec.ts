import { describe, expect, it } from 'vitest'
import {
  collectTransferableArrayBuffers,
  copyBuffersToTransferableViews
} from './transferableBuffers'

const makeBufferBand = () => ({
  left: Buffer.from([1, 2]),
  right: Buffer.from([3, 4]),
  peakLeft: Buffer.from([5, 6]),
  peakRight: Buffer.from([7, 8])
})

describe('collectTransferableArrayBuffers', () => {
  it('collects nested typed-array buffers once', () => {
    const shared = new ArrayBuffer(16)
    const other = new Uint8Array(8)
    const result = collectTransferableArrayBuffers({
      bands: [new Uint8Array(shared), new Uint8Array(shared, 4, 4)],
      detail: { height: other }
    })

    expect(result).toHaveLength(2)
    expect(result).toContain(shared)
    expect(result).toContain(other.buffer)
  })

  it('skips pooled Node buffers and handles cycles', () => {
    const sharedWithBuffer = new ArrayBuffer(8)
    const cyclic: Record<string, unknown> = {
      typed: new Uint8Array(sharedWithBuffer),
      payload: Buffer.from(sharedWithBuffer)
    }
    cyclic.self = cyclic

    expect(collectTransferableArrayBuffers(cyclic)).toEqual([])
  })

  it('copies napi waveform Buffers into transferable Uint8Arrays', () => {
    const waveform = copyBuffersToTransferableViews({
      duration: 1,
      sampleRate: 44_100,
      step: 1,
      bands: {
        low: makeBufferBand(),
        mid: makeBufferBand(),
        high: makeBufferBand(),
        all: makeBufferBand()
      }
    })

    expect(waveform).not.toBeNull()
    expect(Buffer.isBuffer(waveform.bands.low.left)).toBe(false)
    expect(waveform.bands.low.left).toEqual(new Uint8Array([1, 2]))
    expect(collectTransferableArrayBuffers(waveform)).toHaveLength(16)
  })

  it('copies PCM and raw waveform Buffers without mutating the source payload', () => {
    const source = {
      pcmData: Buffer.from([1, 2, 3, 4]),
      rawWaveformData: { minLeft: Buffer.from([5, 6]) }
    }
    const transferable = copyBuffersToTransferableViews(source)

    expect(Buffer.isBuffer(source.pcmData)).toBe(true)
    expect(Buffer.isBuffer(transferable.pcmData)).toBe(false)
    expect(transferable.pcmData).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(collectTransferableArrayBuffers(transferable)).toHaveLength(2)
  })
})
