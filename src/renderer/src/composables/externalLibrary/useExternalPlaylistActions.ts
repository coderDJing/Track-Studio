import type { Ref, ComputedRef } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import {
  findNodeById,
  sanitizeNodeName
} from '@renderer/composables/rekordboxDesktop/useRekordboxTreeUtils'
import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'
import type { ExternalLibraryMutationResponse } from '@shared/externalLibrary'

type RunWriting = <T>(task: () => Promise<T>) => Promise<T>
type RefreshTree = (preferredPlaylistId?: number) => Promise<void>
type ShowFailure = (message: string) => Promise<void>

export const useExternalPlaylistActions = (params: {
  runtime: ReturnType<typeof useRuntimeStore>
  originalTreeNodes: ComputedRef<IPioneerPlaylistTreeNode[]>
  playlistSearch: Ref<string>
  isExternalSource: ComputedRef<boolean>
  isEditableSource: ComputedRef<boolean>
  dialogWriting: Ref<boolean>
  runWithDialogWriting: RunWriting
  refreshTree: RefreshTree
  showFailureDialog: ShowFailure
}) => {
  const {
    runtime,
    originalTreeNodes,
    playlistSearch,
    isExternalSource,
    isEditableSource,
    dialogWriting,
    runWithDialogWriting,
    refreshTree,
    showFailureDialog
  } = params

  const mutate = async (payload: Record<string, unknown>) =>
    (await window.electron.ipcRenderer.invoke('external-library:mutate', {
      kind: runtime.externalDjLibrary.selectedKind,
      path: runtime.externalDjLibrary.selectedSourcePath,
      ...payload
    })) as ExternalLibraryMutationResponse

  const runMutation = async (task: () => Promise<boolean>) => {
    try {
      return await task()
    } catch (error) {
      await showFailureDialog(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  const create = async (
    operation: 'create-playlist' | 'create-folder',
    name: string,
    parentId: number
  ) => {
    if (!isEditableSource.value || !isExternalSource.value || dialogWriting.value) return false
    const parent = parentId > 0 ? findNodeById(originalTreeNodes.value, parentId) : null
    return await runMutation(() =>
      runWithDialogWriting(async () => {
        const response = await mutate({
          operation,
          parentExternalId: parent?.externalId,
          name
        })
        if (!response.ok) {
          await showFailureDialog(response.summary.errorMessage)
          return false
        }
        playlistSearch.value = ''
        await refreshTree(response.summary.playlistId || 0)
        return true
      })
    )
  }

  const rename = async (node: IPioneerPlaylistTreeNode, nextName: string) => {
    if (!isEditableSource.value || !isExternalSource.value || dialogWriting.value) return false
    const name = sanitizeNodeName(nextName)
    if (!node.externalId || !name || name === sanitizeNodeName(node.name)) return true
    return await runMutation(() =>
      runWithDialogWriting(async () => {
        const response = await mutate({ operation: 'rename', externalId: node.externalId, name })
        if (!response.ok) {
          await showFailureDialog(response.summary.errorMessage)
          return false
        }
        await refreshTree(response.summary.playlistId || 0)
        return true
      })
    )
  }

  const remove = async (node: IPioneerPlaylistTreeNode) => {
    if (
      !isEditableSource.value ||
      !isExternalSource.value ||
      dialogWriting.value ||
      !node.externalId
    )
      return false
    return await runMutation(() =>
      runWithDialogWriting(async () => {
        const response = await mutate({ operation: 'delete', externalId: node.externalId })
        if (!response.ok) {
          await showFailureDialog(response.summary.errorMessage)
          return false
        }
        const selectedId = Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
        await refreshTree(selectedId === node.id ? 0 : response.summary.playlistId || 0)
        return true
      })
    )
  }

  return { create, rename, remove }
}
