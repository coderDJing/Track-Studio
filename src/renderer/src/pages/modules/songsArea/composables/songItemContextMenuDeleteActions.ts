import { nextTick, type Ref } from 'vue'
import type { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import type { ISongInfo } from '../../../../../../types/globals'
import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
import emitter from '@renderer/utils/mitt'
import libraryUtils from '@renderer/utils/libraryUtils'
import { delSongsViaSend, permanentlyDelSongsViaSend } from '@renderer/utils/recycleBinActions'
import { showDeleteSummaryIfNeeded } from './songItemContextMenuSummaries'
import { detectSongsAreaScrollCarrier } from './scrollCarrier'

/**
 * 曲目右键菜单里「删除 / 从 SET 移除 / 从 Mixtape 移除 / 回收站彻底删除」这一组动作。
 *
 * 与其余菜单项分开的原因：它们共同维护「乐观删除 + 播放态清理 + 滚动回顶」这一套状态，
 * 互相耦合，却和其他动作（导出、分析、传输）没有交集。
 */

export type SongDeleteActionResult = {
  action: 'songsRemoved'
  paths?: string[]
  itemIds?: string[]
}

type DeleteSummary = {
  total?: number
  success?: number
  failed?: number
  removedPaths?: string[]
}

type OptimisticRestoreItem = {
  song: ISongInfo
  index: number
}

export interface SongDeleteActionContext {
  songsAreaState: ISongsAreaPaneRuntimeState
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaHostElementRef: Ref<InstanceType<typeof OverlayScrollbarsComponent> | null>
  syncSongsAreaScrollMetrics?: () => void
  isMixtapeView: () => boolean
  isSetView: () => boolean
  isRecycleBinView: boolean
  isExternalView: boolean
  normalizePath: (path: string | undefined | null) => string
  getRowKey: (song: ISongInfo) => string
  resolveSelectedKeys: () => string[]
  resolveSelectedFilePaths: (keys?: string[]) => string[]
  resolveSelectedItemIds: (keys?: string[]) => string[]
  resolveSelectedSetItemIds: (keys?: string[]) => string[]
}

const scrollSongsAreaToTop = (ctx: SongDeleteActionContext) => {
  const resetCarrierToTop = () => {
    const scrollElements = ctx.songsAreaHostElementRef.value?.osInstance()?.elements()
    const explicitViewport = scrollElements?.viewport as HTMLElement | undefined
    const explicitHost = scrollElements?.host as HTMLElement | undefined
    const info = detectSongsAreaScrollCarrier(
      explicitViewport || explicitHost || null,
      explicitHost || null
    )
    const targets = [info.carrier, info.viewport, info.content, info.host].filter(
      (element, index, list): element is HTMLElement =>
        element instanceof HTMLElement && list.indexOf(element) === index
    )
    for (const target of targets) {
      if (target.scrollTop !== 0) {
        target.scrollTop = 0
      }
    }
  }
  ctx.songsAreaState.scrollTop = 0
  resetCarrierToTop()
  ctx.syncSongsAreaScrollMetrics?.()
  void nextTick().then(() => {
    resetCarrierToTop()
    ctx.syncSongsAreaScrollMetrics?.()
  })
}

const clearPlayingStateIfTouched = (
  ctx: SongDeleteActionContext,
  normalizedPathSet: Set<string>
) => {
  const touchesCurrentPlaying =
    ctx.runtime.playingData.playingSongListUUID === ctx.songsAreaState.songListUUID &&
    normalizedPathSet.has(ctx.normalizePath(ctx.runtime.playingData.playingSong?.filePath))
  if (!touchesCurrentPlaying) return false
  try {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  } catch {}
  ctx.runtime.playingData.playingSongListUUID = ''
  ctx.runtime.playingData.playingSongListData = []
  ctx.runtime.playingData.playingSong = null
  return true
}

const buildDelSongsPayload = (ctx: SongDeleteActionContext, paths: string[]) => {
  if (ctx.isExternalView) {
    return { filePaths: paths, sourceType: 'external' }
  }
  const songListPath = libraryUtils.findDirPathByUuid(ctx.songsAreaState.songListUUID)
  if (songListPath) {
    return { filePaths: paths, songListPath }
  }
  return paths
}

const requestDeleteSongs = async (ctx: SongDeleteActionContext, paths: string[]) =>
  await delSongsViaSend(buildDelSongsPayload(ctx, paths))

/**
 * 「删除上方全部」。
 *
 * SET 只移除条目；其他视图走真实文件删除。网易云虚拟节点不会进入本菜单，
 * 因此这里不需要再区分虚拟路径。
 */
const handleDeleteAllAbove = async (
  ctx: SongDeleteActionContext,
  song: ISongInfo
): Promise<SongDeleteActionResult | null> => {
  const { songsAreaState, runtime, resolveSelectedFilePaths, getRowKey } = ctx
  const sourceSongListUUID = songsAreaState.songListUUID
  // 1. 基于当前状态和右键的歌曲，确定要删除的歌曲信息和路径 (delPaths)
  const initialSongInfoArrSnapshot = [...songsAreaState.songInfoArr]
  const songIndex = initialSongInfoArrSnapshot.findIndex(
    (item) => getRowKey(item) === getRowKey(song)
  )

  if (songIndex === -1) {
    return null
  }
  if (songIndex === 0) {
    return null // 没有曲目在当前曲目之上
  }

  const songsToRemoveInfoBasedOnSnapshot = initialSongInfoArrSnapshot.slice(0, songIndex)
  if (ctx.isSetView()) {
    const itemIds = songsToRemoveInfoBasedOnSnapshot
      .map((item) => item.setItemId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (!itemIds.length) return null
    await window.electron.ipcRenderer.invoke('setList:remove-items', itemIds)
    songsAreaState.selectedSongFilePath.length = 0
    if (
      runtime.playingData.playingSongListUUID === sourceSongListUUID &&
      runtime.playingData.playingSong?.setItemId &&
      itemIds.includes(runtime.playingData.playingSong.setItemId)
    ) {
      runtime.playingData.playingSongListUUID = ''
      runtime.playingData.playingSongListData = []
      runtime.playingData.playingSong = null
    }
    emitter.emit('playlistContentChanged', { uuids: [sourceSongListUUID] })
    emitter.emit('songsRemoved', {
      listUUID: sourceSongListUUID,
      itemIds
    })
    scrollSongsAreaToTop(ctx)
    return { action: 'songsRemoved', itemIds }
  }
  const delPaths = songsToRemoveInfoBasedOnSnapshot.map((s) => s.filePath)

  if (delPaths.length === 0) {
    return null
  }

  // 2. 用户确认 (如果需要)
  if (ctx.isRecycleBinView) {
    const res = await confirm({
      title: t('common.delete'),
      content: [t('tracks.confirmDeleteAllAbove'), t('tracks.deleteHint')]
    })
    if (res !== 'confirm') {
      return null
    }
  }

  let removedPathsForEvent: string[]
  const removedPathSet = new Set(delPaths.map((item) => ctx.normalizePath(item)))
  const optimisticRestoreItems: OptimisticRestoreItem[] = songsToRemoveInfoBasedOnSnapshot.map(
    (item, index) => ({
      song: { ...item },
      index
    })
  )
  const canOptimisticallyUpdate = true
  clearPlayingStateIfTouched(ctx, removedPathSet)
  emitter.emit('songsArea/optimistic-remove', {
    listUUID: sourceSongListUUID,
    paths: delPaths
  })
  scrollSongsAreaToTop(ctx)

  // 4. IPC 调用执行文件删除
  try {
    let deleteSummary: DeleteSummary
    if (ctx.isRecycleBinView) {
      deleteSummary = await permanentlyDelSongsViaSend([...delPaths])
    } else {
      deleteSummary = await requestDeleteSongs(ctx, [...delPaths])
    }
    removedPathsForEvent = deleteSummary.removedPaths || []
    const removedNormalizedSet = new Set(
      removedPathsForEvent.map((item) => ctx.normalizePath(item))
    )
    const failedRestoreItems =
      canOptimisticallyUpdate && Number(deleteSummary.failed || 0) > 0
        ? optimisticRestoreItems.filter(
            (item) => !removedNormalizedSet.has(ctx.normalizePath(item.song.filePath))
          )
        : []
    if (failedRestoreItems.length > 0) {
      emitter.emit('songsArea/optimistic-restore', {
        listUUID: sourceSongListUUID,
        items: failedRestoreItems
      })
    }
    if (ctx.isRecycleBinView || Number(deleteSummary.failed || 0) > 0) {
      await showDeleteSummaryIfNeeded(deleteSummary, {
        restoredFailed: failedRestoreItems.length > 0
      })
    }
  } catch {
    if (canOptimisticallyUpdate && optimisticRestoreItems.length > 0) {
      emitter.emit('songsArea/optimistic-restore', {
        listUUID: sourceSongListUUID,
        items: optimisticRestoreItems
      })
    }
    await showDeleteSummaryIfNeeded(
      {
        total: delPaths.length,
        success: 0,
        failed: delPaths.length
      },
      { restoredFailed: canOptimisticallyUpdate && optimisticRestoreItems.length > 0 }
    )
    return null
  }

  if (!canOptimisticallyUpdate && removedPathsForEvent.length > 0) {
    scrollSongsAreaToTop(ctx)
  }
  // 通知全局，保证其他视图也能同步（包含当前 songsArea 监听的统一删除处理）
  if (removedPathsForEvent.length > 0) {
    emitter.emit('songsRemoved', {
      listUUID: sourceSongListUUID,
      paths: removedPathsForEvent
    })
    emitter.emit('playlistContentChanged', { uuids: [sourceSongListUUID] })
  }
  return { action: 'songsRemoved', paths: removedPathsForEvent }
}

/** 「删除曲目 / 从 SET 移除 / 回收站彻底删除」：当前选中的行 */
const handleDeleteSelected = async (
  ctx: SongDeleteActionContext
): Promise<SongDeleteActionResult | null> => {
  const { songsAreaState, runtime, resolveSelectedFilePaths } = ctx
  const currentSelectedKeys = [...ctx.resolveSelectedKeys()]

  if (!currentSelectedKeys.length) return null

  if (ctx.isMixtapeView()) {
    const itemIds = ctx.resolveSelectedItemIds(currentSelectedKeys)
    if (!itemIds.length) return null
    await window.electron.ipcRenderer.invoke('mixtape:remove', {
      playlistId: songsAreaState.songListUUID,
      itemIds: [...itemIds]
    })
    songsAreaState.selectedSongFilePath.length = 0
    emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
    emitter.emit('songsRemoved', {
      listUUID: songsAreaState.songListUUID,
      itemIds: [...itemIds]
    })
    return { action: 'songsRemoved', itemIds: [...itemIds] }
  }
  if (ctx.isSetView()) {
    const itemIds = ctx.resolveSelectedSetItemIds(currentSelectedKeys)
    if (!itemIds.length) return null
    await window.electron.ipcRenderer.invoke('setList:remove-items', itemIds)
    songsAreaState.selectedSongFilePath.length = 0
    if (
      runtime.playingData.playingSongListUUID === songsAreaState.songListUUID &&
      runtime.playingData.playingSong?.setItemId &&
      itemIds.includes(runtime.playingData.playingSong.setItemId)
    ) {
      runtime.playingData.playingSongListUUID = ''
      runtime.playingData.playingSongListData = []
      runtime.playingData.playingSong = null
    }
    emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
    emitter.emit('songsRemoved', {
      listUUID: songsAreaState.songListUUID,
      itemIds: [...itemIds]
    })
    return { action: 'songsRemoved', itemIds: [...itemIds] }
  }

  let shouldDelete = true
  if (ctx.isRecycleBinView) {
    const res = await confirm({
      title: t('common.delete'),
      content: [t('tracks.confirmDeleteSelected'), t('tracks.deleteHint')]
    })
    shouldDelete = res === 'confirm'
  }

  if (!shouldDelete) return null

  const selectedSnapshot = [...songsAreaState.songInfoArr]
  const resolvedSelectedPaths = resolveSelectedFilePaths(currentSelectedKeys)
  let removedPathsForEvent: string[]
  const selectedPathSet = new Set(resolvedSelectedPaths.map((item) => ctx.normalizePath(item)))
  const optimisticRestoreItems: OptimisticRestoreItem[] = selectedSnapshot
    .map((item, index) => ({ song: { ...item }, index }))
    .filter((item) => selectedPathSet.has(ctx.normalizePath(item.song.filePath)))

  clearPlayingStateIfTouched(ctx, selectedPathSet)
  emitter.emit('songsArea/optimistic-remove', {
    listUUID: songsAreaState.songListUUID,
    paths: resolvedSelectedPaths
  })

  try {
    let deleteSummary: DeleteSummary
    if (ctx.isRecycleBinView) {
      deleteSummary = await permanentlyDelSongsViaSend([...resolvedSelectedPaths])
    } else {
      deleteSummary = await requestDeleteSongs(ctx, [...resolvedSelectedPaths])
    }
    removedPathsForEvent = deleteSummary.removedPaths || []
    const removedNormalizedSet = new Set(
      removedPathsForEvent.map((item) => ctx.normalizePath(item))
    )
    const failedRestoreItems =
      Number(deleteSummary.failed || 0) > 0
        ? optimisticRestoreItems.filter(
            (item) => !removedNormalizedSet.has(ctx.normalizePath(item.song.filePath))
          )
        : []
    if (failedRestoreItems.length > 0) {
      emitter.emit('songsArea/optimistic-restore', {
        listUUID: songsAreaState.songListUUID,
        items: failedRestoreItems
      })
    }
    if (ctx.isRecycleBinView || Number(deleteSummary.failed || 0) > 0) {
      await showDeleteSummaryIfNeeded(deleteSummary, {
        restoredFailed: failedRestoreItems.length > 0
      })
    }
  } catch {
    if (optimisticRestoreItems.length > 0) {
      emitter.emit('songsArea/optimistic-restore', {
        listUUID: songsAreaState.songListUUID,
        items: optimisticRestoreItems
      })
    }
    await showDeleteSummaryIfNeeded(
      {
        total: resolvedSelectedPaths.length,
        success: 0,
        failed: resolvedSelectedPaths.length
      },
      { restoredFailed: optimisticRestoreItems.length > 0 }
    )
    return null
  }

  songsAreaState.selectedSongFilePath.length = 0
  if (removedPathsForEvent.length > 0) {
    emitter.emit('songsRemoved', {
      listUUID: songsAreaState.songListUUID,
      paths: removedPathsForEvent
    })
    emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
  }
  return { action: 'songsRemoved', paths: removedPathsForEvent }
}

export const SONG_DELETE_MENU_NAMES = new Set([
  'tracks.deleteAllAbove',
  'tracks.deleteTracks',
  'library.removeFromSet',
  'recycleBin.permanentlyDeleteTracks'
])

export async function handleSongDeleteMenuAction(
  menuName: string,
  song: ISongInfo,
  ctx: SongDeleteActionContext
): Promise<SongDeleteActionResult | null> {
  if (menuName === 'tracks.deleteAllAbove') {
    return await handleDeleteAllAbove(ctx, song)
  }
  return await handleDeleteSelected(ctx)
}
