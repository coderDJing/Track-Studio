import { ref, type Ref } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { IPioneerPlaylistTreeNode, ISongInfo } from 'src/types/globals'
import { isEditablePioneerUsbSong } from '@renderer/utils/pioneerUsbEditing'
import { prepareAndApplyPioneerUsbWrite } from '@renderer/utils/pioneerUsbWrite'
import emitter from '@renderer/utils/mitt'

export const usePioneerUsbPlaylistDrop = (params: {
  runtime: ReturnType<typeof useRuntimeStore>
  enabled: Ref<boolean>
  rootPath: Ref<string>
  libraryType: Ref<string>
}) => {
  const targetId = ref<number | null>(null)
  const pending = ref(false)
  const resolveSongs = (): ISongInfo[] => {
    const paths = params.runtime.draggingSongFilePaths
    const rowKeys = new Set(params.runtime.dragSourceMixtapeItemIds)
    const songs = params.runtime.playingData.playingSongListData.filter(
      (song) => rowKeys.has(song.mixtapeItemId || '') && paths.includes(song.filePath)
    )
    if (
      !paths.length ||
      !rowKeys.size ||
      songs.length !== paths.length ||
      songs.some(
        (song) =>
          !isEditablePioneerUsbSong(song) ||
          song.pioneerUsbSource?.rootPath !== params.rootPath.value ||
          song.pioneerUsbSource.libraryType !== params.libraryType.value
      )
    )
      return []
    return songs
  }
  const accepts = (node: IPioneerPlaylistTreeNode) =>
    params.enabled.value &&
    !pending.value &&
    params.runtime.songDragActive &&
    !node.isFolder &&
    !node.isSmartPlaylist &&
    node.id > 0 &&
    resolveSongs().length > 0
  const dragOver = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    if (!params.runtime.songDragActive) return false
    targetId.value = accepts(node) ? node.id : null
    if (event.dataTransfer) event.dataTransfer.dropEffect = targetId.value ? 'copy' : 'none'
    return true
  }
  const drop = async (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    if (!params.runtime.songDragActive) return false
    targetId.value = null
    if (!accepts(node)) return true
    const songs = resolveSongs()
    const source = songs[0].pioneerUsbSource!
    const rootPath = params.rootPath.value
    const libraryType = source.libraryType
    pending.value = true
    try {
      const result = await prepareAndApplyPioneerUsbWrite(
        {
          rootPath,
          libraryType,
          operation: {
            kind: 'add-to-playlist',
            playlistId: node.id,
            trackIds: songs.map((song) => song.pioneerUsbSource!.trackId)
          }
        },
        node.name
      )
      if (result) emitter.emit('pioneerUsb/changed', { rootPath, analysisUnchanged: true })
    } finally {
      pending.value = false
    }
    return true
  }
  return { targetId, pending, dragOver, drop }
}
