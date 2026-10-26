import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import { computed, ref, watch, type Ref } from 'vue'
import {
  buildSongsAreaDefaultColumns,
  getSongsAreaMinWidthByKey,
  SONGS_AREA_MIXTAPE_STORAGE_KEY
} from '@renderer/pages/modules/songsArea/composables/useSongsAreaColumns'
import { mapMixtapeSnapshotToSongInfo } from '@renderer/composables/mixtape/mixtapeSnapshotSongMapper'
import type { MixtapeTrack } from '@renderer/composables/mixtape/types'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { applyUiSettings, readUiSettings } from '@renderer/utils/uiSettingsStorage'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import type { ISongInfo, ISongsAreaColumn } from '../../../../types/globals'

type UseMixtapeAutoGainDialogOptions = {
  mixtapeRawItems: Ref<unknown[]>
  tracks: Ref<MixtapeTrack[]>
  autoGainReferenceTrackId: Ref<string>
  openAutoGainDialog: () => void
  handleAutoGainDialogCancel: () => void
  handleAutoGainDialogConfirm: () => void | Promise<void>
  handleAutoGainSelectLoudestReference: () => void | Promise<void>
  handleAutoGainSelectQuietestReference: () => void | Promise<void>
}

const MIXTAPE_COLUMN_MODE = 'mixtape' as const

const normalizeColumnOrder = (_value: unknown): undefined => undefined

const persistAutoGainColumns = (columns: ISongsAreaColumn[]) => {
  try {
    const normalized = columns.map((column) => ({
      ...column,
      order: normalizeColumnOrder(column.order)
    }))
    localStorage.setItem(SONGS_AREA_MIXTAPE_STORAGE_KEY, JSON.stringify(normalized))
  } catch {}
}

const loadAutoGainColumns = () => {
  const defaultColumns: ISongsAreaColumn[] = buildSongsAreaDefaultColumns(MIXTAPE_COLUMN_MODE).map(
    (column) => ({
      ...column,
      order: normalizeColumnOrder(column.order)
    })
  )
  const defaultColumnsByKey = new Map(defaultColumns.map((column) => [column.key, column]))
  const saved = localStorage.getItem(SONGS_AREA_MIXTAPE_STORAGE_KEY)
  let mergedColumns: ISongsAreaColumn[] = defaultColumns
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as Partial<ISongsAreaColumn>[]
      const normalized: ISongsAreaColumn[] = parsed
        .map((item): ISongsAreaColumn | null => {
          const key = String(item?.key || '')
          const fallback = defaultColumnsByKey.get(key)
          if (!fallback) return null
          const minWidth = getSongsAreaMinWidthByKey(fallback.key, MIXTAPE_COLUMN_MODE)
          const rawWidth = Number(item?.width)
          const nextColumn: ISongsAreaColumn = {
            ...fallback,
            show: typeof item?.show === 'boolean' ? item.show : fallback.show,
            width: Number.isFinite(rawWidth) ? Math.max(minWidth, rawWidth) : fallback.width
          }
          nextColumn.order = normalizeColumnOrder(item?.order)
          return nextColumn
        })
        .filter((item): item is ISongsAreaColumn => item !== null)
      if (normalized.length) {
        const existingKeySet = new Set(normalized.map((item) => item.key))
        for (const fallback of defaultColumns) {
          if (existingKeySet.has(fallback.key)) continue
          normalized.push(fallback)
        }
        mergedColumns = normalized
      }
    } catch {}
  }
  const visibleColumns = mergedColumns.filter((column) => column.show)
  return visibleColumns.length ? mergedColumns : defaultColumns
}

const stopAutoGainWaveformPreview = () => {
  emitter.emit('waveform-preview:stop', { reason: 'explicit' })
}

const refreshRuntimeSetting = async (runtimeStore: ReturnType<typeof useRuntimeStore>) => {
  try {
    const latest = await window.electron.ipcRenderer.invoke('getSetting')
    if (latest && typeof latest === 'object') {
      const merged = { ...(latest as Record<string, unknown>) }
      applyUiSettings(merged, readUiSettings())
      runtimeStore.setting = merged as typeof runtimeStore.setting
    }
  } catch {}
}

export const useMixtapeAutoGainDialog = (options: UseMixtapeAutoGainDialogOptions) => {
  const runtime = useRuntimeStore()

  const autoGainColumnMenuVisible = ref(false)
  const autoGainColumnMenuEvent = ref<MouseEvent | null>(null)
  const autoGainDialogColumns = ref<ISongsAreaColumn[]>(loadAutoGainColumns())

  watch(
    () => autoGainDialogColumns.value,
    (columns) => {
      persistAutoGainColumns(columns)
    },
    { deep: true }
  )

  const autoGainSongColumns = computed<ISongsAreaColumn[]>(() =>
    autoGainDialogColumns.value.filter((column) => column.show)
  )

  const autoGainSongTotalWidth = computed(() =>
    autoGainSongColumns.value.reduce((sum, column) => sum + Number(column.width || 0), 0)
  )

  const autoGainDialogSongs = computed<ISongInfo[]>(() => {
    return options.mixtapeRawItems.value.map((raw, index) =>
      mapMixtapeSnapshotToSongInfo(raw as Record<string, unknown>, index, {
        buildDisplayPathByUuid: (uuid) => libraryUtils.buildDisplayPathByUuid(uuid)
      })
    )
  })

  const autoGainSelectedRowKeys = computed(() => {
    const referenceTrackId = options.autoGainReferenceTrackId.value
    if (!referenceTrackId) return []
    const targetTrack = options.tracks.value.find((item) => item.id === referenceTrackId)
    const keys = [referenceTrackId, targetTrack?.filePath || ''].filter(Boolean)
    return Array.from(new Set(keys))
  })

  const resolveAutoGainReferenceId = (song: ISongInfo) => {
    if (song.mixtapeItemId) return song.mixtapeItemId
    const matchedTrack = options.tracks.value.find((item) =>
      sameRendererFilePath(item.filePath, song.filePath)
    )
    return matchedTrack?.id || ''
  }

  const handleAutoGainSongClick = (_event: MouseEvent, song: ISongInfo) => {
    const nextId = resolveAutoGainReferenceId(song)
    if (nextId) options.autoGainReferenceTrackId.value = nextId
  }

  const handleAutoGainSongDragStart = (event: DragEvent) => {
    event.preventDefault()
  }

  const handleAutoGainColumnsUpdate = (columns: ISongsAreaColumn[]) => {
    if (!Array.isArray(columns) || !columns.length) return
    autoGainDialogColumns.value = columns.map((column) => ({
      ...column,
      order: normalizeColumnOrder(column.order)
    }))
  }

  const handleAutoGainColumnClick = (_column: ISongsAreaColumn) => {
    // 与主窗口 Mixtape 自动录制歌单一致：列头点击不触发排序
  }

  const handleAutoGainHeaderContextMenu = (event: MouseEvent) => {
    autoGainColumnMenuEvent.value = event
    autoGainColumnMenuVisible.value = true
  }

  const handleAutoGainToggleColumnVisibility = (columnKey: string) => {
    const key = String(columnKey || '')
    if (!key) return
    autoGainDialogColumns.value = autoGainDialogColumns.value.map((column) =>
      column.key === key ? { ...column, show: !column.show } : column
    )
  }

  const handleOpenAutoGainDialog = async () => {
    await refreshRuntimeSetting(runtime)
    autoGainDialogColumns.value = loadAutoGainColumns()
    autoGainColumnMenuVisible.value = false
    autoGainColumnMenuEvent.value = null
    options.openAutoGainDialog()
  }

  const handleAutoGainDialogCancelClick = () => {
    stopAutoGainWaveformPreview()
    options.handleAutoGainDialogCancel()
  }

  const handleAutoGainDialogConfirmClick = async () => {
    stopAutoGainWaveformPreview()
    await options.handleAutoGainDialogConfirm()
  }

  const handleAutoGainSelectLoudestReferenceClick = async () => {
    stopAutoGainWaveformPreview()
    await options.handleAutoGainSelectLoudestReference()
  }

  const handleAutoGainSelectQuietestReferenceClick = async () => {
    stopAutoGainWaveformPreview()
    await options.handleAutoGainSelectQuietestReference()
  }

  return {
    autoGainColumnMenuVisible,
    autoGainColumnMenuEvent,
    autoGainDialogColumns,
    autoGainSongColumns,
    autoGainSongTotalWidth,
    autoGainDialogSongs,
    autoGainSelectedRowKeys,
    handleAutoGainSongClick,
    handleAutoGainSongDragStart,
    handleAutoGainColumnsUpdate,
    handleAutoGainColumnClick,
    handleAutoGainHeaderContextMenu,
    handleAutoGainToggleColumnVisibility,
    handleOpenAutoGainDialog,
    handleAutoGainDialogCancelClick,
    handleAutoGainDialogConfirmClick,
    handleAutoGainSelectLoudestReferenceClick,
    handleAutoGainSelectQuietestReferenceClick
  }
}
