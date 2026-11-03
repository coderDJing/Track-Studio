import { getLibraryDb, setMetaValue, type SqliteDatabase } from '../libraryDb'
import { parseSetSnapshot } from './validation'
import { emptySetSnapshot, type SetSyncSnapshot } from '../../shared/setLibrarySync'

const ENABLED = 'set_library_sync_enabled_v1'
const BASE = 'set_library_sync_base_v1'
const read = (db: SqliteDatabase, key: string): string | null =>
  db.prepare<{ value: string }>('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
export const isSetLibrarySyncEnabled = (): boolean => {
  const db = getLibraryDb()
  return !!db && read(db, ENABLED) === '1'
}
export const setSetLibrarySyncEnabled = (enabled: boolean): void => {
  const db = getLibraryDb()
  if (!db) throw new Error('SET_SYNC_LIBRARY_NOT_READY')
  setMetaValue(db, ENABLED, enabled ? '1' : '0')
  if (read(db, ENABLED) !== (enabled ? '1' : '0')) throw new Error('SET_SYNC_STATE_WRITE_FAILED')
}
export function readSetSyncBase(userKey: string): SetSyncSnapshot {
  const db = getLibraryDb()
  if (!db) throw new Error('SET_SYNC_LIBRARY_NOT_READY')
  const raw = read(db, BASE)
  if (!raw) return emptySetSnapshot()
  const saved: unknown = JSON.parse(raw)
  if (!saved || typeof saved !== 'object' || !('userKey' in saved) || saved.userKey !== userKey)
    return emptySetSnapshot()
  return parseSetSnapshot('snapshot' in saved ? saved.snapshot : null)
}
export function writeSetSyncBase(userKey: string, snapshot: SetSyncSnapshot): void {
  const db = getLibraryDb()
  if (!db) throw new Error('SET_SYNC_LIBRARY_NOT_READY')
  const raw = JSON.stringify({ userKey, snapshot })
  if (read(db, BASE) === raw) return
  setMetaValue(db, BASE, raw)
  if (read(db, BASE) !== raw) throw new Error('SET_SYNC_STATE_WRITE_FAILED')
}
