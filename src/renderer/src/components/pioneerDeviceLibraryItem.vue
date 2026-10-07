<script setup lang="ts">
import { computed } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import listIconAsset from '@renderer/assets/listIcon.svg?asset'
import type { IPioneerPlaylistTreeNode } from '../../../types/globals'

const listIconMaskStyle = {
  '--icon-mask': `url("${listIconAsset}")`
}

const runtime = useRuntimeStore()

const props = defineProps({
  node: {
    type: Object as () => IPioneerPlaylistTreeNode,
    required: true
  },
  depth: {
    type: Number,
    default: 0
  },
  expandedIds: {
    type: Object as () => Set<number>,
    required: true
  },
  filterText: {
    type: String,
    default: ''
  },
  interactionDisabled: {
    type: Boolean,
    default: false
  },
  draggableNodes: {
    type: Boolean,
    default: false
  },
  contextmenuEnabled: {
    type: Boolean,
    default: false
  },
  contextMenuNodeId: {
    type: Number,
    default: undefined
  },
  dragTargetNodeId: {
    type: Number,
    default: null
  },
  dragTargetApproach: {
    type: String as () => '' | 'top' | 'center' | 'bottom',
    default: ''
  },
  dragSourceId: {
    type: Number,
    default: null
  }
})

const emit = defineEmits<{
  toggleFolder: [node: IPioneerPlaylistTreeNode]
  selectPlaylist: [node: IPioneerPlaylistTreeNode]
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
const paddingLeft = computed(() => `${Math.max(0, props.depth) * 10}px`)
const isSelected = computed(
  () => !props.node.isFolder && runtime.pioneerDeviceLibrary.selectedPlaylistId === props.node.id
)
const dragApproach = computed(() =>
  props.dragTargetNodeId === props.node.id ? props.dragTargetApproach || '' : ''
)
const isDragging = computed(() => props.dragSourceId === props.node.id)
const canDrag = computed(
  () =>
    props.draggableNodes &&
    !props.interactionDisabled &&
    !props.node.isSmartPlaylist &&
    !!props.node.name
)

const handleClick = () => {
  if (props.interactionDisabled) return
  if (props.node.isFolder) {
    emit('toggleFolder', props.node)
    return
  }
  emit('selectPlaylist', props.node)
}

const handleContextmenu = (event: MouseEvent) => {
  if (props.interactionDisabled || !props.contextmenuEnabled || props.node.isSmartPlaylist) return
  emit('contextmenuNode', event, props.node)
}

const handleDragStart = (event: DragEvent) => {
  if (!canDrag.value) {
    event.preventDefault()
    return
  }
  emit('dragstartNode', event, props.node)
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
</script>

<template>
  <div class="pioneer-tree-item">
    <div
      class="mainBody"
      style="display: flex; box-sizing: border-box"
      :style="{ paddingLeft }"
      :class="{
        selectedDir: isSelected,
        rightClickBorder: contextMenuNodeId === node.id,
        borderTop: dragApproach === 'top',
        borderBottom: dragApproach === 'bottom',
        borderCenter: dragApproach === 'center',
        dragging: isDragging,
        disabled: interactionDisabled
      }"
      :draggable="canDrag"
      @click.stop="handleClick"
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
        <span v-else class="library-list-icon" :style="listIconMaskStyle"></span>
      </div>
      <div style="height: 23px; width: calc(100% - 20px)">
        <div class="nameRow">
          <span class="nameText">{{ node.name }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="node.isFolder && isExpanded && hasChildren"
      style="width: 100%; box-sizing: border-box"
    >
      <template v-for="child of node.children" :key="`${child.id}:${child.order}`">
        <pioneerDeviceLibraryItem
          :node="child"
          :depth="depth + 1"
          :expanded-ids="expandedIds"
          :filter-text="filterText"
          :interaction-disabled="interactionDisabled"
          :draggable-nodes="draggableNodes"
          :contextmenu-enabled="contextmenuEnabled"
          :context-menu-node-id="contextMenuNodeId"
          :drag-target-node-id="dragTargetNodeId"
          :drag-target-approach="dragTargetApproach"
          :drag-source-id="dragSourceId"
          @toggle-folder="emit('toggleFolder', $event)"
          @select-playlist="emit('selectPlaylist', $event)"
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

.rightClickBorder {
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
</style>
