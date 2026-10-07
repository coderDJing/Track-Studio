/** Synthetic byte fixtures exercise the on-disk format without a USB or native module. */
const PAGE_SIZE = 4096
const HEADER_SIZE = 40
const align4 = (length: number) => Math.ceil(length / 4) * 4

export const pdbString = (value: string): Buffer => {
  if (/^[\x00-\x7f]*$/.test(value) && value.length <= 126) {
    return Buffer.concat([Buffer.from([value.length * 2 + 3]), Buffer.from(value, 'ascii')])
  }
  const unicode = /[^\x00-\x7f]/.test(value)
  const payload = Buffer.from(value, unicode ? 'utf16le' : 'ascii')
  const header = Buffer.alloc(4)
  header[0] = unicode ? 0x90 : 0x40
  header.writeUInt16LE(payload.length + 4, 1)
  return Buffer.concat([header, payload])
}

export const pdbTrack = (id: number, path = `/Contents/${id}.mp3`, artworkId = 0): Buffer => {
  const strings = Array.from({ length: 21 }, (_, slot) =>
    pdbString(slot === 20 ? path : slot === 14 ? `/PIONEER/USBANLZ/${id}/ANLZ0000.DAT` : '')
  )
  const row = Buffer.alloc(
    0x88 + strings.reduce((sum, string) => sum + align4(string.length), 0) + 4
  )
  row.writeUInt16LE(0x24, 0)
  row.writeUInt32LE(id, 0x48)
  row.writeUInt32LE(artworkId, 0x1c)
  let offset = 0x88
  strings.forEach((string, slot) => {
    row.writeUInt16LE(offset, 0x5e + slot * 2)
    string.copy(row, offset)
    offset += align4(string.length)
  })
  return row
}

export const pdbPlaylist = (id: number, name: string, parentId = 0, isFolder = false): Buffer => {
  const string = pdbString(name)
  const row = Buffer.alloc(align4(20 + string.length))
  row.writeUInt32LE(parentId, 0)
  row.writeUInt32LE(id, 12)
  row.writeUInt32LE(isFolder ? 1 : 0, 16)
  string.copy(row, 20)
  return row
}

export const pdbEntry = (playlistId: number, trackId: number, position: number): Buffer => {
  const row = Buffer.alloc(12)
  row.writeUInt32LE(position, 0)
  row.writeUInt32LE(trackId, 4)
  row.writeUInt32LE(playlistId, 8)
  return row
}

export const pdbHistoryEntry = (historyId: number, trackId: number, position: number): Buffer => {
  const row = pdbEntry(historyId, trackId, position)
  row.writeUInt32LE(trackId, 0)
  row.writeUInt32LE(historyId, 4)
  row.writeUInt32LE(position, 8)
  return row
}

export const pdbNamedRow = (id: number, name: string): Buffer => {
  const string = pdbString(name)
  const row = Buffer.alloc(align4(4 + string.length))
  row.writeUInt32LE(id, 0)
  string.copy(row, 4)
  return row
}

export const pdbTagTrack = (trackId: number, tagId: number): Buffer => {
  const row = Buffer.alloc(16)
  row.writeUInt32LE(trackId, 4)
  row.writeUInt32LE(tagId, 8)
  row.writeUInt32LE(3, 12)
  return row
}

export const pdbExtSettings = (): Buffer => {
  const row = Buffer.alloc(40)
  row.writeUInt16LE(0x700, 0)
  row.writeUInt32LE(0x11223344, 24)
  row[28] = 3
  for (let i = 0; i < 5; i++) {
    row[29 + i] = 34 + i
    row[34 + i] = 3
  }
  return row
}

export const pdbColumn = (id: number, kind: number, name: string): Buffer => {
  const row = pdbNamedRow(id, name)
  row.writeUInt16LE(kind, 2)
  return row
}

export const pdbSettingsRow = (id: number, pointer: number, flags: number): Buffer => {
  const row = Buffer.alloc(8)
  row.writeUInt16LE(id, 0)
  row.writeUInt16LE(pointer, 2)
  row.writeUInt32LE(flags, 4)
  return row
}

export const pdbExportMetadata = (trackCount: number): Buffer => {
  const row = Buffer.alloc(40)
  row.writeUInt16LE(0x280, 0)
  row.writeUInt32LE(trackCount, 4)
  pdbString('2024-02-29').copy(row, 12)
  row[23] = 25
  row[24] = 30
  pdbString('1000').copy(row, 25)
  pdbString('').copy(row, 30)
  return row
}

export type PdbFixtureTable = { type: number; rows: Buffer[]; deletedSlots?: number[] }

export const pdbFixture = (tables: PdbFixtureTable[]): Buffer => {
  type TableLayout = PdbFixtureTable & { index: number; dataPages: number[]; candidate: number }
  const layouts: TableLayout[] = []
  let nextUnused = 1
  for (const table of tables) {
    const index = nextUnused++
    const dataPages: number[] = []
    let used = 0
    let slots = 0
    for (const row of table.rows) {
      if (
        !slots ||
        HEADER_SIZE + used + row.length + 2 * (slots + 1) + 4 * Math.ceil((slots + 1) / 16) >
          PAGE_SIZE
      ) {
        dataPages.push(nextUnused++)
        used = 0
        slots = 0
      }
      used += row.length
      slots++
    }
    layouts.push({ ...table, index, dataPages, candidate: nextUnused++ })
  }
  const lastWritten = Math.max(...layouts.flatMap((table) => [table.index, ...table.dataPages]))
  const bytes = Buffer.alloc((lastWritten + 1) * PAGE_SIZE)
  bytes.writeUInt32LE(PAGE_SIZE, 4)
  bytes.writeUInt32LE(tables.length, 8)
  bytes.writeUInt32LE(nextUnused, 12)
  bytes.writeUInt32LE(11, 20)
  layouts.forEach((table, tableIndex) => {
    const directory = 28 + tableIndex * 16
    const last = table.dataPages.at(-1) ?? table.index
    bytes.writeUInt32LE(table.type, directory)
    bytes.writeUInt32LE(table.candidate, directory + 4)
    bytes.writeUInt32LE(table.index, directory + 8)
    bytes.writeUInt32LE(last, directory + 12)
    const indexStart = table.index * PAGE_SIZE
    bytes.writeUInt32LE(table.index, indexStart + 4)
    bytes.writeUInt32LE(table.type, indexStart + 8)
    bytes.writeUInt32LE(table.dataPages[0] ?? table.candidate, indexStart + 12)
    bytes.writeUInt32LE(3, indexStart + 16)
    bytes[indexStart + 27] = 0x64
    bytes.writeUInt32LE(table.index, indexStart + HEADER_SIZE)
    bytes.writeUInt32LE(table.dataPages[0] ?? 0x03ffffff, indexStart + HEADER_SIZE + 4)
    let rowIndex = 0
    for (let pagePosition = 0; pagePosition < table.dataPages.length; pagePosition++) {
      const page = table.dataPages[pagePosition]
      const start = page * PAGE_SIZE
      bytes.writeUInt32LE(page, start + 4)
      bytes.writeUInt32LE(table.type, start + 8)
      bytes.writeUInt32LE(table.dataPages[pagePosition + 1] ?? table.candidate, start + 12)
      bytes.writeUInt32LE(3, start + 16)
      bytes[start + 27] = 0x24
      let used = 0
      let slots = 0
      let live = 0
      for (;;) {
        const row = table.rows[rowIndex]
        if (
          !row ||
          HEADER_SIZE + used + row.length + 2 * (slots + 1) + 4 * Math.ceil((slots + 1) / 16) >
            PAGE_SIZE
        )
          break
        const base = start + PAGE_SIZE - Math.floor(slots / 16) * 36
        row.copy(bytes, start + HEADER_SIZE + used)
        bytes.writeUInt16LE(used, base - 6 - (slots % 16) * 2)
        if (!table.deletedSlots?.includes(rowIndex)) {
          bytes.writeUInt16LE(bytes.readUInt16LE(base - 4) | (1 << (slots % 16)), base - 4)
          live++
        } else {
          bytes[start + 27] |= 0x10
        }
        rowIndex++
        used += row.length
        slots++
      }
      bytes.writeUIntLE(slots | (live << 13), start + 24, 3)
      bytes.writeUInt16LE(used, start + 30)
      bytes.writeUInt16LE(
        PAGE_SIZE - HEADER_SIZE - used - 2 * slots - 4 * Math.ceil(slots / 16),
        start + 28
      )
      // Deliberately differs from the real current count. It is historical data.
      bytes.writeUInt16LE(0x1fff, start + 34)
    }
  })
  return bytes
}

export const standardPdbFixture = (entries = [pdbEntry(10, 1, 1), pdbEntry(10, 2, 2)]): Buffer =>
  pdbFixture([
    { type: 0, rows: [pdbTrack(1, '/Contents/音乐/一首歌.mp3', 1), pdbTrack(2), pdbTrack(3)] },
    {
      type: 7,
      rows: [
        pdbPlaylist(10, '歌曲 🎵'),
        pdbPlaylist(20, '目标'),
        pdbPlaylist(30, '文件夹', 0, true),
        pdbPlaylist(31, '子歌单', 30)
      ]
    },
    { type: 8, rows: entries },
    { type: 13, rows: [pdbNamedRow(1, '/PIONEER/Artwork/封面.jpg')] },
    { type: 11, rows: [pdbNamedRow(1, 'History')] },
    { type: 12, rows: [pdbHistoryEntry(1, 2, 1), pdbHistoryEntry(1, 1, 2)] }
  ])
