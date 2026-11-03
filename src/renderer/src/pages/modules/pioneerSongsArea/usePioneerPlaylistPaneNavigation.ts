import type { Ref } from 'vue'
import type { IPioneerPlaylistTreeNode } from 'src/types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import { openDjPlaylist } from '@renderer/utils/djPlaylist'
import emitter from '@renderer/utils/mitt'
import { useExternalPlaylistContextMenu } from '@renderer/composables/externalLibrary/useExternalPlaylistContextMenu'
import { findNodeById } from '@renderer/composables/rekordboxDesktop/useRekordboxTreeUtils'

export function usePioneerPlaylistPaneNavigation(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  treeNodes: Ref<IPioneerPlaylistTreeNode[]>
  isBusy: () => boolean
  isEditable: () => boolean
  shouldSuppressClick: () => boolean
}) {
  const { runtime } = params
  const { contextMenuNodeId, showNodeContextMenu: showSourceMenu } =
    useExternalPlaylistContextMenu()
  const showNodeContextMenu: typeof showSourceMenu = async (nodeId, args) => {
    const sourceKey = runtime.pioneerDeviceLibrary.selectedSourceKey
    const node = findNodeById(params.treeNodes.value, nodeId)
    const result = await showSourceMenu(nodeId, {
      ...args,
      menuArr:
        node && !node.isFolder
          ? [
              [{ menuName: 'playlist.showInLeftPane' }, { menuName: 'playlist.showInRightPane' }],
              ...args.menuArr
            ]
          : args.menuArr
    })
    if (sourceKey !== runtime.pioneerDeviceLibrary.selectedSourceKey) return 'cancel'
    if (
      result !== 'cancel' &&
      (result.menuName === 'playlist.showInLeftPane' ||
        result.menuName === 'playlist.showInRightPane')
    ) {
      openDjPlaylist(
        runtime,
        nodeId,
        result.menuName === 'playlist.showInLeftPane' ? 'left' : 'right'
      )
      return 'cancel'
    }
    return result
  }
  const selectPlaylist = (node: IPioneerPlaylistTreeNode) => {
    if (params.shouldSuppressClick() || params.isBusy() || node.isFolder || node.isSmartPlaylist)
      return
    openDjPlaylist(runtime, node.id)
    if (params.isEditable() && runtime.pioneerDeviceLibrary.selectedPlaylistId === node.id) {
      emitter.emit('dj-library:refresh-selected-playlist', {
        sourceKey: runtime.pioneerDeviceLibrary.selectedSourceKey,
        playlistId: node.id
      })
      return
    }
    runtime.pioneerDeviceLibrary.selectedPlaylistId = node.id
  }
  return { contextMenuNodeId, showNodeContextMenu, selectPlaylist }
}
