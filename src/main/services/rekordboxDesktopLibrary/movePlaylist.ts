import { requireRekordboxDesktopLibraryProbe } from './detect'
import { buildRekordboxDesktopFailureSummary, logRekordboxDesktopFailure } from './failure'
import { runRekordboxDesktopHelper } from './helper'
import type {
  RekordboxDesktopHelperError,
  RekordboxDesktopHelperMovePlaylistPayload
} from './types'
import type {
  RekordboxDesktopMovePlaylistRequest,
  RekordboxDesktopMovePlaylistResponse
} from '../../../shared/rekordboxDesktopPlaylist'

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
): RekordboxDesktopMovePlaylistResponse => {
  logRekordboxDesktopFailure(
    '[rekordbox-desktop-playlist] move playlist failed',
    errorCode,
    errorMessage,
    details
  )
  return {
    ok: false,
    summary: buildRekordboxDesktopFailureSummary(errorCode, errorMessage)
  }
}

export async function moveRekordboxDesktopPlaylist(
  request: RekordboxDesktopMovePlaylistRequest
): Promise<RekordboxDesktopMovePlaylistResponse> {
  const playlistId = Math.max(0, Number(request.playlistId) || 0)
  const parentId = Math.max(0, Number(request.parentId) || 0)
  const seq = Math.max(0, Number(request.seq) || 0)

  if (playlistId <= 0) {
    return buildFailureResponse('INVALID_PLAYLIST_ID', '目标 Rekordbox 节点无效。', {
      playlistId,
      parentId,
      seq
    })
  }
  if (seq <= 0) {
    return buildFailureResponse('PLAYLIST_MOVE_FAILED', '目标排序序号无效。', {
      playlistId,
      parentId,
      seq
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
        playlistId,
        parentId,
        seq
      }
    )
  }

  try {
    const payload = await runRekordboxDesktopHelper<
      RekordboxDesktopHelperMovePlaylistPayload,
      {
        dbPath: string
        dbDir: string
        playlistId: number
        parentId: number
        seq: number
      }
    >('move-playlist', {
      dbPath: probe.dbPath,
      dbDir: probe.dbDir,
      playlistId,
      parentId,
      seq
    })

    return {
      ok: true,
      summary: {
        playlistId: Number(payload?.playlistId) || playlistId,
        parentId: Number(payload?.parentId) || parentId,
        seq: Number(payload?.seq) || seq
      }
    }
  } catch (error) {
    return buildFailureResponse(
      getErrorCode(error, 'PLAYLIST_MOVE_FAILED'),
      getErrorMessage(error, '移动 Rekordbox 播放列表失败。'),
      {
        playlistId,
        parentId,
        seq,
        error
      }
    )
  }
}
