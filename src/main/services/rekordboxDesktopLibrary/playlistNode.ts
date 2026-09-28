import { requireRekordboxDesktopLibraryProbe } from './detect'
import { buildRekordboxDesktopFailureSummary, logRekordboxDesktopFailure } from './failure'
import { runRekordboxDesktopHelper } from './helper'
import type {
  RekordboxDesktopHelperDeletePlaylistPayload,
  RekordboxDesktopHelperError,
  RekordboxDesktopHelperRenamePlaylistPayload
} from './types'
import type {
  RekordboxDesktopDeletePlaylistRequest,
  RekordboxDesktopDeletePlaylistResponse,
  RekordboxDesktopRenamePlaylistRequest,
  RekordboxDesktopRenamePlaylistResponse
} from '../../../shared/rekordboxDesktopPlaylist'

const sanitizeNodeName = (value: unknown) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')

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

const buildFailureResponse = (
  action: 'rename' | 'delete',
  errorCode: string,
  errorMessage: string,
  details?: Record<string, unknown>
): RekordboxDesktopRenamePlaylistResponse | RekordboxDesktopDeletePlaylistResponse => {
  logRekordboxDesktopFailure(
    `[rekordbox-desktop-playlist] ${action} playlist failed`,
    errorCode,
    errorMessage,
    details
  )
  return {
    ok: false,
    summary: buildRekordboxDesktopFailureSummary(errorCode, errorMessage)
  }
}

export async function renameRekordboxDesktopPlaylistNode(
  request: RekordboxDesktopRenamePlaylistRequest
): Promise<RekordboxDesktopRenamePlaylistResponse> {
  const playlistId = Math.max(0, Number(request.playlistId) || 0)
  const name = sanitizeNodeName(request.name)

  if (playlistId <= 0) {
    return buildFailureResponse('rename', 'INVALID_PLAYLIST_ID', '目标 Rekordbox 节点无效。', {
      playlistId,
      name
    }) as RekordboxDesktopRenamePlaylistResponse
  }

  if (!name) {
    return buildFailureResponse('rename', 'INVALID_PLAYLIST_NAME', '名称不能为空。', {
      playlistId
    }) as RekordboxDesktopRenamePlaylistResponse
  }

  let probe: Awaited<ReturnType<typeof requireRekordboxDesktopLibraryProbe>>
  try {
    probe = await requireRekordboxDesktopLibraryProbe()
  } catch (error) {
    return buildFailureResponse(
      'rename',
      getErrorCode(error, 'REKORDBOX_DB_OPEN_FAILED'),
      getErrorMessage(error, '未检测到可写入的 Rekordbox 库。'),
      {
        playlistId,
        name
      }
    ) as RekordboxDesktopRenamePlaylistResponse
  }

  try {
    const payload = await runRekordboxDesktopHelper<
      RekordboxDesktopHelperRenamePlaylistPayload,
      {
        dbPath: string
        dbDir: string
        playlistId: number
        name: string
      }
    >('rename-playlist', {
      dbPath: probe.dbPath,
      dbDir: probe.dbDir,
      playlistId,
      name
    })

    const resolvedName = sanitizeNodeName(payload?.playlistName || name)
    if (!resolvedName) {
      return buildFailureResponse(
        'rename',
        'PLAYLIST_RENAME_FAILED',
        'Rekordbox 返回了无效的节点名称。',
        {
          playlistId,
          name,
          helperPayload: payload
        }
      ) as RekordboxDesktopRenamePlaylistResponse
    }

    return {
      ok: true,
      summary: {
        playlistId: Number(payload?.playlistId) || playlistId,
        playlistName: resolvedName,
        parentId: Number(payload?.parentId) || 0,
        isFolder: Boolean(payload?.isFolder)
      }
    }
  } catch (error) {
    return buildFailureResponse(
      'rename',
      getErrorCode(error, 'PLAYLIST_RENAME_FAILED'),
      getErrorMessage(error, '重命名 Rekordbox 节点失败。'),
      {
        playlistId,
        name,
        error
      }
    ) as RekordboxDesktopRenamePlaylistResponse
  }
}

export async function deleteRekordboxDesktopPlaylistNode(
  request: RekordboxDesktopDeletePlaylistRequest
): Promise<RekordboxDesktopDeletePlaylistResponse> {
  const playlistId = Math.max(0, Number(request.playlistId) || 0)

  if (playlistId <= 0) {
    return buildFailureResponse('delete', 'INVALID_PLAYLIST_ID', '目标 Rekordbox 节点无效。', {
      playlistId
    }) as RekordboxDesktopDeletePlaylistResponse
  }

  let probe: Awaited<ReturnType<typeof requireRekordboxDesktopLibraryProbe>>
  try {
    probe = await requireRekordboxDesktopLibraryProbe()
  } catch (error) {
    return buildFailureResponse(
      'delete',
      getErrorCode(error, 'REKORDBOX_DB_OPEN_FAILED'),
      getErrorMessage(error, '未检测到可写入的 Rekordbox 库。'),
      {
        playlistId
      }
    ) as RekordboxDesktopDeletePlaylistResponse
  }

  try {
    const payload = await runRekordboxDesktopHelper<
      RekordboxDesktopHelperDeletePlaylistPayload,
      {
        dbPath: string
        dbDir: string
        playlistId: number
      }
    >('delete-playlist', {
      dbPath: probe.dbPath,
      dbDir: probe.dbDir,
      playlistId
    })

    return {
      ok: true,
      summary: {
        playlistId: Number(payload?.playlistId) || playlistId,
        parentId: Number(payload?.parentId) || 0,
        isFolder: Boolean(payload?.isFolder),
        playlistName: sanitizeNodeName(payload?.playlistName || '')
      }
    }
  } catch (error) {
    return buildFailureResponse(
      'delete',
      getErrorCode(error, 'PLAYLIST_DELETE_FAILED'),
      getErrorMessage(error, '删除 Rekordbox 节点失败。'),
      {
        playlistId,
        error
      }
    ) as RekordboxDesktopDeletePlaylistResponse
  }
}
