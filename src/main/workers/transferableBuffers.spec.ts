import { describe, expect, it } from 'vitest'
import { collectTransferableArrayBuffers } from './transferableBuffers'

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
})
