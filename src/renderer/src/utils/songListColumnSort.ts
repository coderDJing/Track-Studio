import type { ISongInfo, ISongsAreaColumn } from 'src/types/globals'
import { getKeySortText } from '@shared/keyDisplay'
import { getSongListFieldRawValue } from './songListFieldDisplay'
type KeyDisplayStyle = Parameters<typeof getKeySortText>[1]
export function sortSongColumns(
  songs: ISongInfo[],
  columns: ISongsAreaColumn[],
  style?: KeyDisplayStyle,
  status?: (song: ISongInfo) => string
) {
  const column = columns.find((value) => value.order)
  if (!column || column.key === 'index')
    return column?.order === 'desc' ? [...songs].reverse() : songs
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
  const value = (song: ISongInfo): string | number | null => {
    const raw = getSongListFieldRawValue(song, column.key)
    if (column.key === 'icloudStatus') return status?.(song) || null
    if (raw === undefined || raw === null || raw === '') return null
    if (column.key === 'duration') {
      const parts = String(raw).split(':').map(Number)
      return parts.length === 2 && parts.every(Number.isFinite) ? parts[0] * 60 + parts[1] : null
    }
    if (column.key === 'bpm' || column.key === 'bitrate')
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    if (column.key === 'key') return getKeySortText(String(raw), style ?? 'Classic')
    return String(raw)
  }
  return songs
    .map((song, index) => ({ song, index, value: value(song) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null)
        return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1
      const result =
        typeof a.value === 'number' && typeof b.value === 'number'
          ? a.value - b.value
          : collator.compare(String(a.value), String(b.value))
      return (column.order === 'desc' ? -result : result) || a.index - b.index
    })
    .map(({ song }) => song)
}
