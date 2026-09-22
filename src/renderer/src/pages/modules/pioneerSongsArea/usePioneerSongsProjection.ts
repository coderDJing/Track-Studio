import type { ComputedRef, Ref, ShallowRef } from 'vue'
import { normalizeBpmDisplayScaled } from '@renderer/utils/bpm'
import { getKeyDisplayText, getKeySortText } from '@shared/keyDisplay'
import { normalizeAddedAtMs, matchTimestampByDateFilter } from '@shared/songAddedAt'
import { matchComparableByFilter } from '@shared/filterCompare'
import { getSongListFieldRawValue } from '@renderer/utils/songListFieldDisplay'
import type { RekordboxSourceKind } from '@shared/rekordboxSources'
import type {
  IPioneerPlaylistTrack,
  IRekordboxSourceKind,
  ISongInfo,
  ISongMemoryCue,
  ISongHotCue,
  ISongsAreaColumn
} from '../../../../../types/globals'

export type PioneerSongSnapshot = {
  filePath: string
  fileName: string
  fileFormat: string
  cover: null
  title: string | undefined
  artist: string | undefined
  album: string | undefined
  duration: string
  genre: string | undefined
  label: string | undefined
  bitrate: number | undefined
  container: string | undefined
  key: string | undefined
  originalKey: string | undefined
  originalBpm: number | undefined
  energyScore: number | undefined
  energyAlgorithmVersion: number | undefined
  energyAnalysis: ISongInfo['energyAnalysis']
  hotCues: ISongHotCue[]
  memoryCues: ISongMemoryCue[]
}

type UsePioneerSongsProjectionParams = {
  originalTracks: ShallowRef<IPioneerPlaylistTrack[]>
  visibleSongs: Ref<ISongInfo[]>
  columnData: Ref<ISongsAreaColumn[]>
  selectedRowKeys: Ref<string[]>
  selectedSourceRootPath: ComputedRef<string>
  selectedSourceKind: ComputedRef<IRekordboxSourceKind | ''>
  getKeyDisplayStyle: () => string
  getCurrentPlaybackListKey: () => string
  getPlayingSongListUUID: () => string
  setPlayingSongListData: (songs: ISongInfo[]) => void
  emitPioneerSongsAreaLog: (event: string, payload?: Record<string, unknown>) => void
}

const getSongField = (song: ISongInfo, key: string): unknown => getSongListFieldRawValue(song, key)

const normalizePath = (value: string) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()

const resolveFileNameAndFormat = (filePath: string) => {
  const baseName =
    String(filePath || '')
      .split(/[/\\]/)
      .pop() || ''
  const parts = baseName.split('.')
  const ext = parts.length > 1 ? parts.pop() || '' : ''
  return {
    fileName: baseName,
    fileFormat: ext ? ext.toUpperCase() : ''
  }
}

const sortArrayByProperty = <T extends object>(
  array: T[],
  property: keyof T,
  order: 'asc' | 'desc'
) => {
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
  return [...array].sort((a, b) => {
    const valueA = String(a[property] || '')
    const valueB = String(b[property] || '')
    return order === 'asc' ? collator.compare(valueA, valueB) : collator.compare(valueB, valueA)
  })
}

const parseDurationToSeconds = (mmss: string): number => {
  if (!mmss || typeof mmss !== 'string') return NaN
  const parts = mmss.split(':')
  if (parts.length !== 2) return NaN
  const minutes = Number(parts[0])
  const seconds = Number(parts[1])
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return NaN
  return minutes * 60 + seconds
}

const parseNumberInput = (input: unknown): number => {
  if (input === null || input === undefined) return NaN
  if (typeof input === 'number') return Number.isFinite(input) ? input : NaN
  const raw = String(input || '').trim()
  if (!raw) return NaN
  const cleaned = raw.replace(/[^0-9.]/g, '')
  if (!cleaned) return NaN
  const parts = cleaned.split('.')
  const normalized = parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('')}` : parts[0]
  const value = Number(normalized)
  return Number.isFinite(value) ? value : NaN
}

const parseComparableBpm = (input: unknown): number | null => {
  const numeric = parseNumberInput(input)
  if (Number.isNaN(numeric)) return null
  return normalizeBpmDisplayScaled(numeric)
}

const parseComparableNumber = (input: unknown): number | null => {
  const numeric = parseNumberInput(input)
  return Number.isNaN(numeric) ? null : numeric
}

const parseExcludeKeywords = (input: unknown): string[] => {
  if (input === null || input === undefined) return []
  const raw = String(input)
  if (!raw.trim()) return []
  return raw
    .split(/[,\n;\r，；、|]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

export const usePioneerSongsProjection = (params: UsePioneerSongsProjectionParams) => {
  const toSongInfo = (track: IPioneerPlaylistTrack): ISongInfo => ({
    filePath: track.filePath,
    fileName: track.fileName,
    fileFormat: track.fileFormat,
    cover: null,
    title: track.title,
    artist: track.artist || undefined,
    album: track.album || undefined,
    duration: track.duration,
    genre: track.genre || undefined,
    label: track.label || undefined,
    bitrate: track.bitrate,
    container: track.container || undefined,
    key: track.key,
    bpm: track.bpm,
    beatGridMap: track.beatGridMap,
    rekordboxGridEntries: track.rekordboxGridEntries?.map((entry) => ({ ...entry })),
    beatGridSource: track.beatGridMap ? 'rekordbox' : undefined,
    timeBasisOffsetMs: track.timeBasisOffsetMs,
    hotCues: Array.isArray(track.hotCues) ? track.hotCues.map((cue) => ({ ...cue })) : [],
    memoryCues: Array.isArray(track.memoryCues) ? track.memoryCues.map((cue) => ({ ...cue })) : [],
    mixOrder: track.entryIndex,
    externalAnalyzePath: track.analyzePath || null,
    externalWaveformRootPath: params.selectedSourceRootPath.value || null,
    externalSourceKind: (params.selectedSourceKind.value || 'usb') as RekordboxSourceKind,
    pioneerCoverPath: track.coverPath || null,
    pioneerAnalyzePath:
      params.selectedSourceKind.value === 'usb' ? track.analyzePath || null : null,
    pioneerDeviceRootPath:
      params.selectedSourceKind.value === 'usb'
        ? params.selectedSourceRootPath.value || null
        : null,
    mixtapeItemId: track.rowKey,
    addedAtMs: normalizeAddedAtMs(track.dateAdded),
    fileMissing: track.fileMissing ?? false
  })

  const resolveTrackKey = (song: ISongInfo) => song.mixtapeItemId || song.filePath

  const resolveSelectedTracksByKeys = (keys: string[]) => {
    if (!keys.length) return []
    const selectedKeySet = new Set(keys)
    return params.visibleSongs.value.filter((song) => selectedKeySet.has(resolveTrackKey(song)))
  }

  const resolveSelectedTracks = (fallback?: ISongInfo) => {
    const selectedKeys = params.selectedRowKeys.value.length
      ? [...params.selectedRowKeys.value]
      : fallback
        ? [resolveTrackKey(fallback)]
        : []
    if (!selectedKeys.length) return []
    const tracks = resolveSelectedTracksByKeys(selectedKeys)
    if (tracks.length > 0) return tracks
    return fallback ? [fallback] : []
  }

  const buildSongSnapshot = (filePath: string, song: ISongInfo): PioneerSongSnapshot => {
    const meta = resolveFileNameAndFormat(filePath)
    return {
      filePath,
      fileName: meta.fileName,
      fileFormat: song.fileFormat || meta.fileFormat,
      cover: null,
      title: song.title ?? meta.fileName,
      artist: song.artist,
      album: song.album,
      duration: song.duration ?? '',
      genre: song.genre,
      label: song.label,
      bitrate: song.bitrate,
      container: song.container,
      key: song.key,
      originalKey: song.key,
      originalBpm: song.bpm,
      energyScore: song.energyScore,
      energyAlgorithmVersion: song.energyAlgorithmVersion,
      energyAnalysis: song.energyAnalysis,
      hotCues: Array.isArray(song.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
      memoryCues: Array.isArray(song.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : []
    }
  }

  const applyFiltersAndSorting = (reason = 'unspecified') => {
    let filtered = params.originalTracks.value.map((track) => toSongInfo(track))
    const beforeCount = filtered.length
    for (const col of params.columnData.value) {
      if (!col.filterActive) continue
      if (col.filterType === 'text' && col.key) {
        const keyword = String(col.filterValue || '').toLowerCase()
        const excludeKeywords = parseExcludeKeywords(col.filterExcludeValue)
        const hasInclude = keyword.trim().length > 0
        const hasExclude = excludeKeywords.length > 0
        if (!hasInclude && !hasExclude) continue
        const isKeyColumn = col.key === 'key'
        const keyStyle = params.getKeyDisplayStyle() === 'Camelot' ? 'Camelot' : 'Classic'
        filtered = filtered.filter((song) => {
          const rawValue = String(getSongField(song, col.key) ?? '')
          const displayValue = isKeyColumn ? getKeyDisplayText(rawValue, keyStyle) : rawValue
          const value = displayValue.toLowerCase()
          if (hasInclude && !value.includes(keyword)) return false
          if (hasExclude && excludeKeywords.some((item) => value.includes(item))) return false
          return true
        })
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
          const duration = parseDurationToSeconds(String(song.duration ?? ''))
          if (Number.isNaN(duration)) return false
          return matchComparableByFilter(
            duration,
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
          const bpm = parseComparableBpm(song.bpm)
          if (bpm === null) return false
          return matchComparableByFilter(bpm, col.filterOp, target, targetTo)
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

    const sortedCol = params.columnData.value.find((col) => col.order)
    if (sortedCol?.order) {
      if (sortedCol.key === 'index') {
        filtered = [...filtered].sort((a, b) => {
          const valueA = Number(a.mixOrder) || 0
          const valueB = Number(b.mixOrder) || 0
          return sortedCol.order === 'asc' ? valueA - valueB : valueB - valueA
        })
      } else if (sortedCol.key === 'key') {
        const style = params.getKeyDisplayStyle() === 'Camelot' ? 'Camelot' : 'Classic'
        const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
        filtered = [...filtered].sort((a, b) => {
          const valueA = getKeySortText(String(a.key || ''), style)
          const valueB = getKeySortText(String(b.key || ''), style)
          return sortedCol.order === 'asc'
            ? collator.compare(valueA, valueB)
            : collator.compare(valueB, valueA)
        })
      } else if (sortedCol.key === 'addedAtMs') {
        filtered = [...filtered].sort((a, b) => {
          const valueA = Number(a.addedAtMs)
          const valueB = Number(b.addedAtMs)
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
      } else {
        filtered = sortArrayByProperty(filtered, sortedCol.key as keyof ISongInfo, sortedCol.order)
      }
    }

    params.visibleSongs.value = filtered

    if (
      params.getCurrentPlaybackListKey() &&
      params.getPlayingSongListUUID() === params.getCurrentPlaybackListKey()
    ) {
      params.setPlayingSongListData([...params.visibleSongs.value])
    }

    params.emitPioneerSongsAreaLog('apply-filters-and-sorting', {
      reason,
      beforeCount,
      afterCount: filtered.length,
      selectedRowCount: params.selectedRowKeys.value.length,
      filters: params.columnData.value
        .filter((col) => !!col.filterActive)
        .map((col) => ({
          key: col.key,
          filterType: col.filterType || '',
          filterOp: col.filterOp || '',
          filterValue: col.filterValue || '',
          filterExcludeValue: col.filterExcludeValue || '',
          filterDuration: col.filterDuration || '',
          filterDurationTo: col.filterDurationTo || '',
          filterNumber: col.filterNumber || '',
          filterNumberTo: col.filterNumberTo || '',
          filterDate: col.filterDate || '',
          filterDateTo: col.filterDateTo || ''
        })),
      firstOriginalTracks: params.originalTracks.value.slice(0, 5).map((track) => ({
        rowKey: track.rowKey,
        title: track.title,
        filePath: track.filePath
      })),
      firstVisibleSongs: filtered.slice(0, 5).map((song) => ({
        rowKey: song.mixtapeItemId || song.filePath,
        title: song.title,
        filePath: song.filePath
      }))
    })
  }

  return {
    applyFiltersAndSorting,
    buildSongSnapshot,
    normalizePath,
    resolveSelectedTracks,
    resolveSelectedTracksByKeys,
    resolveTrackKey
  }
}
