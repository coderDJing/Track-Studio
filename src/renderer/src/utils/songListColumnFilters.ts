import type { ISongInfo, ISongsAreaColumn } from 'src/types/globals'
import { normalizeCamelotKey, parseSelectedKeyFilter, getKeyDisplayText } from '@shared/keyDisplay'
import { normalizeArtistName, splitArtistNames } from '@shared/artistNames'
import { normalizeBpmDisplayScaled } from './bpm'
import { resolveSongBeatGridV2BpmFilterValues } from '@shared/songBeatGridMapV2'
import { matchTimestampByDateFilter } from '@shared/songAddedAt'
import { matchComparableByFilter } from '@shared/filterCompare'
import { getOriginalPlaylistDisplay } from './recycleBinDisplay'
import { getSongListFieldRawValue as getSongField } from './songListFieldDisplay'
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

/** The same filter engine is used by ordinary playlists and safe read-only cloud rows. */
export function filterSongColumns(
  songs: ISongInfo[],
  columns: ISongsAreaColumn[],
  options: { keyStyle?: 'Camelot' | 'Classic'; curatedArtists?: Array<{ name: string }> } = {}
) {
  let filtered = songs
  for (const col of columns) {
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
      const keyStyle = options.keyStyle || 'Classic'
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
          (options.curatedArtists || []).map((a) => normalizeArtistName(a.name))
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
      const targetTo = col.filterOp === 'between' ? parseComparableNumber(col.filterNumberTo) : null
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

  return filtered
}
