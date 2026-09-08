import { ref, type Ref } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import scanNewSongDialog from '@renderer/components/scanNewSongDialog'
import exportDialog from '@renderer/components/exportDialog'
import {
  openRekordboxDesktopPlaylistForPlaylist,
  openRekordboxDesktopPlaylistForSelectedTracks
} from '@renderer/utils/rekordboxDesktopPlaylist'
import { t } from '@renderer/utils/translate'
import libraryUtils from '@renderer/utils/libraryUtils'
import { DEFAULT_MIXTAPE_STEM_PROFILE } from '@shared/mixtapeStemProfiles'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import { setPendingMixtapeProjectMode } from '@renderer/composables/mixtape/stemMode'
import { startAudioConvertFromFiles } from '@renderer/utils/audioConvertActions'
import { appendOrderedTracksToMixtape } from '@renderer/utils/mixtapePlaylistAppend'
import {
  promptAndQueueManualKeyAnalysisBatch,
  scanSongListsForMissingAnalysisFiles
} from '@renderer/utils/manualKeyAnalysis'
import { promptAndStartTrackReanalysis } from '@renderer/utils/trackReanalysis'
import {
  clearSongsAreaPaneBySongListUUID,
  showSongListInPane
} from '@renderer/utils/songsAreaSplit'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import {
  buildLibraryContextMenuArr,
  collectFilesForCurrentTrackOperation as collectFilesForLibraryContextOperation,
  collectSetListUuids,
  collectSetPlaylistMissingAnalysisFiles,
  collectSetPlaylistTracksForBatchRename,
  collectSongListTargets,
  collectSongListUuids,
  collectOrderedSongsForMixtape,
  collectSongsForSimilarBatch,
  loadSetPlaylistSongs,
  scanSongListsForSongs,
  scanSongListsForFiles,
  uniqueFilePaths
} from './libraryContextMenuHelpers'
import { handleRekordboxXmlPlaylistExport } from './handleRekordboxXmlPlaylistExport'
import type { IDir, IMenu, IMetadataAutoFillSummary } from '../../../../types/globals'
import { isWindowsPathPlatform, normalizeFilePathForComparison } from '@shared/filePathComparison'

type ExportSongsToDirSummary = {
  removedPaths?: string[]
  removedSetItemIds?: string[]
}

type PlaylistDedupSummary = {
  removedFilePaths?: string[]
  fingerprintMode?: 'pcm' | 'file'
  analyzeFailedCount?: number
  scannedCount?: number
}

type LibraryItemEmitter = {
  emit: (event: string, payload?: unknown) => void
}

interface UseLibraryContextMenuOptions {
  dirDataRef: Ref<IDir | null>
  fatherDirDataRef: Ref<IDir | null>
  runtime: ReturnType<typeof useRuntimeStore>
  props: { uuid: string; libraryName: string }
  emitter: LibraryItemEmitter
  dirChildRendered: { value: boolean }
  dirChildShow: { value: boolean }
  trackCount: { value: number | null }
  warnAcoustIdMissing: () => void
  startRename: () => Promise<void> | void
}

export function useLibraryContextMenu({
  dirDataRef,
  fatherDirDataRef,
  runtime,
  props,
  emitter,
  dirChildRendered,
  dirChildShow,
  trackCount,
  warnAcoustIdMissing,
  startRename
}: UseLibraryContextMenuOptions) {
  const getErrorMessage = (error: unknown) =>
    error instanceof Error && error.message.trim() ? error.message : t('common.unknownError')
  const getDirData = () => dirDataRef.value
  const getFatherDirData = () => fatherDirDataRef.value

  const getOperateUuids = (): string[] => {
    if (runtime.selectedPlaylistIds.includes(props.uuid)) {
      return runtime.selectedPlaylistIds
    }
    return [props.uuid]
  }

  const collectFilesForCurrentTrackOperation = async (operateUuids = getOperateUuids()) => {
    return collectFilesForLibraryContextOperation(operateUuids)
  }

  const rightClickMenuShow = ref(false)
  const buildMenuArr = (): IMenu[][] =>
    buildLibraryContextMenuArr({
      dirData: getDirData(),
      libraryAreaSelected: runtime.libraryAreaSelected,
      libraryName: props.libraryName,
      creatingSongListUUID: runtime.creatingSongListUUID
    })

  const menuArr = ref<IMenu[][]>(buildMenuArr())

  const deleteDir = async () => {
    if (runtime.isProgressing) {
      await confirmTaskBusy()
      return
    }
    const dirData = getDirData()
    const fatherDirData = getFatherDirData()
    if (!dirData || !fatherDirData) return
    runtime.isProgressing = true
    try {
      if (dirData?.type === 'mixtapeList') {
        const allowed = await libraryUtils.ensureMixtapeDeleteAllowed(props.uuid)
        if (!allowed) return
      }
      const libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
      if (libraryTree === null) {
        throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
      }
      const uuids = libraryUtils.getAllUuids(libraryTree)
      for (const pane of ['single', 'left', 'right'] as const) {
        const paneSongListUUID = runtime.songsAreaPanels.panes[pane].songListUUID
        if (uuids.indexOf(paneSongListUUID) !== -1) {
          runtime.clearSongsAreaPaneState(pane)
        }
      }
      if (uuids.indexOf(runtime.playingData.playingSongListUUID) !== -1) {
        runtime.playingData.playingSongListUUID = ''
        runtime.playingData.playingSongListData = []
        runtime.playingData.playingSong = null
      }
      if (!Array.isArray(fatherDirData.children)) {
        throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
      }
      let deleteIndex: number | undefined
      for (const index in fatherDirData.children) {
        if (fatherDirData.children[index]?.uuid === dirData.uuid) {
          deleteIndex = Number(index)
          continue
        }
        if (fatherDirData.children[index].order && dirData.order) {
          if (fatherDirData.children[index].order > dirData.order) {
            fatherDirData.children[index].order--
          }
        }
      }
      if (deleteIndex !== undefined) {
        fatherDirData.children.splice(deleteIndex, 1)
      }
      await libraryUtils.diffLibraryTreeExecuteFileOperation()
    } finally {
      runtime.isProgressing = false
    }
  }

  const deleteDirs = async (uuids: string[]) => {
    if (runtime.isProgressing) {
      await confirmTaskBusy()
      return
    }
    // 过滤掉祖先也在删除列表中的 UUID，避免父子节点重复处理
    const uuidSet = new Set(uuids)
    uuids = uuids.filter((uuid) => {
      let parent = libraryUtils.getFatherLibraryTreeByUUID(uuid)
      while (parent) {
        if (uuidSet.has(parent.uuid)) return false
        parent = libraryUtils.getFatherLibraryTreeByUUID(parent.uuid)
      }
      return true
    })
    for (const uuid of uuids) {
      const node = libraryUtils.getLibraryTreeByUUID(uuid)
      if (!node) continue
      if (node.type === 'mixtapeList') {
        const allowed = await libraryUtils.ensureMixtapeDeleteAllowed(uuid)
        if (!allowed) return
      }
    }
    runtime.isProgressing = true
    try {
      for (const uuid of uuids) {
        const node = libraryUtils.getLibraryTreeByUUID(uuid)
        if (!node) continue
        const childUuids = libraryUtils.getAllUuids(node)
        for (const pane of ['single', 'left', 'right'] as const) {
          if (childUuids.includes(runtime.songsAreaPanels.panes[pane].songListUUID)) {
            runtime.clearSongsAreaPaneState(pane)
          }
        }
        if (childUuids.includes(runtime.playingData.playingSongListUUID)) {
          runtime.playingData.playingSongListUUID = ''
          runtime.playingData.playingSongListData = []
          runtime.playingData.playingSong = null
        }
      }

      const entries: Array<{ parent: IDir; index: number; order?: number }> = []
      for (const uuid of uuids) {
        const parent = libraryUtils.getFatherLibraryTreeByUUID(uuid)
        if (!parent?.children) continue
        const index = parent.children.findIndex((c) => c.uuid === uuid)
        if (index !== -1) {
          entries.push({ parent, index, order: parent.children[index].order })
        }
      }

      entries.sort((a, b) => b.index - a.index)
      for (const { parent, index, order } of entries) {
        if (order !== undefined) {
          for (const sibling of parent.children!) {
            if (sibling.order !== undefined && sibling.order > order) {
              sibling.order--
            }
          }
        }
        parent.children!.splice(index, 1)
      }
      await libraryUtils.diffLibraryTreeExecuteFileOperation()
    } finally {
      runtime.isProgressing = false
    }
  }

  const confirmTaskBusy = async () => {
    await confirm({
      title: t('dialog.hint'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
  }

  const contextmenuEvent = async (event: MouseEvent) => {
    const dirData = getDirData()
    if (!dirData) return
    const shouldSkipPathCheck =
      dirData.dirName === '' || runtime.creatingSongListUUID === props.uuid
    if (!shouldSkipPathCheck) {
      const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
      const isSongListPathExist = await window.electron.ipcRenderer.invoke(
        'dirPathExists',
        songListPath
      )
      if (!isSongListPathExist) {
        await confirm({
          title: t('common.error'),
          content: [t('library.notExistOnDisk')],
          confirmShow: false
        })
        await deleteDir()
        return
      }
    }
    menuArr.value = buildMenuArr()
    if (!menuArr.value.length) return
    rightClickMenuShow.value = true
    const result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
    rightClickMenuShow.value = false
    if (result === 'cancel') return

    switch (result.menuName) {
      case 'library.createPlaylist': {
        const currentDirData = getDirData()
        if (!currentDirData) break
        dirChildRendered.value = true
        dirChildShow.value = true
        const newUuid = uuidV4()
        currentDirData.children = currentDirData.children || []
        currentDirData.children.unshift({
          uuid: newUuid,
          dirName: '',
          type: 'songList'
        })
        break
      }
      case 'library.createStemMixtape':
      case 'library.createEqMixtape': {
        const currentDirData = getDirData()
        if (!currentDirData) break
        const mixMode = result.menuName === 'library.createEqMixtape' ? 'eq' : 'stem'
        dirChildRendered.value = true
        dirChildShow.value = true
        const newUuid = uuidV4()
        currentDirData.children = currentDirData.children || []
        currentDirData.children.unshift({
          uuid: newUuid,
          dirName: '',
          type: 'mixtapeList',
          mixMode,
          stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE
        })
        setPendingMixtapeProjectMode(newUuid, {
          mixMode,
          stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE
        })
        break
      }
      case 'library.createSetPlaylist': {
        const currentDirData = getDirData()
        if (!currentDirData) break
        dirChildRendered.value = true
        dirChildShow.value = true
        currentDirData.children = currentDirData.children || []
        currentDirData.children.unshift({
          uuid: uuidV4(),
          dirName: '',
          type: 'setList'
        })
        break
      }
      case 'library.createSetFolder': {
        const currentDirData = getDirData()
        if (!currentDirData) break
        dirChildRendered.value = true
        dirChildShow.value = true
        currentDirData.children = currentDirData.children || []
        currentDirData.children.unshift({
          uuid: uuidV4(),
          dirName: '',
          type: 'dir'
        })
        break
      }
      case 'library.createFolder': {
        const currentDirData = getDirData()
        if (!currentDirData) break
        dirChildRendered.value = true
        dirChildShow.value = true
        currentDirData.children = currentDirData.children || []
        currentDirData.children.unshift({
          uuid: uuidV4(),
          dirName: '',
          type: 'dir'
        })
        break
      }
      case 'common.rename': {
        await startRename()
        break
      }
      case 'common.delete':
      case 'playlist.deletePlaylist': {
        const operateUuids = getOperateUuids()
        if (operateUuids.length === 1) {
          await deleteDir()
        } else {
          await deleteDirs(operateUuids)
        }
        break
      }
      case 'playlist.emptyPlaylist': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        const setListUuids = getOperateUuids().filter(
          (uuid) => libraryUtils.getLibraryTreeByUUID(uuid)?.type === 'setList'
        )
        if (setListUuids.length > 0) {
          runtime.isProgressing = true
          try {
            for (const uuid of setListUuids) {
              await window.electron.ipcRenderer.invoke('setList:clear-playlist', uuid)
              for (const pane of ['single', 'left', 'right'] as const) {
                const paneState = runtime.songsAreaPanels.panes[pane]
                if (paneState.songListUUID === uuid) {
                  paneState.selectedSongFilePath.length = 0
                  paneState.songInfoArr = []
                  paneState.totalSongCount = 0
                }
              }
              if (runtime.playingData.playingSongListUUID === uuid) {
                runtime.playingData.playingSongListUUID = ''
                runtime.playingData.playingSongListData = []
                runtime.playingData.playingSong = null
              }
            }
            emitter.emit('playlistContentChanged', { uuids: setListUuids })
          } finally {
            runtime.isProgressing = false
          }
          break
        }
        const operateUuids = collectSongListUuids(getOperateUuids())
        if (!operateUuids.length) break
        runtime.isProgressing = true
        try {
          for (const uuid of operateUuids) {
            const dirPath = libraryUtils.findDirPathByUuid(uuid)
            await window.electron.ipcRenderer.invoke('emptyDir', dirPath)
            for (const pane of ['single', 'left', 'right'] as const) {
              const paneState = runtime.songsAreaPanels.panes[pane]
              if (paneState.songListUUID === uuid) {
                paneState.selectedSongFilePath.length = 0
                paneState.songInfoArr = []
                paneState.totalSongCount = 0
              }
            }
            if (runtime.playingData.playingSongListUUID === uuid) {
              runtime.playingData.playingSongListData = []
              runtime.playingData.playingSong = null
            }
          }
          try {
            emitter.emit('playlistContentChanged', { uuids: operateUuids })
          } catch {}
        } finally {
          runtime.isProgressing = false
        }
        break
      }
      case 'playlist.showInLeftPane': {
        showSongListInPane(runtime, 'left', props.uuid)
        break
      }
      case 'playlist.showInRightPane': {
        showSongListInPane(runtime, 'right', props.uuid)
        break
      }
      case 'tracks.importTracks': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        await scanNewSongDialog({ libraryName: props.libraryName, songListUuid: props.uuid })
        break
      }
      case 'library.addToMixtape': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        const entries = await collectOrderedSongsForMixtape(getOperateUuids())
        await appendOrderedTracksToMixtape({ entries })
        break
      }
      case 'tracks.exportTracks': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        const dialogResult = await exportDialog({ title: 'tracks.title' })
        if (dialogResult !== 'cancel') {
          const operateUuids = getOperateUuids()
          const setListUuids = collectSetListUuids(operateUuids)
          const setExportItems: Array<{ filePath: string; setItemId?: string }> = []
          const setItemPlaylistUuid = new Map<string, string>()
          for (const uuid of setListUuids) {
            const songs = await loadSetPlaylistSongs(uuid)
            for (const song of songs) {
              if (song.fileMissing || !song.filePath) continue
              const setItemId = String(song.setItemId || '').trim()
              if (setItemId) {
                setItemPlaylistUuid.set(setItemId, uuid)
              }
              setExportItems.push({
                filePath: song.filePath,
                setItemId: setItemId || undefined
              })
            }
          }
          if (setExportItems.length > 0) {
            const exportSummary = (await window.electron.ipcRenderer.invoke(
              'exportSongsToDir',
              dialogResult.folderPathVal,
              dialogResult.deleteSongsAfterExport,
              setExportItems
            )) as ExportSongsToDirSummary | undefined
            if (dialogResult.deleteSongsAfterExport) {
              const removedSetItemIds =
                Array.isArray(exportSummary?.removedSetItemIds) &&
                exportSummary.removedSetItemIds.length > 0
                  ? exportSummary.removedSetItemIds
                  : setExportItems
                      .map((item) => item.setItemId)
                      .filter((id): id is string => typeof id === 'string' && id.length > 0)
              const removedByUuid = new Map<string, string[]>()
              for (const itemId of removedSetItemIds) {
                const uuid = setItemPlaylistUuid.get(itemId)
                if (!uuid) continue
                const list = removedByUuid.get(uuid) || []
                list.push(itemId)
                removedByUuid.set(uuid, list)
              }
              for (const [uuid, itemIds] of removedByUuid.entries()) {
                emitter.emit('songsRemoved', {
                  listUUID: uuid,
                  itemIds
                })
                if (
                  runtime.playingData.playingSongListUUID === uuid &&
                  runtime.playingData.playingSong?.setItemId &&
                  itemIds.includes(runtime.playingData.playingSong.setItemId)
                ) {
                  runtime.playingData.playingSong = null
                }
              }
              if (runtime.setting.showPlaylistTrackCount && removedByUuid.has(props.uuid)) {
                trackCount.value = Math.max(
                  0,
                  Number(trackCount.value || 0) - (removedByUuid.get(props.uuid)?.length || 0)
                )
              }
              if (removedByUuid.size > 0) {
                try {
                  emitter.emit('playlistContentChanged', { uuids: [...removedByUuid.keys()] })
                } catch {}
              }
            }
          }

          const songListUuids = collectSongListUuids(operateUuids)
          for (const uuid of songListUuids) {
            const dirPath = libraryUtils.findDirPathByUuid(uuid)
            await window.electron.ipcRenderer.invoke(
              'exportSongListToDir',
              dialogResult.folderPathVal,
              dialogResult.deleteSongsAfterExport,
              dirPath
            )
            if (dialogResult.deleteSongsAfterExport) {
              clearSongsAreaPaneBySongListUUID(runtime, uuid)
              if (runtime.playingData.playingSongListUUID === uuid) {
                runtime.playingData.playingSongListUUID = ''
                runtime.playingData.playingSongListData = []
                runtime.playingData.playingSong = null
              }
              emitter.emit('playlistContentChanged', { uuids: [uuid] })
            }
          }
        }
        break
      }
      case 'rekordboxXmlExport.menuExportPlaylist': {
        await handleRekordboxXmlPlaylistExport({
          getDirData,
          runtime,
          props,
          emitter,
          trackCount,
          confirmTaskBusy
        })
        break
      }
      case 'rekordboxDesktop.menuCreatePlaylistFromPlaylist': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        const currentDirData = getDirData()
        const playlistName = String(currentDirData?.dirName || '').trim()
        if (currentDirData?.type === 'setList' || props.libraryName === 'SetLibrary') {
          runtime.isProgressing = true
          try {
            const tracks = await loadSetPlaylistSongs(props.uuid)
            if (!tracks.length) {
              await confirm({
                title: t('rekordboxDesktop.failureTitle'),
                content: [t('rekordboxDesktop.noTracksToImport')],
                confirmShow: false
              })
              return
            }
            const summary = await openRekordboxDesktopPlaylistForSelectedTracks({
              tracks,
              songListUUID: props.uuid,
              playlistName
            })
            if (summary?.removedSetItemIds?.length) {
              const removedSetItemIds = summary.removedSetItemIds
              emitter.emit('songsRemoved', {
                listUUID: props.uuid,
                itemIds: removedSetItemIds
              })
              if (runtime.playingData.playingSongListUUID === props.uuid) {
                const removedIdSet = new Set(removedSetItemIds)
                runtime.playingData.playingSongListData =
                  runtime.playingData.playingSongListData.filter(
                    (item) => !removedIdSet.has(item.setItemId || '')
                  )
                if (
                  runtime.playingData.playingSong?.setItemId &&
                  removedIdSet.has(runtime.playingData.playingSong.setItemId)
                ) {
                  runtime.playingData.playingSong = null
                }
              }
              if (runtime.setting.showPlaylistTrackCount) {
                trackCount.value = Math.max(
                  0,
                  Number(trackCount.value || 0) - removedSetItemIds.length
                )
              }
              try {
                emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
              } catch {}
            }
          } finally {
            runtime.isProgressing = false
          }
          break
        }
        const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
        runtime.isProgressing = true
        try {
          const summary = await openRekordboxDesktopPlaylistForPlaylist({
            songListUUID: props.uuid,
            songListPath,
            playlistName,
            deletePayload: {
              songListPath
            }
          })
          if (summary?.removedSourceFilePaths?.length) {
            const removedAll = summary.removedSourceFilePaths.length >= summary.trackCount
            if (!removedAll) {
              try {
                emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
              } catch {}
              break
            }
            clearSongsAreaPaneBySongListUUID(runtime, props.uuid)
            if (runtime.playingData.playingSongListUUID === props.uuid) {
              runtime.playingData.playingSongListUUID = ''
              runtime.playingData.playingSongListData = []
              runtime.playingData.playingSong = null
            }
            if (runtime.setting.showPlaylistTrackCount) {
              trackCount.value = 0
            }
            try {
              emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
            } catch {}
          }
        } finally {
          runtime.isProgressing = false
        }
        break
      }
      case 'playlist.autoMix': {
        const currentDirData = getDirData()
        if (currentDirData?.type !== 'mixtapeList') break
        const playlistPath = libraryUtils.findDirPathByUuid(props.uuid)
        window.electron.ipcRenderer.send('mixtape:open', {
          playlistId: props.uuid,
          playlistPath,
          playlistName: currentDirData?.dirName
        })
        break
      }
      case 'playlist.calculateSetDuration': {
        const currentDirData = getDirData()
        if (currentDirData?.type !== 'setList' && currentDirData?.type !== 'songList') break
        const songs =
          currentDirData.type === 'setList'
            ? await loadSetPlaylistSongs(props.uuid)
            : await scanSongListsForSongs([props.uuid])
        const { default: openSetDurationDialog } =
          await import('@renderer/components/setDurationDialog')
        await openSetDurationDialog(songs)
        break
      }
      case 'tracks.showInFileExplorer': {
        const operateUuids = getOperateUuids()
        for (const uuid of operateUuids) {
          window.electron.ipcRenderer.send('openFileExplorer', libraryUtils.findDirPathByUuid(uuid))
        }
        break
      }
      case 'metadata.autoFillMenu': {
        const operateUuids = getOperateUuids()
        const refreshUuids = [
          ...collectSongListUuids(operateUuids),
          ...collectSetListUuids(operateUuids)
        ]
        if (!refreshUuids.length) break
        const files = await collectFilesForCurrentTrackOperation(operateUuids)
        if (!files.length) {
          await confirm({
            title: t('dialog.hint'),
            content: [t('metadata.autoFillNoEligible')],
            confirmShow: false
          })
          return
        }
        warnAcoustIdMissing()
        runtime.isProgressing = true
        let summary: IMetadataAutoFillSummary | null = null
        let hadError = false
        try {
          summary = await invokeMetadataAutoFill(files)
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
          return
        }
        const { default: openAutoSummary } =
          await import('@renderer/components/autoMetadataSummaryDialog')
        await openAutoSummary(summary)
        const updates =
          summary.items
            ?.filter((item) => item.status === 'applied' && item.updatedSongInfo)
            .map((item) => ({
              song: item.updatedSongInfo,
              oldFilePath: item.oldFilePath
            })) || []
        if (updates.length) {
          try {
            emitter.emit('metadataBatchUpdated', { updates })
          } catch {}
        }
        try {
          emitter.emit('playlistContentChanged', { uuids: refreshUuids })
        } catch {}
        break
      }
      case 'playlist.batchRename': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        const operateUuids = getOperateUuids()
        const seen = new Set<string>()
        const songLists: Array<{ uuid: string; path: string; name: string }> = []
        const setListUuids = collectSetListUuids(operateUuids)
        for (const uuid of operateUuids) {
          const node = libraryUtils.getLibraryTreeByUUID(uuid)
          if (!node) continue
          if (node.type === 'songList') {
            if (!seen.has(node.uuid)) {
              seen.add(node.uuid)
              songLists.push({
                uuid: node.uuid,
                path: libraryUtils.findDirPathByUuid(node.uuid),
                name: node.dirName
              })
            }
          } else {
            for (const target of collectSongListTargets(node)) {
              if (!seen.has(target.uuid)) {
                seen.add(target.uuid)
                songLists.push(target)
              }
            }
          }
        }
        const setTracks = setListUuids.length
          ? await collectSetPlaylistTracksForBatchRename(setListUuids)
          : []
        if (!songLists.length && !setTracks.length) {
          await confirm({
            title: t('dialog.hint'),
            content: [t('batchRename.noEligibleTracks')],
            confirmShow: false
          })
          return
        }
        const { default: openPlaylistBatchRenameDialog } =
          await import('@renderer/components/playlistBatchRename')
        await openPlaylistBatchRenameDialog({
          title: t('batchRename.dialogTitle'),
          songLists,
          tracks: setTracks
        })
        break
      }
      case 'tracks.convertFormat': {
        try {
          const files = await collectFilesForCurrentTrackOperation()
          await startAudioConvertFromFiles({
            files,
            allowedSourceExts: runtime.setting.audioExt,
            songListUUID: props.uuid
          })
        } catch {}
        break
      }
      case 'tracks.convertNonMp3ToMp3': {
        try {
          const files = await collectFilesForCurrentTrackOperation()
          const result = await startAudioConvertFromFiles({
            files,
            allowedSourceExts: runtime.setting.audioExt,
            songListUUID: props.uuid,
            presetTargetFormat: 'mp3',
            lockTargetFormat: true,
            excludeSameFormatAsTarget: true,
            skipExistingTargetCopies: true
          })
          if (result.status === 'no-files') {
            await confirm({
              title: t('dialog.hint'),
              content: [t('convert.noNonMp3Files')],
              confirmShow: false
            })
          }
        } catch {}
        break
      }
      case 'similarTracks.menu': {
        const seeds = await collectSongsForSimilarBatch(getOperateUuids())
        if (!seeds.length) {
          await confirm({
            title: t('dialog.hint'),
            content: [t('similarTracks.batchNoSeeds')],
            confirmShow: false
          })
          return
        }
        const { default: openBatchSimilarTracksDialog } =
          await import('@renderer/components/batchSimilarTracksDialog')
        await openBatchSimilarTracksDialog(seeds)
        break
      }
      case 'fingerprints.analyzeAndAdd': {
        const operateUuids = collectSongListUuids(getOperateUuids())
        if (!operateUuids.length) break
        const files = await scanSongListsForFiles(operateUuids)
        if (!files.length) {
          await confirm({
            title: t('dialog.hint'),
            content: [t('fingerprints.noEligibleTracks')],
            confirmShow: false
          })
          return
        }
        await analyzeFingerprintsForPaths(files, { origin: 'playlist' })
        break
      }
      case 'playlist.fingerprintDeduplicate': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        const confirmResult = await confirm({
          title: t('playlist.deduplicateConfirmTitle'),
          content: [t('playlist.deduplicateConfirm')]
        })
        if (confirmResult !== 'confirm') {
          return
        }
        const operateUuids = collectSongListUuids(getOperateUuids())
        if (!operateUuids.length) break
        runtime.isProgressing = true
        const normalizePath = (p: string | undefined | null) =>
          normalizeFilePathForComparison(
            p,
            isWindowsPathPlatform(runtime.setting.platform || runtime.platform)
          )
        try {
          let totalRemoved = 0
          let totalScanned = 0
          let totalAnalyzeFailed = 0
          let fingerprintMode: string | undefined
          for (const uuid of operateUuids) {
            const songListPath = libraryUtils.findDirPathByUuid(uuid)
            const progressId = `playlist_dedup_${Date.now()}_${uuid}`
            const summary = (await window.electron.ipcRenderer.invoke(
              'deduplicateSongListByFingerprint',
              {
                songListPath,
                progressId
              }
            )) as PlaylistDedupSummary
            const removedRaw: string[] = Array.isArray(summary?.removedFilePaths)
              ? summary.removedFilePaths.filter(Boolean)
              : []
            const removedNormalized = removedRaw.map((p) => normalizePath(p)).filter(Boolean)
            if (removedNormalized.length > 0) {
              emitter.emit('songsRemoved', { listUUID: uuid, paths: removedNormalized })
            }
            try {
              emitter.emit('playlistContentChanged', { uuids: [uuid] })
            } catch {}
            totalRemoved += removedRaw.length
            totalScanned += summary?.scannedCount || 0
            totalAnalyzeFailed += summary?.analyzeFailedCount || 0
            if (summary?.fingerprintMode) {
              fingerprintMode = summary.fingerprintMode
            }
          }
          const modeLabel =
            fingerprintMode === 'file' ? t('fingerprints.modeFile') : t('fingerprints.modePCM')
          const feedbackLines = [
            t('playlist.deduplicateRemovedCount', { n: totalRemoved }),
            t('playlist.deduplicateModeUsed', { mode: modeLabel })
          ]
          if (totalAnalyzeFailed) {
            feedbackLines.push(t('import.analysisFailedCount', { count: totalAnalyzeFailed }))
          }
          if (totalScanned) {
            feedbackLines.unshift(t('playlist.deduplicateScannedCount', { n: totalScanned }))
          }
          await confirm({
            title: t('playlist.deduplicateFinished'),
            content: feedbackLines,
            confirmShow: false
          })
        } catch (error: unknown) {
          await confirm({
            title: t('common.error'),
            content: [getErrorMessage(error)],
            confirmShow: false
          })
        } finally {
          runtime.isProgressing = false
        }
        break
      }
      case 'recycleBin.permanentlyDelete': {
        const res = await confirm({
          title: t('common.delete'),
          content: [t('tracks.confirmDelete'), t('tracks.deleteHint')]
        })
        if (res === 'confirm') {
          const recycleBin = runtime.libraryTree.children?.find(
            (item) => item.dirName === 'RecycleBin'
          )
          const index = recycleBin?.children?.findIndex((item) => item.uuid === props.uuid)
          if (index !== undefined && index !== -1 && recycleBin?.children) {
            recycleBin.children.splice(index, 1)
          }
          if (runtime.playingData.playingSongListUUID === props.uuid) {
            runtime.playingData.playingSongListUUID = ''
            runtime.playingData.playingSongListData = []
            runtime.playingData.playingSong = null
          }
          clearSongsAreaPaneBySongListUUID(runtime, props.uuid)
          await libraryUtils.diffLibraryTreeExecuteFileOperation()
        }
        break
      }
      case 'tracks.analyzeMissingTracks': {
        const operateUuids = getOperateUuids()
        const songListUuids = collectSongListUuids(operateUuids)
        const setListUuids = collectSetListUuids(operateUuids)
        if (!songListUuids.length && !setListUuids.length) break
        const requiresRuntimeAnalysis = runtime.analysisRuntime.available === true
        const [songListFiles, setListFiles] = await Promise.all([
          songListUuids.length
            ? scanSongListsForMissingAnalysisFiles(songListUuids, requiresRuntimeAnalysis, {
                includeSongStructure: true
              })
            : Promise.resolve([]),
          setListUuids.length
            ? collectSetPlaylistMissingAnalysisFiles(setListUuids, requiresRuntimeAnalysis)
            : Promise.resolve([])
        ])
        const files = uniqueFilePaths([...songListFiles, ...setListFiles])
        if (!files.length) {
          await confirm({
            title: t('dialog.hint'),
            content: [t('tracks.noMissingAnalysisTracks')],
            confirmShow: false
          })
          return
        }
        await promptAndQueueManualKeyAnalysisBatch(files, 'tracks.analyzingMissingTracks')
        break
      }
      case 'tracks.reanalyzePlaylist': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        const operateUuids = getOperateUuids()
        const refreshUuids = [
          ...collectSongListUuids(operateUuids),
          ...collectSetListUuids(operateUuids)
        ]
        if (!refreshUuids.length) break
        const files = uniqueFilePaths(await collectFilesForCurrentTrackOperation(operateUuids))
        if (!files.length) {
          await confirm({
            title: t('dialog.hint'),
            content: [t('metadata.autoFillNoEligible')],
            confirmShow: false
          })
          return
        }
        const songs = await collectSongsForSimilarBatch(operateUuids)
        const result = await promptAndStartTrackReanalysis(files, songs)
        if (result?.canceled) return
        try {
          emitter.emit('playlistContentChanged', { uuids: refreshUuids })
        } catch {}
        break
      }
    }
  }

  return {
    rightClickMenuShow,
    menuArr,
    contextmenuEvent,
    deleteDir
  }
}
