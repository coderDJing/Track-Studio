import { UsbPdbContainer, type UsbPdbRow } from './usbPdbContainer'

const ensure = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Cannot edit USB DeviceSQL Bank List: ${message}`)
}

/** Flat kind-101 Banks observed in native rekordbox 7.2.19 two-track exports/deletion. */
export const readUsbPdbBanks = (db: UsbPdbContainer, trackIds: ReadonlySet<number>) => {
  const banks = new Set<number>()
  for (const row of db.rows(9)) {
    db.requireRowBytes(row, 0, 21)
    ensure(
      db.u32(row, 0) === 0 && db.u32(row, 4) === 0 && db.u32(row, 16) === 0,
      'unsupported Bank node layout'
    )
    db.string(row, 20)
    const id = db.u32(row, 12)
    ensure(id > 0 && !banks.has(id), 'duplicate or zero Bank ID')
    banks.add(id)
  }
  const cues = new Map<number, { trackId: number; row: UsbPdbRow }>()
  for (const row of db.rows(15)) {
    ensure(row.end - row.offset === 44, 'unsupported Bank cue row size')
    ensure(
      [0, 4, 16, 20].every((offset) => db.u32(row, offset) === 0) && db.u32(row, 40) === 101,
      'unsupported Bank cue layout or kind'
    )
    const trackId = db.u32(row, 32)
    const id = db.u32(row, 36)
    ensure(trackIds.has(trackId), 'Bank cue references missing track')
    ensure(id > 0 && !cues.has(id), 'duplicate or zero Bank cue ID')
    const end = db.u32(row, 12)
    ensure(end === 0xffffffff || end > db.u32(row, 28), 'invalid Bank loop endpoint')
    cues.set(id, { trackId, row })
  }
  const slots = new Set<string>()
  const linked = new Set<number>()
  const members = db.rows(10).map((row) => {
    ensure(row.end - row.offset === 16, 'unsupported Bank member row size')
    const cueId = db.u32(row, 0)
    const slot = db.u32(row, 4)
    const trackId = db.u32(row, 8)
    const bankId = db.u32(row, 12)
    ensure(banks.has(bankId), 'Bank member references missing Bank')
    ensure(slot >= 1 && slot <= 8, 'invalid Bank slot')
    ensure(cues.get(cueId)?.trackId === trackId, 'Bank member cue/track mismatch')
    const key = `${bankId}:${slot}`
    ensure(!slots.has(key), 'duplicate Bank slot')
    slots.add(key)
    linked.add(cueId)
    return { trackId, row }
  })
  ensure(
    [...cues.keys()].every((id) => linked.has(id)),
    'Bank cue lacks member reference'
  )
  return { cues, members }
}

/** Native deletion clears the affected slot/cue, preserving Bank nodes and other slot numbers. */
export const pruneUsbPdbBankTracks = (
  db: UsbPdbContainer,
  trackIds: ReadonlySet<number>,
  deleted: ReadonlySet<number>
): void => {
  const { cues, members } = readUsbPdbBanks(db, trackIds)
  for (const member of members) if (deleted.has(member.trackId)) db.deleteRow(member.row)
  for (const cue of cues.values()) if (deleted.has(cue.trackId)) db.deleteRow(cue.row)
}
