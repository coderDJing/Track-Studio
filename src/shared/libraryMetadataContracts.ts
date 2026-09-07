import {
  CURATED_ARTIST_LIBRARY_META_KEY,
  mergeStoredCuratedArtistLibrary
} from './curatedArtistLibraryMerge'

type LibraryMetadataMerge = (targetValue: string | null, sourceValue: string) => string

type ExactLibraryMetadataContract = {
  kind: 'exact'
  key: string
  strategy: 'local' | 'merge'
  merge?: LibraryMetadataMerge
}

type PrefixLibraryMetadataContract = {
  kind: 'prefix'
  prefix: string
  strategy: 'local'
}

export type LibraryMetadataContract = ExactLibraryMetadataContract | PrefixLibraryMetadataContract

export class LibraryMetadataContractError extends Error {
  constructor(key: string) {
    super(`未声明的库 meta key：${String(key || '').trim()}`)
    this.name = 'LibraryMetadataContractError'
  }
}

// This is the only registry for persistent meta keys. A new key must choose whether it is
// local-only or merged, and a mergeable key must provide an explicit merge function.
export const LIBRARY_METADATA_CONTRACTS: readonly LibraryMetadataContract[] = [
  {
    kind: 'exact',
    key: CURATED_ARTIST_LIBRARY_META_KEY,
    strategy: 'merge',
    merge: mergeStoredCuratedArtistLibrary
  },
  { kind: 'exact', key: 'library_setting_fingerprint_mode', strategy: 'local' },
  { kind: 'exact', key: 'library_setting_audio_ext', strategy: 'local' },
  { kind: 'exact', key: 'library_setting_persist_song_filters', strategy: 'local' },
  { kind: 'exact', key: 'library_setting_cloud_sync_user_key', strategy: 'local' },
  { kind: 'exact', key: 'library_setting_cloud_sync_auto_enabled', strategy: 'local' },
  { kind: 'exact', key: 'library_setting_cloud_sync_auto_interval_ms', strategy: 'local' },
  { kind: 'exact', key: 'library_setting_curated_library_sync_enabled', strategy: 'local' },
  { kind: 'exact', key: 'curated_library_sync_last_applied_revision', strategy: 'local' },
  { kind: 'exact', key: 'curated_library_sync_deferred_ops_v1', strategy: 'local' },
  { kind: 'exact', key: 'curated_library_sync_last_cloud_ids_v1', strategy: 'local' },
  { kind: 'exact', key: 'curated_library_sync_last_snapshot_v1', strategy: 'local' },
  { kind: 'exact', key: 'curated_library_sync_last_conflicts_v1', strategy: 'local' },
  { kind: 'exact', key: 'curated_library_sync_last_failures_v1', strategy: 'local' },
  { kind: 'exact', key: 'curated_library_sync_last_quota_v1', strategy: 'local' },
  { kind: 'exact', key: 'curated_library_sync_pending_deleted_nodes_v1', strategy: 'local' },
  { kind: 'exact', key: 'curated_library_sync_pending_join_mode_v1', strategy: 'local' },
  { kind: 'exact', key: 'cache_key_relative_migrated_v1', strategy: 'local' },
  { kind: 'exact', key: 'cache_key_relative_migrated_v2', strategy: 'local' },
  { kind: 'exact', key: 'library_tree_migration_done_v1', strategy: 'local' },
  { kind: 'exact', key: 'library_tree_migration_in_progress_v1', strategy: 'local' },
  { kind: 'exact', key: 'library_tree_legacy_archive_done_v1', strategy: 'local' },
  { kind: 'exact', key: 'legacy_migration_done_v1', strategy: 'local' },
  { kind: 'exact', key: 'legacy_migration_in_progress_v1', strategy: 'local' },
  { kind: 'exact', key: 'legacy_cache_migrated_v1', strategy: 'local' },
  { kind: 'exact', key: 'waveform_cache_purged_v1', strategy: 'local' },
  { kind: 'exact', key: 'recycle_bin_migrated_v1', strategy: 'local' },
  { kind: 'prefix', prefix: 'fingerprints_migrated_', strategy: 'local' },
  { kind: 'prefix', prefix: 'fingerprints_collection_hash_cache_', strategy: 'local' },
  { kind: 'prefix', prefix: 'library_merge.', strategy: 'local' }
]

const isMergeableLibraryMetadataContract = (
  contract: LibraryMetadataContract
): contract is ExactLibraryMetadataContract & {
  strategy: 'merge'
  merge: LibraryMetadataMerge
} =>
  contract.kind === 'exact' && contract.strategy === 'merge' && typeof contract.merge === 'function'

export const LIBRARY_MERGEABLE_METADATA_CONTRACTS = LIBRARY_METADATA_CONTRACTS.filter(
  isMergeableLibraryMetadataContract
)

const getLibraryMetadataContract = (key: string): LibraryMetadataContract | null => {
  const normalizedKey = String(key || '').trim()
  if (!normalizedKey) return null
  for (const contract of LIBRARY_METADATA_CONTRACTS) {
    if (contract.kind === 'exact' && contract.key === normalizedKey) return contract
    if (contract.kind === 'prefix' && normalizedKey.startsWith(contract.prefix)) return contract
  }
  return null
}

export const isRegisteredLibraryMetadataKey = (key: string): boolean =>
  getLibraryMetadataContract(key) !== null

export const assertRegisteredLibraryMetadataKey = (key: string): void => {
  if (isRegisteredLibraryMetadataKey(key)) return
  throw new LibraryMetadataContractError(key)
}
