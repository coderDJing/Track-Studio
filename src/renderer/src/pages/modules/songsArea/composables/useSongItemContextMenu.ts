import { nextTick, Ref, ref } from 'vue'
import { type ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import { ISongInfo, IMenu, type IMetadataAutoFillSummary } from '../../../../../../types/globals' // Corrected path
import { t } from '@renderer/utils/translate'
import rightClickMenu from '@renderer/components/rightClickMenu' // Assuming it's a default export or easily callable
import confirm from '@renderer/components/confirmDialog'
import {
  showDeleteSummaryIfNeeded,
  showRestoreSummaryIfNeeded
} from './songItemContextMenuSummaries'
import exportDialog from '@renderer/components/exportDialog'
import { openRekordboxDesktopPlaylistForSelectedTracks } from '@renderer/utils/rekordboxDesktopPlaylist'
import { openRekordboxXmlExportForSelectedTracks } from '@renderer/utils/rekordboxXmlExport'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import emitter from '@renderer/utils/mitt'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import { hasEffectiveAcoustIdKey } from '@renderer/utils/acoustid'
import libraryUtils from '@renderer/utils/libraryUtils'
import { startAudioConvertFromFiles } from '@renderer/utils/audioConvertActions'
import { promptAndStartTrackReanalysis } from '@renderer/utils/trackReanalysis'
import choiceDialog from '@renderer/components/choiceDialog'
import { normalizeArtistName, splitArtistNames } from '@shared/artistNames'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import {
  buildNeteaseSearchQuery,
  normalizeNeteaseSearchText,
  openNeteaseSearch
} from '@renderer/utils/neteaseSearch'
import { delSongsViaSend, permanentlyDelSongsViaSend } from '@renderer/utils/recycleBinActions'
import {
  buildSongItemMenuArr,
  createDefaultMenuArr,
  createMixtapeMenuArr,
  createRecycleMenuArr,
  createSetMenuArr,
  withoutRecordingAnalysisMenus
} from './songItemContextMenuMenus'
import { detectSongsAreaScrollCarrier } from './scrollCarrier'
import type { LibraryTransferActionMode } from '@renderer/utils/libraryTransfer'
import { isWindowsPathPlatform, normalizeFilePathForComparison } from '@shared/filePathComparison'

// Type for the return value when a dialog needs to be opened by the parent
interface OpenDialogAction {
  action: 'openSelectSongListDialog'
  libraryName: 'CuratedLibrary' | 'FilterLibrary' | 'SetLibrary' | 'MixtapeLibrary'
  actionMode?: LibraryTransferActionMode
}

// 新增：用于表示歌曲被右键菜单操作移除的返回类型
interface SongsRemovedAction {
  action: 'songsRemoved'
  paths?: string[]
  itemIds?: string[]
}

interface MetadataUpdatedAction {
  action: 'metadataUpdated'
  song: ISongInfo
  oldFilePath?: string
}

interface MetadataBatchUpdatedAction {
  action: 'metadataBatchUpdated'
  updates: Array<{ song: ISongInfo; oldFilePath?: string }>
}

type DeleteSummary = {
  total?: number
  success?: number
  failed?: number
  removedPaths?: string[]
}

type ExportSongsToDirSummary = {
  removedPaths?: string[]
  removedSetItemIds?: string[]
}

type OptimisticRestoreItem = {
  song: ISongInfo
  index: number
}

export function useSongItemContextMenu(
  songsAreaHostElementRef: Ref<InstanceType<typeof OverlayScrollbarsComponent> | null>, // For scrolling
  songsAreaState: ISongsAreaPaneRuntimeState,
  syncSongsAreaScrollMetrics?: () => void
) {
  const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error || t('common.unknownError'))
  const runtime = useRuntimeStore() // Use the store directly
  const normalizePath = (p: string | undefined | null) =>
    normalizeFilePathForComparison(
      p,
      isWindowsPathPlatform(runtime.setting.platform || runtime.platform)
    )
  const isMixtapeView = () =>
    libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type === 'mixtapeList'
  const isSetView = () =>
    libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type === 'setList'
  const getRowKey = (song: ISongInfo) =>
    isMixtapeView() && song.mixtapeItemId
      ? song.mixtapeItemId
      : isSetView() && song.setItemId
        ? song.setItemId
        : song.filePath
  const resolveSelectedKeys = () => songsAreaState.selectedSongFilePath
  const resolveSelectedFilePaths = (keys?: string[]) => {
    const selectedKeys = keys ?? resolveSelectedKeys()
    if (!isMixtapeView() && !isSetView()) {
      return selectedKeys.filter((p) => typeof p === 'string' && p.length > 0)
    }
    const map = new Map<string, string>()
    for (const item of songsAreaState.songInfoArr) {
      if (item.mixtapeItemId) {
        map.set(item.mixtapeItemId, item.filePath)
      }
      if (item.setItemId) {
        map.set(item.setItemId, item.filePath)
      }
    }
    return selectedKeys
      .map((key) => map.get(key) || key)
      .filter((p) => typeof p === 'string' && p.length > 0)
  }
  const resolveSelectedItemIds = (keys?: string[]) => {
    if (!isMixtapeView()) return []
    const selectedKeys = keys ?? resolveSelectedKeys()
    const available = new Set(
      songsAreaState.songInfoArr
        .map((item) => item.mixtapeItemId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
    return selectedKeys.filter((key) => available.has(key))
  }
  const resolveSelectedSetItemIds = (keys?: string[]) => {
    if (!isSetView()) return []
    const selectedKeys = keys ?? resolveSelectedKeys()
    const available = new Set(
      songsAreaState.songInfoArr
        .map((item) => item.setItemId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
    return selectedKeys.filter((key) => available.has(key))
  }
  const resolveSelectedSongs = (keys?: string[]) => {
    const selectedKeys = keys ?? resolveSelectedKeys()
    if (isMixtapeView() || isSetView()) {
      const selectedKeySet = new Set(selectedKeys)
      return songsAreaState.songInfoArr.filter((item) => selectedKeySet.has(getRowKey(item)))
    }
    const selectedFilePathSet = new Set(resolveSelectedFilePaths(selectedKeys))
    return songsAreaState.songInfoArr.filter((item) => selectedFilePathSet.has(item.filePath))
  }
  const hasWarnedMissingAcoustId = ref(false)
  const warnAcoustIdMissing = () => {
    if (hasWarnedMissingAcoustId.value) return
    void (async () => {
      if (await hasEffectiveAcoustIdKey(runtime.setting)) return
      hasWarnedMissingAcoustId.value = true
      void confirm({
        title: t('metadata.autoFillFingerprintHintTitle'),
        content: [
          t('metadata.autoFillFingerprintHintMissing'),
          t('metadata.autoFillFingerprintHintGuide')
        ],
        confirmShow: false
      })
    })()
  }

  const confirmTaskBusy = async () => {
    await confirm({
      title: t('dialog.hint'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
  }

  const resolveCoreLibraryName = (): 'FilterLibrary' | 'CuratedLibrary' | 'SetLibrary' | '' => {
    const dirPath = String(
      libraryUtils.findDirPathByUuid(songsAreaState.songListUUID) || ''
    ).replace(/\\/g, '/')
    if (dirPath === 'library/FilterLibrary' || dirPath.startsWith('library/FilterLibrary/')) {
      return 'FilterLibrary'
    }
    if (dirPath === 'library/CuratedLibrary' || dirPath.startsWith('library/CuratedLibrary/')) {
      return 'CuratedLibrary'
    }
    if (dirPath === 'library/SetLibrary' || dirPath.startsWith('library/SetLibrary/')) {
      return 'SetLibrary'
    }
    return ''
  }

  const resolveCuratedArtistMatches = (currentSong: ISongInfo) => {
    if (runtime.setting.enableCuratedArtistTracking === false) return []
    if (runtime.libraryAreaSelected !== 'FilterLibrary') return []
    const favorites = runtime.curatedArtistFavorites || []
    const matchedArtists: string[] = []
    const seen = new Set<string>()
    for (const artistName of splitArtistNames(currentSong?.artist)) {
      const normalized = normalizeArtistName(artistName)
      if (!normalized || seen.has(normalized)) continue
      const matchedFavorite = favorites.find(
        (item) => normalizeArtistName(item?.name) === normalized
      )
      if (!matchedFavorite) continue
      seen.add(normalized)
      matchedArtists.push(String(matchedFavorite.name || artistName).trim() || artistName)
    }
    return matchedArtists
  }

  const menuArr: Ref<IMenu[][]> = ref(createDefaultMenuArr(songsAreaState.songListUUID))

  const showAndHandleSongContextMenu = async (
    event: MouseEvent,
    song: ISongInfo
  ): Promise<
    | OpenDialogAction
    | SongsRemovedAction
    | MetadataUpdatedAction
    | MetadataBatchUpdatedAction
    | null
  > => {
    const isRecycleBinView = songsAreaState.songListUUID === RECYCLE_BIN_UUID
    const isRecordingLibraryView = songsAreaState.songListUUID === RECORDING_LIBRARY_UUID
    const isExternalView = songsAreaState.songListUUID === EXTERNAL_PLAYLIST_UUID
    const matchedCuratedArtists = resolveCuratedArtistMatches(song)
    const matchedCuratedArtist = matchedCuratedArtists[0] || ''
    if (songsAreaState.selectedSongFilePath.indexOf(getRowKey(song)) === -1) {
      songsAreaState.selectedSongFilePath = [getRowKey(song)]
    }

    const baseMenuArr = isMixtapeView()
      ? createMixtapeMenuArr()
      : isRecycleBinView
        ? createRecycleMenuArr()
        : isSetView()
          ? createSetMenuArr(songsAreaState.songListUUID)
          : createDefaultMenuArr(songsAreaState.songListUUID)
    menuArr.value = buildSongItemMenuArr(
      isRecordingLibraryView ? withoutRecordingAnalysisMenus(baseMenuArr) : baseMenuArr,
      matchedCuratedArtists
    )
    const result = await rightClickMenu({
      menuArr: menuArr.value,
      clickEvent: event
    })

    if (result === 'cancel') return null

    const buildDelSongsPayload = (paths: string[]) => {
      if (isExternalView) {
        return { filePaths: paths, sourceType: 'external' }
      }
      const songListPath = libraryUtils.findDirPathByUuid(songsAreaState.songListUUID)
      if (songListPath) {
        return { filePaths: paths, songListPath }
      }
      return paths
    }
    const showNeteaseSearchEmptyHint = async (messageKey: string) => {
      await confirm({
        title: t('dialog.hint'),
        content: [t(messageKey)],
        confirmShow: false
      })
    }
    const openSongNeteaseSearch = async (query: string) => {
      if (!openNeteaseSearch(query)) {
        await showNeteaseSearchEmptyHint('tracks.neteaseSearchEmpty')
      }
    }
    const requestDeleteSongs = async (paths: string[]) => {
      return await delSongsViaSend(buildDelSongsPayload(paths))
    }

    const resetSongsAreaScrollCarrierToTop = () => {
      const scrollElements = songsAreaHostElementRef.value?.osInstance()?.elements()
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

    const scrollSongsAreaToTop = () => {
      songsAreaState.scrollTop = 0
      resetSongsAreaScrollCarrierToTop()
      syncSongsAreaScrollMetrics?.()
      void nextTick().then(() => {
        resetSongsAreaScrollCarrierToTop()
        syncSongsAreaScrollMetrics?.()
      })
    }

    const clearPlayingStateIfTouched = (normalizedPathSet: Set<string>) => {
      const touchesCurrentPlaying =
        runtime.playingData.playingSongListUUID === songsAreaState.songListUUID &&
        normalizedPathSet.has(normalizePath(runtime.playingData.playingSong?.filePath))
      if (!touchesCurrentPlaying) return false
      try {
        emitter.emit('waveform-preview:stop', { reason: 'switch' })
      } catch {}
      runtime.playingData.playingSongListUUID = ''
      runtime.playingData.playingSongListData = []
      runtime.playingData.playingSong = null
      return true
    }

    switch (result.menuName) {
      case 'recycleBin.restoreToOriginal': {
        const currentSelectedPaths = resolveSelectedFilePaths()
        if (!currentSelectedPaths.length) return null
        const summary = await window.electron.ipcRenderer.invoke('recycleBin:restore', {
          filePaths: [...currentSelectedPaths]
        })
        const removedPaths = Array.isArray(summary?.removedPaths) ? summary.removedPaths : []
        if (removedPaths.length > 0) {
          emitter.emit('songsRemoved', {
            listUUID: songsAreaState.songListUUID,
            paths: removedPaths
          })
        }
        const playlistUuids = Array.isArray(summary?.playlistUuids) ? summary.playlistUuids : []
        if (removedPaths.length > 0) {
          emitter.emit('playlistContentChanged', {
            uuids: Array.from(new Set([RECYCLE_BIN_UUID, ...playlistUuids]))
          })
        }
        songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
          (path) => !removedPaths.includes(path)
        )
        await showRestoreSummaryIfNeeded(summary)
        if (removedPaths.length > 0) {
          return { action: 'songsRemoved', paths: removedPaths }
        }
        return null
      }
      case 'tracks.editMetadata': {
        const { default: openEditMetadataDialog } =
          await import('@renderer/components/editMetadataDialog')
        const dialogResult = await openEditMetadataDialog({
          filePath: song.filePath
        })
        if (dialogResult && dialogResult !== 'cancel') {
          return {
            action: 'metadataUpdated',
            song: dialogResult.updatedSongInfo,
            oldFilePath: dialogResult.oldFilePath
          }
        }
        return null
      }
      case 'metadata.autoFillMenu': {
        const selectedFiles = resolveSelectedFilePaths()
        if (!selectedFiles.length) {
          await confirm({
            title: t('dialog.hint'),
            content: [t('metadata.autoFillNeedSelection')],
            confirmShow: false
          })
          return null
        }
        warnAcoustIdMissing()
        runtime.isProgressing = true
        let summary: IMetadataAutoFillSummary | null = null
        let hadError = false
        try {
          summary = await invokeMetadataAutoFill(selectedFiles)
        } catch (error: unknown) {
          hadError = true
          await confirm({
            title: t('common.error'),
            content: [getErrorMessage(error)],
            confirmShow: false
          })
        } finally {
          runtime.isProgressing = false
        }
        if (!summary) {
          if (!hadError) {
            await confirm({
              title: t('dialog.hint'),
              content: [t('metadata.autoFillNoEligible')],
              confirmShow: false
            })
          }
          return null
        }
        const { default: openAutoSummary } =
          await import('@renderer/components/autoMetadataSummaryDialog')
        await openAutoSummary(summary)
        const updates =
          summary.items
            ?.filter((item) => item.status === 'applied' && item.updatedSongInfo)
            .map((item) => ({
              song: item.updatedSongInfo as ISongInfo,
              oldFilePath: item.oldFilePath
            })) || []
        if (updates.length) {
          return {
            action: 'metadataBatchUpdated',
            updates
          }
        }
        return null
      }
      case 'tracks.convertFormat': {
        const files = resolveSelectedFilePaths()
        try {
          await startAudioConvertFromFiles({
            files,
            allowedSourceExts: runtime.setting.audioExt,
            songListUUID: songsAreaState.songListUUID
          })
        } catch {
          // 忽略错误，由主进程统一上报
        }
        return null
      }
      case 'stemSeparation.menu': {
        const { default: openLibraryStemSeparationDialog } =
          await import('@renderer/components/libraryStemSeparationDialog')
        await openLibraryStemSeparationDialog({
          filePath: song.filePath,
          songTitle: song.title
        })
        return null
      }
      case 'similarTracks.menu': {
        const seeds = resolveSelectedSongs()
        if (!seeds.length) return null
        const { default: openBatchSimilarTracksDialog } =
          await import('@renderer/components/batchSimilarTracksDialog')
        await openBatchSimilarTracksDialog(seeds)
        return null
      }
      case 'tracks.deleteAllAbove': {
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
        if (isSetView()) {
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
          scrollSongsAreaToTop()
          return { action: 'songsRemoved', itemIds }
        }
        const delPaths = songsToRemoveInfoBasedOnSnapshot.map((s) => s.filePath)

        if (delPaths.length === 0) {
          return null
        }

        // 2. 用户确认 (如果需要)
        if (isRecycleBinView) {
          const res = await confirm({
            title: t('common.delete'),
            content: [t('tracks.confirmDeleteAllAbove'), t('tracks.deleteHint')]
          })
          if (res !== 'confirm') {
            return null
          }
        }

        // 列表不再使用封面 URL，无需回收

        let removedPathsForEvent = [...delPaths]
        const removedPathSet = new Set(delPaths.map((item) => normalizePath(item)))
        const optimisticRestoreItems: OptimisticRestoreItem[] =
          songsToRemoveInfoBasedOnSnapshot.map((item, index) => ({
            song: { ...item },
            index
          }))
        const canOptimisticallyUpdate = true
        clearPlayingStateIfTouched(removedPathSet)
        emitter.emit('songsArea/optimistic-remove', {
          listUUID: sourceSongListUUID,
          paths: delPaths
        })
        scrollSongsAreaToTop()

        // 4. IPC 调用执行文件删除
        try {
          let deleteSummary: DeleteSummary
          if (isRecycleBinView) {
            deleteSummary = await permanentlyDelSongsViaSend([...delPaths])
          } else {
            deleteSummary = await requestDeleteSongs([...delPaths])
          }
          removedPathsForEvent = deleteSummary.removedPaths || []
          const removedNormalizedSet = new Set(
            removedPathsForEvent.map((item) => normalizePath(item))
          )
          const failedRestoreItems =
            canOptimisticallyUpdate && Number(deleteSummary.failed || 0) > 0
              ? optimisticRestoreItems.filter(
                  (item) => !removedNormalizedSet.has(normalizePath(item.song.filePath))
                )
              : []
          if (failedRestoreItems.length > 0) {
            emitter.emit('songsArea/optimistic-restore', {
              listUUID: sourceSongListUUID,
              items: failedRestoreItems
            })
          }
          if (isRecycleBinView || Number(deleteSummary.failed || 0) > 0) {
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
          scrollSongsAreaToTop()
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
      case 'tracks.deleteTracks':
      case 'library.removeFromSet':
      case 'recycleBin.permanentlyDeleteTracks':
        {
          const currentSelectedKeys = [...resolveSelectedKeys()]

          if (!currentSelectedKeys.length) return null

          if (isMixtapeView()) {
            const itemIds = resolveSelectedItemIds(currentSelectedKeys)
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
          if (isSetView()) {
            const itemIds = resolveSelectedSetItemIds(currentSelectedKeys)
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
          if (isRecycleBinView) {
            const res = await confirm({
              title: t('common.delete'),
              content: [t('tracks.confirmDeleteSelected'), t('tracks.deleteHint')]
            })
            shouldDelete = res === 'confirm'
          }

          if (shouldDelete) {
            const selectedSnapshot = [...songsAreaState.songInfoArr]
            const resolvedSelectedPaths = resolveSelectedFilePaths(currentSelectedKeys)
            let removedPathsForEvent = [...resolvedSelectedPaths]
            const selectedPathSet = new Set(
              resolvedSelectedPaths.map((item) => normalizePath(item))
            )
            const optimisticRestoreItems: OptimisticRestoreItem[] = selectedSnapshot
              .map((item, index) => ({ song: { ...item }, index }))
              .filter((item) => selectedPathSet.has(normalizePath(item.song.filePath)))

            clearPlayingStateIfTouched(selectedPathSet)
            emitter.emit('songsArea/optimistic-remove', {
              listUUID: songsAreaState.songListUUID,
              paths: resolvedSelectedPaths
            })

            try {
              let deleteSummary: DeleteSummary
              if (isRecycleBinView) {
                deleteSummary = await permanentlyDelSongsViaSend([...resolvedSelectedPaths])
              } else {
                deleteSummary = await requestDeleteSongs([...resolvedSelectedPaths])
              }
              removedPathsForEvent = deleteSummary.removedPaths || []
              const removedNormalizedSet = new Set(
                removedPathsForEvent.map((item) => normalizePath(item))
              )
              const failedRestoreItems =
                Number(deleteSummary.failed || 0) > 0
                  ? optimisticRestoreItems.filter(
                      (item) => !removedNormalizedSet.has(normalizePath(item.song.filePath))
                    )
                  : []
              if (failedRestoreItems.length > 0) {
                emitter.emit('songsArea/optimistic-restore', {
                  listUUID: songsAreaState.songListUUID,
                  items: failedRestoreItems
                })
              }
              if (isRecycleBinView || Number(deleteSummary.failed || 0) > 0) {
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
        }
        break
      case 'fingerprints.analyzeAndAdd': {
        const files = resolveSelectedFilePaths()
        await analyzeFingerprintsForPaths(files, { origin: 'selection' })
        return null
      }
      case 'library.removeCuratedArtistFavorite': {
        if (matchedCuratedArtists.length <= 0) return null
        let artistToRemove = matchedCuratedArtist
        if (matchedCuratedArtists.length === 1) {
          const res = await confirm({
            title: t('library.removeCuratedArtistFavoriteTitle'),
            content: [t('library.removeCuratedArtistFavoriteConfirm', { artist: artistToRemove })]
          })
          if (res !== 'confirm') return null
        } else {
          const selectedArtistKey = await choiceDialog({
            title: t('library.removeCuratedArtistFavoriteTitle'),
            content: [
              t('library.removeCuratedArtistFavoriteSelectHint'),
              t('library.removeCuratedArtistFavoriteSelectDesc')
            ],
            options: [
              ...matchedCuratedArtists.map((artist) => ({
                key: normalizeArtistName(artist),
                label: artist
              })),
              { key: 'cancel', label: t('common.cancel') }
            ],
            innerHeight: Math.min(220 + matchedCuratedArtists.length * 42, 420),
            innerWidth: 520
          })
          if (selectedArtistKey === 'cancel') return null
          artistToRemove =
            matchedCuratedArtists.find(
              (artist) => normalizeArtistName(artist) === selectedArtistKey
            ) || ''
          if (!artistToRemove) return null
        }
        try {
          await window.electron.ipcRenderer.invoke('curatedArtists:remove', artistToRemove)
        } catch (error: unknown) {
          await confirm({
            title: t('common.error'),
            content: [getErrorMessage(error)],
            confirmShow: false
          })
        }
        return null
      }
      case 'library.moveToCurated':
        return {
          action: 'openSelectSongListDialog',
          libraryName: 'CuratedLibrary',
          actionMode: 'move'
        }
      case 'library.copyToCurated':
        return {
          action: 'openSelectSongListDialog',
          libraryName: 'CuratedLibrary',
          actionMode: 'copy'
        }
      case 'library.moveToFilter':
        return {
          action: 'openSelectSongListDialog',
          libraryName: 'FilterLibrary',
          actionMode: 'move'
        }
      case 'library.copyToFilter':
        return {
          action: 'openSelectSongListDialog',
          libraryName: 'FilterLibrary',
          actionMode: 'copy'
        }
      case 'library.addToSet':
        return { action: 'openSelectSongListDialog', libraryName: 'SetLibrary' }
      case 'library.addToMixtape':
        return { action: 'openSelectSongListDialog', libraryName: 'MixtapeLibrary' }
      case 'tracks.exportTracks': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return null
        }
        const exportResult = await exportDialog({ title: 'tracks.title' })
        if (exportResult !== 'cancel') {
          const { folderPathVal, deleteSongsAfterExport } = exportResult
          const currentSelectedKeys = [...resolveSelectedKeys()]
          const songsToExportFilePaths = resolveSelectedFilePaths(currentSelectedKeys)

          const selectedKeySet = new Set(currentSelectedKeys)
          const songsToExportObjects =
            isMixtapeView() || isSetView()
              ? songsAreaState.songInfoArr.filter((item) => selectedKeySet.has(getRowKey(item)))
              : songsAreaState.songInfoArr.filter((item) =>
                  songsToExportFilePaths.includes(item.filePath)
                )

          if (songsToExportObjects.length === 0) return null

          const exportSummary = (await window.electron.ipcRenderer.invoke(
            'exportSongsToDir',
            folderPathVal,
            deleteSongsAfterExport,
            JSON.parse(JSON.stringify(songsToExportObjects))
          )) as ExportSongsToDirSummary | undefined
          if (deleteSongsAfterExport && songsToExportFilePaths.length > 0) {
            const removedPaths =
              Array.isArray(exportSummary?.removedPaths) && exportSummary.removedPaths.length > 0
                ? exportSummary.removedPaths
                : songsToExportFilePaths
            const removedSetItemIds =
              Array.isArray(exportSummary?.removedSetItemIds) &&
              exportSummary.removedSetItemIds.length > 0
                ? exportSummary.removedSetItemIds
                : songsToExportObjects
                    .map((item) => item.setItemId)
                    .filter((id): id is string => typeof id === 'string' && id.length > 0)
            if (isSetView() && removedSetItemIds.length > 0) {
              songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
                (key) => !removedSetItemIds.includes(key)
              )
              if (
                songsAreaState.songListUUID === runtime.playingData.playingSongListUUID &&
                runtime.playingData.playingSong?.setItemId &&
                removedSetItemIds.includes(runtime.playingData.playingSong.setItemId)
              ) {
                runtime.playingData.playingSong = null
              }
              emitter.emit('songsRemoved', {
                listUUID: songsAreaState.songListUUID,
                itemIds: removedSetItemIds
              })
              emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
              return { action: 'songsRemoved', itemIds: removedSetItemIds }
            }
            // 不直接修改显示列表，仅广播，由 songsArea.vue 统一处理 original + applyFiltersAndSorting
            if (isMixtapeView()) {
              songsAreaState.selectedSongFilePath.length = 0
            } else {
              songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
                (path) => !removedPaths.includes(path)
              )
            }
            if (songsAreaState.songListUUID === runtime.playingData.playingSongListUUID) {
              if (
                runtime.playingData.playingSong &&
                removedPaths.includes(runtime.playingData.playingSong.filePath)
              ) {
                runtime.playingData.playingSong = null
              }
            }
            emitter.emit('songsRemoved', {
              listUUID: songsAreaState.songListUUID,
              paths: removedPaths
            })
            emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
            return { action: 'songsRemoved', paths: removedPaths }
          }
        }
        break
      }
      case 'rekordboxXmlExport.menuExportSelectedTracks': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return null
        }
        const sourceLibraryName = resolveCoreLibraryName()
        if (!sourceLibraryName) {
          await confirm({
            title: t('rekordboxXmlExport.failureTitle'),
            content: [t('rekordboxXmlExport.unsupportedSource')],
            confirmShow: false
          })
          return null
        }
        const selectedSongs = resolveSelectedSongs()
        if (!selectedSongs.length) {
          await confirm({
            title: t('rekordboxXmlExport.failureTitle'),
            content: [t('rekordboxXmlExport.noTracksToExport')],
            confirmShow: false
          })
          return null
        }
        runtime.isProgressing = true
        try {
          const summary = await openRekordboxXmlExportForSelectedTracks({
            tracks: selectedSongs,
            sourceLibraryName,
            songListUUID: songsAreaState.songListUUID
          })
          if (summary && summary.mode === 'move' && summary.sourceFilePaths.length > 0) {
            const removedSetItemIds = Array.isArray(summary.removedSetItemIds)
              ? summary.removedSetItemIds
              : []
            if (isSetView() && removedSetItemIds.length > 0) {
              songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
                (item) => !removedSetItemIds.includes(item)
              )
              if (songsAreaState.songListUUID === runtime.playingData.playingSongListUUID) {
                if (
                  runtime.playingData.playingSong?.setItemId &&
                  removedSetItemIds.includes(runtime.playingData.playingSong.setItemId)
                ) {
                  runtime.playingData.playingSong = null
                }
              }
              emitter.emit('songsRemoved', {
                listUUID: songsAreaState.songListUUID,
                itemIds: removedSetItemIds
              })
              emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
              return { action: 'songsRemoved', itemIds: removedSetItemIds }
            }
            if (isMixtapeView()) {
              songsAreaState.selectedSongFilePath.length = 0
            } else {
              songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
                (item) => !summary.sourceFilePaths.includes(item)
              )
            }
            if (songsAreaState.songListUUID === runtime.playingData.playingSongListUUID) {
              if (
                runtime.playingData.playingSong &&
                summary.sourceFilePaths.includes(runtime.playingData.playingSong.filePath)
              ) {
                runtime.playingData.playingSong = null
              }
            }
            emitter.emit('songsRemoved', {
              listUUID: songsAreaState.songListUUID,
              paths: summary.sourceFilePaths
            })
            emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
            return { action: 'songsRemoved', paths: summary.sourceFilePaths }
          }
        } finally {
          runtime.isProgressing = false
        }
        break
      }
      case 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return null
        }
        const selectedSongs = resolveSelectedSongs()
        if (!selectedSongs.length) {
          await confirm({
            title: t('rekordboxDesktop.failureTitle'),
            content: [t('rekordboxDesktop.noTracksToImport')],
            confirmShow: false
          })
          return null
        }
        runtime.isProgressing = true
        try {
          const summary = await openRekordboxDesktopPlaylistForSelectedTracks({
            tracks: selectedSongs,
            songListUUID: songsAreaState.songListUUID,
            deletePayload: {
              songListPath: isExternalView
                ? undefined
                : libraryUtils.findDirPathByUuid(songsAreaState.songListUUID),
              sourceType: isExternalView ? 'external' : undefined
            }
          })
          if (summary?.removedSetItemIds?.length) {
            const removedSetItemIds = summary.removedSetItemIds
            songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
              (item) => !removedSetItemIds.includes(item)
            )
            if (songsAreaState.songListUUID === runtime.playingData.playingSongListUUID) {
              if (
                runtime.playingData.playingSong?.setItemId &&
                removedSetItemIds.includes(runtime.playingData.playingSong.setItemId)
              ) {
                runtime.playingData.playingSong = null
              }
            }
            emitter.emit('songsRemoved', {
              listUUID: songsAreaState.songListUUID,
              itemIds: removedSetItemIds
            })
            emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
            return { action: 'songsRemoved', itemIds: removedSetItemIds }
          }
          if (summary?.removedSourceFilePaths?.length) {
            if (isMixtapeView()) {
              songsAreaState.selectedSongFilePath.length = 0
            } else {
              songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
                (item) => !summary.removedSourceFilePaths?.includes(item)
              )
            }
            if (songsAreaState.songListUUID === runtime.playingData.playingSongListUUID) {
              if (
                runtime.playingData.playingSong &&
                summary.removedSourceFilePaths.includes(runtime.playingData.playingSong.filePath)
              ) {
                runtime.playingData.playingSong = null
              }
            }
            emitter.emit('songsRemoved', {
              listUUID: songsAreaState.songListUUID,
              paths: summary.removedSourceFilePaths
            })
            emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
            return { action: 'songsRemoved', paths: summary.removedSourceFilePaths }
          }
        } finally {
          runtime.isProgressing = false
        }
        break
      }
      case 'tracks.showInFileExplorer':
        window.electron.ipcRenderer.send('show-item-in-folder', song.filePath)
        break
      case 'tracks.neteaseSearchTitle': {
        const title = normalizeNeteaseSearchText(song.title)
        if (!title) {
          await showNeteaseSearchEmptyHint('tracks.neteaseSearchTitleEmpty')
          break
        }
        await openSongNeteaseSearch(title)
        break
      }
      case 'tracks.neteaseSearchArtist': {
        const artist = normalizeNeteaseSearchText(song.artist)
        if (!artist) {
          await showNeteaseSearchEmptyHint('tracks.neteaseSearchArtistEmpty')
          break
        }
        await openSongNeteaseSearch(artist)
        break
      }
      case 'tracks.neteaseSearchAlbum': {
        const album = normalizeNeteaseSearchText(song.album)
        if (!album) {
          await showNeteaseSearchEmptyHint('tracks.neteaseSearchAlbumEmpty')
          break
        }
        await openSongNeteaseSearch(album)
        break
      }
      case 'tracks.neteaseSearchTitleArtist': {
        const title = normalizeNeteaseSearchText(song.title)
        const artist = normalizeNeteaseSearchText(song.artist)
        if (!title && !artist) {
          await showNeteaseSearchEmptyHint('tracks.neteaseSearchTitleArtistEmpty')
          break
        }
        await openSongNeteaseSearch(buildNeteaseSearchQuery(title, artist))
        break
      }
      case 'tracks.clearTrackCache': {
        const files = resolveSelectedFilePaths()
        await promptAndStartTrackReanalysis(files, resolveSelectedSongs())
        break
      }
    }
    return null // Default return if no dialog action
  }

  return {
    showAndHandleSongContextMenu
    // menuArr is not returned as it's internal to the composable now
  }
}
