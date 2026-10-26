import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import type { ComputedRef, Ref } from 'vue'
import { useMiniPlayerHost } from '@renderer/composables/miniPlayer/useMiniPlayerHost'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { WebAudioPlayer } from './webAudioPlayer'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { normalizeMiniPlayerSeekRatio } from '@shared/miniPlayerWindow'
import emitter from '@renderer/utils/mitt'
import { toIpcCloneablePayload } from '@renderer/utils/ipcCloneablePayload'

type MainPlayerActions = {
  pause: () => void
  togglePlayPause: () => void
  nextSong: () => void
  previousSong: () => void
  fastForward: () => void
  fastBackward: () => void
  delSong: () => void | Promise<void>
  delAllAbove: (options?: { confirmed?: boolean }) => void | Promise<void>
  handleMoveSong: (targetUuid: string) => Promise<void>
  setPlaybackRangeStartPercent: (value: number) => void
  setPlaybackRangeEndPercent: (value: number) => void
  savePlaybackRange: () => void | Promise<void>
  togglePlaybackRange: () => void | Promise<void>
}

export function useMainPlayerMiniPlayer(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  audioPlayer: Ref<WebAudioPlayer | null>
  isPlaying: ComputedRef<boolean>
  playerCurrentSeconds: Ref<number>
  playerWaveformDurationSec: ComputedRef<number>
  playerWaveformRenderRevision: Ref<number>
  waveformShow: Ref<boolean>
  bpm: Ref<number | string>
  isInternalSongChange: Ref<boolean>
  requestLoadSong: (filePath: string) => void
  play: () => void
  actions: MainPlayerActions
  setVolume: (value: number) => void
  getVolume: () => number
}) {
  const seekSeconds = (seconds: number) => {
    const player = params.audioPlayer.value
    if (!player || !params.waveformShow.value) return
    const duration = params.playerWaveformDurationSec.value
    const next = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Number(seconds) || 0))
    player.seek(next, true)
  }

  const seekPercent = (percent: number) => {
    const player = params.audioPlayer.value
    if (!player || !params.waveformShow.value) return
    const duration = params.playerWaveformDurationSec.value
    if (!(duration > 0)) return
    player.seek(normalizeMiniPlayerSeekRatio(percent) * duration, true)
  }

  const exportTrackWithFolder = async (folderPath: string, deleteAfter: boolean) => {
    const song = params.runtime.playingData.playingSong
    if (!song?.filePath || !folderPath) return
    const shouldDelete =
      deleteAfter &&
      !isRekordboxExternalPlaybackSource(params.runtime.playingData.playingSongListUUID, song)
    const listUuidAtExportStart = params.runtime.playingData.playingSongListUUID
    const currentList = params.runtime.playingData.playingSongListData
    const currentIndex = currentList.findIndex((item) =>
      sameRendererFilePath(item.filePath, song.filePath)
    )
    const summary = (await window.electron.ipcRenderer.invoke(
      'exportSongsToDir',
      folderPath,
      shouldDelete,
      toIpcCloneablePayload([song])
    )) as { removedPaths?: unknown; removedSetItemIds?: unknown } | undefined
    if (!shouldDelete || currentIndex < 0) return

    params.audioPlayer.value?.stop()
    params.audioPlayer.value?.empty()
    params.waveformShow.value = false
    params.bpm.value = ''
    currentList.splice(currentIndex, 1)
    const nextSong = currentList[Math.min(currentIndex, currentList.length - 1)] || null
    params.isInternalSongChange.value = true
    params.runtime.playingData.playingSong = nextSong
    if (nextSong) {
      params.requestLoadSong(nextSong.filePath)
    } else {
      params.runtime.playingData.playingSongListUUID = ''
    }

    const removedSetItemIds = Array.isArray(summary?.removedSetItemIds)
      ? summary.removedSetItemIds.filter((item): item is string => typeof item === 'string')
      : []
    const removedPaths = Array.isArray(summary?.removedPaths)
      ? summary.removedPaths.filter((item): item is string => typeof item === 'string')
      : [song.filePath]
    if (removedSetItemIds.length > 0) {
      emitter.emit('songsRemoved', { listUUID: listUuidAtExportStart, itemIds: removedSetItemIds })
    } else {
      emitter.emit('songsRemoved', { listUUID: listUuidAtExportStart, paths: removedPaths })
    }
    emitter.emit('playlistContentChanged', { uuids: [listUuidAtExportStart] })
  }

  return useMiniPlayerHost({
    runtime: params.runtime,
    audioPlayer: params.audioPlayer,
    isPlaying: params.isPlaying,
    playerCurrentSeconds: params.playerCurrentSeconds,
    playerWaveformDurationSec: params.playerWaveformDurationSec,
    playerWaveformRenderRevision: params.playerWaveformRenderRevision,
    waveformShow: params.waveformShow,
    actions: {
      play: params.play,
      pause: params.actions.pause,
      togglePlayPause: params.actions.togglePlayPause,
      nextSong: params.actions.nextSong,
      previousSong: params.actions.previousSong,
      fastForward: params.actions.fastForward,
      fastBackward: params.actions.fastBackward,
      delSong: params.actions.delSong,
      delAllAbove: params.actions.delAllAbove,
      handleMoveSong: params.actions.handleMoveSong,
      prepareRemoteTransfer: () => true,
      exportTrackWithFolder,
      seekSeconds,
      seekPercent,
      setPlaybackRangeStartPercent: params.actions.setPlaybackRangeStartPercent,
      setPlaybackRangeEndPercent: params.actions.setPlaybackRangeEndPercent,
      savePlaybackRange: params.actions.savePlaybackRange,
      togglePlaybackRange: params.actions.togglePlaybackRange,
      setVolume: params.setVolume,
      getVolume: params.getVolume
    }
  })
}
