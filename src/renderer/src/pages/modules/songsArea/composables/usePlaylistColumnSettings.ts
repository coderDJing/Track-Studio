import { computed, onScopeDispose, ref, watch, type ComputedRef } from 'vue'
import type {
  ISongsAreaPaneRuntimeState,
  SongsAreaColumnMode,
  useRuntimeStore
} from '@renderer/stores/runtime'
import {
  isPlaylistViewNode,
  usePlaylistViewSettingsStore
} from '@renderer/stores/playlistViewSettings'
import libraryUtils from '@renderer/utils/libraryUtils'
import { cloneSongColumns } from './songColumnStorage'

interface PlaylistColumnSettingsParams {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  columnMode: ComputedRef<SongsAreaColumnMode>
  shouldPersistToLocalStorage: () => boolean
  onSettingsChange: () => void
}

export const usePlaylistColumnSettings = (params: PlaylistColumnSettingsParams) => {
  const { runtime, songsAreaState, columnMode, onSettingsChange } = params
  const store = usePlaylistViewSettingsStore()
  const libraryUuid = computed(() => runtime.libraryTree.uuid)
  const canCustomize = computed(
    () =>
      !!libraryUuid.value &&
      isPlaylistViewNode(libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID))
  )
  const playlistSettings = computed(() =>
    canCustomize.value
      ? store.getPlaylist(
          libraryUuid.value,
          songsAreaState.songListUUID,
          runtime.setting.persistSongFilters
        )
      : undefined
  )
  const independentSettings = computed(() => playlistSettings.value?.enabled === true)
  const effectiveColumns = computed(() =>
    independentSettings.value
      ? playlistSettings.value!.columns
      : store.getSharedColumns(columnMode.value, runtime.setting.persistSongFilters)
  )
  const columnData = ref(cloneSongColumns(effectiveColumns.value))
  let applyingSettings = false
  let restoringPlaylist = false
  let restoreGeneration = 0
  onScopeDispose(() => {
    restoreGeneration += 1
  })
  let sharedCompatibleKeyOnly = songsAreaState.compatibleKeyOnly
  if (independentSettings.value) {
    songsAreaState.compatibleKeyOnly = playlistSettings.value!.compatibleKeyOnly
  }

  watch(
    () => ({
      libraryUuid: libraryUuid.value,
      uuid: songsAreaState.songListUUID,
      mode: columnMode.value,
      independent: independentSettings.value,
      columns: effectiveColumns.value,
      compatible: independentSettings.value ? playlistSettings.value!.compatibleKeyOnly : undefined
    }),
    (next, previous) => {
      const switched =
        next.uuid !== previous.uuid ||
        next.libraryUuid !== previous.libraryUuid ||
        next.mode !== previous.mode
      applyingSettings = true
      try {
        if (switched) {
          sharedCompatibleKeyOnly = false
          restoringPlaylist = true
          const generation = ++restoreGeneration
          // 分栏状态复制会依次赋值 UUID 和兼容开关，等整次复制完成再恢复歌单设置。
          // 这期间禁止把临时的 false 写回独立配置。
          queueMicrotask(() => {
            if (generation !== restoreGeneration) return
            applyingSettings = true
            try {
              songsAreaState.compatibleKeyOnly = independentSettings.value
                ? playlistSettings.value!.compatibleKeyOnly
                : false
            } finally {
              applyingSettings = false
              restoringPlaylist = false
            }
          })
        } else if (next.independent && !previous.independent) {
          sharedCompatibleKeyOnly = songsAreaState.compatibleKeyOnly
        }
        const compatible = next.independent
          ? next.compatible === true
          : switched || previous.independent
            ? sharedCompatibleKeyOnly
            : songsAreaState.compatibleKeyOnly
        const columnsChanged = JSON.stringify(columnData.value) !== JSON.stringify(next.columns)
        const compatibleChanged = songsAreaState.compatibleKeyOnly !== compatible
        if (columnsChanged) columnData.value = cloneSongColumns(next.columns)
        if (compatibleChanged) songsAreaState.compatibleKeyOnly = compatible
        if (!switched && (columnsChanged || compatibleChanged)) onSettingsChange()
      } finally {
        applyingSettings = false
      }
    },
    { flush: 'sync' }
  )

  watch(
    () => songsAreaState.compatibleKeyOnly,
    (compatible) => {
      if (applyingSettings || restoringPlaylist || !independentSettings.value) return
      store.updatePlaylist(
        libraryUuid.value,
        songsAreaState.songListUUID,
        columnData.value,
        compatible
      )
    },
    { flush: 'sync' }
  )

  const persistColumnData = () => {
    if (restoringPlaylist || !params.shouldPersistToLocalStorage()) return
    if (independentSettings.value) {
      store.updatePlaylist(
        libraryUuid.value,
        songsAreaState.songListUUID,
        columnData.value,
        songsAreaState.compatibleKeyOnly
      )
    } else {
      songsAreaState.columnCacheByMode[columnMode.value] = cloneSongColumns(columnData.value)
      store.updateSharedColumns(columnMode.value, columnData.value)
    }
  }

  const resetToSharedSettings = () => {
    store.resetPlaylist(
      libraryUuid.value,
      songsAreaState.songListUUID,
      runtime.setting.persistSongFilters,
      sharedCompatibleKeyOnly
    )
  }

  return { columnData, persistColumnData, independentSettings, resetToSharedSettings }
}
