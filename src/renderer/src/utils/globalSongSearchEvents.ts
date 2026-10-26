import { rendererFilePathKey } from '@renderer/utils/filePathComparison'
import type { useRuntimeStore } from '@renderer/stores/runtime'

type RuntimeStore = ReturnType<typeof useRuntimeStore>

export type SongsRemovedPayload = {
  listUUID?: string
  itemIds?: string[]
  paths?: string[]
}

const normalizePath = (value: string) => rendererFilePathKey(String(value || ''))

export const markGlobalSongSearchDirty = (
  reason: string,
  options?: { songListUUID?: string; songListUUIDs?: string[] }
) => {
  void window.electron.ipcRenderer
    .invoke('song-search:mark-dirty', { reason, ...options })
    .catch(() => {})
}

export const handleSongsRemovedForGlobalSearchUpdate = (
  runtime: RuntimeStore,
  payload: SongsRemovedPayload | null
) => {
  try {
    markGlobalSongSearchDirty('songs-removed', { songListUUID: payload?.listUUID })
    const itemIds: string[] = Array.isArray(payload?.itemIds) ? payload.itemIds : []
    const listUUID: string | undefined = payload?.listUUID
    if (itemIds.length > 0) {
      if (listUUID && listUUID !== runtime.playingData.playingSongListUUID) return
      const idSet = new Set(itemIds)
      runtime.playingData.playingSongListData = (
        runtime.playingData.playingSongListData || []
      ).filter((song) => !idSet.has(song?.mixtapeItemId || song?.setItemId || ''))
      if (
        runtime.playingData.playingSong &&
        idSet.has(
          runtime.playingData.playingSong.mixtapeItemId ||
            runtime.playingData.playingSong.setItemId ||
            ''
        )
      ) {
        runtime.playingData.playingSong = null
      }
      return
    }

    const paths: string[] = Array.isArray(payload?.paths) ? payload.paths : []
    if (!paths.length) return
    if (listUUID && listUUID !== runtime.playingData.playingSongListUUID) return
    const normalizedSet = new Set(paths.map((p) => normalizePath(p)).filter(Boolean))
    runtime.playingData.playingSongListData = (
      runtime.playingData.playingSongListData || []
    ).filter((song) => !normalizedSet.has(normalizePath(song.filePath)))
    if (
      runtime.playingData.playingSong &&
      normalizedSet.has(normalizePath(runtime.playingData.playingSong.filePath))
    ) {
      runtime.playingData.playingSong = null
    }
  } catch {}
}
