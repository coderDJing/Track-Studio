import { describe, expect, it } from 'vitest'
import type { PioneerUsbCue } from '../../../shared/pioneerUsbWrite'
import { parseUsbAnlz, writeUsbAnlzCues, validateUsbAnlzMpegCueFamily } from './usbAnlzWrite'

// Synthetic values exercise the native field layout; they are not evidence
// that seek values can be generated from time or played by Pioneer hardware.
const sourceWithSeek = (hot = true, loop = false, nonzero = true) => {
  const header = Buffer.alloc(28)
  header.write('PMAI')
  header.writeUInt32BE(28, 4)
  const comment = Buffer.from('old\0', 'utf16le').swap16()
  const entry = Buffer.alloc(88 + comment.length)
  entry.write('PCP2')
  entry.writeUInt32BE(16, 4)
  entry.writeUInt32BE(entry.length, 8)
  entry.writeUInt32BE(hot ? 1 : 0, 12)
  entry[16] = loop ? 2 : 1
  entry.writeUInt16BE(1000, 18)
  entry.writeUInt32BE(1234, 20)
  entry.writeUInt32BE(loop ? 2500 : 0xffffffff, 24)
  entry[29] = 1
  entry.writeUInt32BE(comment.length, 40)
  comment.copy(entry, 44)
  const suffix = 44 + comment.length
  entry[suffix] = 5
  entry.fill(0x7a, suffix + 1, suffix + 4)
  if (nonzero) {
    entry.writeBigUInt64BE(0x0102030405060708n, suffix + 4)
    entry.writeBigUInt64BE(loop ? 0x1112131415161718n : 0n, suffix + 12)
    entry.writeBigUInt64BE(0x2122232425262728n, suffix + 20)
    entry.writeBigUInt64BE(loop ? 0x3132333435363738n : 0n, suffix + 28)
    entry.writeUInt32BE(1152, suffix + 36)
    entry.writeUInt32BE(loop ? 1152 : 0, suffix + 40)
  }
  const section = Buffer.alloc(20)
  section.write('PCO2')
  section.writeUInt32BE(20, 4)
  section.writeUInt32BE(20 + entry.length, 8)
  section.writeUInt32BE(hot ? 1 : 0, 12)
  section.writeUInt16BE(1, 16)
  const bytes = Buffer.concat([header, section, entry])
  bytes.writeUInt32BE(bytes.length, 8)
  return bytes
}

const cueEntry = (bytes: Buffer, hot: boolean) =>
  parseUsbAnlz(bytes)
    .sections.find((section) => section.kind === 'PCO2' && section.bytes.readUInt32BE(12) === +hot)!
    .bytes.subarray(20)

describe('ANLZ native decoder seek preservation', () => {
  it('checks unknown MPEG data across DAT A–C and EXT D–H before adding or moving slots', () => {
    const empty = Buffer.alloc(28)
    empty.write('PMAI')
    empty.writeUInt32BE(28, 4)
    empty.writeUInt32BE(28, 8)
    const original = [
      { slot: 0, sec: 1 },
      { slot: 3, sec: 2 }
    ]
    const files = ['.DAT', '.EXT'].map((extension) =>
      writeUsbAnlzCues(empty, extension, original, [])
    )
    const datHot = parseUsbAnlz(files[0]).sections.find(
      (tag) => tag.kind === 'PCOB' && tag.bytes.readUInt32BE(12) === 1
    )!
    files[0].writeUInt32BE(75, files[0].indexOf(datHot.bytes) + 24 + 40)
    expect(() => validateUsbAnlzMpegCueFamily(files, original, [])).not.toThrow()
    expect(() =>
      validateUsbAnlzMpegCueFamily(files, [...original, { slot: 4, sec: 3 }], [])
    ).toThrow('MPEG 定位')
    expect(() =>
      validateUsbAnlzMpegCueFamily(
        files,
        [
          { slot: 0, sec: 1 },
          { slot: 3, sec: 2.001 }
        ],
        []
      )
    ).toThrow('MPEG 定位')
    expect(() => validateUsbAnlzMpegCueFamily(files, [], [{ sec: 4 }])).toThrow('MPEG 定位')
    expect(() => validateUsbAnlzMpegCueFamily(files, [], [])).not.toThrow()
  })
  it('does not retain legacy MPEG coordinates after moving a Hot Cue or loop endpoint', () => {
    const empty = Buffer.alloc(28)
    empty.write('PMAI')
    empty.writeUInt32BE(28, 4)
    empty.writeUInt32BE(28, 8)
    const encoded = writeUsbAnlzCues(empty, '.DAT', [{ slot: 0, sec: 1.234, loopEndSec: 2.5 }], [])
    const source = Buffer.from(encoded)
    const section = parseUsbAnlz(source).sections.find(
      (section) => section.kind === 'PCOB' && section.bytes.readUInt32BE(12) === 1
    )!
    const offset = source.indexOf(section.bytes) + 24
    for (let index = 0; index < 4; index++) source.writeUInt32BE(index + 1, offset + 40 + index * 4)
    const original = Buffer.from(source)
    for (const cue of [
      { slot: 0, sec: 1.235, loopEndSec: 2.5 },
      { slot: 0, sec: 1.234, loopEndSec: 2.501 },
      { slot: 0, sec: 1.234 }
    ])
      expect(() => writeUsbAnlzCues(source, '.DAT', [cue], [])).toThrow('MPEG 定位')
    expect(source).toEqual(original)
    expect(
      writeUsbAnlzCues(source, '.DAT', [{ slot: 0, sec: 1.234, loopEndSec: 2.5 }], [])
    ).toEqual(source)
    expect(() => writeUsbAnlzCues(source, '.DAT', [], [])).not.toThrow()
  })

  it('rejects moving a point, changing either loop endpoint or changing loop type', () => {
    for (const loop of [false, true]) {
      const source = sourceWithSeek(true, loop)
      const original = Buffer.from(source)
      const requested: PioneerUsbCue[] = loop
        ? [
            { slot: 0, sec: 1.235, loopEndSec: 2.5 },
            { slot: 0, sec: 1.234, loopEndSec: 2.501 },
            { slot: 0, sec: 1.234 }
          ]
        : [
            { slot: 0, sec: 1.235 },
            { slot: 0, sec: 1.234, loopEndSec: 2.5 }
          ]
      for (const cue of requested)
        expect(() => writeUsbAnlzCues(source, '.EXT', [cue], [])).toThrow('设备解码定位')
      expect(source).toEqual(original)
    }
  })

  it('rejects new slots and Memory positions even when another list carries the seek fields', () => {
    const source = sourceWithSeek()
    expect(() => writeUsbAnlzCues(source, '.EXT', [{ slot: 1, sec: 1.234 }], [])).toThrow(
      '设备解码定位'
    )
    expect(() => writeUsbAnlzCues(source, '.EXT', [{ slot: 0, sec: 1.234 }], [{ sec: 3 }])).toThrow(
      '设备解码定位'
    )
    expect(() =>
      writeUsbAnlzCues(sourceWithSeek(false), '.EXT', [{ slot: 0, sec: 3 }], [])
    ).toThrow('设备解码定位')
    expect(() => writeUsbAnlzCues(sourceWithSeek(false), '.EXT', [], [{ sec: 1.235 }])).toThrow(
      '设备解码定位'
    )
  })

  it('preserves all six seek values when a longer comment and color change their byte offset', () => {
    const source = sourceWithSeek()
    const before = cueEntry(source, true)
    const output = writeUsbAnlzCues(
      source,
      '.EXT',
      [{ slot: 0, sec: 1.234, comment: '更长的中文评论 🎧', colorIndex: 6, color: '#abcdef' }],
      []
    )
    const after = cueEntry(output, true)
    const suffix = 44 + after.readUInt32BE(40)
    expect(after.subarray(suffix + 4)).toEqual(before.subarray(48 + before.readUInt32BE(40)))
    expect(after.subarray(suffix, suffix + 4).toString('hex')).toBe('06abcdef')
    expect(after.readUInt32BE(20)).toBe(1234)
  })

  it('allows deleting decoder-bearing cues and editing an unchanged Memory Loop', () => {
    const source = sourceWithSeek(false, true)
    const output = writeUsbAnlzCues(
      source,
      '.EXT',
      [],
      [{ sec: 1.234, loopEndSec: 2.5, comment: 'saved loop', loopNumerator: 8, loopDenominator: 1 }]
    )
    const entry = cueEntry(output, false)
    expect(entry.readUInt16BE(36)).toBe(8)
    expect(entry.subarray(48 + entry.readUInt32BE(40))).toEqual(
      cueEntry(source, false).subarray(48 + cueEntry(source, false).readUInt32BE(40))
    )
    expect(cueEntry(writeUsbAnlzCues(source, '.EXT', [], []), false)).toHaveLength(0)
  })

  it('keeps arbitrary positions available for the observed all-zero extended suffix profile', () => {
    const source = sourceWithSeek(true, false, false)
    const output = writeUsbAnlzCues(
      source,
      '.EXT',
      [
        { slot: 0, sec: 4 },
        { slot: 1, sec: 5, loopEndSec: 6 }
      ],
      [{ sec: 7 }]
    )
    expect(cueEntry(output, true).readUInt32BE(20)).toBe(4000)
    const first = cueEntry(output, true)
    expect(first.subarray(44 + first.readUInt32BE(40), first.readUInt32BE(8))).toEqual(
      Buffer.from([5, 0x7a, 0x7a, 0x7a])
    )
    expect(cueEntry(output, false).readUInt32BE(20)).toBe(7000)
  })
})
