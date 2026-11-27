import { usePlaylistColumnSettings } from '@renderer/pages/modules/songsArea/composables/usePlaylistColumnSettings'
import { usePlaylistViewSettingsStore } from '@renderer/stores/playlistViewSettings'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import { icloudDirectory, icloudState } from './icloudLibrary'
import { computed, ref, reactive, watch, type ComputedRef } from 'vue'
import type { ISongsAreaColumn } from 'src/types/globals'
import {
  buildSongsAreaDefaultColumns,
  normalizeSongColumns
} from '@renderer/pages/modules/songsArea/composables/songColumnStorage'
import { useColumnDragPreview } from '@renderer/pages/modules/songsArea/composables/useColumnDragPreview'
const storageKey = 'icloudSongColumnData'
const supported = new Set([
  'index',
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
  'fileFormat',
  'bitrate',
  'fileName',
  'container'
])
const icloudStatusColumn: ISongsAreaColumn = {
  key: 'icloudStatus',
  columnName: 'icloud.cloudStatus',
  show: true,
  width: 160,
  filterType: undefined
}

/** Previous iCloud default: ordinary supported columns with status last. */
export const PREVIOUS_ICLOUD_DEFAULT_COLUMN_KEYS = [
  'index',
  'cover',
  'waveformPreview',
  'title',
  'artist',
  'duration',
  'bpm',
  'key',
  'album',
  'label',
  'genre',
  'fileFormat',
  'bitrate',
  'fileName',
  'container',
  'icloudStatus'
] as const

export function buildIcloudDefaultColumns() {
  const columns = buildSongsAreaDefaultColumns('default').filter((column) =>
    supported.has(column.key)
  )
  const titleIndex = columns.findIndex((column) => column.key === 'title')
  columns.splice(titleIndex + 1, 0, { ...icloudStatusColumn })
  return columns
}

const supportedIcloudKeys = new Set([...supported, 'icloudStatus'])

function supportedIcloudKeysIn(columns: { key: string }[]) {
  return columns.map((column) => column.key).filter((key) => supportedIcloudKeys.has(key))
}

function shouldMigrateLegacyIcloudStatusOrder(columns: ISongsAreaColumn[]) {
  const keys = supportedIcloudKeysIn(columns)
  const statusIndex = keys.indexOf('icloudStatus')
  const titleIndex = keys.indexOf('title')
  if (statusIndex < 0 || titleIndex < 0 || statusIndex === titleIndex + 1) return false
  if (
    keys.length === PREVIOUS_ICLOUD_DEFAULT_COLUMN_KEYS.length &&
    keys.every((key, index) => key === PREVIOUS_ICLOUD_DEFAULT_COLUMN_KEYS[index])
  ) {
    return true
  }
  // Status stayed in the previous default position (last among supported columns).
  return statusIndex === keys.length - 1
}

function placeIcloudStatusAfterTitle(columns: ISongsAreaColumn[]) {
  const statusIndex = columns.findIndex((column) => column.key === 'icloudStatus')
  const titleIndex = columns.findIndex((column) => column.key === 'title')
  if (statusIndex < 0 || titleIndex < 0 || statusIndex === titleIndex + 1) return columns
  const next = columns.slice()
  const [status] = next.splice(statusIndex, 1)
  next.splice(next.findIndex((column) => column.key === 'title') + 1, 0, status)
  return next
}

export function normalizeIcloudColumns(saved: unknown) {
  const columns = normalizeSongColumns(saved, 'default', true, buildIcloudDefaultColumns())
  if (Array.isArray(saved) && !saved.some((col) => col?.key === 'cover')) {
    const index = columns.findIndex((col) => col.key === 'cover')
    const [cover] = columns.splice(index, 1)
    columns.splice(columns.findIndex((col) => col.key === 'index') + 1, 0, cover)
  }
  return shouldMigrateLegacyIcloudStatusOrder(columns)
    ? placeIcloudStatusAfterTitle(columns)
    : columns
}
export { sortSongColumns as sortIcloudSongs } from './songListColumnSort'
export function useIcloudColumns(
  runtime = { setting: { persistSongFilters: false } } as ReturnType<typeof useRuntimeStore>,
  identity: ComputedRef<string> = computed(
    () => `${icloudState.value?.folder || 'iCloud Drive'}:${icloudDirectory.value}`
  )
) {
  const store = usePlaylistViewSettingsStore(),
    libraryUuid = computed(() => 'icloud-drive-view')
  const pane = reactive({
    songListUUID: identity.value,
    compatibleKeyOnly: false,
    columnCacheByMode: {}
  }) as ISongsAreaPaneRuntimeState
  const extra = ref<Record<string, ISongsAreaColumn>>({})
  try {
    extra.value = JSON.parse(localStorage.getItem('icloudColumnStatus:v1') || '{}')
  } catch {
    /* discard malformed view preference */
  }
  const scope = {
    libraryUuid,
    canCustomize: computed(() => true),
    project: (raw: ISongsAreaColumn[]) => {
      const columns = normalizeIcloudColumns(raw)
      const status = extra.value[identity.value]
      return status
        ? columns.map((col) => (col.key === 'icloudStatus' ? { ...col, ...status } : col))
        : columns
    },
    mergeShared: (columns: ISongsAreaColumn[], shared: ISongsAreaColumn[]) => [
      ...columns.filter((col) => col.key !== 'icloudStatus'),
      ...shared.filter((col) => !supported.has(col.key))
    ]
  }
  const {
    columnData: columns,
    persistColumnData,
    resetToSharedSettings: resetColumns,
    independentSettings: independent
  } = usePlaylistColumnSettings({
    runtime,
    songsAreaState: pane,
    columnMode: computed(() => 'default'),
    shouldPersistToLocalStorage: () => true,
    onSettingsChange: () => {},
    externalScope: scope
  })
  watch(
    identity,
    (value) => {
      pane.songListUUID = value
    },
    { flush: 'sync' }
  )
  const independentSettings = computed({
    get: () => independent.value,
    set: (enabled: boolean) =>
      store.setIndependent(
        libraryUuid.value,
        pane.songListUUID,
        'default',
        enabled,
        false,
        runtime.setting.persistSongFilters
      )
  })
  // Previous versions always kept their own snapshot. Keep it as an independent preference on migration.
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
    if (Array.isArray(saved) && !store.getPlaylist(libraryUuid.value, pane.songListUUID, false)) {
      independentSettings.value = true
      store.updatePlaylist(
        libraryUuid.value,
        pane.songListUUID,
        normalizeIcloudColumns(saved),
        false
      )
    }
  } catch {
    /* keep shared settings */
  }
  const menuOpen = ref(false),
    menuEvent = ref<MouseEvent | null>(null)
  const visibleColumns = computed(() => columns.value.filter((column) => column.show))
  const { rowsVisibleColumns, handleColumnDragPreview } = useColumnDragPreview(visibleColumns)
  const updateColumns = (value: ISongsAreaColumn[]) => {
    const next = normalizeIcloudColumns(value),
      status = next.find((col) => col.key === 'icloudStatus')!
    columns.value = next
    // Persist before changing the projected extra column; its synchronous settings watcher
    // must not restore an older shared snapshot over the user's current edit.
    persistColumnData()
    extra.value = { ...extra.value, [identity.value]: status }
    localStorage.setItem('icloudColumnStatus:v1', JSON.stringify(extra.value))
  }
  const sortColumn = (column: ISongsAreaColumn) => {
    if (column.key === 'cover') return
    updateColumns(
      columns.value.map((value) => ({
        ...value,
        order: value.key === column.key ? (value.order === 'asc' ? 'desc' : 'asc') : undefined
      }))
    )
  }
  const toggleColumn = (key: string) =>
    updateColumns(
      columns.value.map((value) => (value.key === key ? { ...value, show: !value.show } : value))
    )
  const contextMenu = (event: MouseEvent) => {
    menuEvent.value = event
    menuOpen.value = true
  }
  return {
    columns,
    independentSettings,
    visibleColumns,
    rowsVisibleColumns,
    handleColumnDragPreview,
    updateColumns,
    sortColumn,
    toggleColumn,
    resetColumns,
    contextMenu,
    menuOpen,
    menuEvent
  }
}
