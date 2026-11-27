<script setup lang="ts">
import { ref } from 'vue'
import type { IcloudFolderNode } from '@renderer/utils/icloudFolderTree'
import {
  icloudDirectory,
  icloudState,
  icloudDirectorySelected,
  selectIcloudDirectory,
  icloudInvoke
} from '@renderer/utils/icloudLibrary'
import { dropLocalSongsOnIcloud } from '@renderer/utils/icloudDrag'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import folderIcon from '@renderer/assets/folder.svg?asset'
import rightClickMenu from '@renderer/components/rightClickMenu'
const props = defineProps<{ node: IcloudFolderNode; depth: number }>()
const emit = defineEmits<{
  toggle: [node: IcloudFolderNode]
  retry: [node: IcloudFolderNode]
  refresh: [node: IcloudFolderNode]
}>()
const runtime = useRuntimeStore()
const anchor = ref<HTMLElement>(),
  dropHover = ref(false),
  menuOpen = ref(false),
  menuError = ref('')
async function context(event: MouseEvent) {
  const relative = props.node.relativePath,
    token = icloudState.value?.rootToken
  menuOpen.value = true
  menuError.value = ''
  try {
    const choice = await rightClickMenu({
      clickEvent: event,
      menuArr: [[{ menuName: 'tracks.showInFileExplorer' }], [{ menuName: 'icloud.refresh' }]]
    })
    if (choice === 'cancel' || token !== icloudState.value?.rootToken) return
    if (choice.menuName === 'tracks.showInFileExplorer')
      await icloudInvoke('icloud:reveal', relative, token)
    if (choice.menuName === 'icloud.refresh') emit('refresh', props.node)
  } catch (reason) {
    menuError.value = reason instanceof Error ? reason.message : 'failed'
  } finally {
    menuOpen.value = false
  }
}
function refreshAfterError() {
  menuError.value = ''
  emit('refresh', props.node)
}
function dragover(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('application/x-song-drag')) return
  event.stopPropagation()
  const allowed = props.node.residency !== 'cloud' && props.node.status !== 'unavailable'
  if (allowed) event.preventDefault()
  event.dataTransfer.dropEffect = allowed ? 'copy' : 'none'
  dropHover.value = allowed
}
function drop(event: DragEvent) {
  dropHover.value = false
  event.stopPropagation()
  event.preventDefault()
  if (props.node.residency === 'cloud' || props.node.status === 'unavailable') return
  if (
    dropLocalSongsOnIcloud(
      event,
      runtime.draggingSongFilePaths,
      props.node.relativePath,
      icloudState.value?.rootToken
    )
  )
    selectIcloudDirectory(props.node.relativePath)
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'ArrowRight' && props.node.hasChildren !== false && !props.node.expanded) {
    event.preventDefault()
    emit('toggle', props.node)
  }
  if (event.key === 'ArrowLeft' && props.node.expanded) {
    event.preventDefault()
    emit('toggle', props.node)
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    selectIcloudDirectory(props.node.relativePath)
  }
}
</script>
<template>
  <div
    role="treeitem"
    :aria-level="depth + 1"
    :aria-busy="node.status === 'loading'"
    :aria-selected="icloudDirectorySelected && icloudDirectory === node.relativePath"
    :aria-expanded="node.hasChildren === false ? undefined : node.expanded"
    :data-cloud-folder="node.relativePath"
  >
    <div
      class="cloud-folder-row"
      :class="{
        selected: icloudDirectorySelected && icloudDirectory === node.relativePath,
        'drop-hover': dropHover,
        'context-open': menuOpen
      }"
      :style="{ paddingLeft: `${depth * 12 + 8}px` }"
      tabindex="0"
      @click.stop="selectIcloudDirectory(node.relativePath)"
      @keydown.stop="keydown"
      @contextmenu.stop.prevent="context"
      @dragover="dragover"
      @dragleave="dropHover = false"
      @drop="drop"
    >
      <button
        v-if="node.hasChildren !== false"
        class="expander"
        :aria-label="t(node.expanded ? 'icloud.collapseFolder' : 'icloud.expandFolder')"
        :aria-expanded="node.expanded"
        @click.stop="emit('toggle', node)"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="currentColor"
          :style="{ transform: node.expanded ? 'rotate(90deg)' : undefined }"
          aria-hidden="true"
        >
          <path
            d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z"
          />
        </svg>
      </button>
      <span v-else class="expander-spacer" aria-hidden="true" />
      <span
        class="folder-icon"
        :style="{ '--folder-mask': `url(${JSON.stringify(folderIcon)})` }"
        aria-hidden="true"
      />
      <span ref="anchor" class="folder-name">{{ node.name }}</span>
      <span v-if="node.residency === 'cloud' && !node.expanded" class="cloud-badge">{{
        t('icloud.residency.cloud')
      }}</span>
    </div>
    <bubbleBox :dom="anchor" :title="node.relativePath || node.name" :only-when-overflow="true" />
    <div v-if="menuError" class="folder-state" role="alert">
      {{ t(`icloud.errors.${menuError}`) }}
      <button @click.stop="refreshAfterError">{{ t('icloud.refresh') }}</button>
    </div>
    <div v-if="node.expanded" role="group">
      <div v-if="node.status === 'loading'" class="folder-state" role="status">
        {{ t('common.loading') }}
      </div>
      <div
        v-else-if="node.status === 'unavailable' || node.status === 'error'"
        class="folder-state"
        role="status"
      >
        <span>{{
          t(node.error === 'download' ? 'icloud.folderNotLocal' : `icloud.errors.${node.error}`)
        }}</span>
        <button @click.stop="emit('retry', node)">{{ t('icloud.retry') }}</button>
      </div>
      <template v-else-if="node.status === 'ready'">
        <IcloudFolderTreeNode
          v-for="child in node.children"
          :key="child.relativePath"
          :node="child"
          :depth="depth + 1"
          @toggle="emit('toggle', $event)"
          @retry="emit('retry', $event)"
          @refresh="emit('refresh', $event)"
        />
        <div v-if="node.missingRoot" class="folder-state">
          {{ t('icloud.driveUnavailable') }}
        </div>
      </template>
    </div>
  </div>
</template>
<style scoped lang="scss">
.cloud-folder-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 23px;
  box-sizing: border-box;
  color: var(--text);
  font-size: 13px;
  cursor: default;
  user-select: none;
}
.cloud-folder-row:hover,
.cloud-folder-row.selected,
.cloud-folder-row.context-open {
  background: var(--hover);
}
.cloud-folder-row:focus-visible,
button:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.cloud-folder-row.drop-hover {
  box-shadow: inset 0 0 0 1px var(--accent);
}
button {
  background: transparent;
  color: inherit;
  border: 0;
  cursor: pointer;
  padding: 0 4px;
  font: inherit;
}
.expander {
  display: flex;
  align-items: center;
  padding: 0;
  flex-shrink: 0;
}
.expander-spacer {
  flex: 0 0 16px;
}
.folder-icon {
  flex: 0 0 13px;
  height: 13px;
  background: currentColor;
  mask: var(--folder-mask) center / contain no-repeat;
  -webkit-mask: var(--folder-mask) center / contain no-repeat;
}
.folder-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cloud-badge,
.folder-state {
  font-size: 11px;
  color: var(--text-weak);
}
.folder-state {
  padding: 4px 10px 4px 26px;
  overflow-wrap: anywhere;
}
</style>
