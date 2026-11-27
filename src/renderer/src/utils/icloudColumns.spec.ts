import { effectScope, computed, ref } from 'vue'
import { usePlaylistViewSettingsStore } from '@renderer/stores/playlistViewSettings'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { songColumnStorageKey } from '@renderer/pages/modules/songsArea/composables/songColumnStorage'
import {
  PREVIOUS_ICLOUD_DEFAULT_COLUMN_KEYS,
  normalizeIcloudColumns,
  sortIcloudSongs,
  useIcloudColumns as actualUseIcloudColumns
} from './icloudColumns'
import { buildSongsAreaDefaultColumns } from '@renderer/pages/modules/songsArea/composables/songColumnStorage'
import type { ISongInfo, ISongsAreaColumn } from 'src/types/globals'
const scopes: ReturnType<typeof effectScope>[] = []
const useIcloudColumns = (...args: Parameters<typeof actualUseIcloudColumns>) => {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => actualUseIcloudColumns(...args))!
}
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
})
let storage: Map<string, string>
beforeEach(() => {
  setActivePinia(createPinia())
  storage = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  })
})
const song = (name: string, bpm?: number, duration = ''): ISongInfo => ({
  filePath: name,
  fileName: name,
  title: name,
  bpm,
  duration,
  cover: null,
  artist: undefined,
  album: undefined,
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined,
  fileFormat: 'wav'
})
describe('shared song columns in iCloud', () => {
  it('retains real applicable fields and cloud status but excludes local-only analysis/edit columns', () => {
    const columns = normalizeIcloudColumns(null),
      keys = columns.map((c) => c.key)
    for (const key of [
      'cover',
      'waveformPreview',
      'title',
      'artist',
      'album',
      'duration',
      'bpm',
      'key',
      'genre',
      'label',
      'bitrate',
      'fileFormat',
      'container',
      'icloudStatus'
    ])
      expect(keys).toContain(key)
    for (const key of ['energy', 'waveform', 'rating', 'mixOrder']) expect(keys).not.toContain(key)
    expect(columns.find((c) => c.key === 'artist')?.filterType).toBe('text')
    const coverIndex = keys.indexOf('cover')
    expect(keys.indexOf('waveformPreview')).toBe(coverIndex + 1)
    expect(keys.indexOf('title')).toBe(keys.indexOf('waveformPreview') + 1)
    expect(keys.indexOf('icloudStatus')).toBe(keys.indexOf('title') + 1)
    expect(keys.indexOf('artist')).toBe(keys.indexOf('icloudStatus') + 1)
    expect(columns.find((c) => c.key === 'waveformPreview')?.show).toBe(true)
    expect(columns.find((c) => c.key === 'icloudStatus')?.show).toBe(true)
  })

  it('does not change the ordinary local list default column order', () => {
    const keys = buildSongsAreaDefaultColumns('default').map((column) => column.key)
    expect(keys).not.toContain('icloudStatus')
    expect(keys.indexOf('title')).toBe(keys.indexOf('waveformPreview') + 1)
    expect(keys.indexOf('artist')).toBe(keys.indexOf('title') + 1)
  })
  it('inserts a missing waveform preview column into saved cloud preferences without dropping cover or status', () => {
    const saved = normalizeIcloudColumns(null).filter((col) => col.key !== 'waveformPreview')
    const columns = normalizeIcloudColumns(saved)
    const keys = columns.map((col) => col.key)
    expect(keys).toContain('waveformPreview')
    expect(keys.indexOf('waveformPreview')).toBe(keys.indexOf('cover') + 1)
    expect(columns.find((col) => col.key === 'cover')?.show).toBe(true)
    expect(columns.find((col) => col.key === 'icloudStatus')?.show).toBe(true)
  })
  it('inherits ordinary playlist display preferences on first use without altering them', () => {
    const shared = normalizeIcloudColumns(null)
      .filter((c) => c.key !== 'icloudStatus')
      .map((c) => (c.key === 'album' ? { ...c, show: false, width: 211 } : c))
    const key = songColumnStorageKey('default'),
      saved = JSON.stringify(shared)
    storage.set(key, saved)
    const ui = useIcloudColumns()
    expect(ui.columns.value.find((c) => c.key === 'album')).toMatchObject({
      show: false,
      width: 211
    })
    expect(ui.columns.value.find((c) => c.key === 'icloudStatus')?.show).toBe(true)
    ui.independentSettings.value = true
    ui.toggleColumn('artist')
    expect(storage.get(key)).toBe(saved)
  })
  it('persists column selection, resized widths and drag order separately from ordinary playlists', () => {
    const ui = useIcloudColumns()
    ui.independentSettings.value = true
    ui.toggleColumn('artist')
    const artist = ui.columns.value.find((c) => c.key === 'artist')!
    ui.updateColumns([
      { ...artist, width: 237 },
      ...ui.columns.value.filter((c) => c.key !== 'artist')
    ])
    const restored = useIcloudColumns()
    expect(restored.columns.value[0]).toMatchObject({ key: 'artist', width: 237, show: false })
    expect([...storage.keys()]).toContain('playlistViewSettings:v1:icloud-drive-view')
    restored.sortColumn(restored.columns.value.find((c) => c.key === 'bpm')!)
    expect(restored.columns.value.find((c) => c.key === 'bpm')?.order).toBe('asc')
    restored.sortColumn(restored.columns.value.find((c) => c.key === 'bpm')!)
    expect(restored.columns.value.find((c) => c.key === 'bpm')?.order).toBe('desc')
  })
  it('sorts numeric BPM and duration stably with missing values last in either direction', () => {
    const rows = [
      song('missing'),
      song('high', 130, '10:00'),
      song('low', 90, '2:00'),
      song('tie', 90, '2:00')
    ]
    for (const key of ['bpm', 'duration']) {
      const columns: ISongsAreaColumn[] = normalizeIcloudColumns(null).map((c) => ({
        ...c,
        order: c.key === key ? ('asc' as const) : undefined
      }))
      expect(sortIcloudSongs(rows, columns).map((s) => s.fileName)).toEqual([
        'low',
        'tie',
        'high',
        'missing'
      ])
      columns.find((c) => c.key === key)!.order = 'desc'
      expect(sortIcloudSongs(rows, columns).map((s) => s.fileName)).toEqual([
        'high',
        'low',
        'tie',
        'missing'
      ])
    }
    expect(rows[0].fileName).toBe('missing')
  })
  it('sorts the actual cloud status and real keys without replacing song identities', () => {
    const rows = [{ ...song('b'), key: 'Am' }, { ...song('a'), key: 'Cm' }, song('missing')]
    const columns: ISongsAreaColumn[] = normalizeIcloudColumns(null).map((c) => ({
      ...c,
      order: c.key === 'icloudStatus' ? ('asc' as const) : undefined
    }))
    const result = sortIcloudSongs(rows, columns, 'Classic', (s) =>
      s.fileName === 'a' ? 'local' : s.fileName === 'b' ? 'cloud' : ''
    )
    expect(result.map((s) => s.fileName)).toEqual(['b', 'a', 'missing'])
    expect(result[0]).toBe(rows[0])
    columns.forEach((c) => {
      c.order = c.key === 'key' ? 'asc' : undefined
    })
    expect(sortIcloudSongs(rows, columns, 'Camelot').at(-1)).toBe(rows[2])
  })
})

it('migrates old cloud preferences with a real cover column, persisting visibility/width/order without making pictures sortable', () => {
  const old = normalizeIcloudColumns(null).filter((col) => col.key !== 'cover')
  storage.set('icloudSongColumnData', JSON.stringify(old))
  const ui = useIcloudColumns()
  const index = ui.columns.value.findIndex((col) => col.key === 'index')
  expect(ui.columns.value[index + 1].key).toBe('cover')
  ui.toggleColumn('cover')
  ui.updateColumns(
    ui.columns.value.map((col) => (col.key === 'cover' ? { ...col, width: 61 } : col))
  )
  const again = useIcloudColumns()
  expect(again.columns.value.find((col) => col.key === 'cover')).toMatchObject({
    width: 61,
    show: !normalizeIcloudColumns(null).find((col) => col.key === 'cover')!.show
  })
  again.sortColumn(again.columns.value.find((col) => col.key === 'cover')!)
  expect(again.columns.value.find((col) => col.key === 'cover')?.order).toBeUndefined()
  again.resetColumns()
  expect(again.columns.value.some((col) => col.key === 'cover')).toBe(true)
})

it('uses the ordinary shared controller: live follow, independent edits, directory identities, retained preferences and reset', () => {
  const directory = ref('A'),
    identity = computed(() => directory.value)
  const ui = useIcloudColumns(undefined, identity),
    store = usePlaylistViewSettingsStore()
  store.updateSharedColumns(
    'default',
    store
      .getSharedColumns('default', false)
      .map((col) => (col.key === 'album' ? { ...col, width: 211 } : col))
  )
  expect(ui.columns.value.find((col) => col.key === 'album')?.width).toBe(211)
  ui.independentSettings.value = true
  ui.updateColumns(
    ui.columns.value.map((col) => (col.key === 'album' ? { ...col, width: 333 } : col))
  )
  expect(store.getSharedColumns('default', false).find((col) => col.key === 'album')?.width).toBe(
    211
  )
  directory.value = 'B'
  expect(ui.independentSettings.value).toBe(false)
  expect(ui.columns.value.find((col) => col.key === 'album')?.width).toBe(211)
  directory.value = 'A'
  expect(ui.columns.value.find((col) => col.key === 'album')?.width).toBe(333)
  ui.independentSettings.value = false
  expect(ui.columns.value.find((col) => col.key === 'album')?.width).toBe(211)
  ui.independentSettings.value = true
  expect(ui.columns.value.find((col) => col.key === 'album')?.width).toBe(333)
  ui.resetColumns()
  expect(ui.columns.value.find((col) => col.key === 'album')?.width).toBe(211)
})

const previousDefaultColumns = () => {
  const current = normalizeIcloudColumns(null)
  const status = current.find((column) => column.key === 'icloudStatus')!
  return [...current.filter((column) => column.key !== 'icloudStatus'), status]
}

describe('iCloud default status column placement', () => {
  it('migrates a saved previous default order, keeping widths and visibility', () => {
    expect(previousDefaultColumns().map((column) => column.key)).toEqual([
      ...PREVIOUS_ICLOUD_DEFAULT_COLUMN_KEYS
    ])
    const saved = previousDefaultColumns().map((column) =>
      column.key === 'title'
        ? { ...column, width: 321, show: true }
        : column.key === 'artist'
          ? { ...column, show: false }
          : column
    )
    const columns = normalizeIcloudColumns(saved)
    const keys = columns.map((column) => column.key)
    expect(keys).toEqual(normalizeIcloudColumns(null).map((column) => column.key))
    expect(keys.indexOf('icloudStatus')).toBe(keys.indexOf('title') + 1)
    expect(columns.find((column) => column.key === 'title')).toMatchObject({
      width: 321,
      show: true
    })
    expect(columns.find((column) => column.key === 'artist')?.show).toBe(false)
    expect(columns.find((column) => column.key === 'icloudStatus')?.show).toBe(true)
  })

  it('moves a status column left at the old default position without reshuffling a custom order', () => {
    const previous = previousDefaultColumns()
    const artist = previous.find((column) => column.key === 'artist')!
    const status = previous.find((column) => column.key === 'icloudStatus')!
    const saved = [
      ...previous.filter((column) => column.key !== 'artist' && column.key !== 'icloudStatus'),
      { ...artist, width: 237 },
      status
    ]
    const columns = normalizeIcloudColumns(saved)
    const keys = columns.map((column) => column.key)
    expect(keys.indexOf('icloudStatus')).toBe(keys.indexOf('title') + 1)
    expect(keys.at(-1)).toBe('artist')
    expect(columns.find((column) => column.key === 'artist')).toMatchObject({
      width: 237,
      show: true
    })
  })

  it('does not overwrite a custom status placement or other user edits', () => {
    const previous = previousDefaultColumns()
    const artistIndex = previous.findIndex((column) => column.key === 'artist')
    const status = previous.find((column) => column.key === 'icloudStatus')!
    const saved = previous.filter((column) => column.key !== 'icloudStatus')
    saved.splice(artistIndex + 1, 0, { ...status, width: 180, show: false })
    const columns = normalizeIcloudColumns(saved)
    const keys = columns.map((column) => column.key)
    expect(keys.indexOf('icloudStatus')).toBe(keys.indexOf('artist') + 1)
    expect(keys.indexOf('icloudStatus')).not.toBe(keys.indexOf('title') + 1)
    expect(columns.find((column) => column.key === 'icloudStatus')).toMatchObject({
      width: 180,
      show: false
    })
  })

  it('migrates a legacy saved directory preference in the iCloud column controller', () => {
    storage.set('icloudSongColumnData', JSON.stringify(previousDefaultColumns()))
    const ui = useIcloudColumns()
    const keys = ui.columns.value.map((column) => column.key)
    expect(keys.indexOf('icloudStatus')).toBe(keys.indexOf('title') + 1)
    expect(keys).toEqual(normalizeIcloudColumns(null).map((column) => column.key))
  })
})
