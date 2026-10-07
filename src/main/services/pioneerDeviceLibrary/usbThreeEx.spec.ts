import { describe, expect, it } from 'vitest'
import { isKnownUsbThreeEx } from './usbThreeEx'

const string = (text: string) => {
  const bytes = Buffer.from(text, 'ascii')
  return Buffer.concat([
    bytes.length < 32 ? Buffer.from([0xa0 | bytes.length]) : Buffer.from([0xd9, bytes.length]),
    bytes
  ])
}
const float = (value: number, wide = false) => {
  const bytes = Buffer.alloc(wide ? 9 : 5)
  bytes[0] = wide ? 0xcb : 0xca
  if (wide) bytes.writeDoubleBE(value, 1)
  else bytes.writeFloatBE(value, 1)
  return bytes
}
const array = (items: Buffer[]) => {
  const header = Buffer.alloc(items.length < 16 ? 1 : 3)
  if (items.length < 16) header[0] = 0x90 | items.length
  else {
    header[0] = 0xdc
    header.writeUInt16BE(items.length, 1)
  }
  return Buffer.concat([header, ...items])
}
const vector = (size = 64) =>
  array(Array.from({ length: size }, (_, index) => float(index / size - 0.5, index % 2 === 0)))

// Structure and scalar/container encodings observed in 260 native desktop .3EX
// files. Values are synthetic, so no audio embeddings or track identity is stored.
const nativeSchema = (): [string, Buffer][] => [
  ['d4', float(284.708125, true)],
  ['d5', array([vector(), vector()])],
  ['d6', vector()],
  ['d7', vector(2)],
  ['d8', float(0.75, true)],
  ['d9', Buffer.from([24])],
  ['d2', string('123456789')],
  ['d3', string('0123456789abcdef0123456789abcdef')],
  ['d12', float(1, true)],
  ['d11', float(0, true)],
  ['d10', Buffer.from([0])]
]
const embedding = (fields = nativeSchema(), count = fields.length) =>
  Buffer.concat([
    Buffer.from([0x81]),
    string('embedding'),
    Buffer.from([0x80 | count]),
    ...fields.flatMap(([key, value]) => [string(key), value])
  ])
const replace = (key: string, value: Buffer) =>
  embedding(nativeSchema().map(([name, original]) => [name, name === key ? value : original]))

describe('embedding-only .3EX preservation', () => {
  it('checks the entire native schema without mutating the supplied bytes', () => {
    const bytes = embedding()
    const before = Buffer.from(bytes)
    expect(isKnownUsbThreeEx(bytes)).toBe(true)
    expect(bytes).toEqual(before)
    expect(isKnownUsbThreeEx(embedding(nativeSchema().reverse()))).toBe(true)
  })

  it('rejects every truncated prefix and trailing data, including another valid object', () => {
    const bytes = embedding()
    for (let length = 0; length < bytes.length; length++) {
      expect(isKnownUsbThreeEx(bytes.subarray(0, length))).toBe(false)
    }
    expect(isKnownUsbThreeEx(Buffer.concat([bytes, Buffer.from([0])]))).toBe(false)
    expect(isKnownUsbThreeEx(Buffer.concat([bytes, bytes]))).toBe(false)
  })

  it('rejects unknown or repeated fields and other top-level payloads', () => {
    const fields = nativeSchema()
    expect(isKnownUsbThreeEx(embedding([...fields, ['cue', array([])]]))).toBe(false)
    expect(isKnownUsbThreeEx(embedding(fields.slice(1)))).toBe(false)
    expect(
      isKnownUsbThreeEx(embedding(fields.map((field, index) => (index === 1 ? fields[0] : field))))
    ).toBe(false)
    expect(
      isKnownUsbThreeEx(
        embedding(fields.map(([key, value]) => [key === 'd4' ? 'cue' : key, value]))
      )
    ).toBe(false)
    const other = Buffer.from(embedding())
    other.write('otherdata', 2, 'ascii')
    expect(isKnownUsbThreeEx(other)).toBe(false)
    expect(isKnownUsbThreeEx(Buffer.from('PMAI'))).toBe(false)
  })

  it('checks string identities, floating point types and finite vector values', () => {
    expect(isKnownUsbThreeEx(replace('d2', string('not-an-id')))).toBe(false)
    expect(isKnownUsbThreeEx(replace('d3', string('not-a-32-character-hex-identity')))).toBe(false)
    expect(isKnownUsbThreeEx(replace('d4', Buffer.from([1])))).toBe(false)
    expect(isKnownUsbThreeEx(replace('d4', float(Infinity)))).toBe(false)
    expect(isKnownUsbThreeEx(replace('d8', float(NaN)))).toBe(false)
    expect(
      isKnownUsbThreeEx(replace('d6', array([float(Infinity), ...Array(63).fill(float(0))])))
    ).toBe(false)
    expect(isKnownUsbThreeEx(replace('d9', float(1)))).toBe(false)
    expect(isKnownUsbThreeEx(replace('d10', Buffer.from([0xff])))).toBe(false)
    const unsafe = Buffer.alloc(9)
    unsafe[0] = 0xcf
    unsafe.writeBigUInt64BE(0xffffffffffffffffn, 1)
    expect(isKnownUsbThreeEx(replace('d10', unsafe))).toBe(false)
  })

  it('requires the observed vector dimensions and bounded complete containers', () => {
    expect(isKnownUsbThreeEx(replace('d5', array([])))).toBe(false)
    expect(isKnownUsbThreeEx(replace('d5', array([vector(63)])))).toBe(false)
    expect(isKnownUsbThreeEx(replace('d6', vector(65)))).toBe(false)
    expect(isKnownUsbThreeEx(replace('d7', vector(3)))).toBe(false)
    expect(isKnownUsbThreeEx(replace('d5', Buffer.from([0xdd, 0xff, 0xff, 0xff, 0xff])))).toBe(
      false
    )
    expect(isKnownUsbThreeEx(replace('d2', Buffer.from([0xdb, 0xff, 0xff, 0xff, 0xff])))).toBe(
      false
    )
    expect(isKnownUsbThreeEx(Buffer.alloc(2 * 1024 * 1024 + 1))).toBe(false)
  })
})
