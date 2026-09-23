import { ref, type Ref } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { clearRekordboxSourceCache } from '@renderer/utils/rekordboxLibraryCache'
import { ensureRekordboxDesktopWriteAvailable } from '@renderer/utils/rekordboxDesktopWriteAvailability'
import { t } from '@renderer/utils/translate'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { IPioneerPlaylistTreeNode, ISongInfo } from '../../../../../types/globals'
import type {
  RekordboxDesktopRemovePlaylistTracksResponse,
  RekordboxDesktopReorderPlaylistTracksResponse
} from '@shared/rekordboxDesktopPlaylist'
import type { ExternalLibraryMutationResponse, ExternalLibraryKind } from '@shared/externalLibrary'

export const usePioneerDesktopPlaylistActions = (params: {
  runtime: ReturnType<typeof useRuntimeStore>
  selectedPlaylistId: Ref<number>
  selectedExternalKind: Ref<ExternalLibraryKind | null>
  selectedSourceRootPath: Ref<string>
  selectedSourceCacheKey: Ref<string>
  currentPlaybackListKey: Ref<string>
  visibleSongs: Ref<ISongInfo[]>
  selectedRowKeys: Ref<string[]>
  loadPlaylistTracks: () => Promise<void>
}) => {
  const {
    runtime,
    selectedPlaylistId,
    selectedExternalKind,
    selectedSourceRootPath,
    selectedSourceCacheKey,
    currentPlaybackListKey,
    visibleSongs,
    selectedRowKeys,
    loadPlaylistTracks
  } = params

  const isExternalSerato = () => selectedExternalKind.value === 'serato'
  const sourceText = (rekordboxKey: string, seratoKey: string, values?: Record<string, unknown>) =>
    t(isExternalSerato() ? seratoKey : rekordboxKey, values)

  const resolveSelectedExternalPlaylistId = () => {
    const selectedId = selectedPlaylistId.value
    const walk = (nodes: IPioneerPlaylistTreeNode[]): string | undefined => {
      for (const node of nodes) {
        if (node.id === selectedId) return node.externalId
        if (node.children?.length) {
          const match = walk(node.children)
          if (match) return match
        }
      }
      return undefined
    }
    return walk(runtime.pioneerDeviceLibrary.treeNodes || [])
  }

  const invokeExternalMutation = async (payload: Record<string, unknown>) =>
    (await window.electron.ipcRenderer.invoke('external-library:mutate', {
      kind: selectedExternalKind.value,
      path: selectedSourceRootPath.value,
      externalId: resolveSelectedExternalPlaylistId(),
      ...payload
    })) as ExternalLibraryMutationResponse

  const playlistMutationPending = ref(false)

  const runWithPlaylistMutationPending = async <T>(task: () => Promise<T>): Promise<T> => {
    playlistMutationPending.value = true
    try {
      return await task()
    } finally {
      playlistMutationPending.value = false
    }
  }

  const showRekordboxFailureDialog = async (message: string, logPath?: string) => {
    const content = [
      sourceText('rekordboxDesktop.failedReason', 'library.externalLibraryFailedReason', {
        message: message || t('common.unknownError')
      })
    ]
    if (logPath) {
      content.push(
        sourceText('rekordboxDesktop.failureLogHint', 'library.externalLibraryFailureLogHint', {
          path: logPath
        })
      )
    }
    await confirm({
      title: sourceText('rekordboxDesktop.failureTitle', 'library.externalLibraryFailureTitle'),
      content,
      confirmShow: false,
      innerWidth: 620,
      innerHeight: 0,
      textAlign: 'left',
      canCopyText: Boolean(logPath)
    })
  }

  const syncPlaybackListFromVisibleSongs = () => {
    if (runtime.playingData.playingSongListUUID !== currentPlaybackListKey.value) return
    runtime.playingData.playingSongListData = [...visibleSongs.value]
  }

  const sortRowKeysByVisibleSongs = (rowKeys: string[]) => {
    const indexMap = new Map<string, number>()
    visibleSongs.value.forEach((item, index) => {
      const key = String(item.mixtapeItemId || '').trim()
      if (!key || indexMap.has(key)) return
      indexMap.set(key, index)
    })
    return [...rowKeys].sort((left, right) => {
      const leftIndex = indexMap.get(left)
      const rightIndex = indexMap.get(right)
      if (leftIndex === undefined && rightIndex === undefined) return 0
      if (leftIndex === undefined) return 1
      if (rightIndex === undefined) return -1
      return leftIndex - rightIndex
    })
  }

  const removeTracksFromDesktopPlaylist = async (selectedTracks: ISongInfo[], enabled: boolean) => {
    if (!enabled) return
    const playlistId = selectedPlaylistId.value
    const rowKeys = selectedTracks
      .map((item) => String(item.mixtapeItemId || '').trim())
      .filter(Boolean)
    if (!playlistId || rowKeys.length === 0) return

    const confirmContent =
      rowKeys.length === 1
        ? [
            sourceText(
              'rekordboxDesktop.removeTrackFromPlaylistConfirmLine1',
              'library.removeTrackFromSeratoPlaylistConfirmLine1',
              {
                name: selectedTracks[0]?.title || t('tracks.unknownTrack')
              }
            ),
            sourceText(
              'rekordboxDesktop.removeTracksFromPlaylistConfirmLine2',
              'library.removeTracksFromSeratoPlaylistConfirmLine2'
            )
          ]
        : [
            sourceText(
              'rekordboxDesktop.removeTracksFromPlaylistConfirmCount',
              'library.removeTracksFromSeratoPlaylistConfirmCount',
              { count: rowKeys.length }
            ),
            sourceText(
              'rekordboxDesktop.removeTracksFromPlaylistConfirmLine2',
              'library.removeTracksFromSeratoPlaylistConfirmLine2'
            )
          ]
    const confirmResult = await confirm({
      title: sourceText(
        'rekordboxDesktop.removeTracksFromPlaylistTitle',
        'library.removeTracksFromSeratoPlaylistTitle'
      ),
      content: confirmContent,
      innerWidth: 620,
      innerHeight: 0,
      textAlign: 'left'
    })
    if (confirmResult !== 'confirm') return

    await runWithPlaylistMutationPending(async () => {
      try {
        let response:
          | ExternalLibraryMutationResponse
          | RekordboxDesktopRemovePlaylistTracksResponse
          | null
        if (isExternalSerato()) {
          response = await invokeExternalMutation({ operation: 'remove-tracks', rowKeys })
        } else {
          if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return
          response = (await window.electron.ipcRenderer.invoke(
            buildRekordboxSourceChannel('desktop', 'remove-playlist-tracks'),
            { playlistId, rowKeys }
          )) as RekordboxDesktopRemovePlaylistTracksResponse
        }

        if (!response || !response.ok) {
          if (!response) return
          await showRekordboxFailureDialog(response.summary.errorMessage, response.summary.logPath)
          return
        }

        const removedKeySet = new Set(rowKeys)
        selectedRowKeys.value = []
        if (selectedSourceCacheKey.value) {
          clearRekordboxSourceCache(selectedSourceCacheKey.value)
        }

        if (runtime.playingData.playingSongListUUID === currentPlaybackListKey.value) {
          runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.filter(
            (item) => !removedKeySet.has(String(item.mixtapeItemId || '').trim())
          )
        }

        await loadPlaylistTracks()
        syncPlaybackListFromVisibleSongs()
      } catch (error) {
        await showRekordboxFailureDialog(
          error instanceof Error ? error.message : String(error || t('common.unknownError'))
        )
      }
    })
  }

  const reorderTracksInDesktopPlaylist = async (
    sourceItemIds: string[],
    targetIndex: number,
    enabled: boolean
  ) => {
    if (!enabled) return
    const playlistId = selectedPlaylistId.value
    const rowKeys = sortRowKeysByVisibleSongs(
      sourceItemIds.map((item) => String(item || '').trim()).filter(Boolean)
    )
    if (!playlistId || rowKeys.length === 0) return

    await runWithPlaylistMutationPending(async () => {
      try {
        let response:
          | ExternalLibraryMutationResponse
          | RekordboxDesktopReorderPlaylistTracksResponse
          | null
        if (isExternalSerato()) {
          response = await invokeExternalMutation({
            operation: 'reorder-tracks',
            rowKeys,
            targetIndex
          })
        } else {
          if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return
          response = (await window.electron.ipcRenderer.invoke(
            buildRekordboxSourceChannel('desktop', 'reorder-playlist-tracks'),
            { playlistId, rowKeys, targetIndex }
          )) as RekordboxDesktopReorderPlaylistTracksResponse
        }

        if (!response || !response.ok) {
          if (!response) return
          await showRekordboxFailureDialog(response.summary.errorMessage, response.summary.logPath)
          return
        }

        if (selectedSourceCacheKey.value) {
          clearRekordboxSourceCache(selectedSourceCacheKey.value)
        }

        await loadPlaylistTracks()
        selectedRowKeys.value = rowKeys
        syncPlaybackListFromVisibleSongs()
      } catch (error) {
        await showRekordboxFailureDialog(
          error instanceof Error ? error.message : String(error || t('common.unknownError'))
        )
      }
    })
  }

  const renumberTracksInDesktopPlaylist = async (orderedSongs: ISongInfo[], enabled: boolean) => {
    if (!enabled) return
    const playlistId = selectedPlaylistId.value
    const rowKeys = orderedSongs
      .map((item) => String(item.mixtapeItemId || '').trim())
      .filter(Boolean)
    if (!playlistId || rowKeys.length <= 1) return

    await runWithPlaylistMutationPending(async () => {
      try {
        let response:
          | ExternalLibraryMutationResponse
          | RekordboxDesktopReorderPlaylistTracksResponse
          | null
        if (isExternalSerato()) {
          response = await invokeExternalMutation({
            operation: 'reorder-tracks',
            rowKeys,
            targetIndex: 0
          })
        } else {
          if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return
          response = (await window.electron.ipcRenderer.invoke(
            buildRekordboxSourceChannel('desktop', 'reorder-playlist-tracks'),
            { playlistId, rowKeys, targetIndex: 0 }
          )) as RekordboxDesktopReorderPlaylistTracksResponse
        }

        if (!response || !response.ok) {
          if (!response) return
          await showRekordboxFailureDialog(response.summary.errorMessage, response.summary.logPath)
          return
        }

        if (selectedSourceCacheKey.value) {
          clearRekordboxSourceCache(selectedSourceCacheKey.value)
        }

        await loadPlaylistTracks()
        selectedRowKeys.value = rowKeys
        syncPlaybackListFromVisibleSongs()
      } catch (error) {
        await showRekordboxFailureDialog(
          error instanceof Error ? error.message : String(error || t('common.unknownError'))
        )
      }
    })
  }

  return {
    playlistMutationPending,
    removeTracksFromDesktopPlaylist,
    reorderTracksInDesktopPlaylist,
    renumberTracksInDesktopPlaylist
  }
}
