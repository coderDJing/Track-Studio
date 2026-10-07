import { describe, expect, it } from 'vitest'
import { UsbPdbContainer } from './usbPdbContainer'
import { UsbPdbEditor } from './usbPdbEditor'
import { pdbEntry, pdbFixture, pdbPlaylist, pdbTrack } from './usbPdbFixtures'
import { emptyUsbMutation } from './usbWriteModel'

// Raw native rows: IDs intentionally differ from Bank IDs and slot numbers.
const members = [
  '01000000010000000100000001000000',
  '02000000020000000100000001000000',
  '03000000060000000200000002000000',
  '04000000080000000100000002000000'
].map((hex) => Buffer.from(hex, 'hex'))
const cues = [
  '000000000000000000000000ffffffff0000000000000000ce050000b3260000010000000100000065000000',
  '0000000000000000851300002382000000000000000000009411000035750000010000000200000065000000',
  '000000000000000000000000ffffffff0000000000000000e20500003b270000020000000300000065000000',
  '000000000000000000000000ffffffff0000000000000000b6080000193a0000010000000400000065000000'
].map((hex) => Buffer.from(hex, 'hex'))
const fixture = (
  bankMembers = members,
  bankCues = cues,
  nodes = [pdbPlaylist(1, 'RKB-sql-cue-probe'), pdbPlaylist(2, 'RKB-sql-ref-probe')]
) =>
  pdbFixture([
    { type: 0, rows: [pdbTrack(1), pdbTrack(2)] },
    { type: 7, rows: [pdbPlaylist(1, 'verify')] },
    { type: 8, rows: [pdbEntry(1, 1, 1), pdbEntry(1, 2, 2)] },
    { type: 9, rows: nodes },
    { type: 10, rows: bankMembers },
    { type: 15, rows: bankCues }
  ])
const payloads = (bytes: Buffer, type: number) =>
  new UsbPdbContainer(bytes).rows(type).map((row) => bytes.subarray(row.offset, row.end))

describe('native legacy Bank track deletion', () => {
  it('clears only WAV F and retains Bank nodes, MP3 A/B/H and their raw payloads', () => {
    const bytes = fixture()
    const editor = new UsbPdbEditor(bytes)
    expect(editor.snapshot().protectedTrackIds).toEqual([1, 2])
    editor.apply({ ...emptyUsbMutation(), deleteTrackIds: [2] })
    const output = editor.toBuffer()
    expect(payloads(output, 9)).toEqual(payloads(bytes, 9))
    expect(payloads(output, 10)).toEqual([members[0], members[1], members[3]])
    expect(payloads(output, 15)).toEqual([cues[0], cues[1], cues[3]])
    expect(editor.snapshot().tracks.map((track) => track.id)).toEqual([1])
    expect(editor.snapshot().protectedTrackIds).toEqual([1])
  })

  it('keeps Bank slots unchanged on playlist removal and preserves empty Bank nodes', () => {
    const bytes = fixture()
    const editor = new UsbPdbEditor(bytes)
    editor.apply({ ...emptyUsbMutation(), deletePlaylistIds: [1] })
    for (const type of [9, 10, 15])
      expect(payloads(editor.toBuffer(), type)).toEqual(payloads(bytes, type))
    editor.apply({ ...emptyUsbMutation(), deleteTrackIds: [1, 2] })
    expect(payloads(editor.toBuffer(), 9)).toEqual(payloads(bytes, 9))
    expect(payloads(editor.toBuffer(), 10)).toEqual([])
    expect(payloads(editor.toBuffer(), 15)).toEqual([])
  })

  it('rejects mismatched track/cue IDs, duplicate slots, orphan cues and unknown layouts', () => {
    const mismatch = Buffer.from(members[2])
    mismatch.writeUInt32LE(1, 8)
    const wrongKind = Buffer.from(cues[2])
    wrongKind.writeUInt32LE(102, 40)
    for (const bytes of [
      fixture([members[0], members[1], mismatch, members[3]]),
      fixture([...members, members[2]]),
      fixture(members.slice(0, 3)),
      fixture(members, [cues[0], cues[1], wrongKind, cues[3]]),
      fixture(members, cues, [pdbPlaylist(1, 'folder', 0, true), pdbPlaylist(2, 'bank')]),
      fixture(members, [...cues, cues[2]])
    ])
      expect(() => new UsbPdbEditor(bytes)).toThrow(/Bank/)
  })
})
