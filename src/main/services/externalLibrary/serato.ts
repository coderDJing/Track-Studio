import fs from 'node:fs/promises'
import path from 'node:path'
import {
  getAllCrates,
  getLibraryTracks,
  getTrackMetadata,
  parseMarkers2FromGeob
} from 'serato-connect'
import { readSeratoCrateOrder } from './seratoCrateOrder'
import type {
  ExternalLibraryCue,
  ExternalLibraryPlaylist,
  ExternalLibrarySnapshot,
  ExternalLibraryTrack
} from '../../../shared/externalLibrary'

type SeratoChunk = { tag: string; payload: Buffer }

const normalizePathKey = (value: string) =>
  path.normalize(value).replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase()

const decodeUtf16Be = (payload: Buffer): string => {
  const evenLength = payload.length - (payload.length % 2)
  const swapped = Buffer.allocUnsafe(evenLength)
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = payload[index + 1]
    swapped[index + 1] = payload[index]
  }
  return swapped.toString('utf16le').replaceAll('\0', '').trim()
}

const parseChunks = (data: Buffer): SeratoChunk[] => {
  const chunks: SeratoChunk[] = []
  let offset = 0
  while (offset + 8 <= data.length) {
    const tag = data.subarray(offset, offset + 4).toString('ascii')
    const length = data.readUInt32BE(offset + 4)
    offset += 8
    if (length > data.length - offset) break
    chunks.push({ tag, payload: data.subarray(offset, offset + length) })
    offset += length
  }
  return chunks
}

const nestedChunks = (payload: Buffer) => parseChunks(payload)

const firstText = (chunks: SeratoChunk[], tags: string[]) => {
  for (const tag of tags) {
    const chunk = chunks.find((item) => item.tag === tag)
    if (chunk) return decodeUtf16Be(chunk.payload)
  }
  return ''
}

const firstNumber = (chunks: SeratoChunk[], tags: string[]) => {
  const value = firstText(chunks, tags)
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

const parseTrackChunks = (chunks: SeratoChunk[]): Partial<ExternalLibraryTrack> => {
  const nested = chunks.flatMap((chunk) =>
    chunk.tag.startsWith('o') ? nestedChunks(chunk.payload) : []
  )
  const fields = [...chunks, ...nested]
  const filePath = firstText(fields, ['pfil', 'ptrk'])
  const track: Partial<ExternalLibraryTrack> = {
    filePath,
    title: firstText(fields, ['tsng']),
    artist: firstText(fields, ['tart']),
    album: firstText(fields, ['talb']),
    genre: firstText(fields, ['tgen']),
    label: firstText(fields, ['tlbl']),
    comment: firstText(fields, ['tcom']),
    key: firstText(fields, ['tkey']),
    bpm: firstNumber(fields, ['tbpm']),
    durationSec: firstNumber(fields, ['tlen']),
    year: firstNumber(fields, ['ttyr'])
  }
  return track
}

const parseTrackRecords = (data: Buffer) => {
  const records: Array<Partial<ExternalLibraryTrack>> = []
  for (const chunk of parseChunks(data)) {
    if (chunk.tag !== 'otrk') continue
    const track = parseTrackChunks(nestedChunks(chunk.payload))
    if (track.filePath) records.push(track)
  }
  return records
}

const resolveSeratoRoot = (inputPath: string) => {
  const normalized = path.normalize(inputPath)
  return path.basename(normalized).toLowerCase() === '_serato_'
    ? normalized
    : path.join(normalized, '_Serato_')
}

const resolveTrackPath = (seratoRoot: string, value: string) => {
  const normalized = value.trim().replaceAll('\\', '/')
  const windowsDrivePath = normalized.match(/^\/?([A-Za-z]:\/.*)$/)?.[1]
  if (windowsDrivePath) return path.win32.normalize(windowsDrivePath)
  if (normalized.startsWith('//')) return path.win32.normalize(normalized)

  if (/^[A-Za-z]:[\\/]/.test(seratoRoot)) {
    const volumeRoot = path.win32.parse(path.win32.normalize(seratoRoot)).root
    return path.win32.normalize(path.win32.join(volumeRoot, normalized.replace(/^\/+/, '')))
  }

  return path.posix.normalize(path.posix.join('/', normalized.replace(/^\/+/, '')))
}

const readFrkbFolderNames = async (seratoRoot: string): Promise<string[]> => {
  try {
    const value: unknown = JSON.parse(
      await fs.readFile(path.join(seratoRoot, 'FRKB folders.json'), 'utf8')
    )
    return Array.isArray(value)
      ? value.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  } catch {
    return []
  }
}

const createPlaylist = (
  playlists: ExternalLibraryPlaylist[],
  cache: Map<string, ExternalLibraryPlaylist>,
  parts: string[],
  trackIds: string[],
  leafIsFolder = false
) => {
  let parentId: string | null = null
  for (let index = 0; index < parts.length; index += 1) {
    const name = parts[index]
    const id = `serato:${parts.slice(0, index + 1).join('/')}`
    const isLeaf = index === parts.length - 1
    let playlist = cache.get(id)
    if (!playlist) {
      playlist = {
        id,
        name,
        parentId,
        isFolder: !isLeaf || (isLeaf && leafIsFolder),
        trackIds: [],
        order: playlists.length
      }
      cache.set(id, playlist)
      playlists.push(playlist)
    }
    if (isLeaf) {
      playlist.isFolder = playlist.isFolder || leafIsFolder
      playlist.trackIds.push(...trackIds)
    }
    parentId = id
  }
}

const buildTrack = (
  partial: Partial<ExternalLibraryTrack>,
  filePath: string,
  index: number,
  missing = false
): ExternalLibraryTrack => ({
  id: `serato-track:${normalizePathKey(filePath) || index}`,
  filePath,
  title: partial.title,
  artist: partial.artist,
  album: partial.album,
  genre: partial.genre,
  label: partial.label,
  comment: partial.comment,
  key: partial.key,
  bpm: partial.bpm,
  durationSec: partial.durationSec,
  bitrate: partial.bitrate,
  sampleRate: partial.sampleRate,
  fileFormat: partial.fileFormat,
  year: partial.year,
  dateAdded: partial.dateAdded,
  missing,
  cues: []
})

const readVorbisMarkers2 = (native: unknown) => {
  if (!Array.isArray(native)) return undefined
  const item = native.find(
    (tag) =>
      tag &&
      typeof tag === 'object' &&
      String((tag as { id?: unknown }).id || '').toUpperCase() === 'SERATO_MARKERS_V2'
  ) as { value?: unknown } | undefined
  const value = String(item?.value || '').replace(/\s/g, '')
  if (!value) return undefined
  try {
    const decoded = Buffer.from(value, 'base64')
    const markerName = Buffer.from('Serato Markers2', 'ascii')
    const markerOffset = decoded.indexOf(markerName)
    if (markerOffset < 0) return undefined
    let dataOffset = markerOffset + markerName.length
    if (decoded[dataOffset] === 0) dataOffset += 1
    return parseMarkers2FromGeob(decoded.subarray(dataOffset))
  } catch {
    return undefined
  }
}

export const hydrateSeratoTracks = async (
  sourceTracks: ExternalLibraryTrack[]
): Promise<{ tracks: ExternalLibraryTrack[]; warnings: string[] }> => {
  const tracks = sourceTracks.map((track) => ({
    ...track,
    cues: track.cues.map((cue) => ({ ...cue })),
    waveformOverview:
      track.waveformOverview instanceof Uint8Array
        ? new Uint8Array(track.waveformOverview)
        : undefined
  }))
  const warnings: string[] = []
  let failedCount = 0
  let durationFailedCount = 0
  let nextTrackIndex = 0
  const musicMetadata = await import('music-metadata')
  const worker = async (track: ExternalLibraryTrack) => {
    try {
      await fs.access(track.filePath)
    } catch {
      track.missing = true
      return
    }
    try {
      const audioMetadata = await musicMetadata.parseFile(track.filePath, {
        skipCovers: true,
        includeChapters: false,
        duration: true
      })
      const durationSec = Number(audioMetadata.format.duration)
      if (Number.isFinite(durationSec) && durationSec > 0) {
        track.durationSec = durationSec
      } else {
        durationFailedCount += 1
        track.durationSec = undefined
      }
    } catch {
      durationFailedCount += 1
      track.durationSec = undefined
    }
    try {
      const metadata = await getTrackMetadata(track.filePath)
      const fileMetadata = await musicMetadata.parseFile(track.filePath, {
        skipCovers: true,
        includeChapters: false,
        duration: false
      })
      const parsedMarkers =
        metadata?.markers &&
        (metadata.markers.cuePoints.length > 0 || metadata.markers.loops.length > 0)
          ? metadata.markers
          : readVorbisMarkers2(fileMetadata.native?.vorbis)
      if (!metadata && !parsedMarkers) return
      const metadataCues: ExternalLibraryCue[] = []
      for (const cue of parsedMarkers?.cuePoints || []) {
        metadataCues.push({
          kind: 'hotCue',
          positionMs: cue.position,
          slot: cue.index,
          name: cue.name
        })
      }
      for (const loop of parsedMarkers?.loops || []) {
        metadataCues.push({
          kind: 'loop',
          positionMs: loop.startPosition,
          endPositionMs: loop.endPosition,
          slot: loop.index,
          name: loop.name
        })
      }
      for (const marker of metadata?.beatgrid?.markers || []) {
        metadataCues.push({
          kind: 'grid',
          positionMs: marker.position * 1000,
          bpm: marker.bpm
        })
      }
      if (metadataCues.length) track.cues = metadataCues
      if (metadata?.autotags?.bpm && Number.isFinite(metadata.autotags.bpm)) {
        track.bpm = metadata.autotags.bpm
      }
      if (metadata?.overview instanceof Uint8Array && metadata.overview.length > 2) {
        track.waveformOverview = new Uint8Array(metadata.overview)
      }
    } catch {
      failedCount += 1
    }
  }
  const workers = Array.from({ length: Math.min(8, tracks.length) }, async () => {
    while (nextTrackIndex < tracks.length) {
      const track = tracks[nextTrackIndex]
      nextTrackIndex += 1
      if (!track) return
      await worker(track)
    }
  })
  await Promise.all(workers)
  if (failedCount)
    warnings.push(`${failedCount} 首 Serato 音频元数据读取失败，已保留库内曲目记录。`)
  if (durationFailedCount)
    warnings.push(`${durationFailedCount} 首 Serato 音频时长读取失败，时长将显示为空。`)
  return { tracks, warnings }
}

export const readSeratoLibrary = async (
  inputPath: string,
  options?: { hydrateTracks?: boolean }
): Promise<ExternalLibrarySnapshot> => {
  const seratoRoot = resolveSeratoRoot(inputPath)
  const warnings: string[] = []
  const trackByPath = new Map<string, ExternalLibraryTrack>()

  const [libraryTracks, crates, crateOrder, frkbFolderNames] = await Promise.all([
    getLibraryTracks(seratoRoot),
    getAllCrates(seratoRoot),
    readSeratoCrateOrder(seratoRoot),
    readFrkbFolderNames(seratoRoot)
  ])
  const frkbFolderSet = new Set(frkbFolderNames.map((name) => name.toLowerCase()))
  const crateOrderMap = new Map(crateOrder.map((name, index) => [name.toLowerCase(), index]))
  crates.sort((left, right) => {
    const leftOrder = crateOrderMap.get(left.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = crateOrderMap.get(right.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder || left.name.localeCompare(right.name)
  })
  for (const [index, sourceTrack] of libraryTracks.entries()) {
    const resolvedPath = resolveTrackPath(seratoRoot, sourceTrack.filePath)
    const partial: Partial<ExternalLibraryTrack> = {
      title: sourceTrack.title,
      artist: sourceTrack.artist,
      album: sourceTrack.album,
      genre: sourceTrack.genre,
      label: sourceTrack.label,
      comment: sourceTrack.comment,
      key: sourceTrack.key,
      bpm: sourceTrack.bpm,
      durationSec: sourceTrack.length,
      bitrate: sourceTrack.bitrate,
      sampleRate: sourceTrack.sampleRate,
      fileFormat: sourceTrack.fileType,
      year: sourceTrack.year,
      dateAdded: sourceTrack.dateAdded?.toISOString()
    }
    trackByPath.set(
      normalizePathKey(resolvedPath),
      buildTrack(partial, resolvedPath, index, sourceTrack.missing === true)
    )
  }
  if (!libraryTracks.length)
    warnings.push('未找到 Serato database V2，将只根据 crate 文件构建曲目。')

  const playlists: ExternalLibraryPlaylist[] = []
  const playlistCache = new Map<string, ExternalLibraryPlaylist>()
  if (!crates.length) warnings.push('未找到 Serato Subcrates/*.crate。')

  for (const folderName of frkbFolderNames) {
    createPlaylist(playlists, playlistCache, folderName.split('%%').filter(Boolean), [], true)
  }

  for (const crate of crates) {
    if (frkbFolderSet.has(String(crate.name || '').toLowerCase())) continue
    const trackIds: string[] = []
    for (const crateTrackPath of crate.trackPaths) {
      const resolvedPath = resolveTrackPath(seratoRoot, crateTrackPath)
      const key = normalizePathKey(resolvedPath)
      let track = trackByPath.get(key)
      if (!track) {
        track = buildTrack({}, resolvedPath, trackByPath.size)
        trackByPath.set(key, track)
      }
      trackIds.push(track.id)
    }
    let leafIsFolder = false
    try {
      const crateData = await fs.readFile(crate.path)
      leafIsFolder = parseChunks(crateData).some(
        (chunk) => chunk.tag === 'frkb' && chunk.payload.toString('utf8') === 'folder'
      )
    } catch {
      // The crate remains readable even if its optional FRKB marker cannot be inspected.
    }
    createPlaylist(
      playlists,
      playlistCache,
      crate.name.split('%%').filter(Boolean),
      trackIds,
      leafIsFolder
    )
  }

  const snapshot: ExternalLibrarySnapshot = {
    kind: 'serato',
    rootPath: path.dirname(seratoRoot),
    libraryPath: seratoRoot,
    tracks: [...trackByPath.values()],
    playlists,
    warnings
  }
  if (options?.hydrateTracks === false) return snapshot

  const hydrated = await hydrateSeratoTracks(snapshot.tracks)
  return {
    ...snapshot,
    tracks: hydrated.tracks,
    warnings: [...snapshot.warnings, ...hydrated.warnings]
  }
}

export const __seratoTestUtils = {
  decodeUtf16Be,
  parseChunks,
  parseTrackRecords,
  resolveTrackPath
}
