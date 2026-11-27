import { it, expect } from 'vitest'
import { filterSongColumns } from './songListColumnFilters'
import { sortSongColumns } from './songListColumnSort'
import { normalizeIcloudColumns } from './icloudColumns'
import type { ISongInfo, ISongsAreaColumn } from 'src/types/globals'
const rows = Array.from({ length: 450 }, (_, index) => ({
  filePath: `${index}.wav`,
  fileName: `${index}.wav`,
  title: `Track ${index}`,
  ...(index === 449
    ? { artist: 'Real artist', album: 'Real album', duration: '2:34', bpm: 124, key: 'Am' }
    : {})
})) as ISongInfo[]
it('ordinary playlists and cloud use the same full-collection text/exclude/duration/BPM/key filters without inventing unknown metadata', () => {
  const col = (key: string, patch: Partial<ISongsAreaColumn>) => ({
    ...normalizeIcloudColumns(null).find((column) => column.key === key)!,
    filterActive: true,
    ...patch
  })
  for (const column of [
    col('artist', { filterValue: 'real' }),
    col('duration', { filterOp: 'gte', filterDuration: '2:00' }),
    col('bpm', { filterOp: 'gte', filterNumber: '120' }),
    col('key', { filterValue: 'Am' })
  ])
    expect(filterSongColumns(rows, [column]).map((row) => row.fileName)).toEqual(['449.wav'])
  expect(filterSongColumns(rows, [col('artist', { filterExcludeValue: 'real' })])).toHaveLength(449)
  expect(rows[0].bpm).toBeUndefined()
  expect(rows[0].artist).toBeUndefined()
})
it('shared stable sorting keeps unknown values last in both directions across the complete directory', () => {
  for (const order of ['asc', 'desc'] as const) {
    const columns = [{ ...normalizeIcloudColumns(null).find((col) => col.key === 'bpm')!, order }]
    const sorted = sortSongColumns(rows, columns)
    expect(sorted[0].fileName).toBe('449.wav')
    expect(sorted.slice(1).map((song) => song.fileName)).toEqual(
      rows.slice(0, 449).map((song) => song.fileName)
    )
  }
})
