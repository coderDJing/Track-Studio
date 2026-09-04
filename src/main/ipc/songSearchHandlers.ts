import { ipcMain } from 'electron'
import globalSongSearchEngine, { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import { savePlaylistViewSnapshot } from '../libraryCacheDb/playlistViewSnapshot'
import { recordPlaylistOpenPath } from '../services/playlistOpenPerfTrace'

export function registerSongSearchHandlers() {
  ipcMain.handle('song-search:warmup', async (_event, payload?: { force?: boolean }) => {
    const force = payload?.force === true
    return await globalSongSearchEngine.warmup(force)
  })

  ipcMain.handle(
    'song-search:query',
    async (_event, payload?: { keyword?: string; limit?: number }) => {
      const keyword = typeof payload?.keyword === 'string' ? payload.keyword : ''
      const limit = typeof payload?.limit === 'number' ? payload.limit : undefined
      return await globalSongSearchEngine.query(keyword, limit)
    }
  )

  ipcMain.handle(
    'song-search:playlist-fast-load',
    async (_event, payload?: { songListUUID?: string }) => {
      const songListUUID =
        typeof payload?.songListUUID === 'string' ? payload.songListUUID.trim() : ''
      const result = await globalSongSearchEngine.getPlaylistFastLoad(songListUUID)
      // 这条是快照没建立时的第二档路径。它刚刚对着磁盘核对过缓存身份，
      // 结果正好可以当权威快照存下来，下一次打开就能走 'playlist:fast-open'（零 fs）。
      if (result.hit && songListUUID && result.listRoot) {
        savePlaylistViewSnapshot({
          songListUUID,
          listRoot: result.listRoot,
          identityDigest: result.identityDigest,
          items: result.items,
          missingWaveformFilePaths: result.missingWaveformFilePaths
        })
      }
      recordPlaylistOpenPath({
        source: 'cache-verify',
        hit: result.hit,
        tookMs: result.tookMs,
        itemCount: result.items.length,
        reason: result.hit ? undefined : 'cache-identity-unverified',
        songListUUID
      })
      return result
    }
  )

  ipcMain.handle(
    'song-search:mark-dirty',
    async (
      _event,
      payload?: { reason?: string; songListUUID?: string; songListUUIDs?: string[] }
    ) => {
      const reason = typeof payload?.reason === 'string' ? payload.reason : undefined
      markGlobalSongSearchDirty(reason, {
        songListUUID: typeof payload?.songListUUID === 'string' ? payload.songListUUID : undefined,
        songListUUIDs: Array.isArray(payload?.songListUUIDs) ? payload.songListUUIDs : undefined
      })
      return { success: true }
    }
  )
}
