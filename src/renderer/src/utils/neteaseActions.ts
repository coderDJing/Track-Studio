import { ref } from 'vue'
import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
import rightClickMenu from '@renderer/components/rightClickMenu'
import openNeteaseLoginDialog from '@renderer/components/neteaseLoginDialog'
import openNeteaseImportDialog from '@renderer/components/neteaseImportDialog'
import openNeteaseCopyToLibraryDialog from '@renderer/components/neteaseCopyToLibraryDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import {
  NETEASE_DOWNLOADED_UUID,
  NETEASE_PLAYLIST_PREFIX,
  applyNeteaseGroupsToTree,
  findNeteaseLibraryNode,
  localizeNeteaseTreeTitles,
  getNeteasePlaylistId,
  isNeteasePendingPath,
  isNeteasePlaylistUuid,
  isNeteasePreviewUrl,
  parseNeteasePendingSongId,
  parseNeteaseSongId
} from './neteaseSongs'
import {
  queueMainPlayerPlayingAnalysis,
  resolveBrowserMainPlayerAnalysisIntent
} from './playlistAnalysisGate'
import { appendExternalSongsToSet } from './setCustody'
import { appendDownloadedFilesToMixtape } from './mixtapePlaylistAppend'
import type { ISongInfo } from '../../../types/globals'
import {
  canRemoveTracksFromNeteasePlaylist,
  findNeteasePlaylistContext
} from './neteasePlaylistContext'

/**
 * 网易云相关的渲染层动作。
 *
 * 集中放在这里的原因：入口有多处（库图标、树空白处、分组节点、歌单节点、曲目行），
 * 它们都要触发同一批流程——登录、同步、导入、清理缓存。分散写会互相打架。
 */

type NeteaseStatus = {
  loggedIn?: boolean
  account?: { userId: string; nickname: string; avatarUrl: string; vipType: number } | null
}

type NeteaseGroupPayload = {
  id: string
  title: string
  items: Array<{ playlistId: string; title: string; trackCount: number; coverUrl: string }>
}

type NeteaseSyncResult = {
  groups?: NeteaseGroupPayload[]
  playlistCount?: number
  trackCount?: number
}

/** 正在同步目录：只在歌单树还是空的时候显示 loading */
export const neteaseCatalogSyncing = ref(false)

/** 最近一次问到的登录态。null 表示还没问过，启动时会预取，避免第一次点图标才卡住。 */
export const neteaseLoggedIn = ref<boolean | null>(null)

let statusInFlight: Promise<NeteaseStatus> | null = null

const catalogGroupsFromPayload = (payload: unknown): NeteaseGroupPayload[] => {
  if (!payload || typeof payload !== 'object') return []
  const groups = (payload as NeteaseSyncResult).groups
  return Array.isArray(groups) ? groups : []
}

const neteaseTreeIsEmpty = (tree: unknown): boolean => {
  const node = findNeteaseLibraryNode(tree as never)
  return !node?.children?.length
}

const applyCatalogGroupsToTree = async (groups: NeteaseGroupPayload[]): Promise<boolean> => {
  if (!groups.length) return false
  const runtime = useRuntimeStore()
  if (applyNeteaseGroupsToTree(runtime.libraryTree, groups)) {
    neteaseCatalogSyncing.value = false
    return true
  }
  try {
    // skipSync：不要为了补一个库节点去扫整库；skipPreparation:false 会把 NeteaseLibrary 建进树
    const tree = await invoke<typeof runtime.libraryTree>('netease:ensure-library-tree')
    if (!tree) return false
    localizeNeteaseTreeTitles(tree)
    runtime.libraryTree = tree
    runtime.oldLibraryTree = JSON.parse(JSON.stringify(tree))
    const applied = applyNeteaseGroupsToTree(runtime.libraryTree, groups)
    if (applied) neteaseCatalogSyncing.value = false
    return applied
  } catch (error) {
    console.warn('[netease] 歌单已同步，但树节点还不在，无法挂上', error)
    return false
  }
}

const handleNeteaseCatalogUpdated = (_event: unknown, payload: unknown) => {
  void applyCatalogGroupsToTree(catalogGroupsFromPayload(payload))
}

let catalogListenerBound = false
export const bindNeteaseCatalogUpdates = (): void => {
  if (catalogListenerBound) return
  catalogListenerBound = true
  window.electron.ipcRenderer.on('netease:catalog-updated', handleNeteaseCatalogUpdated)
}

export type NeteaseImportTarget =
  'FilterLibrary' | 'CuratedLibrary' | 'SetLibrary' | 'MixtapeLibrary'

const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  window.electron.ipcRenderer.invoke(channel, payload) as Promise<T>

export const getNeteaseStatus = async (): Promise<NeteaseStatus> => {
  if (statusInFlight) return statusInFlight
  statusInFlight = (async () => {
    try {
      const status = await invoke<NeteaseStatus>('netease:status')
      neteaseLoggedIn.value = Boolean(status.loggedIn)
      return status
    } catch {
      neteaseLoggedIn.value = false
      return { loggedIn: false, account: null }
    } finally {
      statusInFlight = null
    }
  })()
  return statusInFlight
}

/** 启动时先问一次登录态，后面点图标就能立刻切库，不必再等这一下。 */
export const prefetchNeteaseStatus = (): void => {
  void getNeteaseStatus()
}

/**
 * 已登录返回 true；未登录时直接弹扫码窗，成功即返回 true。
 *
 * 不要在前面再垫一个"需要先登录"的提示框：扫码窗自己就写着要做什么，
 * 垫一层等于让用户先关掉一个没有按钮的说明，再看到真正能操作的窗口。
 */
export const ensureNeteaseLoggedIn = async (): Promise<boolean> => {
  const status = await getNeteaseStatus()
  if (status.loggedIn) return true
  const ok = await openNeteaseLoginDialog()
  neteaseLoggedIn.value = ok
  return ok
}

/**
 * 同步目录并刷新树。
 *
 * 只改 NeteaseLibrary 节点的 children，不做整树重载——整树重载会重建所有节点对象，
 * 展开状态和滚动位置都会丢。
 */
export const syncNeteaseLibrary = async (
  options: { silent?: boolean; background?: boolean } = {}
): Promise<NeteaseSyncResult | null> => {
  const runtime = useRuntimeStore()
  if (!(await ensureNeteaseLoggedIn())) return null
  bindNeteaseCatalogUpdates()
  // 点击图标切入时不能用整窗进度挡住库树，否则会像没点进去一样。
  if (!options.background) runtime.isProgressing = true
  if (neteaseTreeIsEmpty(runtime.libraryTree)) neteaseCatalogSyncing.value = true
  try {
    const result = await invoke<NeteaseSyncResult>('netease:sync')
    const groups = catalogGroupsFromPayload(result)
    if (groups.length === 0) {
      if (!options.silent) {
        await confirm({
          title: t('netease.syncFailed'),
          content: [t('netease.syncEmpty')],
          confirmShow: false
        })
      }
      return result
    }
    await applyCatalogGroupsToTree(groups)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : t('common.unknownError')
    await confirm({ title: t('netease.syncFailed'), content: [message], confirmShow: false })
    return null
  } finally {
    neteaseCatalogSyncing.value = false
    if (!options.background) runtime.isProgressing = false
  }
}

export const logoutNetease = async (): Promise<void> => {
  const answer = await confirm({
    title: t('netease.loggingOut'),
    content: [t('netease.logoutConfirm')],
    confirmShow: true
  })
  if (!answer) return
  await invoke('netease:logout')
  neteaseLoggedIn.value = false
  const runtime = useRuntimeStore()
  applyNeteaseGroupsToTree(runtime.libraryTree, [])
  emitter.emit('netease/statusChanged')
}

/** 打开「查看已下载」虚拟列表：不是树节点，只是 songsArea 的一个列表 uuid */
export const openNeteaseDownloadedView = (): void => {
  const runtime = useRuntimeStore()
  runtime.songsArea.songListUUID = NETEASE_DOWNLOADED_UUID
}

/**
 * 导入一张网易云歌单。
 *
 * 四个目标库走两条路，区别在「谁来保管文件」：
 *   - 筛选库 / 精选库 → 复制进目标歌单目录并改名（主进程一次做完，含指纹去重与保序）
 *   - SET 库 / 混音库 → 各自的追加接口自己会复制（custody / vault），
 *     所以这里只负责把歌下载下来，把路径交给它们
 */
export const importNeteasePlaylistInto = async (options: {
  playlistId: string
  target: NeteaseImportTarget
}): Promise<void> => {
  const { playlistId, target } = options
  if (!playlistId) return
  if (!(await ensureNeteaseLoggedIn())) return

  const result = await openNeteaseImportDialog({
    libraryName: target,
    neteasePlaylistId: playlistId
  })
  if (!result) return
  const runtime = useRuntimeStore()
  runtime.isProgressing = true
  try {
    if (target === 'FilterLibrary' || target === 'CuratedLibrary') {
      const summary = await invoke<{
        imported?: number
        skippedDuplicate?: number
        skippedUnavailable?: number
        failed?: number
        errorSamples?: string[]
      }>('netease:import-playlist', {
        playlistId,
        songListPath: result.songListPath,
        songListUUID: result.songListUuid,
        deduplicateMode: result.deduplicateMode,
        pushFingerprintLibrary: result.isPushSongFingerprintLibrary
      })
      const imported = Number(summary?.imported || 0)
      const skipped =
        Number(summary?.skippedDuplicate || 0) + Number(summary?.skippedUnavailable || 0)
      await confirm({
        title: t('netease.importTitle'),
        content: [
          skipped > 0
            ? t('netease.importFinishedWithSkip', { count: imported, skipped })
            : t('netease.importFinished', { count: imported }),
          ...(Array.isArray(summary?.errorSamples) ? summary.errorSamples.slice(0, 3) : [])
        ],
        confirmShow: false
      })
      emitter.emit('playlistContentChanged', { uuids: [result.songListUuid] })
      refreshNeteaseViews(`${NETEASE_PLAYLIST_PREFIX}${playlistId}`)
      return
    }

    // SET / 混音：先下载，再交给各自的追加接口
    const downloaded = await invoke<{
      items?: Array<{ songId: string; filePath: string; title: string; artist: string }>
      failed?: Array<{ songId: string; error: string }>
    }>('netease:ensure-downloaded', { playlistId })
    const items = Array.isArray(downloaded?.items) ? downloaded.items : []
    if (items.length === 0) {
      await confirm({
        title: t('netease.importFailed'),
        content: [t('netease.noImportableTracks')],
        confirmShow: false
      })
      return
    }
    if (target === 'SetLibrary') {
      await appendExternalSongsToSet({
        playlistUuid: result.songListUuid,
        items: items.map((item) => ({
          song: buildRowFromDownloaded(item),
          originPathSnapshot: '网易云音乐'
        }))
      })
    } else {
      await appendDownloadedFilesToMixtape({
        playlistId: result.songListUuid,
        entries: items.map((item) => ({
          filePath: item.filePath,
          song: buildRowFromDownloaded(item)
        }))
      })
    }
    refreshNeteaseViews(`${NETEASE_PLAYLIST_PREFIX}${playlistId}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : t('common.unknownError')
    await confirm({ title: t('netease.importFailed'), content: [message], confirmShow: false })
  } finally {
    runtime.isProgressing = false
  }
}

const buildRowFromDownloaded = (item: {
  songId: string
  filePath: string
  title: string
  artist: string
}): ISongInfo => {
  const baseName = item.filePath.split(/[/\\]/).pop() || item.title || item.songId
  const ext = baseName.split('.').pop() || ''
  return {
    filePath: item.filePath,
    fileName: baseName,
    fileFormat: ext ? ext.toUpperCase() : '',
    cover: null,
    title: item.title || baseName,
    artist: item.artist || undefined,
    album: undefined,
    duration: '',
    genre: undefined,
    label: undefined,
    bitrate: undefined,
    container: ext ? ext.toUpperCase() : undefined,
    neteaseSongId: item.songId,
    neteaseDownloaded: true
  }
}

/**
 * 下载状态变了，两个视图都可能要刷新：
 *   - 「查看已下载」的内容变了；
 *   - 正在看的网易云歌单里，那一行的「已下载」标记变了。
 * 只对有意义的 uuid 发事件，别的视图不该因为一次下载被重载。
 */
const refreshNeteaseViews = (playlistUuid?: string): void => {
  const runtime = useRuntimeStore()
  emitter.emit('netease/downloadedChanged')
  const targets = new Set<string>([NETEASE_DOWNLOADED_UUID])
  if (playlistUuid) targets.add(playlistUuid)
  const current = runtime.songsArea.songListUUID
  if (isNeteasePlaylistUuid(current)) targets.add(current)
  for (const uuid of targets) {
    emitter.emit('songsArea/reload-if-current', { uuid })
  }
}

/**
 * 删除本地缓存（文件进回收站；SET 引用的会先被收进 SET 托管）。
 *
 * 返回 true 表示确实删了——用户取消确认时返回 false，调用方
 * （播放器菜单的「已下载」标记）据此决定要不要改状态。
 */
export const deleteNeteaseLocalFiles = async (songIds: string[]): Promise<boolean> => {
  const ids = songIds.map((id) => String(id)).filter(Boolean)
  if (ids.length === 0) return false
  const answer = await confirm({
    title: t('netease.removeLocalFile'),
    content: [t('netease.deleteLocalConfirm', { count: ids.length })],
    confirmShow: true
  })
  if (!answer) return false
  await invoke('netease:delete-local', { songIds: ids })
  refreshNeteaseViews()
  return true
}

const unwrapIpcError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error || '')
  const marker = 'Error invoking remote method'
  const index = raw.lastIndexOf(': ')
  if (raw.includes(marker) && index >= 0) {
    return raw.slice(index + 2).trim() || raw
  }
  return raw
}

/**
 * 从自己创建的歌单或「我喜欢的音乐」里移出曲目。
 * 先改云端歌单，成功后再刷新本地列表；已下载的 `.store` 文件会留着。
 */
export const removeNeteasePlaylistTracks = async (input: {
  playlistId: string
  songIds: string[]
  title?: string
  confirm?: boolean
}): Promise<boolean> => {
  const playlistId = String(input.playlistId || '').trim()
  const songIds = [...new Set(input.songIds.map((id) => String(id || '').trim()).filter(Boolean))]
  if (!playlistId || songIds.length === 0) return false
  const runtime = useRuntimeStore()
  const title =
    input.title ||
    findNeteasePlaylistContext(runtime.libraryTree, `${NETEASE_PLAYLIST_PREFIX}${playlistId}`)
      ?.title ||
    ''
  if (input.confirm !== false) {
    const answer = await confirm({
      title: t('netease.removeFromPlaylist'),
      content: [t('netease.removeFromPlaylistConfirm', { title, count: songIds.length })],
      confirmShow: true
    })
    if (!answer) return false
  }
  try {
    await invoke('netease:remove-playlist-tracks', { playlistId, songIds })
    refreshNeteaseViews(`${NETEASE_PLAYLIST_PREFIX}${playlistId}`)
    return true
  } catch (error) {
    const message = unwrapIpcError(error) || t('common.unknownError')
    await confirm({
      title: t('netease.removeFromPlaylistFailed'),
      content: [message],
      confirmShow: false
    })
    return false
  }
}

/**
 * 从网易云歌单（或「查看已下载」）把选中曲目复制到筛选库 / 精选库。
 * 先弹出和「导入新曲目」同款的选项框：选目标歌单、是否入指纹库、是否比对去重，
 * 以及（仅自建 / 我喜欢）复制后要不要从当前网易云歌单移除。
 * 真正落地走主进程的 import-playlist（下载、改名、去重），不用 moveSongsToDir。
 */
export const copyNeteaseSongsToLibrary = async (options: {
  songs: ISongInfo[]
  sourcePlaylistUuid: string
  libraryName: 'FilterLibrary' | 'CuratedLibrary'
}): Promise<boolean> => {
  const songs = options.songs.filter((song) => !!neteaseSongLookupId(song))
  if (songs.length === 0) return false
  if (!(await ensureNeteaseLoggedIn())) return false

  const runtime = useRuntimeStore()
  const canRemove = canRemoveTracksFromNeteasePlaylist(
    runtime.libraryTree,
    options.sourcePlaylistUuid
  )
  const result = await openNeteaseCopyToLibraryDialog({
    libraryName: options.libraryName,
    canRemoveFromPlaylist: canRemove
  })
  if (!result) return false

  const songIds = songs.map((song) => neteaseSongLookupId(song)).filter(Boolean)
  const playlistId = isNeteasePlaylistUuid(options.sourcePlaylistUuid)
    ? getNeteasePlaylistId(options.sourcePlaylistUuid)
    : ''
  runtime.isProgressing = true
  try {
    const summary = await invoke<{
      imported?: number
      skippedDuplicate?: number
      skippedUnavailable?: number
      failed?: number
      errorSamples?: string[]
      importedSongIds?: string[]
      skippedDuplicateSongIds?: string[]
    }>('netease:import-playlist', {
      playlistId,
      songIds,
      songListPath: result.songListPath,
      songListUUID: result.songListUuid,
      deduplicateMode: result.deduplicateMode === 'none' ? 'none' : 'library',
      pushFingerprintLibrary: result.isPushSongFingerprintLibrary
    })
    const imported = Number(summary?.imported || 0)
    const skipped =
      Number(summary?.skippedDuplicate || 0) + Number(summary?.skippedUnavailable || 0)
    let removed = 0
    if (result.removeFromPlaylist && canRemove && playlistId) {
      const removableIds = [
        ...new Set(
          [...(summary?.importedSongIds || []), ...(summary?.skippedDuplicateSongIds || [])]
            .map((id) => String(id || '').trim())
            .filter(Boolean)
        )
      ]
      if (removableIds.length > 0) {
        const didRemove = await removeNeteasePlaylistTracks({
          playlistId,
          songIds: removableIds,
          confirm: false
        })
        if (didRemove) removed = removableIds.length
      }
    }
    const copyContent = (() => {
      if (skipped > 0 && removed > 0) {
        return t('netease.copyFinishedWithSkipAndRemove', {
          count: imported,
          skipped,
          removed
        })
      }
      if (removed > 0) {
        return t('netease.copyFinishedWithRemove', { count: imported, removed })
      }
      if (skipped > 0) {
        return t('netease.copyFinishedWithSkip', { count: imported, skipped })
      }
      return t('netease.copyFinished', { count: imported })
    })()
    await confirm({
      title: t('netease.copyConfirm'),
      content: [
        copyContent,
        ...(Array.isArray(summary?.errorSamples) ? summary.errorSamples.slice(0, 3) : [])
      ],
      confirmShow: false
    })
    emitter.emit('playlistContentChanged', { uuids: [result.songListUuid] })
    refreshNeteaseViews(options.sourcePlaylistUuid)
    return true
  } catch (error) {
    const message = unwrapIpcError(error) || t('common.unknownError')
    await confirm({ title: t('netease.copyFailed'), content: [message], confirmShow: false })
    return false
  } finally {
    runtime.isProgressing = false
  }
}

type NeteaseDownloadOutcome = {
  items?: Array<{ songId: string }>
  failed?: Array<{ songId: string; error: string }>
}

/** 一首都没失败才算成功——调用方拿它决定「已下载」标记要不要翻 */
const isFullyDownloaded = (result: NeteaseDownloadOutcome | undefined): boolean =>
  (result?.failed?.length ?? 0) === 0 && (result?.items?.length ?? 0) > 0

/** 单首下载（曲目行菜单）：只落 `.store`，不进任何库 */
export const downloadNeteaseTracks = async (songIds: string[]): Promise<boolean> => {
  const ids = songIds.map((id) => String(id)).filter(Boolean)
  if (ids.length === 0) return false
  const runtime = useRuntimeStore()
  runtime.isProgressing = true
  try {
    const result = await invoke<NeteaseDownloadOutcome>('netease:ensure-downloaded', {
      songIds: ids
    })
    refreshNeteaseViews()
    return isFullyDownloaded(result)
  } finally {
    runtime.isProgressing = false
  }
}

/**
 * 导出 / 移动到别的库之前，把网易云曲目落成本地文件，返回真实路径。
 *
 * 歌单视图里的行只有流地址。让用户"先去『查看已下载』再操作"是把内部模型
 * 摊到用户面前；正确的做法是这里补一步下载，然后按普通本地文件继续。
 */
export const resolveNeteaseLocalPath = async (songId: string): Promise<string | null> => {
  const id = String(songId || '').trim()
  if (!id) return null
  const runtime = useRuntimeStore()
  runtime.isProgressing = true
  try {
    const result = await invoke<NeteaseDownloadOutcome & { items?: Array<{ filePath?: string }> }>(
      'netease:ensure-downloaded',
      { songIds: [id] }
    )
    const filePath = String(result?.items?.[0]?.filePath || '')
    if (filePath) {
      refreshNeteaseViews()
      return filePath
    }
    const reason = String(result?.failed?.[0]?.error || t('common.unknownError'))
    await confirm({
      title: t('netease.downloadFailedTitle'),
      content: [reason],
      confirmShow: false
    })
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : t('common.unknownError')
    await confirm({
      title: t('netease.downloadFailedTitle'),
      content: [message],
      confirmShow: false
    })
    return null
  } finally {
    runtime.isProgressing = false
  }
}

function durationStringToMs(duration?: string): number | undefined {
  const parts = String(duration || '')
    .split(':')
    .map((part) => Number(part))
  if (!parts.length || parts.some((part) => !Number.isFinite(part) || part < 0)) return undefined
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  if (seconds <= 0) return undefined
  return Math.round(seconds * 1000)
}

export const appendNeteaseSongsToSet = async (options: {
  playlistUuid: string
  songs: ISongInfo[]
  originPlaylistUuid?: string | null
  originPathSnapshot?: string | null
}): Promise<void> => {
  const playlistUuid = String(options.playlistUuid || '').trim()
  const songs = Array.isArray(options.songs) ? options.songs : []
  if (!playlistUuid || songs.length === 0) return
  await invoke('netease:append-to-set', {
    playlistUuid,
    items: songs.map((song) => ({
      songId: String(
        song.neteaseSongId ||
          parseNeteaseSongId(song.filePath) ||
          parseNeteasePendingSongId(song.filePath) ||
          ''
      ),
      title: song.title,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      durationMs: durationStringToMs(song.duration),
      analysis: {
        key: song.key,
        keyAnalysisAlgorithmVersion: song.keyAnalysisAlgorithmVersion,
        energyScore: song.energyScore,
        energyAlgorithmVersion: song.energyAlgorithmVersion,
        energyAnalysis: song.energyAnalysis,
        hotCues: Array.isArray(song.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
        memoryCues: Array.isArray(song.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : []
      },
      originPlaylistUuid: options.originPlaylistUuid,
      originPathSnapshot: options.originPathSnapshot
    }))
  })
  try {
    emitter.emit('playlistContentChanged', { uuids: [playlistUuid] })
    emitter.emit('setList/itemsChanged', { uuids: [playlistUuid] })
    emitter.emit('songsArea/clipboardHint', { message: t('library.addToSet') })
  } catch {}
}

export const fulfillNeteasePendingSetSong = async (song: ISongInfo): Promise<ISongInfo | null> => {
  const songId = String(
    song.neteaseSongId ||
      parseNeteasePendingSongId(song.filePath) ||
      parseNeteaseSongId(song.filePath) ||
      ''
  )
  if (!songId) return null
  const runtime = useRuntimeStore()
  runtime.isProgressing = true
  try {
    const result = await invoke<{ filePath?: string; error?: string }>(
      'netease:fulfill-pending-set',
      { songId }
    )
    if (!result?.filePath) {
      await confirm({
        title: t('netease.downloadFailedTitle'),
        content: [String(result?.error || t('common.unknownError'))],
        confirmShow: false
      })
      return null
    }
    refreshNeteaseViews()
    if (song.setItemId) {
      const listUuid = runtime.songsArea.songListUUID
      if (listUuid) {
        emitter.emit('setList/itemsChanged', { uuids: [listUuid] })
        emitter.emit('playlistContentChanged', { uuids: [listUuid] })
      }
    }
    const fileName = result.filePath.split(/[/\\]/).pop() || song.fileName
    const ext = fileName.split('.').pop() || ''
    return {
      ...song,
      filePath: result.filePath,
      fileName,
      fileFormat: ext ? ext.toUpperCase() : song.fileFormat,
      neteaseDownloaded: true,
      neteasePendingDownload: false,
      neteasePendingStatus: undefined,
      neteasePendingError: undefined
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : t('common.unknownError')
    await confirm({
      title: t('netease.downloadFailedTitle'),
      content: [message],
      confirmShow: false
    })
    return null
  } finally {
    runtime.isProgressing = false
  }
}

export const isNeteasePendingSetSong = (song: ISongInfo | null | undefined): boolean =>
  Boolean(song?.neteasePendingDownload) || isNeteasePendingPath(song?.filePath)

type DownloadedItem = { songId?: string; filePath?: string }

/** 把需要落地的 songId 下到 `.store/`，返回 songId -> 本地路径；失败的不进表，并提示 */
const downloadNeteaseLocalPathBySongId = async (
  songIds: string[],
  pendingSongIds: Iterable<string> = []
): Promise<Map<string, string>> => {
  const uniqueIds = [...new Set(songIds.filter((id) => id))]
  const pending = new Set(pendingSongIds)
  const byId = new Map<string, string>()
  if (uniqueIds.length === 0) return byId

  const runtime = useRuntimeStore()
  runtime.isProgressing = true
  try {
    const result = await invoke<{
      items?: DownloadedItem[]
      failed?: Array<{ songId?: string; error?: string }>
    }>('netease:ensure-downloaded', { songIds: uniqueIds })
    for (const item of result?.items || []) {
      if (item?.songId && item?.filePath) byId.set(item.songId, item.filePath)
    }
    for (const songId of uniqueIds) {
      if (pending.has(songId) && byId.get(songId)) {
        await invoke('netease:fulfill-pending-set', { songId })
      }
    }
    refreshNeteaseViews()
    const failed = (result?.failed || []).filter((item) => item?.songId && !byId.has(item.songId))
    if (failed.length > 0) {
      await confirm({
        title: t('netease.downloadFailedTitle'),
        content: failed.slice(0, 5).map((item) => String(item.error || item.songId)),
        confirmShow: false
      })
    }
  } finally {
    runtime.isProgressing = false
  }
  return byId
}

function neteaseSongLookupId(song: Pick<ISongInfo, 'filePath' | 'neteaseSongId'>): string {
  return (
    parseNeteasePendingSongId(String(song.filePath || '')) ||
    parseNeteaseSongId(String(song.filePath || '')) ||
    String(song.neteaseSongId || '')
  )
}

function needsNeteaseLocalFile(
  song: Pick<ISongInfo, 'filePath' | 'neteasePendingDownload'>
): boolean {
  const filePath = String(song.filePath || '')
  return (
    isNeteasePreviewUrl(filePath) ||
    isNeteasePendingPath(filePath) ||
    Boolean(song.neteasePendingDownload)
  )
}

function withLocalNeteasePath(song: ISongInfo, localPath: string): ISongInfo {
  const fileName = localPath.split(/[/\\]/).pop() || song.fileName
  const ext = fileName.split('.').pop() || ''
  return {
    ...song,
    filePath: localPath,
    fileName,
    fileFormat: ext ? ext.toUpperCase() : song.fileFormat,
    neteaseDownloaded: true,
    neteasePendingDownload: false,
    neteasePendingStatus: undefined,
    neteasePendingError: undefined
  }
}

/** 导出 / 分析开始前：把流地址或待下载占位换成 `.store` 里的真实路径，失败的不往下传 */
export const ensureNeteaseLocalFilePaths = async (filePaths: string[]): Promise<string[]> => {
  const paths = Array.isArray(filePaths)
    ? filePaths.filter((item) => typeof item === 'string' && item.trim())
    : []
  if (paths.length === 0) return []

  const pendingIds: string[] = []
  const uniqueIds: string[] = []
  for (const filePath of paths) {
    const pendingId = parseNeteasePendingSongId(filePath)
    const previewId = parseNeteaseSongId(filePath)
    const songId = pendingId || previewId
    if (!songId) continue
    uniqueIds.push(songId)
    if (pendingId) pendingIds.push(pendingId)
  }
  const byId =
    uniqueIds.length > 0
      ? await downloadNeteaseLocalPathBySongId(uniqueIds, pendingIds)
      : new Map<string, string>()
  const ready: string[] = []
  for (const filePath of paths) {
    const songId = parseNeteasePendingSongId(filePath) || parseNeteaseSongId(filePath)
    if (!songId) {
      ready.push(filePath)
      continue
    }
    const localPath = byId.get(songId)
    if (localPath) ready.push(localPath)
  }
  return ready
}

/**
 * 切歌自动分析：预览地址或占位路径不能直接进队列。
 * 浏览器模式只提升已在队列里的任务，这里不会为了分析去下载。
 * 非浏览器模式会先下载到 `.store/`，再用真实路径排队。
 */
export const queueNeteaseAwarePlayingAnalysis = (
  runtime: Parameters<typeof queueMainPlayerPlayingAnalysis>[0],
  filePath?: string | null
): void => {
  const path = String(filePath || '').trim()
  if (!path) return
  if (!isNeteasePreviewUrl(path) && !isNeteasePendingPath(path)) {
    queueMainPlayerPlayingAnalysis(runtime, path)
    return
  }
  if (isNeteasePendingPath(path)) return
  if (resolveBrowserMainPlayerAnalysisIntent(runtime) !== 'immediate') return
  void (async () => {
    const ready = await ensureNeteaseLocalFilePaths([path])
    if (ready[0]) queueMainPlayerPlayingAnalysis(runtime, ready[0])
  })()
}

/** 导出等需要完整曲目对象的操作：先下载再返回带真实路径的副本，失败的一首不往下传 */
export const mapNeteaseSongsToLocalFiles = async (songs: ISongInfo[]): Promise<ISongInfo[]> => {
  const list = Array.isArray(songs) ? songs : []
  if (list.length === 0) return []
  const pendingIds: string[] = []
  const uniqueIds: string[] = []
  for (const song of list) {
    if (!needsNeteaseLocalFile(song)) continue
    const songId = neteaseSongLookupId(song)
    if (!songId) continue
    uniqueIds.push(songId)
    if (isNeteasePendingPath(song.filePath) || song.neteasePendingDownload) pendingIds.push(songId)
  }
  const byId =
    uniqueIds.length > 0
      ? await downloadNeteaseLocalPathBySongId(uniqueIds, pendingIds)
      : new Map<string, string>()
  const ready: ISongInfo[] = []
  for (const song of list) {
    if (!needsNeteaseLocalFile(song)) {
      ready.push(song)
      continue
    }
    const localPath = byId.get(neteaseSongLookupId(song)) || ''
    if (!localPath) continue
    ready.push(withLocalNeteasePath(song, localPath))
  }
  return ready
}

export type NeteaseImportEstimate = {
  trackCount: number
  estimatedBytes: number
  level: 'jymaster' | 'lossless' | 'exhigh' | 'standard'
}

export const loadNeteaseImportEstimate = async (
  playlistId: string
): Promise<NeteaseImportEstimate> => {
  const result = await invoke<NeteaseImportEstimate>('netease:import-estimate', { playlistId })
  return {
    trackCount: Number(result?.trackCount) || 0,
    estimatedBytes: Number(result?.estimatedBytes) || 0,
    level:
      result?.level === 'jymaster' || result?.level === 'exhigh' || result?.level === 'standard'
        ? result.level
        : 'lossless'
  }
}

export type NeteaseDownloadedSummary = {
  count: number
  totalBytes: number
  orphanCount: number
  orphanSongIds: string[]
}

const EMPTY_SUMMARY: NeteaseDownloadedSummary = {
  count: 0,
  totalBytes: 0,
  orphanCount: 0,
  orphanSongIds: []
}

export const loadNeteaseDownloadedSummary = async (): Promise<NeteaseDownloadedSummary> => {
  try {
    const result = await invoke<NeteaseDownloadedSummary>('netease:downloaded-summary')
    return {
      count: Number(result?.count) || 0,
      totalBytes: Number(result?.totalBytes) || 0,
      orphanCount: Number(result?.orphanCount) || 0,
      orphanSongIds: Array.isArray(result?.orphanSongIds) ? result.orphanSongIds : []
    }
  } catch {
    return EMPTY_SUMMARY
  }
}

/** 一次性清掉"已不在任何歌单"的缓存文件（用户点了才做，绝不自动） */
export const cleanupNeteaseOrphans = async (summary: NeteaseDownloadedSummary): Promise<void> => {
  if (summary.orphanSongIds.length === 0) return
  await deleteNeteaseLocalFiles(summary.orphanSongIds)
}

/** 「共 N 首 · 12.3GB · 其中 M 首已不在歌单」这种摘要文案 */
export const formatNeteaseDownloadedSummary = (
  summary: NeteaseDownloadedSummary
): { total: string; orphan: string } => {
  const size = formatBytes(summary.totalBytes)
  return {
    total: size
      ? `${t('netease.totalTracks', { count: summary.count })} · ${t('netease.totalSize', { size })}`
      : t('netease.totalTracks', { count: summary.count }),
    orphan: summary.orphanCount > 0 ? String(summary.orphanCount) : ''
  }
}

const formatBytes = (bytes: number): string => {
  const value = Number(bytes) || 0
  if (value <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)}${units[unit]}`
}

export const formatNeteaseImportEstimate = (estimate: NeteaseImportEstimate): string => {
  const size = formatBytes(estimate.estimatedBytes) || '0B'
  const levelLabel =
    estimate.level === 'jymaster'
      ? t('netease.settings.qualityJymaster')
      : estimate.level === 'exhigh'
        ? t('netease.settings.qualityExhigh')
        : estimate.level === 'standard'
          ? t('netease.settings.qualityStandard')
          : t('netease.settings.qualityLossless')
  return t('netease.importEstimate', {
    count: estimate.trackCount,
    size,
    level: levelLabel
  })
}

/** 库级右键：查看已下载 / 同步 / 登录或退出。图标、树空白处、分组节点共用。 */
export const handleNeteaseLibraryContextMenu = async (event: MouseEvent): Promise<void> => {
  const status = await getNeteaseStatus()
  const menuArr = [
    [{ menuName: 'netease.viewDownloaded' }],
    [
      ...(status.loggedIn ? [{ menuName: 'netease.sync' }] : []),
      ...(status.loggedIn
        ? [{ menuName: 'netease.relogin' }, { menuName: 'netease.logout' }]
        : [{ menuName: 'netease.login' }])
    ]
  ]
  const result = await rightClickMenu({ menuArr, clickEvent: event })
  if (result === 'cancel') return
  switch (result.menuName) {
    case 'netease.viewDownloaded':
      openNeteaseDownloadedView()
      break
    case 'netease.sync':
      await syncNeteaseLibrary()
      break
    case 'netease.login':
    case 'netease.relogin':
      if (await openNeteaseLoginDialog()) await syncNeteaseLibrary()
      break
    case 'netease.logout':
      await logoutNetease()
      break
  }
}

export const handleNeteaseLibraryIconContextMenu = handleNeteaseLibraryContextMenu

/** 歌单节点右键：四项导入 + 同步 */
export const handleNeteasePlaylistContextMenu = async (
  event: MouseEvent,
  uuid: string
): Promise<void> => {
  const playlistId = getNeteasePlaylistId(uuid)
  const menuArr = [
    [
      { menuName: 'netease.importToFilter' },
      { menuName: 'netease.importToCurated' },
      { menuName: 'netease.importToSet' },
      { menuName: 'netease.importToMixtape' }
    ],
    [{ menuName: 'netease.sync' }]
  ]
  const result = await rightClickMenu({ menuArr, clickEvent: event })
  if (result === 'cancel') return
  const targetByMenu: Record<string, NeteaseImportTarget> = {
    'netease.importToFilter': 'FilterLibrary',
    'netease.importToCurated': 'CuratedLibrary',
    'netease.importToSet': 'SetLibrary',
    'netease.importToMixtape': 'MixtapeLibrary'
  }
  const target = targetByMenu[result.menuName as string]
  if (target) {
    await importNeteasePlaylistInto({ playlistId, target })
    return
  }
  if (result.menuName === 'netease.sync') await syncNeteaseLibrary()
}
