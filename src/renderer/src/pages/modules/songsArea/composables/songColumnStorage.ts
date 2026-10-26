import type { ISongsAreaColumn } from 'src/types/globals'
import { MIN_WIDTH_BY_KEY } from '../minWidth'
import pkg from '../../../../../../../package.json'
import type { SongsAreaColumnMode } from '@renderer/stores/runtime'
export type { SongsAreaColumnMode } from '@renderer/stores/runtime'

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

export const songColumnStorageKey = (mode: SongsAreaColumnMode): string => {
  if (mode === 'recycle') return SONGS_AREA_RECYCLE_STORAGE_KEY
  if (mode === 'recording') return SONGS_AREA_RECORDING_STORAGE_KEY
  if (mode === 'mixtape') return SONGS_AREA_MIXTAPE_STORAGE_KEY
  return SONGS_AREA_DEFAULT_STORAGE_KEY
}

export const cloneSongColumns = (columns: ISongsAreaColumn[]): ISongsAreaColumn[] =>
  columns.map((column) => ({ ...column }))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const filterTextFields = [
  'filterValue',
  'filterExcludeValue',
  'filterDuration',
  'filterDurationTo',
  'filterNumber',
  'filterNumberTo',
  'filterDate',
  'filterDateTo'
] as const

// 只在从磁盘载入时应用 persistFilters；会话内切换设置不能清掉正在使用的筛选。
export const normalizeSongColumns = (
  value: unknown,
  mode: SongsAreaColumnMode,
  persistFilters: boolean
): ISongsAreaColumn[] => {
  const defaults = buildSongsAreaDefaultColumns(mode)
  const byKey = new Map(defaults.map((column) => [column.key, column]))
  const seen = new Set<string>()
  const columns: ISongsAreaColumn[] = []
  if (Array.isArray(value)) {
    for (const saved of value) {
      if (!isRecord(saved) || typeof saved.key !== 'string' || seen.has(saved.key)) continue
      const base = byKey.get(saved.key)
      if (!base) continue
      seen.add(saved.key)
      const column: ISongsAreaColumn = {
        ...base,
        show: typeof saved.show === 'boolean' ? saved.show : base.show,
        width:
          typeof saved.width === 'number' && Number.isFinite(saved.width)
            ? Math.max(getSongsAreaMinWidthByKey(base.key, mode), saved.width)
            : base.width,
        order: saved.order === 'asc' || saved.order === 'desc' ? saved.order : undefined
      }
      if (persistFilters) {
        column.filterActive = saved.filterActive === true
        column.filterCuratedOnly = saved.filterCuratedOnly === true
        if (['eq', 'gte', 'lte', 'between'].includes(String(saved.filterOp))) {
          column.filterOp = saved.filterOp as ISongsAreaColumn['filterOp']
        }
        for (const field of filterTextFields) {
          if (typeof saved[field] === 'string') column[field] = saved[field]
        }
      }
      columns.push(column)
    }
  }
  defaults.forEach((column, index) => {
    if (seen.has(column.key)) return
    const preceding = new Set(defaults.slice(0, index).map((item) => item.key))
    let insertion = columns.length
    for (let i = columns.length - 1; i >= 0; i -= 1) {
      if (preceding.has(columns[i].key)) {
        insertion = i + 1
        break
      }
    }
    columns.splice(insertion, 0, { ...column })
  })
  if (!columns.some((column) => column.show)) columns[0].show = true
  let hasOrder = false
  for (const column of columns) {
    if (
      mode === 'mixtape' ||
      hasOrder ||
      column.key === 'cover' ||
      column.key === 'waveformPreview'
    ) {
      column.order = undefined
    }
    if (column.order) hasOrder = true
  }
  if (!hasOrder && mode !== 'mixtape') {
    const column = columns.find(
      (item) => item.key === (mode === 'recycle' ? 'deletedAtMs' : 'index')
    )
    if (column) column.order = mode === 'recycle' ? 'desc' : 'asc'
  }
  return columns
}

export const readSharedSongColumns = (
  mode: SongsAreaColumnMode,
  persistFilters: boolean
): ISongsAreaColumn[] => {
  const key = songColumnStorageKey(mode)
  const raw = localStorage.getItem(key)
  try {
    return normalizeSongColumns(raw ? JSON.parse(raw) : null, mode, persistFilters)
  } catch (error) {
    console.error(`解析本地存储的 ${key} 出错:`, error)
    return normalizeSongColumns(null, mode, persistFilters)
  }
}
