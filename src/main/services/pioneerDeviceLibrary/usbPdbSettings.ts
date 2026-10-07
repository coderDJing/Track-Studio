import { UsbPdbContainer, type UsbPdbRow } from './usbPdbContainer'

/**
 * These settings contain column IDs, never track IDs. Menu layout corroborated
 * by https://github.com/vynulldev/vynull/blob/main/pdb/defaults.go.
 * Type 18's category/pointer shapes were compared across rekordcrate's empty
 * export and fragmede's 1-track/12-track exports. vynull corroborates column
 * flags and order bytes; unknown category/pointer shapes still block deletion.
 * https://github.com/Holzhaus/rekordcrate/tree/main/data/complete_export/empty
 * https://github.com/fragmede/rekordbox-pdb/tree/main/tests/data
 */
const MENU_POINTERS = new Map<number, number>([
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 4],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [13, 15],
  [14, 19],
  [15, 20],
  [16, 21],
  [17, 5],
  [18, 23],
  [19, 22],
  [20, 18],
  [22, 27],
  [24, 17],
  [27, 26]
])

const COLUMN_DEFAULTS = new Map<number, [number, number]>([
  [1, [6, 1]],
  [21, [7, 1]],
  [14, [8, 1]],
  [8, [9, 1]],
  [9, [10, 1]],
  [10, [11, 1]],
  [15, [13, 1]],
  [13, [15, 1]],
  [23, [16, 1]],
  [22, [17, 1]],
  [25, [0, 0x100]],
  [26, [1, 0x200]],
  [2, [2, 0x300]],
  [3, [3, 0x400]],
  [5, [4, 0x500]],
  [6, [5, 0x600]],
  [11, [12, 0x700]]
])

export const isKnownUsbPdbSettingsTable = (db: UsbPdbContainer, type: number): boolean => {
  if (type !== 17 && type !== 18) return false
  const columnIds = new Set(
    db
      .rows(16)
      .filter((row) => {
        const kind = db.u16(row, 2)
        return kind >= 0x80 && kind <= 0xaa
      })
      .map((row) => db.u16(row, 0))
  )
  const seen = new Set<number>()
  return db.rows(type).every((row) => {
    if (row.end - row.offset !== 8) return false
    const id = db.u16(row, 0)
    if (!columnIds.has(id) || seen.has(id)) return false
    seen.add(id)
    if (type === 18) {
      const expected = COLUMN_DEFAULTS.get(id)
      return (
        !!expected &&
        db.u16(row, 2) === expected[0] &&
        db.u8(row, 4) <= 2 &&
        db.u8(row, 5) <= columnIds.size &&
        db.u16(row, 6) === 0
      )
    }
    const flags = db.u8(row, 4)
    const expectedFlag =
      id === 2
        ? 2
        : id === 3
          ? 3
          : id === 4
            ? 1
            : id === 5
              ? 5
              : id === 14
                ? 4
                : id === 15
                  ? 6
                  : 0x63
    // rekordcrate models visibility as Unknown(u8) for undocumented states;
    // preserve it without mistaking it for a track reference.
    return db.u16(row, 2) === MENU_POINTERS.get(id) && flags === expectedFlag
  })
}

export const validateUsbPdbExportMetadata = (db: UsbPdbContainer, row: UsbPdbRow): void => {
  db.requireRowBytes(row, 0, 31)
  if (
    db.u16(row, 0) !== 0x280 ||
    db.u32(row, 8) !== 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(db.string(row, 12)) ||
    db.u8(row, 23) !== 25 ||
    db.u8(row, 24) !== 30 ||
    db.string(row, 25) !== '1000' ||
    db.string(row, 30) !== ''
  ) {
    throw new Error('Cannot edit USB DeviceSQL database: unsupported export metadata layout')
  }
}
