import { nextTick } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import {
  createPioneerUsbPlaylistDeleteRequest,
  matchesPioneerUsbPlaylistDeleteRequest,
  type PioneerUsbPlaylistDeleteRequest
} from '@renderer/utils/pioneerUsbPlaylistRequest'
import type { IPioneerPlaylistTreeNode } from 'src/types/globals'

export const usePioneerUsbPlaylistDelete = (
  runtime: ReturnType<typeof useRuntimeStore>,
  isExternalSource: () => boolean
) => {
  const source = () => ({
    sourceKind: runtime.pioneerDeviceLibrary.selectedSourceKind || '',
    sourceKey: runtime.pioneerDeviceLibrary.selectedSourceKey || '',
    rootPath: runtime.pioneerDeviceLibrary.selectedSourceRootPath || '',
    libraryType: runtime.pioneerDeviceLibrary.selectedLibraryType || '',
    external: isExternalSource()
  })
  const createRequest = (node: IPioneerPlaylistTreeNode) =>
    createPioneerUsbPlaylistDeleteRequest(source(), node)

  const open = async (request: PioneerUsbPlaylistDeleteRequest | null, playlistId: number) => {
    if (!matchesPioneerUsbPlaylistDeleteRequest(request, source(), playlistId)) return
    // Select the target directly: the ordinary click handler toggles the selected node off.
    runtime.pioneerDeviceLibrary.selectedPlaylistId = playlistId
    await nextTick()
    if (
      !matchesPioneerUsbPlaylistDeleteRequest(
        request,
        source(),
        runtime.pioneerDeviceLibrary.selectedPlaylistId
      )
    )
      return
    emitter.emit('pioneerUsb/open-delete-playlist', request)
  }
  return { createRequest, open }
}
