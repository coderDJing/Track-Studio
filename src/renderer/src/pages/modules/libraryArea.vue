<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from 'vue'
import libraryItem from '@renderer/components/libraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import rightClickMenu from '../../components/rightClickMenu'
import { t, toLibraryDisplayName } from '@renderer/utils/translate'
import emitter from '../../utils/mitt'
import { handleLibraryAreaEmptySpaceDrop } from '@renderer/utils/dragUtils'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { DEFAULT_MIXTAPE_STEM_PROFILE } from '@shared/mixtapeStemProfiles'
import { useLibraryTreeSortUi } from '@renderer/composables/useLibraryTreeSortUi'
import { emptyRecycleBinWithOptimisticUpdate } from '@renderer/utils/recycleBinActions'
import {
  persistMixtapeProjectMode,
  setPendingMixtapeProjectMode
} from '@renderer/composables/mixtape/stemMode'
import { isLibraryTreeManualSort } from '@renderer/utils/libraryTreeSort'
import type { IDir } from 'src/types/globals'

const runtime = useRuntimeStore()
const props = defineProps({
  uuid: {
    type: String,
    required: true
  }
})
const libraryData = computed(() => {
  const data = libraryUtils.getLibraryTreeByUUID(props.uuid)
  if (data === null) {
    throw new Error(`libraryData error: ${JSON.stringify(data)}`)
  }
  return data
})

const libraryName = computed(() => libraryData.value.dirName)
const isRecycleBin = computed(() => runtime.libraryAreaSelected === 'RecycleBin')
const {
  isManualSort,
  showSortButton,
  sortButtonBubbleTitle,
  sortIconMaskStyle,
  displayedChildren,
  isAwaitingTrackCounts,
  openSortMenu
} = useLibraryTreeSortUi({
  libraryName,
  libraryRoot: libraryData,
  isActive: () => runtime.libraryAreaSelected === libraryName.value,
  forceManual: isRecycleBin,
  reverseChildren: isRecycleBin
})

const showHint = computed(() => {
  const children = libraryData.value.children
  const hasSpecialChild = children?.some((child) =>
    ['filterLibrarySonglistDemo1', 'curatedLibrarySonglistDemo1'].includes(child.uuid)
  )
  return !children?.length || (children?.length === 1 && hasSpecialChild)
})

// 将核心库名称映射为 i18n key，仅用于显示
const libraryTitleText = computed(() => toLibraryDisplayName(libraryData.value.dirName))

const emptyRecycleBinHandleClick = async () => {
  await emptyRecycleBinWithOptimisticUpdate(runtime)
}

let welcomeCreatedPlaylistTimer: ReturnType<typeof setTimeout> | null = null
const markWelcomeCreatedPlaylist = (uuid: string) => {
  runtime.welcomeCreatedPlaylistUUID = uuid
  emitter.emit('welcome:playlist-created', { uuid })
  if (welcomeCreatedPlaylistTimer) clearTimeout(welcomeCreatedPlaylistTimer)
  welcomeCreatedPlaylistTimer = setTimeout(() => {
    if (runtime.welcomeCreatedPlaylistUUID === uuid) {
      runtime.welcomeCreatedPlaylistUUID = ''
    }
    welcomeCreatedPlaylistTimer = null
  }, 680)
}

const handleWelcomeCreatePlaylist = (kind: unknown) => {
  if (runtime.libraryAreaSelected !== libraryName.value) return

  if (
    kind === 'songList' &&
    (libraryName.value === 'FilterLibrary' || libraryName.value === 'CuratedLibrary')
  ) {
    const newUuid = uuidV4()
    libraryData.value.children = libraryData.value.children || []
    libraryData.value.children.unshift({
      uuid: newUuid,
      type: 'songList',
      dirName: ''
    })
    markWelcomeCreatedPlaylist(newUuid)
    return
  }

  if (kind === 'setList' && libraryName.value === 'SetLibrary') {
    const newUuid = uuidV4()
    libraryData.value.children = libraryData.value.children || []
    libraryData.value.children.unshift({
      uuid: newUuid,
      type: 'setList',
      dirName: ''
    })
    markWelcomeCreatedPlaylist(newUuid)
    return
  }

  if (libraryName.value === 'MixtapeLibrary' && kind === 'stemMixtape') {
    markWelcomeCreatedPlaylist(createPendingMixtapeList('stem'))
  } else if (libraryName.value === 'MixtapeLibrary' && kind === 'eqMixtape') {
    markWelcomeCreatedPlaylist(createPendingMixtapeList('eq'))
  }
}

onMounted(() => {
  emitter.on('welcome:create-playlist', handleWelcomeCreatePlaylist)
})

onUnmounted(() => {
  emitter.off('welcome:create-playlist', handleWelcomeCreatePlaylist)
  if (welcomeCreatedPlaylistTimer) clearTimeout(welcomeCreatedPlaylistTimer)
})

// 歌单筛选关键词（仅匹配歌单名）
const playlistSearch = ref('')
// 扁平化当前库下的全部歌单（不关心折叠状态）
const allSongListArr = computed<IDir[]>(() => {
  const result: IDir[] = []
  const traverse = (node?: IDir) => {
    if (!node) return
    if (node.type === 'songList' || node.type === 'mixtapeList' || node.type === 'setList') {
      result.push(node)
    }
    if (node.children && node.children.length) {
      for (const child of node.children) traverse(child as IDir)
    }
  }
  traverse(libraryData.value as unknown as IDir)
  return result
})
const exactMatchExists = computed(() => {
  const keyword = String(playlistSearch.value || '')
    .trim()
    .toLowerCase()
  if (!keyword) return true
  return allSongListArr.value.some((x) => (x.dirName || '').toLowerCase() === keyword)
})
const directNameConflictExists = computed(() => {
  const keyword = String(playlistSearch.value || '')
    .trim()
    .toLowerCase()
  if (!keyword) return false
  const siblings = libraryData.value.children || []
  return siblings.some(
    (item) =>
      String(item?.dirName || '')
        .trim()
        .toLowerCase() === keyword
  )
})
const showCreateNow = computed(() => {
  const keyword = String(playlistSearch.value || '').trim()
  if (!keyword) return false
  // 回收站中不显示立即创建
  if (runtime.libraryAreaSelected === 'RecycleBin') return false
  return !exactMatchExists.value && !directNameConflictExists.value
})
const isMixtapeLibrary = computed(() => runtime.libraryAreaSelected === 'MixtapeLibrary')
const isSetLibrary = computed(() => runtime.libraryAreaSelected === 'SetLibrary')
const createPendingMixtapeList = (mixMode: 'stem' | 'eq') => {
  const newUuid = uuidV4()
  for (let item of libraryData.value.children || []) {
    if (item.order) item.order++
  }
  libraryData.value.children = libraryData.value.children || []
  libraryData.value.children.unshift({
    uuid: newUuid,
    type: 'mixtapeList',
    dirName: '',
    mixMode,
    stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE,
    order: 1,
    children: []
  } as IDir)
  setPendingMixtapeProjectMode(newUuid, {
    mixMode,
    stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE
  })
  return newUuid
}
const createNow = async () => {
  const name = String(playlistSearch.value || '').trim()
  if (!name) return
  const invalidCharsRegex = /[<>:"/\\|?*\u0000-\u001F]/
  if (invalidCharsRegex.test(name)) {
    await confirm({
      title: t('common.error'),
      content: [t('library.nameInvalidChars')],
      confirmShow: false
    })
    return
  }
  if (directNameConflictExists.value) {
    await confirm({
      title: t('common.error'),
      content: [t('library.nameAlreadyExists', { name })],
      confirmShow: false
    })
    return
  }
  const newUuid = uuidV4()
  for (let item of libraryData.value.children || []) {
    if (item.order) item.order++
  }
  libraryData.value.children = libraryData.value.children || []
  libraryData.value.children.unshift({
    uuid: newUuid,
    type: isMixtapeLibrary.value ? 'mixtapeList' : isSetLibrary.value ? 'setList' : 'songList',
    dirName: name,
    mixMode: isMixtapeLibrary.value ? 'stem' : undefined,
    stemProfile: isMixtapeLibrary.value ? DEFAULT_MIXTAPE_STEM_PROFILE : undefined,
    order: 1,
    children: []
  } as IDir)
  let success = false
  try {
    success = await libraryUtils.diffLibraryTreeExecuteFileOperation()
    if (success && isMixtapeLibrary.value) {
      await persistMixtapeProjectMode(newUuid, {
        mixMode: 'stem',
        stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE
      })
    }
  } catch {}
  // 创建完成后清空搜索
  playlistSearch.value = ''
}

const menuArr = ref([
  [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]
])
const contextmenuEvent = async (event: MouseEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    menuArr.value = [[{ menuName: 'recycleBin.emptyRecycleBin' }]]
  } else if (runtime.libraryAreaSelected === 'MixtapeLibrary') {
    menuArr.value = [
      [
        { menuName: 'library.createStemMixtape' },
        { menuName: 'library.createEqMixtape' },
        { menuName: 'library.createFolder' }
      ]
    ]
  } else if (runtime.libraryAreaSelected === 'SetLibrary') {
    menuArr.value = [
      [{ menuName: 'library.createSetPlaylist' }, { menuName: 'library.createSetFolder' }]
    ]
  } else {
    menuArr.value = [[{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]]
  }
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  if (result !== 'cancel') {
    if (result.menuName == 'library.createPlaylist') {
      const newUuid = uuidV4()
      libraryData.value.children = libraryData.value.children || []
      libraryData.value.children.unshift({
        uuid: newUuid,
        type: 'songList',
        dirName: ''
      })
      // 不在此时标记“创建中”，等待命名确认开始写盘时再标记
    } else if (result.menuName == 'library.createSetPlaylist') {
      const newUuid = uuidV4()
      libraryData.value.children = libraryData.value.children || []
      libraryData.value.children.unshift({
        uuid: newUuid,
        type: 'setList',
        dirName: ''
      })
    } else if (result.menuName == 'library.createSetFolder') {
      libraryData.value.children = libraryData.value.children || []
      libraryData.value.children.unshift({
        uuid: uuidV4(),
        type: 'dir',
        dirName: ''
      })
    } else if (result.menuName == 'library.createStemMixtape') {
      createPendingMixtapeList('stem')
    } else if (result.menuName == 'library.createEqMixtape') {
      createPendingMixtapeList('eq')
    } else if (result.menuName == 'library.createFolder') {
      libraryData.value.children = libraryData.value.children || []
      libraryData.value.children.unshift({
        uuid: uuidV4(),
        type: 'dir',
        dirName: ''
      })
    } else if (result.menuName == 'recycleBin.emptyRecycleBin') {
      await emptyRecycleBinHandleClick()
    }
  }
}

const collapseButtonHandleClick = async () => {
  emitter.emit('collapseButtonHandleClick', libraryData.value.dirName)
}

const sortButtonRef = useTemplateRef<HTMLDivElement>('sortButtonRef')
const collapseButtonRef = useTemplateRef<HTMLDivElement>('collapseButtonRef')

const dragApproach = ref('')
const dragover = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'none'
    }
    return
  }
  if (!isLibraryTreeManualSort(libraryName.value)) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    dragApproach.value = ''
    return
  }
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }
  e.dataTransfer.dropEffect = 'move'
  dragApproach.value = 'top'
}
const dragenter = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'none'
    }
    return
  }
  if (!isLibraryTreeManualSort(libraryName.value)) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    dragApproach.value = ''
    return
  }
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }
  e.dataTransfer.dropEffect = 'move'
  dragApproach.value = 'top'
}
const dragleave = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    return
  }
  if (runtime.dragItemData === null) {
    if (e.dataTransfer === null) {
      throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
    }
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }
  dragApproach.value = ''
}
const drop = async (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    runtime.dragItemData = null
    return
  }
  if (!isLibraryTreeManualSort(libraryName.value)) {
    runtime.dragItemData = null
    return
  }
  if (runtime.dragItemData === null) {
    if (e.dataTransfer === null) {
      throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
    }
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }

  dragApproach.value = ''

  try {
    // 使用 dragUtils 中的函数处理拖放到空白区域
    await handleLibraryAreaEmptySpaceDrop(runtime.dragItemData, libraryData.value)

    // 如果处理成功或失败，都清除拖拽数据
  } catch (error) {
    console.error('Drop operation failed:', error)
  } finally {
    runtime.dragItemData = null
  }
}

const handleContentClick = () => {
  runtime.focusArea = 'library'
  runtime.selectedPlaylistIds = []
  // 清空歌曲列表选中状态
  runtime.songsArea.selectedSongFilePath.length = 0
  if (runtime.songsAreaPanels.splitEnabled) {
    runtime.songsAreaPanels.panes.left.selectedSongFilePath.length = 0
    runtime.songsAreaPanels.panes.right.selectedSongFilePath.length = 0
  }
}
</script>
<template>
  <div class="content" @contextmenu.stop="contextmenuEvent" @click="handleContentClick">
    <div class="unselectable libraryTitle">
      <span>{{ libraryTitleText }}</span>
      <div class="libraryTitleActions">
        <div
          v-if="showSortButton"
          ref="sortButtonRef"
          class="titleActionButton"
          :class="{ isActive: !isManualSort }"
          @click.stop="openSortMenu"
        >
          <span class="sortIcon" :style="sortIconMaskStyle"></span>
        </div>
        <bubbleBox
          v-if="showSortButton"
          :dom="sortButtonRef || undefined"
          :title="sortButtonBubbleTitle"
        />
        <div ref="collapseButtonRef" class="titleActionButton" @click="collapseButtonHandleClick()">
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
        <bubbleBox :dom="collapseButtonRef || undefined" :title="t('playlist.collapsibleFolder')" />
      </div>
    </div>
    <!-- 顶部筛选输入框 -->
    <div class="librarySearchWrapper">
      <div class="searchRow">
        <div class="searchInputWrapper">
          <input
            v-model="playlistSearch"
            class="searchInput"
            :placeholder="t('playlist.searchPlaylists')"
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
    <div class="unselectable libraryArea">
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
        <div class="libraryTreeDropSurface">
          <div v-if="isAwaitingTrackCounts" class="trackCountSortLoading" role="status">
            <span class="trackCountSortLoadingSpinner" aria-hidden="true"></span>
            <span>{{ t('common.loading') }}</span>
          </div>
          <template v-for="item of displayedChildren" v-else :key="item.uuid">
            <libraryItem
              v-if="!(runtime.selectSongListDialogShow && !item.dirName)"
              :uuid="item.uuid"
              :library-name="libraryData.dirName"
              :filter-text="playlistSearch"
            />
          </template>
          <div
            class="libraryDropSpace"
            :class="{ borderTop: dragApproach == 'top' }"
            @dragover.stop.prevent="dragover"
            @dragenter.stop.prevent="dragenter"
            @drop.stop="drop"
            @dragleave.stop="dragleave"
          >
            <span
              v-show="showHint && runtime.layoutConfig.libraryAreaWidth !== 0"
              class="libraryStatusText"
            >
              {{
                runtime.libraryAreaSelected === 'RecycleBin'
                  ? t('recycleBin.noDeletionRecords')
                  : t('library.rightClickToCreate')
              }}
            </span>
          </div>
        </div>
      </OverlayScrollbarsComponent>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.borderTop {
  box-shadow: inset 0 1px 0 0 var(--accent);
}

.libraryTreeDropSurface {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.trackCountSortLoading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 8px;
  color: var(--text-weak);
  font-size: 12px;
}

.trackCountSortLoadingSpinner {
  width: 14px;
  height: 14px;
  box-sizing: border-box;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: trackCountSortLoadingSpin 0.75s linear infinite;
}

@keyframes trackCountSortLoadingSpin {
  to {
    transform: rotate(360deg);
  }
}

.libraryDropSpace {
  flex: 1 1 auto;
  min-height: 30px;
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  align-items: center;
}

.libraryStatusText {
  font-size: 12px;
  color: var(--text-weak);
  line-height: 1.4;
  text-align: center;
  padding: 0 8px;
}

.libraryArea {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
}

.content {
  height: 100%;
  width: 100%;
  display: flex;
  flex-grow: 1;
  min-height: 0;
  background-color: var(--bg);
  overflow: hidden;
  flex-direction: column;

  .libraryTitle {
    height: 35px;
    line-height: 35px;
    padding: 0 18px 0 20px;
    font-size: 12px;
    font-weight: bold;
    display: flex;
    justify-content: space-between;

    .libraryTitleActions {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 2px;
    }

    .titleActionButton {
      color: var(--text);
      width: 20px;
      height: 20px;
      display: flex;
      justify-content: center;
      align-items: center;
      border-radius: 5px;
      cursor: pointer;

      &:hover {
        background-color: var(--hover);
      }

      &.isActive {
        color: var(--accent);
      }

      .sortIcon {
        width: 16px;
        height: 16px;
        background-color: currentColor;
        mask-image: var(--sort-icon-mask);
        mask-repeat: no-repeat;
        mask-position: center;
        mask-size: contain;
        -webkit-mask-image: var(--sort-icon-mask);
        -webkit-mask-repeat: no-repeat;
        -webkit-mask-position: center;
        -webkit-mask-size: contain;
      }
    }
  }
}

.librarySearchWrapper {
  flex-shrink: 0;
  padding: 6px 5px 6px 5px;
  background-color: var(--bg);
}

.searchInput {
  width: 100%;
  height: 22px;
  line-height: 22px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  border-radius: 2px;
  padding: 0 8px;
  box-sizing: border-box;
  font-size: 12px;
  font-weight: normal;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

// 当鼠标悬停在输入框容器（包括清空按钮）时，也应用输入框的 hover 效果
.searchInputWrapper:hover .searchInput {
  background-color: var(--hover);
  border-color: var(--accent);
}

.searchRow {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
}

.searchRow .searchInput {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}

.searchInputWrapper {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}

.searchInputWrapper .searchInput {
  width: 100%;
  padding-right: 24px; // 为清空按钮预留空间
}

.clearBtn {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  cursor: pointer;
  z-index: 1;
}

.createNowBtn {
  height: 22px;
  line-height: 22px;
  padding: 0 8px;
  font-size: 12px;
  border-radius: 2px;
  border: 1px solid var(--border);
  box-sizing: border-box;
  background-color: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  flex-shrink: 0;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.bubbleBox {
  height: 22px;
  line-height: 22px;
  text-align: center;
  position: relative;
  border-radius: 3px;
  border: 1px solid var(--border);
  font-size: 12px;
  background-color: var(--bg-elev);
  padding: 0 10px;
  font-weight: normal;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter,
.fade-leave-to {
  opacity: 0;
}
</style>
