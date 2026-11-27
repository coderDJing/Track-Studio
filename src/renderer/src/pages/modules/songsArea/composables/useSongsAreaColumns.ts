import { sortSongColumns } from '@renderer/utils/songListColumnSort'
import { filterSongColumns } from '@renderer/utils/songListColumnFilters'
import { computed, ref, toRaw, watch, type ShallowRef } from 'vue'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'
import type {
  ISongsAreaPaneRuntimeState,
  SongsAreaColumnMode,
  useRuntimeStore
} from '@renderer/stores/runtime'
import { getKeySortText, isHarmonicMixCompatible } from '@shared/keyDisplay'
import { useHarmonicReferenceKey } from '@renderer/composables/useHarmonicReferenceKey'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import { getOriginalPlaylistDisplay } from '@renderer/utils/recycleBinDisplay'
import { resolveSongBeatGridV2BpmSortValue } from '@shared/songBeatGridMapV2'
import libraryUtils from '@renderer/utils/libraryUtils'
import { getSongListFieldRawValue } from '@renderer/utils/songListFieldDisplay'
import { filterSongsByPlaylistSearch } from '@renderer/utils/playlistSongSearch'
import { usePlaylistColumnSettings } from './usePlaylistColumnSettings'
import { getNeteaseDownloadStatusRank } from '@renderer/utils/neteaseDownloadStatus'
export {
  buildSongsAreaDefaultColumns,
  getSongsAreaMinWidthByKey,
  SONGS_AREA_MIXTAPE_STORAGE_KEY
} from './songColumnStorage'
import { isDefaultLikeColumnMode, resolveSongsAreaColumnMode } from './songColumnStorage'

interface UseSongsAreaColumnsParams {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  shouldPersistToLocalStorage: () => boolean
}

export function useSongsAreaColumns(params: UseSongsAreaColumnsParams) {
  const { runtime, songsAreaState, originalSongInfoArr } = params
  const harmonicReferenceKey = useHarmonicReferenceKey(runtime)
  const compatibleKeyFilterActive = computed(
    () => songsAreaState.compatibleKeyOnly && runtime.mainWindowBrowseMode !== 'browser'
  )

  const getSongField = (song: ISongInfo, key: string): unknown =>
    getSongListFieldRawValue(song, key)

  const isRecycleBinView = computed(() => songsAreaState.songListUUID === RECYCLE_BIN_UUID)
  const isRecordingLibraryView = computed(
    () => songsAreaState.songListUUID === RECORDING_LIBRARY_UUID
  )
  const isMixtapeView = computed(
    () => libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type === 'mixtapeList'
  )
  const isSetView = computed(
    () => libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type === 'setList'
  )
  const columnMode = computed<SongsAreaColumnMode>(() =>
    resolveSongsAreaColumnMode(
      songsAreaState.songListUUID,
      isMixtapeView.value
        ? 'mixtapeList'
        : libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type
    )
  )
  const canUsePlaylistTrackNumberForIndex = computed(() => {
    if (columnMode.value !== 'default') return false
    if (isSetView.value) return true
    const dirPath = String(
      libraryUtils.findDirPathByUuid(songsAreaState.songListUUID) || ''
    ).replace(/\\/g, '/')
    return (
      dirPath === 'library/FilterLibrary' ||
      dirPath.startsWith('library/FilterLibrary/') ||
      dirPath === 'library/CuratedLibrary' ||
      dirPath.startsWith('library/CuratedLibrary/')
    )
  })

  const { columnData, persistColumnData, resetToSharedSettings, independentSettings } =
    usePlaylistColumnSettings({ ...params, columnMode, onSettingsChange: applyChangedSettings })

  function applyChangedSettings() {
    applyFiltersAndSorting()
    const visible = new Set(songsAreaState.songInfoArr.map(getSongSelectionKey))
    const selected = songsAreaState.selectedSongFilePath
    if (selected.some((key) => !visible.has(key))) {
      songsAreaState.selectedSongFilePath = selected.filter((key) => visible.has(key))
    }
    if (runtime.playingData.playingSongListUUID === songsAreaState.songListUUID) {
      runtime.playingData.playingSongListData = songsAreaState.songInfoArr
    }
  }

  function getSongSelectionKey(song: ISongInfo) {
    if (isMixtapeView.value) return song.mixtapeItemId || song.filePath
    if (isSetView.value) return song.setItemId || song.filePath
    return song.filePath
  }

  // --- 根据列筛选过滤并按当前排序排序 ---
  const applyVisibleSongs = (songs: ISongInfo[]) => {
    const current = songsAreaState.songInfoArr
    if (
      current.length === songs.length &&
      current.every((song, index) => toRaw(song) === toRaw(songs[index]))
    ) {
      return
    }
    songsAreaState.songInfoArr = songs
  }

  function applyFiltersAndSorting() {
    let filtered = [...originalSongInfoArr.value]
    if (songsAreaState.totalSongCount !== filtered.length) {
      songsAreaState.totalSongCount = filtered.length
    }
    filtered = filterSongsByPlaylistSearch(
      filtered,
      songsAreaState.searchQuery,
      columnData.value.map((col) => col.key),
      {
        keyDisplayStyle: runtime.setting.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic',
        isDesktopRekordboxSong: false
      }
    )
    if (compatibleKeyFilterActive.value) {
      filtered = filtered.filter((song) =>
        isHarmonicMixCompatible(harmonicReferenceKey.value, String(song.key || ''))
      )
    }
    filtered = filterSongColumns(filtered, columnData.value, {
      keyStyle: runtime.setting.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic',
      curatedArtists: runtime.curatedArtistFavorites
    })

    if (columnMode.value === 'mixtape') {
      applyVisibleSongs(filtered)
      return
    }

    const sortedCol = columnData.value.find((c) => c.order)
    if (sortedCol) {
      if (sortedCol.key === 'index') {
        if (canUsePlaylistTrackNumberForIndex.value) {
          filtered = [...filtered].sort((a, b) => {
            const valueA =
              typeof a.playlistTrackNumber === 'number' && Number.isFinite(a.playlistTrackNumber)
                ? a.playlistTrackNumber
                : Number.MAX_SAFE_INTEGER
            const valueB =
              typeof b.playlistTrackNumber === 'number' && Number.isFinite(b.playlistTrackNumber)
                ? b.playlistTrackNumber
                : Number.MAX_SAFE_INTEGER
            if (valueA === valueB) {
              const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
              return collator.compare(String(a.filePath || ''), String(b.filePath || ''))
            }
            return sortedCol.order === 'asc' ? valueA - valueB : valueB - valueA
          })
        } else if (sortedCol.order === 'desc') {
          filtered = [...filtered].reverse()
        }
      } else if (sortedCol.key === 'key') {
        const style = runtime.setting.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
        const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
        filtered = [...filtered].sort((a, b) => {
          const valueA = getKeySortText(String(a.key || ''), style)
          const valueB = getKeySortText(String(b.key || ''), style)
          const emptyA = valueA.trim() === ''
          const emptyB = valueB.trim() === ''
          if (emptyA && emptyB) return 0
          if (emptyA) return 1
          if (emptyB) return -1
          return sortedCol.order === 'asc'
            ? collator.compare(valueA, valueB)
            : collator.compare(valueB, valueA)
        })
      } else if (sortedCol.key === 'deletedAtMs' || sortedCol.key === 'addedAtMs') {
        filtered = [...filtered].sort((a, b) => {
          const valueA = Number(sortedCol.key === 'deletedAtMs' ? a.deletedAtMs : a.addedAtMs)
          const valueB = Number(sortedCol.key === 'deletedAtMs' ? b.deletedAtMs : b.addedAtMs)
          const validA = Number.isFinite(valueA)
          const validB = Number.isFinite(valueB)
          if (!validA && !validB) return 0
          if (!validA) return 1
          if (!validB) return -1
          return sortedCol.order === 'asc' ? valueA - valueB : valueB - valueA
        })
      } else if (sortedCol.filterType === 'number') {
        filtered = [...filtered].sort((a, b) => {
          const valueA = Number(getSongField(a, sortedCol.key))
          const valueB = Number(getSongField(b, sortedCol.key))
          const validA = Number.isFinite(valueA)
          const validB = Number.isFinite(valueB)
          if (!validA && !validB) return 0
          if (!validA) return 1
          if (!validB) return -1
          return sortedCol.order === 'asc' ? valueA - valueB : valueB - valueA
        })
      } else if (sortedCol.key === 'bpm') {
        filtered = [...filtered].sort((a, b) => {
          const valueA = resolveSongBeatGridV2BpmSortValue(a.beatGridMap, a.bpm)
          const valueB = resolveSongBeatGridV2BpmSortValue(b.beatGridMap, b.bpm)
          const validA = valueA !== null
          const validB = valueB !== null
          if (!validA && !validB) return 0
          if (!validA) return 1
          if (!validB) return -1
          return sortedCol.order === 'asc' ? valueA - valueB : valueB - valueA
        })
      } else if (sortedCol.key === 'neteaseDownloadStatus') {
        filtered = [...filtered].sort((a, b) => {
          const valueA = getNeteaseDownloadStatusRank(a)
          const valueB = getNeteaseDownloadStatusRank(b)
          const validA = valueA !== null
          const validB = valueB !== null
          if (!validA && !validB) return 0
          if (!validA) return 1
          if (!validB) return -1
          return sortedCol.order === 'asc' ? valueA - valueB : valueB - valueA
        })
      } else if (sortedCol.key === 'originalPlaylistPath') {
        const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
        filtered = [...filtered].sort((a, b) => {
          const valueA = getOriginalPlaylistDisplay(a).trim()
          const valueB = getOriginalPlaylistDisplay(b).trim()
          const emptyA = valueA === ''
          const emptyB = valueB === ''
          if (emptyA && emptyB) return 0
          if (emptyA) return 1
          if (emptyB) return -1
          return sortedCol.order === 'asc'
            ? collator.compare(valueA, valueB)
            : collator.compare(valueB, valueA)
        })
      } else {
        filtered = sortSongColumns(
          filtered,
          [sortedCol],
          runtime.setting.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
        )
      }
    }

    // 防御性去重：SET 歌单允许同文件重复，需按映射条目 ID 去重。
    const seen = new Set<string>()
    filtered = filtered.filter((item) => {
      const key = isSetView.value ? item.setItemId || item.filePath : item.filePath
      if (!key) return false
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    applyVisibleSongs(filtered)
  }

  const shouldApplyFiltersAndSortingForSongChange = (fields: string[]) => {
    if (!Array.isArray(fields) || fields.length === 0) return false
    if (songsAreaState.searchQuery.trim()) return true
    if (compatibleKeyFilterActive.value && fields.includes('key')) return true
    if (columnMode.value === 'mixtape') return false
    const fieldSet = new Set(fields.filter(Boolean))
    if (!fieldSet.size) return false
    return columnData.value.some((col) => {
      if (col.order) {
        if (col.key === 'index') return fieldSet.has('playlistTrackNumber')
        if (col.key === 'key') return fieldSet.has('key')
        if (col.key === 'bpm') return fieldSet.has('bpm') || fieldSet.has('beatGridMap')
        if (fieldSet.has(String(col.key || ''))) return true
        return fieldSet.has('energyAnalysis') && col.key !== 'energyScore'
      }
      if (!col.filterActive) return false
      if (col.filterType === 'bpm') return fieldSet.has('bpm') || fieldSet.has('beatGridMap')
      if (col.filterType === 'number') {
        if (fieldSet.has(String(col.key || ''))) return true
        return fieldSet.has('energyAnalysis') && col.key !== 'energyScore'
      }
      if (col.filterType === 'date') return fieldSet.has('addedAtMs')
      if (col.filterType === 'text' && col.key === 'key') return fieldSet.has('key')
      return false
    })
  }

  // --- 列更新 ---
  const handleColumnsUpdate = (newColumns: ISongsAreaColumn[]) => {
    columnData.value = newColumns
    persistColumnData()
    applyFiltersAndSorting()
    songsAreaState.selectedSongFilePath.length = 0

    if (runtime.playingData.playingSongListUUID === songsAreaState.songListUUID) {
      runtime.playingData.playingSongListData = songsAreaState.songInfoArr
    }
  }

  watch(
    () => songsAreaState.searchQuery,
    () => {
      applyFiltersAndSorting()
      songsAreaState.selectedSongFilePath.length = 0
    }
  )

  watch([compatibleKeyFilterActive, harmonicReferenceKey], ([active], [wasActive]) => {
    if (!active && !wasActive) return
    applyFiltersAndSorting()
    if (active !== wasActive) {
      songsAreaState.selectedSongFilePath.length = 0
    } else {
      const visibleKeys = new Set(songsAreaState.songInfoArr.map(getSongSelectionKey))
      const selected = songsAreaState.selectedSongFilePath
      if (selected.some((key) => !visibleKeys.has(key))) {
        songsAreaState.selectedSongFilePath = selected.filter((key) => visibleKeys.has(key))
      }
    }
  })

  watch(
    () => runtime.setting.keyDisplayStyle,
    () => {
      const sortedCol = columnData.value.find((c) => c.order)
      const hasKeyFilter = columnData.value.some((c) => c.key === 'key' && c.filterActive)
      if (sortedCol?.key === 'key' || hasKeyFilter || songsAreaState.searchQuery.trim()) {
        applyFiltersAndSorting()
      }
    }
  )

  // --- 右键菜单与可见性切换 ---
  const colRightClickMenuShow = ref(false)
  const triggeringColContextEvent = ref<MouseEvent | null>(null)
  const contextmenuEvent = (event: MouseEvent) => {
    triggeringColContextEvent.value = event
    colRightClickMenuShow.value = true
  }

  const handleToggleColumnVisibility = (columnKey: string) => {
    const columnIndex = columnData.value.findIndex((col) => col.key === columnKey)
    if (columnIndex !== -1) {
      const newColumns = columnData.value.map((col, index) => {
        if (index === columnIndex) {
          return { ...col, show: !col.show }
        }
        return col
      })
      columnData.value = newColumns
      persistColumnData()
    }
  }

  // --- 列头排序点击 ---
  const colMenuClick = (col: ISongsAreaColumn) => {
    if (columnMode.value === 'mixtape') return
    if (col.key === 'cover' || col.key === 'waveformPreview') return
    if (col.key === 'index' && !isDefaultLikeColumnMode(columnMode.value)) return

    const newColumnData = columnData.value.map((item) => {
      if (item.key !== col.key) {
        return { ...item, order: undefined }
      }
      const newOrderForItem = item.order === 'asc' ? 'desc' : item.order === 'desc' ? 'asc' : 'asc'
      return { ...item, order: newOrderForItem as 'asc' | 'desc' }
    })
    columnData.value = newColumnData.map((c) =>
      c.key === 'cover' ? { ...c, order: undefined } : c
    )
    persistColumnData()
    applyFiltersAndSorting()

    if (runtime.playingData.playingSongListUUID === songsAreaState.songListUUID) {
      runtime.playingData.playingSongListData = songsAreaState.songInfoArr
    }
  }

  const columnDataArr = computed(() => columnData.value.filter((item) => item.show))

  const totalColumnsWidth = computed(() => {
    if (!columnDataArr.value || columnDataArr.value.length === 0) return 0
    return columnDataArr.value.reduce((sum, col) => sum + (col.width || 0), 0)
  })

  return {
    compatibleKeyFilterActive,
    columnData,
    columnDataArr,
    totalColumnsWidth,
    colRightClickMenuShow,
    triggeringColContextEvent,
    contextmenuEvent,
    handleToggleColumnVisibility,
    handleColumnsUpdate,
    colMenuClick,
    applyFiltersAndSorting,
    shouldApplyFiltersAndSortingForSongChange,
    persistColumnData,
    resetToSharedSettings,
    independentSettings,
    columnMode
  }
}
