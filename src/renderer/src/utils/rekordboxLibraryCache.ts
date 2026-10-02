import type {
  IPioneerPlaylistTrack,
  IPioneerPlaylistTreeNode,
  IRekordboxSourceKind,
  IRekordboxSourceLibraryType
} from 'src/types/globals'

const SOURCE_TREE_CACHE_TTL_MS = 30_000
const PLAYLIST_TRACK_CACHE_TTL_MS = 30_000
const MAX_SOURCE_TREE_CACHE_SIZE = 12
const MAX_PLAYLIST_TRACK_CACHE_SIZE = 96

type SourceTreeCacheEntry = {
  treeNodes: IPioneerPlaylistTreeNode[]
  selectedPlaylistId: number
  updatedAt: number
  revision?: string
}

type PlaylistTrackCacheEntry = {
  tracks: IPioneerPlaylistTrack[]
  updatedAt: number
  revision?: string
}

type ExternalSourceIdentity = {
  sourceKind: IRekordboxSourceKind | ''
  sourceKey?: string | null | undefined
  rootPath?: string | null | undefined
  libraryType?: IRekordboxSourceLibraryType | ''
}

const sourceTreeCache = new Map<string, SourceTreeCacheEntry>()
const playlistTrackCache = new Map<string, PlaylistTrackCacheEntry>()

const normalizeCachePart = (value: unknown) => String(value || '').trim()

const cloneTreeNodes = (nodes: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode[] =>
  Array.isArray(nodes)
    ? nodes.map((node) => ({
        ...node,
        children: cloneTreeNodes(Array.isArray(node.children) ? node.children : [])
      }))
    : []

const clonePlaylistTracks = (tracks: IPioneerPlaylistTrack[]): IPioneerPlaylistTrack[] =>
  Array.isArray(tracks)
    ? tracks.map((track) => ({
        ...track,
        hotCues: Array.isArray(track.hotCues) ? track.hotCues.map((cue) => ({ ...cue })) : [],
        memoryCues: Array.isArray(track.memoryCues)
          ? track.memoryCues.map((cue) => ({ ...cue }))
          : []
      }))
    : []

const touchCacheEntry = <T>(cache: Map<string, T>, key: string, value: T) => {
  cache.delete(key)
  cache.set(key, value)
}

const pruneCache = <T>(cache: Map<string, T>, maxSize: number) => {
  while (cache.size > maxSize) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) break
    cache.delete(oldestKey)
  }
}

const hasFreshTimestamp = (updatedAt: number, ttlMs: number) => Date.now() - updatedAt <= ttlMs

const buildPlaylistTracksCacheKey = (sourceCacheKey: string, playlistId: number) =>
  `${sourceCacheKey}::playlist:${Number(playlistId) || 0}`

export const buildRekordboxSourceCacheKey = ({
  sourceKind,
  sourceKey,
  rootPath,
  libraryType
}: ExternalSourceIdentity): string => {
  const normalizedSourceKind = sourceKind === 'desktop' || sourceKind === 'usb' ? sourceKind : ''
  if (!normalizedSourceKind) return ''

  const normalizedSourceKey = normalizeCachePart(sourceKey)
  const normalizedRootPath = normalizeCachePart(rootPath)
  const normalizedLibraryType = normalizeCachePart(libraryType) || 'default'
  const resolvedIdentity = normalizedSourceKey || normalizedRootPath
  if (!resolvedIdentity) return ''

  return [normalizedSourceKind, normalizedLibraryType, resolvedIdentity].join('::')
}

export const getCachedRekordboxSourceTree = (sourceCacheKey: string) => {
  const normalizedKey = normalizeCachePart(sourceCacheKey)
  if (!normalizedKey) return null
  const cached = sourceTreeCache.get(normalizedKey)
  if (!cached) return null
  touchCacheEntry(sourceTreeCache, normalizedKey, cached)
  return {
    treeNodes: cloneTreeNodes(cached.treeNodes),
    selectedPlaylistId: Number(cached.selectedPlaylistId) || 0,
    updatedAt: cached.updatedAt,
    revision: cached.revision
  }
}

export const shouldRefreshRekordboxSourceTree = (sourceCacheKey: string) => {
  const cached = sourceTreeCache.get(normalizeCachePart(sourceCacheKey))
  if (!cached) return true
  return !hasFreshTimestamp(cached.updatedAt, SOURCE_TREE_CACHE_TTL_MS)
}

export const setCachedRekordboxSourceTree = (
  sourceCacheKey: string,
  treeNodes: IPioneerPlaylistTreeNode[],
  options?: {
    selectedPlaylistId?: number
    revision?: string
  }
) => {
  const normalizedKey = normalizeCachePart(sourceCacheKey)
  if (!normalizedKey) return

  const previous = sourceTreeCache.get(normalizedKey)
  const hasSelectedPlaylistId =
    options && Object.prototype.hasOwnProperty.call(options, 'selectedPlaylistId')
  touchCacheEntry(sourceTreeCache, normalizedKey, {
    treeNodes: cloneTreeNodes(treeNodes),
    selectedPlaylistId: hasSelectedPlaylistId
      ? Math.max(0, Number(options?.selectedPlaylistId) || 0)
      : Number(previous?.selectedPlaylistId) || 0,
    updatedAt: Date.now(),
    revision: options?.revision
  })
  pruneCache(sourceTreeCache, MAX_SOURCE_TREE_CACHE_SIZE)
}

export const rememberRekordboxSourceSelectedPlaylist = (
  sourceCacheKey: string,
  playlistId: number
) => {
  const normalizedKey = normalizeCachePart(sourceCacheKey)
  if (!normalizedKey) return

  const previous = sourceTreeCache.get(normalizedKey)
  touchCacheEntry(sourceTreeCache, normalizedKey, {
    treeNodes: cloneTreeNodes(previous?.treeNodes || []),
    selectedPlaylistId: Number(playlistId) || 0,
    updatedAt: previous?.updatedAt || 0,
    revision: previous?.revision
  })
  pruneCache(sourceTreeCache, MAX_SOURCE_TREE_CACHE_SIZE)
}

export const getRememberedRekordboxSourceSelectedPlaylist = (sourceCacheKey: string) => {
  const cached = sourceTreeCache.get(normalizeCachePart(sourceCacheKey))
  if (!cached) return 0
  touchCacheEntry(sourceTreeCache, normalizeCachePart(sourceCacheKey), cached)
  return Number(cached.selectedPlaylistId) || 0
}

export const getCachedRekordboxPlaylistTracks = (sourceCacheKey: string, playlistId: number) => {
  const normalizedSourceCacheKey = normalizeCachePart(sourceCacheKey)
  const safePlaylistId = Number(playlistId) || 0
  if (!normalizedSourceCacheKey || safePlaylistId <= 0) return null

  const cacheKey = buildPlaylistTracksCacheKey(normalizedSourceCacheKey, safePlaylistId)
  const cached = playlistTrackCache.get(cacheKey)
  if (!cached) return null
  touchCacheEntry(playlistTrackCache, cacheKey, cached)
  return {
    tracks: clonePlaylistTracks(cached.tracks),
    updatedAt: cached.updatedAt,
    revision: cached.revision
  }
}

export const shouldRefreshRekordboxPlaylistTracks = (
  sourceCacheKey: string,
  playlistId: number
) => {
  const normalizedSourceCacheKey = normalizeCachePart(sourceCacheKey)
  const safePlaylistId = Number(playlistId) || 0
  if (!normalizedSourceCacheKey || safePlaylistId <= 0) return true

  const cached = playlistTrackCache.get(
    buildPlaylistTracksCacheKey(normalizedSourceCacheKey, safePlaylistId)
  )
  if (!cached) return true
  return !hasFreshTimestamp(cached.updatedAt, PLAYLIST_TRACK_CACHE_TTL_MS)
}

export const setCachedRekordboxPlaylistTracks = (
  sourceCacheKey: string,
  playlistId: number,
  tracks: IPioneerPlaylistTrack[],
  revision?: string
) => {
  const normalizedSourceCacheKey = normalizeCachePart(sourceCacheKey)
  const safePlaylistId = Number(playlistId) || 0
  if (!normalizedSourceCacheKey || safePlaylistId <= 0) return

  const cacheKey = buildPlaylistTracksCacheKey(normalizedSourceCacheKey, safePlaylistId)
  touchCacheEntry(playlistTrackCache, cacheKey, {
    tracks: clonePlaylistTracks(tracks),
    updatedAt: Date.now(),
    revision
  })
  pruneCache(playlistTrackCache, MAX_PLAYLIST_TRACK_CACHE_SIZE)
}

export const clearRekordboxSourceCache = (sourceCacheKey: string) => {
  const normalizedSourceCacheKey = normalizeCachePart(sourceCacheKey)
  if (!normalizedSourceCacheKey) return

  sourceTreeCache.delete(normalizedSourceCacheKey)
  for (const cacheKey of [...playlistTrackCache.keys()]) {
    if (!cacheKey.startsWith(`${normalizedSourceCacheKey}::playlist:`)) continue
    playlistTrackCache.delete(cacheKey)
  }
}

export const clearRekordboxSourceCachesByKind = (sourceKind: IRekordboxSourceKind) => {
  if (sourceKind !== 'desktop' && sourceKind !== 'usb') return
  for (const cacheKey of [...sourceTreeCache.keys()]) {
    if (!cacheKey.startsWith(`${sourceKind}::`)) continue
    clearRekordboxSourceCache(cacheKey)
  }
}
