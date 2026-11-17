import { existsSync } from 'node:fs'
import { ipcMain, type BrowserWindow } from 'electron'
import { log } from '../log'
import store from '../store'
import { createProgressSender } from '../window/mainWindow/progress'
import { protectSetReferencedFilesForDeletion } from '../ipc/setListHandlers'
import { neteaseClient, type NeteaseLevel } from './client'
import { createQrDataUrl } from './qr'
import { clearSession, loadSession, restoreSessionIntoClient, saveSession } from './session'
import {
  deleteLocalFile,
  getDownloadedSummary,
  getLocalFilePath,
  getPlaylistTracks,
  listDownloaded,
  reconcileStoreFromDisk,
  syncCatalog
} from './library'
import { ensureTracksDownloaded, estimatePlaylistImportSize, importNeteasePlaylist } from './import'
import {
  appendNeteaseTracksToSet,
  fulfillPendingSetSong,
  setNeteaseSetPendingNotifier
} from './setPending'
import { clearPreviewCache, enforcePreviewCacheLimit, getPreviewCacheUsage } from './cache'
import { isSafeSongId } from './paths'
import { getLibrary } from '../utils'
import { clearTrackCache } from '../services/cacheMaintenance'

/**
 * 网易云相关的 IPC。
 *
 * 所有通道都以 `netease:` 开头，preload 的 invoke/listen 白名单按前缀放行；
 * 新增通道只要名字还在这个前缀下，就不必再改白名单。
 */

let registered = false

function normalizeLevel(value: unknown): NeteaseLevel {
  if (value === 'jymaster' || value === 'lossless' || value === 'exhigh' || value === 'standard') {
    return value
  }
  return 'lossless'
}

/**
 * 渲染层传来的一切曲目 id 都要过这一关。
 *
 * id 会被拼进 `.store/<songId>.<ext>`，而 IPC 是信任边界：
 * 只要有一个 `..` 片段漏进去，就是任意路径写入。
 */
function sanitizeSongIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : []
  const out: string[] = []
  for (const item of list) {
    const id = String(item ?? '').trim()
    if (!id) continue
    if (!isSafeSongId(id)) {
      log.warn('[netease] 丢弃非法曲目 id', id.slice(0, 32))
      continue
    }
    out.push(id)
  }
  return out
}

export function registerNeteaseHandlers(getWindow: () => BrowserWindow | null): void {
  setNeteaseSetPendingNotifier((payload) => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send('netease:set-pending-updated', payload)
  })
  if (registered) return
  registered = true

  ipcMain.handle('netease:status', async () => {
    if (!neteaseClient.isLoggedIn) {
      const restored = await restoreSessionIntoClient()
      if (!restored) return { loggedIn: false, account: null }
    }
    try {
      const account = await neteaseClient.fetchAccount()
      return { loggedIn: Boolean(account), account }
    } catch (error) {
      log.warn('[netease] 读取账号失败', error)
      return { loggedIn: false, account: null }
    }
  })

  ipcMain.handle('netease:login-start', async () => {
    const { unikey, url } = await neteaseClient.createQrKey()
    return { unikey, url, qrDataUrl: createQrDataUrl(url, { scale: 8 }) }
  })

  ipcMain.handle('netease:login-poll', async (_event, payload: { unikey?: string }) => {
    const unikey = String(payload?.unikey || '')
    if (!unikey) throw new Error('缺少 unikey')
    const state = await neteaseClient.checkQr(unikey)
    if (state.code === 803 && state.account) {
      await saveSession({
        cookie: neteaseClient.exportCookies(),
        userId: state.account.userId,
        nickname: state.account.nickname
      })
    }
    return state
  })

  ipcMain.handle('netease:logout', async () => {
    await clearSession()
    return { ok: true }
  })

  ipcMain.handle('netease:sync', async (event) => {
    return await syncCatalog({
      onGroupsReady: (groups) => {
        if (event.sender.isDestroyed()) return
        event.sender.send('netease:catalog-updated', { groups })
      }
    })
  })

  // 补齐 NeteaseLibrary 节点，但不做全盘扫描。同步后渲染树还没有这个库时走这里。
  ipcMain.handle('netease:ensure-library-tree', async () => {
    return await getLibrary({ skipSync: true, skipPreparation: false })
  })

  ipcMain.handle('netease:playlist-tracks', async (_event, payload: { playlistId?: string }) => {
    const playlistId = String(payload?.playlistId || '')
    if (!playlistId) throw new Error('缺少 playlistId')
    const tracks = getPlaylistTracks(playlistId)
    return {
      playlistId,
      tracks: tracks.map((track) => ({
        ...track,
        downloaded: Boolean(getLocalFilePath(track.songId))
      }))
    }
  })

  ipcMain.handle('netease:downloaded', async () => {
    // 打开列表前顺一次盘：文件还在但索引丢了（库合并后）要能自动补回来
    try {
      await reconcileStoreFromDisk()
    } catch (error) {
      log.warn('[netease] 补录已下载索引失败', error)
    }
    return { tracks: listDownloaded() }
  })

  ipcMain.handle('netease:downloaded-summary', async () => {
    return getDownloadedSummary()
  })

  ipcMain.handle('netease:preview-cache-usage', async () => {
    return await getPreviewCacheUsage()
  })

  ipcMain.handle('netease:clear-preview-cache', async () => {
    return await clearPreviewCache()
  })

  ipcMain.handle('netease:enforce-preview-cache', async () => {
    return await enforcePreviewCacheLimit()
  })

  /**
   * 整张歌单导入筛选库/精选库：复制 + 改名 + 保序，全部在主进程一次做完。
   * 进度沿用底部那条通用进度条（`progressSet`），不另开一套 UI。
   */
  ipcMain.handle('netease:import-playlist', async (_event, payload: Record<string, unknown>) => {
    const window = getWindow()
    const sendProgress = createProgressSender(() => window)
    const songListPath = String(payload?.songListPath || '')
    if (!songListPath) throw new Error('缺少目标歌单')
    const songIds = sanitizeSongIds(payload?.songIds)
    return await importNeteasePlaylist({
      songListPath,
      songListUUID: String(payload?.songListUUID || ''),
      playlistId: String(payload?.playlistId || ''),
      songIds,
      deduplicateMode:
        payload?.deduplicateMode === 'batch' || payload?.deduplicateMode === 'none'
          ? (payload.deduplicateMode as 'batch' | 'none')
          : 'library',
      pushFingerprintLibrary: payload?.pushFingerprintLibrary === true,
      level: normalizeLevel(payload?.level ?? store.settingConfig?.neteaseLevel),
      sendProgress
    })
  })

  /**
   * 只下载、不复制。SET 库与混音库各自有自己的保管方式，
   * 渲染层拿到本地路径后接着调它们已有的追加接口。
   */
  ipcMain.handle(
    'netease:ensure-downloaded',
    async (_event, payload: { songIds?: string[]; playlistId?: string; level?: string }) => {
      const window = getWindow()
      const sendProgress = createProgressSender(() => window)
      const explicit = sanitizeSongIds(payload?.songIds)
      const playlistId = String(payload?.playlistId || '')
      const songIds =
        explicit.length > 0
          ? explicit
          : playlistId
            ? getPlaylistTracks(playlistId).map((track) => track.songId)
            : []
      return await ensureTracksDownloaded(
        songIds,
        normalizeLevel(payload?.level ?? store.settingConfig?.neteaseLevel),
        undefined,
        sendProgress
      )
    }
  )

  ipcMain.handle(
    'netease:import-estimate',
    async (_event, payload: { playlistId?: string; level?: string }) => {
      const playlistId = String(payload?.playlistId || '')
      if (!playlistId)
        return { trackCount: 0, estimatedBytes: 0, level: normalizeLevel(payload?.level) }
      return await estimatePlaylistImportSize(
        playlistId,
        normalizeLevel(payload?.level ?? store.settingConfig?.neteaseLevel)
      )
    }
  )

  ipcMain.handle(
    'netease:append-to-set',
    async (
      _event,
      payload: {
        playlistUuid?: string
        items?: Array<{
          songId?: string
          title?: string
          artist?: string
          album?: string
          duration?: string
          durationMs?: number
          analysis?: Record<string, unknown> | null
          originPlaylistUuid?: string | null
          originPathSnapshot?: string | null
        }>
      }
    ) => {
      const playlistUuid = String(payload?.playlistUuid || '')
      const items = Array.isArray(payload?.items) ? payload.items : []
      if (!playlistUuid || items.length === 0) {
        return { pendingSongIds: [], readyCount: 0, pendingCount: 0 }
      }
      return await appendNeteaseTracksToSet(
        playlistUuid,
        items.map((item) => ({
          songId: String(item?.songId || ''),
          title: item?.title,
          artist: item?.artist,
          album: item?.album,
          duration: item?.duration,
          durationMs: item?.durationMs,
          analysis: item?.analysis || null,
          originPlaylistUuid: item?.originPlaylistUuid,
          originPathSnapshot: item?.originPathSnapshot
        }))
      )
    }
  )

  ipcMain.handle('netease:fulfill-pending-set', async (_event, payload: { songId?: string }) => {
    return await fulfillPendingSetSong(String(payload?.songId || ''))
  })

  ipcMain.handle('netease:resolve-local', async (_event, payload: { songIds?: string[] }) => {
    const songIds = sanitizeSongIds(payload?.songIds)
    const items: Array<{ songId: string; filePath: string }> = []
    for (const songId of songIds) {
      const filePath = getLocalFilePath(songId)
      if (filePath && existsSync(filePath)) items.push({ songId, filePath })
    }
    return { items }
  })

  ipcMain.handle('netease:delete-local', async (_event, payload: { songIds?: string[] }) => {
    const songIds = sanitizeSongIds(payload?.songIds)
    // SET 歌单是**引用**本地文件的。删缓存前先让已有的保护逻辑把这些文件收进 SET 托管，
    // 否则「已下载」里清一下缓存，SET 里那几首就变成红线了。
    const paths = songIds
      .map((songId) => getLocalFilePath(songId))
      .filter((item): item is string => Boolean(item))
    if (paths.length > 0) {
      try {
        await protectSetReferencedFilesForDeletion(paths)
      } catch (error) {
        log.warn('[netease] SET 引用保护失败，继续删除缓存', error)
      }
    }
    let removed = 0
    for (const songId of songIds) {
      const result = await deleteLocalFile(songId)
      if (result.removed) removed += 1
    }
    // 分轨资产按源文件路径登记；缓存文件删掉后不清会留下孤儿。
    for (const filePath of paths) {
      await clearTrackCache(filePath)
    }
    return { removed, requested: songIds.length }
  })

  // 启动时恢复登录态（不阻塞，失败就当未登录）
  void loadSession().then((session) => {
    if (session?.cookie) neteaseClient.importCookies(session.cookie)
  })
}
