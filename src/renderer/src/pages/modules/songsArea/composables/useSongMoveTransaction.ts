import { rendererFilePathKey } from '@renderer/utils/filePathComparison'
import { nextTick } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import type { ISongInfo } from '../../../../../../types/globals'

type PrepareSongMoveOptions = {
  sourceSongListUUID: string
  sourceSongs: ISongInfo[]
  filePaths: string[]
}

type OptimisticRestoreItem = {
  song: ISongInfo
  index: number
}

export type MoveSongsToDirSummary = {
  movedEntries: Array<{
    sourcePath: string
    targetPath: string
  }>
  failed: number
}

const normalizePath = (value: string | undefined | null) => rendererFilePathKey(String(value || ''))

export function useSongMoveTransaction() {
  const runtime = useRuntimeStore()

  const prepareSongMove = async ({
    sourceSongListUUID,
    sourceSongs,
    filePaths
  }: PrepareSongMoveOptions) => {
    const movedPathSet = new Set(filePaths.map(normalizePath).filter(Boolean))
    if (!sourceSongListUUID || movedPathSet.size === 0) {
      return { restoreSourceList: () => {} }
    }

    const restoreItems: OptimisticRestoreItem[] = sourceSongs
      .map((song, index) => ({ song: { ...song }, index }))
      .filter((item) => movedPathSet.has(normalizePath(item.song.filePath)))
    const isPlayingSourceList = runtime.playingData.playingSongListUUID === sourceSongListUUID
    const currentPlayingPath = normalizePath(runtime.playingData.playingSong?.filePath)
    const currentPlayingWillMove =
      isPlayingSourceList && Boolean(currentPlayingPath) && movedPathSet.has(currentPlayingPath)
    const playbackList = [...runtime.playingData.playingSongListData]

    if (isPlayingSourceList) {
      const currentIndex = playbackList.findIndex(
        (song) => normalizePath(song.filePath) === currentPlayingPath
      )
      const nextPlaybackList = playbackList.filter(
        (song) => !movedPathSet.has(normalizePath(song.filePath))
      )
      runtime.playingData.playingSongListData = nextPlaybackList

      emitter.emit('songsArea/optimistic-remove', {
        listUUID: sourceSongListUUID,
        paths: filePaths,
        resumeMainPlayerAfterPreviewStop: !currentPlayingWillMove
      })

      if (currentPlayingWillMove) {
        const nextSong = playbackList.find(
          (song, index) =>
            index > currentIndex &&
            !movedPathSet.has(normalizePath(song.filePath)) &&
            !song.fileMissing
        )
        runtime.playerReady = false
        runtime.isSwitchingSong = Boolean(nextSong)
        if (!nextSong) {
          runtime.playingData.playingSongListData = []
        }
        runtime.playingData.playingSong = nextSong || null
        await nextTick()
      }
    } else {
      emitter.emit('songsArea/optimistic-remove', {
        listUUID: sourceSongListUUID,
        paths: filePaths
      })
    }

    return {
      restoreSourceList: (pathsToRestore?: string[]) => {
        const restorePathSet = pathsToRestore
          ? new Set(pathsToRestore.map(normalizePath).filter(Boolean))
          : null
        const items = restorePathSet
          ? restoreItems.filter((item) => restorePathSet.has(normalizePath(item.song.filePath)))
          : restoreItems
        if (!items.length) return
        emitter.emit('songsArea/optimistic-restore', {
          listUUID: sourceSongListUUID,
          items
        })
      }
    }
  }

  return { prepareSongMove }
}
