import { ipcMain } from 'electron'
import path from 'node:path'
import { readSeratoLibrary, readTraktorCollection } from '../services/externalLibrary'
import { hydrateSeratoTracks } from '../services/externalLibrary/serato'
import { probeExternalLibraries } from '../services/externalLibrary/detect'
import {
  buildExternalLibraryBrowserTracks,
  buildExternalLibraryBrowserTree,
  buildSeratoWaveformOverviews,
  isExternalLibraryKind
} from '../services/externalLibrary/browserAdapter'
import type { ExternalLibrarySnapshot, ExternalLibraryTrack } from '../../shared/externalLibrary'
import * as LibraryCacheDb from '../libraryCacheDb'
import { hydrateExternalLibraryTracksFromAnalysisCache } from '../services/externalLibrary/analysisCache'
import { mutateSeratoCrate } from '../services/externalLibrary/seratoCrateWriter'
import {
  writeSeratoHotCues,
  type SeratoHotCue
} from '../services/externalLibrary/seratoMarkersWriter'
import { getPlaylistNumericId } from '../services/externalLibrary/browserAdapter'
import type { ExternalLibraryMutationResponse } from '../../shared/externalLibrary'

type ExternalLibraryKind = 'serato' | 'traktor'

const SNAPSHOT_CACHE_TTL_MS = 30_000
const SERATO_TRACK_METADATA_CACHE_TTL_MS = 5 * 60_000
const snapshotCache = new Map<string, { snapshot: ExternalLibrarySnapshot; updatedAt: number }>()
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

const resolveExternalLibraryAnalysisSourceId = (kind: ExternalLibraryKind) =>
  `external-library:${kind}`

const buildSeratoTrackMetadataCacheKey = (sourcePath: string, filePath: string) =>
  `${normalizeAbsolutePathKey(sourcePath)}::${normalizeAbsolutePathKey(filePath)}`

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

const readLibrary = async (kind: ExternalLibraryKind, sourcePath: string, preferCached = false) => {
  const cacheKey = `${kind}:${path.normalize(sourcePath).toLocaleLowerCase()}`
  const cached = snapshotCache.get(cacheKey)
  if (cached && (preferCached || Date.now() - cached.updatedAt <= SNAPSHOT_CACHE_TTL_MS)) {
    return cached.snapshot
  }
  const activeRequest = snapshotRequests.get(cacheKey)
  if (activeRequest) return await activeRequest

  const request =
    kind === 'serato'
      ? readSeratoLibrary(sourcePath, { hydrateTracks: false })
      : readTraktorCollection(path.resolve(sourcePath))
  snapshotRequests.set(cacheKey, request)
  try {
    const snapshot = await request
    snapshotCache.set(cacheKey, { snapshot, updatedAt: Date.now() })
    scheduleExternalLibraryAnalysisReconcile(kind, sourcePath, snapshot)
    return snapshot
  } finally {
    if (snapshotRequests.get(cacheKey) === request) snapshotRequests.delete(cacheKey)
  }
}

export const invalidateExternalLibrarySnapshot = (
  kind: ExternalLibraryKind,
  sourcePath: string
) => {
  const cacheKey = `${kind}:${path.normalize(sourcePath).toLocaleLowerCase()}`
  snapshotCache.delete(cacheKey)
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
        externalId?: string
        parentExternalId?: string
        name?: string
        rowKeys?: string[]
        targetIndex?: number
        seq?: number
        playlistId?: number
        trackPaths?: string[]
        trackPathMappings?: Array<{ sourcePath: string; storedPath: string }>
        trackCueMappings?: Array<{ storedPath: string; hotCues?: SeratoHotCue[] }>
      }
    ): Promise<ExternalLibraryMutationResponse> => {
      const { kind, sourcePath } = parseRequest(request)
      if (kind !== 'serato') {
        return { ok: false, summary: { errorMessage: 'Traktor 库目前是只读的。' } }
      }
      try {
        for (const cueMapping of request.trackCueMappings || []) {
          const storedPath = String(cueMapping.storedPath || '').trim()
          if (!storedPath || !Array.isArray(cueMapping.hotCues) || !cueMapping.hotCues.length)
            continue
          await writeSeratoHotCues(storedPath, cueMapping.hotCues)
        }
        const summary = await mutateSeratoCrate({
          operation: request.operation || 'rename',
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
            : selectedTracks
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
      if (kind !== 'serato' || !filePaths.length) return { items: [] }
      const snapshot = await readLibrary(kind, sourcePath, true)
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
