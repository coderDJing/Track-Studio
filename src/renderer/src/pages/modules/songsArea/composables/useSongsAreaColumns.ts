import { computed, ref, watch, type ShallowRef } from 'vue'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'
import { MIN_WIDTH_BY_KEY } from '../minWidth'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import { getKeyDisplayText, getKeySortText } from '@shared/keyDisplay'
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
import pkg from '../../../../../../../package.json'

interface UseSongsAreaColumnsParams {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  shouldPersistToLocalStorage: () => boolean
}

export type SongsAreaColumnMode = 'default' | 'recycle' | 'recording' | 'mixtape'

const INIT_EXTRA_WIDTH = 40
const IS_RC_BUILD = /-rc(?:\.|$)/i.test(String(pkg.version || '').trim())
const SONGS_AREA_DEFAULT_STORAGE_KEY = 'songColumnData'
const SONGS_AREA_RECYCLE_STORAGE_KEY = 'recycleBinColumnData'
const SONGS_AREA_RECORDING_STORAGE_KEY = 'recordingLibraryColumnData'
export const SONGS_AREA_MIXTAPE_STORAGE_KEY = 'mixtapeColumnData'

const buildSongsAreaBaseColumns = (
  mode: SongsAreaColumnMode
): Omit<ISongsAreaColumn, 'width'>[] => {
  const isRecycleBin = mode === 'recycle'
  const isRecording = mode === 'recording'
  const isMixtape = mode === 'mixtape'
  const columns: Omit<ISongsAreaColumn, 'width'>[] = [
    {
      columnName: isMixtape ? 'columns.mixOrder' : 'columns.index',
      key: 'index',
      show: true,
      order: mode === 'default' ? 'asc' : undefined
    }
  ]
  if (isRecycleBin) {
    columns.push({
      columnName: 'columns.deletedAt',
      key: 'deletedAtMs',
      show: true,
      order: 'desc'
    })
  }
  if (isRecording) {
    columns.push(
      { columnName: 'columns.waveformPreview', key: 'waveformPreview', show: true },
      {
        columnName: 'columns.title',
        key: 'title',
        show: true,
        filterType: 'text'
      },
      {
        columnName: 'columns.duration',
        key: 'duration',
        show: true,
        filterType: 'duration'
      },
      { columnName: 'columns.bitrate', key: 'bitrate', show: true },
      {
        columnName: 'columns.fileFormat',
        key: 'fileFormat',
        show: true,
        filterType: 'text'
      },
      {
        columnName: 'columns.format',
        key: 'container',
        show: true,
        filterType: 'text'
      },
      {
        columnName: 'columns.fileName',
        key: 'fileName',
        show: true,
        filterType: 'text'
      }
    )
    return columns
  }
  columns.push(
    { columnName: 'columns.cover', key: 'cover', show: true },
    { columnName: 'columns.waveformPreview', key: 'waveformPreview', show: true },
    {
      columnName: 'columns.title',
      key: 'title',
      show: true,
      filterType: isMixtape ? undefined : 'text'
    },
    {
      columnName: 'columns.artist',
      key: 'artist',
      show: true,
      filterType: isMixtape ? undefined : 'text'
    }
  )
  if (isRecycleBin) {
    columns.push({
      columnName: 'columns.originalPlaylist',
      key: 'originalPlaylistPath',
      show: true,
      filterType: 'text'
    })
  }
  if (isMixtape) {
    columns.push({
      columnName: 'columns.mixSource',
      key: 'originalPlaylistPath',
      show: true
    })
  }
  columns.push(
    {
      columnName: 'columns.duration',
      key: 'duration',
      show: true,
      filterType: isMixtape ? undefined : 'duration'
    },
    {
      columnName: 'columns.bpm',
      key: 'bpm',
      show: true,
      filterType: isMixtape ? undefined : 'bpm'
    },
    {
      columnName: 'columns.energy',
      key: 'energyScore',
      show: true,
      filterType: isMixtape ? undefined : 'number'
    },
    {
      columnName: 'columns.dancefloorEnergy',
      key: 'dancefloorScore',
      show: true,
      filterType: isMixtape ? undefined : 'number'
    },
    {
      columnName: 'columns.danceability',
      key: 'danceabilityScore',
      show: true,
      filterType: isMixtape ? undefined : 'number'
    },
    {
      columnName: 'columns.rhythmicEnergy',
      key: 'rhythmicScore',
      show: true,
      filterType: isMixtape ? undefined : 'number'
    },
    {
      columnName: 'columns.dropImpact',
      key: 'dropScore',
      show: false,
      filterType: isMixtape ? undefined : 'number'
    },
    {
      columnName: 'columns.breakdownContrast',
      key: 'breakdownScore',
      show: false,
      filterType: isMixtape ? undefined : 'number'
    },
    {
      columnName: 'columns.drivingScore',
      key: 'drivingScore',
      show: false,
      filterType: isMixtape ? undefined : 'number'
    },
    {
      columnName: 'columns.mainSectionScore',
      key: 'mainSectionScore',
      show: false,
      filterType: isMixtape ? undefined : 'number'
    },
    {
      columnName: 'columns.highEnergyCoverageScore',
      key: 'highEnergyCoverageScore',
      show: false,
      filterType: isMixtape ? undefined : 'number'
    },
    {
      columnName: 'columns.peakEnergy',
      key: 'peakScore',
      show: false,
      filterType: isMixtape ? undefined : 'number'
    },
    {
      columnName: 'columns.energyRange',
      key: 'rangeScore',
      show: false,
      filterType: isMixtape ? undefined : 'number'
    },
    {
      columnName: 'columns.key',
      key: 'key',
      show: true,
      filterType: isMixtape ? undefined : 'text'
    },
    {
      columnName: 'columns.album',
      key: 'album',
      show: true,
      filterType: isMixtape ? undefined : 'text'
    },
    {
      columnName: 'columns.label',
      key: 'label',
      show: true,
      filterType: isMixtape ? undefined : 'text'
    },
    {
      columnName: 'columns.genre',
      key: 'genre',
      show: true,
      filterType: isMixtape ? undefined : 'text'
    },
    {
      columnName: 'columns.fileFormat',
      key: 'fileFormat',
      show: true,
      filterType: isMixtape ? undefined : 'text'
    },
    { columnName: 'columns.bitrate', key: 'bitrate', show: true },
    {
      columnName: 'columns.fileName',
      key: 'fileName',
      show: true,
      filterType: isMixtape ? undefined : 'text'
    },
    {
      columnName: 'columns.format',
      key: 'container',
      show: true,
      filterType: isMixtape ? undefined : 'text'
    }
  )
  if (IS_RC_BUILD) {
    columns.push({
      columnName: 'columns.energyConfidence',
      key: 'confidence',
      show: true,
      filterType: isMixtape ? undefined : 'number'
    })
  }
  if (!isRecycleBin) {
    columns.push({
      columnName: 'columns.addedAt',
      key: 'addedAtMs',
      show: true,
      filterType: isMixtape ? undefined : 'date'
    })
  }
  return columns
}

const defaultNoExtraWidthKeys = new Set([
  'index',
  'duration',
  'bpm',
  'energyScore',
  'dancefloorScore',
  'danceabilityScore',
  'rhythmicScore',
  'drivingScore',
  'mainSectionScore',
  'highEnergyCoverageScore',
  'dropScore',
  'breakdownScore',
  'peakScore',
  'rangeScore',
  'confidence',
  'key'
])

export const getSongsAreaMinWidthByKey = (key: string, mode: SongsAreaColumnMode) => {
  const base = MIN_WIDTH_BY_KEY[key] ?? 0
  if (mode === 'mixtape' && key === 'index') return base + 30
  return base
}

export const buildSongsAreaDefaultColumns = (mode: SongsAreaColumnMode): ISongsAreaColumn[] =>
  buildSongsAreaBaseColumns(mode).map((col) => {
    const minWidth = getSongsAreaMinWidthByKey(col.key, mode)
    return {
      ...col,
      width: defaultNoExtraWidthKeys.has(col.key) ? minWidth : minWidth + INIT_EXTRA_WIDTH
    }
  })

export function useSongsAreaColumns(params: UseSongsAreaColumnsParams) {
  const { runtime, songsAreaState, originalSongInfoArr, shouldPersistToLocalStorage } = params

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

  const readPersistedColumns = (mode: SongsAreaColumnMode): ISongsAreaColumn[] => {
    const storageKey =
      mode === 'recycle'
        ? SONGS_AREA_RECYCLE_STORAGE_KEY
        : mode === 'recording'
          ? SONGS_AREA_RECORDING_STORAGE_KEY
          : mode === 'mixtape'
            ? SONGS_AREA_MIXTAPE_STORAGE_KEY
            : SONGS_AREA_DEFAULT_STORAGE_KEY
    const defaultColumns = buildSongsAreaDefaultColumns(mode)
    const savedData = localStorage.getItem(storageKey)
    let finalColumns: ISongsAreaColumn[]

    if (!savedData) {
      finalColumns = JSON.parse(JSON.stringify(defaultColumns))
    } else {
      try {
        const parsedSavedColumns: ISongsAreaColumn[] = JSON.parse(savedData)
        const defaultColumnsMap = new Map(defaultColumns.map((col) => [col.key, col]))

        finalColumns = parsedSavedColumns
          .map((savedCol) => {
            const defaultCol = defaultColumnsMap.get(savedCol.key)
            if (defaultCol) {
              const mergedCol = {
                ...defaultCol,
                show: savedCol.show !== undefined ? savedCol.show : defaultCol.show,
                width: savedCol.width !== undefined ? savedCol.width : defaultCol.width,
                order: (Object.prototype.hasOwnProperty.call(savedCol, 'order')
                  ? savedCol.order
                  : undefined) as ISongsAreaColumn['order'],
                key: defaultCol.key,
                columnName: defaultCol.columnName,
                filterType: defaultCol.filterType,
                filterActive:
                  (runtime.setting.persistSongFilters ? savedCol.filterActive : false) ?? false,
                filterValue: runtime.setting.persistSongFilters ? savedCol.filterValue : undefined,
                filterExcludeValue: runtime.setting.persistSongFilters
                  ? (savedCol as ISongsAreaColumn).filterExcludeValue
                  : undefined,
                filterOp: runtime.setting.persistSongFilters ? savedCol.filterOp : undefined,
                filterDuration: runtime.setting.persistSongFilters
                  ? savedCol.filterDuration
                  : undefined,
                filterDurationTo: runtime.setting.persistSongFilters
                  ? (savedCol as ISongsAreaColumn).filterDurationTo
                  : undefined,
                filterNumber: runtime.setting.persistSongFilters
                  ? (savedCol as ISongsAreaColumn).filterNumber
                  : undefined,
                filterNumberTo: runtime.setting.persistSongFilters
                  ? (savedCol as ISongsAreaColumn).filterNumberTo
                  : undefined,
                filterDate: runtime.setting.persistSongFilters
                  ? (savedCol as ISongsAreaColumn).filterDate
                  : undefined,
                filterDateTo: runtime.setting.persistSongFilters
                  ? (savedCol as ISongsAreaColumn).filterDateTo
                  : undefined,
                filterCuratedOnly: runtime.setting.persistSongFilters
                  ? (savedCol as ISongsAreaColumn).filterCuratedOnly
                  : undefined
              }
              return mergedCol
            }
            return null
          })
          .filter((col) => col !== null) as ISongsAreaColumn[]

        defaultColumns.forEach((defaultCol, defaultIndex) => {
          if (finalColumns.some((fc) => fc.key === defaultCol.key)) return
          const precedingKeys = defaultColumns.slice(0, defaultIndex).map((item) => item.key)
          let insertionIndex = -1
          for (let index = finalColumns.length - 1; index >= 0; index -= 1) {
            if (precedingKeys.includes(finalColumns[index].key)) {
              insertionIndex = index + 1
              break
            }
          }
          finalColumns.splice(
            insertionIndex === -1 ? finalColumns.length : insertionIndex,
            0,
            JSON.parse(JSON.stringify(defaultCol))
          )
        })

        finalColumns = finalColumns.filter((fc) => defaultColumnsMap.has(fc.key))
      } catch (error) {
        console.error(`解析本地存储的 ${storageKey} 出错，使用默认列配置:`, error)
        finalColumns = JSON.parse(JSON.stringify(defaultColumns))
      }
    }

    const hasOrderAfterMerge = finalColumns.some((col) => col.order !== undefined)
    if (!hasOrderAfterMerge && mode !== 'mixtape') {
      if (mode === 'recycle') {
        const deletedAtIndex = finalColumns.findIndex((col) => col.key === 'deletedAtMs')
        if (deletedAtIndex !== -1) {
          finalColumns[deletedAtIndex] = {
            ...finalColumns[deletedAtIndex],
            order: 'desc'
          }
        }
      } else {
        const indexColIndex = finalColumns.findIndex((col) => col.key === 'index')
        if (indexColIndex !== -1) {
          finalColumns[indexColIndex] = { ...finalColumns[indexColIndex], order: 'asc' }
        } else {
          const titleColIndex = finalColumns.findIndex((col) => col.key === 'title')
          if (titleColIndex !== -1) {
            finalColumns[titleColIndex] = { ...finalColumns[titleColIndex], order: 'asc' }
          }
        }
      }
    }

    finalColumns = finalColumns.map((col) => {
      const minWidth = getSongsAreaMinWidthByKey(col.key, mode) ?? col.width
      if (col.width < minWidth) {
        return { ...col, width: minWidth }
      }
      return col
    })
    if (mode === 'mixtape') {
      finalColumns = finalColumns.map((col) => ({
        ...col,
        order: undefined
      }))
    }

    return finalColumns
  }

  const loadColumnsForMode = (mode: SongsAreaColumnMode): ISongsAreaColumn[] => {
    const cached = songsAreaState.columnCacheByMode[mode]
    if (Array.isArray(cached) && cached.length > 0) {
      return cached.map((item) => ({ ...item }))
    }
    const loaded = readPersistedColumns(mode)
    songsAreaState.columnCacheByMode[mode] = loaded.map((item) => ({ ...item }))
    return loaded
  }

  const columnData = ref<ISongsAreaColumn[]>(loadColumnsForMode(columnMode.value))

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

  // --- 持久化 ---
  const persistColumnData = () => {
    songsAreaState.columnCacheByMode[columnMode.value] = columnData.value.map((item) => ({
      ...item
    }))
    if (!shouldPersistToLocalStorage()) return
    const storageKey =
      columnMode.value === 'recycle'
        ? SONGS_AREA_RECYCLE_STORAGE_KEY
        : columnMode.value === 'recording'
          ? SONGS_AREA_RECORDING_STORAGE_KEY
          : columnMode.value === 'mixtape'
            ? SONGS_AREA_MIXTAPE_STORAGE_KEY
            : SONGS_AREA_DEFAULT_STORAGE_KEY
    localStorage.setItem(storageKey, JSON.stringify(columnData.value))
  }

  // --- 根据列筛选过滤并按当前排序排序 ---
  function applyFiltersAndSorting() {
    let filtered = [...originalSongInfoArr.value]
    songsAreaState.totalSongCount = filtered.length
    for (const col of columnData.value) {
      if (!col.filterActive) continue
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
      songsAreaState.songInfoArr = filtered
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

    songsAreaState.songInfoArr = filtered
  }

  const shouldApplyFiltersAndSortingForSongChange = (fields: string[]) => {
    if (!Array.isArray(fields) || fields.length === 0) return false
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
    () => columnMode.value,
    () => {
      columnData.value = loadColumnsForMode(columnMode.value)
      applyFiltersAndSorting()
    }
  )

  watch(
    () => runtime.setting.keyDisplayStyle,
    () => {
      const sortedCol = columnData.value.find((c) => c.order)
      const hasKeyFilter = columnData.value.some((c) => c.key === 'key' && c.filterActive)
      if (sortedCol?.key === 'key' || hasKeyFilter) {
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
    persistColumnData
  }
}
