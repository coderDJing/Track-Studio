import fs from 'fs-extra'
import path from 'node:path'
import { getLibraryDb } from '../libraryDb'
import { getSetCustodyDirAbs } from '../services/setCustody'
import { recycleOrphanedSetCustodyFiles } from '../ipc/setListHandlers'
import { isPathBusyForRemoteMutation } from '../curatedLibrarySync/busyPaths'
import type { SetItemRecord } from '../setListDb'
import { tryBeginLibraryMaintenanceMutation } from '../services/libraryMerge/mutationGate'

const KEY = 'set_library_sync_pending_cleanup_v1'
export function queueSetSyncCleanup(items: SetItemRecord[]): void {
  const db = getLibraryDb()
  if (!db) throw new Error('SET_SYNC_LIBRARY_NOT_READY')
  const previous = db.prepare<{ value: string }>('SELECT value FROM meta WHERE key = ?').get(KEY)
  const raw: unknown = previous ? JSON.parse(previous.value) : []
  if (!Array.isArray(raw)) throw new Error('SET_SYNC_INVALID_CLEANUP_STATE')
  if (items.length === 0 && raw.length === 0) return
  const merged = new Map<string, SetItemRecord>()
  for (const item of [...raw, ...items]) {
    if (item && typeof item === 'object' && typeof item.filePath === 'string')
      merged.set(item.filePath, item)
  }
  db.prepare(
    'INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(KEY, JSON.stringify([...merged.values()]))
}
export async function cleanupSetSyncCustody(): Promise<void> {
  const release = tryBeginLibraryMaintenanceMutation()
  if (!release) return
  try {
    await runCleanup()
  } finally {
    release()
  }
}
async function runCleanup(): Promise<void> {
  const db = getLibraryDb()
  if (!db) return
  const saved = db.prepare<{ value: string }>('SELECT value FROM meta WHERE key = ?').get(KEY)
  if (!saved) return
  const items: SetItemRecord[] = JSON.parse(saved.value)
  if (!items.length) return
  const custody = path.resolve(getSetCustodyDirAbs())
  const pending: SetItemRecord[] = []
  for (const item of items) {
    const file = path.resolve(item.filePath)
    const rel = path.relative(custody, file)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    if (isPathBusyForRemoteMutation(file)) {
      pending.push(item)
      continue
    }
    await recycleOrphanedSetCustodyFiles([item])
    if (await fs.pathExists(file)) {
      const references = db
        .prepare<{ count: number }>(
          'SELECT COUNT(*) AS count FROM set_items WHERE frkb_file_path_key(file_path)=frkb_file_path_key(?)'
        )
        .get(file)
      if (!references?.count) pending.push(item)
    }
  }
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(pending), KEY)
}
