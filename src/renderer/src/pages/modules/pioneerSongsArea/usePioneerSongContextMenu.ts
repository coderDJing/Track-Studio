import type { ComputedRef, Ref } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import exportDialog from '@renderer/components/exportDialog'
import confirm from '@renderer/components/confirmDialog'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { openRekordboxDesktopPlaylistForSelectedTracks } from '@renderer/utils/rekordboxDesktopPlaylist'
import {
  createMusicSearchMenuItems,
  getMusicSearchOpenFailedMessageKey,
  openMusicSearch,
  resolveMusicSearchMenuAction
} from '@renderer/utils/musicSearch'
import { t } from '@renderer/utils/translate'
import { promptAndStartTrackReanalysis } from '@renderer/utils/trackReanalysis'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { IMenu, ISongInfo } from '../../../../../types/globals'
import type { PioneerTransferTarget } from './usePioneerTrackCopyDialog'

type ExistingOperationTracksResult = {
  updatedTracks: ISongInfo[]
  missingTracks: ISongInfo[]
  existingTracks: ISongInfo[]
}

type UsePioneerSongContextMenuParams = {
  runtime: ReturnType<typeof useRuntimeStore>
  selectedRowKeys: Ref<string[]>
  playlistMutationPending: Ref<boolean>
  canRemoveTracksFromDesktopPlaylist: ComputedRef<boolean>
  currentPlaybackListKey: ComputedRef<string>
  cancelPendingRepeatSingleClickDeselect: () => void
  resolveSelectedTracks: (fallback?: ISongInfo) => ISongInfo[]
  resolveExistingOperationTracks: (tracks: ISongInfo[]) => Promise<ExistingOperationTracksResult>
  showFileMissingHint: (missingTracks: ISongInfo[]) => Promise<void>
  openCopyTargetDialog: (libraryName: PioneerTransferTarget, tracks?: ISongInfo[]) => void
  removeTracksFromDesktopPlaylist: (selectedTracks: ISongInfo[], enabled: boolean) => Promise<void>
}

const buildPioneerSongMenuGroups = (canRemoveTracksFromDesktopPlaylist: boolean): IMenu[][] => {
  const groups: IMenu[][] = []
  if (canRemoveTracksFromDesktopPlaylist) {
    groups.push([{ menuName: 'rekordboxDesktop.removeTracksFromPlaylistAction' }])
  }
  groups.push([{ menuName: 'tracks.exportTracksCopyOnly' }])
  groups.push([{ menuName: 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks' }])
  groups.push([
    { menuName: 'library.copyToFilter' },
    { menuName: 'library.copyToCurated' },
    { menuName: 'library.addToMixtapeByCopy' }
  ])
  groups.push([{ menuName: 'tracks.showInFileExplorer' }])
  groups.push(createMusicSearchMenuItems())
  groups.push([{ menuName: 'similarTracks.menu' }])
  groups.push([{ menuName: 'fingerprints.analyzeAndAdd' }])
  groups.push([{ menuName: 'tracks.clearTrackCache' }])
  groups.push([{ menuName: 'stemSeparation.menu' }])
  return groups
}

export const usePioneerSongContextMenu = (params: UsePioneerSongContextMenuParams) => {
  const confirmTaskBusy = async () => {
    await confirm({
      title: t('dialog.hint'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
  }

  const handleSongContextMenu = async (event: MouseEvent, song: ISongInfo) => {
    params.cancelPendingRepeatSingleClickDeselect()
    if (params.playlistMutationPending.value) return
    const key = song.mixtapeItemId || song.filePath
    if (!key) return
    if (!params.selectedRowKeys.value.includes(key)) {
      params.selectedRowKeys.value = [key]
    }

    const result = await rightClickMenu({
      menuArr: buildPioneerSongMenuGroups(params.canRemoveTracksFromDesktopPlaylist.value),
      clickEvent: event
    })
    if (result === 'cancel') return

    const musicSearchAction = resolveMusicSearchMenuAction(result.menuName, song)
    if (musicSearchAction) {
      const messageKey = musicSearchAction.query
        ? (await openMusicSearch(musicSearchAction.provider, musicSearchAction.query))
          ? ''
          : getMusicSearchOpenFailedMessageKey(musicSearchAction.provider)
        : musicSearchAction.emptyMessageKey
      if (messageKey) {
        await confirm({
          title: t('dialog.hint'),
          content: [t(messageKey)],
          confirmShow: false
        })
      }
      return
    }

    const selectedTracks = params.resolveSelectedTracks(song)
    if (!selectedTracks.length) return

    const { updatedTracks, missingTracks, existingTracks } =
      await params.resolveExistingOperationTracks(selectedTracks)
    const showSelectedMissingHint = async () => params.showFileMissingHint(missingTracks)

    switch (result.menuName) {
      case 'rekordboxDesktop.removeTracksFromPlaylistAction':
        await params.removeTracksFromDesktopPlaylist(
          updatedTracks,
          params.canRemoveTracksFromDesktopPlaylist.value
        )
        return
      case 'library.copyToCurated':
        if (!existingTracks.length) {
          await showSelectedMissingHint()
          return
        }
        params.openCopyTargetDialog('CuratedLibrary', existingTracks)
        return
      case 'library.copyToFilter':
        if (!existingTracks.length) {
          await showSelectedMissingHint()
          return
        }
        params.openCopyTargetDialog('FilterLibrary', existingTracks)
        return
      case 'library.addToMixtapeByCopy':
        if (!existingTracks.length) {
          await showSelectedMissingHint()
          return
        }
        params.openCopyTargetDialog('MixtapeLibrary', existingTracks)
        return
      case 'fingerprints.analyzeAndAdd':
        if (!existingTracks.length) {
          await showSelectedMissingHint()
          return
        }
        await analyzeFingerprintsForPaths(
          existingTracks.map((item) => item.filePath),
          {
            origin: 'selection'
          }
        )
        return
      case 'stemSeparation.menu': {
        const { default: openLibraryStemSeparationDialog } =
          await import('@renderer/components/libraryStemSeparationDialog')
        await openLibraryStemSeparationDialog({
          filePath: song.filePath,
          songTitle: song.title
        })
        return
      }
      case 'tracks.clearTrackCache':
        if (!existingTracks.length) {
          await showSelectedMissingHint()
          return
        }
        await promptAndStartTrackReanalysis(
          existingTracks.map((item) => item.filePath),
          existingTracks
        )
        return
      case 'similarTracks.menu': {
        const { default: openBatchSimilarTracksDialog } =
          await import('@renderer/components/batchSimilarTracksDialog')
        await openBatchSimilarTracksDialog(existingTracks.length ? existingTracks : [song])
        return
      }
      case 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks':
        if (params.runtime.isProgressing) {
          await confirmTaskBusy()
          return
        }
        if (!existingTracks.length) {
          await showSelectedMissingHint()
          return
        }
        params.runtime.isProgressing = true
        try {
          await openRekordboxDesktopPlaylistForSelectedTracks({
            tracks: existingTracks,
            songListUUID: params.currentPlaybackListKey.value,
            forceKeepSourceTracks: true
          })
        } finally {
          params.runtime.isProgressing = false
        }
        return
      case 'tracks.exportTracksCopyOnly': {
        if (!existingTracks.length) {
          await showSelectedMissingHint()
          return
        }
        const exportResult = await exportDialog({
          title: 'tracks.title',
          forceCopyOnly: true
        })
        if (exportResult === 'cancel') return
        await window.electron.ipcRenderer.invoke(
          'exportSongsToDir',
          exportResult.folderPathVal,
          false,
          JSON.parse(JSON.stringify(existingTracks))
        )
        return
      }
      case 'tracks.showInFileExplorer':
        if (updatedTracks[0]?.fileMissing) {
          await showSelectedMissingHint()
        } else {
          window.electron.ipcRenderer.send('show-item-in-folder', updatedTracks[0]?.filePath)
        }
        return
    }
  }

  return {
    handleSongContextMenu
  }
}
