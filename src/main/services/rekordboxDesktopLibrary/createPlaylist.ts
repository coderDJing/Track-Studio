import fs from 'fs-extra'
import path from 'path'
import store from '../../store'
import { resolveLibraryPath } from '../../utils'
import { readTrackMetadata } from '../metadataEditor'
import { scanSongListOffMainThread } from '../songListScanWorker'
import { loadSharedSongHotCueDefinition } from '../sharedSongHotCues'
import { loadSharedSongMemoryCueDefinition } from '../sharedSongMemoryCues'
import { normalizeSongHotCues } from '../../../shared/hotCues'
import { normalizeSongMemoryCues } from '../../../shared/memoryCues'
import { sortByPlaylistTrackNumber } from '../../../shared/playlistTrackOrder'
import { requireRekordboxDesktopLibraryProbe } from './detect'
import { buildRekordboxDesktopFailureSummary, logRekordboxDesktopFailure } from './failure'
import { runRekordboxDesktopHelper } from './helper'
import type {
  RekordboxDesktopHelperCreatePlaylistPayload,
  RekordboxDesktopHelperCreatePlaylistTrack,
  RekordboxDesktopHelperError
} from './types'
import type {
  RekordboxDesktopPlaylistRequest,
  RekordboxDesktopPlaylistResponse,
  RekordboxDesktopPlaylistTrackInput,
  RekordboxDesktopPlaylistWriteTarget
} from '../../../shared/rekordboxDesktopPlaylist'
import type { ISongHotCue, ISongMemoryCue } from '../../../types/globals'

type ResolvedTrack = {
  sourcePath: string
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  genre?: string
  composer?: string
  lyricist?: string
  label?: string
  isrc?: string
  comment?: string
  year?: string
  trackNumber?: number
  discNumber?: number
  durationSeconds?: number
  bitrate?: number
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
}

type SourceTracksResult =
  | {
      ok: true
      tracks: ResolvedTrack[]
    }
  | {
      ok: false
      code: string
      message: string
    }

type RekordboxDesktopPlaylistProgressPayload = {
  id: string
  titleKey: string
  now: number
  total: number
  isInitial?: boolean
  dismiss?: boolean
  noProgress?: boolean
}

type RekordboxDesktopPlaylistRunOptions = {
  reportProgress?: (payload: RekordboxDesktopPlaylistProgressPayload) => void | Promise<void>
}

const buildFailureResponse = (
  errorCode: string,
  errorMessage: string,
  details?: Record<string, unknown>
): RekordboxDesktopPlaylistResponse => {
  logRekordboxDesktopFailure(
    '[rekordbox-desktop-playlist] write failed',
    errorCode,
    errorMessage,
    details
  )
  return {
    ok: false,
    summary: buildRekordboxDesktopFailureSummary(errorCode, errorMessage)
  }
}

const sanitizePlaylistName = (value: string) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')

const resolveWriteTarget = (target: RekordboxDesktopPlaylistWriteTarget | undefined) => {
  if (target?.mode === 'append') {
    const playlistId = Number(target.playlistId) || 0
    if (playlistId <= 0) {
      return {
        ok: false as const,
        code: 'INVALID_PLAYLIST_ID',
        message: '目标 Rekordbox 播放列表无效。'
      }
    }
    return {
      ok: true as const,
      target: {
        mode: 'append' as const,
        playlistId,
        playlistName: sanitizePlaylistName(String(target.playlistName || ''))
      }
    }
  }

  if (target?.mode === 'create') {
    const playlistName = sanitizePlaylistName(target.playlistName)
    if (!playlistName) {
      return {
        ok: false as const,
        code: 'INVALID_PLAYLIST_NAME',
        message: '播放列表名称不能为空。'
      }
    }
    return {
      ok: true as const,
      target: {
        mode: 'create' as const,
        playlistName,
        parentId: Math.max(0, Number(target.parentId) || 0)
      }
    }
  }

  return {
    ok: false as const,
    code: 'INVALID_PLAYLIST_NAME',
    message: '缺少 Rekordbox 写入目标。'
  }
}

const sanitizeOptionalText = (value: unknown) => {
  const text = String(value || '').trim()
  return text || undefined
}

const parseDurationSeconds = (value: string | undefined) => {
  const text = String(value || '').trim()
  if (!text) return undefined
  const parts = text.split(':').map((part) => Number(part))
  if (parts.length !== 2 || parts.some((part) => Number.isNaN(part) || part < 0)) return undefined
  return parts[0] * 60 + parts[1]
}

const validateSelectedTrackInputs = (tracks: RekordboxDesktopPlaylistTrackInput[]) => {
  const normalized = Array.isArray(tracks)
    ? tracks.filter(
        (item): item is RekordboxDesktopPlaylistTrackInput =>
          !!item && typeof item.filePath === 'string' && item.filePath.trim().length > 0
      )
    : []
  if (normalized.length === 0) {
    return {
      ok: false as const,
      code: 'NO_TRACKS',
      message: '没有可写入 Rekordbox 的曲目。'
    }
  }
  return {
    ok: true as const,
    tracks: sortByPlaylistTrackNumber(normalized).map((item) => {
      return {
        sourcePath: path.resolve(item.filePath),
        title: sanitizeOptionalText(item.displayName),
        artist: sanitizeOptionalText(item.artist),
        album: sanitizeOptionalText(item.album),
        genre: sanitizeOptionalText(item.genre),
        label: sanitizeOptionalText(item.label),
        durationSeconds: parseDurationSeconds(item.duration),
        bitrate:
          typeof item.bitrate === 'number' && Number.isFinite(item.bitrate) && item.bitrate > 0
            ? item.bitrate
            : undefined,
        hotCues: normalizeSongHotCues(item.hotCues),
        memoryCues: normalizeSongMemoryCues(item.memoryCues)
      } satisfies ResolvedTrack
    })
  }
}

const resolveSelectedTracks = (request: RekordboxDesktopPlaylistRequest): SourceTracksResult => {
  if (request.source.kind !== 'selected-tracks') {
    return {
      ok: false,
      code: 'INVALID_SOURCE',
      message: '写入源类型无效。'
    }
  }
  return validateSelectedTrackInputs(request.source.tracks)
}

const resolvePlaylistTracks = async (
  request: RekordboxDesktopPlaylistRequest
): Promise<SourceTracksResult> => {
  if (request.source.kind !== 'playlist') {
    return {
      ok: false,
      code: 'INVALID_SOURCE',
      message: '写入源类型无效。'
    }
  }

  const rendererPath = String(request.source.songListPath || '').trim()
  if (!rendererPath) {
    return {
      ok: false,
      code: 'PLAYLIST_PATH_REQUIRED',
      message: '缺少歌单路径。'
    }
  }

  const absolutePlaylistPath = resolveLibraryPath(rendererPath).absPath
  const result = await scanSongListOffMainThread({
    scanPath: absolutePlaylistPath,
    audioExt: store.settingConfig.audioExt,
    songListUUID: request.source.songListUUID,
    databaseDir: store.databaseDir
  })
  const scanData = Array.isArray(result?.scanData) ? result.scanData : []
  if (scanData.length === 0) {
    return {
      ok: false,
      code: 'NO_TRACKS',
      message: '当前歌单里没有可写入 Rekordbox 的曲目。'
    }
  }
  const orderedScanData = sortByPlaylistTrackNumber(scanData)

  return {
    ok: true,
    tracks: orderedScanData.map((item) => {
      return {
        sourcePath: path.resolve(item.filePath),
        title: sanitizeOptionalText(item.title),
        artist: sanitizeOptionalText(item.artist),
        album: sanitizeOptionalText(item.album),
        genre: sanitizeOptionalText(item.genre),
        label: sanitizeOptionalText(item.label),
        durationSeconds: parseDurationSeconds(item.duration),
        bitrate:
          typeof item.bitrate === 'number' && Number.isFinite(item.bitrate) && item.bitrate > 0
            ? item.bitrate
            : undefined,
        hotCues: normalizeSongHotCues(item.hotCues),
        memoryCues: normalizeSongMemoryCues(item.memoryCues)
      } satisfies ResolvedTrack
    })
  }
}

const resolveSourceTracks = async (
  request: RekordboxDesktopPlaylistRequest
): Promise<SourceTracksResult> => {
  if (request.source.kind === 'selected-tracks') {
    return resolveSelectedTracks(request)
  }
  return await resolvePlaylistTracks(request)
}

const enrichTracksWithMetadata = async (tracks: ResolvedTrack[]) => {
  return await Promise.all(
    tracks.map(async (track) => {
      try {
        const detail = await readTrackMetadata(track.sourcePath)
        if (!detail) return track
        return {
          ...track,
          title: sanitizeOptionalText(detail.title) || track.title,
          artist: sanitizeOptionalText(detail.artist) || track.artist,
          album: sanitizeOptionalText(detail.album) || track.album,
          albumArtist: sanitizeOptionalText(detail.albumArtist) || track.albumArtist,
          genre: sanitizeOptionalText(detail.genre) || track.genre,
          composer: sanitizeOptionalText(detail.composer) || track.composer,
          lyricist: sanitizeOptionalText(detail.lyricist) || track.lyricist,
          label: sanitizeOptionalText(detail.label) || track.label,
          isrc: sanitizeOptionalText(detail.isrc) || track.isrc,
          comment: sanitizeOptionalText(detail.comment) || track.comment,
          year: sanitizeOptionalText(detail.year) || track.year,
          trackNumber:
            typeof detail.trackNo === 'number' &&
            Number.isFinite(detail.trackNo) &&
            detail.trackNo > 0
              ? detail.trackNo
              : track.trackNumber,
          discNumber:
            typeof detail.discNo === 'number' && Number.isFinite(detail.discNo) && detail.discNo > 0
              ? detail.discNo
              : track.discNumber,
          durationSeconds:
            typeof detail.durationSeconds === 'number' &&
            Number.isFinite(detail.durationSeconds) &&
            detail.durationSeconds > 0
              ? detail.durationSeconds
              : track.durationSeconds
        } satisfies ResolvedTrack
      } catch {
        return track
      }
    })
  )
}

const enrichTracksWithSharedCues = async (tracks: ResolvedTrack[]) => {
  return await Promise.all(
    tracks.map(async (track) => {
      const existingHotCues = normalizeSongHotCues(track.hotCues)
      const existingMemoryCues = normalizeSongMemoryCues(track.memoryCues)
      if (existingHotCues.length > 0 && existingMemoryCues.length > 0) {
        return {
          ...track,
          hotCues: existingHotCues,
          memoryCues: existingMemoryCues
        }
      }

      const [sharedHotCueDefinition, sharedMemoryCueDefinition] = await Promise.all([
        existingHotCues.length > 0
          ? Promise.resolve(null)
          : loadSharedSongHotCueDefinition(track.sourcePath),
        existingMemoryCues.length > 0
          ? Promise.resolve(null)
          : loadSharedSongMemoryCueDefinition(track.sourcePath)
      ])

      return {
        ...track,
        hotCues:
          existingHotCues.length > 0
            ? existingHotCues
            : normalizeSongHotCues(sharedHotCueDefinition?.hotCues),
        memoryCues:
          existingMemoryCues.length > 0
            ? existingMemoryCues
            : normalizeSongMemoryCues(sharedMemoryCueDefinition?.memoryCues)
      } satisfies ResolvedTrack
    })
  )
}

const collectMissingSourcePaths = async (sourcePaths: string[]) => {
  const missing: string[] = []
  for (const sourcePath of sourcePaths) {
    try {
      const exists = await fs.pathExists(sourcePath)
      if (!exists) missing.push(sourcePath)
    } catch {
      missing.push(sourcePath)
    }
  }
  return missing
}

const buildHelperTrackPayload = (
  track: ResolvedTrack
): RekordboxDesktopHelperCreatePlaylistTrack => ({
  filePath: track.sourcePath,
  title: track.title,
  artist: track.artist,
  album: track.album,
  albumArtist: track.albumArtist,
  genre: track.genre,
  composer: track.composer,
  lyricist: track.lyricist,
  label: track.label,
  isrc: track.isrc,
  comment: track.comment,
  year: track.year,
  trackNumber:
    typeof track.trackNumber === 'number' && Number.isFinite(track.trackNumber)
      ? track.trackNumber
      : null,
  discNumber:
    typeof track.discNumber === 'number' && Number.isFinite(track.discNumber)
      ? track.discNumber
      : null,
  durationSeconds:
    typeof track.durationSeconds === 'number' && Number.isFinite(track.durationSeconds)
      ? track.durationSeconds
      : null,
  bitrate:
    typeof track.bitrate === 'number' && Number.isFinite(track.bitrate) ? track.bitrate : null,
  hotCues: Array.isArray(track.hotCues) ? track.hotCues.map((cue) => ({ ...cue })) : [],
  memoryCues: Array.isArray(track.memoryCues) ? track.memoryCues.map((cue) => ({ ...cue })) : []
})

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

const reportProgress = async (
  request: RekordboxDesktopPlaylistRequest,
  options: RekordboxDesktopPlaylistRunOptions,
  payload: Omit<RekordboxDesktopPlaylistProgressPayload, 'id'>
) => {
  if (typeof options.reportProgress !== 'function') return
  await options.reportProgress({
    id: request.jobId,
    ...payload
  })
}

export async function createRekordboxDesktopPlaylist(
  request: RekordboxDesktopPlaylistRequest,
  options: RekordboxDesktopPlaylistRunOptions = {}
): Promise<RekordboxDesktopPlaylistResponse> {
  await reportProgress(request, options, {
    titleKey: 'rekordboxDesktop.preparing',
    now: 0,
    total: 1,
    isInitial: true,
    noProgress: true
  })

  const dismissProgress = async () => {
    await reportProgress(request, options, {
      titleKey: 'rekordboxDesktop.preparing',
      now: 0,
      total: 0,
      dismiss: true
    })
  }

  const fail = async (
    errorCode: string,
    errorMessage: string,
    details?: Record<string, unknown>
  ) => {
    await dismissProgress()
    return buildFailureResponse(errorCode, errorMessage, details)
  }

  const targetResult = resolveWriteTarget(request.target)
  if (!targetResult.ok) {
    return await fail(targetResult.code, targetResult.message, {
      sourceKind: request.source.kind
    })
  }
  const target = targetResult.target

  let probe: Awaited<ReturnType<typeof requireRekordboxDesktopLibraryProbe>>
  try {
    probe = await requireRekordboxDesktopLibraryProbe()
  } catch (error) {
    return await fail(
      getErrorCode(error, 'REKORDBOX_DB_OPEN_FAILED'),
      getErrorMessage(error, '未检测到可写入的 Rekordbox 库。'),
      {
        sourceKind: request.source.kind,
        target
      }
    )
  }

  const sourceTracksResult = await resolveSourceTracks(request)
  if (!sourceTracksResult.ok) {
    return await fail(sourceTracksResult.code, sourceTracksResult.message, {
      sourceKind: request.source.kind,
      target
    })
  }

  const sourceTracks = await enrichTracksWithSharedCues(
    await enrichTracksWithMetadata(sourceTracksResult.tracks)
  )
  const missingPaths = await collectMissingSourcePaths(
    sourceTracks.map((track) => track.sourcePath)
  )
  if (missingPaths.length > 0) {
    return await fail(
      'TRACK_FILE_MISSING',
      `存在缺失文件，已阻止写入 Rekordbox。缺失数量：${missingPaths.length}`,
      {
        sourceKind: request.source.kind,
        target,
        missingPaths
      }
    )
  }

  const totalSteps = sourceTracks.length + 1
  await reportProgress(request, options, {
    titleKey: 'rekordboxDesktop.importingTracks',
    now: 0,
    total: totalSteps,
    isInitial: true,
    noProgress: false
  })

  try {
    const helperCommand = target.mode === 'append' ? 'append-playlist' : 'create-playlist'
    const payload = await runRekordboxDesktopHelper<
      RekordboxDesktopHelperCreatePlaylistPayload,
      {
        dbPath: string
        dbDir: string
        playlistName?: string
        parentId?: number
        playlistId?: number
        tracks: RekordboxDesktopHelperCreatePlaylistTrack[]
      }
    >(
      helperCommand,
      {
        dbPath: probe.dbPath,
        dbDir: probe.dbDir,
        ...(target.mode === 'append'
          ? { playlistId: target.playlistId }
          : { playlistName: target.playlistName, parentId: target.parentId }),
        tracks: sourceTracks.map((track) => buildHelperTrackPayload(track))
      },
      {
        onProgress: (progressPayload) => {
          const stage = String(progressPayload.stage || '').trim()
          if (stage === 'committing') {
            void reportProgress(request, options, {
              titleKey: 'rekordboxDesktop.committingChanges',
              now: totalSteps - 1,
              total: totalSteps,
              noProgress: false
            })
            return
          }

          const completedTracks = Number(progressPayload.completedTracks) || 0
          void reportProgress(request, options, {
            titleKey: 'rekordboxDesktop.importingTracks',
            now: Math.max(0, Math.min(sourceTracks.length, completedTracks)),
            total: totalSteps,
            noProgress: false
          })
        }
      }
    )

    const playlistId = Number(payload?.playlistId) || 0
    const fallbackPlaylistName =
      target.mode === 'append' ? target.playlistName : target.playlistName
    const resolvedPlaylistName = sanitizePlaylistName(
      String(payload?.playlistName || fallbackPlaylistName)
    )
    if (playlistId <= 0 || !resolvedPlaylistName) {
      return await fail('PLAYLIST_CREATE_FAILED', 'Rekordbox 返回了无效的播放列表结果。', {
        sourceKind: request.source.kind,
        target,
        helperPayload: payload
      })
    }

    await reportProgress(request, options, {
      titleKey: 'rekordboxDesktop.committingChanges',
      now: totalSteps,
      total: totalSteps,
      noProgress: false
    })

    return {
      ok: true,
      summary: {
        mode: target.mode,
        playlistId,
        playlistName: resolvedPlaylistName,
        trackCount: Number(payload?.trackTotal) || sourceTracks.length,
        addedToPlaylistCount:
          Number(payload?.addedToPlaylistCount) ||
          Math.max(0, sourceTracks.length - (Number(payload?.skippedDuplicateCount) || 0)),
        addedToCollectionCount: Number(payload?.addedToCollectionCount) || 0,
        reusedCollectionCount: Number(payload?.reusedCollectionCount) || 0,
        skippedDuplicateCount: Number(payload?.skippedDuplicateCount) || 0
      }
    }
  } catch (error) {
    await reportProgress(request, options, {
      titleKey: 'rekordboxDesktop.importingTracks',
      now: 0,
      total: 0,
      dismiss: true
    })
    return buildFailureResponse(
      getErrorCode(error, 'PLAYLIST_CREATE_FAILED'),
      getErrorMessage(error, '写入 Rekordbox 播放列表失败。'),
      {
        sourceKind: request.source.kind,
        target,
        error
      }
    )
  }
}
