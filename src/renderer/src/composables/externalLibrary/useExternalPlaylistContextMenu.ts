import { ref } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'

export const useExternalPlaylistContextMenu = () => {
  const contextMenuNodeId = ref<number>()
  let activeMenu: symbol | null = null

  const showNodeContextMenu = async (
    nodeId: number,
    args: Parameters<typeof rightClickMenu>[0]
  ) => {
    const menu = Symbol()
    activeMenu = menu
    contextMenuNodeId.value = nodeId
    try {
      return await rightClickMenu(args)
    } finally {
      if (activeMenu === menu) {
        activeMenu = null
        contextMenuNodeId.value = undefined
      }
    }
  }

  return { contextMenuNodeId, showNodeContextMenu }
}
