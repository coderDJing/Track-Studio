import { ref } from 'vue'
import { type ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'
import { copySongCueDefinitionsToTargets } from '@renderer/utils/songCueTransfer'
import type { ISongInfo } from '../../../../../../types/globals'
import { type MoveSongsToDirSummary, useSongMoveTransaction } from './useSongMoveTransaction'
import {
  resolveLibraryTransferActionModeForSongList,
  type LibraryTransferActionMode
} from '@renderer/utils/libraryTransfer'
import { isWindowsPathPlatform, normalizeFilePathForComparison } from '@shared/filePathComparison'

export type MoveSongsLibraryName =
  | 'CuratedLibrary'
  | 'FilterLibrary'
  | 'SetLibrary'
  | 'MixtapeLibrary'

interface UseSelectAndMoveSongsParams {
  songsAreaState: ISongsAreaPaneRuntimeState
}

type MoveSongsConfirmOptions = {
  preservePlaybackForRemovedPaths?: boolean
  resumeMainPlayerAfterPreviewStop?: boolean
}

type MixtapeAppendResult = {
  inserted?: number
  skippedNoBpm?: number
}

export function useSelectAndMoveSongs(params: UseSelectAndMoveSongsParams) {
  const { songsAreaState } = params
  const runtime = useRuntimeStore()
  const normalizePath = (value: string) =>
    normalizeFilePathForComparison(
      value,
      isWindowsPathPlatform(runtime.setting.platform || runtime.platform)
    )
  const { prepareSongMove } = useSongMoveTransaction()
  const normalizeUniqueStrings = (values: unknown[]): string[] =>
    Array.from(
      new Set(
        values
          .filter((value) => typeof value === 'string')
          .map((value) => String(value).trim())
          .filter(Boolean)
      )
    )
  const sortFilePathsByVisibleSongOrder = (filePaths: string[]) => {
    const normalizedSet = new Set(normalizeUniqueStrings(filePaths))
    if (normalizedSet.size <= 1) return [...normalizedSet]
    const ordered = songsAreaState.songInfoArr
      .map((song) => String(song.filePath || '').trim())
      .filter((filePath) => normalizedSet.has(filePath))
    if (ordered.length === normalizedSet.size) return ordered
    const seen = new Set(ordered)
    return [...ordered, ...[...normalizedSet].filter((filePath) => !seen.has(filePath))]
  }
  const resolveFileNameAndFormat = (filePath: string) => {
    const baseName =
      String(filePath || '')
        .split(/[/\\]/)
        .pop() || ''
    const parts = baseName.split('.')
    const ext = parts.length > 1 ? parts.pop() || '' : ''
    const fileFormat = ext ? ext.toUpperCase() : ''
    return { fileName: baseName, fileFormat }
  }
  const buildSongSnapshot = (filePath: string, song?: ISongInfo | null) => {
    const meta = resolveFileNameAndFormat(filePath)
    return {
      filePath,
      fileName: song?.fileName || meta.fileName,
      fileFormat: song?.fileFormat || meta.fileFormat,
      cover: null,
      title: song?.title ?? meta.fileName,
      artist: song?.artist,
      album: song?.album,
      duration: song?.duration ?? '',
      genre: song?.genre,
      label: song?.label,
      bitrate: song?.bitrate,
      container: song?.container,
      key: song?.key,
      keyAnalysisAlgorithmVersion: song?.keyAnalysisAlgorithmVersion,
      originalKey: song?.key,
      originalBpm: song?.bpm,
      energyScore: song?.energyScore,
      energyAlgorithmVersion: song?.energyAlgorithmVersion,
      hotCues: Array.isArray(song?.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
      memoryCues: Array.isArray(song?.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : []
    }
  }
  const buildSongAnalysisSnapshot = (song?: ISongInfo | null) => ({
    key: song?.key,
    keyAnalysisAlgorithmVersion: song?.keyAnalysisAlgorithmVersion,
    energyScore: song?.energyScore,
    energyAlgorithmVersion: song?.energyAlgorithmVersion,
    hotCues: Array.isArray(song?.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
    memoryCues: Array.isArray(song?.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : []
  })
  const isNoBpmSong = (song?: ISongInfo | null) => song?.beatGridStatus === 'no-bpm'
  const emitNoBpmMixtapeHint = (count: number) => {
    const skipped = Math.max(0, Math.round(Number(count) || 0))
    if (skipped <= 0) return
    try {
      emitter.emit('songsArea/clipboardHint', {
        message:
          skipped > 1 ? t('mixtape.noBpmSkipped', { count: skipped }) : t('mixtape.noBpmBlocked')
      })
    } catch {}
  }

  const isDialogVisible = ref(false)
  const targetLibraryName = ref<MoveSongsLibraryName | ''>('')
  const dialogActionMode = ref<LibraryTransferActionMode>('move')

  const initiateMoveSongs = (
    libraryName: MoveSongsLibraryName,
    actionMode?: LibraryTransferActionMode
  ) => {
    targetLibraryName.value = libraryName
    dialogActionMode.value =
      actionMode ?? resolveLibraryTransferActionModeForSongList(songsAreaState.songListUUID)
    isDialogVisible.value = true
  }

  const resolveSourceRowKey = (sourceNodeType: string | undefined, song: ISongInfo) => {
    if (sourceNodeType === 'mixtapeList' && song.mixtapeItemId) return song.mixtapeItemId
    if (sourceNodeType === 'setList' && song.setItemId) return song.setItemId
    return song.filePath
  }

  const resolveSelectedSongsByRowKey = (selectedKeys: string[], sourceNodeType?: string) => {
    const songByKey = new Map<string, ISongInfo>()
    const songByPath = new Map<string, ISongInfo>()
    for (const song of songsAreaState.songInfoArr) {
      const rowKey = resolveSourceRowKey(sourceNodeType, song)
      if (rowKey) songByKey.set(rowKey, song)
      if (song.filePath && !songByPath.has(song.filePath)) {
        songByPath.set(song.filePath, song)
      }
    }
    return selectedKeys
      .map((key) => songByKey.get(key) || songByPath.get(key))
      .filter((song): song is ISongInfo => !!song?.filePath)
  }

  /**
   * Handles the confirmation from the select song list dialog.
   * Moves selected songs to the chosen directory and updates the store.
   * @param targetSongListUUID - The UUID of the target song list.
   */
  const handleMoveSongsConfirm = async (
    targetSongListUUID: string,
    options: MoveSongsConfirmOptions = {}
  ) => {
    isDialogVisible.value = false
    const sourceSongListUUID = songsAreaState.songListUUID
    const sourceActionMode = dialogActionMode.value
    const selectedPaths = sortFilePathsByVisibleSongOrder(
      JSON.parse(JSON.stringify(songsAreaState.selectedSongFilePath))
    )
    const songMap = new Map(songsAreaState.songInfoArr.map((song) => [song.filePath, song]))
    if (!selectedPaths.length) return

    const targetNode = libraryUtils.getLibraryTreeByUUID(targetSongListUUID)
    const sourceNode = libraryUtils.getLibraryTreeByUUID(sourceSongListUUID)
    const isSetTarget = targetNode?.type === 'setList' || targetLibraryName.value === 'SetLibrary'
    if (
      sourceActionMode === 'move' &&
      targetSongListUUID === songsAreaState.songListUUID &&
      !isSetTarget
    ) {
      // Moving to the same list, do nothing.
      return
    }
    if (isSetTarget) {
      if (
        targetNode?.type !== 'setList' ||
        (sourceNode &&
          sourceNode.type !== 'songList' &&
          sourceNode.type !== 'mixtapeList' &&
          sourceNode.type !== 'setList')
      ) {
        return
      }
      const selectedKeys = normalizeUniqueStrings(songsAreaState.selectedSongFilePath)
      const originPathSnapshot = sourceNode
        ? libraryUtils.buildDisplayPathByUuid(sourceSongListUUID)
        : ''
      const items = resolveSelectedSongsByRowKey(selectedKeys, sourceNode?.type).map((song) => ({
        filePath: song.filePath,
        originPlaylistUuid: sourceSongListUUID,
        originPathSnapshot,
        analysis: buildSongAnalysisSnapshot(song)
      }))
      if (items.length === 0) return
      await window.electron.ipcRenderer.invoke('setList:append-items', {
        playlistUuid: targetSongListUUID,
        items
      })
      songsAreaState.selectedSongFilePath.length = 0
      try {
        emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
        emitter.emit('setList/itemsChanged', { uuids: [targetSongListUUID] })
        emitter.emit('songsArea/clipboardHint', {
          message: t('library.addToSet')
        })
      } catch {}
      return
    }
    const isMixtapeTarget =
      targetNode?.type === 'mixtapeList' || targetLibraryName.value === 'MixtapeLibrary'
    if (isMixtapeTarget) {
      if (
        !sourceNode ||
        (sourceNode.type !== 'songList' &&
          sourceNode.type !== 'mixtapeList' &&
          sourceNode.type !== 'setList')
      ) {
        return
      }
      const originPathSnapshot = libraryUtils.buildDisplayPathByUuid(sourceSongListUUID)
      const selectedSourceSongs = resolveSelectedSongsByRowKey(
        normalizeUniqueStrings(selectedPaths),
        sourceNode.type
      )
      const mixtapeSongMap = new Map(
        songsAreaState.songInfoArr
          .filter((song) => typeof song.mixtapeItemId === 'string' && song.mixtapeItemId.length > 0)
          .map((song) => [song.mixtapeItemId as string, song])
      )
      const itemsFromMixtapeIds = normalizeUniqueStrings(selectedPaths)
        .map((itemId) => {
          const song = mixtapeSongMap.get(itemId)
          const filePath = song?.filePath || ''
          if (!song || !filePath) return null
          return {
            filePath,
            originPlaylistUuid: sourceSongListUUID,
            originPathSnapshot,
            info: buildSongSnapshot(filePath, song),
            sourcePlaylistId: sourceSongListUUID,
            sourceItemId: itemId
          }
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
      const itemsFromMixtapePaths = normalizeUniqueStrings(selectedPaths)
        .map((filePath) => {
          const song = songMap.get(filePath)
          if (!song || !song.filePath) return null
          return {
            filePath: song.filePath,
            originPlaylistUuid: sourceSongListUUID,
            originPathSnapshot,
            info: buildSongSnapshot(song.filePath, song),
            sourcePlaylistId: sourceSongListUUID,
            sourceItemId:
              typeof song.mixtapeItemId === 'string' && song.mixtapeItemId.trim()
                ? song.mixtapeItemId.trim()
                : undefined
          }
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
      const rawItems =
        sourceNode.type === 'mixtapeList'
          ? itemsFromMixtapeIds.length > 0
            ? itemsFromMixtapeIds
            : itemsFromMixtapePaths
          : sourceNode.type === 'setList'
            ? selectedSourceSongs.map((song) => ({
                filePath: song.filePath,
                originPlaylistUuid: sourceSongListUUID,
                originPathSnapshot,
                info: buildSongSnapshot(song.filePath, song)
              }))
            : normalizeUniqueStrings(selectedPaths).map((filePath: string) => ({
                filePath,
                originPlaylistUuid: sourceSongListUUID,
                originPathSnapshot,
                info: buildSongSnapshot(filePath, songMap.get(filePath))
              }))
      const items = rawItems.filter((item) => !isNoBpmSong(item.info))
      const skippedNoBpm = rawItems.length - items.length
      if (items.length === 0) {
        emitNoBpmMixtapeHint(skippedNoBpm)
        return
      }
      const result = (await window.electron.ipcRenderer.invoke('mixtape:append', {
        playlistId: targetSongListUUID,
        items
      })) as MixtapeAppendResult | null
      const totalSkippedNoBpm = skippedNoBpm + Math.max(0, Number(result?.skippedNoBpm || 0))
      const inserted = Math.max(0, Number(result?.inserted || 0))
      if (inserted <= 0 && totalSkippedNoBpm > 0) {
        emitNoBpmMixtapeHint(totalSkippedNoBpm)
      }
      if (inserted <= 0) return
      songsAreaState.selectedSongFilePath.length = 0
      try {
        emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
        emitter.emit('songsArea/clipboardHint', {
          message:
            totalSkippedNoBpm > 0
              ? t('mixtape.addedToMixtapeWithNoBpmSkipped', {
                  count: inserted,
                  skipped: totalSkippedNoBpm
                })
              : t('mixtape.addedToMixtape', { count: inserted })
        })
      } catch {}
      return
    }

    if (sourceActionMode === 'copy') {
      const selectedSourceItems = resolveSelectedSongsByRowKey(
        normalizeUniqueStrings(selectedPaths),
        sourceNode?.type
      ).map((song) => ({
        filePath: song.filePath,
        song
      }))
      if (!selectedSourceItems.length) return

      const targetDirPath = libraryUtils.findDirPathByUuid(targetSongListUUID)
      if (!targetDirPath) return

      const copiedPaths = (await window.electron.ipcRenderer.invoke(
        'moveSongsToDir',
        selectedSourceItems.map((item) => item.filePath),
        targetDirPath,
        {
          mode: 'copy',
          curatedArtistNames: selectedSourceItems.map((item) => item.song.artist || '')
        }
      )) as string[]
      await copySongCueDefinitionsToTargets(
        copiedPaths.map((targetFilePath, index) => ({
          targetFilePath,
          sourceSong: selectedSourceItems[index]?.song
        }))
      )

      songsAreaState.selectedSongFilePath.length = 0
      try {
        emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
        emitter.emit('songsArea/clipboardHint', { action: 'copy' })
      } catch {}
      return
    }

    const moveTransaction = await prepareSongMove({
      sourceSongListUUID,
      sourceSongs: songsAreaState.songInfoArr,
      filePaths: selectedPaths
    })
    let moveSummary: MoveSongsToDirSummary
    try {
      moveSummary = (await window.electron.ipcRenderer.invoke(
        'moveSongsToDir',
        selectedPaths,
        libraryUtils.findDirPathByUuid(targetSongListUUID),
        {
          returnSummary: true,
          curatedArtistNames: selectedPaths.map(
            (filePath: string) => songMap.get(filePath)?.artist || ''
          )
        }
      )) as MoveSongsToDirSummary
    } catch (error) {
      moveTransaction.restoreSourceList()
      throw error
    }
    const movedSourcePathSet = new Set(
      moveSummary.movedEntries.map((item) => normalizePath(item.sourcePath))
    )
    const failedSourcePaths = selectedPaths.filter(
      (filePath) => !movedSourcePathSet.has(normalizePath(filePath))
    )
    if (failedSourcePaths.length > 0) {
      moveTransaction.restoreSourceList(failedSourcePaths)
    }
    await copySongCueDefinitionsToTargets(
      moveSummary.movedEntries.map(({ sourcePath, targetPath }) => ({
        targetFilePath: targetPath,
        sourceSong: songMap.get(sourcePath)
      }))
    )

    // 不在此处直接修改 original 或 runtime.songsArea.songInfoArr，
    // 统一通过全局事件在 songsArea.vue 中处理，避免与排序/筛选链路竞态。
    songsAreaState.selectedSongFilePath.length = 0 // 清空选择

    // 通知全局，保证 songsArea 与其他视图收到统一的移除事件
    emitter.emit('songsRemoved', {
      listUUID: sourceSongListUUID,
      paths: moveSummary.movedEntries.map(({ sourcePath }) => sourcePath),
      preservePlaybackForRemovedPaths: options.preservePlaybackForRemovedPaths,
      resumeMainPlayerAfterPreviewStop: options.resumeMainPlayerAfterPreviewStop
    })

    // 同步通知源/目标歌单数量刷新
    try {
      const affected = [sourceSongListUUID, targetSongListUUID].filter(Boolean)
      emitter.emit('playlistContentChanged', { uuids: affected })
    } catch {}

    if (failedSourcePaths.length > 0 || moveSummary.failed > 0) {
      throw new Error('moveSongsToDir incomplete')
    }
  }

  const handleDialogCancel = () => {
    isDialogVisible.value = false
  }

  return {
    isDialogVisible, // To be bound to v-if or v-model of the dialog component
    targetLibraryName, // To be passed as a prop to the dialog component
    dialogActionMode,
    initiateMoveSongs, // To be called by the parent component to start the process
    handleMoveSongsConfirm, // To be called by the dialog component on confirm event
    handleDialogCancel // To be called by the dialog component on cancel event
  }
}
