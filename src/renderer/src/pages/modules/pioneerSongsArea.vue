<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, watch, useTemplateRef } from 'vue'
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
import { sendHorizontalBrowseInteractionTrace } from '@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTrace'
import { beginHorizontalBrowseDeckInteraction } from '@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTimeline'
import { t } from '@renderer/utils/translate'
import {
  buildRekordboxSourceCacheKey,
  rememberRekordboxSourceSelectedPlaylist
} from '@renderer/utils/rekordboxLibraryCache'
import { buildSongsAreaDefaultColumns } from '@renderer/pages/modules/songsArea/composables/useSongsAreaColumns'
import ColumnHeaderContextMenu from '@renderer/pages/modules/songsArea/ColumnHeaderContextMenu.vue'
import { useWaveformPreviewPlayer } from '@renderer/pages/modules/songsArea/composables/useWaveformPreviewPlayer'
import { useKeyboardSelection } from '@renderer/pages/modules/songsArea/composables/useKeyboardSelection'
import { useAutoScrollToCurrent } from '@renderer/pages/modules/songsArea/composables/useAutoScrollToCurrent'
import { useSongLocateFlash } from '@renderer/pages/modules/songsArea/composables/useSongLocateFlash'
import type { ISongsAreaPaneRuntimeState, SongsAreaPaneKey } from '@renderer/stores/runtime'
import { useParentRafSampler } from '@renderer/pages/modules/songsArea/composables/useParentRafSampler'
import { usePioneerDesktopPlaylistActions } from './pioneerSongsArea/usePioneerDesktopPlaylistActions'
import { usePioneerPlaylistTracks } from './pioneerSongsArea/usePioneerPlaylistTracks'
import { usePioneerSongDrag } from './pioneerSongsArea/usePioneerSongDrag'
import { usePioneerSongContextMenu } from './pioneerSongsArea/usePioneerSongContextMenu'
import { usePioneerSongsPlaceholder } from './pioneerSongsArea/usePioneerSongsPlaceholder'
import { usePioneerSongsProjection } from './pioneerSongsArea/usePioneerSongsProjection'
import {
  usePioneerTrackCopyDialog,
  type PioneerTransferTarget
} from './pioneerSongsArea/usePioneerTrackCopyDialog'
import type {
  IPioneerPlaylistTrack,
  IPioneerPlaylistTreeNode,
  IRekordboxSourceKind,
  ISongInfo,
  ISongsAreaColumn
} from '../../../../types/globals'

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

const runtime = useRuntimeStore()
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')
const handleOverlayClick = (e: MouseEvent) => {
  if (e.button === 0) selectedRowKeys.value = []
}
const originalTracks = shallowRef<IPioneerPlaylistTrack[]>([])
const visibleSongs = ref<ISongInfo[]>([])
const loading = ref(false)
const selectedRowKeys = ref<string[]>([])
const columnData = ref<ISongsAreaColumn[]>(
  buildSongsAreaDefaultColumns('default').map((column) =>
    column.key === 'index' ? { ...column, width: Math.max(column.width, 74) } : column
  )
)

const ascendingOrder = ascendingOrderAsset
const descendingOrder = descendingOrderAsset
const { externalScrollTop, externalViewportHeight } = useParentRafSampler({ songsAreaRef })
useWaveformPreviewPlayer()

const pioneerSongsAreaState = {
  get songListUUID() {
    return currentPlaybackListKey?.value || ''
  },
  get songInfoArr() {
    return visibleSongs.value
  },
  get totalSongCount() {
    return visibleSongs.value.length
  },
  get selectedSongFilePath() {
    return selectedRowKeys.value
  },
  set selectedSongFilePath(v: string[]) {
    selectedRowKeys.value = v
  },
  get scrollTop() {
    return 0
  },
  set scrollTop(value: number) {
    void value
  },
  get scrollLeft() {
    return 0
  },
  set scrollLeft(value: number) {
    void value
  },
  columnCacheByMode: {}
} as unknown as ISongsAreaPaneRuntimeState
const { songClick, cancelPendingRepeatSingleClickDeselect, cancelPendingShiftSelect } =
  useKeyboardSelection({
    runtime,
    songsAreaState: pioneerSongsAreaState,
    externalViewportHeight,
    readOnly: true
  })
const selectedRowKeysForTemplate = computed(() => [...selectedRowKeys.value])

const selectedSourceKey = computed(() => runtime.pioneerDeviceLibrary.selectedSourceKey || '')
const selectedSourceKind = computed<IRekordboxSourceKind | ''>(
  () => runtime.pioneerDeviceLibrary.selectedSourceKind || ''
)
const isDesktopSource = computed(() => selectedSourceKind.value === 'desktop')
const selectedSourceName = computed(() => {
  if (runtime.pioneerDeviceLibrary.selectedSourceName) {
    return runtime.pioneerDeviceLibrary.selectedSourceName
  }
  return isDesktopSource.value ? t('pioneer.desktopLibraryName') : 'Pioneer USB'
})
const selectedPlaylistId = computed(() => runtime.pioneerDeviceLibrary.selectedPlaylistId || 0)
const selectedSourceRootPath = computed(
  () => runtime.pioneerDeviceLibrary.selectedSourceRootPath || ''
)
const selectedLibraryType = computed(
  () => runtime.pioneerDeviceLibrary.selectedLibraryType || 'deviceLibrary'
)

const selectedPlaylistNode = computed(() => {
  const targetId = selectedPlaylistId.value
  if (!targetId) return null
  const walk = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode | null => {
    for (const item of items) {
      if (item.id === targetId) return item
      if (Array.isArray(item.children) && item.children.length > 0) {
        const found = walk(item.children)
        if (found) return found
      }
    }
    return null
  }
  return walk(runtime.pioneerDeviceLibrary.treeNodes || [])
})
const currentPlaybackListKey = computed(() => {
  if (!selectedPlaylistId.value) return ''
  const sourceKey = selectedSourceKey.value || selectedSourceRootPath.value || 'rekordbox'
  const sourceKind = selectedSourceKind.value || 'usb'
  return `${sourceKind}:${sourceKey}:${selectedPlaylistId.value}`
})
const selectedSourceCacheKey = computed(() =>
  buildRekordboxSourceCacheKey({
    sourceKind: selectedSourceKind.value,
    sourceKey: selectedSourceKey.value,
    rootPath: selectedSourceRootPath.value,
    libraryType: selectedLibraryType.value
  })
)

const visibleColumns = computed(() => columnData.value.filter((item) => item.show))
const totalWidth = computed(() =>
  visibleColumns.value.reduce((sum, col) => sum + Number(col.width || 0), 0)
)
const playingSongFilePathForRows = computed(() => {
  if (!currentPlaybackListKey.value) return undefined
  if (runtime.playingData.playingSongListUUID !== currentPlaybackListKey.value) return undefined
  const playingSong = runtime.playingData.playingSong
  return playingSong?.mixtapeItemId || playingSong?.filePath || undefined
})
const playingSongFilePathsForRows = computed(() => {
  const keys = new Set<string>()
  const mainRowKey = playingSongFilePathForRows.value
  if (mainRowKey) keys.add(mainRowKey)
  const topDeckSong = runtime.horizontalBrowseDecks.topSong
  if (topDeckSong) {
    const key = String(topDeckSong.mixtapeItemId || topDeckSong.filePath || '').trim()
    if (key) keys.add(key)
  }
  const bottomDeckSong = runtime.horizontalBrowseDecks.bottomSong
  if (bottomDeckSong) {
    const key = String(bottomDeckSong.mixtapeItemId || bottomDeckSong.filePath || '').trim()
    if (key) keys.add(key)
  }
  return [...keys]
})
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
  const playlistLabel = selectedPlaylistNode.value?.name || ''
  return playlistLabel ? `${driveLabel} / ${playlistLabel}` : driveLabel
})

const emitPioneerSongsAreaLog = (_event: string, _payload?: Record<string, unknown>) => {}

const {
  applyFiltersAndSorting,
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
  getKeyDisplayStyle: () => runtime.setting.keyDisplayStyle || '',
  getCurrentPlaybackListKey: () => currentPlaybackListKey.value,
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
  if (payload?.pane !== 'pioneer') return
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
  selectedPlaylistId,
  originalTracks,
  visibleSongs,
  columnData,
  emitPioneerSongsAreaLog
})

const canRemoveTracksFromDesktopPlaylist = computed(
  () =>
    isDesktopSource.value &&
    Boolean(selectedPlaylistNode.value) &&
    !selectedPlaylistNode.value?.isFolder &&
    !selectedPlaylistNode.value?.isSmartPlaylist
)
const hasActiveTrackFilters = computed(() =>
  columnData.value.some((col) => Boolean(col.filterActive))
)
const sortedTrackColumn = computed(() => columnData.value.find((col) => Boolean(col.order)) || null)
const canReorderDesktopTracks = computed(
  () =>
    canRemoveTracksFromDesktopPlaylist.value &&
    !loading.value &&
    !playlistMutationPending.value &&
    !hasActiveTrackFilters.value &&
    (!sortedTrackColumn.value ||
      (sortedTrackColumn.value.key === 'index' && sortedTrackColumn.value.order === 'asc'))
)
const canRenumberDesktopTracks = computed(
  () =>
    canRemoveTracksFromDesktopPlaylist.value &&
    !loading.value &&
    !playlistMutationPending.value &&
    visibleSongs.value.length > 1 &&
    Boolean(sortedTrackColumn.value) &&
    sortedTrackColumn.value?.key !== 'index'
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
  applyFiltersAndSorting('columns-updated')
  selectedRowKeys.value = []
}

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
  applyFiltersAndSorting('column-sort-click')
}

const isCurrentPlaylistLoadTarget = (sourceCacheKey: string, playlistId: number) =>
  selectedSourceCacheKey.value === sourceCacheKey && selectedPlaylistId.value === playlistId

const { loadPlaylistTracks } = usePioneerPlaylistTracks({
  selectedSourceCacheKey,
  selectedPlaylistId,
  selectedSourceKind,
  selectedSourceRootPath,
  selectedLibraryType,
  originalTracks,
  visibleSongs,
  loading,
  selectedRowKeys,
  applyFiltersAndSorting,
  isCurrentPlaylistLoadTarget,
  emitPioneerSongsAreaLog
})

const {
  playlistMutationPending,
  removeTracksFromDesktopPlaylist,
  reorderTracksInDesktopPlaylist,
  renumberTracksInDesktopPlaylist
} = usePioneerDesktopPlaylistActions({
  runtime,
  selectedPlaylistId,
  selectedSourceCacheKey,
  currentPlaybackListKey,
  visibleSongs,
  selectedRowKeys,
  loadPlaylistTracks
})

const { handleSongContextMenu } = usePioneerSongContextMenu({
  runtime,
  selectedRowKeys,
  playlistMutationPending,
  canRemoveTracksFromDesktopPlaylist,
  currentPlaybackListKey,
  cancelPendingRepeatSingleClickDeselect,
  resolveSelectedTracks,
  resolveExistingOperationTracks,
  showFileMissingHint,
  openCopyTargetDialog,
  removeTracksFromDesktopPlaylist
})

watch(
  () => [selectedSourceRootPath.value, selectedPlaylistId.value, selectedSourceKind.value] as const,
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
      Array.isArray(runtime.pioneerDeviceLibrary.treeNodes)
        ? runtime.pioneerDeviceLibrary.treeNodes.length
        : 0
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

watch(
  selectedRowKeys,
  (keys) => {
    runtime.pioneerSelectedRowKeys = [...keys]
  },
  { deep: true }
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

// 播放器标记文件缺失时，同步更新原始数据使 UI 立即变色
const handleSongFileMissing = (payload: { listUUID?: string; filePath?: string }) => {
  if (!payload?.filePath) return
  if (currentPlaybackListKey.value && payload.listUUID === currentPlaybackListKey.value) {
    const missingPath = payload.filePath
    originalTracks.value = originalTracks.value.map((track) =>
      track.filePath === missingPath ? { ...track, fileMissing: true } : track
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
      track.filePath === restoredPath ? { ...track, fileMissing: false } : track
    )
    applyFiltersAndSorting('fileRestored-changed')
  }
}
emitter.on('songFileRestored', handleSongFileRestored)

const handlePlaylistReorder = async (payload: { sourceItemIds: string[]; targetIndex: number }) => {
  await reorderTracksInDesktopPlaylist(
    payload.sourceItemIds,
    payload.targetIndex,
    canReorderDesktopTracks.value
  )
}

const handleRenumberTracksByVisibleOrder = async () => {
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
        track.filePath === missingPath ? { ...track, fileMissing: true } : track
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
    isSameList && runtime.playingData.playingSong?.filePath === normalizedSong.filePath

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
  cancelPendingRepeatSingleClickDeselect()
  emitter.off('songsArea/focus-song', handleFocusSongRequest)
  emitter.off('preview-transfer:open-dialog', handlePreviewMoveRequest)
  emitter.off('songFileMissing', handleSongFileMissing)
  emitter.off('songFileRestored', handleSongFileRestored)
})
</script>

<template>
  <div class="songsAreaShell">
    <div v-if="placeholderText" class="songsAreaPlaceholder">
      {{ placeholderText }}
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
      style="height: 100%; width: 100%; position: relative"
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
        @column-click="handleColumnClick"
        @header-contextmenu="contextmenuEvent"
        @index-action-click="handleRenumberTracksByVisibleOrder"
      />

      <SongListRows
        :songs="visibleSongs"
        :visible-columns="visibleColumns"
        :selected-song-file-paths="selectedRowKeysForTemplate"
        :playing-song-file-path="playingSongFilePathForRows"
        :playing-song-file-paths="playingSongFilePathsForRows"
        :flash-row-key="locateFlashRowKey"
        :flash-row-token="locateFlashRowToken"
        :harmonic-reference-key="harmonicReferenceKeyForRows"
        :total-width="totalWidth"
        source-library-name="PioneerDeviceLibrary"
        :source-song-list-u-u-i-d="
          currentPlaybackListKey || `${selectedSourceKind || 'usb'}:${selectedPlaylistId}`
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
    </OverlayScrollbarsComponent>
    <ColumnHeaderContextMenu
      v-model="colRightClickMenuShow"
      :target-event="triggeringColContextEvent"
      :columns="columnData"
      @toggle-column-visibility="handleToggleColumnVisibility"
    />
    <RekordboxDesktopWritingOverlay v-if="playlistMutationPending" />
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
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
}

.songsAreaPlaceholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  font-size: 12px;
}
</style>
