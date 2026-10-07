// Native rekordbox 7 .3EX samples are MessagePack embeddings, not PMAI tags.
// They are independent of exported cue/grid tags and must remain byte-identical.
// Only this fully checked observed schema can be preserved during a write.
class EmbeddingReader {
  private offset = 0

  constructor(private readonly bytes: Buffer) {}

  private take(size: number): Buffer {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.bytes.length - this.offset)
      throw new Error('Truncated embedding')
    const result = this.bytes.subarray(this.offset, this.offset + size)
    this.offset += size
    return result
  }

  private byte(): number {
    return this.take(1)[0]
  }

  private length(fixedBase: number, fixedMask: number, type16: number, type32: number): number {
    const marker = this.byte()
    if ((marker & fixedMask) === fixedBase) return marker & ~fixedMask
    if (marker === type16) return this.take(2).readUInt16BE()
    if (marker === type32) return this.take(4).readUInt32BE()
    throw new Error('Unsupported embedding container')
  }

  mapLength(): number {
    return this.length(0x80, 0xf0, 0xde, 0xdf)
  }

  arrayLength(): number {
    return this.length(0x90, 0xf0, 0xdc, 0xdd)
  }

  string(): string {
    const marker = this.byte()
    let length: number
    if ((marker & 0xe0) === 0xa0) length = marker & 0x1f
    else if (marker === 0xd9) length = this.byte()
    else if (marker === 0xda) length = this.take(2).readUInt16BE()
    else if (marker === 0xdb) length = this.take(4).readUInt32BE()
    else throw new Error('Unsupported embedding string')
    if (length > 32) throw new Error('Embedding string too long')
    const data = this.take(length)
    if (data.some((byte) => byte < 0x20 || byte > 0x7e))
      throw new Error('Unsupported embedding string characters')
    return data.toString('ascii')
  }

  float(): number {
    const marker = this.byte()
    const value =
      marker === 0xca
        ? this.take(4).readFloatBE()
        : marker === 0xcb
          ? this.take(8).readDoubleBE()
          : NaN
    if (!Number.isFinite(value)) throw new Error('Invalid embedding float')
    return value
  }

  unsignedInteger(): number {
    const marker = this.byte()
    let value: number
    if (marker <= 0x7f) value = marker
    else if (marker === 0xcc) value = this.byte()
    else if (marker === 0xcd) value = this.take(2).readUInt16BE()
    else if (marker === 0xce) value = this.take(4).readUInt32BE()
    else if (marker === 0xcf) value = Number(this.take(8).readBigUInt64BE())
    else if (marker === 0xd0) value = this.take(1).readInt8()
    else if (marker === 0xd1) value = this.take(2).readInt16BE()
    else if (marker === 0xd2) value = this.take(4).readInt32BE()
    else if (marker === 0xd3) value = Number(this.take(8).readBigInt64BE())
    else throw new Error('Invalid embedding integer')
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid embedding integer')
    return value
  }

  vector(size: number): void {
    if (this.arrayLength() !== size) throw new Error('Unsupported embedding vector size')
    for (let index = 0; index < size; index++) this.float()
  }

  finished(): boolean {
    return this.offset === this.bytes.length
  }
}

/** Recognize the observed embedding-only schema; never alter or serialize its bytes. */
export const isKnownUsbThreeEx = (bytes: Buffer): boolean => {
  if (bytes.length > 2 * 1024 * 1024) return false
  try {
    const reader = new EmbeddingReader(bytes)
    if (reader.mapLength() !== 1 || reader.string() !== 'embedding' || reader.mapLength() !== 11)
      return false
    const seen = new Set<string>()
    for (let index = 0; index < 11; index++) {
      const key = reader.string()
      if (seen.has(key)) return false
      seen.add(key)
      if (key === 'd2') {
        if (!/^[0-9]{1,10}$/.test(reader.string())) return false
      } else if (key === 'd3') {
        if (!/^[0-9a-f]{32}$/i.test(reader.string())) return false
      } else if (key === 'd5') {
        const count = reader.arrayLength()
        if (count < 1 || count > 2048) return false
        for (let vector = 0; vector < count; vector++) reader.vector(64)
      } else if (key === 'd6' || key === 'd7') {
        reader.vector(key === 'd6' ? 64 : 2)
      } else if (key === 'd9' || key === 'd10') {
        reader.unsignedInteger()
      } else if (key === 'd4' || key === 'd8' || key === 'd11' || key === 'd12') {
        reader.float()
      } else return false
    }
    return reader.finished()
  } catch {
    return false
  }
}
