<script setup lang="ts">
import { PropType, computed, onUnmounted, ref as vRef, toRef } from 'vue'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../types/globals'
import type { SongsAreaPaneKey } from '@renderer/stores/runtime'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { useVirtualRows } from './SongListRows/useVirtualRows'
import { useSongRowEvents } from './SongListRows/useSongRowEvents'
import { useCoverThumbnails } from './SongListRows/useCoverThumbnails'
import { useRowAnalysisViewport } from './SongListRows/useRowAnalysisViewport'
import { useSongColumnReorderAnimation } from './SongListRows/useSongColumnReorderAnimation'
import { useKeyAnalysisProgress } from './composables/useKeyAnalysisProgress'
import { useCoverPreview } from './SongListRows/useCoverPreview'
import { useSongRowHoverInteractions } from './SongListRows/useSongRowHoverInteractions'
import { useSongRowIdentity } from './SongListRows/useSongRowIdentity'
import { useSongRowDisplay } from './SongListRows/useSongRowDisplay'
import { useSongRowRefs } from './SongListRows/useSongRowRefs'
import { useWaveformPreview } from './SongListRows/useWaveformPreview'
import CoverPreviewOverlay from './SongListRows/CoverPreviewOverlay.vue'
import CoverThumbnailImage from './SongListRows/CoverThumbnailImage.vue'
import CuratedArtistCellContent from './SongListRows/CuratedArtistCellContent.vue'
import RowAnalysisBar from './SongListRows/RowAnalysisBar.vue'
import WaveformPreviewCell from './SongListRows/WaveformPreviewCell.vue'
import { createTouchLongPressDrag } from '@renderer/utils/touchLongPressDrag'
import { createInternalMouseDrag } from '@renderer/utils/internalMouseDrag'

const props = defineProps({
  songs: {
    type: Array as PropType<ISongInfo[]>,
    required: true
  },
  visibleColumns: {
    type: Array as PropType<ISongsAreaColumn[]>,
    required: true
  },
  selectedSongFilePaths: {
    type: Array as PropType<string[]>,
    required: true
  },
  playingSongFilePath: {
    type: String as PropType<string | undefined>,
    default: undefined
  },
  playingSongFilePaths: {
    type: Array as PropType<string[]>,
    default: () => []
  },
  flashRowKey: {
    type: String,
    default: ''
  },
  flashRowToken: {
    type: Number,
    default: 0
  },
  totalWidth: {
    type: Number,
    required: true
  },
  sourceLibraryName: {
    type: String,
    required: true
  },
  sourceSongListUUID: {
    type: String,
    required: true
  },
  sourcePaneKey: {
    type: String as PropType<SongsAreaPaneKey | ''>,
    default: ''
  },
  scrollHostElement: {
    type: Object as PropType<HTMLElement | null | undefined>,
    default: undefined
  },
  externalScrollTop: {
    type: Number as PropType<number | undefined>,
    default: undefined
  },
  externalViewportHeight: {
    type: Number as PropType<number | undefined>,
    default: undefined
  },
  songListRootDir: {
    type: String as PropType<string | undefined>,
    default: undefined
  },
  externalWaveformRootPath: {
    type: String as PropType<string | undefined>,
    default: undefined
  },
  readOnly: {
    type: Boolean,
    default: false
  },
  enableCoverThumbnails: {
    type: Boolean,
    default: true
  },
  analysisCompleteFilePaths: {
    type: Array as PropType<string[]>,
    default: () => []
  },
  allowSongDragWhenReadOnly: { type: Boolean, default: false },
  internalMouseDrag: { type: Boolean, default: false },
  allowContextMenuWhenReadOnly: { type: Boolean, default: false },
  allowDblclickWhenReadOnly: { type: Boolean, default: false },
  allowWaveformPreviewWhenReadOnly: { type: Boolean, default: false },
  reorderMode: {
    type: String as PropType<'none' | 'mixtape' | 'playlist'>,
    default: 'none'
  },
  harmonicReferenceKey: {
    type: String as PropType<string | undefined>,
    default: ''
  }
})

type MixtapeDragPayload = {
  sourceSongListUUID?: string
  itemIds?: string[]
}

const emit = defineEmits<{
  (e: 'song-click', event: MouseEvent, song: ISongInfo): void
  (e: 'song-contextmenu', event: MouseEvent, song: ISongInfo): void
  (e: 'song-dblclick', song: ISongInfo, event: MouseEvent): void
  (e: 'song-dragstart', event: DragEvent, song: ISongInfo): void
  (e: 'song-dragend', event: DragEvent): void
  (e: 'mixtape-reorder', payload: { sourceItemIds: string[]; targetIndex: number }): void
  (e: 'playlist-reorder', payload: { sourceItemIds: string[]; targetIndex: number }): void
  (e: 'rows-rendered', count: number): void
}>()

const songsRef = toRef(props, 'songs')
const scrollHostElementRef = toRef(props, 'scrollHostElement')
const externalScrollTopRef = toRef(props, 'externalScrollTop')
const externalViewportHeightRef = toRef(props, 'externalViewportHeight')
const songListRootDirRef = toRef(props, 'songListRootDir')
const externalWaveformRootPathRef = toRef(props, 'externalWaveformRootPath')
const reorderModeRef = toRef(props, 'reorderMode')
const sourceSongListUUIDRef = toRef(props, 'sourceSongListUUID')
const sourcePaneKeyRef = toRef(props, 'sourcePaneKey')
const sourceLibraryNameRef = toRef(props, 'sourceLibraryName')
const enableCoverThumbnailsRef = toRef(props, 'enableCoverThumbnails')
const visibleColumnsRef = toRef(props, 'visibleColumns')
const runtime = useRuntimeStore()
const requiresRuntimeAnalysis = computed(() => runtime.analysisRuntime.available === true)
const playingSongRowKeySet = computed(
  () =>
    new Set(
      [
        ...(Array.isArray(props.playingSongFilePaths) ? props.playingSongFilePaths : []),
        props.playingSongFilePath
      ]
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    )
)
const isMixtapeList = computed(() => props.reorderMode === 'mixtape')
const isInternalReorderEnabled = computed(
  () => props.reorderMode === 'mixtape' || props.reorderMode === 'playlist'
)
const canStartSongDrag = computed(
  () => !props.readOnly || isInternalReorderEnabled.value || props.allowSongDragWhenReadOnly
)
const canPreviewWaveform = computed(() => !props.readOnly || props.allowWaveformPreviewWhenReadOnly)
const { isPlaylistReorder, isPioneerLibraryContext, getRowKey, getCellKey, getIndexCellValue } =
  useSongRowIdentity({
    songListRootDir: songListRootDirRef,
    reorderMode: reorderModeRef
  })
const { cellRefMap, coverCellRefMap, setCellRef, setCoverCellRef } = useSongRowRefs()

const hoveredCellKey = vRef<string | null>(null)
const onlyWhenOverflowComputed = computed(() => true)
const DEFAULT_ROW_HEIGHT = 30
const dragHoverIndex = vRef<number | null>(null)
const dragHoverPosition = vRef<'before' | 'after' | null>(null)
const dragHoverEdge = vRef<'top' | 'bottom' | null>(null)
const clearDragHover = () => {
  dragHoverIndex.value = null
  dragHoverPosition.value = null
  dragHoverEdge.value = null
}
const draggingItemIds = vRef<string[]>([])
const draggingSourceListUUID = vRef('')
const lastAutoScrollAt = vRef(0)
const touchSongDrag = createTouchLongPressDrag()
const mouseSongDrag = createInternalMouseDrag()
const AUTO_SCROLL_EDGE_PX = 36
const AUTO_SCROLL_STEP_PX = 22
const AUTO_SCROLL_MIN_INTERVAL = 16
const topPadVisible = vRef(false)
const bottomPadVisible = vRef(false)
const topPadStyle = vRef<Record<string, string>>({})
const bottomPadStyle = vRef<Record<string, string>>({})
const updatePadStyle = (
  current: typeof topPadStyle,
  top: number,
  left: number,
  width: number,
  height: number
) => {
  const nextTop = `${top}px`
  const nextLeft = `${left}px`
  const nextWidth = `${width}px`
  const nextHeight = `${height}px`
  const previous = current.value
  if (
    previous.top === nextTop &&
    previous.left === nextLeft &&
    previous.width === nextWidth &&
    previous.height === nextHeight
  ) {
    return
  }
  current.value = {
    top: nextTop,
    left: nextLeft,
    width: nextWidth,
    height: nextHeight
  }
}
const resolveDragHost = () =>
  (viewportElement.value || scrollHostElementRef.value || rowsRoot.value) as HTMLElement | null
const resolveDropContainer = () => {
  const rows = rowsRoot.value
  if (!rows) return null
  const shell = rows.closest('.songs-area-shell') as HTMLElement | null
  return shell || rows
}

const updateDropPadRects = () => {
  const rows = rowsRoot.value
  const container = resolveDropContainer()
  if (!rows || !container) {
    topPadVisible.value = false
    bottomPadVisible.value = false
    return
  }
  const cRect = container.getBoundingClientRect()
  const rRect = rows.getBoundingClientRect()
  const topHeight = Math.max(0, Math.min(rRect.top, cRect.bottom) - cRect.top)
  if (topHeight > 0) {
    topPadVisible.value = true
    updatePadStyle(topPadStyle, cRect.top, cRect.left, cRect.width, topHeight)
  } else {
    topPadVisible.value = false
  }
  const listLen = totalHeight.value
  const safeScrollTop = Math.max(0, Math.min(effectiveScrollTop.value, listLen))
  const listEndY = rRect.top + (listLen - safeScrollTop)
  const bottomStart = Math.min(Math.max(listEndY, rRect.top), cRect.bottom)
  const bottomHeight = Math.max(0, cRect.bottom - bottomStart)
  if (bottomHeight > 0) {
    bottomPadVisible.value = true
    updatePadStyle(bottomPadStyle, bottomStart, cRect.left, cRect.width, bottomHeight)
  } else {
    bottomPadVisible.value = false
  }
}
const scheduleAutoScroll = (event: DragEvent) => {
  const host = resolveDragHost()
  if (!host) return
  const rect = host.getBoundingClientRect()
  const y = event.clientY
  const distanceTop = y - rect.top
  const distanceBottom = rect.bottom - y
  let delta = 0
  if (distanceTop < AUTO_SCROLL_EDGE_PX) {
    delta = -AUTO_SCROLL_STEP_PX
  } else if (distanceBottom < AUTO_SCROLL_EDGE_PX) {
    delta = AUTO_SCROLL_STEP_PX
  }
  if (!delta) return
  const now = performance.now()
  if (now - lastAutoScrollAt.value < AUTO_SCROLL_MIN_INTERVAL) return
  lastAutoScrollAt.value = now
  host.scrollTop += delta
}

const {
  getCellValue,
  getCellTitle,
  isCuratedArtistHit,
  getCuratedArtistBadgeText,
  getCuratedArtistBadgeTitle,
  isHarmonicKeyMatch
} = useSongRowDisplay({
  runtime,
  sourceLibraryName: () => props.sourceLibraryName,
  harmonicReferenceKey: () => props.harmonicReferenceKey || ''
})
const hasCuratedArtistBadge = (song: ISongInfo, colKey: string) =>
  colKey === 'artist' && getCuratedArtistBadgeText(song, colKey).length > 0

const {
  rowsRoot,
  hostElement,
  viewportElement,
  visibleSongsWithIndex,
  offsetTopPx,
  totalHeight,
  rowHeight,
  effectiveScrollTop,
  effectiveViewportHeight,
  startIndex,
  endIndex,
  actualStartIndex,
  actualEndIndex,
  visibleCount,
  scrollLeft
} = useVirtualRows({
  songs: songsRef,
  scrollHostElement: scrollHostElementRef,
  externalScrollTop: externalScrollTopRef,
  externalViewportHeight: externalViewportHeightRef
})

useSongColumnReorderAnimation(rowsRoot, toRef(props, 'visibleColumns'))

const headerHeight = computed(() => {
  const header = rowsRoot.value?.previousElementSibling as HTMLElement | null
  const measuredHeight = Number(header?.offsetHeight || 0)
  return measuredHeight > 0 ? measuredHeight : DEFAULT_ROW_HEIGHT
})

const availableRowsViewportHeight = computed(() => {
  const viewportHeight = Number(effectiveViewportHeight.value || 0)
  return Math.max(0, viewportHeight - headerHeight.value)
})

const contentHeight = computed(() => Math.max(totalHeight.value, availableRowsViewportHeight.value))

const shouldSuppressPointerAction = (event?: MouseEvent) => {
  if (runtime.songDragSuppressClickUntilMs <= Date.now()) return false
  event?.stopPropagation()
  event?.preventDefault()
  return true
}

const { onRowsClick, onRowsContextmenu, onRowsDblclick } = useSongRowEvents({
  songs: songsRef,
  emitSongClick: (e, song) => emit('song-click', e, song),
  emitSongContextmenu: (e, song) => emit('song-contextmenu', e, song),
  emitSongDblclick: (song, event) => emit('song-dblclick', song, event),
  shouldSuppressPointerAction
})

const { getCoverUrl, fetchCoverUrl, onImgError } = useCoverThumbnails({
  songs: songsRef,
  visibleSongsWithIndex,
  startIndex,
  endIndex,
  actualStartIndex,
  actualEndIndex,
  visibleCount,
  songListRootDir: songListRootDirRef,
  sessionIdentity: computed(() => `${props.sourcePaneKey}:${props.sourceSongListUUID}`),
  platform: computed(() => runtime.setting?.platform),
  enabled: enableCoverThumbnailsRef
})

const { listViewportWidth } = useRowAnalysisViewport({
  rowsRoot,
  viewportElement,
  scrollHostElement: scrollHostElementRef
})

const { getAnalysisProgress, isSongNeedsAnalysis, hasAnyAnalysisProgress } = useKeyAnalysisProgress(
  {
    visibleSongsWithIndex,
    requiresRuntimeAnalysis,
    isAnalysisCompleteOverride: (filePath) => {
      if (sourceLibraryNameRef.value === 'RecordingLibrary') return true
      const normalized = String(filePath || '')
        .replace(/\//g, '\\')
        .toLowerCase()
      return props.analysisCompleteFilePaths.some(
        (item) =>
          String(item || '')
            .replace(/\//g, '\\')
            .toLowerCase() === normalized
      )
    }
  }
)
const showAnalysisProgressBar = computed(
  () => sourceLibraryNameRef.value !== 'RecordingLibrary' && hasAnyAnalysisProgress.value
)

const {
  coverPreviewState,
  coverPreviewSize,
  previewedCoverUrl,
  onCoverMouseEnter,
  onCoverMouseLeave,
  handleCoverPreviewMouseMove,
  handleCoverPreviewWheel,
  closeCoverPreview
} = useCoverPreview({
  songs: songsRef,
  rowsRoot,
  hostElement,
  viewportElement,
  coverCellRefMap,
  rowHeight,
  defaultRowHeight: DEFAULT_ROW_HEIGHT,
  getCoverUrl,
  fetchCoverUrl,
  effectiveScrollTop,
  scrollLeft
})

const {
  setWaveformCanvasRef,
  getWaveformClickPercent,
  requestWaveformPreview,
  requestWaveformPreviewAtSeconds,
  stopWaveformPreview,
  isWaveformPreviewActive,
  getWaveformPreviewPlayheadStyle,
  getWaveformPlaceholderText,
  getWaveformPlaceholderTitle
} = useWaveformPreview({
  visibleSongsWithIndex,
  visibleColumns: visibleColumnsRef,
  sourceLibraryName: sourceLibraryNameRef,
  sourceSongListUUID: sourceSongListUUIDRef,
  sourcePaneKey: sourcePaneKeyRef,
  songListRootDir: songListRootDirRef,
  externalWaveformRootPath: externalWaveformRootPathRef,
  actualVisibleStartIndex: actualStartIndex,
  actualVisibleEndIndex: actualEndIndex,
  getAnalysisProgress,
  isSongNeedsAnalysis
})

const handleWaveformClick = async (song: ISongInfo, event: MouseEvent) => {
  if (shouldSuppressPointerAction(event)) return
  if (!canPreviewWaveform.value) return
  if (event.button !== 0) return
  const filePath = song?.filePath
  if (!filePath) return
  if (song.fileMissing) return
  if (isPioneerLibraryContext.value) {
    const exists = await window.electron.ipcRenderer.invoke('check-path-exists', filePath)
    if (!exists) {
      song.fileMissing = true
      return
    }
  }
  const percent = getWaveformClickPercent(filePath, event.clientX)
  requestWaveformPreview(song, percent)
}

const handleWaveformStopClick = (event: MouseEvent) => {
  if (shouldSuppressPointerAction(event)) return
  if (!canPreviewWaveform.value) return
  event.stopPropagation()
  event.preventDefault()
  stopWaveformPreview()
}

const handleWaveformHotCueClick = (song: ISongInfo, sec: number) => {
  if (!canPreviewWaveform.value) return
  requestWaveformPreviewAtSeconds(song, sec)
}

const isSelfExternalSongDrag = () =>
  runtime.songDragMode === 'external' &&
  runtime.songDragActive &&
  runtime.draggingSongFilePaths.length > 0

const resolveDragPayload = (event: DragEvent) => {
  if (
    draggingItemIds.value.length > 0 &&
    draggingSourceListUUID.value === props.sourceSongListUUID
  ) {
    return {
      sourceSongListUUID: draggingSourceListUUID.value,
      itemIds: [...draggingItemIds.value]
    }
  }
  const raw = event.dataTransfer?.getData('application/x-mixtape-reorder')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const resolveDragItemIds = (event: DragEvent): string[] => {
  const parsed = resolveDragPayload(event) as MixtapeDragPayload | null
  if (!parsed || parsed.sourceSongListUUID !== props.sourceSongListUUID) return []
  const sourceItemIds = Array.isArray(parsed?.itemIds)
    ? parsed.itemIds.map((id) => String(id)).filter(Boolean)
    : []
  return sourceItemIds
}

const emitInternalReorder = (payload: { sourceItemIds: string[]; targetIndex: number }) => {
  if (isMixtapeList.value) {
    emit('mixtape-reorder', payload)
    return
  }
  if (isPlaylistReorder.value) {
    emit('playlist-reorder', payload)
  }
}

const handleRowDragOver = (event: DragEvent, item: { song: ISongInfo; idx: number }) => {
  if (props.readOnly && !isInternalReorderEnabled.value) return
  if (isSelfExternalSongDrag()) {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'none'
    }
    clearDragHover()
    return
  }
  if (!isInternalReorderEnabled.value) return
  const sourceItemIds = resolveDragItemIds(event)
  if (!sourceItemIds.length) return
  updateDropPadRects()
  const targetId = getRowKey(item.song)
  if (targetId && sourceItemIds.includes(targetId)) {
    clearDragHover()
    return
  }
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  const row = event.currentTarget as HTMLElement | null
  if (!row) return
  const rect = row.getBoundingClientRect()
  const offsetY = event.clientY - rect.top
  dragHoverIndex.value = item.idx
  dragHoverPosition.value = offsetY < rect.height / 2 ? 'before' : 'after'
  dragHoverEdge.value = null
  scheduleAutoScroll(event)
}

const handleEdgeDragOver = (event: DragEvent, edge: 'top' | 'bottom') => {
  if (props.readOnly && !isInternalReorderEnabled.value) return
  if (!isInternalReorderEnabled.value) return
  const sourceItemIds = resolveDragItemIds(event)
  if (!sourceItemIds.length) return
  updateDropPadRects()
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  dragHoverEdge.value = edge
  dragHoverIndex.value = null
  dragHoverPosition.value = null
  scheduleAutoScroll(event)
}

const handleEdgeDrop = (event: DragEvent, edge: 'top' | 'bottom') => {
  if (props.readOnly && !isInternalReorderEnabled.value) return
  if (!isInternalReorderEnabled.value) return
  const sourceItemIds = resolveDragItemIds(event)
  if (!sourceItemIds.length) return
  const listLen = songsRef.value.length
  if (listLen === 0) {
    clearDragHover()
    return
  }
  const targetIndex = edge === 'top' ? 0 : listLen
  clearDragHover()
  emitInternalReorder({ sourceItemIds, targetIndex })
}

const handleTopPadDragOver = (event: DragEvent) => {
  handleEdgeDragOver(event, 'top')
}

const handleBottomPadDragOver = (event: DragEvent) => {
  handleEdgeDragOver(event, 'bottom')
}

const handleTopPadDrop = (event: DragEvent) => {
  updateDropPadRects()
  handleEdgeDrop(event, 'top')
}

const handleBottomPadDrop = (event: DragEvent) => {
  updateDropPadRects()
  handleEdgeDrop(event, 'bottom')
}

const handleRowDrop = (event: DragEvent, item: { song: ISongInfo; idx: number }) => {
  if (props.readOnly && !isInternalReorderEnabled.value) return
  if (isSelfExternalSongDrag()) {
    event.preventDefault()
    event.stopPropagation()
    clearDragHover()
    return
  }
  if (!isInternalReorderEnabled.value) return
  const sourceItemIds = resolveDragItemIds(event)
  if (!sourceItemIds.length) return
  event.preventDefault()
  event.stopPropagation()
  const targetId = getRowKey(item.song)
  if (targetId && sourceItemIds.includes(targetId)) {
    clearDragHover()
    return
  }
  const row = event.currentTarget as HTMLElement | null
  let position: 'before' | 'after' = 'before'
  if (row) {
    const rect = row.getBoundingClientRect()
    const offsetY = event.clientY - rect.top
    position = offsetY < rect.height / 2 ? 'before' : 'after'
  }
  clearDragHover()
  const targetIndex = item.idx + (position === 'after' ? 1 : 0)
  emitInternalReorder({ sourceItemIds, targetIndex })
}

const handleRowDragEnd = (event: DragEvent) => {
  if (!canStartSongDrag.value) return
  draggingItemIds.value = []
  draggingSourceListUUID.value = ''
  clearDragHover()
  topPadVisible.value = false
  bottomPadVisible.value = false
  emit('song-dragend', event)
}

const handleRowDragStart = (event: DragEvent, item: { song: ISongInfo }) => {
  if (props.internalMouseDrag && event.isTrusted) {
    event.preventDefault()
    return
  }
  if (!canStartSongDrag.value) return
  if (isInternalReorderEnabled.value) {
    const rowKey = getRowKey(item.song)
    const selectedKeys = (props.selectedSongFilePaths || []).filter(Boolean)
    const shouldUseSelection = rowKey.length > 0 && selectedKeys.includes(rowKey)
    const fallbackId = rowKey.length > 0 ? [rowKey] : []
    draggingItemIds.value = shouldUseSelection ? [...selectedKeys] : fallbackId
    draggingSourceListUUID.value = props.sourceSongListUUID
    if (event.dataTransfer && draggingItemIds.value.length > 0) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(
        'application/x-mixtape-reorder',
        JSON.stringify({
          sourceSongListUUID: props.sourceSongListUUID,
          itemIds: [...draggingItemIds.value]
        })
      )
    }
    updateDropPadRects()
  }
  emit('song-dragstart', event, item.song)
}

const handleRowTouchStart = (event: TouchEvent) => {
  if (!canStartSongDrag.value) return
  const sourceElement = event.currentTarget
  if (!(sourceElement instanceof HTMLElement)) return
  touchSongDrag.handleTouchStart(event, sourceElement)
}

const handleRowMouseDown = (event: MouseEvent) => {
  if (!props.internalMouseDrag || !canStartSongDrag.value) return
  if (event.currentTarget instanceof HTMLElement) mouseSongDrag.start(event, event.currentTarget)
}

const {
  onRowsMouseOver,
  onRowsMouseLeave,
  handleCoverDblclick,
  handleCoverPreviewDblclick,
  handleCoverPreviewContextmenu
} = useSongRowHoverInteractions({
  hoveredCellKey,
  songs: songsRef,
  coverPreviewState,
  closeCoverPreview,
  emitSongContextmenu: (event, song) => emit('song-contextmenu', event, song),
  emitSongDblclick: (song, event) => emit('song-dblclick', song, event),
  shouldSuppressPointerAction
})

onUnmounted(() => {
  mouseSongDrag.dispose()
  touchSongDrag.cancel()
  coverCellRefMap.clear()
})
</script>

<template>
  <div
    ref="rowsRoot"
    class="song-rows-root"
    @click="onRowsClick"
    @contextmenu.prevent="
      (!props.readOnly || props.allowContextMenuWhenReadOnly) && onRowsContextmenu($event)
    "
    @dblclick="(!props.readOnly || props.allowDblclickWhenReadOnly) && onRowsDblclick($event)"
    @mouseover="onRowsMouseOver"
    @mouseleave="onRowsMouseLeave"
  >
    <div :style="{ height: contentHeight + 'px', position: 'relative' }">
      <div :style="{ position: 'absolute', top: offsetTopPx + 'px', left: 0, right: 0 }">
        <div
          v-for="item in visibleSongsWithIndex"
          :key="getRowKey(item.song)"
          class="song-row-item unselectable"
          :class="{
            'drag-over-before':
              isInternalReorderEnabled &&
              dragHoverIndex === item.idx &&
              dragHoverPosition === 'before',
            'drag-over-after':
              isInternalReorderEnabled &&
              dragHoverIndex === item.idx &&
              dragHoverPosition === 'after'
          }"
          :data-filepath="item.song.filePath"
          :data-rowkey="getRowKey(item.song)"
          :draggable="canStartSongDrag && !internalMouseDrag"
          @mousedown="handleRowMouseDown"
          @touchstart="handleRowTouchStart"
          @dragstart.stop="canStartSongDrag && handleRowDragStart($event, item)"
          @dragend.stop="canStartSongDrag && handleRowDragEnd($event)"
          @dragover="isInternalReorderEnabled && handleRowDragOver($event, item)"
          @drop="isInternalReorderEnabled && handleRowDrop($event, item)"
        >
          <div
            class="song-row-content"
            :class="{
              lightBackground:
                item.idx % 2 === 1 && !selectedSongFilePaths.includes(getRowKey(item.song)),
              darkBackground:
                item.idx % 2 === 0 && !selectedSongFilePaths.includes(getRowKey(item.song)),
              selectedSong: selectedSongFilePaths.includes(getRowKey(item.song)),
              playingSong: playingSongRowKeySet.has(getRowKey(item.song)),
              globalSearchFlashA:
                flashRowKey === getRowKey(item.song) &&
                flashRowToken > 0 &&
                flashRowToken % 2 === 1,
              globalSearchFlashB:
                flashRowKey === getRowKey(item.song) &&
                flashRowToken > 0 &&
                flashRowToken % 2 === 0,
              fileMissing: item.song.fileMissing
            }"
            :style="{ 'min-width': `var(--songs-total-width, ${totalWidth}px)` }"
          >
            <div class="song-row-columns">
              <template v-for="col in visibleColumns" :key="col.key">
                <div
                  v-if="col.key === 'index'"
                  class="cell-title"
                  :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
                >
                  {{ getIndexCellValue(item.song, item.idx) }}
                </div>
                <div
                  v-else-if="col.key === 'cover'"
                  class="cell-cover"
                  :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
                >
                  <div
                    :ref="(el) => setCoverCellRef(item.song.filePath, el)"
                    class="cover-wrapper"
                    @mouseenter="onCoverMouseEnter(item.idx, $event)"
                    @mouseleave="onCoverMouseLeave(item.idx, $event)"
                    @dblclick.stop.prevent="
                      (!props.readOnly || props.allowDblclickWhenReadOnly) &&
                      handleCoverDblclick(item.song, $event)
                    "
                  >
                    <CoverThumbnailImage
                      :file-path="item.song.filePath"
                      :get-cover-url="getCoverUrl"
                      @error="onImgError(item.song.filePath)"
                    />
                  </div>
                </div>
                <WaveformPreviewCell
                  v-else-if="col.key === 'waveformPreview'"
                  :song="item.song"
                  :row-key="getRowKey(item.song)"
                  :width-px="col.width"
                  :can-preview-waveform="canPreviewWaveform"
                  :is-waveform-preview-active="isWaveformPreviewActive"
                  :handle-waveform-click="handleWaveformClick"
                  :handle-waveform-stop-click="handleWaveformStopClick"
                  :handle-hot-cue-click="handleWaveformHotCueClick"
                  :set-waveform-canvas-ref="setWaveformCanvasRef"
                  :get-waveform-placeholder-text="getWaveformPlaceholderText"
                  :get-waveform-placeholder-title="getWaveformPlaceholderTitle"
                  :get-waveform-preview-playhead-style="getWaveformPreviewPlayheadStyle"
                />
                <div
                  v-else
                  :ref="(el) => setCellRef(getCellKey(item.song, col.key), el)"
                  class="cell-title"
                  :class="{
                    'cell-title--curated-artist-hit': isCuratedArtistHit(item.song, col.key),
                    'cell-title--harmonic-match': isHarmonicKeyMatch(item.song, col.key)
                  }"
                  :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
                  :data-key="getCellKey(item.song, col.key)"
                >
                  <CuratedArtistCellContent
                    v-if="hasCuratedArtistBadge(item.song, col.key)"
                    :value="getCellValue(item.song, col.key)"
                    :badge-text="getCuratedArtistBadgeText(item.song, col.key)"
                    :badge-title="getCuratedArtistBadgeTitle(item.song, col.key)"
                    :only-when-overflow="onlyWhenOverflowComputed"
                  />
                  <template v-else>
                    {{ getCellValue(item.song, col.key) }}
                  </template>
                  <bubbleBox
                    v-if="
                      hoveredCellKey === getCellKey(item.song, col.key) &&
                      !hasCuratedArtistBadge(item.song, col.key)
                    "
                    :dom="cellRefMap[getCellKey(item.song, col.key)] || undefined"
                    :title="getCellTitle(item.song, col.key)"
                    :only-when-overflow="onlyWhenOverflowComputed"
                  />
                </div>
              </template>
            </div>
            <RowAnalysisBar
              v-if="showAnalysisProgressBar && !item.song.fileMissing"
              :progress="getAnalysisProgress(item.song.filePath)"
              :viewport-width="listViewportWidth"
              :scroll-left="scrollLeft"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
  <teleport to="body">
    <div
      v-if="isInternalReorderEnabled && draggingItemIds.length > 0 && topPadVisible"
      class="mixtape-drop-pad mixtape-drop-pad--top"
      :class="{ 'is-active': dragHoverEdge === 'top' }"
      :style="topPadStyle"
      @dragenter.stop.prevent="handleTopPadDragOver"
      @dragover.stop.prevent="handleTopPadDragOver"
      @drop.stop.prevent="handleTopPadDrop"
    ></div>
    <div
      v-if="isInternalReorderEnabled && draggingItemIds.length > 0 && bottomPadVisible"
      class="mixtape-drop-pad mixtape-drop-pad--bottom"
      :class="{ 'is-active': dragHoverEdge === 'bottom' }"
      :style="bottomPadStyle"
      @dragenter.stop.prevent="handleBottomPadDragOver"
      @dragover.stop.prevent="handleBottomPadDragOver"
      @drop.stop.prevent="handleBottomPadDrop"
    ></div>
    <CoverPreviewOverlay
      :active="coverPreviewState.active"
      :top="coverPreviewState.overlayTop"
      :left="coverPreviewState.overlayLeft"
      :width="coverPreviewState.overlayWidth"
      :size="coverPreviewSize"
      :image-url="previewedCoverUrl"
      @mousemove="handleCoverPreviewMouseMove"
      @mouseleave="() => closeCoverPreview()"
      @wheel="handleCoverPreviewWheel"
      @contextmenu="
        (!props.readOnly || props.allowContextMenuWhenReadOnly) &&
        handleCoverPreviewContextmenu($event)
      "
      @dblclick="
        (!props.readOnly || props.allowDblclickWhenReadOnly) && handleCoverPreviewDblclick($event)
      "
    />
  </teleport>
</template>

<style lang="scss" scoped src="./SongListRows.scss"></style>
