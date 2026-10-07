import { UsbPdbContainer, type UsbPdbRow } from './usbPdbContainer'
import { isKnownUsbPdbSettingsTable, validateUsbPdbExportMetadata } from './usbPdbSettings'
import { pruneUsbPdbBankTracks, readUsbPdbBanks } from './usbPdbBanks'
import type { UsbLibraryMutation, UsbLibrarySnapshot } from './usbWriteModel'

const TRACKS = 0
const PLAYLISTS = 7
const ENTRIES = 8
const HISTORY_ENTRIES = 12
const ARTWORK = 13

const requireInvariant = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Cannot edit USB DeviceSQL database: ${message}`)
}

const uniqueIds = (ids: number[], field: string): Set<number> => {
  requireInvariant(
    ids.every((id) => Number.isInteger(id) && id > 0 && id <= 0xffffffff),
    `${field} contains invalid IDs`
  )
  const set = new Set(ids)
  requireInvariant(set.size === ids.length, `${field} contains duplicate IDs`)
  return set
}

export class UsbPdbEditor {
  private db: UsbPdbContainer

  constructor(bytes: Buffer) {
    this.db = new UsbPdbContainer(bytes)
    this.snapshot()
  }

  snapshot(): UsbLibrarySnapshot {
    return this.readSnapshot(this.db)
  }

  private readSnapshot(db: UsbPdbContainer): UsbLibrarySnapshot {
    for (const table of [TRACKS, PLAYLISTS, ENTRIES]) {
      requireInvariant(db.hasTable(table), `required table ${table} missing`)
    }
    const artwork = new Map<number, string>()
    for (const row of db.rows(ARTWORK)) {
      const id = db.u32(row, 0)
      requireInvariant(id > 0 && !artwork.has(id), 'duplicate or zero artwork ID')
      artwork.set(id, db.string(row, 4))
    }
    const tracks = db.rows(TRACKS).map((row) => {
      db.requireRowBytes(row, 0, 0x88)
      requireInvariant(db.u16(row, 0) === 0x24, 'unsupported track row subtype')
      const artworkId = db.u32(row, 0x1c)
      requireInvariant(!artworkId || artwork.has(artworkId), 'track references missing artwork')
      const readTrackString = (slot: number): string => {
        const offset = db.u16(row, 0x5e + 2 * slot)
        requireInvariant(offset >= 0x88, 'track string points into fixed fields')
        return db.string(row, offset)
      }
      return {
        id: db.u32(row, 0x48),
        filePath: readTrackString(20),
        analyzePath: readTrackString(14),
        artworkPath: artwork.get(artworkId) ?? ''
      }
    })
    const trackIds = uniqueIds(
      tracks.map((track) => track.id),
      'track table'
    )
    const playlists = db.rows(PLAYLISTS).map((row) => ({
      id: db.u32(row, 12),
      parentId: db.u32(row, 0),
      name: db.string(row, 20),
      isFolder: db.u32(row, 16) !== 0
    }))
    uniqueIds(
      playlists.map((playlist) => playlist.id),
      'playlist table'
    )
    const playlistMap = new Map(playlists.map((playlist) => [playlist.id, playlist]))
    for (const playlist of playlists) {
      let parent = playlist.parentId
      const visited = new Set([playlist.id])
      while (parent) {
        const parentNode = playlistMap.get(parent)
        requireInvariant(!!parentNode?.isFolder, 'playlist references missing parent folder')
        requireInvariant(!visited.has(parent), 'cycle in playlist hierarchy')
        visited.add(parent)
        parent = parentNode!.parentId
      }
    }
    const positions = new Set<string>()
    const entries = db.rows(ENTRIES).map((row) => {
      const entry = {
        playlistId: db.u32(row, 8),
        trackId: db.u32(row, 4),
        entryIndex: db.u32(row, 0)
      }
      requireInvariant(trackIds.has(entry.trackId), 'playlist entry references missing track')
      requireInvariant(
        playlistMap.has(entry.playlistId) && !playlistMap.get(entry.playlistId)!.isFolder,
        'playlist entry references missing playlist or folder'
      )
      requireInvariant(entry.entryIndex > 0, 'zero playlist entry position')
      const key = `${entry.playlistId}:${entry.entryIndex}`
      requireInvariant(!positions.has(key), 'duplicate playlist entry position')
      positions.add(key)
      return entry
    })
    // Histories do not retain deleted audio, but their live references must be
    // accounted for so a deletion never leaves dangling rows behind.
    const historyIds = new Set(db.rows(11).map((row) => db.u32(row, 0)))
    for (const row of db.rows(HISTORY_ENTRIES)) {
      requireInvariant(trackIds.has(db.u32(row, 0)), 'history entry references missing track')
      requireInvariant(historyIds.has(db.u32(row, 4)), 'history entry references missing history')
    }
    const bankTracks = readUsbPdbBanks(db, trackIds).members.map((member) => member.trackId)
    return {
      tracks,
      playlists,
      entries,
      ...(bankTracks.length ? { protectedTrackIds: [...new Set(bankTracks)] } : {})
    }
  }

  /** Each apply is atomic in memory; failed validation preserves the original bytes. */
  apply(mutation: UsbLibraryMutation): void {
    const candidate = new UsbPdbContainer(this.db.toBuffer())
    this.applyTo(candidate, mutation)
    candidate.refresh()
    this.readSnapshot(candidate)
    this.db = new UsbPdbContainer(candidate.toBuffer())
  }

  private applyTo(db: UsbPdbContainer, mutation: UsbLibraryMutation): void {
    const before = this.readSnapshot(db)
    const tracks = new Set(before.tracks.map((track) => track.id))
    const playlists = new Map(before.playlists.map((playlist) => [playlist.id, playlist]))
    const deletedTracks = uniqueIds(mutation.deleteTrackIds, 'deleted tracks')
    const deletedPlaylists = uniqueIds(mutation.deletePlaylistIds, 'deleted playlists')
    for (const id of deletedTracks) requireInvariant(tracks.has(id), `track ${id} missing`)
    for (const id of deletedPlaylists) requireInvariant(playlists.has(id), `playlist ${id} missing`)
    for (const playlist of before.playlists) {
      requireInvariant(
        !deletedPlaylists.has(playlist.parentId) || deletedPlaylists.has(playlist.id),
        'playlist deletion omits a descendant'
      )
    }
    if (deletedTracks.size) this.validateTrackDeletionTables(db)
    if (deletedTracks.size) pruneUsbPdbBankTracks(db, tracks, deletedTracks)
    const requirePlaylist = (id: number): void => {
      requireInvariant(
        !!playlists.get(id) && !playlists.get(id)!.isFolder && !deletedPlaylists.has(id),
        `playlist ${id} missing, a folder, or scheduled for deletion`
      )
    }
    const removed = new Map<number, Set<number>>()
    for (const removal of mutation.removals) {
      requirePlaylist(removal.playlistId)
      const ids = uniqueIds(removal.trackIds, 'removed tracks')
      const present = new Set(
        before.entries
          .filter((entry) => entry.playlistId === removal.playlistId)
          .map((entry) => entry.trackId)
      )
      for (const id of ids)
        requireInvariant(present.has(id), `track ${id} not in requested playlist`)
      const existing = removed.get(removal.playlistId) ?? new Set<number>()
      for (const id of ids) existing.add(id)
      removed.set(removal.playlistId, existing)
    }
    const compactPlaylists = new Set<number>()
    for (const row of db.rows(ENTRIES)) {
      const playlistId = db.u32(row, 8)
      const trackId = db.u32(row, 4)
      if (
        deletedPlaylists.has(playlistId) ||
        deletedTracks.has(trackId) ||
        removed.get(playlistId)?.has(trackId)
      ) {
        db.deleteRow(row)
        if (!deletedPlaylists.has(playlistId)) compactPlaylists.add(playlistId)
      }
    }
    for (const row of db.rows(PLAYLISTS)) {
      if (deletedPlaylists.has(db.u32(row, 12))) db.deleteRow(row)
    }
    for (const row of db.rows(TRACKS)) {
      if (deletedTracks.has(db.u32(row, 0x48))) db.deleteRow(row)
    }
    if (deletedTracks.size) this.pruneDeletedTrackArtwork(db, deletedTracks)
    for (const row of db.rows(HISTORY_ENTRIES)) {
      if (deletedTracks.has(db.u32(row, 0))) db.deleteRow(row)
    }
    if (deletedTracks.size) {
      for (const row of db.rows(19)) {
        validateUsbPdbExportMetadata(db, row)
        db.patchU32(row, 4, tracks.size - deletedTracks.size)
      }
    }
    db.refresh()
    // Native rekordbox compacts surviving positions after removing membership;
    // leave unrelated playlists (including existing gaps) byte-for-byte intact.
    for (const playlistId of compactPlaylists) {
      const rows = db
        .rows(ENTRIES)
        .filter((row) => db.u32(row, 8) === playlistId)
        .sort((a, b) => db.u32(a, 0) - db.u32(b, 0))
      rows.forEach((row, index) => {
        if (db.u32(row, 0) !== index + 1) db.patchU32(row, 0, index + 1)
      })
    }
    const members = new Map<number, Set<number>>()
    const nextPositions = new Map<number, number>()
    for (const row of db.rows(ENTRIES)) {
      const playlistId = db.u32(row, 8)
      const set = members.get(playlistId) ?? new Set<number>()
      set.add(db.u32(row, 4))
      members.set(playlistId, set)
      nextPositions.set(playlistId, Math.max(nextPositions.get(playlistId) ?? 0, db.u32(row, 0)))
    }
    for (const addition of mutation.additions) {
      requirePlaylist(addition.playlistId)
      uniqueIds(addition.trackIds, 'added tracks')
      const set = members.get(addition.playlistId) ?? new Set<number>()
      for (const id of addition.trackIds) {
        requireInvariant(tracks.has(id) && !deletedTracks.has(id), `track ${id} missing or deleted`)
        if (set.has(id)) continue
        const next = (nextPositions.get(addition.playlistId) ?? 0) + 1
        requireInvariant(next <= 0xffffffff, 'playlist entry positions exhausted')
        const content = Buffer.alloc(12)
        content.writeUInt32LE(next, 0)
        content.writeUInt32LE(id, 4)
        content.writeUInt32LE(addition.playlistId, 8)
        db.appendRow(ENTRIES, content)
        set.add(id)
        nextPositions.set(addition.playlistId, next)
      }
      members.set(addition.playlistId, set)
    }
    db.refresh()
    const reordered = new Set<number>()
    for (const reorder of mutation.reorders) {
      requirePlaylist(reorder.playlistId)
      requireInvariant(!reordered.has(reorder.playlistId), 'duplicate playlist reorder')
      reordered.add(reorder.playlistId)
      const requested = uniqueIds(reorder.trackIds, 'reordered tracks')
      const rows = db.rows(ENTRIES).filter((row) => db.u32(row, 8) === reorder.playlistId)
      requireInvariant(
        rows.length === requested.size && rows.every((row) => requested.has(db.u32(row, 4))),
        'reorder must specify the entire final playlist membership'
      )
      const rowMap = new Map(rows.map((row) => [db.u32(row, 4), row]))
      requireInvariant(
        rowMap.size === rows.length,
        'cannot reorder a playlist with duplicate track references'
      )
      reorder.trackIds.forEach((id, index) => db.patchU32(rowMap.get(id)!, 0, index + 1))
    }
  }

  private validateTrackDeletionTables(db: UsbPdbContainer): void {
    // Known name/settings/history-sync tables do not describe track membership.
    // Unknown schemas might; never infer their fields from integer coincidences.
    const understood = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 19])
    for (const type of db.tableTypes()) {
      requireInvariant(
        understood.has(type) || db.rows(type).length === 0 || isKnownUsbPdbSettingsTable(db, type),
        `track deletion blocked by populated unknown table ${type}`
      )
    }
  }

  private pruneDeletedTrackArtwork(db: UsbPdbContainer, deletedTracks: Set<number>): void {
    // Deep Symmetry's track layout (+0x1c) is the only artwork ID reference
    // in the understood legacy schemas. Albums contain artist/name fields;
    // playlist rows contain parent/order/name fields, neither has artwork.
    // https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html
    const rows = db.rows(ARTWORK)
    const pathsById = new Map(rows.map((row) => [db.u32(row, 0), db.string(row, 4)]))
    const affectedPaths = new Set<string>()
    const retainedIds = new Set<number>()
    const pathKey = (value: string) => value.replace(/\\/g, '/').toLowerCase()
    for (const row of db.rows(TRACKS)) {
      const artworkId = db.u32(row, 0x1c)
      if (!artworkId) continue
      if (deletedTracks.has(db.u32(row, 0x48))) {
        const artworkPath = pathsById.get(artworkId)
        if (artworkPath) affectedPaths.add(pathKey(artworkPath))
      } else retainedIds.add(artworkId)
    }
    for (const row of rows) {
      if (!retainedIds.has(db.u32(row, 0)) && affectedPaths.has(pathKey(db.string(row, 4)))) {
        db.deleteRow(row)
      }
    }
  }

  toBuffer(): Buffer {
    return this.db.toBuffer()
  }
}

/** Tag associations are ext type 4, as documented by Deep Symmetry's Kaitai schema. */
export const pruneUsbPdbExtTracks = (bytes: Buffer, deletedIds: number[]): Buffer => {
  const deleted = uniqueIds(deletedIds, 'deleted tracks')
  if (!deleted.size) return Buffer.from(bytes)
  const db = new UsbPdbContainer(bytes)
  for (const type of db.tableTypes()) {
    const rows = db.rows(type)
    if (type === 3 || type === 4 || !rows.length) continue
    // The only observed standalone ext type 7 row has no track associations.
    // Accept its documented shape, but reject different layouts and all other
    // populated unknown tables, whose references cannot safely be rewritten.
    requireInvariant(
      type === 7 && rows.every((row) => isStandaloneExtSettings(db, row)),
      `track deletion blocked by populated unknown exportExt table ${type}`
    )
  }
  for (const row of db.rows(4)) {
    db.requireRowBytes(row, 0, 16)
    requireInvariant(
      db.u32(row, 0) === 0 && db.u32(row, 12) === 3,
      'unsupported exportExt tag association layout'
    )
    if (deleted.has(db.u32(row, 4))) db.deleteRow(row)
  }
  return db.toBuffer()
}

const isStandaloneExtSettings = (db: UsbPdbContainer, row: UsbPdbRow): boolean => {
  db.requireRowBytes(row, 0, 34)
  if (db.u16(row, 0) !== 0x700) return false
  for (let offset = 4; offset < 24; offset += 4) {
    if (db.u32(row, offset) !== 0) return false
  }
  if (db.u8(row, 28) !== 3) return false
  for (let offset = 29; offset < 34; offset++) {
    const stringOffset = db.u8(row, offset)
    if (db.string(row, stringOffset) !== '') return false
  }
  return true
}
