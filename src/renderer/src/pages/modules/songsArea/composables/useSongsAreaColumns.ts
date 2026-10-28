import { normalizeCamelotKey, parseSelectedKeyFilter } from '@shared/keyDisplay'
import { computed, ref, toRaw, watch, type ShallowRef } from 'vue'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'
import type {
  ISongsAreaPaneRuntimeState,
  SongsAreaColumnMode,
  useRuntimeStore
} from '@renderer/stores/runtime'
import { getKeyDisplayText, getKeySortText, isHarmonicMixCompatible } from '@shared/keyDisplay'
import { useHarmonicReferenceKey } from '@renderer/composables/useHarmonicReferenceKey'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import { getOriginalPlaylistDisplay } from '@renderer/utils/recycleBinDisplay'
import { normalizeArtistName, splitArtistNames } from '@shared/artistNames'
import { normalizeBpmDisplayScaled } from '@renderer/utils/bpm'
import {
  resolveSongBeatGridV2BpmFilterValues,
  resolveSongBeatGridV2BpmSortValue
} from '@shared/songBeatGridMapV2'
import { matchTimestampByDateFilter } from '@shared/songAddedAt'
import { matchComparableByFilter } from '@shared/filterCompare'
import libraryUtils from '@renderer/utils/libraryUtils'
import { getSongListFieldRawValue } from '@renderer/utils/songListFieldDisplay'
import { filterSongsByPlaylistSearch } from '@renderer/utils/playlistSongSearch'
import { usePlaylistColumnSettings } from './usePlaylistColumnSettings'
export {
  buildSongsAreaDefaultColumns,
  getSongsAreaMinWidthByKey,
  SONGS_AREA_MIXTAPE_STORAGE_KEY
} from './songColumnStorage'

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
  const columnMode = computed<SongsAreaColumnMode>(() => {
    if (isRecycleBinView.value) return 'recycle'
    if (isRecordingLibraryView.value) return 'recording'
    if (isMixtapeView.value) return 'mixtape'
    return 'default'
  })
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

  // --- 工具 ---
  function sortArrayByProperty<T extends object>(
    array: T[],
    property: keyof T,
    order: 'asc' | 'desc' = 'asc'
  ): T[] {
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
    return [...array].sort((a, b) => {
      const valueA = String(a[property] || '')
      const valueB = String(b[property] || '')
      return order === 'asc' ? collator.compare(valueA, valueB) : collator.compare(valueB, valueA)
    })
  }

  function parseDurationToSeconds(mmss: string): number {
    if (!mmss || typeof mmss !== 'string') return NaN
    const parts = mmss.split(':')
    if (parts.length !== 2) return NaN
    const m = Number(parts[0])
    const s = Number(parts[1])
    if (Number.isNaN(m) || Number.isNaN(s)) return NaN
    return m * 60 + s
  }

  function parseNumberInput(input: unknown): number {
    if (input === null || input === undefined) return NaN
    if (typeof input === 'number') {
      return Number.isFinite(input) ? input : NaN
    }
    const raw = String(input || '').trim()
    if (!raw) return NaN
    const cleaned = raw.replace(/[^0-9.]/g, '')
    if (!cleaned) return NaN
    const parts = cleaned.split('.')
    const normalized = parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('')}` : parts[0]
    const num = Number(normalized)
    return Number.isFinite(num) ? num : NaN
  }

  function parseComparableBpm(input: unknown): number | null {
    const numeric = parseNumberInput(input)
    if (Number.isNaN(numeric)) return null
    return normalizeBpmDisplayScaled(numeric)
  }

  function parseComparableNumber(input: unknown): number | null {
    const numeric = parseNumberInput(input)
    return Number.isNaN(numeric) ? null : numeric
  }

  function parseExcludeKeywords(input: unknown): string[] {
    if (input === null || input === undefined) return []
    const raw = String(input)
    if (!raw.trim()) return []
    return raw
      .split(/[,\n;\r，；、|]+/g)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
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
    for (const col of columnData.value) {
      if (!col.filterActive) continue
      const selectedKeys = col.key === 'key' ? parseSelectedKeyFilter(col.filterValue || '') : null
      if (selectedKeys !== null) {
        const selected = new Set(selectedKeys)
        filtered = filtered.filter((song) =>
          selected.has(normalizeCamelotKey(String(song.key || '')))
        )
        continue
      }
      if (col.filterType === 'text' && col.key) {
        const keyword = String(col.filterValue || '').toLowerCase()
        const excludeKeywords = parseExcludeKeywords(col.filterExcludeValue)
        const hasInclude = keyword.trim().length > 0
        const hasExclude = excludeKeywords.length > 0
        const hasCuratedOnly = !!col.filterCuratedOnly
        if (!hasInclude && !hasExclude && !hasCuratedOnly) continue
        const isKeyColumn = col.key === 'key'
        const isOriginalPlaylist = col.key === 'originalPlaylistPath'
        const keyStyle = runtime.setting.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
        if (hasInclude || hasExclude) {
          filtered = filtered.filter((song) => {
            const rawValue = isOriginalPlaylist
              ? getOriginalPlaylistDisplay(song)
              : String(getSongField(song, col.key) ?? '')
            const displayValue = isKeyColumn ? getKeyDisplayText(rawValue, keyStyle) : rawValue
            const value = displayValue.toLowerCase()
            if (hasInclude && !value.includes(keyword)) return false
            if (hasExclude && excludeKeywords.some((kw) => value.includes(kw))) return false
            return true
          })
        }
        if (hasCuratedOnly && col.key === 'artist') {
          const curatedNames = new Set(
            (runtime.curatedArtistFavorites || []).map((a) => normalizeArtistName(a.name))
          )
          filtered = filtered.filter((song) => {
            const artistNames = splitArtistNames(song.artist)
            return artistNames.some((name) => curatedNames.has(normalizeArtistName(name)))
          })
        }
      } else if (
        col.filterType === 'duration' &&
        col.filterOp &&
        (col.filterOp === 'between'
          ? Boolean(col.filterDuration || col.filterDurationTo)
          : Boolean(col.filterDuration))
      ) {
        const target = col.filterDuration ? parseDurationToSeconds(col.filterDuration) : null
        const targetTo =
          col.filterOp === 'between' && col.filterDurationTo
            ? parseDurationToSeconds(col.filterDurationTo)
            : null
        filtered = filtered.filter((song) => {
          const dur = parseDurationToSeconds(String(song.duration ?? ''))
          if (Number.isNaN(dur)) return false
          return matchComparableByFilter(
            dur,
            col.filterOp,
            target !== null && Number.isNaN(target) ? null : target,
            targetTo !== null && Number.isNaN(targetTo) ? null : targetTo
          )
        })
      } else if (
        col.filterType === 'bpm' &&
        col.filterOp &&
        (col.filterOp === 'between'
          ? Boolean(col.filterNumber || col.filterNumberTo)
          : Boolean(col.filterNumber))
      ) {
        const target = parseComparableBpm(col.filterNumber)
        const targetTo = col.filterOp === 'between' ? parseComparableBpm(col.filterNumberTo) : null
        filtered = filtered.filter((song) => {
          const bpmValues = resolveSongBeatGridV2BpmFilterValues(song.beatGridMap, song.bpm)
          if (!bpmValues.length) return false
          return bpmValues.some((bpmValue) => {
            const bpm = parseComparableBpm(bpmValue)
            if (bpm === null) return false
            return matchComparableByFilter(bpm, col.filterOp, target, targetTo)
          })
        })
      } else if (
        col.filterType === 'number' &&
        col.filterOp &&
        (col.filterOp === 'between'
          ? Boolean(col.filterNumber || col.filterNumberTo)
          : Boolean(col.filterNumber))
      ) {
        const target = parseComparableNumber(col.filterNumber)
        const targetTo =
          col.filterOp === 'between' ? parseComparableNumber(col.filterNumberTo) : null
        filtered = filtered.filter((song) => {
          const value = parseComparableNumber(getSongField(song, col.key))
          if (value === null) return false
          return matchComparableByFilter(value, col.filterOp, target, targetTo)
        })
      } else if (
        col.filterType === 'date' &&
        col.filterOp &&
        (col.filterOp === 'between'
          ? Boolean(col.filterDate || col.filterDateTo)
          : Boolean(col.filterDate))
      ) {
        filtered = filtered.filter((song) =>
          matchTimestampByDateFilter(song.addedAtMs, col.filterOp, col.filterDate, col.filterDateTo)
        )
      }
    }

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
        filtered = sortArrayByProperty<ISongInfo>(
          filtered,
          sortedCol.key as keyof ISongInfo,
          sortedCol.order!
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
    if (col.key === 'index' && columnMode.value !== 'default') return

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
    independentSettings
  }
}
