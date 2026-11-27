import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import { computed, ref, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import { beginHorizontalBrowseDeckInteraction } from '@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTimeline'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  icloudDeckFileNeedsLocalCopy,
  icloudDeckQueueIndex,
  materializeIcloudDeckSong,
  notifyIcloudDeckLocalized
} from '@renderer/utils/icloudPlayback'

type DeckKey = HorizontalBrowseDeckKey
type HorizontalBrowseEditBeatStep = 4 | 8 | 16 | 32 | 128

type UseHorizontalBrowseEditDeckNavigationParams = {
  topDeckSong: Ref<ISongInfo | null>
  assignSongToDeck: (deck: DeckKey, song: ISongInfo) => Promise<unknown>
  handleDeckBeatJump: (deck: DeckKey, direction: -1 | 1, beatCount: number) => void
  resolveDeckPlaying: (deck: DeckKey) => boolean
  handleDeckPlayPauseToggle: (deck: DeckKey) => void
}

const resolveSongQueueKey = (song: ISongInfo | null | undefined) =>
  String(song?.mixtapeItemId || song?.filePath || '').trim()

const resolveSongFilePath = (song: ISongInfo | null | undefined) =>
  String(song?.filePath || '').trim()

const resolveCurrentSongIndex = (songs: ISongInfo[], currentSong: ISongInfo | null) => {
  const currentKey = resolveSongQueueKey(currentSong)
  if (currentKey) {
    const keyIndex = songs.findIndex((song) => resolveSongQueueKey(song) === currentKey)
    if (keyIndex >= 0) return keyIndex
  }

  const currentFilePath = resolveSongFilePath(currentSong)
  if (!currentFilePath) return -1
  return songs.findIndex((song) => sameRendererFilePath(resolveSongFilePath(song), currentFilePath))
}

export const useHorizontalBrowseEditDeckNavigation = ({
  topDeckSong,
  assignSongToDeck,
  handleDeckBeatJump,
  resolveDeckPlaying,
  handleDeckPlayPauseToggle
}: UseHorizontalBrowseEditDeckNavigationParams) => {
  const runtime = useRuntimeStore()
  const editBeatStep = ref<HorizontalBrowseEditBeatStep>(4)
  let editNavigationToken = 0

  const editModeQueue = computed(() =>
    runtime.horizontalBrowseDecks.topSongListData.filter((song) =>
      Boolean(resolveSongFilePath(song))
    )
  )
  const currentEditQueueIndex = computed(() =>
    resolveCurrentSongIndex(editModeQueue.value, topDeckSong.value)
  )
  const canPreviousEditSong = computed(() => currentEditQueueIndex.value > 0)
  const canNextEditSong = computed(
    () =>
      currentEditQueueIndex.value >= 0 &&
      currentEditQueueIndex.value < editModeQueue.value.length - 1
  )

  const loadEditAdjacentSong = (direction: -1 | 1) => {
    const currentIndex = currentEditQueueIndex.value
    if (currentIndex < 0) return false
    const nextSong = editModeQueue.value[currentIndex + direction]
    const filePath = resolveSongFilePath(nextSong)
    if (!filePath) return false
    const shouldResumePlayback = resolveDeckPlaying('top')
    const token = (editNavigationToken += 1)
    const fromPath = resolveSongFilePath(topDeckSong.value)
    const assign = (song: ISongInfo, assignPath: string) => {
      beginHorizontalBrowseDeckInteraction('top', assignPath)
      void assignSongToDeck('top', { ...song }).then(() => {
        if (
          shouldResumePlayback &&
          editNavigationToken === token &&
          sameRendererFilePath(resolveSongFilePath(topDeckSong.value), assignPath) &&
          !resolveDeckPlaying('top')
        ) {
          handleDeckPlayPauseToggle('top')
        }
      })
    }
    if (!icloudDeckFileNeedsLocalCopy(nextSong)) {
      assign(nextSong, filePath)
      return true
    }
    // 只下载这一首。取消、换歌或这次切歌被新的切歌盖掉时，不装轨。
    void materializeIcloudDeckSong(nextSong).then((ready) => {
      if (!ready || editNavigationToken !== token) return
      if (resolveSongFilePath(topDeckSong.value) !== fromPath) return
      const queue = runtime.horizontalBrowseDecks.topSongListData
      const index = icloudDeckQueueIndex(queue, ready)
      if (index >= 0) queue.splice(index, 1, ready)
      const relative = ready.icloudOrigin?.relativePath || ''
      const localPath = resolveSongFilePath(ready)
      if (relative && localPath) notifyIcloudDeckLocalized(relative, localPath)
      assign(ready, resolveSongFilePath(ready))
    })
    return true
  }

  const jumpEditDeckByBeats = (direction: -1 | 1) => {
    if (!topDeckSong.value) return
    handleDeckBeatJump('top', direction, editBeatStep.value)
  }

  return {
    editBeatStep,
    canPreviousEditSong,
    canNextEditSong,
    loadEditAdjacentSong,
    jumpEditDeckByBeats
  }
}
