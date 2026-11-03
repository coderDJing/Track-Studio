import fs from 'fs-extra'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getLibraryDb, initLibraryDb, getMetaValue, setMetaValue } from '../libraryDb'
import store from '../store'
import { invalidateLibraryNodeCache } from '../libraryNodeCache'
import type { SetLocalScan } from './scan'
import { SET_SYNC_ROOT, sameSetValue, type SetSyncSnapshot } from '../../shared/setLibrarySync'

type Action = { kind: 'move'; from: string; to: string } | { kind: 'create'; dir: string }
type Journal = { id: string; actions: Action[] }
const COMMITTED = 'set_library_sync_tree_transaction_v1'

function rollback(journal: Journal): void {
  for (const action of [...journal.actions].reverse()) {
    if (action.kind === 'move') {
      if (fs.existsSync(action.to) && !fs.existsSync(action.from)) {
        fs.mkdirSync(path.dirname(action.from), { recursive: true })
        fs.renameSync(action.to, action.from)
      }
    } else if (fs.existsSync(action.dir)) {
      const entries = fs.readdirSync(action.dir)
      if (!entries.every((name) => name === '.frkb.uuid'))
        throw new Error('SET_SYNC_RECOVERY_DIRECTORY_NOT_EMPTY')
      for (const name of entries) fs.unlinkSync(path.join(action.dir, name))
      fs.rmdirSync(action.dir)
    }
  }
}

export async function recoverSetTreeTransaction(libraryDir = store.databaseDir): Promise<void> {
  if (!libraryDir) return
  const root = path.join(libraryDir, '.set-sync-cache')
  const file = path.join(root, 'tree-journal.json')
  if (!fs.existsSync(file)) return
  const journal: Journal = fs.readJSONSync(file)
  const db = initLibraryDb(libraryDir)
  if (!db) throw new Error('SET_SYNC_LIBRARY_NOT_READY')
  // Only paths generated inside this library may be touched during recovery.
  const libraryRoot = path.resolve(root, '..') + path.sep
  const inside = (p: string) => path.resolve(p).startsWith(libraryRoot)
  if (
    !journal ||
    !Array.isArray(journal.actions) ||
    !journal.actions.every((a) =>
      a.kind === 'move' ? inside(a.from) && inside(a.to) : a.kind === 'create' && inside(a.dir)
    )
  )
    throw new Error('SET_SYNC_INVALID_RECOVERY_JOURNAL')
  if (getMetaValue(db, COMMITTED) !== journal.id) rollback(journal)
  fs.unlinkSync(file)
  invalidateLibraryNodeCache()
}

/** Filesystem changes and SQLite writes share a recoverable journal; no await enters the commit. */
export function commitSetTree(
  local: SetLocalScan,
  target: SetSyncSnapshot,
  writeDatabase: () => void
): void {
  const db = getLibraryDb()
  if (!db) throw new Error('SET_SYNC_LIBRARY_NOT_READY')
  if (sameSetValue(local.snapshot.nodes, target.nodes)) {
    db.transaction(writeDatabase)()
    return
  }
  const journal: Journal = { id: randomUUID(), actions: [] }
  const root = path.dirname(local.directory)
  const journalPath = path.join(root, 'tree-journal.json')
  const backup = path.join(root, `tree-${journal.id}`)
  fs.mkdirSync(backup)
  const save = () => {
    const temporary = `${journalPath}.tmp`
    fs.writeJsonSync(temporary, journal)
    fs.renameSync(temporary, journalPath)
  }
  const move = (from: string, to: string) => {
    if (fs.existsSync(to)) throw new Error('SET_SYNC_DIRECTORY_COLLISION')
    journal.actions.push({ kind: 'move', from, to })
    save()
    fs.renameSync(from, to)
  }
  try {
    save()
    // Detach children first so retained directories keep their own files and UUID marker.
    for (const n of [...local.snapshot.nodes].sort(
      (a, b) => local.nodePaths.get(b.id)!.length - local.nodePaths.get(a.id)!.length
    )) {
      move(local.nodePaths.get(n.id)!, path.join(backup, n.id))
    }
    const paths = new Map([[SET_SYNC_ROOT, local.rootPath]])
    const pending = [...target.nodes]
    while (pending.length) {
      const index = pending.findIndex((n) => paths.has(n.parentId))
      if (index < 0) throw new Error('SET_SYNC_INVALID_TOPOLOGY')
      const n = pending.splice(index, 1)[0]
      const dest = path.join(paths.get(n.parentId)!, n.name)
      if (n.parentId === SET_SYNC_ROOT && n.name.toLowerCase() === '__set_custody__')
        throw new Error('SET_SYNC_RESERVED_NAME')
      const saved = path.join(backup, n.id)
      if (fs.existsSync(saved)) move(saved, dest)
      else {
        if (fs.existsSync(dest)) throw new Error('SET_SYNC_DIRECTORY_COLLISION')
        journal.actions.push({ kind: 'create', dir: dest })
        save()
        fs.mkdirSync(dest)
        fs.writeFileSync(path.join(dest, '.frkb.uuid'), n.id)
      }
      paths.set(n.id, dest)
    }
    db.transaction(() => {
      writeDatabase()
      setMetaValue(db, COMMITTED, journal.id)
      if (getMetaValue(db, COMMITTED) !== journal.id) throw new Error('SET_SYNC_STATE_WRITE_FAILED')
    })()
  } catch (error) {
    rollback(journal)
    fs.unlinkSync(journalPath)
    throw error
  }
  // Deleted containers stay in the recovery directory; source audio is never removed here.
  fs.unlinkSync(journalPath)
  invalidateLibraryNodeCache()
}
