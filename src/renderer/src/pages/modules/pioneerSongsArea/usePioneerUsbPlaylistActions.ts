import { computed, ref, onUnmounted, type Ref, type ShallowRef } from 'vue'
import emitter from '@renderer/utils/mitt'
import {
  clearRekordboxSourceCache,
  clearRekordboxSourceCachesByKind,
  setCachedRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import {
  prepareAndApplyPioneerUsbWrite,
  showPioneerUsbWriteError
} from '@renderer/utils/pioneerUsbWrite'
import { t } from '@renderer/utils/translate'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { PioneerUsbLibraryType, PioneerUsbWriteOperation } from '@shared/pioneerUsbWrite'
import type {
  IPioneerPlaylistTrack,
  IPioneerPlaylistTreeNode,
  ISongInfo
} from '../../../../../types/globals'

type UsbContext = {
  playlistId: number
  playlistName: string
  rootPath: string
  libraryType: PioneerUsbLibraryType
  sourceCacheKey: string
}

export const usePioneerUsbPlaylistActions = (params: {
  runtime: ReturnType<typeof useRuntimeStore>
  enabled: Ref<boolean>
  originalTracks: ShallowRef<IPioneerPlaylistTrack[]>
  selectedRowKeys: Ref<string[]>
  selectedPlaylistId: Ref<number>
  selectedSourceRootPath: Ref<string>
  selectedLibraryType: Ref<string>
  selectedSourceCacheKey: Ref<string>
  selectedPlaylistNode: Ref<IPioneerPlaylistTreeNode | null>
  refreshPlaylistTracks: (options?: { reuseRuntime?: boolean }) => Promise<void>
}) => {
  const usbMutationPending = ref(false)
  let disposed = false
  const usbWriting = computed(() => usbMutationPending.value)
  const captureContext = (): Pick<
    UsbContext,
    'rootPath' | 'libraryType' | 'sourceCacheKey' | 'playlistId' | 'playlistName'
  > | null => {
    if (!params.enabled.value) return null
    const libraryType = params.selectedLibraryType.value
    if (libraryType !== 'oneLibrary' && libraryType !== 'deviceLibrary') return null
    return {
      rootPath: params.selectedSourceRootPath.value,
      libraryType,
      sourceCacheKey: params.selectedSourceCacheKey.value,
      playlistId: params.selectedPlaylistId.value,
      playlistName: params.selectedPlaylistNode.value?.name || ''
    }
  }
  const resolveRawTracks = (songs?: ISongInfo[]) => {
    const keys = new Set(
      songs
        ? songs.map((song) => song.mixtapeItemId || song.filePath)
        : params.selectedRowKeys.value
    )
    const tracks = params.originalTracks.value.filter((track) => keys.has(track.rowKey))
    if (keys.size && tracks.length !== keys.size) throw new Error(t('pioneerUsb.selectionChanged'))
    return tracks
  }
  const refreshAfterWrite = async (
    context: NonNullable<ReturnType<typeof captureContext>>,
    options?: { reorderOnly?: boolean; reuseRuntime?: boolean }
  ) => {
    await window.electron.ipcRenderer.invoke(
      'pioneer-device-library:wait-for-writes',
      context.rootPath
    )
    clearRekordboxSourceCachesByKind('usb')
    clearRekordboxSourceCache(context.sourceCacheKey)
    if (options?.reorderOnly) {
      if (
        !disposed &&
        params.selectedSourceCacheKey.value === context.sourceCacheKey &&
        params.selectedPlaylistId.value === context.playlistId
      )
        await params.refreshPlaylistTracks({ reuseRuntime: true })
      return
    }
    const result = (await window.electron.ipcRenderer.invoke(
      'pioneer-device-library:load-tree',
      context.rootPath,
      context.libraryType
    )) as { treeNodes?: IPioneerPlaylistTreeNode[] }
    const nodes = result.treeNodes || []
    const hasPlaylist = (items: IPioneerPlaylistTreeNode[]): boolean =>
      items.some(
        (node) =>
          node.id === context.playlistId || Boolean(node.children && hasPlaylist(node.children))
      )
    const selectedId = hasPlaylist(nodes) ? context.playlistId : 0
    setCachedRekordboxSourceTree(context.sourceCacheKey, nodes, { selectedPlaylistId: selectedId })
    if (disposed || params.selectedSourceCacheKey.value !== context.sourceCacheKey) return
    if (JSON.stringify(params.runtime.pioneerDeviceLibrary.treeNodes) !== JSON.stringify(nodes)) {
      params.runtime.pioneerDeviceLibrary.treeNodes = nodes
    }
    if (!selectedId && params.selectedPlaylistId.value === context.playlistId) {
      params.runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
      return
    }
    if (params.selectedPlaylistId.value === context.playlistId)
      await params.refreshPlaylistTracks({ reuseRuntime: options?.reuseRuntime === true })
  }
  const runOperation = async (
    operation: PioneerUsbWriteOperation,
    label: string,
    context: NonNullable<ReturnType<typeof captureContext>>
  ) => {
    if (usbMutationPending.value) return false
    usbMutationPending.value = true
    try {
      const result = await prepareAndApplyPioneerUsbWrite(
        {
          rootPath: context.rootPath,
          libraryType: context.libraryType,
          operation
        },
        label
      )
      if (!result) return false
      try {
        await refreshAfterWrite(context, {
          reorderOnly: operation.kind === 'reorder',
          reuseRuntime: true
        })
      } catch (error) {
        await showPioneerUsbWriteError(
          new Error(
            `${t('pioneerUsb.refreshFailed')}\n${error instanceof Error ? error.message : String(error)}`
          ),
          t('pioneerUsb.refreshFailureTitle')
        )
      }
      return true
    } finally {
      usbMutationPending.value = false
    }
  }
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let refreshRunning = false
  let refreshAgain = false
  let refreshReuseRuntime = true
  const refreshChangedSource = async () => {
    if (disposed) return
    if (refreshRunning) {
      refreshAgain = true
      return
    }
    refreshRunning = true
    try {
      do {
        refreshAgain = false
        const reuseRuntime = refreshReuseRuntime
        refreshReuseRuntime = true
        const context = captureContext()
        if (context) await refreshAfterWrite(context, { reuseRuntime })
      } while (refreshAgain)
    } catch (error) {
      // A retry must not lose an earlier notification that may have changed ANLZ.
      refreshReuseRuntime = false
      const message = error instanceof Error ? error.message : String(error)
      if (
        !disposed &&
        (message.includes('此 U 盘正在写入') || message.includes('读取期间 U 盘已更新'))
      ) {
        refreshTimer = setTimeout(() => {
          void refreshChangedSource()
        }, 400)
      } else await showPioneerUsbWriteError(error, t('pioneerUsb.refreshFailureTitle'))
    } finally {
      refreshRunning = false
    }
  }
  const handleUsbChanged = (value: unknown) => {
    if (!value || typeof value !== 'object' || !('rootPath' in value)) return
    clearRekordboxSourceCachesByKind('usb')
    if (value.rootPath !== params.selectedSourceRootPath.value) return
    refreshReuseRuntime &&= 'analysisUnchanged' in value && value.analysisUnchanged === true
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      void refreshChangedSource()
    }, 400)
  }
  emitter.on('pioneerUsb/changed', handleUsbChanged)
  onUnmounted(() => {
    disposed = true
    emitter.off('pioneerUsb/changed', handleUsbChanged)
    if (refreshTimer) clearTimeout(refreshTimer)
  })
  const editSelectedTracks = async (
    kind: 'remove-from-playlist' | 'delete-tracks',
    songs: ISongInfo[]
  ) => {
    const context = captureContext()
    if (!context || usbMutationPending.value) return
    try {
      const trackIds = resolveRawTracks(songs).map((track) => track.trackId)
      if (!trackIds.length) return
      await runOperation(
        kind === 'remove-from-playlist'
          ? { kind, playlistId: context.playlistId, trackIds }
          : { kind, trackIds },
        t(
          kind === 'remove-from-playlist'
            ? 'rekordboxDesktop.removeTracksFromPlaylistAction'
            : 'common.delete'
        ),
        context
      )
    } catch (error) {
      await showPioneerUsbWriteError(error)
    }
  }
  const deleteUsbPlaylist = async () => {
    const context = captureContext()
    if (!context) return
    await runOperation(
      { kind: 'delete-playlist', playlistId: context.playlistId, deleteExclusiveTracks: true },
      `${t('common.delete')}: ${context.playlistName}`,
      context
    )
  }
  const saveUsbOrder = async (orderedSongs: ISongInfo[]) => {
    const context = captureContext()
    if (!context) return
    try {
      const byKey = new Map(
        params.originalTracks.value.map((track) => [track.rowKey, track.trackId])
      )
      const trackIds = orderedSongs.map((song) => byKey.get(song.mixtapeItemId || ''))
      if (
        trackIds.some((id) => id === undefined) ||
        trackIds.length !== params.originalTracks.value.length
      ) {
        throw new Error(t('pioneerUsb.incompleteOrder'))
      }
      await runOperation(
        {
          kind: 'reorder',
          playlistId: context.playlistId,
          trackIds: trackIds.filter((id): id is number => id !== undefined)
        },
        `${t('pioneerUsb.reorder')}: ${context.playlistName}`,
        context
      )
    } catch (error) {
      await showPioneerUsbWriteError(error)
    }
  }
  const reorderUsbTracks = async (
    sourceItemIds: string[],
    targetIndex: number,
    visibleSongs: ISongInfo[]
  ) => {
    const moving = new Set(sourceItemIds)
    const moved = visibleSongs.filter((song) => moving.has(song.mixtapeItemId || ''))
    const remaining = visibleSongs.filter((song) => !moving.has(song.mixtapeItemId || ''))
    if (!moved.length) return
    const boundedIndex = Math.max(0, Math.min(visibleSongs.length, Math.floor(targetIndex)))
    const movedBefore = visibleSongs
      .slice(0, boundedIndex)
      .filter((song) => moving.has(song.mixtapeItemId || '')).length
    const index = boundedIndex - movedBefore
    await saveUsbOrder([...remaining.slice(0, index), ...moved, ...remaining.slice(index)])
  }
  return {
    usbWriting,
    removeUsbTracks: (songs: ISongInfo[]) => editSelectedTracks('remove-from-playlist', songs),
    deleteUsbTracks: (songs: ISongInfo[]) => editSelectedTracks('delete-tracks', songs),
    deleteUsbPlaylist,
    saveUsbOrder,
    reorderUsbTracks
  }
}
