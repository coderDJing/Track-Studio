export type { SongCacheEntry, CoverIndexEntry, LegacyCacheRoots } from './libraryCacheDb/types'

export { resolveCacheListRootAbs, resolveCacheFilePath } from './libraryCacheDb/pathResolvers'

export {
  loadSongCache,
  loadSongCacheEntry,
  updateSongCacheKey,
  clearSongCacheAnalysisFields,
  replaceSongCache,
  upsertSongCacheEntry,
  updateSongCacheTimeBasisOffset,
  removeSongCacheEntry
} from './libraryCacheDb/songCache'

export type {
  PlaylistViewSnapshotMeta,
  PlaylistViewSnapshotRecord,
  PlaylistViewSnapshotWriteInput
} from './libraryCacheDb/playlistViewSnapshot'

export {
  normalizeSnapshotListRoot,
  loadPlaylistViewSnapshot,
  loadPlaylistViewSnapshotMeta,
  savePlaylistViewSnapshot,
  touchPlaylistViewSnapshotVerified,
  touchPlaylistViewSnapshotIdentity,
  markPlaylistViewSnapshotContentStale,
  findPlaylistViewSnapshotUuidsByRoot,
  listPlaylistViewSnapshotVerificationCandidates,
  deletePlaylistViewSnapshot,
  deletePlaylistViewSnapshotsByRoot,
  deletePlaylistViewSnapshotsUnderRoot,
  prunePlaylistViewSnapshots
} from './libraryCacheDb/playlistViewSnapshot'

export {
  loadCoverIndexEntry,
  replaceCoverIndexExtByHash,
  upsertCoverIndexEntry,
  removeCoverIndexEntry,
  loadCoverIndexEntries,
  removeCoverIndexEntries,
  countCoverIndexByHash
} from './libraryCacheDb/coverIndex'

export { getCoverIndexDbDiagnosticSnapshot } from './libraryCacheDb/coverIndex'

export { updateWaveformCacheStat, removeWaveformCacheEntry } from './libraryCacheDb/waveformCache'

export { removeCompactVisualWaveformCacheEntry } from './libraryCacheDb/compactVisualWaveformCache'

export {
  loadUnifiedDisplayWaveformCacheData,
  upsertUnifiedDisplayWaveformCacheEntry,
  updateUnifiedDisplayWaveformCacheStat,
  moveUnifiedDisplayWaveformCacheEntry,
  removeUnifiedDisplayWaveformCacheEntry
} from './libraryCacheDb/unifiedDisplayWaveformCache'

export {
  loadWaveformListPreviewCacheData,
  loadWaveformGlobalOverviewCacheData,
  hasWaveformSurfaceCacheEntryByMeta,
  loadWaveformSurfaceAvailabilityByMeta,
  upsertWaveformSurfaceCacheEntry,
  updateWaveformSurfaceCacheStat,
  moveWaveformSurfaceCacheEntry,
  removeWaveformSurfaceCacheEntry
} from './libraryCacheDb/waveformSurfaceCache'

export {
  loadMixtapeWaveformCacheData,
  upsertMixtapeWaveformCacheEntry,
  removeMixtapeWaveformCacheEntry
} from './libraryCacheDb/mixtapeWaveformCache'

export {
  loadMixtapeRawWaveformCacheData,
  upsertMixtapeRawWaveformCacheEntry,
  removeMixtapeRawWaveformCacheEntry
} from './libraryCacheDb/mixtapeRawWaveformCache'

export {
  loadMixtapeStemWaveformCacheData,
  upsertMixtapeStemWaveformCacheEntry,
  removeMixtapeStemWaveformCacheByFilePath
} from './libraryCacheDb/mixtapeStemWaveformCache'

export {
  loadPioneerPreviewWaveformCacheEntry,
  upsertPioneerPreviewWaveformCacheEntry
} from './libraryCacheDb/pioneerPreviewWaveformCache'

export {
  registerExternalAnalysisContext,
  resolveExternalAnalysisContext,
  unregisterExternalAnalysisContexts,
  touchExternalAnalysisDevice,
  pruneStaleExternalAnalysisDevices,
  pruneStaleExternalAnalysisCacheEntries,
  loadExternalAnalysisCacheEntry,
  loadExternalAnalysisCacheEntryByFilePath,
  touchExternalAnalysisCacheEntrySeen,
  upsertExternalAnalysisCacheEntry,
  upsertExternalAnalysisWaveformCacheEntry,
  removeExternalAnalysisCacheEntry,
  type ExternalAnalysisContext,
  type ExternalAnalysisSourceKind,
  type ExternalAnalysisCacheEntry
} from './libraryCacheDb/externalAnalysisCache'

export {
  renameCacheRoot,
  pruneCachesByRoots,
  scheduleCacheKeyMigration,
  migrateLegacyCachesInLibrary,
  scanLegacyCacheRoots
} from './libraryCacheDb/maintenance'
