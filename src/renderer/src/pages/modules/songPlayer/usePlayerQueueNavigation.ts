import { prepareCloudTransition } from '@renderer/utils/icloudPlayback'
import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import type { Ref } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { ISongInfo } from 'src/types/globals'
import type { WebAudioPlayer } from './webAudioPlayer'
export function usePlayerQueueNavigation({
  runtime,
  audioPlayer,
  isInternalSongChange,
  requestLoadSong
}: {
  runtime: ReturnType<typeof useRuntimeStore>
  audioPlayer: Ref<WebAudioPlayer | null>
  isInternalSongChange: Ref<boolean>
  requestLoadSong: (path: string) => void
}) {
  const fastForward = () => {
    const player = audioPlayer.value
    if (!player) return

    if (runtime.isSwitchingSong || !runtime.playerReady) {
      return
    }

    const duration = player.getDuration()
    if (!duration || Number.isNaN(duration)) return

    const skipAmount = runtime.setting.fastForwardTime

    let hasNextSong = false
    if (runtime.playingData.playingSong && runtime.playingData.playingSongListData?.length) {
      const currentIndex = runtime.playingData.playingSongListData.findIndex((item) =>
        sameRendererFilePath(item.filePath, runtime.playingData.playingSong?.filePath)
      )
      hasNextSong =
        currentIndex !== -1 && currentIndex < runtime.playingData.playingSongListData.length - 1
    }

    const endTime = duration
    const currentTime = player.getCurrentTime()
    const targetTime = currentTime + skipAmount

    const epsilon = 0.01

    if (targetTime >= endTime - epsilon) {
      if (runtime.setting.autoPlayNextSong && hasNextSong) {
        runtime.playerReady = false
        runtime.isSwitchingSong = true
        nextSong()
      } else {
        player.seek(endTime, true)
        player.pause()
      }
      return
    }

    player.skip(skipAmount, true)
  }

  const fastBackward = () => {
    audioPlayer.value?.skip(runtime.setting.fastBackwardTime, true)
  }

  const findNextPlayableSong = (startIndex: number, direction: 1 | -1): ISongInfo | null => {
    const songList = runtime.playingData.playingSongListData
    for (let i = startIndex + direction; i >= 0 && i < songList.length; i += direction) {
      const song = songList[i]
      if (!song.fileMissing) {
        return song
      }
    }
    return null
  }

  let transitionEpoch = 0
  async function transition(candidate: ISongInfo) {
    const version = ++transitionEpoch
    if (candidate.icloudOrigin) {
      const before = runtime.playingData.playingSong
      const ready = await prepareCloudTransition(runtime, candidate)
      if (version !== transitionEpoch) return
      if (!ready || runtime.playingData.playingSong !== before) {
        runtime.playerReady = true
        runtime.isSwitchingSong = false
        return
      }
      const index = runtime.playingData.playingSongListData.findIndex(
        (song) =>
          song.icloudOrigin?.key === candidate.icloudOrigin?.key &&
          song.icloudOrigin?.rootToken === candidate.icloudOrigin?.rootToken
      )
      if (index < 0) {
        runtime.playerReady = true
        runtime.isSwitchingSong = false
        return
      }
      runtime.playingData.playingSongListData.splice(index, 1, ready)
      candidate = ready
    }
    isInternalSongChange.value = true
    runtime.playingData.playingSong = candidate
    requestLoadSong(candidate.filePath)
  }
  const nextSong = async () => {
    // 切歌开始，标记未就绪，阻止快进再次触发
    runtime.playerReady = false
    runtime.isSwitchingSong = true
    if (!runtime.playingData.playingSong) return
    const songList = runtime.playingData.playingSongListData
    const currentIndex = songList.findIndex((item) =>
      sameRendererFilePath(item.filePath, runtime.playingData.playingSong?.filePath)
    )
    if (currentIndex === -1 || currentIndex >= songList.length - 1) {
      runtime.playerReady = true
      runtime.isSwitchingSong = false
      return
    }
    const nextSongData = findNextPlayableSong(currentIndex, 1)
    if (!nextSongData) {
      runtime.playerReady = true
      runtime.isSwitchingSong = false
      return
    }
    await transition(nextSongData)
  }

  const previousSong = async () => {
    // 切歌开始，标记未就绪，阻止快进再次触发
    runtime.playerReady = false
    runtime.isSwitchingSong = true
    if (!runtime.playingData.playingSong) return

    const songList = runtime.playingData.playingSongListData
    const currentIndex = songList.findIndex((item) =>
      sameRendererFilePath(item.filePath, runtime.playingData.playingSong?.filePath)
    )
    if (currentIndex <= 0) {
      // 如果是第一首，或者找不到，则不执行任何操作
      runtime.playerReady = true
      runtime.isSwitchingSong = false
      return
    }

    const prevCandidate = findNextPlayableSong(currentIndex, -1)
    if (!prevCandidate) {
      runtime.playerReady = true
      runtime.isSwitchingSong = false
      return
    }

    await transition(prevCandidate)
  }

  return { fastForward, fastBackward, nextSong, previousSong }
}
