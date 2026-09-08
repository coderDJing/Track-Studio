import { onMounted, onUnmounted, watch, markRaw, triggerRef } from 'vue'
import emitter from '@renderer/utils/mitt'
import type { Ref, ShallowRef } from 'vue'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from '../../../../../../types/globals'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECORDING_LIBRARY_CHANGED_EVENT, RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import { areSongHotCuesEqual, normalizeSongHotCues } from '@shared/hotCues'
import { areSongMemoryCuesEqual, normalizeSongMemoryCues } from '@shared/memoryCues'
import { normalizeSongEnergyScore } from '@shared/songEnergy'
import { normalizeSongStructureAnalysis, type SongStructureAnalysis } from '@shared/songStructure'
import { normalizeSongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import libraryUtils from '@renderer/utils/libraryUtils'
import { markGlobalSongSearchDirty } from '@renderer/utils/globalSongSearchEvents'
import type { OpenSongListOptions } from './useSongsLoader'
import { isWindowsPathPlatform, normalizeFilePathForComparison } from '@shared/filePathComparison'

type UserOpenedSongListOptions = {
  forceAnalysisPrompt?: boolean
  source?: string
}

interface UseSongsAreaEventsParams {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  applyFiltersAndSorting: () => void
  shouldApplyFiltersAndSortingForSongChange: (fields: string[]) => boolean
  openSongList: (options?: OpenSongListOptions) => Promise<void>
  invalidatePendingSongListLoads: () => void
  scheduleSweepCovers: () => void
  activeWaveformPreviewFilePath?: Ref<string>
  // 用户主动打开/切换到某个歌单（首次挂载或点击切换）后触发；
  // 后台刷新（导入/转换/录音库变化等）不会触发，用于决定是否弹框询问分析。
  onUserOpenedSongList?: (
    songListUUID: string,
    options?: UserOpenedSongListOptions
  ) => void | Promise<void>
}

export function useSongsAreaEvents(params: UseSongsAreaEventsParams) {
  const {
    runtime,
    songsAreaState,
    originalSongInfoArr,
    applyFiltersAndSorting,
    shouldApplyFiltersAndSortingForSongChange,
    openSongList,
    invalidatePendingSongListLoads,
    scheduleSweepCovers,
    activeWaveformPreviewFilePath,
    onUserOpenedSongList
  } = params
  const normalizePath = (value: string | undefined | null) =>
    normalizeFilePathForComparison(
      value,
      isWindowsPathPlatform(runtime.setting.platform || runtime.platform)
    )

  const isSupportedPlaylistTrackNumberList = () => {
    const currentListUUID = songsAreaState.songListUUID
    const node = libraryUtils.getLibraryTreeByUUID(currentListUUID)
    if (node?.type !== 'songList') return false
    const dirPath = String(libraryUtils.findDirPathByUuid(currentListUUID) || '').replace(
      /\\/g,
      '/'
    )
    return (
      dirPath === 'library/FilterLibrary' ||
      dirPath.startsWith('library/FilterLibrary/') ||
      dirPath === 'library/CuratedLibrary' ||
      dirPath.startsWith('library/CuratedLibrary/')
    )
  }

  const renumberPlaylistTrackNumbersIfNeeded = () => {
    if (!isSupportedPlaylistTrackNumberList()) return false
    let changed = false
    const nextSongs = originalSongInfoArr.value.map((song, index) => {
      const nextNumber = index + 1
      if (song.playlistTrackNumber === nextNumber) return song
      changed = true
      return {
        ...song,
        playlistTrackNumber: nextNumber
      }
    })
    if (changed) {
      originalSongInfoArr.value = markRaw(nextSongs)
    }
    return changed
  }

  const syncPlayingSongTrackNumberForCurrentList = () => {
    const currentListUUID = songsAreaState.songListUUID
    if (runtime.playingData.playingSongListUUID !== currentListUUID) return
    runtime.playingData.playingSongListData = songsAreaState.songInfoArr
    const currentPlayingSong = runtime.playingData.playingSong
    if (!currentPlayingSong?.filePath) return
    const matchedSong = songsAreaState.songInfoArr.find(
      (song) => normalizePath(song.filePath) === normalizePath(currentPlayingSong.filePath)
    )
    if (!matchedSong) return
    runtime.playingData.playingSong = {
      ...currentPlayingSong,
      playlistTrackNumber: matchedSong.playlistTrackNumber
    }
  }

  const applyMembershipChange = () => {
    renumberPlaylistTrackNumbersIfNeeded()
    applyFiltersAndSorting()
    syncPlayingSongTrackNumberForCurrentList()
  }

  const stopActiveWaveformPreviewIfRemoved = (
    normalizedRemovedPathSet: Set<string>,
    resumeMainPlayerAfterPreviewStop?: boolean
  ) => {
    const activePreviewPath = normalizePath(activeWaveformPreviewFilePath?.value)
    if (!activePreviewPath || !normalizedRemovedPathSet.has(activePreviewPath)) return

    const currentPlayingPath = normalizePath(runtime.playingData.playingSong?.filePath)
    const currentPlayingRemoved =
      runtime.playingData.playingSongListUUID === songsAreaState.songListUUID &&
      !!currentPlayingPath &&
      normalizedRemovedPathSet.has(currentPlayingPath)

    emitter.emit('waveform-preview:stop', {
      reason: 'switch',
      resumeMain: resumeMainPlayerAfterPreviewStop ?? !currentPlayingRemoved
    })
  }

  const onSongsOptimisticallyRemoved = (payload: {
    listUUID?: string
    paths?: string[]
    resumeMainPlayerAfterPreviewStop?: boolean
  }) => {
    const listUUID = payload?.listUUID
    const currentListUUID = songsAreaState.songListUUID
    if (listUUID && listUUID !== currentListUUID) return
    const pathsToRemove: string[] = Array.isArray(payload?.paths) ? payload.paths : []
    if (!pathsToRemove.length) return
    invalidatePendingSongListLoads()
    const normalizedSet = new Set<string>(
      pathsToRemove.map((p: string) => normalizePath(p)).filter(Boolean)
    )
    const hasIntersection = originalSongInfoArr.value.some((s) =>
      normalizedSet.has(normalizePath(s.filePath))
    )
    if (!hasIntersection) return

    stopActiveWaveformPreviewIfRemoved(normalizedSet, payload?.resumeMainPlayerAfterPreviewStop)

    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (song) => !normalizedSet.has(normalizePath(song.filePath))
    )
    applyMembershipChange()

    if (runtime.playingData.playingSongListUUID === currentListUUID) {
      runtime.playingData.playingSongListData = songsAreaState.songInfoArr
    }

    songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
      (path) => !normalizedSet.has(normalizePath(path))
    )
    scheduleSweepCovers()
  }

  const onSongsOptimisticallyRestored = (payload: {
    listUUID?: string
    items?: Array<{ song: ISongInfo; index: number }>
  }) => {
    const listUUID = payload?.listUUID
    const currentListUUID = songsAreaState.songListUUID
    if (listUUID && listUUID !== currentListUUID) return
    const items = Array.isArray(payload?.items) ? payload.items : []
    if (!items.length) return
    invalidatePendingSongListLoads()

    const current = [...originalSongInfoArr.value]
    const existingSet = new Set(current.map((song) => normalizePath(song.filePath)))
    const filteredItems = items
      .filter(
        (item): item is { song: ISongInfo; index: number } =>
          !!item?.song && typeof item.index === 'number' && Number.isFinite(item.index)
      )
      .filter((item) => !existingSet.has(normalizePath(item.song.filePath)))
      .sort((left, right) => left.index - right.index)
    if (!filteredItems.length) return

    const totalLength = current.length + filteredItems.length
    const restoreBuckets = new Map<number, ISongInfo[]>()
    for (const item of filteredItems) {
      const targetIndex = Math.max(0, Math.min(totalLength, Math.floor(item.index)))
      const bucket = restoreBuckets.get(targetIndex) || []
      bucket.push({ ...item.song })
      restoreBuckets.set(targetIndex, bucket)
    }

    const rebuilt: ISongInfo[] = []
    let currentIndex = 0
    for (let index = 0; index < totalLength; index++) {
      const bucket = restoreBuckets.get(index)
      if (bucket?.length) {
        rebuilt.push(...bucket)
        continue
      }
      const currentSong = current[currentIndex]
      if (currentSong) {
        rebuilt.push(currentSong)
        currentIndex += 1
      }
    }
    const trailingBucket = restoreBuckets.get(totalLength)
    if (trailingBucket?.length) {
      rebuilt.push(...trailingBucket)
    }
    while (currentIndex < current.length) {
      rebuilt.push(current[currentIndex])
      currentIndex += 1
    }

    originalSongInfoArr.value = markRaw(rebuilt)
    applyMembershipChange()

    if (runtime.playingData.playingSongListUUID === currentListUUID) {
      runtime.playingData.playingSongListData = songsAreaState.songInfoArr
    }

    scheduleSweepCovers()
  }

  const onSongsFieldsPatched = (payload: {
    listUUID?: string
    items?: Array<{
      absPath?: string
      trackNumber?: number | null
      addedAtMs?: number | null
    }>
  }) => {
    const listUUID = payload?.listUUID
    const currentListUUID = songsAreaState.songListUUID
    if (listUUID && listUUID !== currentListUUID) return
    const items = Array.isArray(payload?.items) ? payload.items : []
    if (!items.length) return

    const patchByPath = new Map<
      string,
      { trackNumber?: number | null; addedAtMs?: number | null }
    >()
    for (const item of items) {
      const key = normalizePath(item.absPath)
      if (!key) continue
      patchByPath.set(key, item)
    }
    if (!patchByPath.size) return

    let changed = false
    let trackChanged = false
    const nextSongs = originalSongInfoArr.value.map((song) => {
      const patch = patchByPath.get(normalizePath(song.filePath))
      if (!patch) return song
      const next = { ...song }
      if ('trackNumber' in patch) {
        const value =
          typeof patch.trackNumber === 'number' && patch.trackNumber > 0
            ? patch.trackNumber
            : undefined
        if (next.playlistTrackNumber !== value) {
          next.playlistTrackNumber = value
          changed = true
          trackChanged = true
        }
      }
      if ('addedAtMs' in patch) {
        const value =
          typeof patch.addedAtMs === 'number' && Number.isFinite(patch.addedAtMs)
            ? patch.addedAtMs
            : undefined
        if (next.addedAtMs !== value) {
          next.addedAtMs = value
          changed = true
        }
      }
      return next
    })
    if (!changed) return

    if (trackChanged) {
      nextSongs.sort((left, right) => {
        const valueA =
          typeof left.playlistTrackNumber === 'number' && Number.isFinite(left.playlistTrackNumber)
            ? left.playlistTrackNumber
            : Number.MAX_SAFE_INTEGER
        const valueB =
          typeof right.playlistTrackNumber === 'number' &&
          Number.isFinite(right.playlistTrackNumber)
            ? right.playlistTrackNumber
            : Number.MAX_SAFE_INTEGER
        return valueA - valueB
      })
    }

    originalSongInfoArr.value = markRaw(nextSongs)
    applyFiltersAndSorting()
    syncPlayingSongTrackNumberForCurrentList()
  }

  const onSongsRemoved = (payload: {
    listUUID?: string
    paths?: string[]
    itemIds?: string[]
    preservePlaybackForRemovedPaths?: boolean
    resumeMainPlayerAfterPreviewStop?: boolean
  }) => {
    const listUUID = payload?.listUUID
    const itemIds: string[] = Array.isArray(payload?.itemIds) ? payload.itemIds : []
    const currentListUUID = songsAreaState.songListUUID
    const isMixtapeView = libraryUtils.getLibraryTreeByUUID(currentListUUID)?.type === 'mixtapeList'
    const isSetView = libraryUtils.getLibraryTreeByUUID(currentListUUID)?.type === 'setList'
    const resolveItemId = (song: ISongInfo) =>
      isMixtapeView ? song.mixtapeItemId || '' : isSetView ? song.setItemId || '' : ''

    if (itemIds.length > 0) {
      if (!isMixtapeView && !isSetView) return
      if (listUUID && listUUID !== currentListUUID) return
      invalidatePendingSongListLoads()
      const idSet = new Set(itemIds)
      const removedPathSet = new Set(
        originalSongInfoArr.value
          .filter((song) => idSet.has(resolveItemId(song)))
          .map((song) => normalizePath(song.filePath))
          .filter(Boolean)
      )
      const hasIntersection = removedPathSet.size > 0
      if (!hasIntersection) return

      const currentPlayingItemId =
        runtime.playingData.playingSongListUUID === currentListUUID &&
        runtime.playingData.playingSong
          ? resolveItemId(runtime.playingData.playingSong)
          : ''
      const currentPlayingRemoved = !!currentPlayingItemId && idSet.has(currentPlayingItemId)
      stopActiveWaveformPreviewIfRemoved(
        removedPathSet,
        payload?.resumeMainPlayerAfterPreviewStop ?? !currentPlayingRemoved
      )

      originalSongInfoArr.value = originalSongInfoArr.value.filter(
        (song) => !idSet.has(resolveItemId(song))
      )
      applyFiltersAndSorting()

      if (runtime.playingData.playingSongListUUID === currentListUUID) {
        runtime.playingData.playingSongListData = songsAreaState.songInfoArr
        if (
          runtime.playingData.playingSong &&
          idSet.has(resolveItemId(runtime.playingData.playingSong))
        ) {
          runtime.playingData.playingSong = null
        }
      }

      songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
        (key) => !idSet.has(key)
      )

      scheduleSweepCovers()
      return
    }

    const pathsToRemove: string[] = Array.isArray(payload?.paths) ? payload.paths : []
    if (!pathsToRemove.length) return
    const normalizedSet = new Set<string>(
      pathsToRemove.map((p: string) => normalizePath(p)).filter(Boolean)
    )
    const hasIntersection = originalSongInfoArr.value.some((s) =>
      normalizedSet.has(normalizePath(s.filePath))
    )

    if ((listUUID === currentListUUID && normalizedSet.size > 0) || hasIntersection) {
      invalidatePendingSongListLoads()
    }
    // 任意视图：仅在当前列表与要移除的路径存在交集时才更新，避免误删与不必要重建
    if (!hasIntersection) return

    stopActiveWaveformPreviewIfRemoved(normalizedSet, payload?.resumeMainPlayerAfterPreviewStop)

    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (song) => !normalizedSet.has(normalizePath(song.filePath))
    )

    applyMembershipChange()

    if (runtime.playingData.playingSongListUUID === songsAreaState.songListUUID) {
      runtime.playingData.playingSongListData = songsAreaState.songInfoArr
      if (
        !payload?.preservePlaybackForRemovedPaths &&
        runtime.playingData.playingSong &&
        normalizedSet.has(normalizePath(runtime.playingData.playingSong.filePath))
      ) {
        runtime.playingData.playingSong = null
      }
    }

    songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
      (path) => !normalizedSet.has(normalizePath(path))
    )

    scheduleSweepCovers()
  }

  const onSongsMovedByDrag = (
    payload:
      | string[]
      | {
          paths?: string[]
          preservePlaybackForRemovedPaths?: boolean
          resumeMainPlayerAfterPreviewStop?: boolean
        }
  ) => {
    if (libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type === 'mixtapeList') {
      return
    }
    const movedSongPaths = Array.isArray(payload) ? payload : payload?.paths || []
    if (!Array.isArray(movedSongPaths) || movedSongPaths.length === 0) return
    const normalizedMovedSet = new Set(
      movedSongPaths.map((path) => normalizePath(path)).filter(Boolean)
    )
    const hasIntersection = originalSongInfoArr.value.some((song) =>
      normalizedMovedSet.has(normalizePath(song.filePath))
    )
    if (hasIntersection) invalidatePendingSongListLoads()
    stopActiveWaveformPreviewIfRemoved(
      normalizedMovedSet,
      Array.isArray(payload) ? undefined : payload?.resumeMainPlayerAfterPreviewStop
    )

    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (song) => !normalizedMovedSet.has(normalizePath(song.filePath))
    )
    applyMembershipChange()
    scheduleSweepCovers()

    if (runtime.playingData.playingSongListUUID === songsAreaState.songListUUID) {
      runtime.playingData.playingSongListData = songsAreaState.songInfoArr
      if (
        !(Array.isArray(payload) ? false : payload?.preservePlaybackForRemovedPaths) &&
        runtime.playingData.playingSong &&
        normalizedMovedSet.has(normalizePath(runtime.playingData.playingSong.filePath))
      ) {
        runtime.playingData.playingSong = null
      }
    }

    songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
      (path) => !normalizedMovedSet.has(normalizePath(path))
    )
  }

  const onExternalPlaylistRefresh = () => {
    if (songsAreaState.songListUUID !== EXTERNAL_PLAYLIST_UUID) return
    void openSongList().catch(() => {})
  }

  let keyUpdateScheduled = false
  type SongPatchFn = (song: ISongInfo) => ISongInfo
  const scheduleApply = () => {
    if (keyUpdateScheduled) return
    keyUpdateScheduled = true
    requestAnimationFrame(() => {
      keyUpdateScheduled = false
      applyFiltersAndSorting()
    })
  }

  const scheduleApplyIfNeeded = (fields: string[]) => {
    if (!shouldApplyFiltersAndSortingForSongChange(fields)) return
    scheduleApply()
  }

  const findSongIndexByPath = (songs: readonly ISongInfo[], normalizedTargetPath: string) => {
    for (let index = 0; index < songs.length; index += 1) {
      if (normalizePath(songs[index]?.filePath) === normalizedTargetPath) {
        return index
      }
    }
    return -1
  }

  const patchSongListAtIndex = (songs: ISongInfo[], index: number, patch: SongPatchFn) => {
    if (index < 0 || index >= songs.length) return false
    const currentSong = songs[index]
    if (!currentSong) return false
    const nextSong = patch(currentSong)
    if (nextSong === currentSong) return false
    songs[index] = nextSong
    return true
  }

  const patchSongListByPath = (
    songs: ISongInfo[] | null | undefined,
    normalizedTargetPath: string,
    patch: SongPatchFn
  ) => {
    if (!songs?.length) return false
    const targetIndex = findSongIndexByPath(songs, normalizedTargetPath)
    return patchSongListAtIndex(songs, targetIndex, patch)
  }

  const patchOriginalSongByPath = (normalizedTargetPath: string, patch: SongPatchFn) => {
    const touched = patchSongListByPath(originalSongInfoArr.value, normalizedTargetPath, patch)
    if (touched) {
      triggerRef(originalSongInfoArr)
    }
    return touched
  }

  const patchSongsAreaSongByPath = (normalizedTargetPath: string, patch: SongPatchFn) =>
    patchSongListByPath(songsAreaState.songInfoArr, normalizedTargetPath, patch)

  const patchPlayingSongListByPath = (normalizedTargetPath: string, patch: SongPatchFn) => {
    if (runtime.playingData.playingSongListData === songsAreaState.songInfoArr) return false
    return patchSongListByPath(runtime.playingData.playingSongListData, normalizedTargetPath, patch)
  }

  const patchExternalPlaylistSongByPath = (normalizedTargetPath: string, patch: SongPatchFn) =>
    patchSongListByPath(runtime.externalPlaylist.songs, normalizedTargetPath, patch)

  const patchPlayingSongByPath = (normalizedTargetPath: string, patch: SongPatchFn) => {
    const currentPlayingSong = runtime.playingData.playingSong
    if (!currentPlayingSong) return false
    if (normalizePath(currentPlayingSong.filePath) !== normalizedTargetPath) return false
    const nextPlayingSong = patch(currentPlayingSong)
    if (nextPlayingSong === currentPlayingSong) return false
    runtime.playingData.playingSong = nextPlayingSong
    return true
  }

  type SongGridUpdatePayload = {
    filePath?: string
    timeBasisOffsetMs?: number
    beatGridMap?: ISongInfo['beatGridMap'] | null
  }

  type PreparedSongGridPatch = {
    normalizedTargetPath: string
    timeBasisOffsetMs?: number
    hasTimeBasisOffsetMs: boolean
    hasBeatGridMapPayload: boolean
    nextBeatGridMap: ISongInfo['beatGridMap'] | null
    shouldClearBeatGridMap: boolean
  }

  const prepareSongGridPatch = (
    payload: SongGridUpdatePayload | null | undefined
  ): PreparedSongGridPatch | null => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    if (!filePath) return null
    const hasTimeBasisOffsetMs =
      typeof payload?.timeBasisOffsetMs === 'number' && Number.isFinite(payload.timeBasisOffsetMs)
    const hasBeatGridMapPayload = Object.prototype.hasOwnProperty.call(payload, 'beatGridMap')
    if (!hasTimeBasisOffsetMs && !hasBeatGridMapPayload) return null
    const nextBeatGridMap = normalizeSongBeatGridMapV2(payload?.beatGridMap, {
      allowSingleClip: true
    })
    return {
      normalizedTargetPath: normalizePath(filePath),
      timeBasisOffsetMs: payload?.timeBasisOffsetMs,
      hasTimeBasisOffsetMs,
      hasBeatGridMapPayload,
      nextBeatGridMap,
      shouldClearBeatGridMap: hasBeatGridMapPayload && payload?.beatGridMap === null
    }
  }

  const applyPreparedSongGridPatch = (song: ISongInfo, patch: PreparedSongGridPatch) => {
    let touched = false
    const nextSong: ISongInfo = { ...song }
    if (patch.nextBeatGridMap) {
      if (nextSong.beatGridMap?.signature !== patch.nextBeatGridMap.signature) {
        nextSong.beatGridMap = patch.nextBeatGridMap
        touched = true
      }
    } else if (patch.shouldClearBeatGridMap && nextSong.beatGridMap !== undefined) {
      delete nextSong.beatGridMap
      touched = true
    }
    if (patch.hasTimeBasisOffsetMs && nextSong.timeBasisOffsetMs !== patch.timeBasisOffsetMs) {
      nextSong.timeBasisOffsetMs = patch.timeBasisOffsetMs
      touched = true
    }
    return touched ? nextSong : song
  }

  const patchSongListByGridPatchMap = (
    songs: ISongInfo[] | null | undefined,
    patchByPath: Map<string, PreparedSongGridPatch>
  ) => {
    if (!songs?.length || patchByPath.size === 0) return false
    let touched = false
    for (let index = 0; index < songs.length; index += 1) {
      const song = songs[index]
      const patch = patchByPath.get(normalizePath(song?.filePath))
      if (!song || !patch) continue
      const nextSong = applyPreparedSongGridPatch(song, patch)
      if (nextSong === song) continue
      songs[index] = nextSong
      touched = true
    }
    return touched
  }

  const applySongGridUpdates = (payloads: SongGridUpdatePayload[]) => {
    const preparedPatches = payloads
      .map((payload) => prepareSongGridPatch(payload))
      .filter((patch): patch is PreparedSongGridPatch => patch !== null)
    if (preparedPatches.length === 0) return
    const patchByPath = new Map(
      preparedPatches.map((patch) => [patch.normalizedTargetPath, patch] as const)
    )
    const changedFields = Array.from(
      new Set(
        preparedPatches.flatMap((patch) => [
          patch.hasTimeBasisOffsetMs ? 'timeBasisOffsetMs' : '',
          patch.hasBeatGridMapPayload ? 'beatGridMap' : ''
        ])
      )
    ).filter(Boolean)

    const originalTouched = patchSongListByGridPatchMap(originalSongInfoArr.value, patchByPath)
    if (originalTouched) {
      triggerRef(originalSongInfoArr)
      scheduleApplyIfNeeded(changedFields)
    }
    patchSongListByGridPatchMap(songsAreaState.songInfoArr, patchByPath)

    const currentPlayingSong = runtime.playingData.playingSong
    if (currentPlayingSong) {
      const patch = patchByPath.get(normalizePath(currentPlayingSong.filePath))
      if (patch) {
        const nextPlayingSong = applyPreparedSongGridPatch(currentPlayingSong, patch)
        if (nextPlayingSong !== currentPlayingSong) {
          runtime.playingData.playingSong = nextPlayingSong
        }
      }
    }
    if (runtime.playingData.playingSongListData !== songsAreaState.songInfoArr) {
      patchSongListByGridPatchMap(runtime.playingData.playingSongListData, patchByPath)
    }
    patchSongListByGridPatchMap(runtime.externalPlaylist.songs, patchByPath)
  }

  const onSongKeyUpdated = (_e: unknown, payload: { filePath?: string; keyText?: string }) => {
    const filePath = payload?.filePath
    const keyText = payload?.keyText
    if (!filePath || typeof keyText !== 'string') return
    const normalizedTargetPath = normalizePath(filePath)

    const applyKeyPatch = (song: ISongInfo): ISongInfo =>
      song.key === keyText
        ? song
        : {
            ...song,
            key: keyText
          }

    if (patchOriginalSongByPath(normalizedTargetPath, applyKeyPatch)) {
      scheduleApplyIfNeeded(['key'])
    }

    patchSongsAreaSongByPath(normalizedTargetPath, applyKeyPatch)
    patchPlayingSongByPath(normalizedTargetPath, applyKeyPatch)
    patchPlayingSongListByPath(normalizedTargetPath, applyKeyPatch)
    patchExternalPlaylistSongByPath(normalizedTargetPath, applyKeyPatch)
  }

  const onSongEnergyUpdated = (
    _e: unknown,
    payload: {
      filePath?: string
      energyScore?: number
      energyAlgorithmVersion?: number
    }
  ) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    const energyScore = normalizeSongEnergyScore(payload?.energyScore)
    if (!filePath || energyScore === undefined) return
    const normalizedTargetPath = normalizePath(filePath)
    const rawEnergyAlgorithmVersion = payload?.energyAlgorithmVersion
    const energyAlgorithmVersion =
      typeof rawEnergyAlgorithmVersion === 'number' &&
      Number.isFinite(rawEnergyAlgorithmVersion) &&
      rawEnergyAlgorithmVersion > 0
        ? Math.floor(rawEnergyAlgorithmVersion)
        : undefined

    const applyEnergyPatch = (song: ISongInfo): ISongInfo => {
      if (
        song.energyScore === energyScore &&
        (energyAlgorithmVersion === undefined ||
          song.energyAlgorithmVersion === energyAlgorithmVersion)
      ) {
        return song
      }
      return {
        ...song,
        energyScore,
        energyAlgorithmVersion: energyAlgorithmVersion ?? song.energyAlgorithmVersion
      }
    }

    const changedFields = [
      'energyScore',
      energyAlgorithmVersion !== undefined ? 'energyAlgorithmVersion' : ''
    ].filter(Boolean)

    if (patchOriginalSongByPath(normalizedTargetPath, applyEnergyPatch)) {
      scheduleApplyIfNeeded(changedFields)
    }

    patchSongsAreaSongByPath(normalizedTargetPath, applyEnergyPatch)
    patchPlayingSongByPath(normalizedTargetPath, applyEnergyPatch)
    patchPlayingSongListByPath(normalizedTargetPath, applyEnergyPatch)
    patchExternalPlaylistSongByPath(normalizedTargetPath, applyEnergyPatch)
  }

  const onSongStructureUpdated = (
    _e: unknown,
    payload: {
      filePath?: string
      songStructure?: SongStructureAnalysis
    }
  ) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    if (!filePath) return
    const songStructure = normalizeSongStructureAnalysis(payload?.songStructure)
    if (!songStructure) return
    const normalizedTargetPath = normalizePath(filePath)
    const signature = JSON.stringify(songStructure)

    const applyStructurePatch = (song: ISongInfo): ISongInfo => {
      if (JSON.stringify(normalizeSongStructureAnalysis(song.songStructure)) === signature) {
        return song
      }
      return {
        ...song,
        songStructure
      }
    }

    if (patchOriginalSongByPath(normalizedTargetPath, applyStructurePatch)) {
      scheduleApplyIfNeeded(['songStructure'])
    }

    patchSongsAreaSongByPath(normalizedTargetPath, applyStructurePatch)
    patchPlayingSongByPath(normalizedTargetPath, applyStructurePatch)
    patchPlayingSongListByPath(normalizedTargetPath, applyStructurePatch)
    patchExternalPlaylistSongByPath(normalizedTargetPath, applyStructurePatch)
  }

  const onSongGridUpdated = (_e: unknown, payload: SongGridUpdatePayload) => {
    applySongGridUpdates([payload])
  }

  const onSongGridBatchUpdated = (_e: unknown, payloads: SongGridUpdatePayload[]) => {
    if (!Array.isArray(payloads)) return
    applySongGridUpdates(payloads)
  }

  const onSongHotCuesUpdated = (
    _e: unknown,
    payload: {
      filePath?: string
      hotCues?: ISongHotCue[]
    }
  ) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    if (!filePath) return
    const normalizedTargetPath = normalizePath(filePath)
    const normalizedHotCues = normalizeSongHotCues(payload?.hotCues)

    const applyHotCuePatch = (song: ISongInfo): ISongInfo => {
      if (areSongHotCuesEqual(song.hotCues, normalizedHotCues)) return song
      return {
        ...song,
        hotCues: normalizedHotCues
      }
    }

    patchOriginalSongByPath(normalizedTargetPath, applyHotCuePatch)
    patchSongsAreaSongByPath(normalizedTargetPath, applyHotCuePatch)
    patchPlayingSongByPath(normalizedTargetPath, applyHotCuePatch)
    patchPlayingSongListByPath(normalizedTargetPath, applyHotCuePatch)
    patchExternalPlaylistSongByPath(normalizedTargetPath, applyHotCuePatch)
  }

  const onSongMemoryCuesUpdated = (
    _e: unknown,
    payload: {
      filePath?: string
      memoryCues?: ISongMemoryCue[]
    }
  ) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
    if (!filePath) return
    const normalizedTargetPath = normalizePath(filePath)
    const normalizedMemoryCues = normalizeSongMemoryCues(payload?.memoryCues)

    const applyMemoryCuePatch = (song: ISongInfo): ISongInfo => {
      if (areSongMemoryCuesEqual(song.memoryCues, normalizedMemoryCues)) return song
      return {
        ...song,
        memoryCues: normalizedMemoryCues
      }
    }

    patchOriginalSongByPath(normalizedTargetPath, applyMemoryCuePatch)
    patchSongsAreaSongByPath(normalizedTargetPath, applyMemoryCuePatch)
    patchPlayingSongByPath(normalizedTargetPath, applyMemoryCuePatch)
    patchPlayingSongListByPath(normalizedTargetPath, applyMemoryCuePatch)
    patchExternalPlaylistSongByPath(normalizedTargetPath, applyMemoryCuePatch)
  }

  const onImportFinished = async (_event: unknown, songListUUID: string, _summary: unknown) => {
    if (runtime.openSongListAfterImportUUID === songListUUID) {
      runtime.openSongListAfterImportUUID = ''
      if (!songsAreaState.songListUUID) {
        songsAreaState.songListUUID = songListUUID
      }
      return
    }
    if (songListUUID === songsAreaState.songListUUID) {
      setTimeout(async () => {
        await openSongList({ waitForFreshAnalysisFields: true })
        // 通知库侧刷新歌单曲目数量徽标
        try {
          emitter.emit('playlistContentChanged', { uuids: [songListUUID] })
        } catch {}
        // 导入到当前歌单后，复用“用户主动打开歌单”的询问分析逻辑：
        // 列表已刷新且用户仍停留在该歌单时，弹框询问是否分析新导入的曲目。
        notifyUserOpenedSongList(songListUUID, {
          forceAnalysisPrompt: true,
          source: 'import-finished-current-list'
        })
      }, 1000)
      return
    }
    try {
      emitter.emit('playlistContentChanged', { uuids: [songListUUID] })
    } catch {}
  }

  const onAudioConvertDone = async (_event: unknown, payload?: { songListUUID?: string }) => {
    const listUUID = payload?.songListUUID
    if (!listUUID) return
    if (listUUID === songsAreaState.songListUUID) {
      setTimeout(async () => {
        await openSongList()
        try {
          emitter.emit('playlistContentChanged', { uuids: [listUUID] })
        } catch {}
      }, 300)
      return
    }
    try {
      emitter.emit('playlistContentChanged', { uuids: [listUUID] })
    } catch {}
  }

  const onReloadCurrentSongList = (payload?: { uuid?: string; scanData?: ISongInfo[] }) => {
    const listUUID = String(payload?.uuid || '').trim()
    if (!listUUID || listUUID !== songsAreaState.songListUUID) return
    const scanData = Array.isArray(payload?.scanData) ? payload.scanData : []
    if (!scanData.length) {
      void openSongList().catch(() => {})
      return
    }
    originalSongInfoArr.value = markRaw(scanData)
    applyFiltersAndSorting()
    markGlobalSongSearchDirty('scanSongList', { songListUUID: listUUID })
  }

  const loadCurrentSongList = async (
    songListUUID: string,
    options?: {
      resetSelection?: boolean
      notifyUserOpened?: boolean
      forceAnalysisPrompt?: boolean
      source?: string
    }
  ) => {
    if (options?.resetSelection) {
      songsAreaState.selectedSongFilePath.length = 0
    }
    if (!songListUUID) {
      invalidatePendingSongListLoads()
      songsAreaState.songInfoArr = []
      songsAreaState.missingWaveformFilePaths = []
      songsAreaState.totalSongCount = 0
      originalSongInfoArr.value = []
      return
    }
    await openSongList({ waitForFreshAnalysisFields: options?.notifyUserOpened === true })
    if (options?.notifyUserOpened) {
      notifyUserOpenedSongList(songListUUID, {
        ...options,
        source: options.source || 'song-list-load'
      })
    }
  }

  const onNoAudioFileWasScanned = () => {
    runtime.openSongListAfterImportUUID = ''
  }

  // 仅当加载完成后用户仍停留在同一歌单时，才通知“用户主动打开了此歌单”
  const notifyUserOpenedSongList = (songListUUID: string, options?: UserOpenedSongListOptions) => {
    if (!onUserOpenedSongList) return
    if (songsAreaState.songListUUID !== songListUUID) return
    void Promise.resolve(onUserOpenedSongList(songListUUID, options)).catch(() => {})
  }

  // 记录当前 pane 已“打开过”的歌单（无论是否弹框）。
  // 用于区分“真正切换到新歌单”与“程序化 '' → 原值 伪切换 / 组件重挂载”，避免后者重复弹框。
  let lastOpenedUUID = ''

  const onRecordingLibraryChanged = () => {
    if (songsAreaState.songListUUID !== RECORDING_LIBRARY_UUID) return
    void openSongList().catch(() => {})
  }

  const onSetListItemsChanged = (payload?: { uuids?: string[] } | null) => {
    const uuids = Array.isArray(payload?.uuids) ? payload.uuids : []
    if (!songsAreaState.songListUUID || !uuids.includes(songsAreaState.songListUUID)) return
    if (libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type !== 'setList') return
    void openSongList().catch(() => {})
  }

  onMounted(() => {
    emitter.on('songsArea/optimistic-remove', onSongsOptimisticallyRemoved)
    emitter.on('songsArea/optimistic-restore', onSongsOptimisticallyRestored)
    emitter.on('songsArea/sync-fields', onSongsFieldsPatched)
    emitter.on('songsRemoved', onSongsRemoved)
    emitter.on('songsMovedByDrag', onSongsMovedByDrag)
    emitter.on('external-playlist/refresh', onExternalPlaylistRefresh)
    window.electron.ipcRenderer.on('song-key-updated', onSongKeyUpdated)
    window.electron.ipcRenderer.on('song-energy-updated', onSongEnergyUpdated)
    window.electron.ipcRenderer.on('song-structure-updated', onSongStructureUpdated)
    window.electron.ipcRenderer.on('song-grid-batch-updated', onSongGridBatchUpdated)
    window.electron.ipcRenderer.on('song-grid-updated', onSongGridUpdated)
    window.electron.ipcRenderer.on('song-hot-cues-updated', onSongHotCuesUpdated)
    window.electron.ipcRenderer.on('song-memory-cues-updated', onSongMemoryCuesUpdated)
    window.electron.ipcRenderer.on('importFinished', onImportFinished)
    window.electron.ipcRenderer.on('noAudioFileWasScanned', onNoAudioFileWasScanned)
    window.electron.ipcRenderer.on('audio:convert:done', onAudioConvertDone)
    window.electron.ipcRenderer.on(RECORDING_LIBRARY_CHANGED_EVENT, onRecordingLibraryChanged)
    emitter.on(RECORDING_LIBRARY_CHANGED_EVENT, onRecordingLibraryChanged)
    emitter.on('setList/itemsChanged', onSetListItemsChanged)
    emitter.on('songsArea/reload-if-current', onReloadCurrentSongList)
    // 组件挂载（含切分屏/进出 Pioneer 等导致的重挂载）恢复已有歌单时不弹框，
    // 仅记录已打开的歌单，待用户真正切换歌单时才询问。
    lastOpenedUUID = songsAreaState.songListUUID || ''
    void loadCurrentSongList(songsAreaState.songListUUID).catch(() => {})
  })

  onUnmounted(() => {
    emitter.off('songsArea/optimistic-remove', onSongsOptimisticallyRemoved)
    emitter.off('songsArea/optimistic-restore', onSongsOptimisticallyRestored)
    emitter.off('songsArea/sync-fields', onSongsFieldsPatched)
    emitter.off('songsRemoved', onSongsRemoved)
    emitter.off('songsMovedByDrag', onSongsMovedByDrag)
    emitter.off('external-playlist/refresh', onExternalPlaylistRefresh)
    window.electron.ipcRenderer.removeListener('song-key-updated', onSongKeyUpdated)
    window.electron.ipcRenderer.removeListener('song-energy-updated', onSongEnergyUpdated)
    window.electron.ipcRenderer.removeListener('song-structure-updated', onSongStructureUpdated)
    window.electron.ipcRenderer.removeListener('song-grid-batch-updated', onSongGridBatchUpdated)
    window.electron.ipcRenderer.removeListener('song-grid-updated', onSongGridUpdated)
    window.electron.ipcRenderer.removeListener('song-hot-cues-updated', onSongHotCuesUpdated)
    window.electron.ipcRenderer.removeListener('song-memory-cues-updated', onSongMemoryCuesUpdated)
    window.electron.ipcRenderer.removeListener('importFinished', onImportFinished)
    window.electron.ipcRenderer.removeListener('noAudioFileWasScanned', onNoAudioFileWasScanned)
    window.electron.ipcRenderer.removeListener('audio:convert:done', onAudioConvertDone)
    window.electron.ipcRenderer.removeListener(
      RECORDING_LIBRARY_CHANGED_EVENT,
      onRecordingLibraryChanged
    )
    emitter.off(RECORDING_LIBRARY_CHANGED_EVENT, onRecordingLibraryChanged)
    emitter.off('setList/itemsChanged', onSetListItemsChanged)
    emitter.off('songsArea/reload-if-current', onReloadCurrentSongList)
  })

  // 切换歌单时刷新列表
  watch(
    () => songsAreaState.songListUUID,
    async (newUUID) => {
      // 仅在真正切换到“此前未打开过的非空歌单”时才询问分析；
      // 程序化的 '' → 原值 伪切换（如把歌曲移动到当前歌单后强制刷新）目标仍是已打开歌单，不弹框。
      const notifyUserOpened = !!newUUID && newUUID !== lastOpenedUUID
      if (newUUID) lastOpenedUUID = newUUID
      await loadCurrentSongList(newUUID, {
        resetSelection: true,
        notifyUserOpened,
        source: 'song-list-watch'
      })
    }
  )

  // 同步 songsArea 与 playingData.playingSongListData
  watch(
    () => runtime.playingData.playingSongListData,
    (newPlayingListData) => {
      const currentSongsAreaListUUID = songsAreaState.songListUUID
      const currentPlayingListUUID = runtime.playingData.playingSongListUUID

      if (currentSongsAreaListUUID && currentSongsAreaListUUID === currentPlayingListUUID) {
        const songsInArea = songsAreaState.songInfoArr
        if (!songsInArea || songsInArea.length === 0) return

        const areaFilePaths = new Set(songsInArea.map((s) => s.filePath))
        const playingListFilePaths = new Set((newPlayingListData || []).map((s) => s.filePath))

        const pathsToRemove: string[] = []
        areaFilePaths.forEach((filePath) => {
          if (!playingListFilePaths.has(filePath)) {
            pathsToRemove.push(filePath)
          }
        })

        if (pathsToRemove.length > 0) {
          originalSongInfoArr.value = originalSongInfoArr.value.filter(
            (item) => !pathsToRemove.includes(item.filePath)
          )
          applyFiltersAndSorting()
          songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.filter(
            (path) => !pathsToRemove.includes(path)
          )
        }
      }
    },
    { deep: true }
  )
}
