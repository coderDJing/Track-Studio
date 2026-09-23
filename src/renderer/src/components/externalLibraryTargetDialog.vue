<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import {
  calculateDragApproach,
  cloneTreeNodes,
  countNodeDescendants,
  filterTreeNodes,
  findNodeById,
  flattenPlayableNodes,
  isDescendantNode,
  isMovableTreeNode,
  moveTreeNode,
  moveTreeNodeToRootEnd,
  normalizeKeyword,
  sanitizeNodeName,
  type MoveTreeNodeResult,
  type TreeDragApproach
} from '@renderer/composables/rekordboxDesktop/useRekordboxTreeUtils'
import openRekordboxDesktopCreateNodeDialog from './rekordboxDesktopCreateNodeDialog'
import rightClickMenu from './rightClickMenu'
import confirmDialog from './confirmDialog'
import RekordboxDesktopTargetTreeItem from './rekordboxDesktopTargetTreeItem.vue'
import type {
  ExternalLibraryKind,
  ExternalLibraryMutationResponse,
  ExternalLibraryPlaylistWriteTarget
} from '@shared/externalLibrary'
import type { IPioneerPlaylistTreeNode } from '../../../types/globals'
import { t } from '@renderer/utils/translate'
import './rekordboxDesktopTargetDialog.scss'

const props = defineProps<{
  kind: ExternalLibraryKind
  sourcePath: string
  dialogTitle: string
  defaultPlaylistName: string
  trackCount?: number
  confirmCallback: (payload: { target: ExternalLibraryPlaylistWriteTarget }) => void
  cancelCallback: () => void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const nodes = ref<IPioneerPlaylistTreeNode[]>([])
const search = ref('')
const selectedId = ref('')
const loading = ref(false)
const errorMessage = ref('')
const writing = ref(false)
const expandedIds = ref(new Set<number>())
const dragSourceId = ref<number | null>(null)
const dragTarget = ref<{
  nodeId: number | null
  approach: '' | TreeDragApproach
  placement?: 'node' | 'root-end'
} | null>(null)
const visibleNodes = computed(() => filterTreeNodes(nodes.value, search.value))
const playlists = computed(() => flattenPlayableNodes(nodes.value))
const selectedNode = computed(() =>
  playlists.value.find((node) => String(node.id) === selectedId.value)
)
const selectedExternalId = computed(() => selectedNode.value?.externalId || '')
const exactMatch = computed(() =>
  playlists.value.some((node) => normalizeKeyword(node.name) === normalizeKeyword(search.value))
)

const showFailure = (message: string) => {
  errorMessage.value = message
}

const isEditable = computed(() => props.kind === 'serato')

const mutate = async (payload: Record<string, unknown>) =>
  (await window.electron.ipcRenderer.invoke('external-library:mutate', {
    kind: props.kind,
    path: props.sourcePath,
    ...payload
  })) as ExternalLibraryMutationResponse

const runMutation = async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
  if (writing.value) return undefined
  writing.value = true
  errorMessage.value = ''
  try {
    return await task()
  } catch (error) {
    showFailure(error instanceof Error ? error.message : String(error))
    return undefined
  } finally {
    writing.value = false
  }
}

const loadTree = async (preferredId = '') => {
  loading.value = true
  errorMessage.value = ''
  try {
    const result = (await window.electron.ipcRenderer.invoke('external-library:load-tree', {
      kind: props.kind,
      path: props.sourcePath
    })) as { treeNodes?: IPioneerPlaylistTreeNode[] }
    nodes.value = Array.isArray(result?.treeNodes) ? result.treeNodes : []
    const next =
      preferredId &&
      playlists.value.some((node) => String(node.id) === preferredId && node.externalId)
        ? preferredId
        : String(playlists.value.find((node) => !node.isFolder && node.externalId)?.id || '')
    selectedId.value = next
  } catch (error) {
    nodes.value = []
    selectedId.value = ''
    showFailure(error instanceof Error ? error.message : String(error))
  } finally {
    loading.value = false
  }
}

const createPlaylist = async () => {
  const name = String(search.value || props.defaultPlaylistName || '').trim()
  if (!name || writing.value || !isEditable.value) return
  await runMutation(async () => {
    const response = await mutate({ operation: 'create-playlist', name })
    if (!response?.ok) {
      showFailure(response?.summary?.errorMessage || '创建播放列表失败。')
      return
    }
    search.value = ''
    await loadTree(String(response.summary?.playlistId || ''))
    const created = nodes.value
      .flatMap((node) => [node, ...(node.children || [])])
      .find((node) => node.externalId === response.summary?.externalId)
    if (created) selectedId.value = String(created.id)
  })
}

const createNode = async (
  operation: 'create-playlist' | 'create-folder',
  name: string,
  parentId = 0
) => {
  if (!isEditable.value || writing.value) return false
  const parent = parentId > 0 ? findNodeById(nodes.value, parentId) : null
  const result = await runMutation(async () => {
    const response = await mutate({
      operation,
      parentExternalId: parent?.externalId,
      name
    })
    if (!response.ok) {
      showFailure(response.summary.errorMessage || 'Serato 歌单操作失败。')
      return false
    }
    search.value = ''
    await loadTree(String(response.summary.playlistId || ''))
    if (parentId > 0) expandedIds.value = new Set(expandedIds.value).add(parentId)
    if (operation === 'create-folder' && response.summary.playlistId) {
      expandedIds.value = new Set(expandedIds.value).add(response.summary.playlistId)
    }
    return true
  })
  return result === true
}

const renameNode = async (node: IPioneerPlaylistTreeNode, nextName: string) => {
  if (!isEditable.value || writing.value || !node.externalId) return false
  const name = sanitizeNodeName(nextName)
  if (!name || name === sanitizeNodeName(node.name)) return true
  const result = await runMutation(async () => {
    const response = await mutate({ operation: 'rename', externalId: node.externalId, name })
    if (!response.ok) {
      showFailure(response.summary.errorMessage || 'Serato 歌单重命名失败。')
      return false
    }
    await loadTree(String(response.summary.playlistId || ''))
    return true
  })
  return result === true
}

const deleteNode = async (node: IPioneerPlaylistTreeNode) => {
  if (!isEditable.value || writing.value || !node.externalId) return false
  const result = await runMutation(async () => {
    const response = await mutate({ operation: 'delete', externalId: node.externalId })
    if (!response.ok) {
      showFailure(response.summary.errorMessage || 'Serato 歌单删除失败。')
      return false
    }
    await loadTree()
    return true
  })
  return result === true
}

const openCreatePlaylistDialog = async (parentId = 0, defaultValue = '') => {
  if (!isEditable.value || writing.value) return
  await openRekordboxDesktopCreateNodeDialog({
    dialogTitle: t('library.createSeratoPlaylistDialogTitle'),
    placeholder: t('library.seratoPlaylistNamePlaceholder'),
    defaultValue,
    confirmText: t('common.confirm'),
    confirmCallback: async (value) => await createNode('create-playlist', value, parentId)
  })
}

const openCreateFolderDialog = async (parentId = 0) => {
  if (!isEditable.value || writing.value) return
  await openRekordboxDesktopCreateNodeDialog({
    dialogTitle: t('library.createSeratoFolderTitle'),
    placeholder: t('library.seratoFolderNamePlaceholder'),
    confirmText: t('common.confirm'),
    confirmCallback: async (value) => await createNode('create-folder', value, parentId)
  })
}

const openRenameDialog = async (node: IPioneerPlaylistTreeNode) => {
  if (!isEditable.value || writing.value) return
  await openRekordboxDesktopCreateNodeDialog({
    dialogTitle: node.isFolder
      ? t('library.renameSeratoFolderTitle')
      : t('library.renameSeratoPlaylistTitle'),
    placeholder: node.isFolder
      ? t('library.seratoFolderNamePlaceholder')
      : t('library.seratoPlaylistNamePlaceholder'),
    defaultValue: node.name,
    confirmText: t('common.confirm'),
    confirmCallback: async (value) => await renameNode(node, value)
  })
}

const confirmDeleteNode = async (node: IPioneerPlaylistTreeNode) => {
  if (!isEditable.value || writing.value) return
  const lines = node.isFolder
    ? (() => {
        const descendants = countNodeDescendants(node)
        const content = [
          t('library.deleteSeratoFolderConfirmLine1', { name: node.name }),
          t('library.deleteSeratoFolderConfirmLine2')
        ]
        if (descendants.folderCount || descendants.playlistCount) {
          content.push(t('library.deleteSeratoFolderDescendants', descendants))
        }
        return content
      })()
    : [
        t('library.deleteSeratoPlaylistConfirmLine1', { name: node.name }),
        t('library.deleteSeratoPlaylistConfirmLine2')
      ]
  const result = await confirmDialog({
    title: node.isFolder
      ? t('library.deleteSeratoFolderTitle')
      : t('library.deleteSeratoPlaylistTitle'),
    content: lines,
    innerWidth: 620,
    innerHeight: 0,
    textAlign: 'left'
  })
  if (result === 'confirm') await deleteNode(node)
}

const openRootContextMenu = async (event: MouseEvent) => {
  if (!isEditable.value || writing.value) return
  const result = await rightClickMenu({
    menuArr: [[{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]],
    clickEvent: event
  })
  if (result === 'cancel') return
  if (result.menuName === 'library.createPlaylist') await openCreatePlaylistDialog()
  else if (result.menuName === 'library.createFolder') await openCreateFolderDialog()
}

const openNodeContextMenu = async (event: MouseEvent, node: IPioneerPlaylistTreeNode) => {
  if (!isEditable.value || writing.value || node.isSmartPlaylist || !node.externalId) return
  const menuArr = node.isFolder
    ? [
        [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }],
        [{ menuName: 'common.rename' }, { menuName: 'rekordboxDesktop.deleteFolderAction' }]
      ]
    : [[{ menuName: 'common.rename' }, { menuName: 'playlist.deletePlaylist' }]]
  const result = await rightClickMenu({ menuArr, clickEvent: event })
  if (result === 'cancel') return
  if (result.menuName === 'library.createPlaylist') await openCreatePlaylistDialog(node.id)
  else if (result.menuName === 'library.createFolder') await openCreateFolderDialog(node.id)
  else if (result.menuName === 'common.rename') await openRenameDialog(node)
  else await confirmDeleteNode(node)
}

const resetDragState = () => {
  dragSourceId.value = null
  dragTarget.value = null
}

const rejectDrop = (event: DragEvent) => {
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
  dragTarget.value = null
}

const handleDragStartNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  if (
    !isEditable.value ||
    writing.value ||
    normalizeKeyword(search.value) ||
    !isMovableTreeNode(node)
  ) {
    event.preventDefault()
    return
  }
  dragSourceId.value = node.id
  dragTarget.value = null
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(node.id))
  }
}

const updateDragTarget = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  if (
    !isEditable.value ||
    writing.value ||
    normalizeKeyword(search.value) ||
    dragSourceId.value === null ||
    !isMovableTreeNode(node) ||
    node.id === dragSourceId.value ||
    isDescendantNode(nodes.value, dragSourceId.value, node.id)
  ) {
    rejectDrop(event)
    return
  }
  const approach = calculateDragApproach(event.offsetY, node.isFolder)
  if (approach === 'center' && !node.isFolder) {
    rejectDrop(event)
    return
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragTarget.value = { nodeId: node.id, approach, placement: 'node' }
}

const persistMove = async (moved: MoveTreeNodeResult) => {
  const previousTree = cloneTreeNodes(nodes.value)
  nodes.value = moved.nodes
  const result = await runMutation(async () => {
    const movedNode = findNodeById(moved.nodes, moved.playlistId)
    const parentNode = moved.parentId > 0 ? findNodeById(moved.nodes, moved.parentId) : null
    const response = await mutate({
      operation: 'move',
      externalId: movedNode?.externalId,
      parentExternalId: parentNode?.externalId,
      name: movedNode?.name,
      seq: moved.seq
    })
    if (!response.ok) {
      showFailure(response.summary.errorMessage || 'Serato 歌单移动失败。')
      return false
    }
    await loadTree(String(moved.playlistId))
    return true
  })
  if (result !== true) nodes.value = previousTree
}

const handleDragOverNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) =>
  updateDragTarget(event, node)
const handleDragEnterNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) =>
  updateDragTarget(event, node)
const handleDragLeaveNode = (_event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  if (!writing.value && dragTarget.value?.nodeId === node.id) dragTarget.value = null
}
const handleDragEndNode = () => resetDragState()

const handleDropNode = async (_event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  const sourceId = dragSourceId.value
  const approach = dragTarget.value?.approach
  resetDragState()
  if (!isEditable.value || writing.value || sourceId === null || !approach) return
  const moved = moveTreeNode(nodes.value, sourceId, node.id, approach)
  if (moved) await persistMove(moved)
}

const updateRootDropTarget = (event: DragEvent) => {
  const source = dragSourceId.value === null ? null : findNodeById(nodes.value, dragSourceId.value)
  if (
    !isEditable.value ||
    writing.value ||
    normalizeKeyword(search.value) ||
    !isMovableTreeNode(source)
  ) {
    rejectDrop(event)
    return
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragTarget.value = { nodeId: null, approach: 'bottom', placement: 'root-end' }
}

const handleDragLeaveRootEnd = () => {
  if (!writing.value && dragTarget.value?.placement === 'root-end') dragTarget.value = null
}

const handleDropRootEnd = async () => {
  const sourceId = dragSourceId.value
  const isRootDrop = dragTarget.value?.placement === 'root-end'
  resetDragState()
  if (!isEditable.value || writing.value || sourceId === null || !isRootDrop) return
  const moved = moveTreeNodeToRootEnd(nodes.value, sourceId)
  if (moved) await persistMove(moved)
}

const toggleFolder = (node: IPioneerPlaylistTreeNode) => {
  const next = new Set(expandedIds.value)
  if (next.has(node.id)) next.delete(node.id)
  else next.add(node.id)
  expandedIds.value = next
}

const selectPlaylist = (node: IPioneerPlaylistTreeNode) => {
  if (!node.isFolder && !node.isSmartPlaylist && node.externalId) selectedId.value = String(node.id)
}

const confirm = () => {
  if (writing.value || !selectedExternalId.value || !selectedNode.value) return
  closeWithAnimation(() =>
    props.confirmCallback({
      target: {
        mode: 'append',
        externalId: selectedExternalId.value,
        playlistName: selectedNode.value?.name
      }
    })
  )
}

const cancel = () => closeWithAnimation(() => props.cancelCallback())

onMounted(() => void loadTree())
const handleKeydown = (event: KeyboardEvent) => {
  if (event.defaultPrevented) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (search.value.trim() && !exactMatch.value && !selectedExternalId.value) void createPlaylist()
    else confirm()
  }
}
window.addEventListener('keydown', handleKeydown)
onUnmounted(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <div
    class="dialog unselectable rekordboxDesktopTargetDialog"
    :class="{ 'dialog-visible': dialogVisible }"
  >
    <div class="content inner" @contextmenu.stop.prevent="openRootContextMenu">
      <div class="unselectable libraryTitle dialog-title dialog-header">
        <div class="collapseButtonPlaceholder"></div>
        <span>{{ props.dialogTitle }}</span>
        <div class="collapseButtonPlaceholder"></div>
      </div>
      <div class="dialog-body">
        <div class="librarySearchWrapper">
          <div class="searchRow">
            <input
              v-model="search"
              class="searchInput"
              :disabled="writing"
              :placeholder="props.defaultPlaylistName"
            />
            <div
              v-if="isEditable && search.trim() && !exactMatch"
              class="createNowBtn"
              @click="createPlaylist"
            >
              {{ t('library.externalWritePlaylistCreate') }}
            </div>
          </div>
        </div>
        <div class="unselectable libraryArea">
          <OverlayScrollbarsComponent
            :options="{ scrollbars: { autoHide: 'leave' as const } }"
            element="div"
            style="height: 100%; width: 100%"
            defer
          >
            <div class="sectionStack">
              <div class="sectionCard sectionCard--all">
                <div class="sectionHeader">
                  <div class="sectionTitle">
                    <span class="sectionAccent sectionAccent--all"></span
                    ><span>{{
                      props.kind === 'serato'
                        ? t('library.externalWriteSeratoSection')
                        : t('library.externalWriteTraktorSection')
                    }}</span>
                  </div>
                </div>
                <div
                  class="sectionBody sectionBody--allDrop"
                  @dragover.prevent="updateRootDropTarget"
                  @dragenter.prevent="updateRootDropTarget"
                  @dragleave="handleDragLeaveRootEnd"
                  @drop.prevent="handleDropRootEnd"
                >
                  <template v-for="item of visibleNodes" :key="String(item.id)">
                    <RekordboxDesktopTargetTreeItem
                      :node="item"
                      :expanded-ids="expandedIds"
                      :selected-playlist-id="Number(selectedId) || 0"
                      :interaction-disabled="writing"
                      :drag-target-node-id="dragTarget?.nodeId || null"
                      :drag-target-approach="dragTarget?.approach || ''"
                      :drag-source-id="dragSourceId"
                      @toggle-folder="toggleFolder"
                      @select-playlist="selectPlaylist"
                      @dbl-click-song-list="confirm"
                      @contextmenu-node="openNodeContextMenu"
                      @dragstart-node="handleDragStartNode"
                      @dragover-node="handleDragOverNode"
                      @dragenter-node="handleDragEnterNode"
                      @dragleave-node="handleDragLeaveNode"
                      @drop-node="handleDropNode"
                      @dragend-node="handleDragEndNode"
                    />
                  </template>
                  <div
                    v-if="loading || errorMessage || !visibleNodes.length"
                    class="libraryEmptyHint"
                  >
                    <span v-if="loading">{{ t('library.externalWritePlaylistLoading') }}</span
                    ><span v-else-if="errorMessage">{{ errorMessage }}</span
                    ><span v-else>{{ t('library.externalWritePlaylistEmpty') }}</span>
                  </div>
                  <div
                    v-if="!loading && visibleNodes.length > 0"
                    class="libraryDropSpace"
                    :class="{ 'libraryDropSpace--active': dragTarget?.placement === 'root-end' }"
                  ></div>
                </div>
              </div>
            </div>
          </OverlayScrollbarsComponent>
        </div>
      </div>
      <div class="dialog-footer footer-centered">
        <div
          class="button dialogActionButton"
          :class="{ disabledAction: writing || !selectedExternalId }"
          @click="confirm"
        >
          {{ t('library.externalWriteConfirm') }}
        </div>
        <div class="button dialogActionButton" :class="{ disabledAction: writing }" @click="cancel">
          {{ t('library.externalWriteCancel') }}
        </div>
      </div>
    </div>
  </div>
</template>
