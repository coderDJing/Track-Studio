<script setup lang="ts">
import {
  ref,
  nextTick,
  useTemplateRef,
  reactive,
  onMounted,
  onUnmounted,
  watch,
  computed
} from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import dialogLibraryItem from '@renderer/components/dialogLibraryItem/index.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import listIconAsset from '@renderer/assets/listIcon.svg?asset'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import emitter from '../../utils/mitt'
import { DEFAULT_MIXTAPE_STEM_PROFILE } from '@shared/mixtapeStemProfiles'
import {
  handleDragStart,
  handleDragOver,
  handleDragEnter,
  handleDragLeave,
  handleDrop,
  type DragState
} from '../../utils/dragUtils'
import {
  getLibraryTreeSortRule,
  isLibraryTreeManualSort,
  libraryTreeSortRuleVersion,
  libraryTreeTrackCountVersion,
  sortLibraryTreeChildren
} from '@renderer/utils/libraryTreeSort'
import { showNearMouseTip } from '@renderer/utils/nearMouseTip'
import {
  clearPendingMixtapeProjectMode,
  consumePendingMixtapeProjectMode,
  persistMixtapeProjectMode,
  setPendingMixtapeProjectMode
} from '@renderer/composables/mixtape/stemMode'
import type { IDir, IMenu } from '../../../../types/globals'
const listIcon = listIconAsset
type PlaylistContentChangedPayload = {
  uuids?: string[]
}
const props = defineProps({
  uuid: {
    type: String,
    required: true
  },
  libraryName: {
    type: String
  },
  needPaddingLeft: {
    type: Boolean,
    default: true
  },
  // 当父组件需要控制“避免与最近使用区重复高亮”时，传入 true
  suppressHighlight: {
    type: Boolean,
    default: false
  },
  // 歌单筛选关键词（仅匹配歌单名）
  filterText: {
    type: [String, Object],
    default: ''
  }
})
const runtime = useRuntimeStore()
let dirData = libraryUtils.getLibraryTreeByUUID(props.uuid)
if (dirData === null) {
  throw new Error(`dirData error: ${JSON.stringify(dirData)}`)
}
let fatherDirData = libraryUtils.getFatherLibraryTreeByUUID(props.uuid)
const isMixtapeDialog = computed(() => String(props.libraryName || '').startsWith('MixtapeLibrary'))
const isSetDialog = computed(() => props.libraryName === 'SetLibrary')
const isDialogListType = (node?: IDir | null) => {
  if (isMixtapeDialog.value) return node?.type === 'mixtapeList'
  if (isSetDialog.value) return node?.type === 'setList'
  return node?.type === 'songList'
}
const resolveMixtapeModeTag = (mixMode?: string) =>
  mixMode === 'eq' ? t('mixtape.mixModeEqTag') : t('mixtape.mixModeStemTag')
const resolveMixtapeModeLabel = (mixMode?: string) =>
  mixMode === 'eq' ? t('mixtape.mixModeEqLabel') : t('mixtape.mixModeStemLabel')
const resolveMixtapeBadgeTitle = (mixMode?: string) => resolveMixtapeModeLabel(mixMode)
const nameTextRef = ref<HTMLElement | null>(null)
const nameTextHovered = ref(false)
const onlyShowBubbleWhenOverflow = computed(
  () => !Reflect.get(runtime.setting, 'songListBubbleAlways')
)
const createPlaylistMenuKey = 'library.createPlaylist'
const createStemMixtapeMenuKey = 'library.createStemMixtape'
const createEqMixtapeMenuKey = 'library.createEqMixtape'
const createSetPlaylistMenuKey = 'library.createSetPlaylist'
const createSetFolderMenuKey = 'library.createSetFolder'
const createFolderMenuKey = 'library.createFolder'
const renameMenuKey = 'common.rename'
const deleteMenuKey = 'common.delete'
const deletePlaylistMenuKey = 'playlist.deletePlaylist'
const myInputHandleInput = () => {
  const newName = operationInputValue.value
  const invalidCharsRegex = /[<>:"/\\|?*\u0000-\u001F]/
  let hintShouldShow = false
  let hintText = ''

  if (!fatherDirData) return // Keep existing null check

  if (newName === '') {
    hintText = t('library.nameRequired')
    hintShouldShow = true
  } else if (invalidCharsRegex.test(newName)) {
    hintText = t('library.nameInvalidChars')
    hintShouldShow = true
  } else {
    const exists = fatherDirData.children?.some((obj) => obj.dirName === newName)
    if (exists) {
      hintText = t('library.nameAlreadyExists', { name: newName })
      hintShouldShow = true
    }
  }

  inputHintText.value = hintText
  inputHintShow.value = hintShouldShow
}

const inputKeyDownEnter = () => {
  // Rely on inputHintShow which is now correctly updated
  if (inputHintShow.value || operationInputValue.value === '') {
    if (!inputHintShow.value) {
      inputHintText.value = t('library.nameRequired')
      inputHintShow.value = true
    }
    return
  }
  myInput.value?.blur() // Proceed to blur if valid
}

const inputKeyDownEsc = () => {
  operationInputValue.value = '' // Clear value on Esc
  inputHintShow.value = false // Hide hint
  inputBlurHandle() // Trigger blur logic (which handles cleanup if needed)
}

const inputHintText = ref('')
const inputBlurHandle = async () => {
  if (inputHintShow.value || operationInputValue.value == '') {
    if (dirData && dirData.dirName == '') {
      if (fatherDirData && fatherDirData.children && fatherDirData.children[0]?.dirName == '') {
        clearPendingMixtapeProjectMode(dirData?.uuid || '')
        fatherDirData.children.shift()
      }
    }
    operationInputValue.value = ''
    inputHintShow.value = false
    return
  }

  if (!fatherDirData) return
  if (fatherDirData.children === undefined) {
    throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
  }

  if (dirData) {
    for (let item of fatherDirData.children) {
      if (item.order) {
        item.order++
      }
    }
    dirData.dirName = operationInputValue.value
    dirData.order = 1
    dirData.children = []
    operationInputValue.value = ''

    const success = await libraryUtils.diffLibraryTreeExecuteFileOperation()
    if (dirData.type === 'mixtapeList') {
      const projectMode = consumePendingMixtapeProjectMode(dirData.uuid)
      if (success && projectMode) {
        await persistMixtapeProjectMode(dirData.uuid, projectMode)
      }
    }
    // 命名完成并写盘成功后，再在对话框中高亮该歌单（不触发双击）
    if (isDialogListType(dirData)) {
      runtime.dialogSelectedSongListUUID = dirData.uuid
      emits('markTreeSelected')
      // 命名完成后刷新曲目数量显示（此时目录已存在）
      if (dirData.type === 'songList') {
        try {
          await ensureTrackCount()
        } catch {}
      }
    }
    // 清除创建中标记
    if (runtime.creatingSongListUUID === dirData.uuid) {
      runtime.creatingSongListUUID = ''
    }
  }
}
let operationInputValue = ref('')

const inputHintShow = ref(false)

const myInput = useTemplateRef('myInput')
const rowEl = useTemplateRef('rowEl')
if (dirData && dirData.dirName == '') {
  nextTick(() => {
    myInput.value?.focus()
  })
}

const rightClickMenuShow = ref(false)
const buildCreateMenuItems = (): IMenu[] => {
  if (isMixtapeDialog.value) {
    return [
      { menuName: createStemMixtapeMenuKey },
      { menuName: createEqMixtapeMenuKey },
      { menuName: createFolderMenuKey }
    ]
  }
  if (isSetDialog.value) {
    return [{ menuName: createSetPlaylistMenuKey }, { menuName: createSetFolderMenuKey }]
  }
  return [{ menuName: createPlaylistMenuKey }, { menuName: createFolderMenuKey }]
}
const menuArr = ref<IMenu[][]>(
  dirData?.type == 'dir'
    ? [buildCreateMenuItems(), [{ menuName: renameMenuKey }, { menuName: deleteMenuKey }]]
    : [[{ menuName: renameMenuKey }, { menuName: deletePlaylistMenuKey }]]
)
const deleteDir = async () => {
  if (dirData?.type === 'mixtapeList') {
    const allowed = await libraryUtils.ensureMixtapeDeleteAllowed(props.uuid)
    if (!allowed) return
  }
  let libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
  if (libraryTree === null) {
    throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
  }

  // --- Add logic to update songsArea and playingData ---
  let uuids = libraryUtils.getAllUuids(libraryTree) // Get all UUIDs within the item being deleted

  // If the deleted item or its children contain the currently viewed songlist
  if (uuids.indexOf(runtime.songsArea.songListUUID) !== -1) {
    runtime.songsArea.songListUUID = '' // Clear the currently viewed songlist
    // Optionally clear other related states like selectedSongFilePath, songInfoArr if necessary
    runtime.songsArea.selectedSongFilePath.length = 0
    runtime.songsArea.songInfoArr = []
    runtime.songsArea.totalSongCount = 0
  }
  // If the deleted item or its children contain the currently playing songlist
  if (uuids.indexOf(runtime.playingData.playingSongListUUID) !== -1) {
    runtime.playingData.playingSongListUUID = '' // Clear playing songlist UUID
    runtime.playingData.playingSongListData = [] // Clear playing list data
    runtime.playingData.playingSong = null // Clear the currently playing song
  }
  // --- End added logic ---

  if (!fatherDirData) return

  let deleteIndex: number | undefined
  if (fatherDirData.children === undefined) {
    throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
  }
  for (let index in fatherDirData.children) {
    if (fatherDirData.children[index]?.uuid === dirData.uuid) {
      deleteIndex = Number(index)
      continue
    }
    if (fatherDirData.children[index].order && dirData.order) {
      if (fatherDirData.children[index].order > dirData.order) {
        fatherDirData.children[index].order--
      }
    }
  }
  if (deleteIndex === undefined) {
    return
  }
  fatherDirData.children.splice(deleteIndex, 1)
  await libraryUtils.diffLibraryTreeExecuteFileOperation()
}
const contextmenuEvent = async (event: MouseEvent) => {
  let songListPath = libraryUtils.findDirPathByUuid(props.uuid)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    await confirm({
      title: t('common.error'),
      content: [t('library.notExistOnDisk')],
      confirmShow: false
    })
    deleteDir()
    return
  }
  rightClickMenuShow.value = true
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  rightClickMenuShow.value = false
  if (result !== 'cancel') {
    if (result.menuName == createPlaylistMenuKey || result.menuName == createSetPlaylistMenuKey) {
      dirChildRendered.value = true
      dirChildShow.value = true
      const newUuid = uuidV4()
      dirData.children = dirData.children || []
      dirData.children.unshift({
        uuid: newUuid,
        dirName: '',
        type: result.menuName == createSetPlaylistMenuKey ? 'setList' : 'songList'
      })
      // 不在此时标记“创建中”，等待命名确认开始写盘时再标记
    } else if (
      result.menuName == createStemMixtapeMenuKey ||
      result.menuName == createEqMixtapeMenuKey
    ) {
      dirChildRendered.value = true
      dirChildShow.value = true
      const newUuid = uuidV4()
      const mixMode = result.menuName == createEqMixtapeMenuKey ? 'eq' : 'stem'
      dirData.children = dirData.children || []
      dirData.children.unshift({
        uuid: newUuid,
        dirName: '',
        type: 'mixtapeList',
        mixMode,
        stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE
      })
      setPendingMixtapeProjectMode(newUuid, {
        mixMode,
        stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE
      })
    } else if (
      result.menuName == createFolderMenuKey ||
      result.menuName == createSetFolderMenuKey
    ) {
      dirChildRendered.value = true
      dirChildShow.value = true
      dirData.children = dirData.children || []
      dirData.children.unshift({
        uuid: uuidV4(),
        dirName: '',
        type: 'dir'
      })
    } else if (result.menuName == renameMenuKey) {
      renameDivShow.value = true
      renameDivValue.value = dirData.dirName
      await nextTick()
      myRenameInput.value?.focus()
    } else if (result.menuName === deleteMenuKey || result.menuName === deletePlaylistMenuKey) {
      deleteDir()
    }
  }
}

const dirChildShow = ref(false)
const dirChildRendered = ref(false)
const dirHandleClick = async () => {
  runtime.activeMenuUUID = ''
  let songListPath = libraryUtils.findDirPathByUuid(props.uuid)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    await confirm({
      title: t('common.error'),
      content: [t('library.notExistOnDisk')],
      confirmShow: false
    })
    deleteDir()
    return
  }
  if (isDialogListType(dirData)) {
    runtime.dialogSelectedSongListUUID = props.uuid
    emits('markTreeSelected')
  } else {
    dirChildRendered.value = true
    dirChildShow.value = !dirChildShow.value
  }
}
const emits = defineEmits(['dblClickSongList', 'markTreeSelected'])
const dirHandleDblClick = () => {
  if (isDialogListType(dirData)) {
    emits('dblClickSongList')
  }
}

const handleCollapseButtonClick = (libraryName: unknown) => {
  if (String(libraryName || '') == props.libraryName) {
    dirChildShow.value = false
  }
}
emitter.on('collapseButtonHandleClick', handleCollapseButtonClick)
//----重命名功能--------------------------------------
const renameDivShow = ref(false)
const renameDivValue = ref('')
const myRenameInput = useTemplateRef('myRenameInput')
const renameInputHintShow = ref(false)
const renameInputHintText = ref('')
const renameInputBlurHandle = async () => {
  if (
    renameInputHintShow.value ||
    renameDivValue.value == '' ||
    renameDivValue.value == dirData.dirName
  ) {
    renameDivValue.value = ''
    renameDivShow.value = false
    return
  }

  // --- Add missing updates for songsArea and playingData paths ---
  // If renaming the currently viewed songlist in songsArea (less likely in dialog, but for consistency)
  if (dirData.uuid === runtime.songsArea.songListUUID) {
    for (let item of runtime.songsArea.songInfoArr) {
      let arr = item.filePath.split(/[/\\]/)
      arr[arr.length - 2] = renameDivValue.value
      item.filePath = arr.join('\\')
    }
    for (let index in runtime.songsArea.selectedSongFilePath) {
      let arr = runtime.songsArea.selectedSongFilePath[index].split(/[/\\]/)
      arr[arr.length - 2] = renameDivValue.value
      runtime.songsArea.selectedSongFilePath[index] = arr.join('\\')
    }
  }
  // If renaming the currently playing songlist
  if (
    dirData.uuid === runtime.playingData.playingSongListUUID &&
    runtime.playingData.playingSong !== null
  ) {
    let arr = runtime.playingData.playingSong.filePath.split(/[/\\]/)
    arr[arr.length - 2] = renameDivValue.value
    runtime.playingData.playingSong.filePath = arr.join('\\')
    for (let item of runtime.playingData.playingSongListData) {
      let arr = item.filePath.split(/[/\\]/)
      arr[arr.length - 2] = renameDivValue.value
      item.filePath = arr.join('\\')
    }
  }
  // --- End added updates ---

  // Update name in memory first
  dirData.dirName = renameDivValue.value
  renameDivValue.value = ''
  renameDivShow.value = false

  await libraryUtils.diffLibraryTreeExecuteFileOperation()
}
const renameInputKeyDownEnter = () => {
  // Rely on renameInputHintShow which is now correctly updated
  if (renameInputHintShow.value || renameDivValue.value === '') {
    if (!renameInputHintShow.value) {
      renameInputHintText.value = t('library.nameRequired')
      renameInputHintShow.value = true
    }
    return
  }
  myRenameInput.value?.blur() // Proceed to blur if valid
}
const renameInputKeyDownEsc = () => {
  renameDivValue.value = '' // Clear value on Esc
  renameInputHintShow.value = false // Hide hint
  renameInputBlurHandle() // Trigger blur logic (which handles cleanup if needed)
}
const renameMyInputHandleInput = () => {
  const newName = renameDivValue.value
  const invalidCharsRegex = /[<>:"/\\|?*\u0000-\u001F]/
  let hintShouldShow = false
  let hintText = ''

  if (!fatherDirData) return // Keep existing null check

  if (newName === '') {
    hintText = t('library.nameRequired')
    hintShouldShow = true
  } else if (invalidCharsRegex.test(newName)) {
    hintText = t('library.nameInvalidChars')
    hintShouldShow = true
  } else {
    // Check if the new name exists AND it's not the original name of this item
    const exists = fatherDirData.children?.some(
      (obj) => obj.dirName === newName && obj.uuid !== props.uuid
    )
    if (exists) {
      hintText = t('library.nameAlreadyExists', { name: newName })
      hintShouldShow = true
    }
  }

  renameInputHintText.value = hintText
  renameInputHintShow.value = hintShouldShow
}

// 监听对话框重命名触发（无需先点击，直接对高亮项生效）
const handleDialogTriggerRename = async (targetUuid: unknown) => {
  try {
    if (targetUuid !== props.uuid) return
    if (!dirData?.dirName) return
    renameDivShow.value = true
    renameDivValue.value = dirData.dirName
    await nextTick()
    myRenameInput.value?.focus()
  } catch {}
}
emitter.on('dialog/trigger-rename', handleDialogTriggerRename)
//------------------------------------

const dragState = reactive<DragState>({
  dragApproach: ''
})

const dialogLibraryName = computed(() => String(props.libraryName || ''))
const isTreeReorderAllowed = computed(() => {
  void libraryTreeSortRuleVersion.value
  return isLibraryTreeManualSort(dialogLibraryName.value)
})
const canStartDialogItemDrag = computed(() => {
  return !!dirData?.dirName && !renameDivShow.value && isTreeReorderAllowed.value
})

const notifyAutoSortBlocksDrag = (clientX: number, clientY: number) => {
  if (isTreeReorderAllowed.value) return
  showNearMouseTip(clientX, clientY, t('playlist.sortAutoBlocksDrag'))
}

const dragstart = async (event: DragEvent) => {
  if (!isTreeReorderAllowed.value) {
    event.preventDefault()
    notifyAutoSortBlocksDrag(event.clientX, event.clientY)
    return
  }
  await handleDragStart(event, props.uuid)
  event.target?.addEventListener(
    'dragend',
    () => {
      runtime.dragItemData = null
    },
    { once: true }
  )
}

const dragover = (e: DragEvent) => {
  if (runtime.dragItemData && !isTreeReorderAllowed.value) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    dragState.dragApproach = ''
    return
  }
  handleDragOver(e, dirData, dragState)
}

const dragenter = (e: DragEvent) => {
  if (runtime.dragItemData && !isTreeReorderAllowed.value) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    dragState.dragApproach = ''
    return
  }
  handleDragEnter(e, dirData, dragState)
}

const dragleave = () => {
  handleDragLeave(dragState)
}

const drop = async (e: DragEvent) => {
  if (runtime.dragItemData && !isTreeReorderAllowed.value) {
    dragState.dragApproach = ''
    runtime.dragItemData = null
    return
  }
  await handleDrop(e, dirData, dragState, fatherDirData)
}

const indentWidth = ref(0)
let depth = libraryUtils.getDepthByUuid(props.uuid)
if (depth === undefined) {
  throw new Error(`depth error: ${JSON.stringify(depth)}`)
}
indentWidth.value = (depth - 2) * 10

// 歌单曲目数量（对话框）
const trackCount = ref<number | null>(null)
let fetchingCount = false
async function ensureTrackCount() {
  if (!runtime.setting.showPlaylistTrackCount) return
  if (fetchingCount) return
  if (dirData?.type !== 'songList') return
  // 未命名的临时歌单没有真实目录，避免把父目录当作歌单目录而统计成总数
  if (!dirData?.dirName) {
    trackCount.value = null
    return
  }
  try {
    fetchingCount = true
    const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
    const count = await window.electron.ipcRenderer.invoke('getSongListTrackCount', songListPath)
    trackCount.value = typeof count === 'number' ? count : 0
  } catch {
    trackCount.value = 0
  } finally {
    fetchingCount = false
  }
}

onMounted(() => {
  ensureTrackCount()
  // 当父组件要求抑制高亮（通常表示当前在“最近使用”区域高亮）时，避免树区自动滚动
  if (props.suppressHighlight) return
  if (runtime.dialogSelectedSongListUUID === props.uuid) {
    nextTick(() => {
      try {
        rowEl.value?.scrollIntoView?.({ block: 'nearest' })
      } catch {}
    })
  }
})

// 200ms 去抖 + 去重刷新（对话框）
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const pendingSet = new Set<string>()
const handlePlaylistContentChanged = (payload: unknown) => {
  try {
    const resolvedPayload =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as PlaylistContentChangedPayload)
        : {}
    const uuids: string[] = (resolvedPayload.uuids || []).filter(Boolean)
    for (const u of uuids) pendingSet.add(u)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (pendingSet.has(props.uuid)) {
        // 对话框里若当前即为打开/高亮的歌单，也可以不经 IPC。此处直接刷一次即可。
        ensureTrackCount()
      }
      pendingSet.clear()
    }, 200)
  } catch {}
}
emitter.on('playlistContentChanged', handlePlaylistContentChanged)

onUnmounted(() => {
  emitter.off('collapseButtonHandleClick', handleCollapseButtonClick)
  emitter.off('dialog/trigger-rename', handleDialogTriggerRename)
  emitter.off('playlistContentChanged', handlePlaylistContentChanged)
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  pendingSet.clear()
})

// --- 筛选：仅歌单名匹配 + 自动展开包含匹配歌单的文件夹（对话框树） ---
const keyword = computed(() =>
  String(props.filterText || '')
    .trim()
    .toLowerCase()
)
const matchesSelf = computed(() => {
  if (!keyword.value) return true
  return isDialogListType(dirData) && dirData?.dirName?.toLowerCase().includes(keyword.value)
})
function hasMatchingDescendant(node?: IDir | null): boolean {
  if (!keyword.value) return true
  if (!node?.children) return false
  for (const c of node.children) {
    if (isDialogListType(c) && c.dirName?.toLowerCase().includes(keyword.value)) return true
    if (c.type === 'dir' && hasMatchingDescendant(c)) return true
  }
  return false
}
const shouldShow = computed(() => {
  if (!keyword.value) return true
  return matchesSelf.value || hasMatchingDescendant(dirData)
})
watch(keyword, () => {
  if (!keyword.value) return
  if (dirData?.type === 'dir' && hasMatchingDescendant(dirData)) {
    dirChildRendered.value = true
    dirChildShow.value = true
  }
})

const displayedFolderChildren = computed(() => {
  const children = dirData?.children
  if (!children?.length) return []
  void libraryTreeSortRuleVersion.value
  void libraryTreeTrackCountVersion.value
  return sortLibraryTreeChildren(children, getLibraryTreeSortRule(String(props.libraryName || '')))
})

// 选中项变化时，若当前组件对应项被选中，使其滚动到可视区域内（对话框）
// 当 suppressHighlight 为 true（近期区高亮）时，不在树区触发自动滚动
watch(
  () => [runtime.dialogSelectedSongListUUID, props.suppressHighlight] as const,
  async ([newVal, suppress]) => {
    if (suppress) return
    if (newVal === props.uuid) {
      await nextTick()
      try {
        rowEl.value?.scrollIntoView?.({ block: 'nearest' })
      } catch {}
    }
  }
)
</script>
<template>
  <div
    v-show="shouldShow"
    ref="rowEl"
    class="mainBody"
    style="display: flex; box-sizing: border-box"
    :style="'padding-left:' + (props.needPaddingLeft ? indentWidth : 0) + 'px'"
    :draggable="canStartDialogItemDrag"
    :class="{
      rightClickBorder: rightClickMenuShow,
      borderTop: dragState.dragApproach == 'top',
      borderBottom: dragState.dragApproach == 'bottom',
      borderCenter: dragState.dragApproach == 'center',
      selectedDir: !props.suppressHighlight && props.uuid == runtime.dialogSelectedSongListUUID
    }"
    @contextmenu.stop="contextmenuEvent"
    @click.stop="dirHandleClick()"
    @dblclick="dirHandleDblClick()"
    @dragover.stop.prevent="dragover"
    @dragstart.stop="dragstart"
    @dragenter.stop.prevent="dragenter"
    @drop.stop="drop"
    @dragleave.stop="dragleave"
  >
    <div class="prefixIcon">
      <svg
        v-if="dirData.type == 'dir'"
        v-show="!dirChildShow"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          clip-rule="evenodd"
          d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z"
        />
      </svg>
      <svg
        v-if="dirData.type == 'dir'"
        v-show="dirChildShow"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          clip-rule="evenodd"
          d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"
        />
      </svg>
      <img
        v-if="isDialogListType(dirData) && runtime.creatingSongListUUID !== props.uuid"
        style="width: 13px; height: 13px"
        :src="listIcon"
        class="songlist-icon"
      />
      <div
        v-if="isDialogListType(dirData) && runtime.creatingSongListUUID === props.uuid"
        class="loading"
      ></div>
    </div>
    <div style="height: 23px; width: calc(100% - 20px)">
      <div v-if="dirData.dirName && !renameDivShow" class="nameRow">
        <span
          ref="nameTextRef"
          class="nameText"
          @mouseenter="isDialogListType(dirData) && (nameTextHovered = true)"
          @mouseleave="nameTextHovered = false"
          >{{ dirData.dirName }}</span
        >
        <bubbleBox
          v-if="isDialogListType(dirData) && nameTextHovered && dirData.dirName"
          :dom="nameTextRef || undefined"
          :title="dirData.dirName"
          :only-when-overflow="onlyShowBubbleWhenOverflow"
        />
        <span v-if="dirData.type === 'mixtapeList'" class="mixtapeBadgeGroup">
          <bubbleBoxTrigger
            tag="span"
            class="mixModeBadge"
            :class="{
              'is-eq': dirData.mixMode === 'eq',
              'is-stem': dirData.mixMode !== 'eq'
            }"
            :title="resolveMixtapeBadgeTitle(dirData.mixMode)"
          >
            <span>{{ resolveMixtapeModeTag(dirData.mixMode) }}</span>
          </bubbleBoxTrigger>
        </span>
        <bubbleBoxTrigger
          v-if="
            dirData.type === 'songList' &&
            runtime.setting.showPlaylistTrackCount &&
            trackCount !== null
          "
          tag="span"
          class="countBadge"
          :title="t('tracks.title')"
        >
          {{ trackCount }}
        </bubbleBoxTrigger>
      </div>
      <div v-if="!dirData.dirName">
        <input
          ref="myInput"
          v-model="operationInputValue"
          class="myInput"
          :class="{ myInputRedBorder: inputHintShow }"
          @blur="inputBlurHandle"
          @keydown.enter="inputKeyDownEnter"
          @keydown.esc="inputKeyDownEsc"
          @click.stop="() => {}"
          @contextmenu.stop="() => {}"
          @input="myInputHandleInput"
        />
        <div v-show="inputHintShow" class="myInputHint">
          <div>{{ inputHintText }}</div>
        </div>
      </div>
      <div v-if="renameDivShow">
        <input
          ref="myRenameInput"
          v-model="renameDivValue"
          class="myInput"
          :class="{ myInputRedBorder: renameInputHintShow }"
          @blur="renameInputBlurHandle"
          @keydown.enter="renameInputKeyDownEnter"
          @keydown.esc="renameInputKeyDownEsc"
          @click.stop="() => {}"
          @contextmenu.stop="() => {}"
          @input="renameMyInputHandleInput"
        />
        <div v-show="renameInputHintShow" class="myInputHint">
          <div>{{ renameInputHintText }}</div>
        </div>
      </div>
    </div>
  </div>
  <div
    v-if="dirData.type == 'dir' && dirChildRendered"
    v-show="dirChildShow"
    style="width: 100%; box-sizing: border-box"
  >
    <template v-for="item of displayedFolderChildren" :key="item.uuid">
      <dialogLibraryItem
        :uuid="item.uuid"
        :library-name="props.libraryName"
        :filter-text="props.filterText"
        :suppress-highlight="props.suppressHighlight"
        @mark-tree-selected="emits('markTreeSelected')"
        @dbl-click-song-list="emits('dblClickSongList')"
      />
    </template>
  </div>
</template>
<style lang="scss" scoped>
.nameRow {
  line-height: 23px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 8px;
  position: relative;
}

.nameText {
  flex: 1 1 auto;
  min-width: 0;
  padding-right: 72px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mixtapeBadgeGroup {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
}

.mixModeBadge {
  width: 50px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-sizing: border-box;
}

.mixModeBadge.is-eq {
  background-color: rgba(255, 184, 77, 0.18);
  color: #d98300;
}

.mixModeBadge.is-stem {
  background-color: rgba(91, 173, 255, 0.18);
  color: #2f85d8;
}

.countBadge {
  min-width: 18px;
  height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
  background-color: var(--hover);
  color: var(--text-weak);
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
}
.selectedDir {
  background-color: var(--hover);

  &:hover {
    background-color: var(--hover) !important;
  }
}

.mainBody {
  &:hover {
    background-color: var(--hover);
  }
}

.borderTop {
  box-shadow: inset 0 1px 0 0 var(--accent);
}

.borderBottom {
  box-shadow: inset 0 -1px 0 0 var(--accent);
}

.borderCenter {
  box-shadow: inset 0 0 0 1px var(--accent);
}

.rightClickBorder {
  box-shadow: inset 0 0 0 1px var(--accent);
}

.myInput {
  width: calc(100% - 6px);
  height: 19px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
}

.myInputRedBorder {
  border: 1px solid #be1100;
}

.myInputHint {
  div {
    width: calc(100% - 7px);
    min-height: 25px;
    line-height: 25px;
    background-color: #5a1d1d;
    border-right: 1px solid #be1100;
    border-left: 1px solid #be1100;
    border-bottom: 1px solid #be1100;
    font-size: 12px;
    padding-left: 5px;
    position: relative;
    z-index: 2;
  }
}

.prefixIcon {
  color: var(--text);
  width: 20px;
  min-width: 20px;
  height: 23px;
  display: flex;
  justify-content: center;
  align-items: center;
}

.loading {
  width: 8px;
  height: 8px;
  border: 2px solid var(--text);
  border-top-color: transparent;
  border-radius: 100%;
  animation: circle infinite 0.75s linear;
}

@keyframes circle {
  0% {
    transform: rotate(0);
  }

  100% {
    transform: rotate(360deg);
  }
}
</style>
