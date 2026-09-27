<script setup lang="ts">
import {
  onMounted,
  onUnmounted,
  ref,
  watch,
  computed,
  ComputedRef,
  useTemplateRef,
  nextTick,
  type PropType,
  type ComponentPublicInstance
} from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import dialogLibraryItem from '@renderer/components/dialogLibraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import listIconAsset from '@renderer/assets/listIcon.svg?asset'
import utils from '../utils/utils'
import { t, toLibraryDisplayName } from '@renderer/utils/translate'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import emitter from '../utils/mitt'
import type { IDir } from 'src/types/globals'
import { handleLibraryAreaEmptySpaceDrop } from '../utils/dragUtils'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import {
  focusSearchInput,
  SEARCH_FOCUS_PRIORITY,
  useSearchFocusTarget
} from '@renderer/composables/useSearchFocus'
import { useLibraryTreeSortUi } from '@renderer/composables/useLibraryTreeSortUi'
import {
  isLibraryTreeManualSort,
  libraryTreeTrackCountVersion
} from '@renderer/utils/libraryTreeSort'
import {
  chooseMixtapeProjectModeForCreate,
  persistMixtapeProjectMode,
  setPendingMixtapeProjectMode
} from '@renderer/composables/mixtape/stemMode'
import {
  buildVisibleCombinedNavList,
  collectDialogSongLists,
  filterSongListsByKeyword,
  isDialogListNode,
  loadRecentDialogSelectedSongListUUIDs,
  persistRecentDialogSelectedSongListUUIDs,
  resolveDialogNavIndexByUUID,
  resolveDialogNavMove,
  type DialogNavItem
} from '@renderer/components/selectSongListDialogNav'
import {
  resolveLibraryTransferActionLabelKey,
  type LibraryTransferActionMode,
  type LibraryTransferTarget
} from '@renderer/utils/libraryTransfer'
const uuid = uuidV4()
const props = defineProps({
  libraryName: {
    type: String,
    default: 'FilterLibrary'
  },
  actionMode: {
    type: String as PropType<LibraryTransferActionMode>,
    default: 'move'
  }
})
const isMixtapeDialog = computed(() => props.libraryName === 'MixtapeLibrary')
const isSetDialog = computed(() => props.libraryName === 'SetLibrary')
const isDialogListType = (node?: IDir | null) => isDialogListNode(node, props.libraryName)

const runtime = useRuntimeStore()
runtime.activeMenuUUID = ''
runtime.selectSongListDialogShow = true
// 选择区域，提前声明，便于初始化时设为 recent
const selectedArea = ref<'recent' | 'tree' | ''>('')
// 歌单筛选关键词（仅匹配歌单名）
const playlistSearch = ref('')
let recentDialogSelectedSongListUUID = loadRecentDialogSelectedSongListUUIDs(
  props.libraryName,
  runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
)
let index = 0
if (recentDialogSelectedSongListUUID.length !== 0) {
  runtime.dialogSelectedSongListUUID = recentDialogSelectedSongListUUID[index]
  selectedArea.value = 'recent'
}

const recentSongListArr = ref<IDir[]>([])
// 最近使用歌单的曲目数量缓存
const recentCounts = ref<Record<string, number>>({})
type PreventableEvent = {
  preventDefault?: () => void
}
let delRecentDialogSelectedSongListUUID: string[] = []
watch(
  () => runtime.libraryTree,
  () => {
    recentSongListArr.value = []
    delRecentDialogSelectedSongListUUID = []
    for (let uuid of recentDialogSelectedSongListUUID) {
      let obj = libraryUtils.getLibraryTreeByUUID(uuid)
      if (obj === null) {
        delRecentDialogSelectedSongListUUID.push(uuid)
      }
      if (obj) {
        recentSongListArr.value.push(obj)
        // 异步刷新数量
        if (runtime.setting.showPlaylistTrackCount && obj.type === 'songList') {
          const path = libraryUtils.findDirPathByUuid(obj.uuid)
          window.electron.ipcRenderer
            .invoke('getSongListTrackCount', path)
            .then((n: number) => (recentCounts.value[obj.uuid] = n || 0))
            .catch(() => (recentCounts.value[obj.uuid] = 0))
        }
      }
    }
    if (delRecentDialogSelectedSongListUUID.length !== 0) {
      recentDialogSelectedSongListUUID = recentDialogSelectedSongListUUID.filter(
        (item) => delRecentDialogSelectedSongListUUID.indexOf(item) === -1
      )
      persistRecentDialogSelectedSongListUUIDs(props.libraryName, recentDialogSelectedSongListUUID)
    }
  },
  { deep: true, immediate: true }
)

const libraryData: ComputedRef<IDir> = computed(() => {
  let filtrateLibraryUUID: string | undefined
  if (runtime.libraryTree && runtime.libraryTree.children) {
    filtrateLibraryUUID = runtime.libraryTree.children.find(
      (element) => element.type === 'library' && element.dirName === props.libraryName
    )?.uuid
  }
  if (filtrateLibraryUUID === undefined) {
    throw new Error(`filtrateLibraryUUID error for libraryName ${props.libraryName}`)
  }
  let data = libraryUtils.getLibraryTreeByUUID(filtrateLibraryUUID)
  if (data === null) {
    throw new Error(`libraryData error: could not find library with UUID ${filtrateLibraryUUID}`)
  }
  return data
})
const {
  currentSortRule,
  isManualSort,
  showSortButton,
  sortButtonBubbleTitle,
  sortIconMaskStyle,
  displayedChildren,
  isAwaitingTrackCounts,
  openSortMenu
} = useLibraryTreeSortUi({
  libraryName: () => props.libraryName,
  libraryRoot: libraryData
})
const dialogTreeVersion = ref(0)
watch(
  () => runtime.libraryTree,
  () => {
    dialogTreeVersion.value++
  },
  { deep: false }
)

// 扁平化当前库下的全部歌单（不关心折叠状态）
const allSongListArr = computed<IDir[]>(() => {
  void libraryTreeTrackCountVersion.value
  return collectDialogSongLists(libraryData.value, props.libraryName, currentSortRule.value)
})

// 组合“最近使用歌单”+“全部歌单”（保留重复项，便于在两个区域都可停留）
const visibleCombinedNavList = computed<DialogNavItem[]>(() =>
  buildVisibleCombinedNavList(
    recentSongListArr.value,
    allSongListArr.value,
    String(playlistSearch.value || '')
  )
)

// 当前选择所在区域，用于避免重复高亮（已提前声明）

// 当前在组合列表中的索引
const navIndex = ref<number>(-1)
const syncNavIndexByUUID = () => {
  const list = visibleCombinedNavList.value || []
  navIndex.value = resolveDialogNavIndexByUUID(
    list,
    runtime.dialogSelectedSongListUUID,
    selectedArea.value
  )
}

// 统一的上下移动处理，供热键与输入框箭头键共用
const moveSelection = (direction: 1 | -1) => {
  const list = visibleCombinedNavList.value || []
  if (list.length === 0) return
  navIndex.value = resolveDialogNavMove(navIndex.value, direction, list.length)
  const target = list[navIndex.value]
  selectedArea.value = target.area
  runtime.dialogSelectedSongListUUID = target.uuid
}
const handleMoveDown = (e?: PreventableEvent | null) => {
  try {
    e?.preventDefault?.()
  } catch {}
  moveSelection(1)
}
const handleMoveUp = (e?: PreventableEvent | null) => {
  try {
    e?.preventDefault?.()
  } catch {}
  moveSelection(-1)
}
const resolveTemplateElement = (
  value: Element | ComponentPublicInstance | null
): HTMLElement | null => {
  if (value instanceof HTMLElement) return value
  if (!value || typeof value !== 'object' || !('$el' in value)) return null
  return value.$el instanceof HTMLElement ? value.$el : null
}

watch(
  () => [
    visibleCombinedNavList.value.length,
    runtime.dialogSelectedSongListUUID,
    selectedArea.value
  ],
  () => {
    syncNavIndexByUUID()
  },
  { immediate: true }
)

// 当没有“最近使用”时，初始高亮定位到“全部歌单”的第一个
watch(
  () => allSongListArr.value.length,
  (len) => {
    if (len > 0 && runtime.dialogSelectedSongListUUID === '') {
      runtime.dialogSelectedSongListUUID = allSongListArr.value[0].uuid
      selectedArea.value = 'tree'
      syncNavIndexByUUID()
    }
  },
  { immediate: true }
)

// libraryData 已提前定义

const collapseButtonRef = useTemplateRef<HTMLDivElement>('collapseButtonRef')
const sortButtonRef = useTemplateRef<HTMLDivElement>('sortButtonRef')
const searchInputRef = useTemplateRef<HTMLInputElement>('searchInputRef')
useSearchFocusTarget({
  getInput: () => searchInputRef.value,
  scope: uuid,
  priority: SEARCH_FOCUS_PRIORITY.dialog
})

const libraryTitleText = computed(() => toLibraryDisplayName(libraryData.value.dirName))
const dialogTitleText = computed(() => {
  if (
    props.libraryName !== 'FilterLibrary' &&
    props.libraryName !== 'CuratedLibrary' &&
    props.libraryName !== 'SetLibrary' &&
    props.libraryName !== 'MixtapeLibrary'
  ) {
    return libraryTitleText.value
  }
  return t(
    resolveLibraryTransferActionLabelKey(
      props.libraryName as LibraryTransferTarget,
      props.actionMode
    )
  )
})
const confirmActionText = computed(() => {
  if (props.libraryName === 'MixtapeLibrary' || props.libraryName === 'SetLibrary') {
    return t('common.confirm')
  }
  return props.actionMode === 'copy' ? t('common.copy') : t('common.move')
})
const listIcon = listIconAsset
const resolveMixtapeModeTag = (mixMode?: string) =>
  mixMode === 'eq' ? t('mixtape.mixModeEqTag') : t('mixtape.mixModeStemTag')
const resolveMixtapeModeLabel = (mixMode?: string) =>
  mixMode === 'eq' ? t('mixtape.mixModeEqLabel') : t('mixtape.mixModeStemLabel')
const resolveMixtapeBadgeTitle = (mixMode?: string) => resolveMixtapeModeLabel(mixMode)

const buildMenuItems = () => {
  if (isMixtapeDialog.value) {
    return [
      { menuName: 'library.createStemMixtape' },
      { menuName: 'library.createEqMixtape' },
      { menuName: 'library.createFolder' }
    ]
  }
  if (isSetDialog.value) {
    return [{ menuName: 'library.createSetPlaylist' }, { menuName: 'library.createSetFolder' }]
  }
  return [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]
}
const menuArr = ref([buildMenuItems()])
const contextmenuEvent = async (event: MouseEvent) => {
  if (!libraryData.value) return
  menuArr.value = [buildMenuItems()]
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  if (result !== 'cancel') {
    if (
      result.menuName == 'library.createPlaylist' ||
      result.menuName == 'library.createSetPlaylist'
    ) {
      const newUuid = uuidV4()
      libraryData.value.children = libraryData.value.children || []
      libraryData.value.children.unshift({
        uuid: newUuid,
        type: result.menuName == 'library.createSetPlaylist' ? 'setList' : 'songList',
        dirName: ''
      })
      // 新建后在对话框中仅定位高亮，不触发双击
      runtime.dialogSelectedSongListUUID = newUuid
      selectedArea.value = 'tree'
    } else if (
      result.menuName == 'library.createStemMixtape' ||
      result.menuName == 'library.createEqMixtape'
    ) {
      const projectMode =
        result.menuName == 'library.createEqMixtape'
          ? { mixMode: 'eq' as const, stemProfile: 'quality' as const }
          : { mixMode: 'stem' as const, stemProfile: 'quality' as const }
      const newUuid = uuidV4()
      libraryData.value.children = libraryData.value.children || []
      libraryData.value.children.unshift({
        uuid: newUuid,
        type: 'mixtapeList',
        dirName: '',
        mixMode: projectMode.mixMode,
        stemProfile: projectMode.stemProfile
      })
      setPendingMixtapeProjectMode(newUuid, projectMode)
      runtime.dialogSelectedSongListUUID = newUuid
      selectedArea.value = 'tree'
    } else if (result.menuName == 'library.createFolder') {
      libraryData.value.children = libraryData.value.children || []
      libraryData.value.children.unshift({
        uuid: uuidV4(),
        type: 'dir',
        dirName: ''
      })
    }
  }
}

const collapseButtonHandleClick = async () => {
  if (!libraryData.value) return
  emitter.emit('collapseButtonHandleClick', libraryData.value.dirName + 'Dialog')
}

// 是否显示“立即创建”按钮：当存在关键字，且当前库内没有一个歌单名称与之完全匹配时显示
const exactMatchExists = computed(() => {
  const keyword = String(playlistSearch.value || '')
    .trim()
    .toLowerCase()
  if (!keyword) return true
  return allSongListArr.value.some((x) => (x.dirName || '').toLowerCase() === keyword)
})
const showCreateNow = computed(() => {
  const keyword = String(playlistSearch.value || '').trim()
  return !!keyword && !exactMatchExists.value
})
const searchKeyword = computed(() =>
  String(playlistSearch.value || '')
    .trim()
    .toLowerCase()
)
// 最近使用只按选择时间排，不跟全部歌单的名称/数量规则
const filteredRecentSongListArr = computed(() => {
  const base = recentSongListArr.value.filter((item) => isDialogListType(item))
  return filterSongListsByKeyword(base, searchKeyword.value)
})
const filteredAllSongListArr = computed(() => {
  return filterSongListsByKeyword(allSongListArr.value, searchKeyword.value)
})
const filteredSongListUuids = computed(() => {
  if (!searchKeyword.value) return allSongListArr.value.map((item) => item.uuid)
  return filteredAllSongListArr.value.map((item) => item.uuid)
})

// 立即以关键字作为名称在根层级创建歌单，并置顶；在对话框中仅高亮不触发确认
const createNow = async () => {
  if (!libraryData.value) return
  const name = String(playlistSearch.value || '').trim()
  if (!name) return
  const projectMode = isMixtapeDialog.value ? await chooseMixtapeProjectModeForCreate() : null
  if (isMixtapeDialog.value && !projectMode) {
    return
  }
  const newUuid = uuidV4()
  // 先提升已有 order，再插入新项到首位
  for (let item of libraryData.value.children || []) {
    if (item.order) item.order++
  }
  libraryData.value.children = libraryData.value.children || []
  libraryData.value.children.unshift({
    uuid: newUuid,
    type: isMixtapeDialog.value ? 'mixtapeList' : isSetDialog.value ? 'setList' : 'songList',
    dirName: name,
    mixMode: isMixtapeDialog.value ? projectMode?.mixMode || 'stem' : undefined,
    stemProfile: isMixtapeDialog.value ? projectMode?.stemProfile || 'quality' : undefined,
    order: 1,
    children: []
  } as IDir)
  try {
    const success = await libraryUtils.diffLibraryTreeExecuteFileOperation()
    if (success && projectMode) {
      await persistMixtapeProjectMode(newUuid, projectMode)
    }
  } catch {}
  // 在选择对话框内：高亮但不触发双击确认
  runtime.dialogSelectedSongListUUID = newUuid
  selectedArea.value = 'tree'
  // 创建完成后清空搜索
  playlistSearch.value = ''
}

const dragApproach = ref('')
const dragover = (e: DragEvent) => {
  if (!isLibraryTreeManualSort(props.libraryName)) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    dragApproach.value = ''
    return
  }
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  e.dataTransfer.dropEffect = 'move'
  dragApproach.value = 'top'
}
const dragenter = (e: DragEvent) => {
  if (!isLibraryTreeManualSort(props.libraryName)) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    dragApproach.value = ''
    return
  }
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  e.dataTransfer.dropEffect = 'move'
  dragApproach.value = 'top'
}
const dragleave = () => {
  if (runtime.dragItemData === null) {
    return
  }
  dragApproach.value = ''
}
const drop = async () => {
  if (!isLibraryTreeManualSort(props.libraryName)) {
    runtime.dragItemData = null
    return
  }
  if (runtime.dragItemData === null || !libraryData.value) {
    return
  }
  dragApproach.value = ''
  try {
    await handleLibraryAreaEmptySpaceDrop(runtime.dragItemData, libraryData.value)
  } catch (error) {
    console.error('Drop operation failed:', error)
  } finally {
    runtime.dragItemData = null
  }
}
onMounted(() => {
  hotkeys('s', uuid, () => {
    handleMoveDown()
  })
  hotkeys('w', uuid, () => {
    handleMoveUp()
  })
  // 兼容上下方向键
  hotkeys('down', uuid, (e) => {
    handleMoveDown(e)
  })
  hotkeys('up', uuid, (e) => {
    handleMoveUp(e)
  })
  // 在对话框内统一使用 F2 触发重命名，避免与 Enter 确认冲突
  hotkeys('f2', uuid, (e) => {
    try {
      e.preventDefault()
      const target = runtime.dialogSelectedSongListUUID
      if (target) emitter.emit('dialog/trigger-rename', target)
      return false
    } catch {}
  })
  hotkeys('E,Enter', uuid, () => {
    confirmHandle()
  })
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
  void nextTick(() => focusSearchInput(searchInputRef.value))
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  runtime.dialogSelectedSongListUUID = ''
  runtime.selectSongListDialogShow = false
})

const flashArea = ref('')
const flashBorder = (flashAreaName: string) => {
  flashArea.value = flashAreaName
  let count = 0
  const interval = setInterval(() => {
    count++
    if (count >= 3) {
      clearInterval(interval)
      flashArea.value = ''
    }
  }, 500)
}
const { dialogVisible, closeWithAnimation } = useDialogTransition()

const confirmHandle = () => {
  const selectedUuid = runtime.dialogSelectedSongListUUID
  const selectionVisible =
    !searchKeyword.value || filteredSongListUuids.value.includes(selectedUuid)
  if (
    !selectedUuid ||
    !selectionVisible ||
    libraryUtils.getLibraryTreeByUUID(selectedUuid) === null
  ) {
    if (!flashArea.value) {
      flashBorder('selectSongList')
    }
  } else {
    if (recentDialogSelectedSongListUUID.indexOf(selectedUuid) === -1) {
      recentDialogSelectedSongListUUID.unshift(selectedUuid)
      const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
      while (recentDialogSelectedSongListUUID.length > maxCount) {
        recentDialogSelectedSongListUUID.pop()
      }
    } else {
      recentDialogSelectedSongListUUID.unshift(
        recentDialogSelectedSongListUUID.splice(
          recentDialogSelectedSongListUUID.indexOf(selectedUuid),
          1
        )[0]
      )
      const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
      while (recentDialogSelectedSongListUUID.length > maxCount) {
        recentDialogSelectedSongListUUID.pop()
      }
    }
    persistRecentDialogSelectedSongListUUIDs(props.libraryName, recentDialogSelectedSongListUUID)
    closeWithAnimation(() => emits('confirm', selectedUuid))
  }
}
const emits = defineEmits(['cancel', 'confirm'])
const cancel = () => {
  closeWithAnimation(() => emits('cancel'))
}
const handleSearchEnter = () => {
  if (!searchKeyword.value) {
    confirmHandle()
    return
  }
  const firstRecent = filteredRecentSongListArr.value[0]
  const firstAll = filteredAllSongListArr.value[0]
  if (!firstRecent && !firstAll) {
    createNow()
    searchInputRef.value?.blur()
    return
  }
  if (firstRecent) {
    runtime.dialogSelectedSongListUUID = firstRecent.uuid
    selectedArea.value = 'recent'
  } else if (firstAll) {
    runtime.dialogSelectedSongListUUID = firstAll.uuid
    selectedArea.value = 'tree'
  }
  syncNavIndexByUUID()
  searchInputRef.value?.blur()
}

// 依据选择的 UUID 判定当前高亮区域（用户通过鼠标点击树或最近区时生效）
watch(
  () => runtime.dialogSelectedSongListUUID,
  (val) => {
    if (!val) {
      selectedArea.value = ''
      navIndex.value = -1
      return
    }
    const inRecent = recentSongListArr.value.some((x) => x.uuid === val)
    const inTree = allSongListArr.value.some((x) => x.uuid === val)
    if (inRecent && inTree) {
      // 两边都有时，保留当前区域；若无区域则默认 recent
      if (!selectedArea.value) selectedArea.value = 'recent'
    } else if (inRecent) {
      selectedArea.value = 'recent'
    } else if (inTree) {
      selectedArea.value = 'tree'
    } else {
      selectedArea.value = ''
    }
    syncNavIndexByUUID()
  }
)

// --- 保持选中项可见：对“最近使用”区域进行滚动 ---
// 记录最近区每一行元素的引用
const recentRowRefs = new Map<string, HTMLElement>()
const setRecentRowRef = (uuid: string, el: Element | ComponentPublicInstance | null) => {
  const resolved = resolveTemplateElement(el)
  if (resolved) recentRowRefs.set(uuid, resolved)
  else recentRowRefs.delete(uuid)
}

// 当选中项或区域变化时，如果处于“recent”区域，滚动到可见
watch(
  [
    () => runtime.dialogSelectedSongListUUID,
    () => selectedArea.value,
    () => recentSongListArr.value.length
  ],
  async () => {
    if (selectedArea.value === 'recent' && runtime.dialogSelectedSongListUUID) {
      await nextTick()
      try {
        recentRowRefs
          .get(runtime.dialogSelectedSongListUUID)
          ?.scrollIntoView?.({ block: 'nearest' })
      } catch {}
    }
  },
  { immediate: true }
)
</script>
<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="content inner" @contextmenu.stop="contextmenuEvent">
      <div v-if="libraryData" class="unselectable libraryTitle dialog-title dialog-header">
        <div class="collapseButtonPlaceholder"></div>
        <span>{{ dialogTitleText }}</span>
        <div class="collapseButtonWrapper">
          <div style="display: flex; justify-content: center; align-items: center">
            <div
              ref="collapseButtonRef"
              class="collapseButton"
              data-dialog-drag-ignore="true"
              @click="collapseButtonHandleClick()"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                xmlns="http://www.w3.org/2000/svg"
                fill="currentColor"
              >
                <path d="M9 9H4v1h5V9z" />
                <path
                  fill-rule="evenodd"
                  clip-rule="evenodd"
                  d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"
                />
              </svg>
            </div>
            <bubbleBox
              :dom="collapseButtonRef || undefined"
              :title="t('playlist.collapsibleFolder')"
            />
          </div>
        </div>
      </div>
      <div class="dialog-body">
        <!-- 顶部筛选输入框 -->
        <div class="librarySearchWrapper">
          <div class="searchRow">
            <div class="searchInputWrapper">
              <input
                ref="searchInputRef"
                v-model="playlistSearch"
                class="searchInput"
                :placeholder="t('playlist.searchPlaylists')"
                @keydown.down.prevent="handleMoveDown"
                @keydown.up.prevent="handleMoveUp"
                @keydown.enter.prevent.stop="handleSearchEnter"
              />
              <div
                v-show="String(playlistSearch || '').length"
                class="clearBtn"
                @click="playlistSearch = ''"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  shape-rendering="geometricPrecision"
                >
                  <path
                    d="M3 3 L9 9 M9 3 L3 9"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    vector-effect="non-scaling-stroke"
                  />
                </svg>
              </div>
            </div>
            <div v-if="showCreateNow" class="createNowBtn" @click="createNow">
              {{ t('playlist.createNow') }}
            </div>
          </div>
        </div>
        <div
          v-if="libraryData?.children?.length"
          class="unselectable libraryArea flashing-border"
          :class="{ 'is-flashing': flashArea == 'selectSongList' }"
        >
          <OverlayScrollbarsComponent
            :options="{
              scrollbars: {
                autoHide: 'leave' as const,
                autoHideDelay: 50,
                clickScroll: true
              } as const,
              overflow: {
                x: 'hidden',
                y: 'scroll'
              } as const
            }"
            element="div"
            style="height: 100%; width: 100%"
            defer
          >
            <div class="sectionStack">
              <div v-if="recentSongListArr.length > 0" class="sectionCard sectionCard--recent">
                <div class="sectionHeader">
                  <div class="sectionTitle">
                    <span class="sectionAccent sectionAccent--recent"></span>
                    <span>{{ t('library.recentlyUsed') }}</span>
                  </div>
                </div>
                <div class="sectionBody">
                  <div
                    v-for="item of filteredRecentSongListArr"
                    :key="item.uuid"
                    :ref="(el) => setRecentRowRef(item.uuid, el)"
                    :class="{
                      selectedDir:
                        selectedArea === 'recent' && item.uuid == runtime.dialogSelectedSongListUUID
                    }"
                    class="recentLibraryItem"
                    @click="
                      ((runtime.dialogSelectedSongListUUID = item.uuid), (selectedArea = 'recent'))
                    "
                    @dblclick="confirmHandle()"
                  >
                    <div
                      style="
                        width: 20px;
                        justify-content: center;
                        align-items: center;
                        display: flex;
                      "
                    >
                      <img
                        class="songlist-icon"
                        style="width: 13px; height: 13px"
                        :src="listIcon"
                      />
                    </div>
                    <div class="nameRow">
                      <span class="nameText">{{ item.dirName }}</span>
                      <span v-if="item.type === 'mixtapeList'" class="mixtapeBadgeGroup">
                        <bubbleBoxTrigger
                          tag="span"
                          class="mixModeBadge"
                          :class="{
                            'is-eq': item.mixMode === 'eq',
                            'is-stem': item.mixMode !== 'eq'
                          }"
                          :title="resolveMixtapeBadgeTitle(item.mixMode)"
                        >
                          <span>{{ resolveMixtapeModeTag(item.mixMode) }}</span>
                        </bubbleBoxTrigger>
                      </span>
                      <span
                        v-if="runtime.setting.showPlaylistTrackCount && item.type === 'songList'"
                        class="countBadge"
                        >{{ recentCounts[item.uuid] ?? 0 }}</span
                      >
                    </div>
                  </div>
                </div>
              </div>
              <div class="sectionCard sectionCard--all">
                <div class="sectionHeader">
                  <div class="sectionTitle">
                    <span class="sectionAccent sectionAccent--all"></span>
                    <span>{{ t('library.allPlaylists') }}</span>
                  </div>
                  <div v-if="showSortButton" class="sectionHeaderActions">
                    <div
                      ref="sortButtonRef"
                      class="titleActionButton"
                      :class="{ isActive: !isManualSort }"
                      @click.stop="openSortMenu"
                    >
                      <span class="sortIcon" :style="sortIconMaskStyle"></span>
                    </div>
                    <bubbleBox :dom="sortButtonRef || undefined" :title="sortButtonBubbleTitle" />
                  </div>
                </div>
                <div class="sectionBody">
                  <div v-if="isAwaitingTrackCounts" class="trackCountSortLoading" role="status">
                    <span class="trackCountSortLoadingSpinner" aria-hidden="true"></span>
                    <span>{{ t('common.loading') }}</span>
                  </div>
                  <template v-else>
                    <template
                      v-for="item of displayedChildren"
                      :key="`${item.uuid}-${dialogTreeVersion}`"
                    >
                      <dialogLibraryItem
                        :uuid="item.uuid"
                        :library-name="props.libraryName"
                        :filter-text="playlistSearch"
                        :suppress-highlight="selectedArea === 'recent'"
                        @dbl-click-song-list="confirmHandle()"
                        @mark-tree-selected="selectedArea = 'tree'"
                      />
                    </template>
                    <div
                      class="libraryDropSpace"
                      :class="{ borderTop: dragApproach == 'top' }"
                      @dragover.stop.prevent="dragover"
                      @dragenter.stop.prevent="dragenter"
                      @drop.stop="drop"
                      @dragleave.stop="dragleave"
                    ></div>
                  </template>
                </div>
              </div>
            </div>
          </OverlayScrollbarsComponent>
        </div>
        <div
          v-else
          class="unselectable flashing-border"
          :class="{ 'is-flashing': flashArea == 'selectSongList' }"
          style="
            max-width: 300px;
            display: flex;
            justify-content: center;
            align-items: center;
            flex-grow: 1;
            min-height: 0;
          "
        >
          <span style="font-size: 12px; color: var(--text-weak)">{{
            t('library.rightClickToCreate')
          }}</span>
        </div>
      </div>

      <div class="dialog-footer footer-centered">
        <div class="button" style="width: 90px; text-align: center" @click="confirmHandle()">
          {{ confirmActionText }} (E)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="cancel()">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped src="./selectSongListDialog.scss"></style>
