import { describe, expect, it } from 'vitest'
import { UsbPdbContainer } from './usbPdbContainer'
import { UsbPdbEditor, pruneUsbPdbExtTracks } from './usbPdbEditor'
import { emptyUsbMutation } from './usbWriteModel'
import {
  pdbColumn,
  pdbEntry,
  pdbExportMetadata,
  pdbExtSettings,
  pdbFixture,
  pdbNamedRow,
  pdbPlaylist,
  pdbSettingsRow,
  pdbTagTrack,
  pdbTrack,
  standardPdbFixture
} from './usbPdbFixtures'

describe('legacy USB DeviceSQL editor', () => {
  it('enumerates unreferenced tracks, decodes Unicode, and preserves a no-op byte for byte', () => {
    const bytes = standardPdbFixture()
    const editor = new UsbPdbEditor(bytes)
    expect(editor.snapshot().tracks.map((track) => track.id)).toEqual([1, 2, 3])
    expect(editor.snapshot().tracks[0]).toMatchObject({
      filePath: '/Contents/音乐/一首歌.mp3',
      artworkPath: '/PIONEER/Artwork/封面.jpg'
    })
    expect(editor.snapshot().playlists[0].name).toBe('歌曲 🎵')
    editor.apply(emptyUsbMutation())
    expect(editor.toBuffer()).toEqual(bytes)
  })

  it('patches only ordering fields and bookkeeping, preserving unrelated data pages', () => {
    const bytes = standardPdbFixture()
    const original = new UsbPdbContainer(bytes)
    const editor = new UsbPdbEditor(bytes)
    editor.apply({ ...emptyUsbMutation(), reorders: [{ playlistId: 10, trackIds: [2, 1] }] })
    const output = editor.toBuffer()
    expect(output.readUInt32LE(20)).toBe(12)
    expect(
      editor
        .snapshot()
        .entries.sort((a, b) => a.entryIndex - b.entryIndex)
        .map((entry) => entry.trackId)
    ).toEqual([2, 1])
    for (const table of [0, 7, 13, 11, 12]) {
      for (const row of original.rows(table)) {
        const start = row.pageIndex * 4096
        expect(output.subarray(start, start + 4096)).toEqual(bytes.subarray(start, start + 4096))
      }
    }
    expect(editor.toBuffer()).toEqual(output)
  })

  it('adds existing tracks to another playlist without removing their original membership or adding duplicates', () => {
    const editor = new UsbPdbEditor(standardPdbFixture())
    editor.apply({ ...emptyUsbMutation(), additions: [{ playlistId: 20, trackIds: [1, 3] }] })
    editor.apply({ ...emptyUsbMutation(), additions: [{ playlistId: 20, trackIds: [1] }] })
    expect(editor.snapshot().entries.filter((entry) => entry.playlistId === 10)).toHaveLength(2)
    expect(
      editor
        .snapshot()
        .entries.filter((entry) => entry.playlistId === 20)
        .map((entry) => entry.trackId)
    ).toEqual([1, 3])
    expect(editor.snapshot().tracks).toHaveLength(3)
  })

  it('appends a real data page to an empty entry table and updates the first-data index', () => {
    const bytes = standardPdbFixture([])
    const directory = 28 + 2 * 16
    const candidate = bytes.readUInt32LE(directory + 4)
    const index = bytes.readUInt32LE(directory + 8)
    const editor = new UsbPdbEditor(bytes)
    editor.apply({ ...emptyUsbMutation(), additions: [{ playlistId: 20, trackIds: [3] }] })
    const output = editor.toBuffer()
    expect(output.readUInt32LE(directory + 12)).toBe(candidate)
    expect(output.readUInt32LE(index * 4096 + 44)).toBe(candidate)
    expect(editor.snapshot().entries).toEqual([{ playlistId: 20, trackId: 3, entryIndex: 1 }])
  })

  it('reads more than 255 slots and ignores invalid tombstone content', () => {
    const entries = Array.from({ length: 280 }, (_, i) => pdbEntry(10, 1, i + 1))
    entries[257] = Buffer.alloc(12, 0xfe)
    const bytes = pdbFixture([
      { type: 0, rows: [pdbTrack(1)] },
      { type: 7, rows: [pdbPlaylist(10, 'Many')] },
      { type: 8, rows: entries, deletedSlots: [257] }
    ])
    const editor = new UsbPdbEditor(bytes)
    expect(editor.snapshot().entries).toHaveLength(279)
    expect(editor.snapshot().entries.at(-1)?.entryIndex).toBe(280)
  })

  it('allocates beyond a full 284-slot data page instead of overwriting heap or directory', () => {
    const entries = Array.from({ length: 284 }, (_, i) => pdbEntry(10, 1, i + 1))
    const bytes = standardPdbFixture(entries)
    const directory = 28 + 2 * 16
    const oldLast = bytes.readUInt32LE(directory + 12)
    const candidate = bytes.readUInt32LE(directory + 4)
    const editor = new UsbPdbEditor(bytes)
    editor.apply({ ...emptyUsbMutation(), additions: [{ playlistId: 10, trackIds: [2] }] })
    const output = editor.toBuffer()
    expect(output.readUInt32LE(directory + 12)).toBe(candidate)
    expect(output.readUInt32LE(oldLast * 4096 + 12)).toBe(candidate)
    expect(output.subarray(oldLast * 4096, (oldLast + 1) * 4096)).toEqual(
      bytes.subarray(oldLast * 4096, (oldLast + 1) * 4096)
    )
    expect(editor.snapshot().entries.at(-1)).toEqual({
      playlistId: 10,
      trackId: 2,
      entryIndex: 285
    })
  })

  it('extends a candidate past EOF when the final table has no data pages', () => {
    const bytes = pdbFixture([
      { type: 0, rows: [pdbTrack(1)] },
      { type: 7, rows: [pdbPlaylist(10, 'Target')] },
      { type: 8, rows: [] }
    ])
    const editor = new UsbPdbEditor(bytes)
    editor.apply({ ...emptyUsbMutation(), additions: [{ playlistId: 10, trackIds: [1] }] })
    expect(editor.toBuffer().length).toBe(bytes.length + 4096)
    expect(new UsbPdbEditor(editor.toBuffer()).snapshot().entries).toHaveLength(1)
  })

  it('deletes memberships and history references while retaining tombstone heap bytes', () => {
    const bytes = standardPdbFixture()
    const original = new UsbPdbContainer(bytes)
    const removedRow = original.rows(0)[1]
    const editor = new UsbPdbEditor(bytes)
    editor.apply({ ...emptyUsbMutation(), deleteTrackIds: [2] })
    expect(editor.snapshot().tracks.map((track) => track.id)).toEqual([1, 3])
    expect(editor.snapshot().entries.map((entry) => entry.trackId)).toEqual([1])
    const output = editor.toBuffer()
    expect(output.subarray(removedRow.offset, removedRow.end)).toEqual(
      bytes.subarray(removedRow.offset, removedRow.end)
    )
    expect(new UsbPdbContainer(output).rows(12)).toHaveLength(1)
    expect(bytes).toEqual(standardPdbFixture())
  })

  it('deletes a folder only when all descendants are supplied, without deleting their songs', () => {
    const editor = new UsbPdbEditor(standardPdbFixture([pdbEntry(31, 1, 1)]))
    expect(() => editor.apply({ ...emptyUsbMutation(), deletePlaylistIds: [30] })).toThrow(
      'omits a descendant'
    )
    editor.apply({ ...emptyUsbMutation(), deletePlaylistIds: [30, 31] })
    expect(editor.snapshot().playlists.map((playlist) => playlist.id)).toEqual([10, 20])
    expect(editor.snapshot().entries).toEqual([])
    expect(editor.snapshot().tracks).toHaveLength(3)
  })

  it.each(['remove-membership', 'delete-track'] as const)(
    'compacts only affected playlist positions after %s, preserving stored playback order',
    (operation) => {
      const editor = new UsbPdbEditor(
        standardPdbFixture([
          pdbEntry(10, 3, 3),
          pdbEntry(10, 1, 1),
          pdbEntry(10, 2, 2),
          pdbEntry(20, 2, 4),
          pdbEntry(20, 3, 7)
        ])
      )
      editor.apply({
        ...emptyUsbMutation(),
        ...(operation === 'delete-track'
          ? { deleteTrackIds: [2] }
          : { removals: [{ playlistId: 10, trackIds: [2] }] })
      })
      const entries = new UsbPdbEditor(editor.toBuffer()).snapshot().entries
      expect(
        entries.filter((row) => row.playlistId === 10).sort((a, b) => a.entryIndex - b.entryIndex)
      ).toEqual([
        { playlistId: 10, trackId: 1, entryIndex: 1 },
        { playlistId: 10, trackId: 3, entryIndex: 2 }
      ])
      expect(entries.filter((row) => row.playlistId === 20)).toEqual(
        operation === 'delete-track'
          ? [{ playlistId: 20, trackId: 3, entryIndex: 1 }]
          : [
              { playlistId: 20, trackId: 2, entryIndex: 4 },
              { playlistId: 20, trackId: 3, entryIndex: 7 }
            ]
      )
    }
  )

  it('prunes affected orphan artwork rows but keeps other IDs referencing a shared path', () => {
    const bytes = pdbFixture([
      { type: 0, rows: [pdbTrack(1, '/Contents/one.mp3', 1), pdbTrack(2, '/Contents/two.mp3', 2)] },
      { type: 7, rows: [pdbPlaylist(10, 'Target')] },
      { type: 8, rows: [pdbEntry(10, 1, 1), pdbEntry(10, 2, 2)] },
      {
        type: 13,
        rows: [
          pdbNamedRow(1, '/shared.jpg'),
          pdbNamedRow(2, '/shared.jpg'),
          pdbNamedRow(3, '/shared.jpg'),
          pdbNamedRow(4, '/unrelated.jpg')
        ]
      }
    ])
    const editor = new UsbPdbEditor(bytes)
    editor.apply({ ...emptyUsbMutation(), deleteTrackIds: [1] })
    let db = new UsbPdbContainer(editor.toBuffer())
    expect(db.rows(13).map((row) => db.u32(row, 0))).toEqual([2, 4])
    expect(editor.snapshot().tracks[0].artworkPath).toBe('/shared.jpg')
    editor.apply({ ...emptyUsbMutation(), deleteTrackIds: [2] })
    db = new UsbPdbContainer(editor.toBuffer())
    expect(db.rows(13).map((row) => db.u32(row, 0))).toEqual([4])
  })

  it('applies removals then additions then a complete final reorder', () => {
    const editor = new UsbPdbEditor(standardPdbFixture())
    editor.apply({
      ...emptyUsbMutation(),
      removals: [{ playlistId: 10, trackIds: [2] }],
      additions: [{ playlistId: 10, trackIds: [3] }],
      reorders: [{ playlistId: 10, trackIds: [3, 1] }]
    })
    expect(
      editor
        .snapshot()
        .entries.sort((a, b) => a.entryIndex - b.entryIndex)
        .map((entry) => entry.trackId)
    ).toEqual([3, 1])
  })

  it('does not partially mutate after an invalid reorder, dangling reference, or occupied candidate', () => {
    const bytes = standardPdbFixture()
    const editor = new UsbPdbEditor(bytes)
    expect(() =>
      editor.apply({
        ...emptyUsbMutation(),
        additions: [{ playlistId: 20, trackIds: [3] }],
        reorders: [{ playlistId: 10, trackIds: [1] }]
      })
    ).toThrow('entire final playlist')
    expect(editor.toBuffer()).toEqual(bytes)
    expect(() => new UsbPdbEditor(standardPdbFixture([pdbEntry(10, 999, 1)]))).toThrow(
      'missing track'
    )
    const empty = standardPdbFixture([])
    const candidate = empty.readUInt32LE(28 + 2 * 16 + 4)
    empty[candidate * 4096 + 10] = 1
    const blocked = new UsbPdbEditor(empty)
    expect(() =>
      blocked.apply({ ...emptyUsbMutation(), additions: [{ playlistId: 20, trackIds: [1] }] })
    ).toThrow('not empty')
    expect(blocked.toBuffer()).toEqual(empty)
  })

  it('rejects corrupt live counts, cycles, and strings outside a live row allocation', () => {
    const bytes = standardPdbFixture()
    const row = new UsbPdbContainer(bytes).rows(8)[0]
    const start = row.pageIndex * 4096
    bytes.writeUIntLE(bytes.readUIntLE(start + 24, 3) + (1 << 13), start + 24, 3)
    expect(() => new UsbPdbEditor(bytes)).toThrow('bitmap')
    const cyclic = standardPdbFixture()
    const treeDirectory = 28 + 16
    const first = cyclic.readUInt32LE(treeDirectory + 8)
    cyclic.writeUInt32LE(first, first * 4096 + 12)
    expect(() => new UsbPdbEditor(cyclic)).toThrow('cycle')
    const malformed = standardPdbFixture()
    const track = new UsbPdbContainer(malformed).rows(0)[0]
    malformed.writeUInt16LE(0xffff, track.offset + 0x5e + 40)
    expect(() => new UsbPdbEditor(malformed)).toThrow('outside allocation')
    const sparse = standardPdbFixture()
    sparse.writeUInt32LE(0xfffffff0, 12)
    expect(() => new UsbPdbEditor(sparse)).toThrow('watermark')
  })

  it('allows ordering with opaque tables but fails closed on track deletion with unknown associations', () => {
    const bytes = pdbFixture([
      { type: 0, rows: [pdbTrack(1), pdbTrack(2)] },
      { type: 7, rows: [pdbPlaylist(10, 'Target')] },
      { type: 8, rows: [pdbEntry(10, 1, 1), pdbEntry(10, 2, 2)] },
      { type: 17, rows: [Buffer.alloc(8)] }
    ])
    const editor = new UsbPdbEditor(bytes)
    editor.apply({ ...emptyUsbMutation(), reorders: [{ playlistId: 10, trackIds: [2, 1] }] })
    const before = editor.toBuffer()
    expect(() => editor.apply({ ...emptyUsbMutation(), deleteTrackIds: [2] })).toThrow(
      'unknown table 17'
    )
    expect(editor.toBuffer()).toEqual(before)
  })

  it('preserves recognized menu settings and updates the export track count after deletion', () => {
    const bytes = pdbFixture([
      { type: 0, rows: [pdbTrack(1), pdbTrack(2)] },
      { type: 7, rows: [pdbPlaylist(10, 'Target')] },
      { type: 8, rows: [pdbEntry(10, 1, 1), pdbEntry(10, 2, 2)] },
      { type: 16, rows: [pdbColumn(1, 0x80, 'GENRE'), pdbColumn(2, 0x81, 'ARTIST')] },
      { type: 17, rows: [pdbSettingsRow(1, 1, 0x563), pdbSettingsRow(2, 2, 0x10002)] },
      { type: 18, rows: [pdbSettingsRow(1, 6, 1), pdbSettingsRow(2, 2, 0x202)] },
      { type: 19, rows: [pdbExportMetadata(2)] }
    ])
    const original = new UsbPdbContainer(bytes)
    const editor = new UsbPdbEditor(bytes)
    editor.apply({ ...emptyUsbMutation(), deleteTrackIds: [2] })
    const output = editor.toBuffer()
    const db = new UsbPdbContainer(output)
    expect(db.u32(db.rows(19)[0], 4)).toBe(1)
    for (const type of [16, 17, 18]) {
      const page = original.rows(type)[0].pageIndex * 4096
      expect(output.subarray(page, page + 4096)).toEqual(bytes.subarray(page, page + 4096))
    }
    const unexpected = Buffer.from(bytes)
    unexpected.writeUInt32LE(999, original.rows(18)[0].offset + 4)
    const blocked = new UsbPdbEditor(unexpected)
    expect(() => blocked.apply({ ...emptyUsbMutation(), deleteTrackIds: [2] })).toThrow(
      'unknown table 18'
    )
    expect(blocked.toBuffer()).toEqual(unexpected)
  })
})

describe('exportExt tag associations', () => {
  it('prunes documented type 4 rows while keeping categories and standalone settings bytes', () => {
    const bytes = pdbFixture([
      { type: 3, rows: [Buffer.alloc(40)] },
      { type: 4, rows: [pdbTagTrack(1, 21), pdbTagTrack(2, 21), pdbTagTrack(2, 22)] },
      { type: 7, rows: [pdbExtSettings()] }
    ])
    const output = pruneUsbPdbExtTracks(bytes, [2])
    const db = new UsbPdbContainer(output)
    expect(db.rows(4).map((row) => db.u32(row, 4))).toEqual([1])
    for (const type of [3, 7]) {
      const page = new UsbPdbContainer(bytes).rows(type)[0].pageIndex * 4096
      expect(output.subarray(page, page + 4096)).toEqual(bytes.subarray(page, page + 4096))
    }
    expect(pruneUsbPdbExtTracks(bytes, [])).toEqual(bytes)
  })

  it('fails closed on unknown populated tables and different association layouts', () => {
    expect(() =>
      pruneUsbPdbExtTracks(pdbFixture([{ type: 8, rows: [Buffer.alloc(16)] }]), [1])
    ).toThrow('unknown exportExt table 8')
    const malformed = pdbTagTrack(1, 2)
    malformed.writeUInt32LE(4, 12)
    expect(() => pruneUsbPdbExtTracks(pdbFixture([{ type: 4, rows: [malformed] }]), [1])).toThrow(
      'association layout'
    )
  })
})
