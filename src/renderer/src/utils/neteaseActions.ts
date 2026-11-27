import { ref } from 'vue'
import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
import rightClickMenu from '@renderer/components/rightClickMenu'
import openNeteaseLoginDialog from '@renderer/components/neteaseLoginDialog'
import openNeteaseImportDialog from '@renderer/components/neteaseImportDialog'
import openNeteaseCopyToLibraryDialog from '@renderer/components/neteaseCopyToLibraryDialog'
import openNeteaseRemovePlaylistDialog from '@renderer/components/neteaseRemovePlaylistDialog'
import {
  normalizeNeteaseRemovePlaylistLocalFilesPref,
  resolveNeteaseRemovePlaylistLocalFilesDecision,
  shouldAskNeteaseRemovePlaylistLocalFiles,
  type NeteaseRemovePlaylistLocalFilesPref
} from '@shared/neteaseRemovePlaylistLocalFiles'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import {
  NETEASE_DOWNLOADED_UUID,
  NETEASE_PLAYLIST_PREFIX,
  createNeteaseOpenPlaylistRemovalPayload,
  applyNeteaseGroupsToTree,
  findNeteaseLibraryNode,
  localizeNeteaseTreeTitles,
  getNeteasePlaylistId,
  isNeteasePlaylistUuid
} from './neteaseSongs'
import { invoke } from './neteaseIpc'
import {
  buildRowFromDownloaded,
  deleteNeteaseLocalFiles,
  neteaseSongLookupId,
  refreshNeteaseViews,
  resolveExistingNeteaseLocalPaths
} from './neteaseLocalFiles'
import { appendExternalSongsToSet } from './setCustody'
import { appendDownloadedFilesToMixtape } from './mixtapePlaylistAppend'
import type { ISongInfo } from '../../../types/globals'
import {
  canRemoveTracksFromNeteasePlaylist,
  findNeteasePlaylistContext,
  getNeteasePlaylistDeletionAction
} from './neteasePlaylistContext'

/**
 * 网易云相关的库级动作：登录态、目录同步、导入、歌单编辑与右键菜单。
 * 下载进 `.store`、路径解析、分析补齐和已下载摘要见 `neteaseLocalFiles`。
 */

type NeteaseStatus = {
  loggedIn?: boolean
  account?: { userId: string; nickname: string; avatarUrl: string; vipType: number } | null
}

type NeteaseGroupPayload = {
  id: string
  title: string
  items: Array<{
    playlistId: string
    title: string
    trackCount: number
    coverUrl: string
    syncState?: 'ok' | 'unreadable'
  }>
}

type NeteaseSyncResult = {
  groups?: NeteaseGroupPayload[]
  /** 因隐私/无权限被跳过的歌单 */
  skipped?: Array<{ playlistId?: string; title?: string }>
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

/** 临时诊断：同步链路排查用，确认问题收敛后整段删除 */
const logNeteaseDiag = (message: string, details?: Record<string, unknown>): void => {
  try {
    window.electron.ipcRenderer.send('outputLog', {
      level: 'info',
      source: 'renderer',
      scope: 'netease-sync-diagnostic',
      message: `[netease-diag] ${message}${details ? ` ${JSON.stringify(details)}` : ''}`
    })
  } catch {}
}

const touchLibraryTreeAfterNeteaseApply = (): void => {
  const runtime = useRuntimeStore()
  // libraryItem 用 shallowRef + 非 deep watch 盯的是 libraryTree 根引用。
  // 只改 NeteaseLibrary.children 时根没变，树上会继续显示旧节点，
  // 右键却按新树查找，删除按钮就会消失。
  runtime.libraryTree = {
    ...runtime.libraryTree,
    children: [...(runtime.libraryTree.children || [])]
  }
  runtime.oldLibraryTree = JSON.parse(JSON.stringify(runtime.libraryTree))
}

const applyNeteaseGroupsToRuntimeTree = (
  groups: Parameters<typeof applyNeteaseGroupsToTree>[1]
): boolean => {
  const runtime = useRuntimeStore()
  if (!applyNeteaseGroupsToTree(runtime.libraryTree, groups)) return false
  touchLibraryTreeAfterNeteaseApply()
  return true
}

const applyCatalogGroupsToTree = async (groups: NeteaseGroupPayload[]): Promise<boolean> => {
  if (!groups.length) return false
  const runtime = useRuntimeStore()
  if (applyNeteaseGroupsToRuntimeTree(groups)) {
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
    const applied = applyNeteaseGroupsToRuntimeTree(groups)
    if (applied) neteaseCatalogSyncing.value = false
    return applied
  } catch (error) {
    console.error('[netease] 歌单已同步，但树节点还不在，无法挂上', error)
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

export const getNeteaseStatus = async (): Promise<NeteaseStatus> => {
  if (statusInFlight) return statusInFlight
  statusInFlight = (async () => {
    try {
      const status = await invoke<NeteaseStatus>('netease:status')
      neteaseLoggedIn.value = Boolean(status.loggedIn)
      return status
    } catch (error) {
      console.error('[netease] 查询登录态失败', error)
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
  logNeteaseDiag('扫码登录结果', { ok })
  return ok
}

/**
 * 因隐私/无权限被跳过的歌单，同步结束后汇总告知一次。
 * 自动同步（silent）不弹：树上这些歌单本身带警示标记，重复弹窗只会打断用户。
 */
const notifySkippedNeteasePlaylists = async (result: NeteaseSyncResult | null): Promise<void> => {
  const skipped = Array.isArray(result?.skipped) ? result.skipped : []
  const names = skipped.map((item) => String(item.title || '').trim()).filter(Boolean)
  if (names.length === 0) return
  await confirm({
    title: t('netease.syncPartialTitle'),
    content: [
      t('netease.syncPartialContent', { count: names.length }),
      names.join('、'),
      t('netease.syncPartialHint')
    ],
    confirmShow: false
  })
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
  logNeteaseDiag('开始同步', {
    silent: Boolean(options.silent),
    background: Boolean(options.background),
    treeEmpty: neteaseTreeIsEmpty(runtime.libraryTree)
  })
  try {
    const result = await invoke<NeteaseSyncResult>('netease:sync')
    const groups = catalogGroupsFromPayload(result)
    logNeteaseDiag('收到同步结果', {
      groups: groups.length,
      playlistCount: Number(result?.playlistCount) || 0,
      trackCount: Number(result?.trackCount) || 0,
      skipped: Array.isArray(result?.skipped) ? result.skipped.length : 0
    })
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
    const applied = await applyCatalogGroupsToTree(groups)
    logNeteaseDiag('歌单树挂载结果', { applied })
    if (!options.silent) await notifySkippedNeteasePlaylists(result)
    return result
  } catch (error) {
    console.error('[netease] 同步失败', error)
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
  applyNeteaseGroupsToRuntimeTree([])
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

const persistNeteaseRemovePlaylistLocalFilesPref = async (
  pref: NeteaseRemovePlaylistLocalFilesPref
) => {
  const runtime = useRuntimeStore()
  runtime.setting.neteaseRemovePlaylistLocalFiles = pref
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
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
 * 先改云端歌单，成功后再刷新本地列表。
 * 若确认框里选择同时删除已下载文件（或设置里已记住该选择），成功后再删 `.store`。
 * `confirm: false`（例如复制到本地库后移除）不会顺带删本地文件。
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
  let deleteLocal = false
  let downloadedIds: string[] = []
  if (input.confirm !== false) {
    const localById = await resolveExistingNeteaseLocalPaths(songIds)
    downloadedIds = songIds.filter((id) => localById.has(id))
    const pref = normalizeNeteaseRemovePlaylistLocalFilesPref(
      runtime.setting.neteaseRemovePlaylistLocalFiles
    )
    const downloadedCount = downloadedIds.length
    if (shouldAskNeteaseRemovePlaylistLocalFiles({ pref, downloadedCount })) {
      const result = await openNeteaseRemovePlaylistDialog({
        title,
        count: songIds.length,
        downloadedCount
      })
      if (!result.confirmed) return false
      const decision = resolveNeteaseRemovePlaylistLocalFilesDecision({
        pref,
        downloadedCount,
        alsoDeleteLocal: result.alsoDeleteLocal,
        remember: result.remember
      })
      deleteLocal = decision.deleteLocal
      if (decision.nextPref) {
        await persistNeteaseRemovePlaylistLocalFilesPref(decision.nextPref)
      }
    } else {
      const content =
        downloadedCount === 0
          ? [t('netease.removeFromPlaylistConfirmOnly', { title, count: songIds.length })]
          : pref === 'delete'
            ? [
                t('netease.removeFromPlaylistConfirmDeleteLocal', {
                  title,
                  count: songIds.length,
                  downloadedCount
                }),
                t('netease.removeFromPlaylistPrefHint')
              ]
            : [
                t('netease.removeFromPlaylistConfirmKeepLocal', { title, count: songIds.length }),
                t('netease.removeFromPlaylistPrefHint')
              ]
      const answer = await confirm({
        title: t('netease.removeFromPlaylist'),
        content,
        confirmShow: true
      })
      if (answer !== 'confirm') return false
      deleteLocal = pref === 'delete' && downloadedCount > 0
    }
  }
  try {
    const result = await invoke<{ removedIds?: string[] }>('netease:remove-playlist-tracks', {
      playlistId,
      songIds
    })
    const removedIds = [
      ...new Set(
        (Array.isArray(result?.removedIds) && result.removedIds.length > 0
          ? result.removedIds
          : songIds
        )
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      )
    ]
    // 先就地从当前打开的歌单列表里拿掉这些行。只发 reload-if-current
    // 会再走一遍 openSongList，但那是异步的，也常被后续 invalidate 丢掉，
    // 用户就会看到列表还在、必须重进歌单才消失。
    const removal = createNeteaseOpenPlaylistRemovalPayload(playlistId, removedIds)
    if (removal.paths.length > 0) {
      emitter.emit('songsArea/optimistic-remove', removal)
    }
    refreshNeteaseViews(removal.listUUID || `${NETEASE_PLAYLIST_PREFIX}${playlistId}`)
    if (deleteLocal) {
      const idsToDelete = downloadedIds.filter((id) => removedIds.includes(id))
      if (idsToDelete.length > 0) {
        await deleteNeteaseLocalFiles(idsToDelete, { confirm: false })
      }
    }
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

const persistNeteaseLibraryIconVisible = async (visible: boolean) => {
  const runtime = useRuntimeStore()
  runtime.setting.showNeteaseLibraryIcon = visible
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

/** 隐藏左侧库栏的网易云图标；登录状态和已下载文件不受影响，可在设置里重新打开。 */
export const hideNeteaseLibraryIcon = async (): Promise<boolean> => {
  const runtime = useRuntimeStore()
  const answer = await confirm({
    title: t('netease.hideLibraryIcon'),
    content: [t('netease.hideLibraryIconConfirm')],
    confirmShow: true
  })
  if (answer !== 'confirm') return false
  await persistNeteaseLibraryIconVisible(false)
  if (runtime.libraryAreaSelected === 'NeteaseLibrary') {
    runtime.libraryAreaSelected = 'FilterLibrary'
  }
  return true
}

const handleNeteaseLibraryMenu = async (
  event: MouseEvent,
  options?: { includeHideIcon?: boolean }
): Promise<void> => {
  const status = await getNeteaseStatus()
  const menuArr = [
    [{ menuName: 'netease.viewDownloaded' }],
    [
      ...(status.loggedIn ? [{ menuName: 'netease.sync' }] : []),
      ...(status.loggedIn
        ? [{ menuName: 'netease.relogin' }, { menuName: 'netease.logout' }]
        : [{ menuName: 'netease.login' }])
    ],
    ...(options?.includeHideIcon ? [[{ menuName: 'netease.hideLibraryIcon' }]] : [])
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
    case 'netease.hideLibraryIcon':
      await hideNeteaseLibraryIcon()
      break
  }
}

/** 库级右键：查看已下载 / 同步 / 登录或退出。树空白处、分组节点共用。 */
export const handleNeteaseLibraryContextMenu = async (event: MouseEvent): Promise<void> => {
  await handleNeteaseLibraryMenu(event)
}

/** 库图标右键：在库级菜单之外多一项「隐藏库图标」。 */
export const handleNeteaseLibraryIconContextMenu = async (event: MouseEvent): Promise<void> => {
  await handleNeteaseLibraryMenu(event, { includeHideIcon: true })
}

/**
 * 删除自己创建的网易云歌单，或取消收藏歌单 / 专辑。
 * 确认框沿用移出曲目时的本地文件选项；真正会删的只是仅属于这张歌单的已下载文件。
 */
export const deleteNeteasePlaylist = async (uuid: string): Promise<boolean> => {
  const runtime = useRuntimeStore()
  const action = getNeteasePlaylistDeletionAction(runtime.libraryTree, uuid)
  const context = findNeteasePlaylistContext(runtime.libraryTree, uuid)
  const playlistId = context?.playlistId || getNeteasePlaylistId(uuid)
  if (!action || !playlistId) return false

  const headingKey = action === 'delete' ? 'netease.deletePlaylist' : 'netease.unsubscribePlaylist'
  const failedKey =
    action === 'delete' ? 'netease.deletePlaylistFailed' : 'netease.unsubscribePlaylistFailed'
  const messageOnlyKey =
    action === 'delete'
      ? 'netease.deletePlaylistConfirmOnly'
      : 'netease.unsubscribePlaylistConfirmOnly'
  const messageKeepKey =
    action === 'delete'
      ? 'netease.deletePlaylistConfirmKeepLocal'
      : 'netease.unsubscribePlaylistConfirmKeepLocal'
  const messageDeleteKey =
    action === 'delete'
      ? 'netease.deletePlaylistConfirmDeleteLocal'
      : 'netease.unsubscribePlaylistConfirmDeleteLocal'

  type DeletePreview = {
    title?: string
    trackCount?: number
    exclusiveDownloadedIds?: string[]
    groups?: Array<{
      id: string
      title: string
      items: Array<{ playlistId: string; title: string; trackCount: number; coverUrl: string }>
    }>
  }

  let preview: DeletePreview
  try {
    preview = await invoke<DeletePreview>('netease:playlist-delete-preview', { playlistId })
  } catch (error) {
    await confirm({
      title: t(failedKey),
      content: [unwrapIpcError(error) || t('common.unknownError')],
      confirmShow: false
    })
    return false
  }

  const title = preview.title || context?.title || ''
  const trackCount = Number(preview.trackCount) || 0
  const exclusiveIds = [
    ...new Set(
      (preview.exclusiveDownloadedIds || []).map((id) => String(id || '').trim()).filter(Boolean)
    )
  ]
  const pref = normalizeNeteaseRemovePlaylistLocalFilesPref(
    runtime.setting.neteaseRemovePlaylistLocalFiles
  )
  const downloadedCount = exclusiveIds.length
  let deleteLocal = false
  if (shouldAskNeteaseRemovePlaylistLocalFiles({ pref, downloadedCount })) {
    const result = await openNeteaseRemovePlaylistDialog({
      title,
      count: trackCount,
      downloadedCount,
      headingKey,
      messageKey: messageOnlyKey,
      downloadedCountKey: 'netease.deletePlaylistExclusiveDownloadedCount'
    })
    if (!result.confirmed) return false
    const decision = resolveNeteaseRemovePlaylistLocalFilesDecision({
      pref,
      downloadedCount,
      alsoDeleteLocal: result.alsoDeleteLocal,
      remember: result.remember
    })
    deleteLocal = decision.deleteLocal
    if (decision.nextPref) {
      await persistNeteaseRemovePlaylistLocalFilesPref(decision.nextPref)
    }
  } else {
    const content =
      downloadedCount === 0
        ? [t(messageOnlyKey, { title, count: trackCount })]
        : pref === 'delete'
          ? [
              t(messageDeleteKey, { title, count: trackCount, downloadedCount }),
              t('netease.removeFromPlaylistPrefHint')
            ]
          : [
              t(messageKeepKey, { title, count: trackCount }),
              t('netease.removeFromPlaylistPrefHint')
            ]
    const answer = await confirm({
      title: t(headingKey),
      content,
      confirmShow: true
    })
    if (answer !== 'confirm') return false
    deleteLocal = pref === 'delete' && downloadedCount > 0
  }

  try {
    const result = await invoke<DeletePreview>('netease:delete-playlist', { playlistId })
    applyNeteaseGroupsToRuntimeTree(Array.isArray(result?.groups) ? result.groups : [])
    if (runtime.songsArea.songListUUID === uuid) {
      runtime.songsArea.songListUUID = ''
    }
    refreshNeteaseViews()
    if (deleteLocal) {
      const idsToDelete = [
        ...new Set(
          (result?.exclusiveDownloadedIds || exclusiveIds)
            .map((id) => String(id || '').trim())
            .filter(Boolean)
        )
      ]
      if (idsToDelete.length > 0) {
        await deleteNeteaseLocalFiles(idsToDelete, { confirm: false })
      }
    }
    return true
  } catch (error) {
    const message = unwrapIpcError(error) || t('common.unknownError')
    await confirm({
      title: t(failedKey),
      content: [message],
      confirmShow: false
    })
    return false
  }
}

/** 歌单节点右键：四项导入 + 删除/取消收藏 + 同步 */
export const handleNeteasePlaylistContextMenu = async (
  event: MouseEvent,
  uuid: string
): Promise<void> => {
  const playlistId = getNeteasePlaylistId(uuid)
  const action = getNeteasePlaylistDeletionAction(useRuntimeStore().libraryTree, uuid)
  const menuArr = [
    [
      { menuName: 'netease.importToFilter' },
      { menuName: 'netease.importToCurated' },
      { menuName: 'netease.importToSet' },
      { menuName: 'netease.importToMixtape' }
    ],
    ...(action === 'delete'
      ? [[{ menuName: 'netease.deletePlaylist' }]]
      : action === 'unsubscribe'
        ? [[{ menuName: 'netease.unsubscribePlaylist' }]]
        : []),
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
  if (
    result.menuName === 'netease.deletePlaylist' ||
    result.menuName === 'netease.unsubscribePlaylist'
  ) {
    await deleteNeteasePlaylist(uuid)
    return
  }
  if (result.menuName === 'netease.sync') await syncNeteaseLibrary()
}
