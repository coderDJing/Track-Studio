import { sameRendererFilePath, RendererFilePathSet } from '@renderer/utils/filePathComparison'

import { Ref, ref } from 'vue'
import { type ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import { ISongInfo, IMenu, type IMetadataAutoFillSummary } from '../../../../../../types/globals' // Corrected path
import { t } from '@renderer/utils/translate'
import rightClickMenu from '@renderer/components/rightClickMenu' // Assuming it's a default export or easily callable
import confirm from '@renderer/components/confirmDialog'
import { showRestoreSummaryIfNeeded } from './songItemContextMenuSummaries'
import exportDialog from '@renderer/components/exportDialog'
import { openRekordboxDesktopPlaylistForSelectedTracks } from '@renderer/utils/rekordboxDesktopPlaylist'
import { openExternalLibraryPlaylistForSelectedTracks } from '@renderer/utils/externalLibraryPlaylist'
import { openRekordboxXmlExportForSelectedTracks } from '@renderer/utils/rekordboxXmlExport'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import emitter from '@renderer/utils/mitt'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import { hasEffectiveAcoustIdKey } from '@renderer/utils/acoustid'
import libraryUtils from '@renderer/utils/libraryUtils'
import { startAudioConvertFromFiles } from '@renderer/utils/audioConvertActions'
import {
  exportNeteaseTracksToRekordboxXml,
  showNeteaseSongInFolder,
  startNeteaseAudioConvert,
  startNeteaseBpmFix
} from '@renderer/utils/neteaseLocalActions'
import { promptAndStartTrackReanalysis } from '@renderer/utils/trackReanalysis'
import choiceDialog from '@renderer/components/choiceDialog'
import { normalizeArtistName, splitArtistNames } from '@shared/artistNames'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import {
  NETEASE_DOWNLOADED_UUID,
  isNeteasePendingPath,
  isNeteasePlaylistUuid,
  isNeteasePreviewUrl,
  getNeteasePlaylistId,
  parseNeteaseSongId
} from '@shared/netease'
import {
  deleteNeteaseLocalFiles,
  downloadNeteaseTracks,
  mapNeteaseSongsToLocalFiles,
  removeNeteasePlaylistTracks
} from '@renderer/utils/neteaseActions'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import {
  getMusicSearchOpenFailedMessageKey,
  openMusicSearch,
  resolveMusicSearchMenuAction
} from '@renderer/utils/musicSearch'
import {
  buildSongItemMenuArr,
  createDefaultMenuArr,
  createMixtapeMenuArr,
  createNeteaseDownloadedMenuArr,
  createNeteaseSetStreamMenuArr,
  createNeteaseStreamMenuArr,
  createRecycleMenuArr,
  createSetMenuArr,
  withoutRecordingAnalysisMenus
} from './songItemContextMenuMenus'
import { isNeteaseStreamSong } from '@renderer/utils/neteaseSongs'
import type { LibraryTransferActionMode } from '@renderer/utils/libraryTransfer'
import { isWindowsPathPlatform, normalizeFilePathForComparison } from '@shared/filePathComparison'
import {
  SONG_DELETE_MENU_NAMES,
  handleSongDeleteMenuAction
} from './songItemContextMenuDeleteActions'
import { canRemoveTracksFromNeteasePlaylist } from '@renderer/utils/neteasePlaylistContext'

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

type ExportSongsToDirSummary = {
  removedPaths?: string[]
  removedSetItemIds?: string[]
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
    const selectedFilePathSet = new RendererFilePathSet(resolveSelectedFilePaths(selectedKeys))
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
    const isNeteaseStreamView = isNeteasePlaylistUuid(songsAreaState.songListUUID)
    const isNeteaseDownloadedView = songsAreaState.songListUUID === NETEASE_DOWNLOADED_UUID
    const matchedCuratedArtists = resolveCuratedArtistMatches(song)
    const matchedCuratedArtist = matchedCuratedArtists[0] || ''
    if (songsAreaState.selectedSongFilePath.indexOf(getRowKey(song)) === -1) {
      songsAreaState.selectedSongFilePath = [getRowKey(song)]
    }

    const selectedSongsForSetDuration = resolveSelectedSongs()
    const setHasNeteaseStream = isSetView() && selectedSongsForSetDuration.some(isNeteaseStreamSong)
    /**
     * 网易云歌单里的行只有 `frkb-preview://` 流地址。
     * 需要真实文件的操作（分析、改名、转码、写 DVS 播放列表）先落成 `.store/` 文件再继续；
     * 下载失败的一首不往下传，避免把 URL 当磁盘路径送进文件系统。
     */
    const resolveLocalSongsForAction = async (): Promise<ISongInfo[] | null> => {
      if (!isNeteaseStreamView) return resolveSelectedSongs()
      const mapped = await mapNeteaseSongsToLocalFiles(resolveSelectedSongs())
      return mapped.length > 0 ? mapped : null
    }
    const resolveLocalFilePathsForAction = async (): Promise<string[] | null> => {
      const songs = await resolveLocalSongsForAction()
      if (!songs) return null
      return songs.map((item) => item.filePath).filter((filePath) => Boolean(filePath))
    }
    const baseMenuArr = isMixtapeView()
      ? createMixtapeMenuArr()
      : isRecycleBinView
        ? createRecycleMenuArr()
        : isNeteaseStreamView
          ? createNeteaseStreamMenuArr(song.neteaseDownloaded === true, {
              canRemoveFromPlaylist: canRemoveTracksFromNeteasePlaylist(
                runtime.libraryTree,
                songsAreaState.songListUUID
              )
            })
          : isNeteaseDownloadedView
            ? createNeteaseDownloadedMenuArr(songsAreaState.songListUUID)
            : isSetView()
              ? setHasNeteaseStream
                ? createNeteaseSetStreamMenuArr()
                : createSetMenuArr(songsAreaState.songListUUID)
              : createDefaultMenuArr(songsAreaState.songListUUID)
    const menuWithSourceLabel = isRecordingLibraryView
      ? withoutRecordingAnalysisMenus(baseMenuArr)
      : baseMenuArr
    menuArr.value = buildSongItemMenuArr(menuWithSourceLabel, matchedCuratedArtists)
    if (selectedSongsForSetDuration.length > 1) {
      menuArr.value.push([{ menuName: 'playlist.calculateSetDuration' }])
    }
    if (isExternalView)
      menuArr.value = menuArr.value
        .map((group) => group.filter((item) => item.menuName !== 'bpmFix.menu'))
        .filter((group) => group.length > 0)
    const result = await rightClickMenu({
      menuArr: menuArr.value,
      clickEvent: event
    })

    if (result === 'cancel') return null

    if (result.menuName === 'netease.downloadToLocal') {
      const songId = song.neteaseSongId || ''
      if (songId) await downloadNeteaseTracks([songId])
      return null
    }
    if (result.menuName === 'netease.removeLocalFile') {
      const ids = resolveSelectedSongs()
        .map((item) => String(item.neteaseSongId || ''))
        .filter((id) => id.length > 0)
      const fallback = String(song.neteaseSongId || '')
      await deleteNeteaseLocalFiles(ids.length > 0 ? ids : fallback ? [fallback] : [])
      return null
    }

    if (result.menuName === 'netease.removeFromPlaylist') {
      const playlistId = getNeteasePlaylistId(songsAreaState.songListUUID)
      const ids = resolveSelectedSongs()
        .map((item) => String(item.neteaseSongId || parseNeteaseSongId(item.filePath) || ''))
        .filter((id) => id.length > 0)
      const fallback = String(song.neteaseSongId || parseNeteaseSongId(song.filePath) || '')
      await removeNeteasePlaylistTracks({
        playlistId,
        songIds: ids.length > 0 ? ids : fallback ? [fallback] : []
      })
      return null
    }

    if (result.menuName === 'playlist.calculateSetDuration') {
      const { default: openSetDurationDialog } =
        await import('@renderer/components/setDurationDialog')
      await openSetDurationDialog(selectedSongsForSetDuration)
      return null
    }

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
      return null
    }

    if (SONG_DELETE_MENU_NAMES.has(result.menuName)) {
      return await handleSongDeleteMenuAction(result.menuName, song, {
        songsAreaState,
        runtime,
        songsAreaHostElementRef,
        syncSongsAreaScrollMetrics,
        isMixtapeView,
        isSetView,
        isRecycleBinView,
        isExternalView,
        normalizePath,
        getRowKey,
        resolveSelectedKeys,
        resolveSelectedFilePaths,
        resolveSelectedItemIds,
        resolveSelectedSetItemIds
      })
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
        if (
          isNeteaseStreamView ||
          isNeteaseDownloadedView ||
          isNeteaseStreamSong(song) ||
          selectedSongsForSetDuration.some(isNeteaseStreamSong)
        ) {
          await startNeteaseAudioConvert(resolveSelectedSongs(), runtime.setting.audioExt)
          return null
        }
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
      case 'bpmFix.menu': {
        if (
          isNeteaseStreamView ||
          isNeteaseDownloadedView ||
          isNeteaseStreamSong(song) ||
          selectedSongsForSetDuration.some(isNeteaseStreamSong)
        ) {
          await startNeteaseBpmFix(resolveSelectedSongs())
          return null
        }
        const files = await resolveLocalFilePathsForAction()
        if (!files || files.length === 0) return null
        const { startBpmFix } = await import('@renderer/utils/bpmFixActions')
        await startBpmFix({
          filePaths: files,
          songListUUID: songsAreaState.songListUUID,
          songListPath: libraryUtils.findDirPathByUuid(songsAreaState.songListUUID) || ''
        })
        return null
      }
      case 'stemSeparation.menu': {
        if (
          !isNeteaseStreamView &&
          (isNeteaseStreamSong(song) || selectedSongsForSetDuration.some(isNeteaseStreamSong))
        ) {
          return null
        }
        let targetSong = song
        if (isNeteaseStreamView) {
          const mapped = await mapNeteaseSongsToLocalFiles([song])
          if (!mapped.length) return null
          targetSong = mapped[0]
        }
        const { default: openLibraryStemSeparationDialog } =
          await import('@renderer/components/libraryStemSeparationDialog')
        await openLibraryStemSeparationDialog({
          filePath: targetSong.filePath,
          songTitle: targetSong.title
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
      case 'fingerprints.analyzeAndAdd': {
        if (isNeteaseStreamSong(song) || selectedSongsForSetDuration.some(isNeteaseStreamSong)) {
          return null
        }
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
        const currentSelectedKeys = [...resolveSelectedKeys()]
        const songsToExportFilePaths = resolveSelectedFilePaths(currentSelectedKeys)
        const selectedKeySet = new Set(currentSelectedKeys)
        const songsToExportObjects =
          isMixtapeView() || isSetView()
            ? songsAreaState.songInfoArr.filter((item) => selectedKeySet.has(getRowKey(item)))
            : songsAreaState.songInfoArr.filter((item) =>
                songsToExportFilePaths.some((filePath) =>
                  sameRendererFilePath(filePath, item.filePath)
                )
              )
        if (songsToExportObjects.length === 0) return null

        const streamOnlyExport = songsToExportObjects.some(
          (item) =>
            isNeteasePreviewUrl(item.filePath) ||
            isNeteasePendingPath(item.filePath) ||
            Boolean(item.neteasePendingDownload)
        )
        const exportResult = await exportDialog({
          title: 'tracks.title',
          forceCopyOnly: streamOnlyExport
        })
        if (exportResult !== 'cancel') {
          const { folderPathVal, deleteSongsAfterExport } = exportResult
          const resolvedSongs = streamOnlyExport
            ? await mapNeteaseSongsToLocalFiles(songsToExportObjects)
            : songsToExportObjects
          if (resolvedSongs.length === 0) return null

          const exportSummary = (await window.electron.ipcRenderer.invoke(
            'exportSongsToDir',
            folderPathVal,
            streamOnlyExport ? false : deleteSongsAfterExport,
            JSON.parse(JSON.stringify(resolvedSongs))
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
                removedPaths.some((filePath) =>
                  sameRendererFilePath(filePath, runtime.playingData.playingSong?.filePath)
                )
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
        if (
          isNeteaseStreamView ||
          isNeteaseDownloadedView ||
          isNeteaseStreamSong(song) ||
          selectedSongsForSetDuration.some(isNeteaseStreamSong)
        ) {
          const selectedSongs = resolveSelectedSongs()
          if (!selectedSongs.length) {
            await confirm({
              title: t('rekordboxXmlExport.failureTitle'),
              content: [t('rekordboxXmlExport.noTracksToExport')],
              confirmShow: false
            })
            return null
          }
          await exportNeteaseTracksToRekordboxXml({
            tracks: selectedSongs,
            songListUUID: songsAreaState.songListUUID
          })
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
                summary.sourceFilePaths.some((filePath) =>
                  sameRendererFilePath(filePath, runtime.playingData.playingSong?.filePath)
                )
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
      case 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks':
      case 'library.writeToSeratoPlaylist':
      case 'library.writeToTraktorPlaylist': {
        if (runtime.isProgressing) {
          await confirmTaskBusy()
          return null
        }
        const selectedSongs = await resolveLocalSongsForAction()
        if (!selectedSongs || !selectedSongs.length) {
          await confirm({
            title: t('rekordboxDesktop.failureTitle'),
            content: [t('rekordboxDesktop.noTracksToImport')],
            confirmShow: false
          })
          return null
        }
        runtime.isProgressing = true
        try {
          // 网易云来源是 `.store` 下载缓存：删掉源文件会让「查看已下载」变成幽灵行，
          // 所以不展示“源曲目如何处理”，默认保留。
          const keepSourceTracks =
            isNeteaseStreamView ||
            isNeteaseDownloadedView ||
            selectedSongs.some((item) => Boolean(item.neteaseSongId))
          const summary =
            result.menuName === 'library.writeToSeratoPlaylist' ||
            result.menuName === 'library.writeToTraktorPlaylist'
              ? await openExternalLibraryPlaylistForSelectedTracks({
                  tracks: selectedSongs,
                  kind: result.menuName === 'library.writeToTraktorPlaylist' ? 'traktor' : 'serato'
                })
              : await openRekordboxDesktopPlaylistForSelectedTracks({
                  tracks: selectedSongs,
                  songListUUID: songsAreaState.songListUUID,
                  forceKeepSourceTracks: keepSourceTracks,
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
                summary.removedSourceFilePaths.some((filePath) =>
                  sameRendererFilePath(filePath, runtime.playingData.playingSong?.filePath)
                )
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
        if (isNeteaseStreamView || isNeteaseDownloadedView || isNeteaseStreamSong(song)) {
          await showNeteaseSongInFolder(song)
          break
        }
        window.electron.ipcRenderer.send('show-item-in-folder', song.filePath)
        break
      case 'tracks.clearTrackCache': {
        if (
          !isNeteaseStreamView &&
          (isNeteaseStreamSong(song) || selectedSongsForSetDuration.some(isNeteaseStreamSong))
        ) {
          return null
        }
        const localSongs = await resolveLocalSongsForAction()
        if (!localSongs || localSongs.length === 0) return null
        await promptAndStartTrackReanalysis(
          localSongs.map((item) => item.filePath),
          localSongs
        )
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
