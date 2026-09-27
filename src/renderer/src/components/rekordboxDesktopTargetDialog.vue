<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  watch,
  type ComponentPublicInstance
} from 'vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import hotkeys from 'hotkeys-js'
import listIconAsset from '@renderer/assets/listIcon.svg?asset'
import RekordboxDesktopTargetTreeItem from '@renderer/components/rekordboxDesktopTargetTreeItem.vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import {
  focusSearchInput,
  SEARCH_FOCUS_PRIORITY,
  useSearchFocusTarget
} from '@renderer/composables/useSearchFocus'
import {
  buildVisibleCombinedNavList,
  loadRecentDialogSelectedSongListUUIDs,
  persistRecentDialogSelectedSongListUUIDs,
  resolveDialogNavIndexByUUID,
  resolveDialogNavMove,
  type DialogNavItem
} from '@renderer/components/selectSongListDialogNav'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  buildRekordboxSourceCacheKey,
  setCachedRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import { v4 as uuidV4 } from 'uuid'
import type { IDir, IPioneerPlaylistTreeNode } from '../../../types/globals'
import type { RekordboxDesktopPlaylistWriteTarget } from '@shared/rekordboxDesktopPlaylist'
import {
  findNodeById,
  filterTreeNodes,
  flattenPlayableNodes,
  collectFolderIds,
  isPlayablePlaylistNode,
  toPseudoSongList,
  normalizeKeyword
} from '@renderer/composables/rekordboxDesktop/useRekordboxTreeUtils'
import { useRekordboxDesktopActions } from '@renderer/composables/rekordboxDesktop/useRekordboxDesktopActions'
import { useRekordboxTreeDrag } from '@renderer/composables/rekordboxDesktop/useRekordboxTreeDrag'
import './rekordboxDesktopTargetDialog.scss'

type DialogPayload = {
  target: RekordboxDesktopPlaylistWriteTarget
}

type LoadTreeResult = {
  treeNodes?: IPioneerPlaylistTreeNode[]
  sourceKey?: string
  sourceRootPath?: string
}

type PreventableEvent = {
  preventDefault?: () => void
}

type PseudoSongList = IDir

const RECENT_LIBRARY_KEY = 'RekordboxDesktopLibrary'
const uuid = uuidV4()
const runtime = useRuntimeStore()

const props = defineProps<{
  dialogTitle: string
  defaultPlaylistName: string
  trackCount?: number
  confirmCallback: (payload: DialogPayload) => void
  cancelCallback: () => void
}>()

runtime.activeMenuUUID = ''
runtime.selectSongListDialogShow = true

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const collapseButtonRef = useTemplateRef<HTMLDivElement>('collapseButtonRef')
const searchInputRef = useTemplateRef<HTMLInputElement>('searchInputRef')
useSearchFocusTarget({
  getInput: () => searchInputRef.value,
  scope: uuid,
  priority: SEARCH_FOCUS_PRIORITY.dialog
})

const rawTreeNodes = ref<IPioneerPlaylistTreeNode[]>([])
const loading = ref(false)
const dialogWriting = ref(false)
const loadError = ref('')
const playlistSearch = ref('')
const expandedFolderIds = ref<Set<number>>(new Set())
const selectedArea = ref<'recent' | 'tree' | ''>('')
const navIndex = ref(-1)
const flashArea = ref('')
const recentRowRefs = new Map<string, HTMLElement>()

let recentSelectedPlaylistIds = loadRecentDialogSelectedSongListUUIDs(
  RECENT_LIBRARY_KEY,
  runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
)
if (recentSelectedPlaylistIds.length > 0) {
  runtime.dialogSelectedSongListUUID = recentSelectedPlaylistIds[0]
  selectedArea.value = 'recent'
}

const resolveTemplateElement = (
  value: Element | ComponentPublicInstance | null
): HTMLElement | null => {
  if (value instanceof HTMLElement) return value
  if (!value || typeof value !== 'object' || !('$el' in value)) return null
  return value.$el instanceof HTMLElement ? value.$el : null
}

const setRecentRowRef = (id: string, el: Element | ComponentPublicInstance | null) => {
  const resolved = resolveTemplateElement(el)
  if (resolved) recentRowRefs.set(id, resolved)
  else recentRowRefs.delete(id)
}

const runWithDialogWriting = async <T,>(task: () => Promise<T>): Promise<T> => {
  dialogWriting.value = true
  try {
    return await task()
  } finally {
    dialogWriting.value = false
  }
}

const filteredTreeNodes = computed(() => filterTreeNodes(rawTreeNodes.value, playlistSearch.value))
const visibleTreeNodes = computed(() => filteredTreeNodes.value)
const allPlaylistNodes = computed(() => flattenPlayableNodes(rawTreeNodes.value))
const renderedExpandedFolderIds = computed(() => {
  const next = !playlistSearch.value.trim()
    ? new Set(expandedFolderIds.value)
    : new Set(collectFolderIds(filteredTreeNodes.value))
  return next
})

const searchKeyword = computed(() => normalizeKeyword(playlistSearch.value))

const recentPlaylistArr = computed<PseudoSongList[]>(() => {
  const result: PseudoSongList[] = []
  const invalidIds: string[] = []
  for (const item of recentSelectedPlaylistIds) {
    const node = findNodeById(rawTreeNodes.value, Number(item) || 0)
    if (!isPlayablePlaylistNode(node)) {
      invalidIds.push(item)
      continue
    }
    result.push(toPseudoSongList(node))
  }
  if (invalidIds.length > 0) {
    recentSelectedPlaylistIds = recentSelectedPlaylistIds.filter(
      (item) => !invalidIds.includes(item)
    )
    persistRecentDialogSelectedSongListUUIDs(RECENT_LIBRARY_KEY, recentSelectedPlaylistIds)
  }
  return result
})

const allSongListArr = computed<PseudoSongList[]>(() =>
  allPlaylistNodes.value.map(toPseudoSongList)
)

const visibleCombinedNavList = computed<DialogNavItem[]>(() =>
  buildVisibleCombinedNavList(
    recentPlaylistArr.value,
    allSongListArr.value,
    String(playlistSearch.value || '')
  )
)

const syncNavIndexByUUID = () => {
  const list = visibleCombinedNavList.value || []
  navIndex.value = resolveDialogNavIndexByUUID(
    list,
    runtime.dialogSelectedSongListUUID,
    selectedArea.value
  )
}

const moveSelection = (direction: 1 | -1) => {
  const list = visibleCombinedNavList.value || []
  if (list.length === 0) return
  navIndex.value = resolveDialogNavMove(navIndex.value, direction, list.length)
  const target = list[navIndex.value]
  selectedArea.value = target.area
  runtime.dialogSelectedSongListUUID = target.uuid
}

const handleMoveDown = (e?: PreventableEvent | null) => {
  if (dialogWriting.value) return
  try {
    e?.preventDefault?.()
  } catch {}
  moveSelection(1)
}

const handleMoveUp = (e?: PreventableEvent | null) => {
  if (dialogWriting.value) return
  try {
    e?.preventDefault?.()
  } catch {}
  moveSelection(-1)
}

const exactMatchExists = computed(() => {
  const keyword = normalizeKeyword(playlistSearch.value)
  if (!keyword) return true
  return allSongListArr.value.some((item) => String(item.dirName || '').toLowerCase() === keyword)
})

const showCreateNow = computed(() => {
  const keyword = String(playlistSearch.value || '').trim()
  return Boolean(keyword) && !exactMatchExists.value
})

const filteredRecentPlaylistArr = computed(() => {
  if (!searchKeyword.value) return recentPlaylistArr.value
  return recentPlaylistArr.value.filter((item) =>
    String(item.dirName || '')
      .toLowerCase()
      .includes(searchKeyword.value)
  )
})

const filteredAllSongListIds = computed(() =>
  allSongListArr.value
    .filter((item) =>
      !searchKeyword.value
        ? true
        : String(item.dirName || '')
            .toLowerCase()
            .includes(searchKeyword.value)
    )
    .map((item) => item.uuid)
)

const flashBorder = (name: string) => {
  flashArea.value = name
  let count = 0
  const interval = window.setInterval(() => {
    count += 1
    if (count >= 3) {
      window.clearInterval(interval)
      flashArea.value = ''
    }
  }, 500)
}

const syncRuntimeDesktopTree = (result: LoadTreeResult) => {
  const sourceKey = String(
    result.sourceKey || runtime.pioneerDeviceLibrary.selectedSourceKey || ''
  ).trim()
  const rootPath = String(
    result.sourceRootPath || runtime.pioneerDeviceLibrary.selectedSourceRootPath || ''
  ).trim()
  if (!sourceKey || !rootPath) return

  const sourceCacheKey = buildRekordboxSourceCacheKey({
    sourceKind: 'desktop',
    sourceKey,
    rootPath,
    libraryType: 'masterDb'
  })
  setCachedRekordboxSourceTree(sourceCacheKey, rawTreeNodes.value)
  if (runtime.pioneerDeviceLibrary.selectedSourceKind !== 'desktop') return
  runtime.pioneerDeviceLibrary.treeNodes = rawTreeNodes.value
}

const loadTree = async (preferredPlaylistId = Number(runtime.dialogSelectedSongListUUID) || 0) => {
  loading.value = true
  loadError.value = ''
  try {
    const result = (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'load-tree')
    )) as LoadTreeResult
    rawTreeNodes.value = Array.isArray(result?.treeNodes) ? result.treeNodes : []

    const nextSelectedId =
      preferredPlaylistId > 0 &&
      isPlayablePlaylistNode(findNodeById(rawTreeNodes.value, preferredPlaylistId))
        ? preferredPlaylistId
        : Number(allSongListArr.value[0]?.uuid) || 0

    runtime.dialogSelectedSongListUUID = nextSelectedId > 0 ? String(nextSelectedId) : ''
    if (nextSelectedId > 0 && !selectedArea.value) {
      selectedArea.value = 'tree'
    }
    syncRuntimeDesktopTree(result)
  } catch (error) {
    loadError.value =
      error instanceof Error ? error.message : String(error || t('common.unknownError'))
    rawTreeNodes.value = []
    runtime.dialogSelectedSongListUUID = ''
  } finally {
    loading.value = false
  }
}

const { showFailureDialog, openCreatePlaylistDialog, contextmenuEvent, handleNodeContextmenu } =
  useRekordboxDesktopActions(
    dialogWriting,
    playlistSearch,
    selectedArea,
    expandedFolderIds,
    loadTree,
    runWithDialogWriting
  )

const {
  dragSourceId,
  dragTarget,
  handleDragStartNode,
  handleDragOverNode,
  handleDragEnterNode,
  handleDragLeaveNode,
  handleDragEndNode,
  handleDragOverRootEnd,
  handleDragEnterRootEnd,
  handleDragLeaveRootEnd,
  handleDropNode,
  handleDropRootEnd
} = useRekordboxTreeDrag(
  rawTreeNodes,
  dialogWriting,
  selectedArea,
  searchKeyword,
  showFailureDialog,
  loadTree,
  runWithDialogWriting
)

const createNow = async () => {
  if (dialogWriting.value) return
  const playlistName = String(playlistSearch.value || '').trim()
  if (!playlistName) return
  await openCreatePlaylistDialog(0, playlistName)
}

const clearSearch = () => {
  if (dialogWriting.value) return
  playlistSearch.value = ''
}

const collapseButtonHandleClick = async () => {
  if (dialogWriting.value) return
  expandedFolderIds.value = new Set()
  await nextTick()
}

const selectRecentPlaylist = (playlistId: string) => {
  if (dialogWriting.value) return
  runtime.dialogSelectedSongListUUID = playlistId
  selectedArea.value = 'recent'
}

const confirmRecentPlaylist = () => {
  if (dialogWriting.value) return
  confirmHandle()
}

const selectPlaylist = (node: IPioneerPlaylistTreeNode) => {
  if (dialogWriting.value) return
  if (!isPlayablePlaylistNode(node)) return
  runtime.dialogSelectedSongListUUID = String(node.id)
  selectedArea.value = 'tree'
}

const toggleFolder = (node: IPioneerPlaylistTreeNode) => {
  if (dialogWriting.value) return
  if (!node.isFolder) return
  const next = new Set(expandedFolderIds.value)
  if (next.has(node.id)) next.delete(node.id)
  else next.add(node.id)
  expandedFolderIds.value = next
}

const confirmHandle = () => {
  if (dialogWriting.value) return
  const selectedId = String(runtime.dialogSelectedSongListUUID || '').trim()
  const selectionVisible =
    !normalizeKeyword(playlistSearch.value) || filteredAllSongListIds.value.includes(selectedId)
  const selectedNode = findNodeById(rawTreeNodes.value, Number(selectedId) || 0)
  if (!selectedId || !selectionVisible || !isPlayablePlaylistNode(selectedNode)) {
    if (!flashArea.value) {
      flashBorder('selectSongList')
    }
    return
  }

  if (recentSelectedPlaylistIds.indexOf(selectedId) === -1) {
    recentSelectedPlaylistIds.unshift(selectedId)
  } else {
    recentSelectedPlaylistIds.unshift(
      recentSelectedPlaylistIds.splice(recentSelectedPlaylistIds.indexOf(selectedId), 1)[0]
    )
  }
  const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
  while (recentSelectedPlaylistIds.length > maxCount) {
    recentSelectedPlaylistIds.pop()
  }
  persistRecentDialogSelectedSongListUUIDs(RECENT_LIBRARY_KEY, recentSelectedPlaylistIds)

  closeWithAnimation(() => {
    props.confirmCallback({
      target: {
        mode: 'append',
        playlistId: Number(selectedId),
        playlistName: selectedNode?.name || ''
      }
    })
  })
}

const cancel = () => {
  if (dialogWriting.value) return
  closeWithAnimation(() => {
    props.cancelCallback()
  })
}

const handleSearchEnter = async () => {
  if (dialogWriting.value) return
  if (!normalizeKeyword(playlistSearch.value)) {
    confirmHandle()
    return
  }
  const firstRecent = recentPlaylistArr.value.find((item) =>
    String(item.dirName || '')
      .toLowerCase()
      .includes(normalizeKeyword(playlistSearch.value))
  )
  const firstAll = allSongListArr.value.find((item) =>
    String(item.dirName || '')
      .toLowerCase()
      .includes(normalizeKeyword(playlistSearch.value))
  )
  if (!firstRecent && !firstAll) {
    await openCreatePlaylistDialog(0, String(playlistSearch.value || '').trim())
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

watch(
  () => allSongListArr.value.length,
  (len) => {
    if (len > 0 && !runtime.dialogSelectedSongListUUID) {
      runtime.dialogSelectedSongListUUID = allSongListArr.value[0].uuid
      selectedArea.value = 'tree'
      syncNavIndexByUUID()
    }
  },
  { immediate: true }
)

watch(
  () => runtime.dialogSelectedSongListUUID,
  (val) => {
    if (!val) {
      selectedArea.value = ''
      navIndex.value = -1
      return
    }
    const inRecent = recentPlaylistArr.value.some((item) => item.uuid === val)
    const inTree = allSongListArr.value.some((item) => item.uuid === val)
    if (inRecent && inTree) {
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

watch(
  [
    () => runtime.dialogSelectedSongListUUID,
    () => selectedArea.value,
    () => recentPlaylistArr.value.length
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

onMounted(() => {
  hotkeys('s', uuid, () => {
    handleMoveDown()
  })
  hotkeys('w', uuid, () => {
    handleMoveUp()
  })
  hotkeys('down', uuid, (e) => {
    handleMoveDown(e)
  })
  hotkeys('up', uuid, (e) => {
    handleMoveUp(e)
  })
  hotkeys('E,Enter', uuid, () => {
    confirmHandle()
    return false
  })
  hotkeys('Esc', uuid, () => {
    cancel()
    return false
  })
  utils.setHotkeysScpoe(uuid)
  void nextTick(() => focusSearchInput(searchInputRef.value))
  void loadTree()
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  runtime.dialogSelectedSongListUUID = ''
  runtime.selectSongListDialogShow = false
})
</script>

<template>
  <div
    class="dialog unselectable rekordboxDesktopTargetDialog"
    :class="{ 'dialog-visible': dialogVisible }"
  >
    <div
      v-dialog-drag="'.dialog-title'"
      class="content inner"
      @contextmenu.stop.prevent="contextmenuEvent($event, 0, defaultPlaylistName)"
    >
      <div class="unselectable libraryTitle dialog-title dialog-header">
        <div class="collapseButtonPlaceholder"></div>
        <span>{{ props.dialogTitle }}</span>
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
        <div class="librarySearchWrapper">
          <div class="searchRow">
            <div class="searchInputWrapper">
              <input
                ref="searchInputRef"
                v-model="playlistSearch"
                class="searchInput"
                :placeholder="t('playlist.searchPlaylists')"
                :disabled="dialogWriting"
                @keydown.down.prevent="handleMoveDown"
                @keydown.up.prevent="handleMoveUp"
                @keydown.enter.prevent.stop="handleSearchEnter"
              />
              <div
                v-show="String(playlistSearch || '').length"
                class="clearBtn"
                :class="{ clearBtnDisabled: dialogWriting }"
                @click="clearSearch()"
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
            <div
              v-if="showCreateNow"
              class="createNowBtn"
              :class="{ disabledAction: dialogWriting }"
              @click="createNow()"
            >
              {{ t('playlist.createNow') }}
            </div>
          </div>
        </div>

        <div
          v-if="allSongListArr.length > 0 || visibleTreeNodes.length > 0 || loading"
          class="unselectable libraryArea flashing-border"
          :class="{ 'is-flashing': flashArea === 'selectSongList' }"
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
              <div v-if="recentPlaylistArr.length > 0" class="sectionCard sectionCard--recent">
                <div class="sectionHeader">
                  <div class="sectionTitle">
                    <span class="sectionAccent sectionAccent--recent"></span>
                    <span>{{ t('library.recentlyUsed') }}</span>
                  </div>
                </div>
                <div class="sectionBody">
                  <div
                    v-for="item of filteredRecentPlaylistArr"
                    :key="item.uuid"
                    :ref="(el) => setRecentRowRef(item.uuid, el)"
                    class="recentLibraryItem"
                    :class="{
                      selectedDir:
                        selectedArea === 'recent' &&
                        item.uuid === runtime.dialogSelectedSongListUUID
                    }"
                    @click="selectRecentPlaylist(item.uuid)"
                    @dblclick="confirmRecentPlaylist()"
                  >
                    <div
                      style="
                        width: 20px;
                        justify-content: center;
                        align-items: center;
                        display: flex;
                      "
                    >
                      <img class="songlist-icon" :src="listIconAsset" />
                    </div>
                    <div class="nameRow">
                      <span class="nameText">{{ item.dirName }}</span>
                    </div>
                  </div>
                  <div class="libraryDropSpace"></div>
                </div>
              </div>

              <div class="sectionCard sectionCard--all">
                <div class="sectionHeader">
                  <div class="sectionTitle">
                    <span class="sectionAccent sectionAccent--all"></span>
                    <span>{{ t('library.allPlaylists') }}</span>
                  </div>
                </div>
                <div
                  class="sectionBody sectionBody--allDrop"
                  @dragover.prevent="handleDragOverRootEnd"
                  @dragenter.prevent="handleDragEnterRootEnd"
                  @dragleave="handleDragLeaveRootEnd"
                  @drop.prevent="handleDropRootEnd"
                >
                  <template v-for="item of visibleTreeNodes" :key="`${item.id}`">
                    <RekordboxDesktopTargetTreeItem
                      :node="item"
                      :depth="0"
                      :expanded-ids="renderedExpandedFolderIds"
                      :selected-playlist-id="Number(runtime.dialogSelectedSongListUUID) || 0"
                      :interaction-disabled="dialogWriting"
                      :drag-target-node-id="dragTarget?.nodeId || null"
                      :drag-target-approach="dragTarget?.approach || ''"
                      :drag-source-id="dragSourceId"
                      @toggle-folder="toggleFolder"
                      @select-playlist="selectPlaylist"
                      @dbl-click-song-list="confirmHandle()"
                      @contextmenu-node="handleNodeContextmenu"
                      @dragstart-node="handleDragStartNode"
                      @dragover-node="handleDragOverNode"
                      @dragenter-node="handleDragEnterNode"
                      @dragleave-node="handleDragLeaveNode"
                      @drop-node="handleDropNode"
                      @dragend-node="handleDragEndNode"
                    />
                  </template>
                  <div
                    v-if="loading || loadError || (!loading && !visibleTreeNodes.length)"
                    class="libraryEmptyHint"
                  >
                    <span v-if="loading">{{ t('rekordboxDesktop.loadingPlaylistTree') }}</span>
                    <span v-else-if="loadError">{{ loadError }}</span>
                    <span v-else>{{ t('rekordboxDesktop.emptyPlaylistTree') }}</span>
                  </div>
                  <div
                    v-if="!loading && visibleTreeNodes.length > 0"
                    class="libraryDropSpace"
                    :class="{ 'libraryDropSpace--active': dragTarget?.placement === 'root-end' }"
                  ></div>
                </div>
              </div>
            </div>
          </OverlayScrollbarsComponent>
        </div>

        <div
          v-else
          class="unselectable flashing-border"
          :class="{ 'is-flashing': flashArea === 'selectSongList' }"
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
        <div
          class="button dialogActionButton"
          :class="{ disabledAction: dialogWriting }"
          @click="confirmHandle()"
        >
          {{ t('rekordboxDesktop.confirmAction') }} (E)
        </div>
        <div
          class="button dialogActionButton"
          :class="{ disabledAction: dialogWriting }"
          @click="cancel()"
        >
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>

      <div v-if="dialogWriting" class="dialogBusyMask" data-dialog-drag-ignore="true">
        <div class="dialogBusyCard">
          <span class="dialogBusySpinner"></span>
          <span>{{ t('rekordboxDesktop.writingInProgress') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
