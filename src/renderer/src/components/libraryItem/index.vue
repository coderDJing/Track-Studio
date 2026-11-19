<script setup lang="ts">
import { ref, computed, watch, shallowRef, onUnmounted } from 'vue'
import libraryItem from '@renderer/components/libraryItem/index.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import listIconAsset from '@renderer/assets/listIcon.svg?asset'
import libraryUtils from '@renderer/utils/libraryUtils'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import emitter from '../../utils/mitt'
import { useDragSongs } from '@renderer/pages/modules/songsArea/composables/useDragSongs'
import {
  fetchAcoustIdClientKeyStatus,
  hasConfiguredAcoustIdClientKey
} from '@renderer/utils/acoustid'
import { useLibraryItemEditing } from './useLibraryItemEditing'
import { useLibraryContextMenu } from './useLibraryContextMenu'
import { useLibraryDragAndDrop } from './useLibraryDragAndDrop'
import { useLibraryTrackCount } from './useLibraryTrackCount'
import { useLibraryFilter } from './useLibraryFilter'
import { resolveActivePlaybackSongListUUIDs } from '@renderer/utils/playbackSongListSources'
import {
  activateSongsAreaPane,
  replaceSongsAreaPaneSongList,
  resolveSongsAreaPaneForLibraryClick
} from '@renderer/utils/songsAreaSplit'
import { createTouchLongPressDrag } from '@renderer/utils/touchLongPressDrag'
import {
  getLibraryTreeSortRule,
  isLibraryTreeManualSort,
  libraryTreeSortRuleVersion,
  libraryTreeTrackCountVersion,
  sortLibraryTreeChildren
} from '@renderer/utils/libraryTreeSort'
import { showNearMouseTip } from '@renderer/utils/nearMouseTip'
import type { IDir } from '../../../../types/globals'
import { isNeteaseVirtualUuid } from '@shared/netease'
const listIcon = listIconAsset
const listIconMaskStyle = {
  '--icon-mask': `url("${listIcon}")`
}
const props = defineProps({
  uuid: {
    type: String,
    required: true
  },
  libraryName: {
    type: String,
    required: true
  },
  // 歌单筛选关键词（仅匹配歌单名）
  filterText: {
    type: [String, Object],
    default: ''
  }
})
const runtime = useRuntimeStore()
const touchPlaylistDrag = createTouchLongPressDrag()
const hasWarnedAcoustId = ref(false)
const hasAcoustIdKey = async () => {
  if (hasConfiguredAcoustIdClientKey(runtime.setting)) return true
  const status = await fetchAcoustIdClientKeyStatus()
  return status.hasEffectiveKey
}
const warnAcoustIdMissing = () => {
  if (hasWarnedAcoustId.value) return
  void (async () => {
    if (await hasAcoustIdKey()) return
    hasWarnedAcoustId.value = true
    void confirm({
      title: t('metadata.autoFillFingerprintHintTitle'),
      content: [
        t('metadata.autoFillFingerprintHintMissing'),
        t('metadata.autoFillFingerprintHintGuide')
      ],
      confirmShow: false
    })
  })()
}
const { handleDropToSongList } = useDragSongs()

const dirDataRef = shallowRef<IDir | null>(null)
const fatherDirDataRef = shallowRef<IDir | null>(null)

const syncNodeRefs = () => {
  dirDataRef.value = libraryUtils.getLibraryTreeByUUID(props.uuid)
  fatherDirDataRef.value = libraryUtils.getFatherLibraryTreeByUUID(props.uuid)
}
syncNodeRefs()

watch(
  () => props.uuid,
  () => {
    syncNodeRefs()
  }
)
watch(
  () => runtime.libraryTree,
  () => {
    syncNodeRefs()
  },
  // 不 deep：整树很深。网易云同步/删除后必须换掉 libraryTree 根引用，这里才会刷新。
  { deep: false }
)

const dirData = computed(() => dirDataRef.value)

const isSongList = computed(() => dirData.value?.type === 'songList')
const isMixtapeList = computed(() => dirData.value?.type === 'mixtapeList')
const isSetList = computed(() => dirData.value?.type === 'setList')
const isPlaylist = computed(() => isSongList.value || isMixtapeList.value || isSetList.value)
const resolveMixtapeModeTag = (mixMode?: string) =>
  mixMode === 'eq' ? t('mixtape.mixModeEqTag') : t('mixtape.mixModeStemTag')
const resolveMixtapeModeLabel = (mixMode?: string) =>
  mixMode === 'eq' ? t('mixtape.mixModeEqLabel') : t('mixtape.mixModeStemLabel')
const resolveMixtapeBadgeTitle = (mixMode?: string) => resolveMixtapeModeLabel(mixMode)

const {
  operationInputValue,
  inputHintText,
  inputHintShow,
  myInput,
  myInputHandleInput,
  inputKeyDownEnter,
  inputKeyDownEsc,
  inputBlurHandle,
  renameDivShow,
  renameDivValue,
  myRenameInput,
  renameInputHintShow,
  renameInputHintText,
  renameInputBlurHandle,
  renameInputKeyDownEnter,
  renameInputKeyDownEsc,
  renameMyInputHandleInput,
  startRename
} = useLibraryItemEditing({ dirDataRef, fatherDirDataRef, runtime, props, emitter })

// trackCount 直接读写共享的曲目数缓存，无需再单独同步一次
const { trackCount } = useLibraryTrackCount({ runtime, dirDataRef, props })

const displayedFolderChildren = computed(() => {
  const children = dirData.value?.children
  if (!children?.length) return children || []
  if (runtime.libraryAreaSelected === 'RecycleBin') return children
  void libraryTreeSortRuleVersion.value
  void libraryTreeTrackCountVersion.value
  return sortLibraryTreeChildren(children, getLibraryTreeSortRule(props.libraryName))
})

const dirChildShow = ref(false)
const dirChildRendered = ref(false)

const { rightClickMenuShow, contextmenuEvent, deleteDir } = useLibraryContextMenu({
  dirDataRef,
  fatherDirDataRef,
  runtime,
  props,
  emitter,
  dirChildRendered,
  dirChildShow,
  trackCount,
  warnAcoustIdMissing,
  startRename
})

const { dragApproach, dragstart, dragover, dragenter, dragleave, drop } = useLibraryDragAndDrop({
  runtime,
  dirDataRef,
  fatherDirDataRef,
  deleteDir,
  props,
  handleDropToSongList,
  emitter
})

const { shouldShow } = useLibraryFilter({
  props,
  dirDataRef,
  dirChildRendered,
  dirChildShow
})

const dirHandleClick = async (event: MouseEvent) => {
  const currentDirData = dirDataRef.value
  if (!currentDirData) return
  if (runtime.songDragSuppressClickUntilMs > Date.now()) return
  runtime.activeMenuUUID = ''
  runtime.focusArea = 'library'
  // 清空歌曲列表选中状态
  runtime.songsArea.selectedSongFilePath.length = 0
  if (runtime.songsAreaPanels.splitEnabled) {
    runtime.songsAreaPanels.panes.left.selectedSongFilePath.length = 0
    runtime.songsAreaPanels.panes.right.selectedSongFilePath.length = 0
  }

  // 获取当前节点及其所有子项的 UUID
  const selfAndChildIds = libraryUtils.getAllUuids(currentDirData)
  const isFolder = !isPlaylist.value

  // 处理多选逻辑
  if (event.ctrlKey || event.metaKey) {
    // Ctrl+Click: 切换选中状态（文件夹包含子项），不打开歌单
    const isCurrentlySelected = runtime.selectedPlaylistIds.includes(props.uuid)
    if (isCurrentlySelected) {
      // 取消选中：移除自身及所有子项
      const childIdSet = new Set(selfAndChildIds)
      runtime.selectedPlaylistIds = runtime.selectedPlaylistIds.filter((id) => !childIdSet.has(id))
    } else {
      // 选中：添加自身及所有子项（去重）
      const merged = new Set([...runtime.selectedPlaylistIds, ...selfAndChildIds])
      runtime.selectedPlaylistIds = [...merged]
    }
    return
  } else if (event.shiftKey && runtime.selectedPlaylistIds.length > 0) {
    // Shift+Click: 范围选中（从最后一个选中的到当前），不打开歌单
    const currentLibrary = (runtime.libraryTree.children || []).find(
      (lib) => lib.dirName === runtime.libraryAreaSelected
    )
    const allPlaylists = currentLibrary
      ? libraryUtils.collectSelectableLibraryUuids(currentLibrary, false)
      : []
    const lastSelectedId = runtime.selectedPlaylistIds[runtime.selectedPlaylistIds.length - 1]
    const lastIndex = allPlaylists.indexOf(lastSelectedId)
    const currentIndex = allPlaylists.indexOf(props.uuid)
    if (lastIndex !== -1 && currentIndex !== -1) {
      const start = Math.min(lastIndex, currentIndex)
      const end = Math.max(lastIndex, currentIndex)
      const rangeIds = allPlaylists.slice(start, end + 1)
      // 合并现有选中和范围选中
      const merged = new Set([...runtime.selectedPlaylistIds, ...rangeIds])
      runtime.selectedPlaylistIds = [...merged]
    }
    return
  } else if (isFolder) {
    // 普通单击文件夹: 只展开/折叠，不选中
    runtime.selectedPlaylistIds = []
  } else {
    // 普通单击歌单: 选中当前歌单
    runtime.selectedPlaylistIds = [props.uuid]
  }
  // 网易云分组/歌单是虚拟节点，没有磁盘目录。不能走本地库那套
  // dirPathExists + 失败就从树里删掉，否则一点「创建的歌单」就会误删。
  if (!isNeteaseVirtualUuid(props.uuid)) {
    const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
    const isSongListPathExist = await window.electron.ipcRenderer.invoke(
      'dirPathExists',
      songListPath
    )
    if (!isSongListPathExist) {
      await confirm({
        title: t('common.error'),
        content: [t('library.notExistOnDisk')],
        confirmShow: false
      })
      await deleteDir()
      return
    }
  }
  if (isPlaylist.value) {
    if (runtime.songsAreaPanels.splitEnabled) {
      const pane = resolveSongsAreaPaneForLibraryClick(runtime)
      replaceSongsAreaPaneSongList(runtime, pane, props.uuid)
      activateSongsAreaPane(runtime, pane)
      return
    }
    if (runtime.songsArea.songListUUID === props.uuid) {
      runtime.songsArea.songListUUID = ''
      return
    }
    runtime.songsArea.songListUUID = props.uuid
  } else {
    dirChildRendered.value = true
    dirChildShow.value = !dirChildShow.value
  }
}

const handleCollapseButtonClick = (libraryName: unknown) => {
  if (String(libraryName || '') == props.libraryName) {
    dirChildShow.value = false
  }
}
emitter.on('collapseButtonHandleClick', handleCollapseButtonClick)

const indentWidth = ref(0)
const syncIndentWidth = () => {
  const depth = libraryUtils.getDepthByUuid(props.uuid)
  indentWidth.value = typeof depth === 'number' ? (depth - 2) * 10 : 0
}
syncIndentWidth()
watch(
  () => props.uuid,
  () => {
    syncIndentWidth()
  }
)
watch(
  () => runtime.libraryTree,
  () => {
    syncIndentWidth()
  },
  { deep: false }
)

const activePlaybackSongListUUIDs = computed(() => {
  return resolveActivePlaybackSongListUUIDs(runtime)
})

const isPlaying = computed(() => {
  if (activePlaybackSongListUUIDs.value.length === 0) return false
  const libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
  if (libraryTree === null) return false
  const uuids = libraryUtils.getAllUuids(libraryTree)
  return activePlaybackSongListUUIDs.value.some((uuid) => uuids.includes(uuid))
})

const isOpenedInSongsArea = computed(() => {
  if (runtime.songsAreaPanels.splitEnabled) {
    return (['left', 'right'] as const).some(
      (pane) => runtime.songsAreaPanels.panes[pane].songListUUID === props.uuid
    )
  }
  return runtime.songsArea.songListUUID === props.uuid
})

const displayDirName = computed(() => {
  const d = dirData.value
  if (!d) return ''
  if (runtime.libraryAreaSelected === 'RecycleBin' && d.dirName) {
    // 支持分钟格式（无秒）与历史秒级格式
    const matchMinute = d.dirName.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})$/)
    if (matchMinute) {
      return `${matchMinute[1]}-${matchMinute[2]}-${matchMinute[3]} ${matchMinute[4]}:${matchMinute[5]}`
    }
    const matchSecond = d.dirName.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/)
    if (matchSecond) {
      return `${matchSecond[1]}-${matchSecond[2]}-${matchSecond[3]} ${matchSecond[4]}:${matchSecond[5]}:${matchSecond[6]}`
    }
  }
  if (
    (d.type === 'songList' || d.type === 'setList') &&
    runtime.setting.showPlaylistTrackCount &&
    trackCount.value !== null
  ) {
    return d.dirName
  }
  return d.dirName
})

// 供模板使用的名称（不带数量）
const nameForDisplay = computed(() => displayDirName.value)
const showTrackCount = computed(
  () =>
    (dirData.value?.type === 'songList' || dirData.value?.type === 'setList') &&
    runtime.setting.showPlaylistTrackCount &&
    trackCount.value !== null
)
const nameTextRef = ref<HTMLElement | null>(null)
const nameTextHovered = ref(false)
const onlyShowBubbleWhenOverflow = computed(
  () => !Reflect.get(runtime.setting, 'songListBubbleAlways')
)
const openMixtapeHandleClick = () => {
  const currentDirData = dirDataRef.value
  if (!currentDirData || currentDirData.type !== 'mixtapeList') return
  const playlistPath = libraryUtils.findDirPathByUuid(props.uuid)
  window.electron.ipcRenderer.send('mixtape:open', {
    playlistId: props.uuid,
    playlistPath,
    playlistName: currentDirData.dirName
  })
}

const canStartLibraryItemDrag = computed(() => {
  void libraryTreeSortRuleVersion.value
  return (
    !!dirData.value?.dirName &&
    !renameDivShow.value &&
    runtime.libraryAreaSelected !== 'RecycleBin' &&
    isLibraryTreeManualSort(props.libraryName)
  )
})

const notifyAutoSortBlocksDrag = (clientX: number, clientY: number) => {
  if (isLibraryTreeManualSort(props.libraryName)) return
  if (runtime.libraryAreaSelected === 'RecycleBin') return
  showNearMouseTip(clientX, clientY, t('playlist.sortAutoBlocksDrag'))
}

const handleDragStartGuard = (event: DragEvent) => {
  if (!isLibraryTreeManualSort(props.libraryName)) {
    event.preventDefault()
    notifyAutoSortBlocksDrag(event.clientX, event.clientY)
    return
  }
  void dragstart(event)
}

const handleTouchStart = (event: TouchEvent) => {
  if (!canStartLibraryItemDrag.value) {
    const touch = event.touches[0]
    if (touch) notifyAutoSortBlocksDrag(touch.clientX, touch.clientY)
    return
  }
  const sourceElement = event.currentTarget
  if (!(sourceElement instanceof HTMLElement)) return
  touchPlaylistDrag.handleTouchStart(event, sourceElement)
}

onUnmounted(() => {
  emitter.off('collapseButtonHandleClick', handleCollapseButtonClick)
  touchPlaylistDrag.cancel()
})
</script>
<template>
  <div
    v-if="dirData"
    v-show="shouldShow"
    class="mainBody"
    style="display: flex; box-sizing: border-box"
    :style="'padding-left:' + indentWidth + 'px'"
    :draggable="canStartLibraryItemDrag"
    :class="{
      rightClickBorder: rightClickMenuShow,
      borderTop: dragApproach == 'top',
      borderBottom: dragApproach == 'bottom',
      borderCenter: dragApproach == 'center',
      selectedDir: isOpenedInSongsArea && !runtime.selectedPlaylistIds.includes(props.uuid),
      selectedLibrary: runtime.selectedPlaylistIds.includes(props.uuid),
      welcomeCreatedPlaylist: runtime.welcomeCreatedPlaylistUUID === props.uuid
    }"
    @contextmenu.stop="contextmenuEvent"
    @click.stop="dirHandleClick($event)"
    @touchstart="handleTouchStart"
    @dragover.stop.prevent="dragover"
    @dragstart.stop="handleDragStartGuard"
    @dragenter.stop.prevent="dragenter"
    @drop.stop.prevent="drop"
    @dragleave.stop="dragleave"
  >
    <div class="prefixIcon" :class="{ isPlaying: isPlaying }">
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
      <span
        v-if="
          isPlaylist &&
          runtime.importingSongListUUID != props.uuid &&
          runtime.creatingSongListUUID !== props.uuid
        "
        class="library-list-icon"
        :class="{ 'is-playing': isPlaying }"
        :style="listIconMaskStyle"
      ></span>
      <div
        v-if="dirData.type == 'songList' && runtime.creatingSongListUUID === props.uuid"
        class="loading"
        :class="{ isPlayingLoading: isPlaying }"
      ></div>
      <div
        v-if="dirData.type == 'songList' && runtime.importingSongListUUID == props.uuid"
        class="loading"
        :class="{ isPlayingLoading: isPlaying }"
      ></div>
    </div>
    <div style="height: 23px; width: calc(100% - 20px)">
      <div
        v-if="dirData.dirName && !renameDivShow"
        class="nameRow"
        :class="{ isPlaying: isPlaying }"
      >
        <span
          ref="nameTextRef"
          :class="[
            'nameText',
            {
              'nameText--with-count': showTrackCount,
              'nameText--with-mixtape-action': dirData.type === 'mixtapeList'
            }
          ]"
          @mouseenter="isPlaylist && (nameTextHovered = true)"
          @mouseleave="nameTextHovered = false"
          >{{ nameForDisplay }}</span
        >
        <bubbleBox
          v-if="isPlaylist && nameTextHovered && nameForDisplay"
          :dom="nameTextRef || undefined"
          :title="nameForDisplay"
          :only-when-overflow="onlyShowBubbleWhenOverflow"
        />
        <span v-if="dirData.type === 'mixtapeList' || showTrackCount" class="rowActions">
          <bubbleBoxTrigger
            v-if="dirData.type === 'mixtapeList'"
            tag="span"
            class="mixModeBadge"
            :class="{
              'is-eq': dirData.mixMode === 'eq',
              'is-stem': dirData.mixMode !== 'eq',
              isPlaying: isPlaying
            }"
            :title="resolveMixtapeBadgeTitle(dirData.mixMode)"
            @click.stop
          >
            <span>{{ resolveMixtapeModeTag(dirData.mixMode) }}</span>
          </bubbleBoxTrigger>
          <bubbleBoxTrigger
            v-if="dirData.type === 'mixtapeList'"
            tag="button"
            type="button"
            class="recordButton"
            :class="{ isPlaying: isPlaying }"
            :title="t('mixtape.openRecordWindow')"
            draggable="false"
            @mousedown.stop
            @click.stop="openMixtapeHandleClick"
            @dragstart.stop.prevent
            @contextmenu.stop
          >
            {{ t('mixtape.recordButton') }}
          </bubbleBoxTrigger>
          <bubbleBoxTrigger
            v-if="showTrackCount"
            tag="span"
            class="countBadge"
            :class="{ isPlaying: isPlaying }"
            :title="t('tracks.title')"
          >
            {{ trackCount }}
          </bubbleBoxTrigger>
        </span>
      </div>
      <div v-if="!dirData.dirName">
        <input
          ref="myInput"
          v-model="operationInputValue"
          class="myInput"
          :data-welcome-created-playlist-input="
            runtime.welcomeCreatedPlaylistUUID === props.uuid ? props.uuid : undefined
          "
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
    v-if="dirData && dirData.type == 'dir' && dirChildRendered"
    v-show="dirChildShow"
    style="width: 100%; box-sizing: border-box"
  >
    <template v-for="item of displayedFolderChildren" :key="item.uuid">
      <libraryItem
        :uuid="item.uuid"
        :library-name="props.libraryName"
        :filter-text="props.filterText"
      />
    </template>
  </div>
</template>
<style lang="scss" scoped>
.library-list-icon {
  width: 13px;
  height: 13px;
  display: inline-block;
  background-color: currentColor;
  color: var(--text);
  mask-image: var(--icon-mask);
  mask-repeat: no-repeat;
  mask-position: center;
  mask-size: contain;
  -webkit-mask-image: var(--icon-mask);
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  -webkit-mask-size: contain;
}

.mainBody.welcomeCreatedPlaylist {
  animation: welcomeCreatedPlaylistPulse 0.68s ease-out;
}

@keyframes welcomeCreatedPlaylistPulse {
  0% {
    background-color: color-mix(in srgb, var(--accent) 26%, transparent);
    box-shadow: inset 2px 0 0 var(--accent);
  }

  100% {
    background-color: transparent;
    box-shadow: inset 2px 0 0 transparent;
  }
}
.library-list-icon.is-playing {
  color: var(--accent);
}

.nameRow {
  line-height: 23px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 8px; // 右侧留白，避免贴边
  position: relative; // 让徽标绝对定位不受省略号影响
}

.nameText {
  flex: 1 1 auto;
  min-width: 0;
  padding-right: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nameText--with-count {
  padding-right: 42px;
}

.nameText--with-mixtape-action {
  padding-right: 116px;
}

.rowActions {
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

.isPlaying.mixModeBadge {
  background-color: var(--accent);
  color: #ffffff !important;
}

.recordButton {
  height: 18px;
  min-width: 36px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--border) 85%, transparent);
  border-radius: 9px;
  background-color: color-mix(in srgb, var(--bg-elev) 92%, transparent);
  color: var(--text-weak);
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.recordButton:hover {
  background-color: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}

.recordButton:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, #ffffff);
  outline-offset: 1px;
}

.recordButton.isPlaying {
  border-color: color-mix(in srgb, var(--accent) 78%, transparent);
  color: var(--accent);
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

.isPlaying.countBadge {
  background-color: var(--accent);
  color: #ffffff !important;
}
.isPlaying {
  color: var(--accent) !important;
}

.isPlayingLoading {
  border: 2px solid var(--accent) !important;
}

.loading {
  width: 8px;
  height: 8px;
  border: 2px solid var(--text);
  border-top-color: transparent;
  border-radius: 100%;
  animation: circle infinite 0.75s linear;
}

// 转转转动画
@keyframes circle {
  0% {
    transform: rotate(0);
  }

  100% {
    transform: rotate(360deg);
  }
}

.selectedDir {
  background-color: var(--hover);

  &:hover {
    background-color: var(--hover) !important;
  }
}

.selectedLibrary {
  background-color: color-mix(in srgb, var(--accent) 24%, var(--bg-elev));

  &:hover {
    background-color: color-mix(in srgb, var(--accent) 30%, var(--bg-elev)) !important;
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
    color: #ffffff;
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
</style>
