<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { createIcloudFolderTree, type IcloudFolderNode } from '@renderer/utils/icloudFolderTree'
import {
  icloudDirectory,
  icloudDirectorySelected,
  icloudState,
  icloudInvoke,
  refreshIcloudState
} from '@renderer/utils/icloudLibrary'
import type { IcloudFolderListing } from '@shared/icloudLibrary'
import { t } from '@renderer/utils/translate'
import IcloudFolderTreeNode from './IcloudFolderTreeNode.vue'
import emitter from '@renderer/utils/mitt'
const tree = createIcloudFolderTree({
  token: () => icloudState.value?.rootToken || '',
  fetch: (relative, token) => icloudInvoke<IcloudFolderListing>('icloud:folders', relative, token),
  listed: (node: IcloudFolderNode) => {
    const prefix = node.relativePath ? `${node.relativePath}/` : ''
    if (!icloudDirectory.value.startsWith(prefix) || icloudDirectory.value === node.relativePath)
      return
    const next = `${prefix}${icloudDirectory.value.slice(prefix.length).split('/')[0]}`
    if (!node.children.some((child) => child.relativePath === next)) {
      icloudDirectory.value = node.relativePath
      icloudDirectorySelected.value = false
    }
  }
})
async function refreshNode(node: IcloudFolderNode) {
  await tree.refresh(node)
  emitter.emit('icloud/refresh-directory', node.relativePath)
}
let alive = true
watch(
  () => icloudState.value?.rootToken,
  (next, previous) => {
    if (!previous || previous === next) return
    tree.reset()
    icloudDirectory.value = ''
    tree.root.name = 'iCloud Drive'
    void tree.load(tree.root)
  }
)
watch(icloudDirectory, (relative) => {
  void tree.reveal(relative)
})
const directoryChanged = (_event: unknown, data: { rootToken: string; directory: string }) => {
  if (data.rootToken !== icloudState.value?.rootToken) return
  const find = (node: IcloudFolderNode): IcloudFolderNode | undefined =>
    node.relativePath === data.directory ? node : node.children.map(find).find(Boolean)
  const node = find(tree.root)
  if (node && node.status === 'ready') void tree.refresh(node)
}
onMounted(async () => {
  window.electron.ipcRenderer.on('icloud:directory-changed', directoryChanged)
  try {
    await refreshIcloudState()
    if (!alive) return
    tree.root.name = 'iCloud Drive'
    await tree.reveal(icloudDirectory.value)
  } catch (reason) {
    if (alive) {
      tree.root.status = 'unavailable'
      tree.root.error = reason instanceof Error ? reason.message : 'unavailable'
    }
  }
})
onUnmounted(() => {
  window.electron.ipcRenderer.removeListener('icloud:directory-changed', directoryChanged)
  alive = false
  tree.dispose()
})
</script>
<template>
  <div class="icloud-folder-tree">
    <header>
      <span>{{ t('icloud.folders') }}</span
      ><button @click="refreshNode(tree.root)">{{ t('icloud.refresh') }}</button>
    </header>
    <div role="tree" :aria-label="t('icloud.folders')">
      <IcloudFolderTreeNode
        :node="tree.root"
        :depth="0"
        @toggle="tree.toggle"
        @retry="tree.load($event, true)"
        @refresh="refreshNode"
      />
    </div>
  </div>
</template>
<style scoped lang="scss">
.icloud-folder-tree {
  height: 100%;
  overflow: auto;
  background: var(--bg);
  color: var(--text);
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px;
  font-size: 12px;
  color: var(--text-weak);
}
button {
  background: transparent;
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  cursor: pointer;
  font: inherit;
}
button:focus-visible {
  outline: 1px solid var(--accent);
}
</style>
