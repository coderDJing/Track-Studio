import path = require('path')
import fs = require('fs-extra')
import { getLibraryDb, isSqliteRow } from '../libraryDb'
import { log } from '../log'
import type { CoverIndexEntry } from './types'
import {
  resolveListRootInput,
  resolveFilePathInput,
  resolveAbsoluteListRoot,
  resolveAbsoluteFilePath
} from './pathResolvers'
import type { SqliteDatabase } from '../libraryDb'
import { runTracedSync } from '../services/mainProcessActivityTraceState'

const migratedCoverRoots = new Set<string>()
const coverIndexMigrationTasks = new Map<string, Promise<void>>()
let coverIndexDbQueue: Promise<void> = Promise.resolve()
let coverIndexDbTaskSequence = 0

type CoverIndexDbTask = {
  id: number
  name: string
  state: 'queued' | 'running'
  queuedAtMs: number
  startedAtMs?: number
}

const coverIndexDbTasks = new Map<number, CoverIndexDbTask>()

type CoverIndexMigrationJson = {
  fileToHash?: Record<string, string>
  hashToExt?: Record<string, string>
}

type CoverIndexRow = {
  list_root?: string
  file_path?: string
  hash?: string
  ext?: string
}

const enqueueCoverIndexDbTask = async <T>(name: string, task: () => Promise<T> | T): Promise<T> => {
  const diagnosticTask: CoverIndexDbTask = {
    id: ++coverIndexDbTaskSequence,
    name,
    state: 'queued',
    queuedAtMs: Date.now()
  }
  coverIndexDbTasks.set(diagnosticTask.id, diagnosticTask)
  const waitForPrevious = coverIndexDbQueue
  let releaseCurrent!: () => void
  coverIndexDbQueue = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  await waitForPrevious
  diagnosticTask.state = 'running'
  diagnosticTask.startedAtMs = Date.now()
  try {
    return await task()
  } finally {
    coverIndexDbTasks.delete(diagnosticTask.id)
    releaseCurrent()
  }
}

export const getCoverIndexDbDiagnosticSnapshot = (nowMs = Date.now()) => ({
  queued: [...coverIndexDbTasks.values()].filter((task) => task.state === 'queued').length,
  running: [...coverIndexDbTasks.values()].filter((task) => task.state === 'running').length,
  tasks: [...coverIndexDbTasks.values()]
    .map((task) => ({
      name: task.name,
      state: task.state,
      waitingMs: Math.max(0, (task.startedAtMs ?? nowMs) - task.queuedAtMs),
      runningMs: task.startedAtMs === undefined ? 0 : Math.max(0, nowMs - task.startedAtMs)
    }))
    .sort((left, right) => right.runningMs - left.runningMs || right.waitingMs - left.waitingMs)
    .slice(0, 12)
})

export function migrateCoverIndexRows(
  db: SqliteDatabase,
  oldListRoot: string,
  newListRootKey: string,
  listRootAbs: string
): number {
  try {
    const rows = db
      .prepare<CoverIndexRow>('SELECT file_path, hash, ext FROM cover_index WHERE list_root = ?')
      .all(oldListRoot)
    if (!rows || rows.length === 0) return 0
    const del = db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?')
    const update = db.prepare(
      'UPDATE cover_index SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
    )
    let moved = 0
    const run = db.transaction(() => {
      for (const row of rows) {
        const filePath = row?.file_path ? String(row.file_path) : ''
        if (!filePath) continue
        const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
        if (!resolvedFile) continue
        const newFileKey = resolvedFile.key
        del.run(newListRootKey, newFileKey)
        const result = update.run(newListRootKey, newFileKey, oldListRoot, filePath)
        moved += result?.changes ? Number(result.changes) : 0
      }
    })
    runTracedSync('sqlite:cover-index-remap', run)
    return moved
  } catch {
    return 0
  }
}

async function ensureCoverIndexMigratedInternal(
  db: SqliteDatabase,
  listRoot: string
): Promise<void> {
  const resolved = resolveListRootInput(listRoot)
  if (!resolved) return
  const listRootKey = resolved.key
  const listRootAbs = resolved.abs
  if (!listRootKey || migratedCoverRoots.has(listRootKey)) return
  const existingTask = coverIndexMigrationTasks.get(listRootKey)
  if (existingTask) {
    await existingTask
    return
  }

  const task = (async () => {
    let shouldMarkMigrated = true
    try {
      const countRow = db
        .prepare<{
          count?: number | string
        }>('SELECT COUNT(1) as count FROM cover_index WHERE list_root = ?')
        .get(listRootKey)
      if (countRow && Number(countRow.count) > 0) return
      if (!listRootAbs) return
      const indexPath = path.join(listRootAbs, '.frkb_covers', '.index.json')
      if (!(await fs.pathExists(indexPath))) return
      const json = (await fs
        .readJSON(indexPath)
        .catch(() => null)) as CoverIndexMigrationJson | null
      const fileToHash = isSqliteRow(json?.fileToHash) ? json?.fileToHash : null
      const hashToExt = isSqliteRow(json?.hashToExt) ? json?.hashToExt : null
      if (!fileToHash) return
      const rows: CoverIndexEntry[] = []
      for (const [filePath, hash] of Object.entries(fileToHash)) {
        if (!filePath || typeof hash !== 'string' || !hash) continue
        const extRaw = hashToExt?.[hash] ?? null
        const ext = typeof extRaw === 'string' && extRaw.trim() ? extRaw : '.jpg'
        const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
        if (!resolvedFile) continue
        rows.push({ filePath: resolvedFile.key, hash, ext })
      }
      if (!rows.length) return
      const insert = db.prepare(
        'INSERT OR REPLACE INTO cover_index (list_root, file_path, hash, ext) VALUES (?, ?, ?, ?)'
      )
      const run = db.transaction((items: CoverIndexEntry[]) => {
        for (const row of items) {
          insert.run(listRootKey, row.filePath, row.hash, row.ext)
        }
      })
      runTracedSync('sqlite:cover-index-json-migration', () => run(rows))
    } catch (error) {
      shouldMarkMigrated = false
      log.error('[sqlite] cover index migrate failed', error)
    } finally {
      coverIndexMigrationTasks.delete(listRootKey)
      if (shouldMarkMigrated) {
        migratedCoverRoots.add(listRootKey)
      } else {
        migratedCoverRoots.delete(listRootKey)
      }
    }
  })()

  coverIndexMigrationTasks.set(listRootKey, task)
  await task
}

export async function ensureCoverIndexMigrated(
  db: SqliteDatabase,
  listRoot: string
): Promise<void> {
  await enqueueCoverIndexDbTask('ensure-migrated', () =>
    ensureCoverIndexMigratedInternal(db, listRoot)
  )
}

export async function loadCoverIndexEntry(
  listRoot: string,
  filePath: string
): Promise<{ hash: string; ext: string } | null | undefined> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return undefined
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return undefined
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return undefined
  const fileKey = resolvedFile.key
  const fileKeyRaw = resolvedFile.keyRaw
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  const legacyFilePath = resolvedFile.legacyAbs
  try {
    return await enqueueCoverIndexDbTask('load-entry', async () => {
      await ensureCoverIndexMigratedInternal(db, listRoot)
      let row = db
        .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
        .get(listRootKey, fileKey)
      let hitListRoot = listRootKey
      let hitFilePath = fileKey
      let legacyHit = false
      if (!row && fileKeyRaw) {
        row = db
          .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
          .get(listRootKey, fileKeyRaw)
        if (row) {
          hitListRoot = listRootKey
          hitFilePath = fileKeyRaw
          legacyHit = true
        }
      }
      if (!row && legacyListRoot && legacyFilePath) {
        row = db
          .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
          .get(legacyListRoot, legacyFilePath)
        if (row) {
          hitListRoot = legacyListRoot
          hitFilePath = legacyFilePath
          legacyHit = true
        }
      }
      if (!row || !row.hash) return null
      if (legacyHit && resolvedRoot.isRelativeKey) {
        try {
          const del = db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?')
          const update = db.prepare(
            'UPDATE cover_index SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
          )
          del.run(listRootKey, fileKey)
          update.run(listRootKey, fileKey, hitListRoot, hitFilePath)
        } catch {}
      }
      return { hash: String(row.hash), ext: String(row.ext || '.jpg') }
    })
  } catch (error) {
    log.error('[sqlite] cover index load failed', error)
    return undefined
  }
}

export async function upsertCoverIndexEntry(
  listRoot: string,
  filePath: string,
  hash: string,
  ext: string
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath || !hash) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return false
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    return await enqueueCoverIndexDbTask('upsert-entry', async () => {
      await ensureCoverIndexMigratedInternal(db, listRoot)
      db.prepare(
        'INSERT INTO cover_index (list_root, file_path, hash, ext) VALUES (?, ?, ?, ?) ON CONFLICT(list_root, file_path) DO UPDATE SET hash = excluded.hash, ext = excluded.ext'
      ).run(listRootKey, resolvedFile.key, hash, ext || '.jpg')
      if (resolvedFile.keyRaw && resolvedFile.keyRaw !== resolvedFile.key) {
        db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?').run(
          listRootKey,
          resolvedFile.keyRaw
        )
      }
      if (legacyListRoot && resolvedFile.legacyAbs) {
        db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?').run(
          legacyListRoot,
          resolvedFile.legacyAbs
        )
      }
      return true
    })
  } catch (error) {
    log.error('[sqlite] cover index upsert failed', error)
    return false
  }
}

export async function replaceCoverIndexExtByHash(
  listRoot: string,
  hash: string,
  oldExt: string,
  newExt: string
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !hash || !oldExt || !newExt) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    return await enqueueCoverIndexDbTask('replace-ext-by-hash', async () => {
      await ensureCoverIndexMigratedInternal(db, listRoot)
      const update = db.prepare(
        'UPDATE cover_index SET ext = ? WHERE list_root = ? AND hash = ? AND ext = ?'
      )
      const run = db.transaction(() => {
        update.run(newExt, listRootKey, hash, oldExt)
        if (legacyListRoot) {
          update.run(newExt, legacyListRoot, hash, oldExt)
        }
      })
      run()
      return true
    })
  } catch (error) {
    log.error('[sqlite] cover index ext replacement failed', error)
    return false
  }
}

export async function removeCoverIndexEntry(
  listRoot: string,
  filePath: string
): Promise<{ hash: string; ext: string } | null | undefined> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return undefined
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return undefined
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return undefined
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    return await enqueueCoverIndexDbTask('remove-entry', async () => {
      await ensureCoverIndexMigratedInternal(db, listRoot)
      let row = db
        .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
        .get(listRootKey, resolvedFile.key)
      if (!row && resolvedFile.keyRaw) {
        row = db
          .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
          .get(listRootKey, resolvedFile.keyRaw)
      }
      if (!row && legacyListRoot && resolvedFile.legacyAbs) {
        row = db
          .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
          .get(legacyListRoot, resolvedFile.legacyAbs)
      }
      if (!row || !row.hash) return null
      db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?').run(
        listRootKey,
        resolvedFile.key
      )
      if (resolvedFile.keyRaw) {
        db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?').run(
          listRootKey,
          resolvedFile.keyRaw
        )
      }
      if (legacyListRoot && resolvedFile.legacyAbs) {
        db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?').run(
          legacyListRoot,
          resolvedFile.legacyAbs
        )
      }
      return { hash: String(row.hash), ext: String(row.ext || '.jpg') }
    })
  } catch (error) {
    log.error('[sqlite] cover index delete failed', error)
    return undefined
  }
}

export async function loadCoverIndexEntries(listRoot: string): Promise<CoverIndexEntry[] | null> {
  const db = getLibraryDb()
  if (!db || !listRoot) return null
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return null
  const listRootKey = resolvedRoot.key
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    return await enqueueCoverIndexDbTask('load-entries', async () => {
      await ensureCoverIndexMigratedInternal(db, listRoot)
      const rows = db
        .prepare<CoverIndexRow>('SELECT file_path, hash, ext FROM cover_index WHERE list_root = ?')
        .all(listRootKey)
      const legacyRows = legacyListRoot
        ? db
            .prepare<CoverIndexRow>(
              'SELECT file_path, hash, ext FROM cover_index WHERE list_root = ?'
            )
            .all(legacyListRoot)
        : []
      const toEntries = (rowsToUse: CoverIndexRow[], rootKey: string, legacyRelRoot?: string) =>
        (rowsToUse || [])
          .filter((row) => row && row.file_path && row.hash)
          .map((row) => {
            let absFilePath = resolveAbsoluteFilePath(rootKey, String(row.file_path))
            if (legacyRelRoot) {
              const resolvedLegacy = resolveFilePathInput(legacyRelRoot, String(row.file_path))
              if (resolvedLegacy && resolvedLegacy.isRelativeKey) {
                absFilePath = resolveAbsoluteFilePath(listRootKey, resolvedLegacy.key)
              }
            }
            return {
              filePath: absFilePath,
              hash: String(row.hash),
              ext: String(row.ext || '.jpg')
            }
          })
      const result = [
        ...toEntries(rows, listRootKey),
        ...toEntries(legacyRows, legacyListRoot || '', legacyListRoot)
      ]
      if (legacyRows && legacyRows.length > 0 && legacyListRoot && resolvedRoot.isRelativeKey) {
        const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
        if (listRootAbs) {
          migrateCoverIndexRows(db, legacyListRoot, listRootKey, listRootAbs)
        }
      }
      return result
    })
  } catch (error) {
    log.error('[sqlite] cover index list failed', error)
    return null
  }
}

export async function removeCoverIndexEntries(
  listRoot: string,
  filePaths: string[]
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  if (!Array.isArray(filePaths) || filePaths.length === 0) return true
  try {
    return await enqueueCoverIndexDbTask('remove-entries', async () => {
      await ensureCoverIndexMigratedInternal(db, listRoot)
      const del = db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?')
      const run = db.transaction((items: string[]) => {
        for (const fp of items) {
          const resolvedFile = resolveFilePathInput(listRootAbs, fp)
          if (!resolvedFile) continue
          del.run(listRootKey, resolvedFile.key)
          if (resolvedFile.keyRaw) {
            del.run(listRootKey, resolvedFile.keyRaw)
          }
          if (legacyListRoot && resolvedFile.legacyAbs) {
            del.run(legacyListRoot, resolvedFile.legacyAbs)
          }
        }
      })
      runTracedSync('sqlite:cover-index-bulk-delete', () => run(filePaths))
      return true
    })
  } catch (error) {
    log.error('[sqlite] cover index bulk delete failed', error)
    return false
  }
}

export async function countCoverIndexByHash(
  listRoot: string,
  hash: string
): Promise<number | null> {
  const db = getLibraryDb()
  if (!db || !listRoot || !hash) return null
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return null
  const listRootKey = resolvedRoot.key
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    return await enqueueCoverIndexDbTask('count-by-hash', async () => {
      const row = db
        .prepare('SELECT COUNT(1) as count FROM cover_index WHERE list_root = ? AND hash = ?')
        .get(listRootKey, hash)
      let total = row ? Number(row.count) : 0
      if (legacyListRoot) {
        const legacyRow = db
          .prepare('SELECT COUNT(1) as count FROM cover_index WHERE list_root = ? AND hash = ?')
          .get(legacyListRoot, hash)
        total += legacyRow ? Number(legacyRow.count) : 0
      }
      return total
    })
  } catch (error) {
    log.error('[sqlite] cover index count failed', error)
    return null
  }
}
