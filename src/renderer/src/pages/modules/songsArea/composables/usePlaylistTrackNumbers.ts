import { computed, markRaw, ref, type Ref, type ShallowRef } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import emitter from '@renderer/utils/mitt'
import libraryUtils from '@renderer/utils/libraryUtils'
import { t } from '@renderer/utils/translate'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'

type UsePlaylistTrackNumbersParams = {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  columnData: Ref<ISongsAreaColumn[]>
  isRequesting: Ref<boolean>
  applyFiltersAndSorting: () => void
  resolveCoreLibraryNameBySongListUUID: (uuid: string) => string
}

const normalizePath = (value: string | undefined | null) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

const normalizeSetItemId = (value: string | undefined | null) => String(value || '').trim()

const buildNumberMap = (orderedIds: string[], normalizeId: (value: string) => string) =>
  new Map(orderedIds.map((id, index) => [normalizeId(id), index + 1]))

export const usePlaylistTrackNumbers = (params: UsePlaylistTrackNumbersParams) => {
  const {
    runtime,
    songsAreaState,
    originalSongInfoArr,
    columnData,
    isRequesting,
    applyFiltersAndSorting,
    resolveCoreLibraryNameBySongListUUID
  } = params

  const trackNumberMutationPending = ref(false)

  const isSupportedPlaylistTrackNumberList = computed(() => {
    const libraryName = resolveCoreLibraryNameBySongListUUID(songsAreaState.songListUUID)
    const nodeType = libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type
    return (
      nodeType === 'setList' ||
      (nodeType === 'songList' &&
        (libraryName === 'FilterLibrary' || libraryName === 'CuratedLibrary'))
    )
  })

  const isSetPlaylistTrackNumberList = computed(
    () => libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type === 'setList'
  )

  const hasActiveTrackFilters = computed(() =>
    columnData.value.some((column) => Boolean(column.filterActive))
  )

  const sortedTrackColumn = computed(
    () => columnData.value.find((column) => Boolean(column.order)) || null
  )

  const canReorderPlaylistTracks = computed(
    () =>
      isSupportedPlaylistTrackNumberList.value &&
      !isRequesting.value &&
      !trackNumberMutationPending.value &&
      songsAreaState.songInfoArr.length > 1 &&
      !hasActiveTrackFilters.value &&
      Boolean(sortedTrackColumn.value?.key === 'index' && sortedTrackColumn.value.order)
  )

  const canRenumberPlaylistTracks = computed(
    () =>
      isSupportedPlaylistTrackNumberList.value &&
      !isRequesting.value &&
      !trackNumberMutationPending.value &&
      songsAreaState.songInfoArr.length > 1 &&
      !hasActiveTrackFilters.value &&
      Boolean(sortedTrackColumn.value) &&
      sortedTrackColumn.value?.key !== 'index'
  )

  const syncPlayingSongListSnapshot = () => {
    if (runtime.playingData.playingSongListUUID !== songsAreaState.songListUUID) return
    runtime.playingData.playingSongListData = [...songsAreaState.songInfoArr]
    const currentPlayingSong = runtime.playingData.playingSong
    if (!currentPlayingSong?.filePath) return
    const currentSetItemId = normalizeSetItemId(currentPlayingSong.setItemId)
    const matchedSong = songsAreaState.songInfoArr.find((song) => {
      if (isSetPlaylistTrackNumberList.value && currentSetItemId) {
        return normalizeSetItemId(song.setItemId) === currentSetItemId
      }
      return normalizePath(song.filePath) === normalizePath(currentPlayingSong.filePath)
    })
    if (!matchedSong) return
    runtime.playingData.playingSong = {
      ...currentPlayingSong,
      playlistTrackNumber: matchedSong.playlistTrackNumber
    }
  }

  const normalizeTrackNumberId = (value: string) =>
    isSetPlaylistTrackNumberList.value ? normalizeSetItemId(value) : normalizePath(value)

  const getTrackNumberId = (song: ISongInfo) =>
    isSetPlaylistTrackNumberList.value
      ? normalizeSetItemId(song.setItemId)
      : String(song.filePath || '').trim()

  const getOrderedTrackNumberIds = (songs: ISongInfo[]) =>
    songs.map(getTrackNumberId).filter(Boolean)

  const isSameOrderAsCurrentTrackNumbers = (orderedIds: string[]) => {
    const currentOrderedIds = getOrderedTrackNumberIds(originalSongInfoArr.value)
    if (currentOrderedIds.length !== orderedIds.length) return false
    return currentOrderedIds.every(
      (id, index) => normalizeTrackNumberId(id) === normalizeTrackNumberId(orderedIds[index])
    )
  }

  const applyOptimisticTrackNumbers = (orderedIds: string[]) => {
    const numberMap = buildNumberMap(orderedIds, normalizeTrackNumberId)
    const songMap = new Map(
      originalSongInfoArr.value.map(
        (song) => [normalizeTrackNumberId(getTrackNumberId(song)), song] as const
      )
    )
    const nextSongs: ISongInfo[] = []
    const used = new Set<string>()
    for (const id of orderedIds) {
      const normalizedId = normalizeTrackNumberId(id)
      const song = songMap.get(normalizedId)
      if (!song || used.has(normalizedId)) continue
      used.add(normalizedId)
      const nextNumber = numberMap.get(normalizedId)
      nextSongs.push({
        ...song,
        playlistTrackNumber: nextNumber
      })
    }
    for (const song of originalSongInfoArr.value) {
      const normalizedId = normalizeTrackNumberId(getTrackNumberId(song))
      if (used.has(normalizedId)) continue
      nextSongs.push({ ...song })
    }
    originalSongInfoArr.value = markRaw(nextSongs)
    applyFiltersAndSorting()
    syncPlayingSongListSnapshot()
  }

  const restoreSnapshot = (snapshot: ISongInfo[]) => {
    originalSongInfoArr.value = markRaw(snapshot.map((song) => ({ ...song })))
    applyFiltersAndSorting()
    syncPlayingSongListSnapshot()
  }

  const showTrackNumberError = async (error: unknown) => {
    const message =
      error instanceof Error && error.message.trim() ? error.message : t('common.unknownError')
    await confirm({
      title: t('common.error'),
      content: [message],
      confirmShow: false
    })
  }

  const persistTrackNumbers = async (orderedIds: string[]) => {
    const songListPath = isSetPlaylistTrackNumberList.value
      ? ''
      : libraryUtils.findDirPathByUuid(songsAreaState.songListUUID)
    if (!isSetPlaylistTrackNumberList.value && !songListPath) {
      throw new Error(t('tracks.playlistTrackNumbersMissingPath'))
    }
    const isNoop = isSameOrderAsCurrentTrackNumbers(orderedIds)
    if (isNoop) {
      try {
        emitter.emit('songsArea/clipboardHint', {
          message: t('tracks.playlistTrackNumbersAlreadyMatchHint')
        })
      } catch {}
      return
    }
    trackNumberMutationPending.value = true
    const snapshotBeforeUpdate = originalSongInfoArr.value.map((song) => ({ ...song }))
    try {
      applyOptimisticTrackNumbers(orderedIds)
      const result = isSetPlaylistTrackNumberList.value
        ? await window.electron.ipcRenderer.invoke('setList:reorder', {
            playlistUuid: songsAreaState.songListUUID,
            orderedIds
          })
        : await window.electron.ipcRenderer.invoke('songList:reorder-track-numbers', {
            songListPath,
            orderedFilePaths: orderedIds
          })
      if (
        isSetPlaylistTrackNumberList.value
          ? result !== true
          : !result?.updated || Number(result?.total || 0) <= 0
      ) {
        throw new Error(t('tracks.playlistTrackNumbersWriteFailed'))
      }
      try {
        emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
        emitter.emit('songsArea/clipboardHint', {
          message: t('tracks.playlistTrackNumbersRenumberedHint', {
            count: orderedIds.length
          })
        })
      } catch {}
    } catch (error) {
      restoreSnapshot(snapshotBeforeUpdate)
      await showTrackNumberError(error)
    } finally {
      trackNumberMutationPending.value = false
    }
  }

  const buildReorderedVisibleSongs = (sourceItemIds: string[], targetIndex: number) => {
    const normalizedSourceSet = new Set(
      sourceItemIds.map((itemId) => normalizeTrackNumberId(itemId)).filter(Boolean)
    )
    const currentVisibleSongs = [...songsAreaState.songInfoArr]
    const moving = currentVisibleSongs.filter((song) =>
      normalizedSourceSet.has(normalizeTrackNumberId(getTrackNumberId(song)))
    )
    if (moving.length === 0) return null
    const remaining = currentVisibleSongs.filter(
      (song) => !normalizedSourceSet.has(normalizeTrackNumberId(getTrackNumberId(song)))
    )
    let insertIndex = remaining.length
    if (targetIndex <= 0) {
      insertIndex = 0
    } else if (targetIndex < currentVisibleSongs.length) {
      const movingBefore = currentVisibleSongs
        .slice(0, Math.min(targetIndex, currentVisibleSongs.length))
        .filter((song) =>
          normalizedSourceSet.has(normalizeTrackNumberId(getTrackNumberId(song)))
        ).length
      insertIndex = Math.max(0, Math.min(remaining.length, targetIndex - movingBefore))
    }
    return [...remaining.slice(0, insertIndex), ...moving, ...remaining.slice(insertIndex)]
  }

  const handlePlaylistReorder = async (payload: {
    sourceItemIds: string[]
    targetIndex: number
  }) => {
    if (!canReorderPlaylistTracks.value) return
    const reorderedVisibleSongs = buildReorderedVisibleSongs(
      payload.sourceItemIds,
      payload.targetIndex
    )
    if (!reorderedVisibleSongs) return
    const isDescending = sortedTrackColumn.value?.order === 'desc'
    const orderedIds = getOrderedTrackNumberIds(
      isDescending ? [...reorderedVisibleSongs].reverse() : reorderedVisibleSongs
    )
    await persistTrackNumbers(orderedIds)
  }

  const handleRenumberTracksByVisibleOrder = async () => {
    if (!canRenumberPlaylistTracks.value) return
    await persistTrackNumbers(getOrderedTrackNumberIds(songsAreaState.songInfoArr))
  }

  return {
    trackNumberMutationPending,
    canReorderPlaylistTracks,
    canRenumberPlaylistTracks,
    handlePlaylistReorder,
    handleRenumberTracksByVisibleOrder
  }
}
