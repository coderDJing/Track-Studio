import { ipcMain } from 'electron'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { readSeratoLibrary, readTraktorCollection } from '../services/externalLibrary'
import { hydrateSeratoTracks } from '../services/externalLibrary/serato'
import { loadTraktorStripePreviews } from '../services/externalLibrary/traktorStripe'
import { hydrateTraktorTrackTimeBases } from '../services/externalLibrary/traktorAudioTimeBasis'
import { probeExternalLibraries } from '../services/externalLibrary/detect'
import { isSeratoV4SourcePath } from '../services/externalLibrary/seratoV4'
import {
  buildExternalLibraryBrowserTracks,
  buildExternalLibraryBrowserTree,
  buildSeratoWaveformOverviews,
  isExternalLibraryKind
} from '../services/externalLibrary/browserAdapter'
import type {
  ExternalLibrarySnapshot,
  ExternalLibraryTrack,
  TraktorTrackMetadata
} from '../../shared/externalLibrary'
import * as LibraryCacheDb from '../libraryCacheDb'
import { hydrateExternalLibraryTracksFromAnalysisCache } from '../services/externalLibrary/analysisCache'
import { mutateSeratoCrate } from '../services/externalLibrary/seratoCrateWriter'
import {
  assertTraktorClosed,
  mutateTraktorCollection
} from '../services/externalLibrary/traktorCollectionWriter'
import {
  writeSeratoHotCues,
  type SeratoHotCue
} from '../services/externalLibrary/seratoMarkersWriter'
import { getPlaylistNumericId } from '../services/externalLibrary/browserAdapter'
import type { ExternalLibraryMutationResponse } from '../../shared/externalLibrary'

type ExternalLibraryKind = 'serato' | 'traktor'

const SERATO_TRACK_METADATA_CACHE_TTL_MS = 5 * 60_000
const snapshotCache = new Map<string, { snapshot: ExternalLibrarySnapshot; sourceStamp?: string }>()
const snapshotRequests = new Map<string, Promise<ExternalLibrarySnapshot>>()
const analysisReconcileRequests = new Map<string, Promise<void>>()
const seratoTrackMetadataCache = new Map<
  string,
  { track: ExternalLibraryTrack; updatedAt: number }
>()

const normalizeAbsolutePathKey = (filePath: string) => {
  const resolved = path.resolve(String(filePath || '').trim()).replace(/\\/g, '/')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const getTraktorSourceStamp = async (sourcePath: string) => {
  const stat = await fs.stat(sourcePath)
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

const getOptionalFileStamp = async (filePath: string) => {
  try {
    const stat = await fs.stat(filePath)
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return 'missing'
    }
    throw error
  }
}

const getSeratoSourceStamp = async (sourcePath: string) => {
  if (isSeratoV4SourcePath(sourcePath)) {
    const files = ['master.sqlite', 'master.sqlite-wal', 'root.sqlite', 'root.sqlite-wal']
    const stamps = await Promise.all(
      files.map(
        async (name) => `${name}:${await getOptionalFileStamp(path.join(sourcePath, name))}`
      )
    )
    return createHash('sha256').update(stamps.join('|')).digest('hex')
  }
  const root =
    path.basename(path.normalize(sourcePath)).toLowerCase() === '_serato_'
      ? sourcePath
      : path.join(sourcePath, '_Serato_')
  const subcratesPath = path.join(root, 'Subcrates')
  let crateNames: string[] = []
  try {
    crateNames = (await fs.readdir(subcratesPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.crate$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      throw error
    }
  }
  const files = [
    path.join(root, 'database V2'),
    path.join(root, 'FRKB folders.json'),
    path.join(root, 'neworder.pref'),
    ...crateNames.map((name) => path.join(subcratesPath, name))
  ]
  const stamps = await Promise.all(
    files.map(
      async (filePath) => `${path.relative(root, filePath)}:${await getOptionalFileStamp(filePath)}`
    )
  )
  return createHash('sha256').update(stamps.join('|')).digest('hex')
}

const getExternalSourceStamp = (kind: ExternalLibraryKind, sourcePath: string) =>
  kind === 'traktor' ? getTraktorSourceStamp(sourcePath) : getSeratoSourceStamp(sourcePath)

const resolveExternalLibraryAnalysisSourceId = (kind: ExternalLibraryKind) =>
  `external-library:${kind}`

const buildSeratoTrackMetadataCacheKey = (sourcePath: string, filePath: string) =>
  `${normalizeAbsolutePathKey(sourcePath)}::${normalizeAbsolutePathKey(filePath)}`

const clearSeratoTrackMetadataCache = (sourcePath: string) => {
  const prefix = `${normalizeAbsolutePathKey(sourcePath)}::`
  for (const key of seratoTrackMetadataCache.keys()) {
    if (key.startsWith(prefix)) seratoTrackMetadataCache.delete(key)
  }
}

const hydrateSeratoTrackSubset = async (
  sourcePath: string,
  sourceTracks: ExternalLibraryTrack[]
) => {
  const now = Date.now()
  for (const [cacheKey, cached] of seratoTrackMetadataCache) {
    if (now - cached.updatedAt > SERATO_TRACK_METADATA_CACHE_TTL_MS) {
      seratoTrackMetadataCache.delete(cacheKey)
    }
  }
  const resolvedTracks = new Map<string, ExternalLibraryTrack>()
  const uncachedTracks: ExternalLibraryTrack[] = []

  for (const track of sourceTracks) {
    const cacheKey = buildSeratoTrackMetadataCacheKey(sourcePath, track.filePath)
    const cached = seratoTrackMetadataCache.get(cacheKey)
    if (cached && now - cached.updatedAt <= SERATO_TRACK_METADATA_CACHE_TTL_MS) {
      resolvedTracks.set(track.id, { ...track, ...cached.track, id: track.id })
    } else {
      if (cached) seratoTrackMetadataCache.delete(cacheKey)
      uncachedTracks.push(track)
    }
  }

  if (uncachedTracks.length) {
    const hydrated = await hydrateSeratoTracks(uncachedTracks)
    for (const track of hydrated.tracks) {
      resolvedTracks.set(track.id, track)
      seratoTrackMetadataCache.set(buildSeratoTrackMetadataCacheKey(sourcePath, track.filePath), {
        track,
        updatedAt: Date.now()
      })
    }
  }

  return sourceTracks.map((track) => resolvedTracks.get(track.id) || track)
}

const selectSnapshotTracks = (snapshot: ExternalLibrarySnapshot, playlistId: number) => {
  if (playlistId === 1) return snapshot.tracks
  const playlist = snapshot.playlists.find(
    (item) => getPlaylistNumericId(item) === Number(playlistId)
  )
  if (!playlist) return []
  const selectedIds = new Set(playlist.trackIds)
  return snapshot.tracks.filter((track) => selectedIds.has(track.id))
}

const buildExternalLibraryAnalysisEntry = (filePath: string) => ({
  relativePath: `abs:${normalizeAbsolutePathKey(filePath)}`,
  filePath
})

const reconcileExternalLibraryAnalysisCache = async (
  kind: ExternalLibraryKind,
  sourcePath: string,
  snapshot: ExternalLibrarySnapshot
) => {
  const sourceId = resolveExternalLibraryAnalysisSourceId(kind)
  const activeEntries = snapshot.tracks.flatMap((track) => {
    const filePath = String(track.filePath || '').trim()
    return filePath ? [buildExternalLibraryAnalysisEntry(filePath)] : []
  })
  await LibraryCacheDb.touchExternalAnalysisDevice('external-playback', sourceId, sourcePath)
  await LibraryCacheDb.reconcileExternalAnalysisCacheEntries(
    'external-playback',
    sourceId,
    activeEntries
  )
  await LibraryCacheDb.pruneStaleExternalAnalysisDevices()
}

const scheduleExternalLibraryAnalysisReconcile = (
  kind: ExternalLibraryKind,
  sourcePath: string,
  snapshot: ExternalLibrarySnapshot
) => {
  const requestKey = `${kind}:${normalizeAbsolutePathKey(sourcePath)}`
  const previousRequest = analysisReconcileRequests.get(requestKey) || Promise.resolve()
  const request = previousRequest
    .catch(() => {})
    .then(() => reconcileExternalLibraryAnalysisCache(kind, sourcePath, snapshot))
  analysisReconcileRequests.set(requestKey, request)
  void request
    .finally(() => {
      if (analysisReconcileRequests.get(requestKey) === request) {
        analysisReconcileRequests.delete(requestKey)
      }
    })
    .catch(() => {})
}

const registerExternalLibraryAnalysisContexts = (
  kind: ExternalLibraryKind,
  sourcePath: string,
  tracks: Array<{ filePath?: unknown }>
) => {
  const sourceId = resolveExternalLibraryAnalysisSourceId(kind)
  void LibraryCacheDb.touchExternalAnalysisDevice('external-playback', sourceId, sourcePath)
  for (const track of tracks) {
    const filePath = String(track?.filePath || '').trim()
    if (!filePath) continue
    LibraryCacheDb.registerExternalAnalysisContext({
      sourceKind: 'external-playback',
      sourceId,
      rootPath: sourcePath,
      relativePath: buildExternalLibraryAnalysisEntry(filePath).relativePath,
      filePath
    })
  }
}

const readLibrary = async (
  kind: ExternalLibraryKind,
  sourcePath: string,
  preferCached = false,
  refreshAttempt = 0
) => {
  const cacheKey = `${kind}:${path.normalize(sourcePath).toLocaleLowerCase()}`
  const sourceStamp =
    kind === 'serato' && preferCached ? undefined : await getExternalSourceStamp(kind, sourcePath)
  const cached = snapshotCache.get(cacheKey)
  if (cached && (kind === 'serato' && preferCached ? true : cached.sourceStamp === sourceStamp)) {
    return cached.snapshot
  }
  if (kind === 'serato' && cached && cached.sourceStamp !== sourceStamp) {
    clearSeratoTrackMetadataCache(sourcePath)
  }
  const activeRequest = snapshotRequests.get(cacheKey)
  if (activeRequest) {
    await activeRequest
    return await readLibrary(kind, sourcePath, preferCached)
  }

  const request =
    kind === 'serato'
      ? readSeratoLibrary(sourcePath, { hydrateTracks: false })
      : readTraktorCollection(path.resolve(sourcePath))
  snapshotRequests.set(cacheKey, request)
  let snapshot: ExternalLibrarySnapshot
  try {
    snapshot = await request
    snapshotCache.set(cacheKey, { snapshot, sourceStamp })
  } finally {
    if (snapshotRequests.get(cacheKey) === request) snapshotRequests.delete(cacheKey)
  }
  const sourceChangedDuringRead =
    (kind !== 'serato' || !preferCached) &&
    (await getExternalSourceStamp(kind, sourcePath)) !== sourceStamp
  if (sourceChangedDuringRead) {
    if (snapshotCache.get(cacheKey)?.snapshot === snapshot) snapshotCache.delete(cacheKey)
    if (refreshAttempt < 2) {
      return await readLibrary(kind, sourcePath, preferCached, refreshAttempt + 1)
    }
    return snapshot
  }
  scheduleExternalLibraryAnalysisReconcile(kind, sourcePath, snapshot)
  return snapshot
}

export const invalidateExternalLibrarySnapshot = (
  kind: ExternalLibraryKind,
  sourcePath: string
) => {
  const cacheKey = `${kind}:${path.normalize(sourcePath).toLocaleLowerCase()}`
  snapshotCache.delete(cacheKey)
  if (kind === 'serato') clearSeratoTrackMetadataCache(sourcePath)
}

const parseRequest = (request: { kind?: ExternalLibraryKind; path?: string } | undefined) => {
  const kind = request?.kind
  const sourcePath = String(request?.path || '').trim()
  if (!sourcePath || !isExternalLibraryKind(kind)) {
    throw new Error('外部库类型或路径无效。')
  }
  return { kind, sourcePath }
}

export function registerExternalLibraryHandlers() {
  ipcMain.handle('external-library:probe', async () => await probeExternalLibraries())

  ipcMain.handle(
    'external-library:source-revision',
    async (_event, request: { kind?: ExternalLibraryKind; path?: string }) => {
      const { kind, sourcePath } = parseRequest(request)
      return { revision: await getExternalSourceStamp(kind, sourcePath) }
    }
  )

  ipcMain.handle(
    'external-library:check-write',
    async (_event, request: { kind?: ExternalLibraryKind; path?: string }) => {
      const { kind, sourcePath } = parseRequest(request)
      if (kind === 'serato' && isSeratoV4SourcePath(sourcePath))
        throw new Error('Serato 4 曲库目前只支持读取。')
      if (kind === 'traktor') await assertTraktorClosed()
      return true
    }
  )

  ipcMain.handle(
    'external-library:read',
    async (_event, request: { kind?: ExternalLibraryKind; path?: string }) => {
      const { kind, sourcePath } = parseRequest(request)
      return await readLibrary(kind, sourcePath)
    }
  )

  ipcMain.handle(
    'external-library:mutate',
    async (
      _event,
      request: {
        kind?: ExternalLibraryKind
        path?: string
        operation?:
          | 'create-playlist'
          | 'create-folder'
          | 'rename'
          | 'move'
          | 'delete'
          | 'remove-tracks'
          | 'reorder-tracks'
          | 'write-tracks'
          | 'append-existing-tracks'
        externalId?: string
        parentExternalId?: string
        name?: string
        rowKeys?: string[]
        targetIndex?: number
        seq?: number
        playlistId?: number
        sourcePlaylistId?: number
        trackPaths?: string[]
        trackPathMappings?: Array<{ sourcePath: string; storedPath: string }>
        trackCueMappings?: Array<{ storedPath: string; hotCues?: SeratoHotCue[] }>
        trackMetadata?: TraktorTrackMetadata[]
      }
    ): Promise<ExternalLibraryMutationResponse> => {
      const { kind, sourcePath } = parseRequest(request)
      try {
        if (kind === 'serato' && isSeratoV4SourcePath(sourcePath))
          throw new Error('Serato 4 曲库目前只支持读取。')
        const operation =
          request.operation === 'append-existing-tracks'
            ? 'write-tracks'
            : request.operation || 'rename'
        if (request.operation === 'append-existing-tracks') {
          // Writes reconcile the source against disk, never against the view snapshot.
          const source =
            kind === 'serato'
              ? await readSeratoLibrary(sourcePath, { hydrateTracks: false })
              : await readTraktorCollection(path.resolve(sourcePath))
          const sourcePlaylistId = Number(request.sourcePlaylistId)
          const requestedPaths = Array.isArray(request.trackPaths) ? request.trackPaths : []
          const sourcePaths = new Set(
            selectSnapshotTracks(source, sourcePlaylistId).map((track) =>
              normalizeAbsolutePathKey(track.filePath)
            )
          )
          if (
            !Number.isSafeInteger(sourcePlaylistId) ||
            sourcePlaylistId <= 0 ||
            !requestedPaths.length ||
            requestedPaths.some((filePath) => !sourcePaths.has(normalizeAbsolutePathKey(filePath)))
          ) {
            throw new Error('来源歌单的曲目已变化，请刷新后重试。')
          }
          const target = source.playlists.find((playlist) => playlist.id === request.externalId)
          if (!target || target.isFolder || target.isSmartPlaylist)
            throw new Error('目标必须是普通歌单。')
          if (
            request.trackCueMappings?.length ||
            request.trackMetadata?.length ||
            request.trackPathMappings?.length
          ) {
            throw new Error('库内添加曲目不能修改音频文件或曲目分析信息。')
          }
        }
        let summary
        if (kind === 'serato') {
          for (const cueMapping of request.trackCueMappings || []) {
            const storedPath = String(cueMapping.storedPath || '').trim()
            if (!storedPath || !Array.isArray(cueMapping.hotCues) || !cueMapping.hotCues.length)
              continue
            await writeSeratoHotCues(storedPath, cueMapping.hotCues)
          }
          summary = await mutateSeratoCrate({
            operation,
            sourcePath,
            externalId: request.externalId,
            parentExternalId: request.parentExternalId,
            name: request.name,
            rowKeys: request.rowKeys,
            targetIndex: request.targetIndex,
            seq: request.seq,
            trackPaths: request.trackPaths,
            trackPathMappings: request.trackPathMappings
          })
        } else {
          summary = await mutateTraktorCollection({
            operation,
            sourcePath,
            externalId: request.externalId,
            parentExternalId: request.parentExternalId,
            name: request.name,
            rowKeys: request.rowKeys,
            targetIndex: request.targetIndex,
            seq: request.seq,
            trackPaths: request.trackPaths,
            trackMetadata: request.trackMetadata
          })
        }
        invalidateExternalLibrarySnapshot(kind, sourcePath)
        const snapshot = await readLibrary(kind, sourcePath, false)
        const selected = summary.externalId
          ? snapshot.playlists.find((item) => item.id === summary.externalId)
          : undefined
        const parent = summary.parentExternalId
          ? snapshot.playlists.find((item) => item.id === summary.parentExternalId)
          : undefined
        return {
          ok: true,
          summary: {
            errorMessage: '',
            ...summary,
            playlistId: selected ? getPlaylistNumericId(selected) : undefined,
            parentExternalId: parent?.id || summary.parentExternalId
          }
        }
      } catch (error) {
        return {
          ok: false,
          summary: { errorMessage: error instanceof Error ? error.message : String(error) }
        }
      }
    }
  )

  ipcMain.handle(
    'external-library:load-tree',
    async (_event, request: { kind?: ExternalLibraryKind; path?: string }) => {
      const { kind, sourcePath } = parseRequest(request)
      return buildExternalLibraryBrowserTree(await readLibrary(kind, sourcePath))
    }
  )

  ipcMain.handle(
    'external-library:load-playlist-tracks',
    async (_event, request: { kind?: ExternalLibraryKind; path?: string; playlistId?: number }) => {
      const { kind, sourcePath } = parseRequest(request)
      const playlistId = Math.max(0, Number(request?.playlistId) || 0)
      if (!playlistId) throw new Error('外部库歌单无效。')
      const snapshot = await readLibrary(kind, sourcePath)
      const selectedTracks = selectSnapshotTracks(snapshot, playlistId)
      const browserSnapshot = {
        ...snapshot,
        tracks:
          kind === 'serato'
            ? await hydrateSeratoTrackSubset(sourcePath, selectedTracks)
            : await hydrateTraktorTrackTimeBases(selectedTracks)
      }
      const result = buildExternalLibraryBrowserTracks(browserSnapshot, playlistId)
      registerExternalLibraryAnalysisContexts(kind, sourcePath, result.tracks)
      return {
        ...result,
        tracks: await hydrateExternalLibraryTracksFromAnalysisCache(result.tracks)
      }
    }
  )

  ipcMain.handle(
    'external-library:load-waveform-overviews',
    async (
      _event,
      request: { kind?: ExternalLibraryKind; path?: string; filePaths?: string[] }
    ) => {
      const { kind, sourcePath } = parseRequest(request)
      const filePaths = Array.from(
        new Set(
          (Array.isArray(request?.filePaths) ? request.filePaths : [])
            .map((filePath) => String(filePath || '').trim())
            .filter(Boolean)
        )
      ).slice(0, 128)
      if (!filePaths.length) return { items: [] }
      const snapshot = await readLibrary(kind, sourcePath, true)
      if (kind === 'traktor') {
        return { items: await loadTraktorStripePreviews(snapshot, filePaths) }
      }
      const requestedPathSet = new Set(filePaths.map(normalizeAbsolutePathKey))
      const requestedTracks = snapshot.tracks.filter((track) =>
        requestedPathSet.has(normalizeAbsolutePathKey(track.filePath))
      )
      return {
        items: buildSeratoWaveformOverviews(
          {
            ...snapshot,
            tracks: await hydrateSeratoTrackSubset(sourcePath, requestedTracks)
          },
          filePaths
        )
      }
    }
  )
}
