import { describe, expect, it } from 'vitest'
import { parseUsbAnlz, shiftUsbAnlzGrid, validateUsbCues, writeUsbAnlzCues } from './usbAnlzWrite'

const section = (kind: string, size: number, header = size) => {
  const bytes = Buffer.alloc(size)
  bytes.write(kind, 0, 'ascii')
  bytes.writeUInt32BE(header, 4)
  bytes.writeUInt32BE(size, 8)
  return bytes
}
const document = (...sections: Buffer[]) => {
  const header = Buffer.alloc(28)
  header.write('PMAI', 0, 'ascii')
  header.writeUInt32BE(header.length, 4)
  const bytes = Buffer.concat([header, ...sections])
  bytes.writeUInt32BE(bytes.length, 8)
  return bytes
}
const grid = () => {
  const bytes = section('PQTZ', 40, 24)
  bytes.writeUInt32BE(0x80000, 16)
  bytes.writeUInt32BE(2, 20)
  for (let index = 0; index < 2; index++) {
    bytes.writeUInt16BE(index + 1, 24 + index * 8)
    bytes.writeUInt16BE(12000, 26 + index * 8)
    bytes.writeUInt32BE(100 + 500 * index, 28 + index * 8)
  }
  return bytes
}

describe('USB analysis writes', () => {
  it('keeps SQL and ANLZ cue positions on the same millisecond precision', () => {
    expect(() => validateUsbCues([{ slot: 0, sec: 1.2345 }], [])).toThrow('毫秒')
    expect(() => validateUsbCues([], [{ sec: 1, loopEndSec: 2.0001 }])).toThrow('毫秒')
    expect(() => validateUsbCues([{ slot: 0, sec: 1.234 }], [{ sec: 0.1 + 0.2 }])).not.toThrow()
  })
  it('uses the native A–C / D–H legacy banks and the complete extended hot cue list', () => {
    const cues = Array.from({ length: 8 }, (_, slot) => ({ slot, sec: slot + 1 }))
    const dat = parseUsbAnlz(writeUsbAnlzCues(document(), '.DAT', cues, [])).sections
    const ext = parseUsbAnlz(writeUsbAnlzCues(document(), '.EXT', cues, [])).sections
    const hot = (tags: ReturnType<typeof parseUsbAnlz>['sections'], kind: string) =>
      tags.find((tag) => tag.kind === kind && tag.bytes.readUInt32BE(12) === 1)!.bytes
    const datHot = hot(dat, 'PCOB')
    const extHot = hot(ext, 'PCOB')
    expect(datHot.readUInt16BE(18)).toBe(3)
    expect(extHot.readUInt16BE(18)).toBe(5)
    expect(hot(ext, 'PCO2').readUInt16BE(16)).toBe(8)
    expect([0, 1, 2].map((index) => datHot.readUInt32BE(24 + 56 * index + 12))).toEqual([1, 2, 3])
    expect([0, 1, 2, 3, 4].map((index) => extHot.readUInt32BE(24 + 56 * index + 12))).toEqual([
      4, 5, 6, 7, 8
    ])
    for (const bank of [datHot, extHot]) {
      for (let offset = 24; offset < bank.length; offset += 56) {
        expect(bank.readUInt32BE(offset + 20)).toBe(0x10000)
        expect(bank.readUInt32BE(offset + 24)).toBe(0xffffffff)
      }
    }
  })
  it('rejects an implicit retained active loop conflicting with a newly activated loop', () => {
    const before = writeUsbAnlzCues(
      document(),
      '.DAT',
      [],
      [{ sec: 1, loopEndSec: 2, activeLoop: true }]
    )
    expect(() =>
      writeUsbAnlzCues(
        before,
        '.DAT',
        [],
        [
          { sec: 1, loopEndSec: 2 },
          { sec: 3, loopEndSec: 4, activeLoop: true }
        ]
      )
    ).toThrow('多个 Active Loop')
  })
  it('preserves waveform and unknown sections exactly while writing all cue variants', () => {
    const wave = section('PWV5', 30, 24)
    wave.fill(0x7b, 24)
    const unknown = section('UNKN', 19, 12)
    unknown.fill(0x81, 12)
    const before = document(wave, unknown, grid())
    const after = writeUsbAnlzCues(
      before,
      '.EXT',
      [
        { slot: 7, sec: 1.23, loopEndSec: 2.5, comment: '中文 🎧', colorIndex: 5, color: '#abcdef' }
      ],
      [{ sec: 3, loopEndSec: 4, activeLoop: true }]
    )
    const tags = parseUsbAnlz(after).sections
    expect(tags.find((tag) => tag.kind === 'PWV5')?.bytes).toEqual(wave)
    expect(tags.find((tag) => tag.kind === 'UNKN')?.bytes).toEqual(unknown)
    expect(tags.find((tag) => tag.kind === 'PQTZ')?.bytes).toEqual(grid())
    expect(tags.filter((tag) => ['PCOB', 'PCO2'].includes(tag.kind))).toHaveLength(4)
    const legacyMemory = tags.find(
      (tag) => tag.kind === 'PCOB' && tag.bytes.readUInt32BE(12) === 0
    )!.bytes
    expect(legacyMemory.readUInt16BE(18)).toBe(0)
    const datMemory = parseUsbAnlz(
      writeUsbAnlzCues(document(), '.DAT', [], [{ sec: 3, loopEndSec: 4, activeLoop: true }])
    ).sections.find((tag) => tag.kind === 'PCOB' && tag.bytes.readUInt32BE(12) === 0)!.bytes
    expect(datMemory.readUInt32BE(24 + 16)).toBe(4)
    const hot = tags.find((tag) => tag.kind === 'PCO2' && tag.bytes.readUInt32BE(12) === 1)!.bytes
    expect(hot.readUInt32BE(20 + 12)).toBe(8)
    expect(hot.readUInt32BE(20 + 20)).toBe(1230)
    expect(hot.readUInt32BE(20 + 24)).toBe(2500)
    expect(
      writeUsbAnlzCues(
        after,
        '.EXT',
        [{ slot: 7, sec: 1.23, loopEndSec: 2.5 }],
        [{ sec: 3, loopEndSec: 4 }]
      )
    ).toEqual(after)
  })
  it('shifts primary beats and invalidates the extended cache without touching waveform', () => {
    const extended = section('PQT2', 60, 56)
    extended.writeUInt32BE(0x01000002, 16)
    extended.writeUInt32BE(100, 28)
    extended.writeUInt32BE(600, 36)
    extended.writeUInt32BE(2, 40)
    extended[56] = 1
    extended[58] = 2
    const wave = section('PWV3', 27, 24)
    const shifted = shiftUsbAnlzGrid(document(grid(), extended, wave), -50, 1000)
    const tags = parseUsbAnlz(shifted.bytes).sections
    expect(tags[0].bytes.readUInt32BE(28)).toBe(50)
    expect(tags[0].bytes.readUInt16BE(26)).toBe(12000)
    expect(tags[1].bytes.length).toBe(56)
    expect(tags[1].bytes.readUInt32BE(16)).toBe(0x01000002)
    expect(tags[1].bytes.subarray(24)).toEqual(Buffer.alloc(32))
    expect(tags[2].bytes).toEqual(wave)
    expect(shifted.hasGrid).toBe(true)
  })
  it('rejects deletion of every original beat, invalid loops and malformed envelopes', () => {
    expect(() => shiftUsbAnlzGrid(document(grid()), -601, 1000)).toThrow('全部原始拍点')
    expect(() =>
      writeUsbAnlzCues(document(), '.DAT', [{ slot: 0, sec: 2, loopEndSec: 1 }], [])
    ).toThrow('终点')
    const truncated = document(grid()).subarray(0, 40)
    expect(() => shiftUsbAnlzGrid(truncated, 1)).toThrow('长度')
  })
})
