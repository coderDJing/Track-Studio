import { requireRekordboxDesktopLibraryProbe } from './detect'
import { runRekordboxDesktopHelper } from './helper'
import { buildRekordboxDesktopFailureSummary, logRekordboxDesktopFailure } from './failure'
import type {
  RekordboxDesktopAppendExistingTracksRequest,
  RekordboxDesktopAppendExistingTracksResponse
} from '../../../shared/rekordboxDesktopPlaylist'

export const appendExistingRekordboxPlaylistTracks = async (
  request: RekordboxDesktopAppendExistingTracksRequest
): Promise<RekordboxDesktopAppendExistingTracksResponse> => {
  try {
    const playlistId = Number(request?.playlistId)
    const sourcePlaylistId = Number(request?.sourcePlaylistId)
    const rowKeys = Array.from(
      new Set((request?.rowKeys || []).map((key) => String(key).trim()).filter(Boolean))
    )
    if (
      !Number.isSafeInteger(playlistId) ||
      playlistId <= 0 ||
      !Number.isSafeInteger(sourcePlaylistId) ||
      sourcePlaylistId <= 0 ||
      !rowKeys.length
    ) {
      throw new Error('拖入歌单的曲目或来源歌单无效。')
    }
    const probe = await requireRekordboxDesktopLibraryProbe()
    const result = await runRekordboxDesktopHelper<
      {
        playlistId: number
        addedToPlaylistCount: number
        skippedDuplicateCount: number
      },
      {
        dbPath: string
        dbDir: string
        playlistId: number
        sourcePlaylistId: number
        rowKeys: string[]
      }
    >('append-existing-playlist-tracks', {
      dbPath: probe.dbPath,
      dbDir: probe.dbDir,
      playlistId,
      sourcePlaylistId,
      rowKeys
    })
    return {
      ok: true,
      summary: {
        playlistId: result.playlistId,
        addedCount: result.addedToPlaylistCount,
        skippedDuplicateCount: result.skippedDuplicateCount
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logRekordboxDesktopFailure(
      '[rekordbox-desktop-playlist] append existing tracks failed',
      'PLAYLIST_APPEND_FAILED',
      message
    )
    return {
      ok: false,
      summary: buildRekordboxDesktopFailureSummary('PLAYLIST_APPEND_FAILED', message)
    }
  }
}
