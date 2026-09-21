<script setup lang="ts">
import librarySelectArea from './modules/librarySelectArea.vue'
import libraryArea from './modules/libraryArea.vue'
import pioneerDeviceLibraryArea from './modules/pioneerDeviceLibraryArea.vue'
import songsArea from './modules/songsArea/songsArea.vue'
import pioneerSongsArea from './modules/pioneerSongsArea.vue'
import {
  type ISongsAreaPaneRuntimeState,
  type LibrarySelection,
  type SplitSongsAreaPaneKey,
  useRuntimeStore
} from '@renderer/stores/runtime'
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import songPlayer from './modules/songPlayer/songPlayer.vue'
import dropIntoDialog from '../components/dropIntoDialog'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import EmptyRecycleBinIcon from '@renderer/components/EmptyRecycleBinIcon.vue'
import libraryUtils from '@renderer/utils/libraryUtils'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { appendExternalPlaylistFromPaths } from '@renderer/utils/externalPlaylist'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import { emptyRecycleBinWithOptimisticUpdate } from '@renderer/utils/recycleBinActions'
import emitter from '@renderer/utils/mitt'
import {
  activateSongsAreaPane,
  exitSongsAreaSplit,
  getSongsAreaOppositePane
} from '@renderer/utils/songsAreaSplit'
import { useSongsAreaSplitDivider } from './homePage/useSongsAreaSplitDivider'
const runtime = useRuntimeStore()
let startX = 0
let isResizing = false
const isHovered = ref(false)
let hoverTimeout: NodeJS.Timeout
const librarySwitching = ref(false)
let librarySwitchTimer: ReturnType<typeof setTimeout> | null = null
const SONGS_AREA_WELCOME_EXIT_MS = 230
const singlePaneHeaderRevealPending = ref(false)
let singlePaneHeaderRevealTimer: ReturnType<typeof setTimeout> | null = null
const suspendedSplitActivePane = ref<SplitSongsAreaPaneKey | ''>('')
const suspendedSinglePaneState = ref<ISongsAreaPaneRuntimeState | null>(null)

const persistRuntimeLayoutConfig = () => {
  window.electron.ipcRenderer.send('layoutConfigChanged', JSON.stringify(runtime.layoutConfig))
}

// 计算 dragBar 的 left 样式
const dragBarLeft = computed(() => {
  return runtime.layoutConfig.libraryAreaWidth + 'px'
})

const handleMouseEnter = () => {
  // 清除之前的定时器，以防用户频繁移动鼠标进出 div
  clearTimeout(hoverTimeout)

  // 设置一个新的定时器，500 毫秒后改变背景色
  hoverTimeout = setTimeout(() => {
    isHovered.value = true
  }, 500)
}

const handleMouseLeave = () => {
  // 清除定时器，因为鼠标已经离开了
  clearTimeout(hoverTimeout)
  if (!isResizing) {
    // 立即将背景色设置回透明
    isHovered.value = false
  }
}
function startResize(e: MouseEvent) {
  e.preventDefault && e.preventDefault()
  isResizing = true
  isHovered.value = true
  startX = e.clientX
  document.addEventListener('mousemove', resize)
  document.addEventListener('mouseup', stopResize)
}

function resize(e: MouseEvent) {
  if (!isResizing) return
  const deltaX = e.clientX - startX

  // 获取窗口宽度
  const windowWidth = window.innerWidth

  const maxWidth = windowWidth - 100

  // 新宽度需要在最小值150和最大值之间
  const newWidth = Math.min(maxWidth, Math.max(150, runtime.layoutConfig.libraryAreaWidth + deltaX))

  if (runtime.layoutConfig.libraryAreaWidth + deltaX < 50) {
    runtime.layoutConfig.libraryAreaWidth = 0
  }
  if (newWidth != 150) {
    runtime.layoutConfig.libraryAreaWidth = newWidth
    startX = e.clientX
  }
}

function stopResize() {
  isResizing = false
  isHovered.value = false
  document.removeEventListener('mousemove', resize)
  document.removeEventListener('mouseup', stopResize)
  persistRuntimeLayoutConfig()
}

const triggerLibrarySwitchAnimation = (shouldSkip = false) => {
  if (shouldSkip) return
  librarySwitching.value = false
  if (librarySwitchTimer) {
    clearTimeout(librarySwitchTimer)
  }
  requestAnimationFrame(() => {
    librarySwitching.value = true
    librarySwitchTimer = setTimeout(() => {
      librarySwitching.value = false
    }, 220)
  })
}

const clearSinglePaneHeaderRevealTimer = () => {
  if (!singlePaneHeaderRevealTimer) return
  clearTimeout(singlePaneHeaderRevealTimer)
  singlePaneHeaderRevealTimer = null
}

const deferSinglePaneHeaderReveal = () => {
  clearSinglePaneHeaderRevealTimer()
  singlePaneHeaderRevealPending.value = true
  singlePaneHeaderRevealTimer = setTimeout(() => {
    singlePaneHeaderRevealPending.value = false
    singlePaneHeaderRevealTimer = null
  }, SONGS_AREA_WELCOME_EXIT_MS)
}

const adjustLibraryWidth = () => {
  const windowWidth = window.innerWidth
  const maxWidth = windowWidth - 100

  // 如果当前宽度超过最大允许宽度，才进行调整
  if (runtime.layoutConfig.libraryAreaWidth > maxWidth) {
    runtime.layoutConfig.libraryAreaWidth = maxWidth
    persistRuntimeLayoutConfig()
  }
}

onMounted(() => {
  window.addEventListener('resize', adjustLibraryWidth)
})

onUnmounted(() => {
  window.removeEventListener('resize', adjustLibraryWidth)
  document.removeEventListener('mousemove', resize)
  document.removeEventListener('mouseup', stopResize)
  clearTimeout(hoverTimeout)
  if (librarySwitchTimer) {
    clearTimeout(librarySwitchTimer)
  }
  clearSinglePaneHeaderRevealTimer()
})

let librarySelected = ref('FilterLibrary')
type CoreLibraryName = 'FilterLibrary' | 'CuratedLibrary' | 'SetLibrary' | 'MixtapeLibrary'
const splitPaneKeys: SplitSongsAreaPaneKey[] = ['left', 'right']
const normalizeLibraryPath = (value: string) => (value || '').replace(/\\/g, '/')
const isCoreLibraryName = (value: string): value is CoreLibraryName =>
  ['FilterLibrary', 'CuratedLibrary', 'SetLibrary', 'MixtapeLibrary'].includes(value)
const isPlaylistUnderLibrary = (uuid: string, libraryName: CoreLibraryName): boolean => {
  if (!uuid) return false
  const node = libraryUtils.getLibraryTreeByUUID(uuid)
  if (
    !node ||
    (node.type !== 'songList' && node.type !== 'mixtapeList' && node.type !== 'setList')
  ) {
    return false
  }
  if (libraryName === 'MixtapeLibrary') {
    if (node.type !== 'mixtapeList') return false
  } else if (libraryName === 'SetLibrary') {
    if (node.type !== 'setList') return false
  } else if (node.type !== 'songList') {
    return false
  }
  const dirPath = libraryUtils.findDirPathByUuid(uuid)
  if (!dirPath) return false
  const normalized = normalizeLibraryPath(dirPath)
  const prefix = `library/${libraryName}`
  return normalized === prefix || normalized.startsWith(`${prefix}/`)
}
const resolveLibrarySelectionBySongListUUID = (uuid: string): LibrarySelection | '' => {
  if (!uuid) return ''
  if (uuid === EXTERNAL_PLAYLIST_UUID) return 'ExternalPlaylist'
  if (uuid === RECYCLE_BIN_UUID) return 'RecycleBin'
  if (uuid === RECORDING_LIBRARY_UUID) return 'RecordingLibrary'
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
const resolveLibraryLabel = (libraryName: LibrarySelection | '') => {
  switch (libraryName) {
    case 'FilterLibrary':
      return t('library.filter')
    case 'CuratedLibrary':
      return t('library.curated')
    case 'SetLibrary':
      return t('library.setLibrary')
    case 'MixtapeLibrary':
      return t('library.mixtapeLibrary')
    case 'ExternalPlaylist':
      return t('library.externalPlaylist')
    case 'RecycleBin':
      return t('recycleBin.recycleBin')
    case 'RecordingLibrary':
      return t('library.recordingLibrary')
    default:
      return ''
  }
}
const resolveSongsPaneTitle = (pane: SplitSongsAreaPaneKey | 'single') => {
  const paneState = runtime.songsAreaPanels.panes[pane]
  const uuid = paneState.songListUUID
  if (!uuid) return t('playlist.noPanePlaylist')
  const libraryLabel = resolveLibraryLabel(resolveLibrarySelectionBySongListUUID(uuid))
  const dirName = libraryUtils.getLibraryTreeByUUID(uuid)?.dirName || ''
  if (!libraryLabel) return dirName
  if (!dirName) return libraryLabel
  return `${libraryLabel} / ${dirName}`
}
const syncLibrarySelectionByPane = (pane: SplitSongsAreaPaneKey | 'single') => {
  const nextLibrary = resolveLibrarySelectionBySongListUUID(
    runtime.songsAreaPanels.panes[pane].songListUUID
  )
  if (!nextLibrary || runtime.libraryAreaSelected === nextLibrary) return
  runtime.libraryAreaSelected = nextLibrary
}
const cloneSongsAreaPaneState = (
  state: ISongsAreaPaneRuntimeState
): ISongsAreaPaneRuntimeState => ({
  songListUUID: String(state.songListUUID || ''),
  songInfoArr: Array.isArray(state.songInfoArr) ? [...state.songInfoArr] : [],
  missingWaveformFilePaths: Array.isArray(state.missingWaveformFilePaths)
    ? [...state.missingWaveformFilePaths]
    : [],
  totalSongCount: Number(state.totalSongCount || 0),
  selectedSongFilePath: Array.isArray(state.selectedSongFilePath)
    ? [...state.selectedSongFilePath]
    : [],
  scrollTop: Number.isFinite(state.scrollTop) ? state.scrollTop : 0,
  scrollLeft: Number.isFinite(state.scrollLeft) ? state.scrollLeft : 0,
  columnCacheByMode: Object.fromEntries(
    Object.entries(state.columnCacheByMode || {}).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map((item) => ({ ...item })) : []
    ])
  ) as ISongsAreaPaneRuntimeState['columnCacheByMode']
})
const suspendSplitForSpecialLibrary = () => {
  if (!runtime.songsAreaPanels.splitEnabled) return
  const activePane = runtime.songsAreaPanels.activePane
  suspendedSplitActivePane.value = activePane === 'right' ? 'right' : 'left'
  runtime.songsAreaPanels.splitEnabled = false
  runtime.setSongsAreaActivePane('single')
}
const suspendSinglePaneForSpecialLibrary = () => {
  if (runtime.songsAreaPanels.splitEnabled) return
  if (suspendedSinglePaneState.value) return
  suspendedSinglePaneState.value = cloneSongsAreaPaneState(runtime.songsAreaPanels.panes.single)
}
const restoreSplitAfterSpecialLibraryIfNeeded = () => {
  if (!suspendedSplitActivePane.value) return false
  runtime.songsAreaPanels.splitEnabled = true
  runtime.setSongsAreaActivePane(suspendedSplitActivePane.value)
  suspendedSplitActivePane.value = ''
  return true
}
const restoreSinglePaneAfterSpecialLibraryIfNeeded = () => {
  if (!suspendedSinglePaneState.value) return false
  runtime.assignSongsAreaPaneState('single', suspendedSinglePaneState.value)
  runtime.setSongsAreaActivePane('single')
  suspendedSinglePaneState.value = null
  return true
}

watch(
  () => runtime.songsArea.songListUUID,
  (uuid) => {
    if (
      !uuid ||
      uuid === EXTERNAL_PLAYLIST_UUID ||
      uuid === RECYCLE_BIN_UUID ||
      uuid === RECORDING_LIBRARY_UUID
    ) {
      return
    }
    const currentLibrary = runtime.libraryAreaSelected
    if (!isCoreLibraryName(currentLibrary)) return
    if (!isPlaylistUnderLibrary(uuid, currentLibrary)) return
    runtime.lastSongListUUIDByLibrary[currentLibrary] = uuid
  }
)
watch(
  () => runtime.libraryAreaSelected,
  (val, oldVal) => {
    librarySelected.value = val
    if (val === 'ExternalPlaylist') {
      if (runtime.songsAreaPanels.splitEnabled) {
        suspendSplitForSpecialLibrary()
      }
      runtime.songsArea.songListUUID = EXTERNAL_PLAYLIST_UUID
    } else if (val === 'RecycleBin' || val === 'RecordingLibrary') {
      if (runtime.songsAreaPanels.splitEnabled) {
        suspendSplitForSpecialLibrary()
      } else {
        suspendSinglePaneForSpecialLibrary()
      }
      const specialListUUID = val === 'RecycleBin' ? RECYCLE_BIN_UUID : RECORDING_LIBRARY_UUID
      if (runtime.songsArea.songListUUID !== specialListUUID) {
        runtime.songsArea.songListUUID = specialListUUID
      }
    } else if (isCoreLibraryName(val)) {
      if (restoreSplitAfterSpecialLibraryIfNeeded()) {
        triggerLibrarySwitchAnimation(oldVal === undefined)
        return
      }
      if (restoreSinglePaneAfterSpecialLibraryIfNeeded()) {
        triggerLibrarySwitchAnimation(oldVal === undefined)
        return
      }
      // 从 ExternalPlaylist/RecycleBin/RecordingLibrary 切换时，用 lastSongListUUIDByLibrary 恢复歌单
      if (
        oldVal === 'ExternalPlaylist' ||
        oldVal === 'RecycleBin' ||
        oldVal === 'RecordingLibrary'
      ) {
        const savedUUID = runtime.lastSongListUUIDByLibrary[val] || ''
        if (savedUUID) {
          runtime.songsArea.songListUUID = savedUUID
        } else {
          runtime.clearSongsAreaPaneState('single')
        }
        triggerLibrarySwitchAnimation(oldVal === undefined)
        return
      }
      if (runtime.songsAreaPanels.splitEnabled || !oldVal) {
        triggerLibrarySwitchAnimation(oldVal === undefined)
        return
      }
      // 单屏核心库切换只切左侧树，不再驱动歌曲列表切换
    } else if (val === 'PioneerDeviceLibrary') {
      // 保留当前歌曲列表面板状态，切回核心库时继续使用
    }
    triggerLibrarySwitchAnimation(oldVal === undefined)
  },
  { immediate: true }
)
const librarySelectedChange = (item: { name: string }) => {
  if (item.name == librarySelected.value) {
    return
  }
  librarySelected.value = item.name
}
let dragOverSongsArea = ref(false)
const isExternalPlaylistView = computed(() => runtime.libraryAreaSelected === 'ExternalPlaylist')
const isRecycleBinView = computed(() => runtime.libraryAreaSelected === 'RecycleBin')
const isRecordingLibraryView = computed(() => runtime.libraryAreaSelected === 'RecordingLibrary')
const isMixtapeLibraryView = computed(() => runtime.libraryAreaSelected === 'MixtapeLibrary')
const isPioneerDeviceLibraryView = computed(
  () => runtime.libraryAreaSelected === 'PioneerDeviceLibrary'
)
const isLibraryPanelHidden = computed(
  () => isExternalPlaylistView.value || isRecycleBinView.value || isRecordingLibraryView.value
)
const showMainSongPlayer = computed(
  () => runtime.mainWindowBrowseMode === 'browser' && Boolean(runtime.playingData.playingSong)
)
const isSongsAreaSplit = computed(
  () => runtime.songsAreaPanels.splitEnabled && !isPioneerDeviceLibraryView.value
)
const showEmptyRecycleBinButton = computed(
  () =>
    isRecycleBinView.value &&
    runtime.songsArea.songListUUID === RECYCLE_BIN_UUID &&
    runtime.songsArea.totalSongCount > 0
)
const showSingleSongsAreaHeader = computed(
  () =>
    !isSongsAreaSplit.value &&
    !isPioneerDeviceLibraryView.value &&
    !singlePaneHeaderRevealPending.value &&
    Boolean(runtime.songsAreaPanels.panes.single.songListUUID)
)

const {
  splitSongsAreaRef,
  splitSongsAreaStyle,
  splitDividerHovered,
  isSongsAreaSplitDividerResizing,
  startSongsAreaSplitResize
} = useSongsAreaSplitDivider({
  runtime,
  isSongsAreaSplit,
  persistLayoutConfig: persistRuntimeLayoutConfig
})

watch(
  () => runtime.songsAreaPanels.panes.single.songListUUID,
  (nextUUID, previousUUID) => {
    if (runtime.songsAreaPanels.splitEnabled || isPioneerDeviceLibraryView.value) {
      clearSinglePaneHeaderRevealTimer()
      singlePaneHeaderRevealPending.value = false
      return
    }
    if (!previousUUID && nextUUID) {
      deferSinglePaneHeaderReveal()
      return
    }
    if (!nextUUID) {
      clearSinglePaneHeaderRevealTimer()
      singlePaneHeaderRevealPending.value = false
    }
  }
)

watch(
  () => [runtime.songsAreaPanels.splitEnabled, isPioneerDeviceLibraryView.value],
  ([splitEnabled, pioneerView]) => {
    if (!splitEnabled && !pioneerView) return
    clearSinglePaneHeaderRevealTimer()
    singlePaneHeaderRevealPending.value = false
  }
)
const isSplitPaneActive = (pane: SplitSongsAreaPaneKey) =>
  runtime.songsAreaPanels.activePane === pane
const handleSplitPaneMouseDown = (pane: SplitSongsAreaPaneKey) => {
  activateSongsAreaPane(runtime, pane)
  syncLibrarySelectionByPane(pane)
}
const handleSplitPaneClose = (pane: SplitSongsAreaPaneKey) => {
  const remainingPane = getSongsAreaOppositePane(pane)
  exitSongsAreaSplit(runtime, remainingPane)
  syncLibrarySelectionByPane('single')
}
const handleSinglePaneClose = () => {
  runtime.clearSongsAreaPaneState('single')
  runtime.setSongsAreaActivePane('single')
}

const clearMainPlayerPlaybackState = () => {
  const hasPlayingState =
    Boolean(runtime.playingData.playingSong) ||
    Boolean(runtime.playingData.playingSongListUUID) ||
    runtime.playingData.playingSongListData.length > 0
  if (!hasPlayingState) return
  try {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  } catch {}
  runtime.playerReady = false
  runtime.isSwitchingSong = false
  runtime.playingData.playingSong = null
  runtime.playingData.playingSongListUUID = ''
  runtime.playingData.playingSongListData = []
}

watch(
  () => runtime.mainWindowBrowseMode,
  (mode, previousMode) => {
    if (mode !== 'browser' && previousMode === 'browser') {
      clearMainPlayerPlaybackState()
    }
  }
)

const isInternalSongDrag = (e: DragEvent) => {
  return (
    (runtime.songDragActive && runtime.draggingSongFilePaths.length > 0) ||
    e.dataTransfer?.types?.includes('application/x-song-drag')
  )
}
const isExternalFileDrag = (e: DragEvent) => {
  const types = e.dataTransfer?.types
  if (types?.includes('Files')) return true
  const items = e.dataTransfer?.items
  if (!items || items.length === 0) return false
  return Array.from(items).some((item) => item.kind === 'file')
}
const dragover = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }

  // 如果是歌曲拖拽，忽略处理
  if (isInternalSongDrag(e)) {
    return
  }
  if (!isExternalFileDrag(e)) {
    dragOverSongsArea.value = false
    e.dataTransfer.dropEffect = 'none'
    return
  }

  if (isRecycleBinView.value || isRecordingLibraryView.value) {
    e.dataTransfer.dropEffect = 'none'
    dragOverSongsArea.value = false
    return
  }

  if (isMixtapeLibraryView.value) {
    e.dataTransfer.dropEffect = 'none'
    dragOverSongsArea.value = false
    return
  }

  if (isExternalPlaylistView.value) {
    e.dataTransfer.dropEffect = 'copy'
    dragOverSongsArea.value = true
    return
  }

  if (runtime.dragItemData !== null || !runtime.songsArea.songListUUID) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  if (runtime.dragTableHeader) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  e.dataTransfer.dropEffect = 'move'
  dragOverSongsArea.value = true
}
const dragleave = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }

  // 如果是歌曲拖拽，忽略处理
  if (isInternalSongDrag(e)) {
    return
  }
  if (!isExternalFileDrag(e)) {
    dragOverSongsArea.value = false
    return
  }

  if (isRecycleBinView.value || isRecordingLibraryView.value) {
    dragOverSongsArea.value = false
    return
  }

  if (isMixtapeLibraryView.value) {
    dragOverSongsArea.value = false
    return
  }

  if (isExternalPlaylistView.value) {
    dragOverSongsArea.value = false
    return
  }

  if (runtime.dragItemData !== null || !runtime.songsArea.songListUUID) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  if (runtime.dragTableHeader) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  dragOverSongsArea.value = false
}

const drop = async (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }

  // 如果是歌曲拖拽，忽略处理
  if (isInternalSongDrag(e)) {
    return
  }
  if (!isExternalFileDrag(e)) {
    dragOverSongsArea.value = false
    e.dataTransfer.dropEffect = 'none'
    return
  }

  if (isRecycleBinView.value || isRecordingLibraryView.value) {
    dragOverSongsArea.value = false
    return
  }

  if (isMixtapeLibraryView.value) {
    dragOverSongsArea.value = false
    return
  }

  if (isExternalPlaylistView.value) {
    dragOverSongsArea.value = false
    const filePaths: string[] = []
    for (let item of Array.from(e.dataTransfer.files)) {
      const resolved = window.api.showFilesPath(item)
      if (resolved) {
        filePaths.push(resolved)
      }
    }
    if (filePaths.length) {
      try {
        await appendExternalPlaylistFromPaths(filePaths)
      } catch (error) {
        console.error('[external-playlist] append failed', error)
      }
    }
    return
  }

  if (runtime.dragItemData !== null || !runtime.songsArea.songListUUID) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  if (runtime.dragTableHeader) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  dragOverSongsArea.value = false
  const filePaths = []
  for (let item of Array.from(e.dataTransfer.files)) {
    filePaths.push(window.api.showFilesPath(item))
  }

  let songListPath = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    await confirm({
      title: t('common.error'),
      content: [t('library.notExistOnDisk')],
      confirmShow: false
    })
    let libraryTree = libraryUtils.getLibraryTreeByUUID(runtime.songsArea.songListUUID)
    if (libraryTree === null) {
      throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
    }
    let fatherDirData = libraryUtils.getFatherLibraryTreeByUUID(runtime.songsArea.songListUUID)
    if (fatherDirData === null) {
      throw new Error(`fatherDirData error: ${JSON.stringify(fatherDirData)}`)
    }
    let songListItem = libraryUtils.getLibraryTreeByUUID(runtime.songsArea.songListUUID)
    if (songListItem === null) {
      throw new Error(`songListItem error: ${JSON.stringify(songListItem)}`)
    }
    libraryUtils.updatePlayingState(songListItem)
    let deleteIndex
    if (fatherDirData.children === undefined) {
      throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
    }
    for (let index in fatherDirData.children) {
      if (fatherDirData.children[index] == libraryTree) {
        deleteIndex = index
        continue
      }
      if (fatherDirData.children[index].order && libraryTree.order) {
        if (fatherDirData.children[index].order > libraryTree.order) {
          fatherDirData.children[index].order--
        }
      }
    }
    fatherDirData.children.splice(Number(deleteIndex), 1)
    libraryUtils.diffLibraryTreeExecuteFileOperation()
    return
  }
  let result = await dropIntoDialog({
    songListUuid: runtime.songsArea.songListUUID,
    libraryName: librarySelected.value
  })
  if (result === 'cancel') {
    return
  }
  runtime.importingSongListUUID = result.importingSongListUUID
  runtime.isProgressing = true
  window.electron.ipcRenderer.send('startImportSongs', {
    filePaths: filePaths,
    songListPath: result.songListPath,
    isDeleteSourceFile: result.isDeleteSourceFile,
    isComparisonSongFingerprint: result.isComparisonSongFingerprint,
    isPushSongFingerprintLibrary: result.isPushSongFingerprintLibrary,
    deduplicateMode: result.deduplicateMode,
    songListUUID: result.importingSongListUUID
  })
}
</script>
<template>
  <div style="display: flex; height: 100%; min-width: 0; overflow: hidden">
    <librarySelectArea
      style="flex-shrink: 0"
      @library-selected-change="librarySelectedChange"
    ></librarySelectArea>
    <div style="flex-grow: 1; min-width: 0; overflow: hidden">
      <div class="mainContent" :class="{ 'mainContent--with-player': showMainSongPlayer }">
        <div
          v-show="!isLibraryPanelHidden"
          class="libraryPanel"
          data-user-guide-target="library-tree"
          style="border-right: 1px solid var(--border); flex-shrink: 0"
          :class="{ librarySwitching }"
          :style="'width:' + runtime.layoutConfig.libraryAreaWidth + 'px'"
        >
          <pioneerDeviceLibraryArea
            v-if="isPioneerDeviceLibraryView"
            style="width: 100%; height: 100%"
          />
          <div v-else class="localLibraryTreePanel">
            <div
              v-for="item of runtime.libraryTree.children"
              v-show="librarySelected == item.dirName"
              style="width: 100%; height: 100%"
            >
              <libraryArea :uuid="item.uuid"></libraryArea>
            </div>

            <div
              v-if="runtime.libraryTreeLoading"
              class="localLibraryTreeLoading"
              role="status"
              aria-live="polite"
            >
              <span class="localLibraryTreeLoadingSpinner" aria-hidden="true"></span>
              <span>{{ t('common.loading') }}</span>
            </div>
          </div>
        </div>
        <div
          v-show="!isLibraryPanelHidden"
          class="dragBar"
          :style="{ left: dragBarLeft }"
          :class="{ dragBarHovered: isHovered }"
          @mousedown="startResize"
          @mouseenter="handleMouseEnter"
          @mouseleave="handleMouseLeave"
        ></div>
        <div
          style="
            flex: 1;
            background-color: var(--bg);
            border: 1px solid transparent;
            min-width: 0;
            overflow: hidden;
          "
          :class="{ songsAreaDragHoverBorder: dragOverSongsArea }"
          @dragover.stop.prevent="dragover"
          @dragleave.stop="dragleave"
          @drop.stop.prevent="drop"
        >
          <pioneerSongsArea
            v-if="isPioneerDeviceLibraryView"
            style="width: 100%; height: 100%; min-width: 0"
          />
          <div
            v-else-if="isSongsAreaSplit"
            ref="splitSongsAreaRef"
            class="splitSongsArea"
            :style="splitSongsAreaStyle"
          >
            <div
              v-for="pane in splitPaneKeys"
              :key="pane"
              class="splitSongsAreaPane"
              :class="[`splitSongsAreaPane--${pane}`, { 'is-active': isSplitPaneActive(pane) }]"
              @mousedown.capture="handleSplitPaneMouseDown(pane)"
            >
              <div class="splitSongsAreaPaneHeader">
                <div class="splitSongsAreaPaneTitle">{{ resolveSongsPaneTitle(pane) }}</div>
                <bubbleBoxTrigger
                  v-if="showEmptyRecycleBinButton"
                  tag="button"
                  class="splitSongsAreaPaneClose"
                  type="button"
                  :title="t('recycleBin.emptyRecycleBin')"
                  @click.stop="emptyRecycleBinWithOptimisticUpdate(runtime)"
                >
                  <EmptyRecycleBinIcon />
                </bubbleBoxTrigger>
                <bubbleBoxTrigger
                  tag="button"
                  class="splitSongsAreaPaneClose"
                  type="button"
                  :title="t('common.close')"
                  @click.stop="handleSplitPaneClose(pane)"
                >
                  <span aria-hidden="true">×</span>
                </bubbleBoxTrigger>
              </div>
              <songsArea
                :pane="pane"
                :enable-preview-player="pane === 'left'"
                style="flex: 1; min-width: 0; min-height: 0"
              />
            </div>
            <div
              class="splitSongsAreaDivider"
              :class="{
                'is-hovered': splitDividerHovered,
                'is-resizing': isSongsAreaSplitDividerResizing
              }"
              role="separator"
              aria-orientation="vertical"
              @mousedown.stop.prevent="startSongsAreaSplitResize"
              @mouseenter="splitDividerHovered = true"
              @mouseleave="splitDividerHovered = isSongsAreaSplitDividerResizing"
            ></div>
          </div>
          <div v-else class="singleSongsAreaShell">
            <div v-if="showSingleSongsAreaHeader" class="splitSongsAreaPaneHeader">
              <div class="splitSongsAreaPaneTitle">{{ resolveSongsPaneTitle('single') }}</div>
              <bubbleBoxTrigger
                v-if="showEmptyRecycleBinButton"
                tag="button"
                class="splitSongsAreaPaneClose"
                type="button"
                :title="t('recycleBin.emptyRecycleBin')"
                @click.stop="emptyRecycleBinWithOptimisticUpdate(runtime)"
              >
                <EmptyRecycleBinIcon />
              </bubbleBoxTrigger>
              <bubbleBoxTrigger
                tag="button"
                class="splitSongsAreaPaneClose"
                type="button"
                :title="t('common.close')"
                @click.stop="handleSinglePaneClose"
              >
                <span aria-hidden="true">×</span>
              </bubbleBoxTrigger>
            </div>
            <songsArea
              pane="single"
              :enable-preview-player="true"
              style="flex: 1; min-width: 0; min-height: 0"
            />
          </div>
        </div>
      </div>
      <div class="mainPlayerShell" :class="{ 'mainPlayerShell--visible': showMainSongPlayer }">
        <songPlayer />
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.mainContent {
  display: flex;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  position: relative;
  transition: height 0.22s cubic-bezier(0.22, 1, 0.36, 1);

  &.mainContent--with-player {
    height: calc(100% - 63px);
  }
}

.mainPlayerShell {
  height: 62px;
  max-height: 0;
  opacity: 0;
  transform: translateY(8px);
  border-top: 1px solid transparent;
  position: relative;
  overflow: hidden;
  transform-origin: bottom center;
  transition:
    max-height 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.18s ease,
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    border-color 0.18s ease;
  pointer-events: none;
}

.mainPlayerShell--visible {
  max-height: 62px;
  opacity: 1;
  transform: translateY(0);
  border-top-color: var(--border);
  overflow: visible;
  pointer-events: auto;
  z-index: 2;
}

.libraryPanel {
  height: 100%;

  &.librarySwitching {
    animation: librarySwitchFade 220ms ease;
  }
}

.localLibraryTreePanel {
  position: relative;
  width: 100%;
  height: 100%;
}

.localLibraryTreeLoading {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-weak);
  font-size: 12px;
  background-color: var(--bg);
  pointer-events: all;
}

.localLibraryTreeLoadingSpinner {
  width: 14px;
  height: 14px;
  box-sizing: border-box;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: localLibraryTreeLoadingSpin 0.75s linear infinite;
}

@keyframes localLibraryTreeLoadingSpin {
  to {
    transform: rotate(360deg);
  }
}

.splitSongsArea {
  display: flex;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  position: relative;
  --songs-area-split-left-width: 50%;
  --songs-area-split-right-width: 50%;
  --songs-area-split-divider-left: 50%;
}

.singleSongsAreaShell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  overflow: hidden;
}

.splitSongsAreaPane {
  flex: 0 0 auto;
  min-width: 0;
  box-sizing: border-box;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--bg) 97%, var(--font-color) 3%);

  &.is-active {
    background: color-mix(in srgb, var(--bg) 92%, var(--main-color) 8%);
  }
}

.splitSongsAreaPane--left {
  width: var(--songs-area-split-left-width);
  flex-basis: var(--songs-area-split-left-width);
  border-right: 1px solid var(--border);
}

.splitSongsAreaPane--right {
  width: var(--songs-area-split-right-width);
  flex-basis: var(--songs-area-split-right-width);
}

.splitSongsAreaDivider {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--songs-area-split-divider-left);
  width: 8px;
  transform: translateX(-50%);
  z-index: 10;
  cursor: ew-resize;
  background: transparent;
  touch-action: none;
}

.splitSongsAreaDivider::before {
  content: '';
  position: absolute;
  top: 0;
  height: 100%;
  bottom: 0;
  left: 50%;
  width: 4px;
  transform: translateX(-50%);
  background-color: var(--accent);
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}

.splitSongsAreaDivider.is-hovered::before,
.splitSongsAreaDivider.is-resizing::before {
  opacity: 1;
}

:global(body.songs-area-split-resizing),
:global(body.songs-area-split-resizing *) {
  cursor: ew-resize !important;
  user-select: none !important;
}

.splitSongsAreaPaneHeader {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 90%, var(--font-color) 10%);
  flex-shrink: 0;
}

.splitSongsAreaPaneTitle {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--font-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.splitSongsAreaPaneClose {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--font-color);
  cursor: pointer;
  flex-shrink: 0;

  &:hover {
    background: color-mix(in srgb, var(--main-color) 18%, transparent);
  }
}

@keyframes librarySwitchFade {
  0% {
    opacity: 0;
    transform: translateY(6px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mainContent,
  .mainPlayerShell {
    transition: none;
  }

  .libraryPanel.librarySwitching {
    animation: none;
  }
}

.dragBar {
  position: absolute;
  top: 0;
  height: 100%;
  width: 8px;
  /* 触发区域宽度 */
  cursor: ew-resize;
  transform: translateX(-50%);
  /* 将 8px 的触发区域居中在 left 位置 */
  z-index: 10;
  /* 确保它在其他内容之上 */
  background-color: transparent;
  /* 确保触发区域不可见 */
}

.dragBar::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  /* 相对于 dragBar 居中 */
  transform: translateX(-50%);
  /* 精确居中 */
  width: 4px;
  /* 宽度始终为 4px */
  height: 100%;
  background-color: var(--accent);
  /* 指示器颜色 */
  opacity: 0;
  /* 初始透明度为 0 */
  transition: opacity 0.2s ease;
  /* 过渡效果应用在透明度上 */
  pointer-events: none;
  /* 伪元素不应捕获事件 */
}

/* 当 dragBar 悬停或拖动时，显示伪元素 */
.dragBar.dragBarHovered::before {
  opacity: 1;
  /* 透明度变为 1 */
}

.songsAreaDragHoverBorder {
  /* 移除默认边框样式 */
  border-color: transparent !important;
  position: relative !important;
}

/* 添加伪元素来创建永远位于顶层的边框 */
.songsAreaDragHoverBorder::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 2px;
  bottom: 0;
  border: 1px solid var(--accent);
  pointer-events: none;
  /* 不影响鼠标事件 */
  z-index: 2;
  /* 确保在所有内容之上 */
}
</style>
