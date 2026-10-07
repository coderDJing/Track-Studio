/**
 * DeviceSQL container editing, keeping heaps and tombstone slots intact.
 * Layout sources: Deep Symmetry's rekordbox_pdb.ksy and fragmede's FORMAT.md.
 * https://github.com/Deep-Symmetry/crate-digger/blob/main/src/main/kaitai/rekordbox_pdb.ksy
 * https://github.com/fragmede/rekordbox-pdb/blob/main/FORMAT.md
 * Writes are format-checked; CDJ/XDJ interoperability still requires device validation.
 */
const PAGE_SIZE = 4096
const HEAP_START = 0x28
const DIRECTORY_START = 0x1c

export type UsbPdbRow = {
  tableType: number
  pageIndex: number
  slot: number
  offset: number
  end: number
}

type PdbPage = {
  index: number
  tableType: number
  isIndex: boolean
  slots: number
  rows: UsbPdbRow[]
}

type PdbTable = {
  type: number
  directoryOffset: number
  pages: PdbPage[]
}

type PageTransaction = { originalSlots: number; deleted: boolean }

const directoryBytes = (slots: number) => 2 * slots + 4 * Math.ceil(slots / 16)

const ensure = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Invalid USB DeviceSQL database: ${message}`)
}

const countBits = (value: number): number => {
  let count = 0
  for (let bits = value; bits; bits >>>= 1) count += bits & 1
  return count
}

export class UsbPdbContainer {
  private bytes: Buffer
  private tables = new Map<number, PdbTable>()
  private touched = new Map<number, PageTransaction>()
  private generations = new Map<number, number>()
  private changed = false

  constructor(bytes: Buffer) {
    this.bytes = Buffer.from(bytes)
    this.parse()
  }

  private parse(): void {
    ensure(this.bytes.length >= PAGE_SIZE, 'missing file header')
    ensure(this.bytes.readUInt32LE(0) === 0, 'unsupported signature')
    ensure(this.bytes.readUInt32LE(4) === PAGE_SIZE, 'unsupported page size')
    ensure(this.bytes.length % PAGE_SIZE === 0, 'truncated page')
    const tableCount = this.bytes.readUInt32LE(8)
    ensure(DIRECTORY_START + tableCount * 16 <= PAGE_SIZE, 'table directory exceeds header')
    const nextUnused = this.bytes.readUInt32LE(12)
    // Unwritten reservations account for at most one candidate per table.
    // Reject sparse pointers that would otherwise request a huge allocation.
    ensure(
      nextUnused <= this.bytes.length / PAGE_SIZE + tableCount + 1,
      'page allocation watermark exceeds written pages and table reservations'
    )
    const claimed = new Set<number>()
    const candidates = new Set<number>()
    this.tables.clear()
    for (let i = 0; i < tableCount; i++) {
      const directoryOffset = DIRECTORY_START + i * 16
      const type = this.bytes.readUInt32LE(directoryOffset)
      ensure(!this.tables.has(type), `duplicate table ${type}`)
      const candidate = this.bytes.readUInt32LE(directoryOffset + 4)
      const first = this.bytes.readUInt32LE(directoryOffset + 8)
      const last = this.bytes.readUInt32LE(directoryOffset + 12)
      ensure(candidate > 0 && candidate < nextUnused, `table ${type} candidate out of range`)
      ensure(!candidates.has(candidate), 'shared empty candidate')
      candidates.add(candidate)
      const pages: PdbPage[] = []
      let index = first
      for (;;) {
        ensure(index > 0 && index < nextUnused, `table ${type} page out of range`)
        ensure(!claimed.has(index), `cycle or shared page ${index}`)
        claimed.add(index)
        const page = this.readPage(index, type)
        pages.push(page)
        const next = this.bytes.readUInt32LE(index * PAGE_SIZE + 12)
        if (index === last) {
          ensure(next === candidate, `table ${type} last page is not linked to empty candidate`)
          break
        }
        index = next
      }
      this.tables.set(type, { type, directoryOffset, pages })
    }
    for (const candidate of candidates) {
      ensure(!claimed.has(candidate), `empty candidate ${candidate} already used`)
    }
  }

  private readPage(index: number, tableType: number): PdbPage {
    const start = index * PAGE_SIZE
    ensure(start + PAGE_SIZE <= this.bytes.length, `missing page ${index}`)
    ensure(this.bytes.readUInt32LE(start) === 0, `page ${index} signature`)
    ensure(this.bytes.readUInt32LE(start + 4) === index, `page ${index} self pointer`)
    ensure(this.bytes.readUInt32LE(start + 8) === tableType, `page ${index} table mismatch`)
    const isIndex = (this.bytes[start + 0x1b] & 0x40) !== 0
    if (isIndex) return { index, tableType, isIndex, slots: 0, rows: [] }
    // Kaitai specifies 13 slot bits + 11 live-row bits. In particular, byte
    // 0x22 describes a previous transaction and is NOT the current slot count.
    const packed = this.bytes.readUIntLE(start + 0x18, 3)
    const slots = packed & 0x1fff
    const liveCount = packed >>> 13
    const used = this.bytes.readUInt16LE(start + 0x1e)
    const free = this.bytes.readUInt16LE(start + 0x1c)
    ensure(used % 4 === 0, `page ${index} heap alignment`)
    ensure(
      HEAP_START + used + free + directoryBytes(slots) === PAGE_SIZE,
      `page ${index} heap/directory sizes disagree`
    )
    const offsets: number[] = []
    const present: boolean[] = []
    let counted = 0
    for (let slot = 0; slot < slots; slot++) {
      const base = start + PAGE_SIZE - Math.floor(slot / 16) * 0x24
      const bit = slot % 16
      const heapOffset = this.bytes.readUInt16LE(base - 6 - bit * 2)
      ensure(heapOffset % 4 === 0 && heapOffset < used, `page ${index} row ${slot} offset`)
      ensure(
        slot === 0 || heapOffset > offsets[slot - 1],
        `page ${index} row offsets not ascending`
      )
      const live = (this.bytes.readUInt16LE(base - 4) & (1 << bit)) !== 0
      offsets.push(heapOffset)
      present.push(live)
      if (live) counted++
    }
    if (slots % 16) {
      const base = start + PAGE_SIZE - Math.floor((slots - 1) / 16) * 0x24
      ensure(
        this.bytes.readUInt16LE(base - 4) >>> (slots % 16) === 0,
        `page ${index} live bits beyond slot count`
      )
    }
    ensure(counted === liveCount, `page ${index} live-row count disagrees with bitmap`)
    const rows: UsbPdbRow[] = []
    for (let slot = 0; slot < slots; slot++) {
      if (!present[slot]) continue
      rows.push({
        tableType,
        pageIndex: index,
        slot,
        offset: start + HEAP_START + offsets[slot],
        end: start + HEAP_START + (offsets[slot + 1] ?? used)
      })
    }
    return { index, tableType, isIndex, slots, rows }
  }

  tableTypes(): number[] {
    return [...this.tables.keys()]
  }

  rows(type: number): UsbPdbRow[] {
    return this.tables.get(type)?.pages.flatMap((page) => page.rows) ?? []
  }

  hasTable(type: number): boolean {
    return this.tables.has(type)
  }

  requireRowBytes(row: UsbPdbRow, relativeOffset: number, length: number): number {
    ensure(
      relativeOffset >= 0 && length >= 0 && relativeOffset + length <= row.end - row.offset,
      `table ${row.tableType} row ${row.slot} field outside allocation`
    )
    return row.offset + relativeOffset
  }

  u16(row: UsbPdbRow, relativeOffset: number): number {
    return this.bytes.readUInt16LE(this.requireRowBytes(row, relativeOffset, 2))
  }

  u8(row: UsbPdbRow, relativeOffset: number): number {
    return this.bytes[this.requireRowBytes(row, relativeOffset, 1)]
  }

  u32(row: UsbPdbRow, relativeOffset: number): number {
    return this.bytes.readUInt32LE(this.requireRowBytes(row, relativeOffset, 4))
  }

  string(row: UsbPdbRow, relativeOffset: number): string {
    const start = this.requireRowBytes(row, relativeOffset, 1)
    const kind = this.bytes[start]
    if (kind & 1) {
      const length = (kind >>> 1) - 1
      ensure(length >= 0, 'invalid short string length')
      this.requireRowBytes(row, relativeOffset, 1 + length)
      return this.bytes.toString('latin1', start + 1, start + 1 + length)
    }
    ensure(kind === 0x40 || kind === 0x90, `unsupported DeviceSQL string kind ${kind}`)
    this.requireRowBytes(row, relativeOffset, 4)
    const length = this.bytes.readUInt16LE(start + 1)
    ensure(length >= 4, 'invalid long string length')
    this.requireRowBytes(row, relativeOffset, length)
    ensure(kind !== 0x90 || (length - 4) % 2 === 0, 'odd UTF-16 string payload')
    return this.bytes.toString(kind === 0x90 ? 'utf16le' : 'latin1', start + 4, start + length)
  }

  private touchTable(type: number): number {
    const existing = this.generations.get(type)
    if (existing !== undefined) return existing
    const table = this.tables.get(type)
    ensure(!!table, `missing table ${type}`)
    let generation = 0
    for (const page of table!.pages) {
      generation = Math.max(generation, this.bytes.readUInt32LE(page.index * PAGE_SIZE + 0x10))
    }
    ensure(generation < 0xffffffff, 'table generation exhausted')
    this.generations.set(type, ++generation)
    return generation
  }

  private touchPage(pageIndex: number, type: number): PageTransaction {
    const existing = this.touched.get(pageIndex)
    if (existing) return existing
    const start = pageIndex * PAGE_SIZE
    const slots = this.bytes.readUIntLE(start + 0x18, 3) & 0x1fff
    for (let group = 0; group < Math.ceil(slots / 16); group++) {
      this.bytes.writeUInt16LE(0, start + PAGE_SIZE - group * 0x24 - 2)
    }
    const transaction = { originalSlots: slots, deleted: false }
    this.touched.set(pageIndex, transaction)
    this.bytes.writeUInt32LE(this.touchTable(type), start + 0x10)
    this.changed = true
    return transaction
  }

  patchU32(row: UsbPdbRow, relativeOffset: number, value: number): void {
    ensure(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, 'u32 value out of range')
    const offset = this.requireRowBytes(row, relativeOffset, 4)
    if (this.bytes.readUInt32LE(offset) === value) return
    this.touchPage(row.pageIndex, row.tableType)
    this.bytes.writeUInt32LE(value, offset)
    const base = row.pageIndex * PAGE_SIZE + PAGE_SIZE - Math.floor(row.slot / 16) * 0x24
    this.bytes.writeUInt16LE(this.bytes.readUInt16LE(base - 2) | (1 << (row.slot % 16)), base - 2)
  }

  deleteRow(row: UsbPdbRow): void {
    const start = row.pageIndex * PAGE_SIZE
    const base = start + PAGE_SIZE - Math.floor(row.slot / 16) * 0x24
    const mask = this.bytes.readUInt16LE(base - 4)
    const bit = 1 << (row.slot % 16)
    if (!(mask & bit)) return
    this.touchPage(row.pageIndex, row.tableType).deleted = true
    this.bytes.writeUInt16LE(mask & ~bit, base - 4)
    this.bytes.writeUInt16LE(this.bytes.readUInt16LE(base - 2) & ~bit, base - 2)
    this.bytes[start + 0x1b] |= 0x10
    const packed = this.bytes.readUIntLE(start + 0x18, 3)
    this.bytes.writeUIntLE(packed - (1 << 13), start + 0x18, 3)
  }

  appendRow(type: number, content: Buffer): void {
    const table = this.tables.get(type)
    ensure(!!table, `missing table ${type}`)
    ensure(content.length > 0 && content.length % 4 === 0, 'row allocation must be aligned')
    ensure(HEAP_START + content.length + directoryBytes(1) <= PAGE_SIZE, 'row too large')
    let pageIndex = this.bytes.readUInt32LE(table!.directoryOffset + 12)
    let start = pageIndex * PAGE_SIZE
    let slots = this.bytes.readUIntLE(start + 0x18, 3) & 0x1fff
    let used = this.bytes.readUInt16LE(start + 0x1e)
    if (
      this.bytes[start + 0x1b] & 0x40 ||
      HEAP_START + used + content.length + directoryBytes(slots + 1) > PAGE_SIZE
    ) {
      pageIndex = this.allocatePage(table!)
      start = pageIndex * PAGE_SIZE
      slots = 0
      used = 0
    }
    this.touchPage(pageIndex, type)
    const base = start + PAGE_SIZE - Math.floor(slots / 16) * 0x24
    const bit = slots % 16
    if (!bit) this.bytes.fill(0, base - 4, base)
    content.copy(this.bytes, start + HEAP_START + used)
    this.bytes.writeUInt16LE(used, base - 6 - bit * 2)
    this.bytes.writeUInt16LE(this.bytes.readUInt16LE(base - 4) | (1 << bit), base - 4)
    this.bytes.writeUInt16LE(this.bytes.readUInt16LE(base - 2) | (1 << bit), base - 2)
    const present = this.bytes.readUIntLE(start + 0x18, 3) >>> 13
    this.bytes.writeUIntLE((slots + 1) | ((present + 1) << 13), start + 0x18, 3)
    this.bytes.writeUInt16LE(used + content.length, start + 0x1e)
    this.bytes.writeUInt16LE(
      PAGE_SIZE - HEAP_START - used - content.length - directoryBytes(slots + 1),
      start + 0x1c
    )
  }

  private allocatePage(table: PdbTable): number {
    const directory = table.directoryOffset
    const index = this.bytes.readUInt32LE(directory + 4)
    const nextUnused = this.bytes.readUInt32LE(12)
    ensure(nextUnused < 0xffffffff, 'page IDs exhausted')
    const start = index * PAGE_SIZE
    if (start < this.bytes.length) {
      ensure(
        this.bytes.subarray(start, start + PAGE_SIZE).every((byte) => byte === 0),
        `empty candidate ${index} is not empty`
      )
    }
    if (start + PAGE_SIZE > this.bytes.length) {
      this.bytes = Buffer.concat([this.bytes, Buffer.alloc(start + PAGE_SIZE - this.bytes.length)])
    }
    const generation = this.touchTable(table.type)
    this.bytes.writeUInt32LE(index, start + 4)
    this.bytes.writeUInt32LE(table.type, start + 8)
    this.bytes.writeUInt32LE(nextUnused, start + 12)
    this.bytes.writeUInt32LE(generation, start + 0x10)
    this.bytes[start + 0x1b] = 0x24
    this.bytes.writeUInt16LE(PAGE_SIZE - HEAP_START, start + 0x1c)
    const oldLast = this.bytes.readUInt32LE(directory + 12)
    const oldStart = oldLast * PAGE_SIZE
    if (this.bytes[oldStart + 0x1b] & 0x40) {
      // This understood index field links the first data page of an empty table.
      ensure(
        this.bytes.readUInt32LE(oldStart + HEAP_START + 4) === 0x03ffffff,
        'unsupported empty-table index layout'
      )
      this.bytes.writeUInt32LE(index, oldStart + HEAP_START + 4)
      this.bytes.writeUInt32LE(generation, oldStart + 0x10)
    }
    this.bytes.writeUInt32LE(index, directory + 12)
    this.bytes.writeUInt32LE(nextUnused, directory + 4)
    this.bytes.writeUInt32LE(nextUnused + 1, 12)
    this.changed = true
    return index
  }

  /** Reparse after mutations before exposing rows or accepting another operation. */
  refresh(): void {
    this.parse()
  }

  toBuffer(): Buffer {
    if (!this.changed) return Buffer.from(this.bytes)
    for (const [pageIndex, transaction] of this.touched) {
      const start = pageIndex * PAGE_SIZE
      const slots = this.bytes.readUIntLE(start + 0x18, 3) & 0x1fff
      let written = 0
      for (let group = 0; group < Math.ceil(slots / 16); group++) {
        written += countBits(this.bytes.readUInt16LE(start + PAGE_SIZE - group * 0x24 - 2))
      }
      const deleteOnly = transaction.deleted && written === 0
      this.bytes.writeUInt16LE(deleteOnly ? 0x1fff : written, start + 0x20)
      this.bytes.writeUInt16LE(deleteOnly ? 0x1fff : transaction.originalSlots, start + 0x22)
    }
    ensure(this.bytes.readUInt32LE(0x14) < 0xffffffff, 'file sequence exhausted')
    const result = Buffer.from(this.bytes)
    result.writeUInt32LE(result.readUInt32LE(0x14) + 1, 0x14)
    // Revalidate the exact output, including newly linked pages and masks.
    new UsbPdbContainer(result)
    return result
  }
}
