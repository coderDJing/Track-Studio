<script setup lang="ts">
import {
  ref,
  shallowRef,
  computed,
  useTemplateRef,
  onMounted,
  onUnmounted,
  watch,
  nextTick
} from 'vue'
import { type SongsAreaPaneKey, useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import { sendHorizontalBrowseInteractionTrace } from '@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTrace'
import { beginHorizontalBrowseDeckInteraction } from '@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTimeline'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'
import { ISongInfo } from '../../../../../types/globals'
import { RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { requestUserGuideStep } from '@renderer/composables/userGuideBridge'
import { waitForUserGuideHole } from '@renderer/composables/userGuideTargets'
import { activateSongsAreaPane } from '@renderer/utils/songsAreaSplit'
import { queueMainPlayerPlayingAnalysis } from '@renderer/utils/playlistAnalysisGate'
import type { MoveSongsLibraryName } from '@renderer/pages/modules/songsArea/composables/useSelectAndMoveSongs'
import { usePlaylistAnalysisPrompt } from '@renderer/pages/modules/songsArea/composables/usePlaylistAnalysisPrompt'
import { useSongsAreaEmptyState } from '@renderer/pages/modules/songsArea/composables/useSongsAreaEmptyState'

import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import welcomePage from '@renderer/components/welcomePage.vue'
import SongListHeader from './SongListHeader.vue'
import SongListRows from './SongListRows.vue'
import ColumnHeaderContextMenu from './ColumnHeaderContextMenu.vue'
import PlaylistAnalysisFloatingButton from './PlaylistAnalysisFloatingButton.vue'

import { useSongItemContextMenu } from '@renderer/pages/modules/songsArea/composables/useSongItemContextMenu'
import { useSelectAndMoveSongs } from '@renderer/pages/modules/songsArea/composables/useSelectAndMoveSongs'
import { useDragSongs } from '@renderer/pages/modules/songsArea/composables/useDragSongs'
import { useSongsAreaColumns } from '@renderer/pages/modules/songsArea/composables/useSongsAreaColumns'
import { useColumnDragPreview } from '@renderer/pages/modules/songsArea/composables/useColumnDragPreview'
import { useSongsAreaPlayingFollow } from '@renderer/pages/modules/songsArea/composables/useSongsAreaPlayingFollow'
import { useSongsLoader } from '@renderer/pages/modules/songsArea/composables/useSongsLoader'
import { useSweepCovers } from '@renderer/pages/modules/songsArea/composables/useSweepCovers'
import { useKeyboardSelection } from '@renderer/pages/modules/songsArea/composables/useKeyboardSelection'
import { useAutoScrollToCurrent } from '@renderer/pages/modules/songsArea/composables/useAutoScrollToCurrent'
import { useParentRafSampler } from '@renderer/pages/modules/songsArea/composables/useParentRafSampler'
import { useSongsAreaEvents } from '@renderer/pages/modules/songsArea/composables/useSongsAreaEvents'
import { useWaveformPreviewPlayer } from '@renderer/pages/modules/songsArea/composables/useWaveformPreviewPlayer'
import { useGlobalSearchFocus } from '@renderer/pages/modules/songsArea/composables/useGlobalSearchFocus'
import { useSongLocateFlash } from '@renderer/pages/modules/songsArea/composables/useSongLocateFlash'
import { useSongsAreaDragAndDrop } from '@renderer/pages/modules/songsArea/composables/useSongsAreaDragAndDrop'
import { usePlaylistTrackNumbers } from '@renderer/pages/modules/songsArea/composables/usePlaylistTrackNumbers'
import { detectSongsAreaScrollCarrier } from '@renderer/pages/modules/songsArea/composables/scrollCarrier'
import {
  resolveDisplayedSongList,
  shouldHoldSongListLoading
} from '@renderer/pages/modules/songsArea/composables/songListLoadGeneration'

import ascendingOrderAsset from '@renderer/assets/ascending-order.svg?asset'
import descendingOrderAsset from '@renderer/assets/descending-order.svg?asset'

import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

// 类型定义，便于正确引用 OverlayScrollbarsComponent 实例
type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null
const ascendingOrder = ascendingOrderAsset
const descendingOrder = descendingOrderAsset

const props = withDefaults(
  defineProps<{
    pane: SongsAreaPaneKey
    enablePreviewPlayer?: boolean
  }>(),
  {
    enablePreviewPlayer: false
  }
)

const runtime = useRuntimeStore()
const songsAreaState = runtime.songsAreaPanels.panes[props.pane]
const isPaneActive = computed(() =>
  runtime.songsAreaPanels.splitEnabled ? runtime.songsAreaPanels.activePane === props.pane : true
)
const shouldPersistColumnsToLocalStorage = () => props.pane === 'single' || isPaneActive.value
const activatePaneIfNeeded = () => {
  if (runtime.songsAreaPanels.splitEnabled && runtime.songsAreaPanels.activePane !== props.pane) {
    activateSongsAreaPane(runtime, props.pane)
  }
}
const normalizeLibraryPath = (value: string) => (value || '').replace(/\\/g, '/')
const resolveCoreLibraryNameBySongListUUID = (uuid: string) => {
  const dirPath = normalizeLibraryPath(libraryUtils.findDirPathByUuid(uuid))
  if (dirPath === 'library/FilterLibrary' || dirPath.startsWith('library/FilterLibrary/')) {
    return 'FilterLibrary'
  }
  if (dirPath === 'library/CuratedLibrary' || dirPath.startsWith('library/CuratedLibrary/')) {
    return 'CuratedLibrary'
  }
  if (dirPath === 'library/SetLibrary' || dirPath.startsWith('library/SetLibrary/')) {
    return 'SetLibrary'
  }
  if (dirPath === 'library/MixtapeLibrary' || dirPath.startsWith('library/MixtapeLibrary/')) {
    return 'MixtapeLibrary'
  }
  return ''
}
const currentSongListSourceLibraryName = computed(
  () =>
    resolveCoreLibraryNameBySongListUUID(songsAreaState.songListUUID) || runtime.libraryAreaSelected
)
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')
const handleOverlayClick = (e: MouseEvent) => {
  if (e.button === 0) {
    runtime.focusArea = 'songsArea'
    songsAreaState.selectedSongFilePath.length = 0
    // 清空歌单列表选中状态
    runtime.selectedPlaylistIds = []
  }
}
const handleEmptyOverlayClick = () => {
  if (
    songsAreaState.songListUUID === RECYCLE_BIN_UUID ||
    songsAreaState.songListUUID === RECORDING_LIBRARY_UUID
  ) {
    return
  }
  void requestUserGuideStep('songsSource')
}
const isMixtapeListView = computed(
  () => libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type === 'mixtapeList'
)
const isSetListView = computed(
  () => libraryUtils.getLibraryTreeByUUID(songsAreaState.songListUUID)?.type === 'setList'
)
const getRowKey = (song: ISongInfo) =>
  isMixtapeListView.value && song.mixtapeItemId
    ? song.mixtapeItemId
    : isSetListView.value && song.setItemId
      ? song.setItemId
      : song.filePath
const resolveSelectedFilePaths = (keys?: string[]) => {
  const selectedKeys = keys ?? songsAreaState.selectedSongFilePath
  if (!isMixtapeListView.value && !isSetListView.value) return selectedKeys
  const map = new Map<string, string>()
  for (const item of songsAreaState.songInfoArr) {
    if (item.mixtapeItemId) {
      map.set(item.mixtapeItemId, item.filePath)
    }
    if (item.setItemId) {
      map.set(item.setItemId, item.filePath)
    }
  }
  return selectedKeys
    .map((key) => map.get(key) || key)
    .filter((p) => typeof p === 'string' && p.length > 0)
}
const songListRootDir = computed(() =>
  songsAreaState.songListUUID === RECORDING_LIBRARY_UUID
    ? 'library/RecordingLibrary'
    : isMixtapeListView.value
      ? ''
      : libraryUtils.findDirPathByUuid(songsAreaState.songListUUID) || ''
)
// 使用 shallowRef 承载原始列表，避免不必要的深层响应式开销
const originalSongInfoArr = shallowRef<ISongInfo[]>([])

// 切换歌单离开动画期间保留旧数据，避免动画播放空内容
const leaveData = shallowRef<ISongInfo[] | null>(null)
const clearLeaveData = () => {
  leaveData.value = null
}
const handleListLeave = (el: Element, done: () => void) => {
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    clearLeaveData()
    done()
  }
  el.addEventListener(
    'transitionend',
    (e) => {
      if (e.target === el) finish()
    },
    { once: true }
  )
  setTimeout(finish, 200)
}

// 父级滚动采样
const {
  externalScrollTop,
  externalViewportHeight,
  syncMetrics: syncParentScrollMetrics
} = useParentRafSampler({ songsAreaRef })

let detachPaneScrollListener: (() => void) | null = null
const resolvePaneScrollCarrier = () => {
  const scrollElements = songsAreaRef.value?.osInstance()?.elements()
  const explicitViewport = scrollElements?.viewport as HTMLElement | undefined
  const explicitHost = scrollElements?.host as HTMLElement | undefined
  return detectSongsAreaScrollCarrier(
    explicitViewport || explicitHost || null,
    explicitHost || null
  ).carrier
}
const persistPaneScrollPosition = () => {
  const carrier = resolvePaneScrollCarrier()
  if (!carrier) return
  songsAreaState.scrollTop = Math.max(0, Number(carrier.scrollTop || 0))
  songsAreaState.scrollLeft = Math.max(0, Number(carrier.scrollLeft || 0))
}
const restorePaneScrollPosition = () => {
  const carrier = resolvePaneScrollCarrier()
  if (!carrier) return
  const nextTop = Math.max(0, Number(songsAreaState.scrollTop || 0))
  const nextLeft = Math.max(0, Number(songsAreaState.scrollLeft || 0))
  if (Math.abs(carrier.scrollTop - nextTop) > 1) {
    carrier.scrollTop = nextTop
  }
  if (Math.abs(carrier.scrollLeft - nextLeft) > 1) {
    carrier.scrollLeft = nextLeft
  }
}
const bindPaneScrollListener = () => {
  const carrier = resolvePaneScrollCarrier()
  if (!carrier) return
  detachPaneScrollListener?.()
  const handleScroll = () => {
    songsAreaState.scrollTop = Math.max(0, Number(carrier.scrollTop || 0))
    songsAreaState.scrollLeft = Math.max(0, Number(carrier.scrollLeft || 0))
  }
  carrier.addEventListener('scroll', handleScroll, { passive: true })
  detachPaneScrollListener = () => carrier.removeEventListener('scroll', handleScroll)
  handleScroll()
}
const scrollCurrentListToTop = () => {
  songsAreaState.scrollTop = 0
  const apply = () => {
    const carrier = resolvePaneScrollCarrier()
    if (carrier && carrier.scrollTop !== 0) {
      carrier.scrollTop = 0
    }
    songsAreaState.scrollTop = 0
  }
  apply()
  void nextTick().then(() => {
    requestAnimationFrame(apply)
  })
}
const handleSongsAreaScrollToTop = (payload?: { listUUID?: string }) => {
  const listUUID = String(payload?.listUUID || '')
  if (!listUUID || listUUID !== songsAreaState.songListUUID) return
  scrollCurrentListToTop()
}
const schedulePaneScrollRestore = () => {
  void nextTick().then(() => {
    requestAnimationFrame(() => {
      if (viewState.value !== 'list') return
      bindPaneScrollListener()
      restorePaneScrollPosition()
    })
  })
}

// Initialize composables
const { showAndHandleSongContextMenu } = useSongItemContextMenu(
  songsAreaRef,
  songsAreaState,
  syncParentScrollMetrics
)
const {
  isDialogVisible: isSelectSongListDialogVisible,
  targetLibraryName: selectSongListDialogTargetLibraryName,
  dialogActionMode: selectSongListDialogActionMode,
  initiateMoveSongs,
  handleMoveSongsConfirm,
  handleDialogCancel
} = useSelectAndMoveSongs({ songsAreaState })
const { startDragSongs, scheduleDragCleanup, handleDropToSongList } = useDragSongs({
  songsAreaState
})
type PreviewMoveRequestPayload = {
  song?: ISongInfo | null
  sourceLibraryName?: string
  sourceSongListUUID?: string
  sourcePane?: SongsAreaPaneKey
  targetLibraryName?: MoveSongsLibraryName
}
type WaveformPreviewStatePayload = {
  filePath?: string
  active?: boolean
  sourceLibraryName?: string
  sourceSongListUUID?: string
  sourcePane?: SongsAreaPaneKey | ''
}

// 列、筛选、排序与表头交互
const {
  columnData,
  columnDataArr,
  totalColumnsWidth,
  colRightClickMenuShow,
  triggeringColContextEvent,
  contextmenuEvent,
  handleToggleColumnVisibility,
  handleColumnsUpdate,
  colMenuClick,
  applyFiltersAndSorting,
  shouldApplyFiltersAndSortingForSongChange,
  persistColumnData
} = useSongsAreaColumns({
  runtime,
  songsAreaState,
  originalSongInfoArr,
  shouldPersistToLocalStorage: shouldPersistColumnsToLocalStorage
})
const { rowsVisibleColumns, handleColumnDragPreview } = useColumnDragPreview(columnDataArr)

// 封面清理
const { scheduleSweepCovers } = useSweepCovers({ runtime, songsAreaState })

// 歌单加载
const {
  loadingShow,
  lastAppliedSongListUUID,
  isRequesting,
  openSongList,
  invalidatePendingSongListLoads
} = useSongsLoader({
  runtime,
  songsAreaState,
  originalSongInfoArr,
  applyFiltersAndSorting
})

const displaySongs = computed(() =>
  resolveDisplayedSongList(
    leaveData.value,
    songsAreaState.songInfoArr,
    songsAreaState.songListUUID,
    lastAppliedSongListUUID.value
  )
)

const {
  playlistAnalysisActionVisible,
  playlistAnalysisActionPending,
  analysisPromptPending,
  handleUserOpenedSongList,
  analyzeDismissedPlaylist
} = usePlaylistAnalysisPrompt({
  runtime,
  songsAreaState,
  isMixtapeListView
})
let songsListGuideWaitToken = 0
const {
  trackNumberMutationPending,
  canReorderPlaylistTracks,
  canRenumberPlaylistTracks,
  handlePlaylistReorder,
  handleRenumberTracksByVisibleOrder
} = usePlaylistTrackNumbers({
  runtime,
  songsAreaState,
  originalSongInfoArr,
  columnData,
  isRequesting,
  applyFiltersAndSorting,
  resolveCoreLibraryNameBySongListUUID
})

const handleMetadataBatchUpdatedFromEvent = async (payload: {
  updates?: Array<{ song: ISongInfo; oldFilePath?: string }>
}) => {
  const updates = Array.isArray(payload?.updates) ? payload.updates : []
  if (!updates.length) return
  const renameMap = new Map<string, string>()
  let touchedCurrentList = false
  for (const update of updates) {
    if (!update?.song) continue
    const oldPath = update.oldFilePath ?? update.song.filePath
    renameMap.set(oldPath, update.song.filePath)
    const didTouch = await applyMetadataUpdate(update.song, update.oldFilePath, {
      rescan: false
    })
    if (didTouch) touchedCurrentList = true
  }
  if (!touchedCurrentList) return
  const selectionBeforeReload = [...songsAreaState.selectedSongFilePath]
  await openSongList()
  songsAreaState.selectedSongFilePath = selectionBeforeReload.map(
    (path) => renameMap.get(path) || path
  )
}
emitter.on('metadataBatchUpdated', handleMetadataBatchUpdatedFromEvent)

// 键盘与鼠标选择
const { songClick, cancelPendingRepeatSingleClickDeselect, cancelPendingShiftSelect } =
  useKeyboardSelection({
    runtime,
    songsAreaState,
    externalViewportHeight,
    scheduleSweepCovers
  })

// 自动滚动到当前播放项
const { scrollToIndex, scrollToIndexIfNeeded } = useAutoScrollToCurrent({
  runtime,
  songsAreaState,
  songsAreaRef
})

const {
  dragHintVisible,
  dragHintMode,
  dragHintTitle,
  dragHintDesc,
  paneDropHover,
  paneDropHoverMode,
  clipboardHintVisible,
  clipboardHintText,
  handleClipboardHint,
  handlePaneDragEnter,
  handlePaneDragOver,
  handlePaneDragLeave,
  handlePaneDrop,
  handleSongDragStart,
  handleSongDragEnd,
  handleMixtapeReorder
} = useSongsAreaDragAndDrop({
  songsAreaState,
  originalSongInfoArr,
  isMixtapeListView,
  getRowKey,
  resolveSelectedFilePaths,
  activatePaneIfNeeded,
  resolveCoreLibraryNameBySongListUUID,
  startDragSongs,
  scheduleDragCleanup,
  handleDropToSongList,
  openSongList,
  applyFiltersAndSorting
})

onMounted(() => {
  schedulePaneScrollRestore()
})

// 切换歌单时快照旧数据，用于离开动画期间保持渲染；同时重置滚动位置
watch(
  () => songsAreaState.songListUUID,
  (_newUUID, _oldUUID) => {
    if (_oldUUID && songsAreaState.songInfoArr.length > 0) {
      leaveData.value = [...songsAreaState.songInfoArr]
    }
    songsAreaState.scrollTop = 0
    songsAreaState.scrollLeft = 0
  }
)

const activePreviewFilePath = ref('')

// songsArea 相关事件
useSongsAreaEvents({
  runtime,
  songsAreaState,
  originalSongInfoArr,
  applyFiltersAndSorting,
  shouldApplyFiltersAndSortingForSongChange,
  openSongList,
  invalidatePendingSongListLoads,
  scheduleSweepCovers,
  activeWaveformPreviewFilePath: activePreviewFilePath,
  onUserOpenedSongList: handleUserOpenedSongList
})
if (props.enablePreviewPlayer) {
  useWaveformPreviewPlayer()
}
emitter.on('songsArea/clipboardHint', handleClipboardHint)
const handleWaveformPreviewState = (payload?: WaveformPreviewStatePayload) => {
  if (
    payload?.active &&
    payload?.sourcePane === props.pane &&
    String(payload?.sourceSongListUUID || '').trim() === songsAreaState.songListUUID &&
    String(payload?.sourceLibraryName || '').trim() === currentSongListSourceLibraryName.value
  ) {
    activePreviewFilePath.value = String(payload?.filePath || '').trim()
    return
  }
  if (payload?.active) {
    activePreviewFilePath.value = ''
    return
  }
  const payloadFilePath = String(payload?.filePath || '').trim()
  if (!payload?.active && (!payloadFilePath || activePreviewFilePath.value === payloadFilePath)) {
    activePreviewFilePath.value = ''
  }
}
emitter.on('waveform-preview:state', handleWaveformPreviewState)
const handlePreviewMoveRequest = (payload?: PreviewMoveRequestPayload) => {
  const song = payload?.song
  const sourceLibraryName = String(payload?.sourceLibraryName || '').trim()
  const sourceSongListUUID = String(payload?.sourceSongListUUID || '').trim()
  const targetLibraryName = payload?.targetLibraryName
  if (!song?.filePath || !sourceSongListUUID || payload?.sourcePane !== props.pane) return
  if (sourceLibraryName && sourceLibraryName !== currentSongListSourceLibraryName.value) return
  if (sourceSongListUUID !== songsAreaState.songListUUID) return
  if (
    targetLibraryName !== 'FilterLibrary' &&
    targetLibraryName !== 'CuratedLibrary' &&
    targetLibraryName !== 'MixtapeLibrary'
  ) {
    return
  }
  const rowKey = getRowKey(song)
  const exists = songsAreaState.songInfoArr.some((item) => getRowKey(item) === rowKey)
  if (!exists) return
  activatePaneIfNeeded()
  runtime.activeMenuUUID = ''
  songsAreaState.selectedSongFilePath = [rowKey]
  initiateMoveSongs(targetLibraryName)
}
emitter.on('preview-transfer:open-dialog', handlePreviewMoveRequest)
emitter.on('songsArea/scrollToTop', handleSongsAreaScrollToTop)

watch(
  () => isPaneActive.value,
  (active) => {
    if (active && runtime.songsAreaPanels.splitEnabled) {
      persistColumnData()
    }
  },
  { immediate: true }
)

onUnmounted(() => {
  songsListGuideWaitToken += 1
  persistPaneScrollPosition()
  detachPaneScrollListener?.()
  detachPaneScrollListener = null
  emitter.off('metadataBatchUpdated', handleMetadataBatchUpdatedFromEvent)
  emitter.off('songsArea/clipboardHint', handleClipboardHint)
  emitter.off('waveform-preview:state', handleWaveformPreviewState)
  emitter.off('preview-transfer:open-dialog', handlePreviewMoveRequest)
  emitter.off('songsArea/scrollToTop', handleSongsAreaScrollToTop)
})
const applyMetadataUpdate = async (
  updatedSong: ISongInfo | undefined,
  incomingOldFilePath?: string,
  options?: { rescan?: boolean }
) => {
  if (!updatedSong) return false
  const oldFilePath = incomingOldFilePath ?? updatedSong.filePath
  let touchedCurrentList = false
  const arr = [...originalSongInfoArr.value]
  let idx = arr.findIndex((item) => item.filePath === oldFilePath)
  if (idx === -1) idx = arr.findIndex((item) => item.filePath === updatedSong.filePath)
  if (idx !== -1) {
    arr.splice(idx, 1, { ...arr[idx], ...updatedSong })
    originalSongInfoArr.value = arr
    applyFiltersAndSorting()
    touchedCurrentList = true
  }

  let runtimeListTouched = false
  songsAreaState.songInfoArr = songsAreaState.songInfoArr.map((item) => {
    if (item.filePath === oldFilePath) {
      runtimeListTouched = true
      return { ...item, ...updatedSong }
    }
    if (item.filePath === updatedSong.filePath) {
      runtimeListTouched = true
      return { ...item, ...updatedSong }
    }
    return item
  })
  if (runtimeListTouched) touchedCurrentList = true

  let selectionTouched = false
  songsAreaState.selectedSongFilePath = songsAreaState.selectedSongFilePath.map((path) => {
    if (path === oldFilePath) {
      selectionTouched = true
      return updatedSong.filePath
    }
    return path
  })
  if (selectionTouched) touchedCurrentList = true

  if (
    runtime.playingData.playingSong &&
    (runtime.playingData.playingSong.filePath === updatedSong.filePath ||
      runtime.playingData.playingSong.filePath === oldFilePath)
  ) {
    runtime.playingData.playingSong = {
      ...runtime.playingData.playingSong,
      ...updatedSong
    }
    runtime.playingData.playingSong.filePath = updatedSong.filePath
  }

  if (runtime.playingData.playingSongListUUID === songsAreaState.songListUUID) {
    runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.map((item) =>
      item.filePath === oldFilePath || item.filePath === updatedSong.filePath
        ? { ...item, ...updatedSong }
        : item
    )
  }

  if (touchedCurrentList && songsAreaState.songListUUID) {
    try {
      emitter.emit('playlistContentChanged', { uuids: [songsAreaState.songListUUID] })
    } catch {}
  }
  try {
    emitter.emit('songMetadataUpdated', {
      filePath: updatedSong.filePath,
      oldFilePath
    })
  } catch {}

  if (touchedCurrentList) {
    scheduleSweepCovers()
  }

  if (options?.rescan === false || !touchedCurrentList) return touchedCurrentList

  const selectionBeforeReload = [...songsAreaState.selectedSongFilePath]
  await openSongList()
  songsAreaState.selectedSongFilePath = selectionBeforeReload.map((path) =>
    path === oldFilePath ? updatedSong.filePath : path
  )
  return touchedCurrentList
}

const handleSongContextMenuEvent = async (event: MouseEvent, song: ISongInfo) => {
  cancelPendingRepeatSingleClickDeselect()
  const result = await showAndHandleSongContextMenu(event, song)
  if (!result) return

  if (result.action === 'openSelectSongListDialog') {
    initiateMoveSongs(result.libraryName, result.actionMode)
    return
  }

  if (result.action === 'songsRemoved') {
    // songsRemoved 已由 useSongItemContextMenu 内部通过 emitter 统一处理，避免这里再次删一遍
    return
  }

  if (result.action === 'metadataUpdated') {
    await applyMetadataUpdate(result.song, result.oldFilePath)
    return
  }

  if (result.action === 'metadataBatchUpdated') {
    const updates = Array.isArray(result.updates) ? result.updates : []
    if (!updates.length) return
    const renameMap = new Map<string, string>()
    let touchedCurrentList = false
    for (const update of updates) {
      if (!update?.song) continue
      const oldPath = update.oldFilePath ?? update.song.filePath
      renameMap.set(oldPath, update.song.filePath)
      const didTouch = await applyMetadataUpdate(update.song, update.oldFilePath, {
        rescan: false
      })
      if (didTouch) touchedCurrentList = true
    }
    if (!touchedCurrentList) return
    const selectionBeforeReload = [...songsAreaState.selectedSongFilePath]
    await openSongList()
    songsAreaState.selectedSongFilePath = selectionBeforeReload.map(
      (path) => renameMap.get(path) || path
    )
    return
  }
}

const requestImmediateAnalysis = (song: ISongInfo) => {
  const filePath = song?.filePath
  if (!filePath) return
  if (runtime.mainWindowBrowseMode !== 'browser') return
  queueMainPlayerPlayingAnalysis(runtime, filePath)
}

const songDblClick = async (song: ISongInfo, event?: MouseEvent) => {
  cancelPendingRepeatSingleClickDeselect()
  cancelPendingShiftSelect()
  if (runtime.songDragSuppressClickUntilMs > Date.now()) return
  try {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  } catch {}
  runtime.activeMenuUUID = ''
  songsAreaState.selectedSongFilePath = []

  const normalizedSong = { ...song }
  requestImmediateAnalysis(normalizedSong)
  if (runtime.mainWindowBrowseMode !== 'browser') {
    const deck =
      runtime.mainWindowBrowseMode === 'edit' ? 'top' : event?.shiftKey ? 'bottom' : 'top'
    const sourceSongListData = songsAreaState.songInfoArr.map((item) => ({ ...item }))
    runtime.playingData.playingSongListUUID = songsAreaState.songListUUID
    runtime.playingData.playingSongListData = sourceSongListData
    beginHorizontalBrowseDeckInteraction(deck, String(normalizedSong.filePath || '').trim())
    sendHorizontalBrowseInteractionTrace('song-dblclick', {
      source: 'songsArea',
      deck,
      filePath: String(normalizedSong.filePath || '').trim()
    })
    emitter.emit('horizontalBrowse/load-song', {
      deck,
      song: normalizedSong,
      sourceSongListUUID: songsAreaState.songListUUID,
      sourceSongListData
    })
    return
  }
  const isSameList = runtime.playingData.playingSongListUUID === songsAreaState.songListUUID
  const isSameSong =
    isSameList && runtime.playingData.playingSong?.filePath === normalizedSong.filePath

  runtime.playingData.playingSongListUUID = songsAreaState.songListUUID
  runtime.playingData.playingSongListData = songsAreaState.songInfoArr

  if (isSameSong && runtime.playingData.playingSong) {
    runtime.playingData.playingSong = normalizedSong
    emitter.emit('player/replay-current-song')
    return
  }

  runtime.playingData.playingSong = normalizedSong
}

const {
  flashRowKey: globalSearchFlashRowKey,
  flashRowToken: globalSearchFlashToken,
  triggerFlash: triggerGlobalSearchFlash
} = useSongLocateFlash()

useGlobalSearchFocus({
  runtime,
  pane: props.pane,
  songsAreaState,
  originalSongInfoArr,
  columnData,
  applyFiltersAndSorting,
  getRowKey,
  scrollToIndex,
  songDblClick,
  onFocusHit: triggerGlobalSearchFlash
})

const viewState = computed<'welcome' | 'blank' | 'loading' | 'list'>(() => {
  if (!songsAreaState.songListUUID) {
    return runtime.songsAreaPanels.splitEnabled && props.pane !== 'single' ? 'blank' : 'welcome'
  }
  if (
    shouldHoldSongListLoading({
      songListUUID: songsAreaState.songListUUID,
      appliedSongListUUID: lastAppliedSongListUUID.value,
      visibleCount: songsAreaState.songInfoArr.length,
      isRequesting: isRequesting.value,
      loadingShow: loadingShow.value
    })
  ) {
    return 'loading'
  }
  return 'list'
})

watch(
  () => lastAppliedSongListUUID.value,
  (appliedUUID) => {
    if (appliedUUID && appliedUUID === songsAreaState.songListUUID) {
      clearLeaveData()
    }
  }
)

watch(
  () => ({
    mode: runtime.mainWindowBrowseMode,
    audience: runtime.setting.userGuideAudience,
    view: viewState.value,
    uuid: songsAreaState.songListUUID,
    trackCount: songsAreaState.songInfoArr.length,
    requesting: isRequesting.value,
    confirmShow: runtime.confirmShow,
    analysisPromptPending: analysisPromptPending.value
  }),
  ({
    mode,
    audience,
    view,
    uuid,
    trackCount,
    requesting,
    confirmShow,
    analysisPromptPending: promptPending
  }) => {
    if (mode !== 'browser') return
    if (!audience || audience === 'veteran') return
    if (requesting || view !== 'list' || !uuid || trackCount <= 0) return
    if (confirmShow || promptPending) return
    const token = ++songsListGuideWaitToken
    const isRekordbox = audience === 'rekordbox'
    void waitForUserGuideHole('songsList', 'songsListBody', isRekordbox, {
      shouldContinue: () =>
        token === songsListGuideWaitToken &&
        runtime.mainWindowBrowseMode === 'browser' &&
        viewState.value === 'list' &&
        songsAreaState.songListUUID === uuid &&
        songsAreaState.songInfoArr.length > 0 &&
        !isRequesting.value &&
        !runtime.confirmShow &&
        !analysisPromptPending.value
    }).then((hole) => {
      if (!hole || token !== songsListGuideWaitToken) return
      if (runtime.confirmShow || analysisPromptPending.value) return
      void requestUserGuideStep('songsList')
    })
  },
  { flush: 'post' }
)

watch(
  () => [viewState.value, songsAreaState.songListUUID] as const,
  ([state]) => {
    if (state !== 'list') {
      persistPaneScrollPosition()
      detachPaneScrollListener?.()
      detachPaneScrollListener = null
      return
    }
    schedulePaneScrollRestore()
  },
  { flush: 'post' }
)

const {
  playingSongFilePathForRows,
  playingSongFilePathsForRows,
  harmonicReferenceKeyForRows,
  showScrollToPlaying,
  handleScrollToPlaying
} = useSongsAreaPlayingFollow({
  runtime,
  songsAreaState,
  viewState,
  getRowKey,
  scrollToIndex,
  scrollToIndexIfNeeded
})

async function onMoveSongsDialogConfirmed(targetSongListUuid: string) {
  await handleMoveSongsConfirm(targetSongListUuid)
}

const { shouldShowEmptyState, emptyTitleText, emptyHintText } = useSongsAreaEmptyState({
  isRequesting,
  songsAreaState,
  columnData
})

// 播放列表同步由 useSongsAreaEvents 管理
</script>
<template>
  <div
    class="songs-area-root"
    data-user-guide-target="songs-list"
    :class="{
      'is-drop-target': paneDropHover,
      'is-drop-target-external': paneDropHoverMode === 'external'
    }"
    @mousedown.capture="activatePaneIfNeeded"
    @dragenter="handlePaneDragEnter"
    @dragover="handlePaneDragOver"
    @dragleave="handlePaneDragLeave"
    @drop="handlePaneDrop"
  >
    <Transition name="songs-area-switch" mode="out-in">
      <div v-if="viewState === 'welcome'" key="welcome" class="unselectable welcomeContainer">
        <welcomePage />
      </div>

      <div v-else-if="viewState === 'blank'" key="blank" class="songs-area-blank"></div>

      <div v-else-if="viewState === 'loading'" key="loading" class="loading-wrapper">
        <div class="loading"></div>
      </div>

      <div v-else key="list" class="songs-area-shell" data-user-guide-target="songs-list-body">
        <OverlayScrollbarsComponent
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
            :total-width="totalColumnsWidth"
            :show-index-action="canRenumberPlaylistTracks"
            :index-action-title="t('tracks.renumberPlaylistTrackNumbersAction')"
            :index-action-disabled="trackNumberMutationPending || isRequesting"
            @update:columns="handleColumnsUpdate"
            @column-click="colMenuClick"
            @header-contextmenu="contextmenuEvent"
            @drag-start="runtime.dragTableHeader = true"
            @drag-end="runtime.dragTableHeader = false"
            @columns-preview="handleColumnDragPreview"
            @index-action-click="handleRenumberTracksByVisibleOrder"
          />

          <!-- 使用 SongListRows 组件渲染歌曲列表 -->
          <Transition name="songs-area-list-switch" mode="out-in" @leave="handleListLeave">
            <div :key="songsAreaState.songListUUID" class="songs-area-list-viewport">
              <Transition name="songs-area-list-switch">
                <SongListRows
                  v-if="displaySongs.length > 0"
                  :songs="displaySongs"
                  :visible-columns="rowsVisibleColumns"
                  :selected-song-file-paths="songsAreaState.selectedSongFilePath"
                  :playing-song-file-path="playingSongFilePathForRows"
                  :playing-song-file-paths="playingSongFilePathsForRows"
                  :flash-row-key="globalSearchFlashRowKey"
                  :flash-row-token="globalSearchFlashToken"
                  :harmonic-reference-key="harmonicReferenceKeyForRows"
                  :total-width="totalColumnsWidth"
                  :source-library-name="currentSongListSourceLibraryName"
                  :source-song-list-u-u-i-d="songsAreaState.songListUUID"
                  :source-pane-key="props.pane"
                  :scroll-host-element="songsAreaRef?.osInstance()?.elements().viewport"
                  :external-scroll-top="externalScrollTop"
                  :external-viewport-height="externalViewportHeight"
                  :song-list-root-dir="songListRootDir"
                  :reorder-mode="
                    isMixtapeListView ? 'mixtape' : canReorderPlaylistTracks ? 'playlist' : 'none'
                  "
                  @song-click="songClick"
                  @song-contextmenu="handleSongContextMenuEvent"
                  @song-dblclick="songDblClick"
                  @song-dragstart="handleSongDragStart"
                  @song-dragend="handleSongDragEnd"
                  @mixtape-reorder="handleMixtapeReorder"
                  @playlist-reorder="handlePlaylistReorder"
                />
              </Transition>
            </div>
          </Transition>
        </OverlayScrollbarsComponent>

        <PlaylistAnalysisFloatingButton
          v-if="playlistAnalysisActionVisible"
          :pending="playlistAnalysisActionPending"
          :with-jump="showScrollToPlaying"
          @analyze="analyzeDismissedPlaylist"
        />

        <bubbleBoxTrigger
          v-if="showScrollToPlaying"
          tag="button"
          class="songs-area-float-jump"
          type="button"
          title="Scroll to playing"
          @click.stop="handleScrollToPlaying"
        >
          <span class="songs-area-float-jump__icon" aria-hidden="true"></span>
        </bubbleBoxTrigger>

        <Transition name="songs-area-drag-hint">
          <div
            v-if="dragHintVisible"
            class="songs-area-drag-hint"
            :class="{ 'is-external': dragHintMode === 'external' }"
          >
            <div class="title">{{ dragHintTitle }}</div>
            <div class="desc">{{ dragHintDesc }}</div>
          </div>
        </Transition>
        <Transition name="songs-area-drag-hint">
          <div v-if="clipboardHintVisible" class="songs-area-drag-hint songs-area-clipboard-hint">
            <div class="title">{{ clipboardHintText }}</div>
          </div>
        </Transition>

        <!-- Empty State Overlay: 鐙珛浜庢粴鍔ㄥ唴瀹癸紝濮嬬粓灞呬腑鍦ㄥ彲瑙嗗尯鍩?-->
        <div
          v-if="shouldShowEmptyState"
          class="songs-area-empty-overlay unselectable"
          data-user-guide-target="songs-source"
          @click.stop="handleEmptyOverlayClick"
        >
          <div class="empty-box">
            <div class="title">
              {{ emptyTitleText }}
            </div>
            <div class="hint">
              {{ emptyHintText }}
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <ColumnHeaderContextMenu
      v-model="colRightClickMenuShow"
      :target-event="triggeringColContextEvent"
      :columns="columnData"
      @toggle-column-visibility="handleToggleColumnVisibility"
    />
    <Teleport to="body">
      <selectSongListDialog
        v-if="isSelectSongListDialogVisible"
        :library-name="selectSongListDialogTargetLibraryName"
        :action-mode="selectSongListDialogActionMode"
        @confirm="onMoveSongsDialogConfirmed"
        @cancel="handleDialogCancel"
      />
    </Teleport>
  </div>
</template>
<style lang="scss" scoped src="./songsArea.scss"></style>
