<script setup lang="ts">
import { createSongRowPlaybackLookup } from '@renderer/utils/songRowPlaybackIdentity'
import { sameRendererFilePath } from '@renderer/utils/filePathComparison'

import { computed, nextTick, onUnmounted, ref, shallowRef, watch, useTemplateRef, toRef } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import SongListHeader from '@renderer/pages/modules/songsArea/SongListHeader.vue'
import SongListRows from '@renderer/pages/modules/songsArea/SongListRows.vue'
import ascendingOrderAsset from '@renderer/assets/ascending-order.svg?asset'
import descendingOrderAsset from '@renderer/assets/descending-order.svg?asset'
import confirm from '@renderer/components/confirmDialog'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import RekordboxDesktopWritingOverlay from '@renderer/components/RekordboxDesktopWritingOverlay.vue'
import emitter from '@renderer/utils/mitt'
import { matchesPioneerUsbPlaylistDeleteRequest } from '@renderer/utils/pioneerUsbPlaylistRequest'
import { sendHorizontalBrowseInteractionTrace } from '@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTrace'
import { beginHorizontalBrowseDeckInteraction } from '@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTimeline'
import { t } from '@renderer/utils/translate'
import { rememberRekordboxSourceSelectedPlaylist } from '@renderer/utils/rekordboxLibraryCache'
import { usePlaylistColumnSettings } from '@renderer/pages/modules/songsArea/composables/usePlaylistColumnSettings'
import { usePioneerPaneSource } from './pioneerSongsArea/usePioneerPaneSource'
import { useHarmonicReferenceKey } from '@renderer/composables/useHarmonicReferenceKey'
import { useColumnDragPreview } from '@renderer/pages/modules/songsArea/composables/useColumnDragPreview'
import ColumnHeaderContextMenu from '@renderer/pages/modules/songsArea/ColumnHeaderContextMenu.vue'
import { useKeyboardSelection } from '@renderer/pages/modules/songsArea/composables/useKeyboardSelection'
import { useAutoScrollToCurrent } from '@renderer/pages/modules/songsArea/composables/useAutoScrollToCurrent'
import { useSongLocateFlash } from '@renderer/pages/modules/songsArea/composables/useSongLocateFlash'
import type { SongsAreaPaneKey } from '@renderer/stores/runtime'
import { useParentRafSampler } from '@renderer/pages/modules/songsArea/composables/useParentRafSampler'
import { usePioneerDesktopPlaylistActions } from './pioneerSongsArea/usePioneerDesktopPlaylistActions'
import { usePioneerUsbPlaylistActions } from './pioneerSongsArea/usePioneerUsbPlaylistActions'
import { usePioneerPlaylistTracks } from './pioneerSongsArea/usePioneerPlaylistTracks'
import { usePioneerSongDrag } from './pioneerSongsArea/usePioneerSongDrag'
import { usePioneerSongContextMenu } from './pioneerSongsArea/usePioneerSongContextMenu'
import { usePioneerSongsPlaceholder } from './pioneerSongsArea/usePioneerSongsPlaceholder'
import { usePioneerSongsProjection } from './pioneerSongsArea/usePioneerSongsProjection'
import { getPlaylistNodeDisplayName } from '@renderer/composables/rekordboxDesktop/playlistNodeDisplayName'
import {
  usePioneerTrackCopyDialog,
  type PioneerTransferTarget
} from './pioneerSongsArea/usePioneerTrackCopyDialog'
import type { IPioneerPlaylistTrack, ISongInfo, ISongsAreaColumn } from '../../../../types/globals'

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

const props = defineProps<{ pane: SongsAreaPaneKey }>()
const runtime = useRuntimeStore()
let disposed = false
const pioneerSongsAreaState = runtime.songsAreaPanels.panes[props.pane]
const isActivePane = computed(
  () => !runtime.songsAreaPanels.splitEnabled || runtime.songsAreaPanels.activePane === props.pane
)
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')
const handleOverlayClick = (e: MouseEvent) => {
  if (e.button === 0) selectedRowKeys.value = []
}
const originalTracks = shallowRef<IPioneerPlaylistTrack[]>([])
const visibleSongs = toRef(pioneerSongsAreaState, 'songInfoArr')
const loading = ref(false)
const selectedRowKeys = toRef(pioneerSongsAreaState, 'selectedSongFilePath')
const { columnData, persistColumnData, independentSettings, resetToSharedSettings } =
  usePlaylistColumnSettings({
    runtime,
    songsAreaState: pioneerSongsAreaState,
    columnMode: computed(() => 'default' as const),
    shouldPersistToLocalStorage: () => true,
    onSettingsChange: () => {
      void applyFiltersAndSorting('view-settings-changed')
    }
  })
const harmonicReferenceKey = useHarmonicReferenceKey(runtime)

const ascendingOrder = ascendingOrderAsset
const descendingOrder = descendingOrderAsset
const { externalScrollTop, externalViewportHeight } = useParentRafSampler({ songsAreaRef })

const { songClick, cancelPendingRepeatSingleClickDeselect, cancelPendingShiftSelect } =
  useKeyboardSelection({
    runtime,
    songsAreaState: pioneerSongsAreaState,
    externalViewportHeight,
    readOnly: true,
    onDeleteSelection: async () => {
      if (canEditUsbPlaylist.value && !playlistMutationPending.value)
        await deleteUsbTracks(resolveSelectedTracks())
    }
  })
watch(songsAreaRef, async (host, _previous, onCleanup) => {
  let cancelled = false
  let detach: (() => void) | undefined
  onCleanup(() => {
    cancelled = true
    detach?.()
  })
  await nextTick()
  if (cancelled) return
  const viewport = host?.osInstance()?.elements().viewport
  if (!viewport) return
  viewport.scrollTop = pioneerSongsAreaState.scrollTop
  viewport.scrollLeft = pioneerSongsAreaState.scrollLeft
  const persist = () => {
    pioneerSongsAreaState.scrollTop = viewport.scrollTop
    pioneerSongsAreaState.scrollLeft = viewport.scrollLeft
  }
  viewport.addEventListener('scroll', persist, { passive: true })
  detach = () => viewport.removeEventListener('scroll', persist)
})
watch(
  () => pioneerSongsAreaState.songListUUID,
  async () => {
    await nextTick()
    const viewport = songsAreaRef.value?.osInstance()?.elements().viewport
    if (viewport) {
      viewport.scrollTop = 0
      viewport.scrollLeft = 0
    }
  }
)
const selectedRowKeysForTemplate = computed(() => [...selectedRowKeys.value])

const {
  browser,
  selectedSourceKey,
  selectedSourceKind,
  selectedExternalKind,
  isExternalSource,
  isSeratoSource,
  isTraktorSource,
  isDesktopSource,
  selectedSourceName,
  selectedPlaylistId,
  selectedSourceRootPath,
  selectedLibraryType,
  selectedPlaylistNode,
  canEditUsbPlaylist,
  currentPlaybackListKey,
  selectedSourceCacheKey,
  treeNodes
} = usePioneerPaneSource(pioneerSongsAreaState)

const visibleColumns = computed(() => columnData.value.filter((item) => item.show))
const { rowsVisibleColumns, handleColumnDragPreview } = useColumnDragPreview(visibleColumns)
const totalWidth = computed(() =>
  visibleColumns.value.reduce((sum, col) => sum + Number(col.width || 0), 0)
)
const playingRowLookup = computed(() =>
  createSongRowPlaybackLookup(visibleSongs.value, (song) => song.mixtapeItemId || song.filePath)
)
const playingSongFilePathForRows = computed(
  () => playingRowLookup.value(runtime.playingData.playingSong)[0]
)
const playingSongFilePathsForRows = computed(() => [
  ...new Set([
    ...playingRowLookup.value(runtime.playingData.playingSong),
    ...playingRowLookup.value(runtime.horizontalBrowseDecks.topSong),
    ...playingRowLookup.value(runtime.horizontalBrowseDecks.bottomSong)
  ])
])
const harmonicReferenceKeyForRows = computed(() => {
  if (runtime.mainWindowBrowseMode === 'browser') return ''
  if (runtime.mainWindowBrowseMode === 'edit') {
    return String(runtime.horizontalBrowseDecks.topSong?.key || '').trim()
  }
  const leaderDeck = runtime.horizontalBrowseDecks.leaderDeck
  if (leaderDeck === 'top') {
    return String(runtime.horizontalBrowseDecks.topSong?.key || '').trim()
  }
  if (leaderDeck === 'bottom') {
    return String(runtime.horizontalBrowseDecks.bottomSong?.key || '').trim()
  }
  return ''
})
const originPathSnapshot = computed(() => {
  const driveLabel = selectedSourceName.value || 'Pioneer USB'
  const playlistLabel = getPlaylistNodeDisplayName(selectedPlaylistNode.value)
  return playlistLabel ? `${driveLabel} / ${playlistLabel}` : driveLabel
})

const emitPioneerSongsAreaLog = (_event: string, _payload?: Record<string, unknown>) => {}

const {
  applyFiltersAndSorting,
  applyFiltersAndSortingMerged,
  buildSongSnapshot,
  normalizePath,
  resolveSelectedTracks,
  resolveSelectedTracksByKeys,
  resolveTrackKey
} = usePioneerSongsProjection({
  originalTracks,
  visibleSongs,
  columnData,
  selectedRowKeys,
  selectedSourceRootPath,
  selectedSourceKind,
  selectedExternalKind,
  isExternalSource,
  getSearchQuery: () => pioneerSongsAreaState.searchQuery,
  getCompatibleKey: () =>
    pioneerSongsAreaState.compatibleKeyOnly && runtime.mainWindowBrowseMode !== 'browser'
      ? harmonicReferenceKey.value
      : null,
  getKeyDisplayStyle: () => runtime.setting.keyDisplayStyle || '',
  getCurrentPlaybackListKey: () => currentPlaybackListKey.value,
  selectedLibraryType,
  getPlayingSongListUUID: () => runtime.playingData.playingSongListUUID,
  setPlayingSongListData: (songs) => {
    runtime.playingData.playingSongListData = songs
  },
  emitPioneerSongsAreaLog
})

const { scrollToIndex } = useAutoScrollToCurrent({
  runtime,
  songsAreaState: pioneerSongsAreaState,
  songsAreaRef
})
const {
  flashRowKey: locateFlashRowKey,
  flashRowToken: locateFlashRowToken,
  triggerFlash: triggerLocateFlash
} = useSongLocateFlash()

type FocusSongPayload = {
  pane?: SongsAreaPaneKey | 'pioneer'
  songListUUID?: string
  filePath?: string
}

const handleFocusSongRequest = async (payload?: FocusSongPayload) => {
  if (payload?.pane !== props.pane && payload?.pane !== 'pioneer') return
  if (payload?.pane === 'pioneer' && !isActivePane.value) return
  const targetListUUID = String(payload.songListUUID || '').trim()
  if (targetListUUID && targetListUUID !== currentPlaybackListKey.value) return
  const targetPath = normalizePath(String(payload.filePath || ''))
  if (!targetPath) return
  const targetIndex = visibleSongs.value.findIndex(
    (song) => normalizePath(song.filePath) === targetPath
  )
  if (targetIndex < 0) return
  const targetSong = visibleSongs.value[targetIndex]
  const rowKey = resolveTrackKey(targetSong)
  selectedRowKeys.value = [rowKey]
  await nextTick()
  scrollToIndex(targetIndex)
  triggerLocateFlash(rowKey)
}

emitter.on('songsArea/focus-song', handleFocusSongRequest)

const { placeholderText } = usePioneerSongsPlaceholder({
  loading,
  isDesktopSource,
  isExternalSource,
  isSeratoSource,
  isTraktorSource,
  selectedPlaylistId,
  originalTracks,
  visibleSongs,
  columnData,
  emitPioneerSongsAreaLog
})

const canRemoveTracksFromDesktopPlaylist = computed(
  () =>
    (isDesktopSource.value || isExternalSource.value) &&
    Boolean(selectedPlaylistNode.value) &&
    (!isExternalSource.value || Boolean(selectedPlaylistNode.value?.externalId)) &&
    !selectedPlaylistNode.value?.isFolder &&
    !selectedPlaylistNode.value?.isAllTracks &&
    !selectedPlaylistNode.value?.isSmartPlaylist
)
const hasActiveTrackFilters = computed(
  () =>
    Boolean(pioneerSongsAreaState.searchQuery.trim() || pioneerSongsAreaState.compatibleKeyOnly) ||
    columnData.value.some((col) => Boolean(col.filterActive))
)
const sortedTrackColumn = computed(() => columnData.value.find((col) => Boolean(col.order)) || null)
const canReorderDesktopTracks = computed(
  () =>
    (canRemoveTracksFromDesktopPlaylist.value || canEditUsbPlaylist.value) &&
    !loading.value &&
    !playlistMutationPending.value &&
    !hasActiveTrackFilters.value &&
    (!sortedTrackColumn.value ||
      (sortedTrackColumn.value.key === 'index' && sortedTrackColumn.value.order === 'asc'))
)
const canRenumberDesktopTracks = computed(
  () =>
    (canRemoveTracksFromDesktopPlaylist.value || canEditUsbPlaylist.value) &&
    !loading.value &&
    !playlistMutationPending.value &&
    visibleSongs.value.length > 1 &&
    Boolean(sortedTrackColumn.value) &&
    sortedTrackColumn.value?.key !== 'index' &&
    (!canEditUsbPlaylist.value || !hasActiveTrackFilters.value)
)

const showFileMissingHint = async (missingTracks: ISongInfo[]) => {
  const paths = missingTracks.map((item) => item.filePath).filter(Boolean)
  const content = [
    t('pioneer.fileMissingHintDetail', { count: missingTracks.length }),
    t('pioneer.fileMissingHintAction'),
    paths.length ? t('pioneer.fileMissingPathListTitle') : t('pioneer.fileMissingPathUnavailable'),
    ...paths.slice(0, 10),
    ...(paths.length > 10 ? [t('pioneer.fileMissingPathMore', { count: paths.length - 10 })] : [])
  ]
  await confirm({
    title: t('pioneer.fileMissingHint'),
    content,
    confirmShow: false,
    innerWidth: 620,
    innerHeight: 0,
    textAlign: 'left',
    canCopyText: paths.length > 0
  })
}

const resolveExistingOperationTracks = async (tracks: ISongInfo[]) => {
  const missingPathSet = new Set(
    tracks.filter((item) => item.fileMissing || !item.filePath).map((item) => item.filePath)
  )
  const pathsToCheck = Array.from(
    new Set(
      tracks.filter((item) => !item.fileMissing && item.filePath).map((item) => item.filePath)
    )
  )

  if (pathsToCheck.length) {
    const existenceMap = (await window.electron.ipcRenderer.invoke(
      'check-paths-exist',
      pathsToCheck
    )) as Record<string, boolean>
    for (const filePath of pathsToCheck) {
      if (existenceMap[filePath] === false) {
        missingPathSet.add(filePath)
      }
    }
  }

  if (missingPathSet.size > 0) {
    originalTracks.value = originalTracks.value.map((track) =>
      missingPathSet.has(track.filePath) ? { ...track, fileMissing: true } : track
    )
    applyFiltersAndSorting('fileMissing-changed')
  }

  const updatedTracks = tracks.map((track) =>
    missingPathSet.has(track.filePath) ? { ...track, fileMissing: true } : track
  )
  const missingTracks = updatedTracks.filter((track) => track.fileMissing || !track.filePath)
  const existingTracks = updatedTracks.filter((track) => !track.fileMissing && track.filePath)

  return {
    updatedTracks,
    missingTracks,
    existingTracks
  }
}

const {
  selectSongListDialogVisible,
  selectSongListDialogTargetLibraryName,
  openCopyTargetDialog,
  handleSelectSongListDialogConfirm,
  handleSelectSongListDialogCancel
} = usePioneerTrackCopyDialog({
  resolveTrackKey,
  resolveSelectedTracksByKeys,
  resolveSelectedTracks,
  resolveExistingOperationTracks,
  showFileMissingHint,
  normalizePath,
  buildSongSnapshot,
  originPathSnapshot
})

const handleColumnsUpdate = (nextColumns: ISongsAreaColumn[]) => {
  columnData.value = nextColumns
  persistColumnData()
  applyFiltersAndSorting('columns-updated')
  selectedRowKeys.value = []
}

watch(columnData, () => persistColumnData(), { deep: true })
watch(
  () => [
    pioneerSongsAreaState.searchQuery,
    pioneerSongsAreaState.compatibleKeyOnly,
    harmonicReferenceKey.value
  ],
  () => {
    void applyFiltersAndSorting('search-or-compatible-key-changed')
  }
)
watch(visibleSongs, () => {
  pioneerSongsAreaState.totalSongCount = originalTracks.value.length
})

// --- 列头右键菜单 ---
const colRightClickMenuShow = ref(false)
const triggeringColContextEvent = ref<MouseEvent | null>(null)
const contextmenuEvent = (event: MouseEvent) => {
  triggeringColContextEvent.value = event
  colRightClickMenuShow.value = true
}

const handleToggleColumnVisibility = (columnKey: string) => {
  const columnIndex = columnData.value.findIndex((col) => col.key === columnKey)
  if (columnIndex !== -1) {
    columnData.value = columnData.value.map((col, index) => {
      if (index === columnIndex) {
        return { ...col, show: !col.show }
      }
      return col
    })
  }
}

const handleColumnClick = (column: ISongsAreaColumn) => {
  if (column.key === 'cover' || column.key === 'waveformPreview') return
  columnData.value = columnData.value.map((item) => {
    if (item.key !== column.key) return { ...item, order: undefined }
    const nextOrder = item.order === 'asc' ? 'desc' : item.order === 'desc' ? 'asc' : 'asc'
    return { ...item, order: nextOrder as 'asc' | 'desc' }
  })
  persistColumnData()
  applyFiltersAndSorting('column-sort-click')
}

const isCurrentPlaylistLoadTarget = (sourceCacheKey: string, playlistId: number) =>
  !disposed &&
  Boolean(pioneerSongsAreaState.djPlaylist) &&
  selectedSourceCacheKey.value === sourceCacheKey &&
  selectedPlaylistId.value === playlistId

const { loadPlaylistTracks, refreshPlaylistTracks } = usePioneerPlaylistTracks({
  selectedSourceCacheKey,
  currentPlaybackListKey,
  selectedPlaylistId,
  selectedSourceKind,
  selectedExternalKind,
  selectedSourceRootPath,
  selectedLibraryType,
  originalTracks,
  visibleSongs,
  loading,
  selectedRowKeys,
  applyFiltersAndSorting,
  applyFiltersAndSortingMerged,
  isCurrentPlaylistLoadTarget,
  emitPioneerSongsAreaLog
})

const handleDjPlaylistRefresh = (payload?: { sourceKey: string; playlistId: number }) => {
  if (!isDesktopSource.value && !isExternalSource.value) return
  if (payload?.sourceKey !== selectedSourceKey.value) return
  if (payload.playlistId !== selectedPlaylistId.value) return
  void loadPlaylistTracks()
}
emitter.on('dj-library:refresh-selected-playlist', handleDjPlaylistRefresh)

const {
  playlistMutationPending: desktopPlaylistMutationPending,
  removeTracksFromDesktopPlaylist,
  reorderTracksInDesktopPlaylist,
  renumberTracksInDesktopPlaylist
} = usePioneerDesktopPlaylistActions({
  runtime,
  selectedPlaylistId,
  selectedExternalKind,
  selectedSourceRootPath,
  selectedSourceCacheKey,
  currentPlaybackListKey,
  selectedTreeNodes: treeNodes,
  visibleSongs,
  refreshPlaylistTracks
})

const {
  usbWriting,
  removeUsbTracks,
  deleteUsbTracks,
  deleteUsbPlaylist,
  saveUsbOrder,
  reorderUsbTracks
} = usePioneerUsbPlaylistActions({
  runtime,
  enabled: canEditUsbPlaylist,
  originalTracks,
  selectedRowKeys,
  selectedPlaylistId,
  selectedSourceRootPath,
  selectedLibraryType,
  selectedSourceCacheKey,
  selectedPlaylistNode,
  onTreeUpdated: (nodes, selectedId) => {
    browser.value.treeNodes = nodes
    if (!selectedId) runtime.clearSongsAreaPaneState(props.pane)
  },
  refreshPlaylistTracks
})
const playlistMutationPending = computed(
  () => desktopPlaylistMutationPending.value || usbWriting.value
)

const { handleSongContextMenu } = usePioneerSongContextMenu({
  runtime,
  selectedRowKeys,
  playlistMutationPending,
  canRemoveTracksFromDesktopPlaylist,
  canEditUsbPlaylist,
  selectedSourceCacheKey,
  removeUsbTracks,
  deleteUsbTracks,
  currentPlaybackListKey,
  cancelPendingRepeatSingleClickDeselect,
  resolveSelectedTracks,
  resolveExistingOperationTracks,
  showFileMissingHint,
  openCopyTargetDialog,
  removeTracksFromDesktopPlaylist
})

watch(
  () =>
    [
      selectedSourceRootPath.value,
      selectedPlaylistId.value,
      selectedSourceKind.value,
      selectedExternalKind.value
    ] as const,
  () => {
    emitPioneerSongsAreaLog('source-or-playlist-changed')
    try {
      emitter.emit('waveform-preview:stop', { reason: 'switch' })
    } catch {}
    void loadPlaylistTracks()
  },
  { immediate: true }
)

watch(
  () =>
    [
      selectedSourceCacheKey.value,
      selectedPlaylistId.value,
      Array.isArray(treeNodes.value) ? treeNodes.value.length : 0
    ] as const,
  ([sourceCacheKey, playlistId, treeNodeCount]) => {
    if (!sourceCacheKey) return
    if (playlistId <= 0 && treeNodeCount <= 0) return
    rememberRekordboxSourceSelectedPlaylist(sourceCacheKey, playlistId)
  },
  { immediate: true }
)

watch(
  () => runtime.setting.keyDisplayStyle,
  () => {
    applyFiltersAndSorting('key-display-style-changed')
  }
)

const handleSongClick = (event: MouseEvent, song: ISongInfo) => {
  if (playlistMutationPending.value) return
  songClick(event, song)
}

const handlePreviewMoveRequest = (
  payload?: Record<string, unknown> & { song?: ISongInfo | null }
) => {
  if (String(payload?.sourceLibraryName || '').trim() !== 'PioneerDeviceLibrary') return
  if (String(payload?.sourceSongListUUID || '').trim() !== currentPlaybackListKey.value) return
  const targetLibraryName = payload?.targetLibraryName as PioneerTransferTarget | undefined
  const song = payload?.song
  if (!song?.filePath || !targetLibraryName) return
  const rowKey = song.mixtapeItemId || song.filePath
  if (!rowKey) return
  const exists = visibleSongs.value.some((item) => (item.mixtapeItemId || item.filePath) === rowKey)
  if (!exists) return
  selectedRowKeys.value = [rowKey]
  openCopyTargetDialog(targetLibraryName)
}
emitter.on('preview-transfer:open-dialog', handlePreviewMoveRequest)
const handleUsbDeletePlaylistRequest = (payload: unknown) => {
  const panes = runtime.songsAreaPanels.splitEnabled
    ? [runtime.songsArea, runtime.songsAreaPanels.panes.left, runtime.songsAreaPanels.panes.right]
    : [runtime.songsAreaPanels.panes.single]
  const owner = panes.find((state) => state.songListUUID === currentPlaybackListKey.value)
  if (owner !== pioneerSongsAreaState) return
  if (
    !canEditUsbPlaylist.value ||
    !matchesPioneerUsbPlaylistDeleteRequest(
      payload,
      {
        sourceKind: selectedSourceKind.value,
        sourceKey: selectedSourceKey.value,
        rootPath: selectedSourceRootPath.value,
        libraryType: selectedLibraryType.value,
        external: isExternalSource.value
      },
      selectedPlaylistId.value
    )
  )
    return
  void deleteUsbPlaylist()
}
emitter.on('pioneerUsb/open-delete-playlist', handleUsbDeletePlaylistRequest)

// 播放器标记文件缺失时，同步更新原始数据使 UI 立即变色
const handleSongFileMissing = (payload: { listUUID?: string; filePath?: string }) => {
  if (!payload?.filePath) return
  if (currentPlaybackListKey.value && payload.listUUID === currentPlaybackListKey.value) {
    const missingPath = payload.filePath
    originalTracks.value = originalTracks.value.map((track) =>
      sameRendererFilePath(track.filePath, missingPath) ? { ...track, fileMissing: true } : track
    )
    applyFiltersAndSorting('fileMissing-changed')
  }
}
emitter.on('songFileMissing', handleSongFileMissing)

const handleSongFileRestored = (payload: { listUUID?: string; filePath?: string }) => {
  if (!payload?.filePath) return
  if (currentPlaybackListKey.value && payload.listUUID === currentPlaybackListKey.value) {
    const restoredPath = payload.filePath
    originalTracks.value = originalTracks.value.map((track) =>
      sameRendererFilePath(track.filePath, restoredPath) ? { ...track, fileMissing: false } : track
    )
    applyFiltersAndSorting('fileRestored-changed')
  }
}
emitter.on('songFileRestored', handleSongFileRestored)

const handlePlaylistReorder = async (payload: { sourceItemIds: string[]; targetIndex: number }) => {
  if (canEditUsbPlaylist.value) {
    if (canReorderDesktopTracks.value)
      await reorderUsbTracks(payload.sourceItemIds, payload.targetIndex, visibleSongs.value)
    return
  }
  await reorderTracksInDesktopPlaylist(
    payload.sourceItemIds,
    payload.targetIndex,
    canReorderDesktopTracks.value
  )
}

const handleRenumberTracksByVisibleOrder = async () => {
  if (canEditUsbPlaylist.value) {
    if (canRenumberDesktopTracks.value) await saveUsbOrder(visibleSongs.value)
    return
  }
  await renumberTracksInDesktopPlaylist(visibleSongs.value, canRenumberDesktopTracks.value)
}

const { handleSongDragStart, handleSongDragEnd } = usePioneerSongDrag({
  selectedRowKeys,
  visibleSongs,
  currentPlaybackListKey,
  resolveSelectedTracks
})

const handleSongDblClick = async (song: ISongInfo, event?: MouseEvent) => {
  cancelPendingRepeatSingleClickDeselect()
  cancelPendingShiftSelect()
  if (!song.fileMissing && song.filePath) {
    const exists = await window.electron.ipcRenderer.invoke('check-path-exists', song.filePath)
    if (!exists) {
      const missingPath = song.filePath
      originalTracks.value = originalTracks.value.map((track) =>
        sameRendererFilePath(track.filePath, missingPath) ? { ...track, fileMissing: true } : track
      )
      applyFiltersAndSorting('fileMissing-changed')
      song.fileMissing = true
    }
  }
  if (song.fileMissing) {
    const songName = String(song.title || song.fileName || '').trim()
    const content = [
      t('pioneer.fileMissingSingleDetail'),
      ...(songName ? [t('pioneer.fileMissingTrackName', { name: songName })] : []),
      song.filePath
        ? t('pioneer.fileMissingPathListTitle')
        : t('pioneer.fileMissingPathUnavailable'),
      ...(song.filePath ? [song.filePath] : []),
      t('pioneer.fileMissingSingleAction')
    ]
    await confirm({
      title: t('pioneer.fileMissingHint'),
      content,
      confirmShow: false,
      innerWidth: 620,
      innerHeight: 0,
      textAlign: 'left',
      canCopyText: Boolean(song.filePath)
    })
    return
  }
  if (playlistMutationPending.value) return
  try {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  } catch {}
  runtime.activeMenuUUID = ''
  selectedRowKeys.value = []

  const normalizedSong = { ...song }
  if (runtime.mainWindowBrowseMode !== 'browser') {
    const deck =
      runtime.mainWindowBrowseMode === 'edit' ? 'top' : event?.shiftKey ? 'bottom' : 'top'
    const playbackListKey = currentPlaybackListKey.value
    if (playbackListKey) {
      runtime.playingData.playingSongListUUID = playbackListKey
      runtime.playingData.playingSongListData = [...visibleSongs.value]
    }
    beginHorizontalBrowseDeckInteraction(deck, String(normalizedSong.filePath || '').trim())
    sendHorizontalBrowseInteractionTrace('song-dblclick', {
      source: 'pioneerSongsArea',
      deck,
      filePath: String(normalizedSong.filePath || '').trim()
    })
    emitter.emit('horizontalBrowse/load-song', {
      deck,
      song: normalizedSong
    })
    return
  }
  const playbackListKey = currentPlaybackListKey.value
  if (!playbackListKey) return
  const isSameList = runtime.playingData.playingSongListUUID === playbackListKey
  const isSameSong =
    isSameList &&
    sameRendererFilePath(runtime.playingData.playingSong?.filePath, normalizedSong.filePath)

  runtime.playingData.playingSongListUUID = playbackListKey
  runtime.playingData.playingSongListData = [...visibleSongs.value]

  if (isSameSong && runtime.playingData.playingSong) {
    runtime.playingData.playingSong = normalizedSong
    emitter.emit('player/replay-current-song')
    return
  }

  runtime.playingData.playingSong = normalizedSong
}

onUnmounted(() => {
  disposed = true
  cancelPendingRepeatSingleClickDeselect()
  emitter.off('songsArea/focus-song', handleFocusSongRequest)
  emitter.off('dj-library:refresh-selected-playlist', handleDjPlaylistRefresh)
  emitter.off('preview-transfer:open-dialog', handlePreviewMoveRequest)
  emitter.off('pioneerUsb/open-delete-playlist', handleUsbDeletePlaylistRequest)
  emitter.off('songFileMissing', handleSongFileMissing)
  emitter.off('songFileRestored', handleSongFileRestored)
})
</script>

<template>
  <div class="songsAreaShell">
    <div v-if="placeholderText && (loading || !originalTracks.length)" class="songsAreaPlaceholder">
      <span v-if="loading" class="songsAreaLoadingSpinner" aria-hidden="true"></span>
      <span>{{ placeholderText }}</span>
    </div>
    <OverlayScrollbarsComponent
      v-else
      ref="songsAreaRef"
      :options="{
        scrollbars: {
          autoHide: 'leave' as const,
          autoHideDelay: 50,
          clickScroll: true
        } as const,
        overflow: {
          x: 'scroll',
          y: 'scroll'
        } as const
      }"
      element="div"
      style="flex: 1; min-height: 0; width: 100%; position: relative"
      @click="handleOverlayClick"
    >
      <SongListHeader
        :columns="columnData"
        :t="t"
        :ascending-order="ascendingOrder"
        :descending-order="descendingOrder"
        :total-width="totalWidth"
        :show-index-action="canRenumberDesktopTracks"
        :index-action-title="t('rekordboxDesktop.renumberPlaylistTracksAction')"
        :index-action-disabled="playlistMutationPending || loading"
        @update:columns="handleColumnsUpdate"
        @columns-preview="handleColumnDragPreview"
        @column-click="handleColumnClick"
        @header-contextmenu="contextmenuEvent"
        @index-action-click="handleRenumberTracksByVisibleOrder"
      />

      <SongListRows
        :songs="visibleSongs"
        :search-query="pioneerSongsAreaState.searchQuery"
        :visible-columns="rowsVisibleColumns"
        :selected-song-file-paths="selectedRowKeysForTemplate"
        :playing-song-file-path="playingSongFilePathForRows"
        :playing-song-file-paths="playingSongFilePathsForRows"
        :flash-row-key="locateFlashRowKey"
        :flash-row-token="locateFlashRowToken"
        :harmonic-reference-key="harmonicReferenceKeyForRows"
        :total-width="totalWidth"
        source-library-name="PioneerDeviceLibrary"
        :source-song-list-u-u-i-d="
          currentPlaybackListKey ||
          `${selectedExternalKind || selectedSourceKind || 'usb'}:${selectedPlaylistId}`
        "
        :scroll-host-element="songsAreaRef?.osInstance()?.elements().viewport"
        :external-scroll-top="externalScrollTop"
        :external-viewport-height="externalViewportHeight"
        :external-waveform-root-path="selectedSourceRootPath"
        :read-only="true"
        :allow-context-menu-when-read-only="true"
        :allow-dblclick-when-read-only="true"
        :allow-waveform-preview-when-read-only="true"
        :allow-song-drag-when-read-only="true"
        :internal-mouse-drag="canEditUsbPlaylist"
        :reorder-mode="canReorderDesktopTracks ? 'playlist' : 'none'"
        song-list-root-dir="library/PioneerDeviceLibrary"
        :enable-cover-thumbnails="true"
        @song-click="handleSongClick"
        @song-contextmenu="handleSongContextMenu"
        @song-dblclick="handleSongDblClick"
        @song-dragstart="handleSongDragStart"
        @song-dragend="handleSongDragEnd"
        @playlist-reorder="handlePlaylistReorder"
      />
      <div v-if="!visibleSongs.length" class="songsAreaPlaceholder songsAreaPlaceholder--filtered">
        {{ t('filters.noResults') }}
      </div>
    </OverlayScrollbarsComponent>
    <ColumnHeaderContextMenu
      v-model="colRightClickMenuShow"
      :target-event="triggeringColContextEvent"
      :columns="columnData"
      :independent-settings="independentSettings"
      @toggle-column-visibility="handleToggleColumnVisibility"
      @reset-to-shared-settings="resetToSharedSettings"
    />
    <RekordboxDesktopWritingOverlay v-if="desktopPlaylistMutationPending" />
    <Teleport to="body">
      <selectSongListDialog
        v-if="selectSongListDialogVisible"
        :library-name="selectSongListDialogTargetLibraryName"
        action-mode="copy"
        @confirm="handleSelectSongListDialogConfirm"
        @cancel="handleSelectSongListDialogCancel"
      />
    </Teleport>
  </div>
</template>

<style scoped lang="scss">
.songsAreaShell {
  color: var(--text);
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
}

.songsAreaPlaceholder {
  width: 100%;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--text-weak);
  font-size: 12px;
}

.songsAreaLoadingSpinner {
  width: 10px;
  height: 10px;
  box-sizing: border-box;
  border: 1.5px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: songsAreaLoadingSpin 0.7s linear infinite;
}

.songsAreaPlaceholder--filtered {
  min-height: 100px;
}

@keyframes songsAreaLoadingSpin {
  to {
    transform: rotate(360deg);
  }
}
</style>
