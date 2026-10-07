import { enrichPioneerTracksWithCueData, normalizePioneerCueDump } from './cues'
import { resolvePioneerDevicePath } from './devicePath'
import { reconcileDeviceLibraryPlaylistTracks } from './deviceLibraryTrackReconciliation'
import { applyMissingFileFlags, markMissingFiles } from '../fileExistenceCheck'
import { probePioneerDeviceLibraryRoot } from './deviceDetection'
import {
  OneLibraryPlaylistNotFoundError,
  readOneLibraryPlaylistTracks,
  readOneLibraryPlaylistTree
} from './oneLibraryDb'
import {
  readPioneerBeatGridsInWorker,
  readPioneerPlaylistAnlzInWorker,
  readPioneerPlaylistTracksInWorker,
  readPioneerPlaylistTreeInWorker
} from './workerPool'
import { createSongBeatGridMapV2FromRekordboxEntries } from '../../../shared/songBeatGridMapV2'
import {
  resolveAudioTimeBasisOffsetMsForFile,
  resolveAudioTimeBasisOffsetMsForFiles
} from '../audioTimeBasisOffset'
import { log } from '../../log'
import type { IPioneerPlaylistTrack, IPioneerPlaylistTreeNode } from '../../../types/globals'
import type {
  PioneerDeviceLibraryProbe,
  PioneerLibraryKind,
  PioneerPlaylistNodeRecord,
  PioneerPlaylistTrackLoadResult,
  PioneerPlaylistTrackRecordRaw,
  PioneerPlaylistTreeLoadResult
} from './types'

type RustPioneerPlaylistTreeNode = {
  id: number
  parentId?: number
  parent_id?: number
  name: string
  isFolder?: boolean
  is_folder?: boolean
  isSmartPlaylist?: boolean
  is_smart_playlist?: boolean
  order: number
  sortOrder?: number
  sort_order?: number
}

type RustPioneerPlaylistTreeDump = {
  exportPdbPath: string
  export_pdb_path?: string
  nodeTotal?: number
  node_total?: number
  folderTotal?: number
  folder_total?: number
  playlistTotal?: number
  playlist_total?: number
  nodes?: RustPioneerPlaylistTreeNode[]
  error?: string
}

type RustPioneerPlaylistTrackRecord = {
  playlistId?: number
  playlist_id?: number
  trackId?: number
  track_id?: number
  entryIndex?: number
  entry_index?: number
  title?: string
  artist?: string
  album?: string
  label?: string
  genre?: string
  filePath?: string
  file_path?: string
  fileName?: string
  file_name?: string
  keyText?: string
  key_text?: string
  bpm?: number
  durationSec?: number
  duration_sec?: number
  bitrate?: number
  sampleRate?: number
  sample_rate?: number
  sampleDepth?: number
  sample_depth?: number
  trackNumber?: number
  track_number?: number
  discNumber?: number
  disc_number?: number
  year?: number
  analyzePath?: string
  analyze_path?: string
  comment?: string
  dateAdded?: string
  date_added?: string
  artworkId?: number
  artwork_id?: number
  artworkPath?: string
  artwork_path?: string
}

type RustPioneerPlaylistTrackDump = {
  exportPdbPath?: string
  export_pdb_path?: string
  playlistId?: number
  playlist_id?: number
  playlistName?: string
  playlist_name?: string
  trackTotal?: number
  track_total?: number
  tracks?: RustPioneerPlaylistTrackRecord[]
  error?: string
}

type RustPioneerBeatGridEntry = {
  beatNumber?: number
  beat_number?: number
  bpm?: number
  timeMs?: number
  time_ms?: number
}

type RustPioneerBeatGridDump = {
  analyzeFilePath?: string
  analyze_file_path?: string
  entries?: RustPioneerBeatGridEntry[]
  error?: string
}

type WorkerBeatGridItem = {
  analyzeFilePath?: string
  dump?: RustPioneerBeatGridDump | null
}

type WorkerPlaylistAnlzItem = {
  analyzeFilePath?: string
  beatGrid?: RustPioneerBeatGridDump | null
  cues?: Parameters<typeof normalizePioneerCueDump>[0]
}

const resolvePioneerDatabasePath = (
  probe: PioneerDeviceLibraryProbe,
  libraryType: PioneerLibraryKind
) => {
  if (libraryType === 'oneLibrary') {
    return probe.oneLibraryDbPath
  }
  return probe.exportPdbPath
}

const normalizePioneerPlaylistTreeDump = (
  result: RustPioneerPlaylistTreeDump,
  fallbackDatabasePath: string
): PioneerPlaylistTreeLoadResult => {
  const rawNodes = Array.isArray(result?.nodes) ? result.nodes : []
  const nodes: PioneerPlaylistNodeRecord[] = rawNodes.map((node) => ({
    id: Number(node?.id) || 0,
    parentId: Number(node?.parentId ?? node?.parent_id) || 0,
    name: String(node?.name || '').trim(),
    isFolder: Boolean(node?.isFolder ?? node?.is_folder),
    isSmartPlaylist: Boolean(node?.isSmartPlaylist ?? node?.is_smart_playlist),
    order: Number(node?.order) || 0,
    sortOrder: Number(node?.sortOrder ?? node?.sort_order) || 0
  }))

  return {
    databasePath: String(
      result?.exportPdbPath ?? result?.export_pdb_path ?? fallbackDatabasePath
    ).trim(),
    nodeTotal: Number(result?.nodeTotal ?? result?.node_total) || nodes.length,
    folderTotal: Number(result?.folderTotal ?? result?.folder_total) || 0,
    playlistTotal: Number(result?.playlistTotal ?? result?.playlist_total) || 0,
    nodes
  }
}

const normalizePioneerPlaylistTrackDump = (
  result: RustPioneerPlaylistTrackDump,
  playlistId: number,
  fallbackDatabasePath: string
): PioneerPlaylistTrackLoadResult => {
  const rawTracks = Array.isArray(result?.tracks) ? result.tracks : []
  const tracks: PioneerPlaylistTrackRecordRaw[] = rawTracks.map((track) => ({
    playlistId: Number(track?.playlistId ?? track?.playlist_id) || playlistId,
    trackId: Number(track?.trackId ?? track?.track_id) || 0,
    entryIndex: Number(track?.entryIndex ?? track?.entry_index) || 0,
    title: String(track?.title || '').trim(),
    artist: String(track?.artist || '').trim(),
    album: String(track?.album || '').trim(),
    label: String(track?.label || '').trim(),
    genre: String(track?.genre || '').trim(),
    filePath: String(track?.filePath ?? track?.file_path ?? '').trim(),
    fileName: String(track?.fileName ?? track?.file_name ?? '').trim(),
    keyText: String(track?.keyText ?? track?.key_text ?? '').trim(),
    bpm: Number(track?.bpm) || undefined,
    durationSec: Number(track?.durationSec ?? track?.duration_sec) || 0,
    bitrate: Number(track?.bitrate) || undefined,
    sampleRate: Number(track?.sampleRate ?? track?.sample_rate) || undefined,
    sampleDepth: Number(track?.sampleDepth ?? track?.sample_depth) || undefined,
    trackNumber: Number(track?.trackNumber ?? track?.track_number) || undefined,
    discNumber: Number(track?.discNumber ?? track?.disc_number) || undefined,
    year: Number(track?.year) || undefined,
    analyzePath: String(track?.analyzePath ?? track?.analyze_path ?? '').trim(),
    comment: String(track?.comment || '').trim(),
    dateAdded: String(track?.dateAdded ?? track?.date_added ?? '').trim(),
    artworkId: Number(track?.artworkId ?? track?.artwork_id) || undefined,
    artworkPath: String(track?.artworkPath ?? track?.artwork_path ?? '').trim()
  }))

  return {
    databasePath: String(
      result?.exportPdbPath ?? result?.export_pdb_path ?? fallbackDatabasePath
    ).trim(),
    playlistId: Number(result?.playlistId ?? result?.playlist_id) || playlistId,
    playlistName: String(result?.playlistName ?? result?.playlist_name ?? '').trim(),
    trackTotal: Number(result?.trackTotal ?? result?.track_total) || tracks.length,
    tracks
  }
}

export async function loadPioneerPlaylistTreeByDrivePath(
  rootPath: string,
  libraryType: PioneerLibraryKind = 'deviceLibrary'
): Promise<{
  drivePath: string
  driveName: string
  libraryType: PioneerLibraryKind
  databasePath: string
  nodeTotal: number
  folderTotal: number
  playlistTotal: number
  nodes: IPioneerPlaylistTreeNode[]
}> {
  const probe = await probePioneerDeviceLibraryRoot(rootPath)
  const databasePath = resolvePioneerDatabasePath(probe, libraryType)
  if (!databasePath) {
    throw new Error(
      libraryType === 'oneLibrary'
        ? '未找到 Pioneer OneLibrary 的 exportLibrary.db'
        : '未找到 Pioneer Device Library 的 export.pdb'
    )
  }

  let loaded: PioneerPlaylistTreeLoadResult
  if (libraryType === 'oneLibrary') {
    loaded = readOneLibraryPlaylistTree(databasePath)
  } else {
    const result = await readPioneerPlaylistTreeInWorker<RustPioneerPlaylistTreeDump>(databasePath)
    if (result?.error) {
      throw new Error(String(result.error))
    }
    loaded = normalizePioneerPlaylistTreeDump(result, databasePath)
  }

  return {
    drivePath: rootPath,
    driveName: '',
    libraryType,
    databasePath: loaded.databasePath,
    nodeTotal: loaded.nodeTotal,
    folderTotal: loaded.folderTotal,
    playlistTotal: loaded.playlistTotal,
    nodes: loaded.nodes
  }
}

export function buildPioneerPlaylistTree(
  nodes: IPioneerPlaylistTreeNode[]
): IPioneerPlaylistTreeNode[] {
  const normalized = Array.isArray(nodes)
    ? nodes
        .filter((node) => node && typeof node.name === 'string' && node.name.trim().length > 0)
        .map((node) => ({
          id: Number(node.id) || 0,
          parentId: Number(node.parentId) || 0,
          name: String(node.name || '').trim(),
          isFolder: Boolean(node.isFolder),
          isSmartPlaylist: Boolean(node.isSmartPlaylist),
          order: Number(node.order) || 0,
          sortOrder: Number(node.sortOrder) || 0,
          children: [] as IPioneerPlaylistTreeNode[]
        }))
    : []

  const byId = new Map<number, IPioneerPlaylistTreeNode>()
  for (const node of normalized) {
    byId.set(node.id, node)
  }

  const roots: IPioneerPlaylistTreeNode[] = []
  for (const node of normalized) {
    const parent = byId.get(node.parentId)
    if (parent) {
      parent.children = parent.children || []
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sortRecursive = (items: IPioneerPlaylistTreeNode[]) => {
    items.sort((left, right) => left.sortOrder - right.sortOrder)
    for (const item of items) {
      if (Array.isArray(item.children) && item.children.length > 0) {
        sortRecursive(item.children)
      }
    }
  }

  sortRecursive(roots)
  return roots
}

const formatDuration = (durationSec: number) => {
  const safe = Math.max(0, Number(durationSec) || 0)
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

const deriveFileFormat = (fileName: string, filePath: string) => {
  const source = String(fileName || filePath || '').trim()
  const ext = source.includes('.') ? source.split('.').pop() || '' : ''
  return ext.trim().toUpperCase()
}

const normalizePioneerBeatGridEntries = (value: RustPioneerBeatGridEntry[] | undefined) => {
  if (!Array.isArray(value) || value.length === 0) return []
  const entries = value
    .map((entry) => ({
      beatNumber: Number(entry?.beatNumber ?? entry?.beat_number),
      bpm: Number(entry?.bpm),
      timeMs: Number(entry?.timeMs ?? entry?.time_ms)
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.beatNumber) &&
        entry.beatNumber >= 1 &&
        entry.beatNumber <= 4 &&
        Number.isFinite(entry.bpm) &&
        entry.bpm > 0 &&
        Number.isFinite(entry.timeMs) &&
        entry.timeMs >= 0
    )
    .sort((left, right) => left.timeMs - right.timeMs)
  if (entries.some((entry, index) => index > 0 && entry.timeMs <= entries[index - 1].timeMs)) {
    return []
  }
  return entries
}

export async function attachPioneerAnlzRuntime(
  rootPath: string,
  tracks: IPioneerPlaylistTrack[],
  options?: { includeCues?: boolean }
): Promise<IPioneerPlaylistTrack[]> {
  const includeCues = options?.includeCues === true
  const absoluteAnalyzePathToTrack = new Map<string, IPioneerPlaylistTrack>()
  for (const track of tracks) {
    const analyzePath = String(track.analyzePath || '').trim()
    const absoluteAnalyzePath = resolvePioneerDevicePath(rootPath, analyzePath)
    if (absoluteAnalyzePath) absoluteAnalyzePathToTrack.set(absoluteAnalyzePath, track)
  }
  if (!absoluteAnalyzePathToTrack.size) return tracks

  const entriesByTrack = new Map<
    IPioneerPlaylistTrack,
    ReturnType<typeof normalizePioneerBeatGridEntries>
  >()
  const cueDataByTrack = new Map<
    IPioneerPlaylistTrack,
    ReturnType<typeof normalizePioneerCueDump>
  >()
  const analyzePaths = Array.from(absoluteAnalyzePathToTrack.keys())

  if (includeCues) {
    await readPioneerPlaylistAnlzInWorker<{ total?: number }>(analyzePaths, (progress) => {
      const item = progress as WorkerPlaylistAnlzItem | null
      const absoluteAnalyzePath = String(item?.analyzeFilePath || '').trim()
      const track = absoluteAnalyzePathToTrack.get(absoluteAnalyzePath)
      if (!track) return
      if (!item?.beatGrid?.error) {
        const entries = normalizePioneerBeatGridEntries(item?.beatGrid?.entries)
        if (entries.length) entriesByTrack.set(track, entries)
      }
      const cueData = normalizePioneerCueDump(item?.cues || null)
      if (cueData.hotCues || cueData.memoryCues) {
        cueDataByTrack.set(track, cueData)
      }
    })
  } else {
    await readPioneerBeatGridsInWorker<{ total?: number }>(analyzePaths, (progress) => {
      const item = progress as WorkerBeatGridItem | null
      const absoluteAnalyzePath = String(item?.analyzeFilePath || '').trim()
      const track = absoluteAnalyzePathToTrack.get(absoluteAnalyzePath)
      const dump = item?.dump
      if (!track || dump?.error) return
      const entries = normalizePioneerBeatGridEntries(dump?.entries)
      if (entries.length) entriesByTrack.set(track, entries)
    })
  }

  const probePaths = tracks
    .filter((track) => track.fileMissing !== true && Boolean(entriesByTrack.get(track)?.length))
    .map((track) => track.filePath)
  await resolveAudioTimeBasisOffsetMsForFiles(probePaths)

  const results = [...tracks]
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]
    const entries = entriesByTrack.get(track)
    const cueData = cueDataByTrack.get(track)
    const beatGridMap = entries?.length
      ? createSongBeatGridMapV2FromRekordboxEntries(entries)
      : undefined
    let timeBasisOffsetMs: number | undefined
    if (beatGridMap && track.fileMissing !== true) {
      try {
        timeBasisOffsetMs = await resolveAudioTimeBasisOffsetMsForFile(track.filePath)
      } catch {
        timeBasisOffsetMs = undefined
      }
    }
    if (!entries?.length && !cueData && timeBasisOffsetMs === undefined) continue
    results[index] = {
      ...track,
      ...(entries?.length ? { rekordboxGridEntries: entries } : {}),
      ...(beatGridMap
        ? {
            beatGridMap,
            bpm: beatGridMap.clips[0]?.bpm || track.bpm,
            ...(timeBasisOffsetMs !== undefined ? { timeBasisOffsetMs } : {})
          }
        : {}),
      ...(cueData?.hotCues ? { hotCues: cueData.hotCues } : {}),
      ...(cueData?.memoryCues ? { memoryCues: cueData.memoryCues } : {})
    }
  }
  return results
}

export async function attachPioneerPlaylistRuntime(
  rootPath: string,
  tracks: IPioneerPlaylistTrack[],
  options?: { includeCues?: boolean; requireCues?: boolean }
): Promise<IPioneerPlaylistTrack[]> {
  if (!tracks.length) return tracks
  const existencePromise = markMissingFiles(tracks)
  const cueTracks =
    options?.requireCues === true
      ? await enrichPioneerTracksWithCueData(rootPath, tracks, { requireCues: true })
      : tracks
  const tracksWithRuntime = await attachPioneerAnlzRuntime(
    rootPath,
    cueTracks,
    options?.requireCues === true ? { includeCues: false } : options
  )
  await existencePromise
  return applyMissingFileFlags(tracksWithRuntime, tracks)
}

const deriveArtistFromFileName = (fileName: string) => {
  const normalized = String(fileName || '').trim()
  if (!normalized) return ''
  const ext = normalized.includes('.') ? normalized.replace(/\.[^.]+$/, '') : normalized
  const separatorIndex = ext.indexOf(' - ')
  if (separatorIndex <= 0) return ''
  return ext.slice(0, separatorIndex).trim()
}

const deriveArtistFromFilePath = (filePath: string, album: string) => {
  const normalized = String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
  if (!normalized) return ''
  const contentsIndex = normalized.toLowerCase().indexOf('/contents/')
  const relative =
    contentsIndex >= 0 ? normalized.slice(contentsIndex + '/Contents/'.length) : normalized
  const segments = relative.split('/').filter(Boolean)
  if (segments.length < 2) return ''
  const artistFolder = String(segments[0] || '').trim()
  if (!artistFolder) return ''
  if (album && artistFolder.toLowerCase() === album.toLowerCase()) return ''
  return artistFolder.replace(/_/g, ', ').trim()
}

const resolvePioneerArtistText = (params: {
  mappedArtist: string
  fileName: string
  filePath: string
  album: string
}) => {
  const mapped = String(params.mappedArtist || '').trim()
  if (mapped) return mapped
  const fromFileName = deriveArtistFromFileName(params.fileName)
  if (fromFileName) return fromFileName
  const fromFilePath = deriveArtistFromFilePath(params.filePath, params.album)
  if (fromFilePath) return fromFilePath
  return ''
}

export async function loadPioneerPlaylistTracksByDrivePath(
  rootPath: string,
  playlistId: number,
  libraryType: PioneerLibraryKind = 'deviceLibrary',
  options?: { includeRuntime?: boolean }
): Promise<{
  drivePath: string
  libraryType: PioneerLibraryKind
  databasePath: string
  playlistId: number
  playlistName: string
  trackTotal: number
  tracks: IPioneerPlaylistTrack[]
}> {
  const probe = await probePioneerDeviceLibraryRoot(rootPath)
  const databasePath = resolvePioneerDatabasePath(probe, libraryType)
  if (!databasePath) {
    throw new Error(
      libraryType === 'oneLibrary'
        ? '未找到 Pioneer OneLibrary 的 exportLibrary.db'
        : '未找到 Pioneer Device Library 的 export.pdb'
    )
  }
  const safePlaylistId = Number(playlistId) || 0
  if (safePlaylistId <= 0) {
    throw new Error('playlistId 无效')
  }

  let loaded: PioneerPlaylistTrackLoadResult
  if (libraryType === 'oneLibrary') {
    loaded = readOneLibraryPlaylistTracks(databasePath, safePlaylistId)
  } else {
    const result = await readPioneerPlaylistTracksInWorker<RustPioneerPlaylistTrackDump>(
      databasePath,
      safePlaylistId
    )
    if (result?.error) {
      throw new Error(String(result.error))
    }
    loaded = normalizePioneerPlaylistTrackDump(result, safePlaylistId, databasePath)

    if (probe.oneLibraryDbPath) {
      try {
        const oneLibrary = readOneLibraryPlaylistTracks(probe.oneLibraryDbPath, safePlaylistId)
        loaded = reconcileDeviceLibraryPlaylistTracks(loaded, oneLibrary).result
      } catch (error) {
        // Device Library PDB 可以存在 OneLibrary 中没有的歌单，保留 PDB 原始曲目即可。
        if (!(error instanceof OneLibraryPlaylistNotFoundError)) {
          log.error(
            '[pioneer-device-library] read OneLibrary companion for Device Library failed',
            {
              playlistId: safePlaylistId,
              databasePath: probe.oneLibraryDbPath,
              error
            }
          )
        }
      }
    }
  }

  const playlistName = String(loaded.playlistName || '').trim()
  const rawTracks = Array.isArray(loaded?.tracks) ? loaded.tracks : []
  const tracks: IPioneerPlaylistTrack[] = rawTracks.map((track) => {
    const playlistIdValue = Number(track?.playlistId) || safePlaylistId
    const trackIdValue = Number(track?.trackId) || 0
    const entryIndexValue = Number(track?.entryIndex) || 0
    const deviceRelativeFilePath = String(track?.filePath || '').trim()
    const filePath = resolvePioneerDevicePath(rootPath, deviceRelativeFilePath)
    const fileName = String(track?.fileName || '').trim()
    const fileFormat = deriveFileFormat(fileName, deviceRelativeFilePath || filePath)
    const durationSec = Number(track?.durationSec) || 0
    const artworkPath = String(track?.artworkPath || '').trim()
    const coverPath = artworkPath ? resolvePioneerDevicePath(rootPath, artworkPath) : ''
    const albumText = String(track?.album || '').trim()
    const mappedArtist = String(track?.artist || '').trim()
    const resolvedArtist = resolvePioneerArtistText({
      mappedArtist,
      fileName,
      filePath: deviceRelativeFilePath || filePath,
      album: albumText
    })
    return {
      rowKey: `pioneer:${playlistIdValue}:${entryIndexValue}:${trackIdValue}`,
      playlistId: playlistIdValue,
      playlistName,
      trackId: trackIdValue,
      entryIndex: entryIndexValue,
      title: String(track?.title || '').trim(),
      artist: resolvedArtist,
      album: albumText,
      label: String(track?.label || '').trim(),
      genre: String(track?.genre || '').trim(),
      filePath,
      fileName,
      fileFormat,
      container: fileFormat,
      duration: formatDuration(durationSec),
      durationSec,
      bpm: Number(track?.bpm) || undefined,
      key: String(track?.keyText || '').trim() || undefined,
      bitrate: Number(track?.bitrate) || undefined,
      sampleRate: Number(track?.sampleRate) || undefined,
      sampleDepth: Number(track?.sampleDepth) || undefined,
      trackNumber: Number(track?.trackNumber) || undefined,
      discNumber: Number(track?.discNumber) || undefined,
      year: Number(track?.year) || undefined,
      analyzePath: String(track?.analyzePath || '').trim() || undefined,
      comment: String(track?.comment || '').trim() || undefined,
      dateAdded: String(track?.dateAdded || '').trim() || undefined,
      artworkId: Number(track?.artworkId) || undefined,
      artworkPath: artworkPath || undefined,
      coverPath: coverPath || undefined
    }
  })

  const tracksWithRuntime =
    options?.includeRuntime === false
      ? tracks
      : await attachPioneerPlaylistRuntime(rootPath, tracks, { includeCues: true })
  if (options?.includeRuntime === false) await markMissingFiles(tracks)

  return {
    drivePath: rootPath,
    libraryType,
    databasePath: loaded.databasePath,
    playlistId: Number(loaded.playlistId) || safePlaylistId,
    playlistName,
    trackTotal: Number(loaded.trackTotal) || tracksWithRuntime.length,
    tracks: tracksWithRuntime
  }
}
