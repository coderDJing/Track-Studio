import { requireRekordboxDesktopLibraryProbe } from './detect'
import { buildRekordboxDesktopFailureSummary, logRekordboxDesktopFailure } from './failure'
import { runRekordboxDesktopHelper } from './helper'
import type {
  RekordboxDesktopHelperCreateEmptyPlaylistPayload,
  RekordboxDesktopHelperCreateFolderPayload,
  RekordboxDesktopHelperError
} from './types'
import type {
  RekordboxDesktopCreateEmptyPlaylistRequest,
  RekordboxDesktopCreateEmptyPlaylistResponse,
  RekordboxDesktopCreateFolderRequest,
  RekordboxDesktopCreateFolderResponse,
  RekordboxDesktopPlaylistFailureSummary
} from '../../../shared/rekordboxDesktopPlaylist'

const sanitizeFolderName = (value: unknown) =>
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
  errorCode: string,
  errorMessage: string,
  details?: Record<string, unknown>
): {
  ok: false
  summary: RekordboxDesktopPlaylistFailureSummary
} => {
  logRekordboxDesktopFailure(
    '[rekordbox-desktop-playlist] create folder failed',
    errorCode,
    errorMessage,
    details
  )
  return {
    ok: false,
    summary: buildRekordboxDesktopFailureSummary(errorCode, errorMessage)
  }
}

export async function createRekordboxDesktopPlaylistFolder(
  request: RekordboxDesktopCreateFolderRequest
): Promise<RekordboxDesktopCreateFolderResponse> {
  const folderName = sanitizeFolderName(request.folderName)
  const parentId = Math.max(0, Number(request.parentId) || 0)
  if (!folderName) {
    return buildFailureResponse('INVALID_PLAYLIST_FOLDER_NAME', '文件夹名称不能为空。', {
      parentId
    })
  }

  let probe: Awaited<ReturnType<typeof requireRekordboxDesktopLibraryProbe>>
  try {
    probe = await requireRekordboxDesktopLibraryProbe()
  } catch (error) {
    return buildFailureResponse(
      getErrorCode(error, 'REKORDBOX_DB_OPEN_FAILED'),
      getErrorMessage(error, '未检测到可写入的 Rekordbox 库。'),
      {
        folderName,
        parentId
      }
    )
  }

  try {
    const payload = await runRekordboxDesktopHelper<
      RekordboxDesktopHelperCreateFolderPayload,
      {
        dbPath: string
        dbDir: string
        folderName: string
        parentId: number
      }
    >('create-folder', {
      dbPath: probe.dbPath,
      dbDir: probe.dbDir,
      folderName,
      parentId
    })

    const folderId = Number(payload?.folderId) || 0
    const resolvedFolderName = sanitizeFolderName(payload?.folderName || folderName)
    if (folderId <= 0 || !resolvedFolderName) {
      return buildFailureResponse(
        'PLAYLIST_FOLDER_CREATE_FAILED',
        'Rekordbox 返回了无效的文件夹结果。',
        {
          folderName,
          parentId,
          helperPayload: payload
        }
      )
    }

    return {
      ok: true,
      summary: {
        folderId,
        folderName: resolvedFolderName,
        parentId: Number(payload?.parentId) || parentId
      }
    }
  } catch (error) {
    return buildFailureResponse(
      getErrorCode(error, 'PLAYLIST_FOLDER_CREATE_FAILED'),
      getErrorMessage(error, '创建 Rekordbox 文件夹失败。'),
      {
        folderName,
        parentId,
        error
      }
    )
  }
}

export async function createRekordboxDesktopEmptyPlaylist(
  request: RekordboxDesktopCreateEmptyPlaylistRequest
): Promise<RekordboxDesktopCreateEmptyPlaylistResponse> {
  const playlistName = sanitizeFolderName(request.playlistName)
  const parentId = Math.max(0, Number(request.parentId) || 0)
  if (!playlistName) {
    return buildFailureResponse('INVALID_PLAYLIST_NAME', '播放列表名称不能为空。', {
      parentId
    })
  }

  let probe: Awaited<ReturnType<typeof requireRekordboxDesktopLibraryProbe>>
  try {
    probe = await requireRekordboxDesktopLibraryProbe()
  } catch (error) {
    return buildFailureResponse(
      getErrorCode(error, 'REKORDBOX_DB_OPEN_FAILED'),
      getErrorMessage(error, '未检测到可写入的 Rekordbox 库。'),
      {
        playlistName,
        parentId
      }
    )
  }

  try {
    const payload = await runRekordboxDesktopHelper<
      RekordboxDesktopHelperCreateEmptyPlaylistPayload,
      {
        dbPath: string
        dbDir: string
        playlistName: string
        parentId: number
      }
    >('create-empty-playlist', {
      dbPath: probe.dbPath,
      dbDir: probe.dbDir,
      playlistName,
      parentId
    })

    const playlistId = Number(payload?.playlistId) || 0
    const resolvedPlaylistName = sanitizeFolderName(payload?.playlistName || playlistName)
    if (playlistId <= 0 || !resolvedPlaylistName) {
      return buildFailureResponse(
        'PLAYLIST_CREATE_FAILED',
        'Rekordbox 返回了无效的播放列表结果。',
        {
          playlistName,
          parentId,
          helperPayload: payload
        }
      )
    }

    return {
      ok: true,
      summary: {
        playlistId,
        playlistName: resolvedPlaylistName,
        parentId: Number(payload?.parentId) || parentId
      }
    }
  } catch (error) {
    return buildFailureResponse(
      getErrorCode(error, 'PLAYLIST_CREATE_FAILED'),
      getErrorMessage(error, '创建 Rekordbox 播放列表失败。'),
      {
        playlistName,
        parentId,
        error
      }
    )
  }
}
