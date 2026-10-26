import { nextTick } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import { replaceExternalPlaylistFromPaths } from '@renderer/utils/externalPlaylist'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { pruneLibraryTreeTrackCounts } from '@renderer/utils/libraryTreeSort'
import { usePlaylistViewSettingsStore } from '@renderer/stores/playlistViewSettings'
import { isRuntimeLibraryTree } from '@renderer/utils/appRuntimeStateGuards'
import { markGlobalSongSearchDirty } from '@renderer/utils/globalSongSearchEvents'
import emitter from '@renderer/utils/mitt'

// 协调主窗口的音乐库读取、树变更及外部曲目导入；IPC 监听生命周期仍由 App 管理。
export const useMainWindowLibraryEvents = (runtime: ReturnType<typeof useRuntimeStore>) => {
  let startupLibraryTreeReconcileRequested = false

  const requestStartupLibraryTreeReconcile = () => {
    if (startupLibraryTreeReconcileRequested) return
    startupLibraryTreeReconcileRequested = true
    // 先让快照树完成一次绘制，再开始后台核对；否则慢盘上的递归扫描会和首屏争抢资源。
    void nextTick()
      .then(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve())
          })
      )
      .then(() => {
        window.electron.ipcRenderer.send('library-tree:startup-ready')
      })
  }

  const getLibrary = async (options?: { useCachedSnapshot?: boolean }) => {
    if (runtime.librarySetupActive) return
    runtime.libraryTreeLoading = true
    let loaded = false
    try {
      runtime.libraryTree = await window.electron.ipcRenderer.invoke(
        options?.useCachedSnapshot ? 'getLibrary:cached' : 'getLibrary'
      )
      runtime.oldLibraryTree = JSON.parse(JSON.stringify(runtime.libraryTree))
      pruneLibraryTreeTrackCounts(runtime.libraryTree)
      usePlaylistViewSettingsStore().pruneDeletedPlaylists(
        runtime.libraryTree,
        runtime.setting.persistSongFilters
      )
      loaded = true
    } finally {
      runtime.libraryTreeLoading = false
      if (options?.useCachedSnapshot && loaded) requestStartupLibraryTreeReconcile()
    }
  }

  const handleExternalOpenImported = async (_e: unknown, payload: { paths?: string[] }) => {
    if (runtime.librarySetupActive) return
    try {
      const rawPaths = Array.isArray(payload?.paths) ? payload.paths : []
      const songs = await replaceExternalPlaylistFromPaths(rawPaths)
      if (songs.length) {
        if (
          runtime.mainWindowBrowseMode === 'horizontal' ||
          runtime.mainWindowBrowseMode === 'edit'
        ) {
          runtime.playingData.playingSongListUUID = EXTERNAL_PLAYLIST_UUID
          runtime.playingData.playingSongListData = songs
          emitter.emit('horizontalBrowse/load-song', { deck: 'top', song: songs[0] })
        } else {
          emitter.emit('external-open/play', { songs, startIndex: 0 })
        }
      }
      markGlobalSongSearchDirty('external-open-imported')
    } catch (error) {
      console.error('[external-open] failed to prepare playlist', error)
    }
  }

  const handleLibraryTreeUpdated = async (_e: unknown, tree: unknown) => {
    try {
      if (isRuntimeLibraryTree(tree)) {
        runtime.libraryTree = tree
        runtime.oldLibraryTree = JSON.parse(JSON.stringify(tree))
        pruneLibraryTreeTrackCounts(tree)
        usePlaylistViewSettingsStore().pruneDeletedPlaylists(
          tree,
          runtime.setting.persistSongFilters
        )
        markGlobalSongSearchDirty('library-tree-updated')
        return
      }
      await getLibrary()
      markGlobalSongSearchDirty('library-tree-reloaded')
    } catch (_err) {}
  }

  void getLibrary({ useCachedSnapshot: true }).catch(() => {})

  return { handleLibraryTreeUpdated, handleExternalOpenImported }
}
