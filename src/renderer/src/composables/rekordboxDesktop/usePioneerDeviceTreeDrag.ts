import { ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { useDjLibrarySongDrop } from './useDjLibrarySongDrop'
import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'
import { ensureRekordboxDesktopWriteAvailable } from '@renderer/utils/rekordboxDesktopWriteAvailability'
import { clearRekordboxSourceCachesByKind } from '@renderer/utils/rekordboxLibraryCache'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type { RekordboxDesktopMovePlaylistResponse } from '@shared/rekordboxDesktopPlaylist'
import type { ExternalLibraryKind } from '@shared/externalLibrary'
import {
  calculateDragApproach,
  cloneTreeNodes,
  findNodeById,
  isDescendantNode,
  isMovableTreeNode,
  moveTreeNode,
  moveTreeNodeToRootEnd,
  normalizeKeyword,
  type MoveTreeNodeResult,
  type TreeDragApproach
} from './useRekordboxTreeUtils'

type BoolRef = { readonly value: boolean }
type StringRef = { readonly value: string }
type TreeRef = { readonly value: IPioneerPlaylistTreeNode[] }
type SyncTreeFn = (nodes: IPioneerPlaylistTreeNode[], preferredPlaylistId?: number) => void
type RefreshTreeFn = (preferredPlaylistId?: number) => Promise<void>
type ShowFailureFn = (message: string, logPath?: string) => Promise<void>
type RunWritingFn = <T>(task: () => Promise<T>) => Promise<T>
type GetPreferredPlaylistIdFn = () => number
type ExternalTreeWriteContext = {
  enabled: BoolRef
  sourcePath: StringRef
  kind: { readonly value: ExternalLibraryKind | null }
}

export function usePioneerDeviceTreeDrag(
  originalTreeNodes: TreeRef,
  isDesktopSource: BoolRef,
  dialogWriting: BoolRef,
  playlistSearch: StringRef,
  syncRuntimeDesktopTree: SyncTreeFn,
  refreshDesktopTree: RefreshTreeFn,
  showFailureDialog: ShowFailureFn,
  runWithDialogWriting: RunWritingFn,
  getPreferredPlaylistId: GetPreferredPlaylistIdFn,
  externalTreeWrite?: ExternalTreeWriteContext
) {
  const canWriteTree = () => isDesktopSource.value || Boolean(externalTreeWrite?.enabled.value)
  const runtime = useRuntimeStore()
  const songDrop = useDjLibrarySongDrop({
    getSource: () => {
      const kind = externalTreeWrite?.enabled.value
        ? externalTreeWrite.kind.value
        : isDesktopSource.value
          ? 'desktop'
          : null
      if (!kind) return null
      return {
        kind,
        sourceKey:
          runtime.pioneerDeviceLibrary.selectedSourceKey ||
          runtime.pioneerDeviceLibrary.selectedSourceRootPath ||
          'rekordbox',
        sourcePath: externalTreeWrite?.enabled.value
          ? externalTreeWrite.sourcePath.value
          : runtime.pioneerDeviceLibrary.selectedSourceRootPath
      }
    },
    isWriting: dialogWriting,
    runWriting: runWithDialogWriting,
    refreshTree: refreshDesktopTree,
    showFailure: showFailureDialog
  })
  const dragSourceId = ref<number | null>(null)
  const dragTarget = ref<{
    nodeId: number | null
    approach: '' | TreeDragApproach
    placement?: 'node' | 'root-end'
  } | null>(null)
  const suppressClickUntilMs = ref(0)

  const resetDragState = () => {
    dragSourceId.value = null
    dragTarget.value = null
  }

  const suppressClickAfterDrag = () => {
    suppressClickUntilMs.value = Date.now() + 450
  }

  const shouldSuppressClick = () => suppressClickUntilMs.value > Date.now()

  const setUnavailableDrop = (event: DragEvent) => {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    dragTarget.value = null
  }

  const handleDragStartNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    if (
      !canWriteTree() ||
      dialogWriting.value ||
      (externalTreeWrite?.enabled.value && !node.externalId) ||
      !isMovableTreeNode(node) ||
      normalizeKeyword(playlistSearch.value)
    ) {
      event.preventDefault()
      return
    }
    dragSourceId.value = node.id
    dragTarget.value = null
    suppressClickAfterDrag()
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(node.id))
    }
  }

  const updateDragTarget = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    if (songDrop.isSongDrag(event)) {
      dragTarget.value = songDrop.handleDragOver(event, node)
        ? { nodeId: node.id, approach: 'center', placement: 'node' }
        : null
      return
    }
    if (!canWriteTree() || dialogWriting.value) {
      setUnavailableDrop(event)
      return
    }
    if (!event.dataTransfer || dragSourceId.value === null) return
    if (
      (externalTreeWrite?.enabled.value && !node.externalId) ||
      !isMovableTreeNode(node) ||
      normalizeKeyword(playlistSearch.value)
    ) {
      setUnavailableDrop(event)
      return
    }
    if (
      node.id === dragSourceId.value ||
      isDescendantNode(originalTreeNodes.value, dragSourceId.value, node.id)
    ) {
      setUnavailableDrop(event)
      return
    }
    const row = event.currentTarget as HTMLElement | null
    if (!row) return
    const approach = calculateDragApproach(
      event.clientY - row.getBoundingClientRect().top,
      node.isFolder
    )
    if (approach === 'center' && !node.isFolder) {
      setUnavailableDrop(event)
      return
    }
    event.dataTransfer.dropEffect = 'move'
    dragTarget.value = {
      nodeId: node.id,
      approach,
      placement: 'node'
    }
  }

  const updateRootEndDragTarget = (event: DragEvent) => {
    if (songDrop.isSongDrag(event)) {
      setUnavailableDrop(event)
      return
    }
    if (!canWriteTree() || dialogWriting.value) {
      setUnavailableDrop(event)
      return
    }
    if (!event.dataTransfer || dragSourceId.value === null) return
    const sourceNode = findNodeById(originalTreeNodes.value, dragSourceId.value)
    if (!isMovableTreeNode(sourceNode) || normalizeKeyword(playlistSearch.value)) {
      setUnavailableDrop(event)
      return
    }
    event.dataTransfer.dropEffect = 'move'
    dragTarget.value = {
      nodeId: null,
      approach: 'bottom',
      placement: 'root-end'
    }
  }

  const persistMovedTree = async (moved: MoveTreeNodeResult) => {
    const previousTree = cloneTreeNodes(originalTreeNodes.value)
    const preferredPlaylistId = getPreferredPlaylistId()
    syncRuntimeDesktopTree(moved.nodes, preferredPlaylistId)

    await runWithDialogWriting(async () => {
      if (externalTreeWrite?.enabled.value) {
        const movedNode = findNodeById(moved.nodes, moved.playlistId)
        const parentNode = moved.parentId > 0 ? findNodeById(moved.nodes, moved.parentId) : null
        const response = (await window.electron.ipcRenderer.invoke('external-library:mutate', {
          kind: externalTreeWrite.kind.value,
          path: externalTreeWrite.sourcePath.value,
          operation: 'move',
          externalId: movedNode?.externalId,
          parentExternalId: parentNode?.externalId,
          name: movedNode?.name,
          seq: moved.seq
        })) as { ok: boolean; summary: { errorMessage?: string } }
        if (!response.ok) {
          syncRuntimeDesktopTree(previousTree, preferredPlaylistId)
          await showFailureDialog(response.summary.errorMessage || '外部歌单移动失败。')
          return
        }
        await refreshDesktopTree(0)
        return
      }
      if (!(await ensureRekordboxDesktopWriteAvailable('move'))) {
        syncRuntimeDesktopTree(previousTree, preferredPlaylistId)
        return
      }

      const response = (await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('desktop', 'move-playlist'),
        {
          playlistId: moved.playlistId,
          parentId: moved.parentId,
          seq: moved.seq
        }
      )) as RekordboxDesktopMovePlaylistResponse

      if (!response.ok) {
        syncRuntimeDesktopTree(previousTree, preferredPlaylistId)
        await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
        return
      }

      clearRekordboxSourceCachesByKind('desktop')
      await refreshDesktopTree(preferredPlaylistId)
    })
  }

  const handleDragOverNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    updateDragTarget(event, node)
  }

  const handleDragEnterNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    updateDragTarget(event, node)
  }

  const handleDragLeaveNode = (_event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    if (dialogWriting.value) return
    if (dragTarget.value?.nodeId === node.id) {
      dragTarget.value = null
    }
  }

  const handleDragEndNode = () => {
    if (dialogWriting.value) return
    suppressClickAfterDrag()
    resetDragState()
  }

  const handleDragOverRootEnd = (event: DragEvent) => {
    updateRootEndDragTarget(event)
  }

  const handleDragEnterRootEnd = (event: DragEvent) => {
    updateRootEndDragTarget(event)
  }

  const handleDragLeaveRootEnd = () => {
    if (dialogWriting.value) return
    if (dragTarget.value?.placement === 'root-end') {
      dragTarget.value = null
    }
  }

  const handleDropNode = async (_event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    if (songDrop.isSongDrag(_event)) {
      suppressClickAfterDrag()
      resetDragState()
      await songDrop.handleDrop(_event, node)
      return
    }
    if (!canWriteTree() || dialogWriting.value) {
      suppressClickAfterDrag()
      resetDragState()
      return
    }
    if (dragSourceId.value === null || !dragTarget.value) {
      suppressClickAfterDrag()
      resetDragState()
      return
    }

    const sourceId = dragSourceId.value
    const targetState = { ...dragTarget.value }
    suppressClickAfterDrag()
    resetDragState()
    if (!targetState.approach) return

    const moved = moveTreeNode(originalTreeNodes.value, sourceId, node.id, targetState.approach)
    if (!moved) return

    await persistMovedTree(moved)
  }

  const handleDropRootEnd = async () => {
    if (!canWriteTree() || dialogWriting.value) {
      suppressClickAfterDrag()
      resetDragState()
      return
    }
    if (dragSourceId.value === null || dragTarget.value?.placement !== 'root-end') {
      suppressClickAfterDrag()
      resetDragState()
      return
    }

    const sourceId = dragSourceId.value
    suppressClickAfterDrag()
    resetDragState()

    const moved = moveTreeNodeToRootEnd(originalTreeNodes.value, sourceId)
    if (!moved) return

    await persistMovedTree(moved)
  }

  return {
    dragSourceId,
    dragTarget,
    resetDragState,
    shouldSuppressClick,
    handleDragStartNode,
    handleDragOverNode,
    handleDragEnterNode,
    handleDragLeaveNode,
    handleDragEndNode,
    handleDragOverRootEnd,
    handleDragEnterRootEnd,
    handleDragLeaveRootEnd,
    handleDropNode,
    handleDropRootEnd
  }
}
