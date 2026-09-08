import { nextTick, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import libraryUtils from '@renderer/utils/libraryUtils'
import { t } from '@renderer/utils/translate'
import emitter from '@renderer/utils/mitt'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { resolvePlaybackDeleteAllAboveTarget } from '@shared/playbackDeleteAllAbove'
import { isWindowsPathPlatform, normalizeFilePathForComparison } from '@shared/filePathComparison'
import { showDeleteSummaryIfNeeded } from '@renderer/pages/modules/songsArea/composables/songItemContextMenuSummaries'

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

export type DelAllAboveOptions = {
  confirmed?: boolean
}

const toDeleteSummary = (summary: unknown): DeleteSummary => {
  const payload = summary && typeof summary === 'object' ? (summary as DeleteSummary) : {}
  return {
    total: Number(payload.total || 0),
    success: Number(payload.success || 0),
    failed: Number(payload.failed || 0),
    removedPaths: Array.isArray(payload.removedPaths) ? payload.removedPaths : []
  }
}

export const createDelAllAbove = (params: {
  runtime: ReturnType<typeof useRuntimeStore>
  isFileOperationInProgress: Ref<boolean>
  isReadOnlyPlaybackSource: () => boolean
}) => {
  const { runtime, isFileOperationInProgress, isReadOnlyPlaybackSource } = params
  const caseInsensitiveFilePath = isWindowsPathPlatform(
    runtime.setting.platform || runtime.platform
  )
  const normalizePath = (filePath: string | undefined | null) =>
    normalizeFilePathForComparison(filePath, caseInsensitiveFilePath)

  const buildSongsAreaOptimisticRestoreItems = (
    listUUID: string,
    filePaths: string[]
  ): OptimisticRestoreItem[] => {
    if (!listUUID || runtime.songsArea.songListUUID !== listUUID) return []
    const pathSet = new Set(filePaths.map((item) => normalizePath(item)))
    return runtime.songsArea.songInfoArr
      .map((item, index) => ({ song: { ...item }, index }))
      .filter((item) => pathSet.has(normalizePath(item.song.filePath)))
  }

  const delAllAbove = async (options?: DelAllAboveOptions) => {
    if (isFileOperationInProgress.value || !runtime.playingData.playingSong) return
    if (isReadOnlyPlaybackSource()) {
      if (!options?.confirmed) {
        await confirm({
          title: t('dialog.hint'),
          content: [t('tracks.readOnlySourceDeleteNotAllowed')],
          confirmShow: false
        })
      }
      return
    }

    const currentSongListUUID = runtime.playingData.playingSongListUUID
    const target = resolvePlaybackDeleteAllAboveTarget({
      listUuid: currentSongListUUID,
      listData: runtime.playingData.playingSongListData,
      playingSong: runtime.playingData.playingSong,
      libraryType: libraryUtils.getLibraryTreeByUUID(currentSongListUUID)?.type,
      caseInsensitiveFilePath
    })
    if (!target) return

    const delPaths = target.songs
      .map((item) => item.filePath)
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
    if (delPaths.length === 0) return

    const isInRecycleBin = currentSongListUUID === RECYCLE_BIN_UUID
    if (!options?.confirmed) {
      const content = [t('tracks.confirmDeleteAllAbovePlaying', { count: delPaths.length })]
      if (isInRecycleBin) {
        content.push(t('tracks.confirmDeleteAllAbove'), t('tracks.deleteHint'))
      }
      const res = await confirm({
        title: t('common.delete'),
        content
      })
      if (res !== 'confirm') return
    }

    isFileOperationInProgress.value = true
    const currentPlayingListSnapshot = [...runtime.playingData.playingSongListData]
    const remainingList = currentPlayingListSnapshot.slice(target.playingIndex)
    const optimisticRestoreItems = buildSongsAreaOptimisticRestoreItems(
      currentSongListUUID,
      delPaths
    )
    let shouldRestorePlaybackList = true

    try {
      runtime.playingData.playingSongListData = remainingList
      emitter.emit('songsArea/optimistic-remove', {
        listUUID: currentSongListUUID,
        paths: delPaths
      })
      emitter.emit('songsArea/scrollToTop', { listUUID: currentSongListUUID })

      let deleteSummary: DeleteSummary
      if (isInRecycleBin) {
        const summary = await window.electron.ipcRenderer.invoke('permanentlyDelSongs', [
          ...delPaths
        ])
        deleteSummary = toDeleteSummary(summary)
      } else {
        const songListPath = libraryUtils.findDirPathByUuid(currentSongListUUID)
        const payload =
          currentSongListUUID === EXTERNAL_PLAYLIST_UUID
            ? { filePaths: [...delPaths], sourceType: 'external' }
            : songListPath
              ? { filePaths: [...delPaths], songListPath }
              : [...delPaths]
        const summary = await window.electron.ipcRenderer.invoke('delSongsAwaitable', payload)
        deleteSummary = toDeleteSummary(summary)
      }

      const removedPathsForEvent = deleteSummary.removedPaths || []
      const removedNormalizedSet = new Set(removedPathsForEvent.map((item) => normalizePath(item)))
      const failedRestoreItems =
        Number(deleteSummary.failed || 0) > 0
          ? optimisticRestoreItems.filter(
              (item) => !removedNormalizedSet.has(normalizePath(item.song.filePath))
            )
          : []
      runtime.playingData.playingSongListData = currentPlayingListSnapshot.filter(
        (item) => !removedNormalizedSet.has(normalizePath(item.filePath))
      )
      if (failedRestoreItems.length > 0) {
        emitter.emit('songsArea/optimistic-restore', {
          listUUID: currentSongListUUID,
          items: failedRestoreItems
        })
      }
      if (isInRecycleBin || Number(deleteSummary.failed || 0) > 0) {
        await showDeleteSummaryIfNeeded(deleteSummary, {
          restoredFailed: failedRestoreItems.length > 0
        })
      }
      if (Number(deleteSummary.success || 0) <= 0 && removedPathsForEvent.length === 0) {
        if (optimisticRestoreItems.length > 0) {
          emitter.emit('songsArea/optimistic-restore', {
            listUUID: currentSongListUUID,
            items: optimisticRestoreItems
          })
        }
        return
      }
      shouldRestorePlaybackList = false
      if (removedPathsForEvent.length > 0) {
        emitter.emit('songsRemoved', {
          listUUID: currentSongListUUID,
          paths: removedPathsForEvent
        })
      }
      const changedPlaylistUuids = new Set<string>([RECYCLE_BIN_UUID])
      if (currentSongListUUID) changedPlaylistUuids.add(currentSongListUUID)
      emitter.emit('playlistContentChanged', { uuids: Array.from(changedPlaylistUuids) })
      await nextTick()
    } catch {
      if (optimisticRestoreItems.length > 0) {
        emitter.emit('songsArea/optimistic-restore', {
          listUUID: currentSongListUUID,
          items: optimisticRestoreItems
        })
      }
      await showDeleteSummaryIfNeeded(
        {
          total: delPaths.length,
          success: 0,
          failed: delPaths.length
        },
        { restoredFailed: optimisticRestoreItems.length > 0 }
      )
    } finally {
      if (shouldRestorePlaybackList) {
        runtime.playingData.playingSongListData = currentPlayingListSnapshot
      }
      isFileOperationInProgress.value = false
    }
  }

  return delAllAbove
}
