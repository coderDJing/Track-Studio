import { onUnmounted } from 'vue'
import emitter from '@renderer/utils/mitt'
import { isEditablePioneerUsbSong } from '@renderer/utils/pioneerUsbEditing'
import type { ISongInfo } from 'src/types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'

/** All players react to confirmed database deletions, including exclusive playlist cleanup. */
export const usePioneerUsbPlaybackDeletion = (params: {
  runtime: ReturnType<typeof useRuntimeStore>
  skipMain?: () => boolean
  onMainDeleted?: (next: {
    listUUID: string
    nextList: ISongInfo[]
    nextSong: ISongInfo | null
  }) => void
  onDeckDeleted?: (deck: 'top' | 'bottom', song: ISongInfo) => Promise<unknown>
}) => {
  const key = (value: string) => value.replace(/\\/g, '/').toLowerCase()
  const handler = (value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('rootPath' in value) ||
      typeof value.rootPath !== 'string' ||
      !('filePaths' in value) ||
      !Array.isArray(value.filePaths)
    )
      return
    const paths = new Set(
      value.filePaths.filter((file): file is string => typeof file === 'string').map(key)
    )
    const root = key(value.rootPath)
    const deleted = (song: ISongInfo | null) =>
      Boolean(
        song &&
        isEditablePioneerUsbSong(song) &&
        key(song.pioneerUsbSource!.rootPath) === root &&
        paths.has(key(song.filePath))
      )
    const playback = params.runtime.playingData
    if (params.onMainDeleted && !params.skipMain?.()) {
      const current = playback.playingSong
      const previousIndex = playback.playingSongListData.findIndex(
        (song) => song.filePath === current?.filePath
      )
      const nextList = playback.playingSongListData.filter((song) => !deleted(song))
      if (deleted(current))
        params.onMainDeleted({
          listUUID: playback.playingSongListUUID,
          nextList,
          nextSong: nextList[Math.max(0, Math.min(previousIndex, nextList.length - 1))] || null
        })
      else if (nextList.length !== playback.playingSongListData.length)
        playback.playingSongListData = nextList
    }
    if (params.onDeckDeleted) {
      const decks = params.runtime.horizontalBrowseDecks
      for (const deck of ['top', 'bottom'] as const) {
        const listKey = deck === 'top' ? 'topSongListData' : 'bottomSongListData'
        const song = deck === 'top' ? decks.topSong : decks.bottomSong
        const nextList = decks[listKey].filter((item) => !deleted(item))
        if (nextList.length !== decks[listKey].length) decks[listKey] = nextList
        if (song && deleted(song))
          void params.onDeckDeleted(deck, song).catch((error) => {
            console.error('[pioneer-usb] clear deleted deck failed', error)
          })
      }
    }
  }
  emitter.on('pioneerUsb/tracks-deleted', handler)
  onUnmounted(() => emitter.off('pioneerUsb/tracks-deleted', handler))
}
