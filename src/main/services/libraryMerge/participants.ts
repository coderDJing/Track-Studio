import { LIBRARY_MERGEABLE_METADATA_CONTRACTS } from '../../../shared/libraryMetadataContracts'
import {
  mergeMixtapeItems,
  mergeMixtapeProjects,
  mergeSetItems,
  type LibraryMergeRowTransformContext
} from './rowTransforms'

type SqliteDatabase = InstanceType<typeof import('better-sqlite3')>

export type LibraryMergeTableStrategy =
  | 'metadata'
  | 'union'
  | 'node-tree'
  | 'analysis-remap'
  | 'row-transform'
  | 'discardable'

type LibraryMergeMetadataParticipant = {
  key: string
  merge: (targetValue: string | null, sourceValue: string) => string
}

type LibraryMergeRowTransform = (context: LibraryMergeRowTransformContext) => number
type LibraryMergeUnionRows = (sourceDb: SqliteDatabase, targetDb: SqliteDatabase) => number

export type LibraryMergeTableParticipant = {
  table: string
  strategy: LibraryMergeTableStrategy
  metadata?: readonly LibraryMergeMetadataParticipant[]
  rowTransform?: LibraryMergeRowTransform
  unionRows?: LibraryMergeUnionRows
}

export class LibraryMergeParticipantContractError extends Error {
  constructor(tableNames: string[]) {
    super(`数据库表未声明合并策略：${tableNames.join(', ')}`)
    this.name = 'LibraryMergeParticipantContractError'
  }
}

function mergeCuratedSyncFileRows(sourceDb: SqliteDatabase, targetDb: SqliteDatabase): number {
  if (!hasTable(sourceDb, 'curated_sync_files') || !hasTable(targetDb, 'curated_sync_files')) {
    return 0
  }
  const rows = sourceDb
    .prepare(
      `SELECT file_id, relative_path, parent_uuid, file_name, content_sha256, content_size,
              mtime_ms, track_number, added_at_ms, updated_at_ms, location, location_path
       FROM curated_sync_files`
    )
    .all() as Array<Record<string, unknown>>
  const insert = targetDb.prepare(
    `INSERT OR IGNORE INTO curated_sync_files (
       file_id, relative_path, parent_uuid, file_name, content_sha256, content_size,
       mtime_ms, track_number, added_at_ms, updated_at_ms, location, location_path
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  let merged = 0
  for (const row of rows) {
    const fileId = typeof row.file_id === 'string' ? row.file_id.trim() : ''
    if (!fileId) continue
    const result = insert.run(
      fileId,
      typeof row.relative_path === 'string' ? row.relative_path : '',
      typeof row.parent_uuid === 'string' ? row.parent_uuid : '',
      typeof row.file_name === 'string' ? row.file_name : '',
      typeof row.content_sha256 === 'string' ? row.content_sha256 : '',
      Number(row.content_size) || 0,
      row.mtime_ms == null ? null : Number(row.mtime_ms),
      row.track_number == null ? null : Number(row.track_number),
      row.added_at_ms == null ? null : Number(row.added_at_ms),
      Number(row.updated_at_ms) || 0,
      typeof row.location === 'string' ? row.location : 'curated',
      typeof row.location_path === 'string' ? row.location_path : null
    )
    merged += Number(result.changes || 0)
  }
  return merged
}

function mergeFingerprintRows(sourceDb: SqliteDatabase, targetDb: SqliteDatabase): number {
  if (!hasTable(sourceDb, 'fingerprints') || !hasTable(targetDb, 'fingerprints')) return 0
  const rows = sourceDb.prepare('SELECT mode, hash FROM fingerprints').all() as Array<
    Record<string, unknown>
  >
  const insert = targetDb.prepare('INSERT OR IGNORE INTO fingerprints (mode, hash) VALUES (?, ?)')
  let merged = 0
  for (const row of rows) {
    const mode = typeof row.mode === 'string' ? row.mode : ''
    const hash = typeof row.hash === 'string' ? row.hash : ''
    if (!mode || !hash) continue
    const result = insert.run(mode, hash)
    merged += Number(result.changes || 0)
  }
  return merged
}

// Every persistent SQLite table must be registered here. New tables are rejected during
// preflight until their owner explicitly chooses a safe merge strategy; they are never skipped.
export const LIBRARY_MERGE_TABLE_PARTICIPANTS: readonly LibraryMergeTableParticipant[] = [
  {
    table: 'meta',
    strategy: 'metadata',
    metadata: LIBRARY_MERGEABLE_METADATA_CONTRACTS.map((contract) => ({
      key: contract.key,
      merge: contract.merge
    }))
  },
  { table: 'fingerprints', strategy: 'union', unionRows: mergeFingerprintRows },
  { table: 'curated_sync_files', strategy: 'union', unionRows: mergeCuratedSyncFileRows },
  { table: 'library_nodes', strategy: 'node-tree' },
  // Despite its historic name, song_cache carries the persistent song metadata and completed
  // analysis results that FRKB must retain after a merge.
  { table: 'song_cache', strategy: 'analysis-remap' },
  { table: 'cover_index', strategy: 'discardable' },
  { table: 'waveform_cache', strategy: 'discardable' },
  { table: 'compact_visual_waveform_cache', strategy: 'discardable' },
  { table: 'unified_display_waveform_cache', strategy: 'discardable' },
  { table: 'waveform_surface_cache', strategy: 'discardable' },
  { table: 'pioneer_preview_waveform_cache', strategy: 'discardable' },
  // Playlist view snapshots are per-machine derived rows: list_root and identity_digest describe
  // this machine's files, and the snapshot only ever serves reads. Importing another library's
  // snapshots would be meaningless at best, so they are dropped and rebuilt by the next scan.
  { table: 'playlist_view_snapshot', strategy: 'discardable' },
  { table: 'set_items', strategy: 'row-transform', rowTransform: mergeSetItems },
  { table: 'mixtape_items', strategy: 'row-transform', rowTransform: mergeMixtapeItems },
  { table: 'mixtape_projects', strategy: 'row-transform', rowTransform: mergeMixtapeProjects },
  { table: 'recycle_bin_records', strategy: 'discardable' },
  { table: 'mixtape_waveform_cache', strategy: 'discardable' },
  { table: 'mixtape_raw_waveform_cache', strategy: 'discardable' },
  { table: 'mixtape_stem_assets', strategy: 'discardable' },
  { table: 'mixtape_stem_waveform_cache', strategy: 'discardable' },
  { table: 'library_stem_assets', strategy: 'discardable' },
  { table: 'external_analysis_devices', strategy: 'discardable' },
  { table: 'external_analysis_cache', strategy: 'discardable' }
]

export const LIBRARY_MERGE_KNOWN_TABLES = new Set(
  LIBRARY_MERGE_TABLE_PARTICIPANTS.map((participant) => participant.table)
)

export const assertLibraryMergeParticipantCoverage = (db: SqliteDatabase): void => {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
    .all() as Array<Record<string, unknown>>
  const unregistered = rows
    .map((row) => (typeof row.name === 'string' ? row.name : ''))
    .filter((name) => name && !name.startsWith('sqlite_'))
    .filter((name) => !LIBRARY_MERGE_KNOWN_TABLES.has(name))
  if (unregistered.length === 0) return
  throw new LibraryMergeParticipantContractError(unregistered)
}

export const LIBRARY_MERGE_ANALYSIS_TABLES = LIBRARY_MERGE_TABLE_PARTICIPANTS.filter(
  (participant) => participant.strategy === 'analysis-remap'
).map((participant) => participant.table)

const hasTable = (db: SqliteDatabase, tableName: string): boolean => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as Record<string, unknown> | undefined
  return typeof row?.name === 'string'
}

const readMetaValue = (db: SqliteDatabase, key: string): string | null => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ? LIMIT 1').get(key) as
    | Record<string, unknown>
    | undefined
  return typeof row?.value === 'string' ? row.value : null
}

export const mergeRegisteredLibraryMetadata = (
  sourceDb: SqliteDatabase,
  targetDb: SqliteDatabase
): number => {
  const metaParticipant = LIBRARY_MERGE_TABLE_PARTICIPANTS.find(
    (participant) => participant.table === 'meta'
  )
  if (!metaParticipant?.metadata || !hasTable(sourceDb, 'meta') || !hasTable(targetDb, 'meta')) {
    return 0
  }
  const upsert = targetDb.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  let merged = 0
  for (const participant of metaParticipant.metadata) {
    const sourceValue = readMetaValue(sourceDb, participant.key)
    if (sourceValue === null) continue
    const targetValue = readMetaValue(targetDb, participant.key)
    upsert.run(participant.key, participant.merge(targetValue, sourceValue))
    merged += 1
  }
  return merged
}

export const mergeRegisteredLibraryUnionRows = (
  sourceDb: SqliteDatabase,
  targetDb: SqliteDatabase
): number => {
  let merged = 0
  for (const participant of LIBRARY_MERGE_TABLE_PARTICIPANTS) {
    if (participant.strategy === 'union' && participant.unionRows) {
      merged += participant.unionRows(sourceDb, targetDb)
    }
  }
  return merged
}

export const mergeRegisteredLibraryRowTransforms = (
  context: LibraryMergeRowTransformContext
): number => {
  let merged = 0
  for (const participant of LIBRARY_MERGE_TABLE_PARTICIPANTS) {
    if (participant.strategy === 'row-transform' && participant.rowTransform) {
      merged += participant.rowTransform(context)
    }
  }
  return merged
}
