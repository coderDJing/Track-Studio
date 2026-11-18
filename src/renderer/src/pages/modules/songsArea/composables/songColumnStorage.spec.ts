// Run: pnpm exec vitest run src/renderer/src/pages/modules/songsArea/composables/songColumnStorage.spec.ts
import { describe, expect, it } from 'vitest'
import {
  buildSongsAreaDefaultColumns,
  normalizeSongColumns,
  songColumnStorageKey
} from './songColumnStorage'

const visibleKeys = (mode: 'default' | 'netease') =>
  buildSongsAreaDefaultColumns(mode)
    .filter((column) => column.show)
    .map((column) => column.key)

describe('netease library default columns', () => {
  it('uses a slim default set and keeps other columns available but hidden', () => {
    const columns = buildSongsAreaDefaultColumns('netease')
    expect(visibleKeys('netease')).toEqual([
      'index',
      'cover',
      'waveformPreview',
      'title',
      'neteaseDownloadStatus',
      'artist',
      'duration',
      'album'
    ])
    const byKey = new Map(columns.map((column) => [column.key, column]))
    expect(byKey.get('fileName')?.show).toBe(false)
    expect(byKey.get('bpm')?.show).toBe(false)
    expect(byKey.get('key')?.show).toBe(false)
    expect(byKey.get('label')?.show).toBe(false)
    expect(byKey.get('genre')?.show).toBe(false)
    expect(byKey.get('bitrate')?.show).toBe(false)
    expect(byKey.get('fileFormat')?.show).toBe(false)
    expect(byKey.get('container')?.show).toBe(false)
    expect(byKey.get('addedAtMs')?.show).toBe(false)
    expect(byKey.get('energyScore')?.show).toBe(false)
    expect(songColumnStorageKey('netease')).toBe('neteaseColumnData')
  })

  it('does not put the download-status column into the local-library defaults', () => {
    const keys = buildSongsAreaDefaultColumns('default').map((column) => column.key)
    expect(keys).not.toContain('neteaseDownloadStatus')
    expect(visibleKeys('default')).toContain('bpm')
    expect(visibleKeys('default')).toContain('key')
  })

  it('hides fileName when a saved NetEase layout still uses the old default set', () => {
    const saved = buildSongsAreaDefaultColumns('netease').map((column) => ({
      ...column,
      show: column.key !== 'fileName' ? column.show : true
    }))
    const columns = normalizeSongColumns(saved, 'netease', false)
    const byKey = new Map(columns.map((column) => [column.key, column]))
    expect(byKey.get('fileName')?.show).toBe(false)
    expect(byKey.get('album')?.show).toBe(true)
  })

  it('keeps a user-enabled fileName column when the visible set is no longer the old default', () => {
    const saved = buildSongsAreaDefaultColumns('netease').map((column) => ({
      ...column,
      show: column.key === 'fileName' || column.key === 'bpm' || column.show
    }))
    const columns = normalizeSongColumns(saved, 'netease', false)
    const byKey = new Map(columns.map((column) => [column.key, column]))
    expect(byKey.get('fileName')?.show).toBe(true)
    expect(byKey.get('bpm')?.show).toBe(true)
  })
})
