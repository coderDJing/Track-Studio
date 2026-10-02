<script setup lang="ts">
import { computed } from 'vue'
import listIconAsset from '@renderer/assets/listIcon.svg?asset'
import type { IPioneerPlaylistTreeNode } from '../../../types/globals'

const listIcon = listIconAsset

const props = defineProps<{
  node: IPioneerPlaylistTreeNode
  depth?: number
  expandedIds: Set<number>
  selectedPlaylistId: number
  interactionDisabled?: boolean
  dragTargetNodeId?: number | null
  dragTargetApproach?: '' | 'top' | 'center' | 'bottom'
  dragSourceId?: number | null
}>()

defineOptions({
  name: 'RekordboxDesktopTargetTreeItem'
})

const emit = defineEmits<{
  toggleFolder: [node: IPioneerPlaylistTreeNode]
  selectPlaylist: [node: IPioneerPlaylistTreeNode]
  dblClickSongList: [node: IPioneerPlaylistTreeNode]
  contextmenuNode: [event: MouseEvent, node: IPioneerPlaylistTreeNode]
  dragstartNode: [event: DragEvent, node: IPioneerPlaylistTreeNode]
  dragoverNode: [event: DragEvent, node: IPioneerPlaylistTreeNode]
  dragenterNode: [event: DragEvent, node: IPioneerPlaylistTreeNode]
  dragleaveNode: [event: DragEvent, node: IPioneerPlaylistTreeNode]
  dropNode: [event: DragEvent, node: IPioneerPlaylistTreeNode]
  dragendNode: [event: DragEvent, node: IPioneerPlaylistTreeNode]
}>()

const hasChildren = computed(
  () => Array.isArray(props.node.children) && props.node.children.length > 0
)
const isExpanded = computed(() =>
  props.node.isFolder ? props.expandedIds.has(props.node.id) : false
)
const indentWidth = computed(() => `${Math.max(0, Number(props.depth) || 0) * 10}px`)
const isSelected = computed(
  () =>
    !props.node.isFolder &&
    !props.node.isSmartPlaylist &&
    props.selectedPlaylistId === props.node.id
)
const dragApproach = computed(() =>
  props.dragTargetNodeId === props.node.id ? props.dragTargetApproach || '' : ''
)
const isDragging = computed(() => props.dragSourceId === props.node.id)
const canDrag = computed(
  () => !props.node.isSmartPlaylist && !props.node.isAllTracks && !!props.node.name
)

const handleClick = () => {
  if (props.interactionDisabled) return
  if (props.node.isFolder) {
    emit('toggleFolder', props.node)
    return
  }
  if (props.node.isSmartPlaylist) return
  emit('selectPlaylist', props.node)
}

const handleDblClick = () => {
  if (props.interactionDisabled) return
  if (props.node.isFolder || props.node.isSmartPlaylist) return
  emit('dblClickSongList', props.node)
}

const handleContextmenu = (event: MouseEvent) => {
  if (props.interactionDisabled) return
  if (props.node.isSmartPlaylist) return
  emit('contextmenuNode', event, props.node)
}

const handleChildContextmenu = (event: MouseEvent, node: IPioneerPlaylistTreeNode) => {
  emit('contextmenuNode', event, node)
}

const handleChildDragStart = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  emit('dragstartNode', event, node)
}

const handleChildDragOver = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  emit('dragoverNode', event, node)
}

const handleChildDragEnter = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  emit('dragenterNode', event, node)
}

const handleChildDragLeave = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  emit('dragleaveNode', event, node)
}

const handleChildDrop = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  emit('dropNode', event, node)
}

const handleChildDragEnd = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  emit('dragendNode', event, node)
}

const handleDragStart = (event: DragEvent) => {
  if (props.interactionDisabled || !canDrag.value) {
    event.preventDefault()
    return
  }
  emit('dragstartNode', event, props.node)
}
</script>

<template>
  <div class="rekordbox-dialog-item">
    <div
      class="mainBody"
      :style="{ paddingLeft: indentWidth }"
      :class="{
        selectedDir: isSelected,
        borderTop: dragApproach === 'top',
        borderBottom: dragApproach === 'bottom',
        borderCenter: dragApproach === 'center',
        dragging: isDragging,
        disabled: interactionDisabled
      }"
      :draggable="canDrag && !interactionDisabled"
      @click.stop="handleClick"
      @dblclick.stop="handleDblClick"
      @contextmenu.stop.prevent="handleContextmenu"
      @dragstart.stop="handleDragStart"
      @dragover.stop.prevent="emit('dragoverNode', $event, node)"
      @dragenter.stop.prevent="emit('dragenterNode', $event, node)"
      @dragleave.stop="emit('dragleaveNode', $event, node)"
      @drop.stop.prevent="emit('dropNode', $event, node)"
      @dragend.stop="emit('dragendNode', $event, node)"
    >
      <div class="prefixIcon">
        <svg
          v-if="node.isFolder && !isExpanded"
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
          v-else-if="node.isFolder"
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
        <img v-else class="songlist-icon" :src="listIcon" />
      </div>
      <div class="nameBox">
        <div class="nameRow">
          <span class="nameText">{{ node.name }}</span>
          <span v-if="node.isSmartPlaylist" class="smartBadge">Smart</span>
        </div>
      </div>
    </div>

    <div v-if="node.isFolder && isExpanded && hasChildren">
      <template v-for="child of node.children" :key="`${child.id}`">
        <RekordboxDesktopTargetTreeItem
          :node="child"
          :depth="(depth || 0) + 1"
          :expanded-ids="expandedIds"
          :selected-playlist-id="selectedPlaylistId"
          :interaction-disabled="interactionDisabled"
          :drag-target-node-id="dragTargetNodeId"
          :drag-target-approach="dragTargetApproach"
          :drag-source-id="dragSourceId"
          @toggle-folder="emit('toggleFolder', $event)"
          @select-playlist="emit('selectPlaylist', $event)"
          @dbl-click-song-list="emit('dblClickSongList', $event)"
          @contextmenu-node="handleChildContextmenu"
          @dragstart-node="handleChildDragStart"
          @dragover-node="handleChildDragOver"
          @dragenter-node="handleChildDragEnter"
          @dragleave-node="handleChildDragLeave"
          @drop-node="handleChildDrop"
          @dragend-node="handleChildDragEnd"
        />
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
.mainBody {
  display: flex;
  box-sizing: border-box;

  &:hover {
    background-color: var(--hover);
  }
}

.selectedDir {
  background-color: var(--hover);

  &:hover {
    background-color: var(--hover) !important;
  }
}

.dragging {
  opacity: 0.5;
}

.disabled {
  pointer-events: none;
  opacity: 0.7;
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

.prefixIcon {
  color: var(--text);
  width: 20px;
  min-width: 20px;
  height: 23px;
  display: flex;
  justify-content: center;
  align-items: center;
}

.songlist-icon {
  width: 13px;
  height: 13px;
}

.nameBox {
  height: 23px;
  width: calc(100% - 20px);
}

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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.smartBadge {
  flex: 0 0 auto;
  min-width: 38px;
  height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  background-color: var(--hover);
  color: var(--text-weak);
}
</style>
