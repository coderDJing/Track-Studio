import { ref, computed } from 'vue'
import { type ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { ISongInfo } from '../../../../../../types/globals'
import emitter from '@renderer/utils/mitt'
import { copySongCueDefinitionsToTargets } from '@renderer/utils/songCueTransfer'
import { buildMixtapeDragSessionItem } from '@renderer/utils/mixtapeDragSession'
import { t } from '@renderer/utils/translate'
import { type MoveSongsToDirSummary, useSongMoveTransaction } from './useSongMoveTransaction'
import { isWindowsPathPlatform, normalizeFilePathForComparison } from '@shared/filePathComparison'

interface DragSongData {
  songFilePaths: string[]
  sourceLibraryName: string
  sourceSongListUUID: string
  sourceMixtapeItemIds?: string[]
}

type SongDragMode = 'internal' | 'external'

type StartDragSongsOptions = {
  songFilePaths?: string[]
  sourceMixtapeItemIds?: string[]
  dragMode?: SongDragMode
}

interface UseDragSongsParams {
  songsAreaState?: ISongsAreaPaneRuntimeState
}

export function useDragSongs(params: UseDragSongsParams = {}) {
  const runtime = useRuntimeStore()
  const songsAreaState = params.songsAreaState ?? runtime.songsArea
  const { prepareSongMove } = useSongMoveTransaction()
  const isDragging = ref(false)
  const dragData = ref<DragSongData | null>(null)
  let dragCleanupTimer: ReturnType<typeof setTimeout> | null = null

  const clearDragCleanupTimer = () => {
    if (dragCleanupTimer) {
      clearTimeout(dragCleanupTimer)
      dragCleanupTimer = null
    }
  }
  const setRuntimeDragState = (
    filePaths: string[],
    sourceSongListUUID: string,
    sourceMixtapeItemIds: string[] = [],
    dragMode: SongDragMode = 'internal'
  ) => {
    runtime.songDragActive = true
    runtime.songDragMode = dragMode
    runtime.draggingSongFilePaths = [...filePaths]
    runtime.dragSourceSongListUUID = sourceSongListUUID
    runtime.dragSourceMixtapeItemIds = [...sourceMixtapeItemIds]
  }
  const clearRuntimeDragState = () => {
    runtime.songDragActive = false
    runtime.songDragMode = ''
    runtime.draggingSongFilePaths = []
    runtime.dragSourceSongListUUID = ''
    runtime.dragSourceMixtapeItemIds = []
  }
  const normalizeUniqueStrings = (values: unknown[]): string[] =>
    Array.from(
      new Set(
        values
          .filter((value) => typeof value === 'string')
          .map((value) => String(value).trim())
          .filter(Boolean)
      )
    )
  const isNoBpmMixtapeItem = (item: { info?: unknown } | null | undefined) =>
    Boolean(
      item &&
      typeof item.info === 'object' &&
      item.info !== null &&
      !Array.isArray(item.info) &&
      (item.info as { beatGridStatus?: unknown }).beatGridStatus === 'no-bpm'
    )
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
  const normalizePath = (p: string | undefined | null) =>
    normalizeFilePathForComparison(
      p,
      isWindowsPathPlatform(runtime.setting.platform || runtime.platform)
    )
  const buildSongAnalysisSnapshot = (song?: ISongInfo | null) => ({
    key: song?.key,
    keyAnalysisAlgorithmVersion: song?.keyAnalysisAlgorithmVersion,
    energyScore: song?.energyScore,
    energyAlgorithmVersion: song?.energyAlgorithmVersion,
    hotCues: Array.isArray(song?.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
    memoryCues: Array.isArray(song?.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : []
  })

  const resolveSourceSongsAreaState = (sourceSongListUUID: string) => {
    if (songsAreaState.songListUUID === sourceSongListUUID) return songsAreaState
    for (const pane of ['single', 'left', 'right'] as const) {
      const paneState = runtime.songsAreaPanels.panes[pane]
      if (paneState.songListUUID === sourceSongListUUID) {
        return paneState
      }
    }
    return runtime.songsArea
  }

  const sortFilePathsByVisibleSongOrder = (filePaths: string[], songs: ISongInfo[]) => {
    const normalizedSet = new Set(
      filePaths.map((item) => String(item || '').trim()).filter(Boolean)
    )
    if (normalizedSet.size <= 1) return [...normalizedSet]
    const ordered = songs
      .map((song) => String(song.filePath || '').trim())
      .filter((filePath) => normalizedSet.has(filePath))
    if (ordered.length === normalizedSet.size) return ordered
    const seen = new Set(ordered)
    return [...ordered, ...[...normalizedSet].filter((filePath) => !seen.has(filePath))]
  }

  /**
   * 开始拖拽歌曲
   * @param songOrSongs - 单个歌曲或歌曲数组
   * @param sourceLibraryName - 源库名称
   * @param sourceSongListUUID - 源歌单UUID
   */
  const startDragSongs = (
    songOrSongs: ISongInfo | ISongInfo[],
    sourceLibraryName: string,
    sourceSongListUUID: string,
    options?: StartDragSongsOptions
  ): string[] => {
    clearDragCleanupTimer()
    // 如果是单个歌曲且没有被选中，则只拖拽该歌曲
    // 如果是单个歌曲但已被选中，则拖拽所有选中的歌曲
    // 如果传入的是数组，则拖拽整个数组
    let songFilePaths: string[]
    const optionPaths = normalizeUniqueStrings(
      Array.isArray(options?.songFilePaths) ? options.songFilePaths : []
    )
    const sourceMixtapeItemIds = normalizeUniqueStrings(
      Array.isArray(options?.sourceMixtapeItemIds) ? options.sourceMixtapeItemIds : []
    )
    const dragMode: SongDragMode = options?.dragMode === 'external' ? 'external' : 'internal'

    if (optionPaths.length > 0) {
      songFilePaths = optionPaths
    } else {
      if (Array.isArray(songOrSongs)) {
        songFilePaths = songOrSongs.map((song) => song.filePath)
      } else {
        const singleSong = songOrSongs
        const isSelected = songsAreaState.selectedSongFilePath.includes(singleSong.filePath)

        if (isSelected && songsAreaState.selectedSongFilePath.length > 0) {
          // 如果这首歌被选中且有其他选中的歌曲，拖拽所有选中的歌曲
          songFilePaths = [...songsAreaState.selectedSongFilePath]
        } else {
          // 否则只拖拽这首歌
          songFilePaths = [singleSong.filePath]
        }
      }
    }

    dragData.value = {
      songFilePaths,
      sourceLibraryName,
      sourceSongListUUID,
      sourceMixtapeItemIds
    }
    isDragging.value = true
    setRuntimeDragState(songFilePaths, sourceSongListUUID, sourceMixtapeItemIds, dragMode)
    return songFilePaths
  }

  /**
   * 结束拖拽
   */
  const endDragSongs = () => {
    isDragging.value = false
    dragData.value = null
    clearRuntimeDragState()
    clearDragCleanupTimer()
  }

  const scheduleDragCleanup = (delayMs: number = 8000) => {
    clearDragCleanupTimer()
    dragCleanupTimer = setTimeout(() => {
      endDragSongs()
    }, delayMs)
  }

  /**
   * 处理拖拽到歌单的逻辑
   * @param targetSongListUUID - 目标歌单UUID
   * @param targetLibraryName - 目标库名称
   * @returns 被移动的歌曲文件路径数组
   */
  const handleDropToSongList = async (targetSongListUUID: string, _targetLibraryName: string) => {
    try {
      // 优先使用拖拽开始时快照，避免拖拽过程中选中态变化导致错移
      const selectedSongFilePaths =
        dragData.value?.songFilePaths?.length && Array.isArray(dragData.value.songFilePaths)
          ? [...dragData.value.songFilePaths]
          : runtime.draggingSongFilePaths.length > 0
            ? [...runtime.draggingSongFilePaths]
            : [...songsAreaState.selectedSongFilePath]
      const sourceMixtapeItemIds = normalizeUniqueStrings(
        Array.isArray(dragData.value?.sourceMixtapeItemIds) &&
          dragData.value.sourceMixtapeItemIds.length > 0
          ? dragData.value.sourceMixtapeItemIds
          : Array.isArray(runtime.dragSourceMixtapeItemIds)
            ? runtime.dragSourceMixtapeItemIds
            : []
      )
      const sourceSongListUUID =
        dragData.value?.sourceSongListUUID ||
        runtime.dragSourceSongListUUID ||
        songsAreaState.songListUUID

      if (!selectedSongFilePaths.length || !sourceSongListUUID) {
        return []
      }
      if (targetSongListUUID === sourceSongListUUID) {
        return []
      }

      const targetNode = libraryUtils.getLibraryTreeByUUID(targetSongListUUID)
      const sourceNode = libraryUtils.getLibraryTreeByUUID(sourceSongListUUID)
      const sourceSongsAreaState = resolveSourceSongsAreaState(sourceSongListUUID)
      const orderedSongFilePaths = sortFilePathsByVisibleSongOrder(
        selectedSongFilePaths,
        sourceSongsAreaState.songInfoArr
      )
      const isSetTarget = targetNode?.type === 'setList'
      const isMixtapeTarget = targetNode?.type === 'mixtapeList'

      if (isSetTarget) {
        if (!sourceNode || sourceNode.type !== 'songList') {
          return []
        }
        const originPathSnapshot = libraryUtils.buildDisplayPathByUuid(sourceSongListUUID)
        const songMap = new Map(
          sourceSongsAreaState.songInfoArr.map((song) => [song.filePath, song])
        )
        const items = orderedSongFilePaths.map((filePath) => ({
          filePath,
          originPlaylistUuid: sourceSongListUUID,
          originPathSnapshot,
          analysis: buildSongAnalysisSnapshot(songMap.get(filePath))
        }))
        if (items.length === 0) {
          return []
        }
        await window.electron.ipcRenderer.invoke('setList:append-items', {
          playlistUuid: targetSongListUUID,
          items
        })
        try {
          emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
          emitter.emit('setList/itemsChanged', { uuids: [targetSongListUUID] })
        } catch {}
        return []
      }

      if (isMixtapeTarget) {
        if (!sourceNode || (sourceNode.type !== 'songList' && sourceNode.type !== 'mixtapeList')) {
          return []
        }
        const originPathSnapshot = libraryUtils.buildDisplayPathByUuid(sourceSongListUUID)
        const songMap = new Map(
          sourceSongsAreaState.songInfoArr.map((song) => [song.filePath, song])
        )
        const mixtapeSongMap = new Map(
          sourceSongsAreaState.songInfoArr
            .filter(
              (song) => typeof song.mixtapeItemId === 'string' && song.mixtapeItemId.length > 0
            )
            .map((song) => [song.mixtapeItemId as string, song])
        )
        const itemsFromMixtapeIds = sourceMixtapeItemIds
          .map((itemId) => {
            const song = mixtapeSongMap.get(itemId)
            const filePath = song?.filePath || ''
            if (!song || !filePath) return null
            return buildMixtapeDragSessionItem({
              song,
              filePath,
              originPathSnapshot,
              sourceSongListUUID,
              sourceItemId: itemId
            })
          })
          .filter((item): item is NonNullable<typeof item> => item !== null)
        const itemsFromMixtapePaths = normalizeUniqueStrings(selectedSongFilePaths)
          .map((filePath) => {
            const song = songMap.get(filePath)
            if (!song || !song.filePath) return null
            return buildMixtapeDragSessionItem({
              song,
              filePath: song.filePath,
              originPathSnapshot,
              sourceSongListUUID,
              sourceItemId:
                typeof song.mixtapeItemId === 'string' && song.mixtapeItemId.trim()
                  ? song.mixtapeItemId.trim()
                  : undefined
            })
          })
          .filter((item): item is NonNullable<typeof item> => item !== null)
        const rawItems =
          sourceNode.type === 'mixtapeList'
            ? itemsFromMixtapeIds.length > 0
              ? itemsFromMixtapeIds
              : itemsFromMixtapePaths
            : orderedSongFilePaths
                .map((filePath) =>
                  buildMixtapeDragSessionItem({
                    song: songMap.get(filePath),
                    filePath,
                    originPathSnapshot,
                    sourceSongListUUID
                  })
                )
                .filter((item): item is NonNullable<typeof item> => item !== null)
        const items = rawItems.filter((item) => !isNoBpmMixtapeItem(item))
        const skippedNoBpm = rawItems.length - items.length
        if (items.length === 0) {
          emitNoBpmMixtapeHint(skippedNoBpm)
          return []
        }
        const result = (await window.electron.ipcRenderer.invoke('mixtape:append', {
          playlistId: targetSongListUUID,
          items
        })) as { inserted?: number; skippedNoBpm?: number } | null
        const inserted = Math.max(0, Number(result?.inserted || 0))
        const totalSkippedNoBpm = skippedNoBpm + Math.max(0, Number(result?.skippedNoBpm || 0))
        if (inserted <= 0 && totalSkippedNoBpm > 0) {
          emitNoBpmMixtapeHint(totalSkippedNoBpm)
          return []
        }
        try {
          if (inserted > 0) {
            emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
            if (totalSkippedNoBpm > 0) {
              emitter.emit('songsArea/clipboardHint', {
                message: t('mixtape.addedToMixtapeWithNoBpmSkipped', {
                  count: inserted,
                  skipped: totalSkippedNoBpm
                })
              })
            }
          }
        } catch {}
        // Mixtape 自动录制歌单目标始终为复制，不回传“移动”结果
        return []
      }

      if (sourceNode?.type === 'mixtapeList') {
        return []
      }

      // 获取目标路径，确保是纯字符串
      const targetDirPath = libraryUtils.findDirPathByUuid(targetSongListUUID)

      if (!targetDirPath) {
        return []
      }

      const moveTransaction = await prepareSongMove({
        sourceSongListUUID,
        sourceSongs: sourceSongsAreaState.songInfoArr,
        filePaths: orderedSongFilePaths
      })
      let moveSummary: MoveSongsToDirSummary
      try {
        moveSummary = (await window.electron.ipcRenderer.invoke(
          'moveSongsToDir',
          orderedSongFilePaths,
          targetDirPath,
          {
            returnSummary: true,
            curatedArtistNames: orderedSongFilePaths.map((filePath) => {
              const song = sourceSongsAreaState.songInfoArr.find(
                (item) => item.filePath === filePath
              )
              return song?.artist || ''
            })
          }
        )) as MoveSongsToDirSummary
      } catch (error) {
        moveTransaction.restoreSourceList()
        throw error
      }
      const movedSourcePathSet = new Set(
        moveSummary.movedEntries.map((item) => normalizePath(item.sourcePath))
      )
      const failedSourcePaths = orderedSongFilePaths.filter(
        (filePath) => !movedSourcePathSet.has(normalizePath(filePath))
      )
      if (failedSourcePaths.length > 0) {
        moveTransaction.restoreSourceList(failedSourcePaths)
      }
      const sourceSongMap = new Map(
        sourceSongsAreaState.songInfoArr.map((song) => [song.filePath, song])
      )
      await copySongCueDefinitionsToTargets(
        moveSummary.movedEntries.map(({ sourcePath, targetPath }) => ({
          targetFilePath: targetPath,
          sourceSong: sourceSongMap.get(sourcePath)
        }))
      )

      // 广播：源/目标歌单内容发生变化（用于刷新数量）
      try {
        const affected = [sourceSongListUUID, targetSongListUUID].filter(Boolean)
        emitter.emit('playlistContentChanged', { uuids: affected })
      } catch {}

      // 乐观移除已在文件移动前执行；保留该事件以同步未参与乐观更新的订阅方。
      try {
        const normalized = moveSummary.movedEntries.map(({ sourcePath }) =>
          normalizePath(sourcePath)
        )
        emitter.emit('songsRemoved', {
          listUUID: sourceSongListUUID,
          paths: normalized,
          preservePlaybackForRemovedPaths: true,
          resumeMainPlayerAfterPreviewStop: true
        })
      } catch {}

      if (failedSourcePaths.length > 0 || moveSummary.failed > 0) {
        throw new Error('moveSongsToDir incomplete')
      }

      return orderedSongFilePaths
    } finally {
      endDragSongs()
    }
  }

  const draggedSongCount = computed(() => {
    return dragData.value?.songFilePaths.length || 0
  })

  return {
    isDragging,
    dragData,
    draggedSongCount,
    startDragSongs,
    endDragSongs,
    scheduleDragCleanup,
    handleDropToSongList
  }
}
