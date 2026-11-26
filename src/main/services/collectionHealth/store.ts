import { getLibraryDb, type SqliteDatabase } from '../../libraryDb'
import { mainFilePathKey } from '../../filePathComparison'
import { resolveAbsoluteFilePath } from '../../libraryCacheDb/pathResolvers'
import type { CollectionHealthCheck } from '../../../shared/collectionHealth'
import { sortFingerprintPair } from './fingerprint'

export type CollectionHealthProbe = {
  listRoot: string
  filePath: string
  size: number
  mtimeMs: number
  /** null = 探测失败/未知，不能当作“无封面”。 */
  hasCover: boolean | null
  fingerprint: string | null
}

type ProbeRow = {
  list_root: string
  file_path: string
  size: number
  mtime_ms: number
  has_cover: number
  fingerprint: string | null
}

type IgnoreRow = {
  list_root: string
  file_path: string
  check_name: string
}

export const ignoreKey = (listRoot: string, filePath: string, check: CollectionHealthCheck) =>
  `${mainFilePathKey(listRoot)}\u0000${mainFilePathKey(filePath)}\u0000${check}`

const db = (): SqliteDatabase => {
  const instance = getLibraryDb()
  if (!instance) throw new Error('COLLECTION_HEALTH_NO_LIBRARY_DB')
  return instance
}

export function readProbe(
  listRoot: string,
  filePath: string,
  size: number,
  mtimeMs: number
): CollectionHealthProbe | null {
  const row = db()
    .prepare<ProbeRow>(
      `SELECT list_root, file_path, size, mtime_ms, has_cover, fingerprint
         FROM collection_health_probes
        WHERE frkb_file_path_key(list_root) = frkb_file_path_key(?)
          AND frkb_file_path_key(file_path) = frkb_file_path_key(?)`
    )
    .get(listRoot, filePath)
  return row ? toProbe(row) : null
}

export function isProbeFresh(probe: CollectionHealthProbe, size: number, mtimeMs: number): boolean {
  return probe.size === size && Math.abs(probe.mtimeMs - mtimeMs) <= 1
}

/** 按歌单根批量读探针；比较交给调用方，一次扫描只查 N 个歌单而不是每首歌一次。 */
export function loadProbes(listRootKeys: string[]): CollectionHealthProbe[] {
  const roots = [...new Set(listRootKeys.map((value) => mainFilePathKey(value)).filter(Boolean))]
  if (roots.length === 0) return []
  const stmt = db().prepare<ProbeRow>(
    `SELECT list_root, file_path, size, mtime_ms, has_cover, fingerprint
       FROM collection_health_probes
      WHERE frkb_file_path_key(list_root) = frkb_file_path_key(?)`
  )
  const result: CollectionHealthProbe[] = []
  for (const root of roots) {
    for (const row of stmt.all(root)) result.push(toProbe(row))
  }
  return result
}

const toProbe = (row: ProbeRow): CollectionHealthProbe => ({
  listRoot: row.list_root,
  filePath: row.file_path,
  size: Number(row.size),
  mtimeMs: Number(row.mtime_ms),
  hasCover: Number(row.has_cover) === 1 ? true : Number(row.has_cover) === 0 ? false : null,
  fingerprint: row.fingerprint || null
})

export function writeProbe(probe: CollectionHealthProbe): void {
  db()
    .prepare(
      `INSERT INTO collection_health_probes
         (list_root, file_path, size, mtime_ms, has_cover, fingerprint, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(list_root, file_path) DO UPDATE SET
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         has_cover = excluded.has_cover,
         fingerprint = excluded.fingerprint,
         updated_at_ms = excluded.updated_at_ms`
    )
    .run(
      probe.listRoot,
      probe.filePath,
      probe.size,
      probe.mtimeMs,
      probe.hasCover === true ? 1 : probe.hasCover === false ? 0 : -1,
      probe.fingerprint,
      Date.now()
    )
}

/** 指纹写入会让判重结果变化，调用方据此决定是否重发快照。 */
export function writeFingerprint(
  listRoot: string,
  filePath: string,
  size: number,
  mtimeMs: number,
  fingerprint: string
): void {
  db()
    .prepare(
      `UPDATE collection_health_probes
          SET fingerprint = ?, updated_at_ms = ?
        WHERE frkb_file_path_key(list_root) = frkb_file_path_key(?)
          AND frkb_file_path_key(file_path) = frkb_file_path_key(?)`
    )
    .run(fingerprint, Date.now(), listRoot, filePath)
}

export function loadIgnoreKeys(rows: IgnoreRow[]): Set<string> {
  const keys = new Set<string>()
  for (const row of rows) {
    keys.add(ignoreKey(row.list_root, row.file_path, row.check_name as CollectionHealthCheck))
  }
  return keys
}

export function loadIgnoreRows(listRootKeys: string[]): IgnoreRow[] {
  if (listRootKeys.length === 0) return []
  const stmt = db().prepare<IgnoreRow>(
    `SELECT list_root, file_path, check_name FROM collection_health_ignored
      WHERE frkb_file_path_key(list_root) = frkb_file_path_key(?)`
  )
  const rows: IgnoreRow[] = []
  for (const root of listRootKeys) rows.push(...stmt.all(root))
  return rows
}

export function addIgnore(
  listRoot: string,
  filePath: string,
  check: CollectionHealthCheck,
  nowMs = Date.now()
): void {
  db()
    .prepare(
      `INSERT INTO collection_health_ignored (list_root, file_path, check_name, created_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(list_root, file_path, check_name) DO UPDATE SET created_at_ms = excluded.created_at_ms`
    )
    .run(listRoot, filePath, check, nowMs)
}

export function removeIgnore(
  listRoot: string,
  filePath: string,
  check: CollectionHealthCheck
): void {
  db()
    .prepare(
      `DELETE FROM collection_health_ignored
        WHERE list_root = ? AND file_path = ? AND check_name = ?`
    )
    .run(listRoot, filePath, check)
}

/**
 * 扫描末尾对账：删除不在当前库路径集合里的忽略记录。
 * aliveKeys 为 ignoreKey() 生成的集合。
 */
export function pruneIgnores(aliveKeys: Set<string>, listRootKeys: string[]): number {
  const rows = loadIgnoreRows(listRootKeys)
  const del = db().prepare(
    `DELETE FROM collection_health_ignored
      WHERE list_root = ? AND file_path = ? AND check_name = ?`
  )
  let removed = 0
  for (const row of rows) {
    if (
      aliveKeys.has(
        ignoreKey(row.list_root, row.file_path, row.check_name as CollectionHealthCheck)
      )
    ) {
      continue
    }
    del.run(row.list_root, row.file_path, row.check_name)
    removed += 1
  }
  return removed
}

/** 歌曲被删除/移入回收站时，按绝对路径清掉对应忽略记录。 */
export function removeIgnoresForAbsolutePaths(absPaths: string[]): number {
  if (absPaths.length === 0) return 0
  const targets = new Set(absPaths.map((value) => mainFilePathKey(value)))
  const rows = db()
    .prepare<IgnoreRow>('SELECT list_root, file_path, check_name FROM collection_health_ignored')
    .all()
  const del = db().prepare(
    `DELETE FROM collection_health_ignored
      WHERE list_root = ? AND file_path = ? AND check_name = ?`
  )
  let removed = 0
  for (const row of rows) {
    const abs = resolveAbsoluteFilePath(row.list_root, row.file_path)
    if (!abs || !targets.has(mainFilePathKey(abs))) continue
    del.run(row.list_root, row.file_path, row.check_name)
    removed += 1
  }
  return removed
}

export function loadDuplicateMutes(): Set<string> {
  const rows = db()
    .prepare<{ fingerprint_a: string; fingerprint_b: string }>(
      'SELECT fingerprint_a, fingerprint_b FROM collection_health_duplicate_mutes'
    )
    .all()
  const result = new Set<string>()
  for (const row of rows) {
    if (!row.fingerprint_a || !row.fingerprint_b) continue
    result.add(sortFingerprintPair(row.fingerprint_a, row.fingerprint_b))
  }
  return result
}

export function addDuplicateMutes(pairs: Array<[string, string]>, nowMs = Date.now()): void {
  if (pairs.length === 0) return
  const insert = db().prepare(
    `INSERT OR IGNORE INTO collection_health_duplicate_mutes
       (fingerprint_a, fingerprint_b, created_at_ms) VALUES (?, ?, ?)`
  )
  const run = db().transaction((items: Array<[string, string]>) => {
    for (const [left, right] of items) {
      if (!left || !right) continue
      const [a, b] = left <= right ? [left, right] : [right, left]
      insert.run(a, b, nowMs)
    }
  })
  run(pairs)
}
