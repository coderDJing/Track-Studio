import { useRuntimeStore } from '@renderer/stores/runtime'
import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'
import type { ExternalLibraryKind, ExternalLibraryMutationResponse } from '@shared/externalLibrary'
import type { RekordboxDesktopAppendExistingTracksResponse } from '@shared/rekordboxDesktopPlaylist'
import { ensureRekordboxDesktopWriteAvailable } from '@renderer/utils/rekordboxDesktopWriteAvailability'
import {
  clearRekordboxSourceCache,
  clearRekordboxSourceCachesByKind
} from '@renderer/utils/rekordboxLibraryCache'
import emitter from '@renderer/utils/mitt'

type Source = { kind: ExternalLibraryKind | 'desktop'; sourceKey: string; sourcePath: string }
type DragState = { sourceListKey: string; filePaths: string[]; rowKeys: string[] }

export const resolveDjLibrarySongDrop = (
  source: Source | null,
  state: DragState,
  node: IPioneerPlaylistTreeNode
) => {
  if (
    !source ||
    node.isFolder ||
    node.isSmartPlaylist ||
    node.isAllTracks ||
    !node.id ||
    (source.kind !== 'desktop' && !node.externalId) ||
    !state.filePaths.length
  )
    return null
  const prefix = `${source.kind}:${source.sourceKey}:`
  if (!state.sourceListKey.startsWith(prefix)) return null
  const sourcePlaylistId = Number(state.sourceListKey.slice(prefix.length))
  if (
    !Number.isSafeInteger(sourcePlaylistId) ||
    sourcePlaylistId <= 0 ||
    sourcePlaylistId === node.id
  )
    return null
  const filePaths = Array.from(new Set(state.filePaths.filter(Boolean)))
  const rowKeys = Array.from(new Set(state.rowKeys.filter(Boolean)))
  if (!filePaths.length || (source.kind === 'desktop' && !rowKeys.length)) return null
  return {
    ...source,
    sourcePlaylistId,
    playlistId: node.id,
    externalId: node.externalId,
    filePaths,
    rowKeys
  }
}

export const useDjLibrarySongDrop = (params: {
  getSource: () => Source | null
  isWriting: { readonly value: boolean }
  runWriting: <T>(task: () => Promise<T>) => Promise<T>
  refreshTree: (preferredPlaylistId?: number) => Promise<void>
  showFailure: (message: string, logPath?: string) => Promise<void>
}) => {
  const runtime = useRuntimeStore()
  const isSongDrag = (event: DragEvent) =>
    Boolean(event.dataTransfer?.types?.includes('application/x-song-drag'))
  const resolveDrop = (node: IPioneerPlaylistTreeNode) =>
    resolveDjLibrarySongDrop(
      params.getSource(),
      {
        sourceListKey: runtime.dragSourceSongListUUID,
        filePaths: [...runtime.draggingSongFilePaths],
        rowKeys: [...runtime.dragSourceMixtapeItemIds]
      },
      node
    )
  const handleDragOver = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    const accepted = !params.isWriting.value && Boolean(resolveDrop(node))
    if (event.dataTransfer) event.dataTransfer.dropEffect = accepted ? 'copy' : 'none'
    return accepted
  }
  const handleDrop = async (_event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    if (params.isWriting.value) return
    const drop = resolveDrop(node)
    if (!drop) return
    const selectedId = runtime.pioneerDeviceLibrary.selectedPlaylistId
    try {
      await params.runWriting(async () => {
        let addedCount = 0
        if (drop.kind === 'desktop') {
          if (!(await ensureRekordboxDesktopWriteAvailable('write'))) return
          const result = (await window.electron.ipcRenderer.invoke(
            'rekordbox-desktop-library:append-existing-playlist-tracks',
            {
              playlistId: drop.playlistId,
              sourcePlaylistId: drop.sourcePlaylistId,
              rowKeys: drop.rowKeys
            }
          )) as RekordboxDesktopAppendExistingTracksResponse
          if (!result.ok) {
            await params.showFailure(result.summary.errorMessage, result.summary.logPath)
            return
          }
          addedCount = result.summary.addedCount
          if (addedCount) clearRekordboxSourceCachesByKind('desktop')
        } else {
          const result = (await window.electron.ipcRenderer.invoke('external-library:mutate', {
            kind: drop.kind,
            path: drop.sourcePath,
            operation: 'append-existing-tracks',
            externalId: drop.externalId,
            sourcePlaylistId: drop.sourcePlaylistId,
            trackPaths: drop.filePaths
          })) as ExternalLibraryMutationResponse
          if (!result.ok) {
            await params.showFailure(result.summary.errorMessage)
            return
          }
          addedCount = result.summary.addedCount || 0
          if (addedCount)
            clearRekordboxSourceCache(`external-library::${drop.kind}::${drop.sourceKey}`)
        }
        if (!addedCount) return
        // Keep the source playlist selected; a successful drop only changes the destination.
        if (runtime.pioneerDeviceLibrary.selectedSourceKey !== drop.sourceKey) return
        await params.refreshTree(Number(selectedId) || 0)
        if (runtime.pioneerDeviceLibrary.selectedPlaylistId === drop.playlistId) {
          emitter.emit('dj-library:refresh-selected-playlist', {
            sourceKey: drop.sourceKey,
            playlistId: drop.playlistId
          })
        }
      })
    } catch (error) {
      console.error('[dj-library-song-drop] failed', error)
      await params.showFailure(error instanceof Error ? error.message : String(error))
    }
  }
  return { isSongDrag, handleDragOver, handleDrop }
}
