import type { IPioneerPlaylistTrack } from '../../../types/globals'
import { attachPioneerPlaylistRuntime } from '../pioneerDeviceLibrary/tree'
import { requireRekordboxDesktopLibraryProbe } from './detect'
import { buildRekordboxDesktopFailureSummary, logRekordboxDesktopFailure } from './failure'
import { runRekordboxDesktopHelper } from './helper'
import type {
  RekordboxDesktopHelperError,
  RekordboxDesktopHelperReorderPlaylistTracksPayload,
  RekordboxDesktopHelperRemovePlaylistTracksPayload,
  RekordboxDesktopHelperTrackRecord,
  RekordboxDesktopHelperTracksPayload,
  RekordboxDesktopLibraryTrackLoadResult
} from './types'
import type {
  RekordboxDesktopReorderPlaylistTracksRequest,
  RekordboxDesktopReorderPlaylistTracksResponse,
  RekordboxDesktopRemovePlaylistTracksRequest,
  RekordboxDesktopRemovePlaylistTracksResponse
} from '../../../shared/rekordboxDesktopPlaylist'

const normalizeRekordboxGridEntries = (
  value: RekordboxDesktopHelperTrackRecord['rekordboxGridEntries']
) => {
  if (!Array.isArray(value) || value.length === 0) return []
  const entries = value
    .map((entry) => ({
      timeMs: Number(entry?.timeMs),
      bpm: Number(entry?.bpm),
      beatNumber: Number(entry?.beatNumber)
    }))
    .filter(
      (entry) =>
        Number.isFinite(entry.timeMs) &&
        entry.timeMs >= 0 &&
        Number.isFinite(entry.bpm) &&
        entry.bpm > 0 &&
        Number.isInteger(entry.beatNumber) &&
        entry.beatNumber >= 1 &&
        entry.beatNumber <= 4
    )
    .sort((left, right) => left.timeMs - right.timeMs)
  if (
    !entries.length ||
    entries.some((entry, index) => index > 0 && entry.timeMs <= entries[index - 1].timeMs)
  ) {
    return []
  }
  return entries
}

const normalizeTrack = (
  track: RekordboxDesktopHelperTrackRecord | null | undefined
): IPioneerPlaylistTrack | null => {
  const rowKey = String(track?.rowKey || '').trim()
  const filePath = String(track?.filePath || '').trim()
  const playlistId = Number(track?.playlistId) || 0
  const trackId = Number(track?.trackId) || 0
  const entryIndex = Number(track?.entryIndex) || 0
  if (!rowKey || !filePath || !playlistId || !trackId) return null

  const rekordboxGridEntries = normalizeRekordboxGridEntries(track?.rekordboxGridEntries)
  return {
    rowKey,
    playlistId,
    playlistName: String(track?.playlistName || '').trim(),
    trackId,
    entryIndex,
    title: String(track?.title || '').trim(),
    artist: String(track?.artist || '').trim(),
    album: String(track?.album || '').trim(),
    label: String(track?.label || '').trim(),
    genre: String(track?.genre || '').trim(),
    filePath,
    fileName: String(track?.fileName || '').trim(),
    fileFormat: String(track?.fileFormat || '').trim(),
    container: String(track?.container || '').trim(),
    duration: String(track?.duration || '').trim(),
    durationSec: Number(track?.durationSec) || 0,
    bpm: Number(track?.bpm) || undefined,
    key: String(track?.key || '').trim() || undefined,
    bitrate: Number(track?.bitrate) || undefined,
    sampleRate: Number(track?.sampleRate) || undefined,
    sampleDepth: Number(track?.sampleDepth) || undefined,
    trackNumber: Number(track?.trackNumber) || undefined,
    discNumber: Number(track?.discNumber) || undefined,
    year: Number(track?.year) || undefined,
    analyzePath: String(track?.analyzePath || '').trim() || undefined,
    rekordboxGridEntries: rekordboxGridEntries.length ? rekordboxGridEntries : undefined,
    comment: String(track?.comment || '').trim() || undefined,
    dateAdded: String(track?.dateAdded || '').trim() || undefined,
    artworkPath: String(track?.artworkPath || '').trim() || undefined,
    coverPath: String(track?.coverPath || '').trim() || undefined,
    hotCues: Array.isArray(track?.hotCues) ? track.hotCues.map((cue) => ({ ...cue })) : undefined,
    memoryCues: Array.isArray(track?.memoryCues)
      ? track.memoryCues.map((cue) => ({ ...cue }))
      : undefined
  }
}

export async function loadRekordboxDesktopPlaylistTracks(
  playlistId: number,
  options?: { includeRuntime?: boolean }
): Promise<RekordboxDesktopLibraryTrackLoadResult> {
  const probe = await requireRekordboxDesktopLibraryProbe()
  const safePlaylistId = Number(playlistId) || 0
  if (safePlaylistId <= 0) {
    throw new Error('playlistId 无效')
  }

  const payload = await runRekordboxDesktopHelper<
    RekordboxDesktopHelperTracksPayload,
    {
      dbPath: string
      dbDir: string
      playlistId: number
      parseAnlzGrid: boolean
    }
  >('load-playlist-tracks', {
    dbPath: probe.dbPath,
    dbDir: probe.dbDir,
    playlistId: safePlaylistId,
    parseAnlzGrid: false
  })

  const tracks = Array.isArray(payload?.tracks)
    ? payload.tracks
        .map((track) => normalizeTrack(track))
        .filter((track): track is IPioneerPlaylistTrack => Boolean(track))
    : []

  const tracksWithRuntime =
    options?.includeRuntime === false
      ? tracks
      : await attachPioneerPlaylistRuntime(probe.sourceRootPath, tracks, { includeCues: false })

  return {
    probe,
    playlistId: Number(payload?.playlistId) || safePlaylistId,
    playlistName: String(payload?.playlistName || '').trim(),
    trackTotal: Number(payload?.trackTotal) || tracksWithRuntime.length,
    tracks: tracksWithRuntime
  }
}

export async function attachRekordboxDesktopPlaylistRuntime(
  tracks: IPioneerPlaylistTrack[]
): Promise<IPioneerPlaylistTrack[]> {
  if (!tracks.length) return tracks
  const probe = await requireRekordboxDesktopLibraryProbe()
  return await attachPioneerPlaylistRuntime(probe.sourceRootPath, tracks, { includeCues: false })
}

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error) {
    const message = String(error.message || '').trim()
    return message || fallback
  }
  return String(error || fallback)
}

const getErrorCode = (error: unknown, fallback: string) => {
  const code = (error as RekordboxDesktopHelperError | null)?.code
  return typeof code === 'string' && code.trim() ? code.trim() : fallback
}

const buildTracksFailureResponse = (
  action: 'remove' | 'reorder',
  errorCode: string,
  errorMessage: string,
  details?: Record<string, unknown>
): RekordboxDesktopRemovePlaylistTracksResponse | RekordboxDesktopReorderPlaylistTracksResponse => {
  logRekordboxDesktopFailure(
    `[rekordbox-desktop-playlist] ${action} playlist tracks failed`,
    errorCode,
    errorMessage,
    details
  )
  return {
    ok: false,
    summary: buildRekordboxDesktopFailureSummary(errorCode, errorMessage)
  }
}

export async function removeRekordboxDesktopPlaylistTracks(
  request: RekordboxDesktopRemovePlaylistTracksRequest
): Promise<RekordboxDesktopRemovePlaylistTracksResponse> {
  const playlistId = Math.max(0, Number(request.playlistId) || 0)
  const rowKeys = Array.isArray(request.rowKeys)
    ? request.rowKeys.map((item) => String(item || '').trim()).filter(Boolean)
    : []

  if (playlistId <= 0) {
    return buildTracksFailureResponse(
      'remove',
      'INVALID_PLAYLIST_ID',
      '目标 Rekordbox 播放列表无效。',
      { playlistId, rowKeys }
    ) as RekordboxDesktopRemovePlaylistTracksResponse
  }
  if (rowKeys.length === 0) {
    return buildTracksFailureResponse(
      'remove',
      'PLAYLIST_TRACK_REMOVE_FAILED',
      '没有可移除的播放列表曲目。',
      { playlistId }
    ) as RekordboxDesktopRemovePlaylistTracksResponse
  }

  let probe: Awaited<ReturnType<typeof requireRekordboxDesktopLibraryProbe>>
  try {
    probe = await requireRekordboxDesktopLibraryProbe()
  } catch (error) {
    return buildTracksFailureResponse(
      'remove',
      getErrorCode(error, 'REKORDBOX_DB_OPEN_FAILED'),
      getErrorMessage(error, '未检测到可写入的 Rekordbox 库。'),
      { playlistId, rowKeys }
    ) as RekordboxDesktopRemovePlaylistTracksResponse
  }

  try {
    const payload = await runRekordboxDesktopHelper<
      RekordboxDesktopHelperRemovePlaylistTracksPayload,
      {
        dbPath: string
        dbDir: string
        playlistId: number
        rowKeys: string[]
      }
    >('remove-playlist-tracks', {
      dbPath: probe.dbPath,
      dbDir: probe.dbDir,
      playlistId,
      rowKeys
    })

    return {
      ok: true,
      summary: {
        playlistId: Number(payload?.playlistId) || playlistId,
        requestedCount: Number(payload?.requestedCount) || rowKeys.length,
        removedCount: Number(payload?.removedCount) || 0,
        skippedCount: Number(payload?.skippedCount) || 0
      }
    }
  } catch (error) {
    return buildTracksFailureResponse(
      'remove',
      getErrorCode(error, 'PLAYLIST_TRACK_REMOVE_FAILED'),
      getErrorMessage(error, '从 Rekordbox 播放列表移除曲目失败。'),
      { playlistId, rowKeys, error }
    ) as RekordboxDesktopRemovePlaylistTracksResponse
  }
}

export async function reorderRekordboxDesktopPlaylistTracks(
  request: RekordboxDesktopReorderPlaylistTracksRequest
): Promise<RekordboxDesktopReorderPlaylistTracksResponse> {
  const playlistId = Math.max(0, Number(request.playlistId) || 0)
  const rowKeys = Array.isArray(request.rowKeys)
    ? request.rowKeys.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  const targetIndex = Math.max(0, Number(request.targetIndex) || 0)

  if (playlistId <= 0) {
    return buildTracksFailureResponse(
      'reorder',
      'INVALID_PLAYLIST_ID',
      '目标 Rekordbox 播放列表无效。',
      { playlistId, rowKeys, targetIndex }
    ) as RekordboxDesktopReorderPlaylistTracksResponse
  }
  if (rowKeys.length === 0) {
    return buildTracksFailureResponse(
      'reorder',
      'PLAYLIST_TRACK_REORDER_FAILED',
      '没有可排序的播放列表曲目。',
      { playlistId, targetIndex }
    ) as RekordboxDesktopReorderPlaylistTracksResponse
  }

  let probe: Awaited<ReturnType<typeof requireRekordboxDesktopLibraryProbe>>
  try {
    probe = await requireRekordboxDesktopLibraryProbe()
  } catch (error) {
    return buildTracksFailureResponse(
      'reorder',
      getErrorCode(error, 'REKORDBOX_DB_OPEN_FAILED'),
      getErrorMessage(error, '未检测到可写入的 Rekordbox 库。'),
      { playlistId, rowKeys, targetIndex }
    ) as RekordboxDesktopReorderPlaylistTracksResponse
  }

  try {
    const payload = await runRekordboxDesktopHelper<
      RekordboxDesktopHelperReorderPlaylistTracksPayload,
      {
        dbPath: string
        dbDir: string
        playlistId: number
        rowKeys: string[]
        targetIndex: number
      }
    >('reorder-playlist-tracks', {
      dbPath: probe.dbPath,
      dbDir: probe.dbDir,
      playlistId,
      rowKeys,
      targetIndex
    })

    return {
      ok: true,
      summary: {
        playlistId: Number(payload?.playlistId) || playlistId,
        requestedCount: Number(payload?.requestedCount) || rowKeys.length,
        movedCount: Number(payload?.movedCount) || 0,
        targetIndex: Number(payload?.targetIndex) || targetIndex
      }
    }
  } catch (error) {
    return buildTracksFailureResponse(
      'reorder',
      getErrorCode(error, 'PLAYLIST_TRACK_REORDER_FAILED'),
      getErrorMessage(error, '调整 Rekordbox 播放列表曲目顺序失败。'),
      { playlistId, rowKeys, targetIndex, error }
    ) as RekordboxDesktopReorderPlaylistTracksResponse
  }
}
