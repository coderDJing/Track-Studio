import type { Ref } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import type { WebAudioPlayer } from './webAudioPlayer'

const PLAYER_FOREGROUND_ACTIVITY_CHANNEL = 'player:foreground-activity'
const PLAYBACK_ACTIVITY_REFRESH_INTERVAL_MS = 5000

type BrowserPlayerEventParams = {
  player: WebAudioPlayer
  runtime: ReturnType<typeof useRuntimeStore>
  playerCurrentSeconds: Ref<number>
  playerWaveformRenderRevision: Ref<number>
  ignoreNextEmptyError: Ref<boolean>
  setPreviousTime: (seconds: number) => void
  setManualSeekActive: (active: boolean) => void
  nextSong: () => void
  scheduleManualSeekReset: () => void
  clearManualSeekTimer: () => void
  handlePlaybackRangeTimeUpdate: (player: WebAudioPlayer, seconds: number) => void
  updateParentWaveformWidth: () => void
  scheduleAdjacentMetadataPreload: (reason: string) => void
  isIgnorablePlayerEmptySourceError: (error: unknown) => boolean
  isIgnorablePlayerInterruptionError: (error: unknown) => boolean
  handleSongLoadError: (path: string | null, aborted: boolean, message: string) => Promise<unknown>
}

export const bindBrowserPlayerEvents = (params: BrowserPlayerEventParams) => {
  const {
    player,
    runtime,
    playerCurrentSeconds,
    playerWaveformRenderRevision,
    ignoreNextEmptyError,
    setPreviousTime,
    setManualSeekActive,
    nextSong,
    scheduleManualSeekReset,
    clearManualSeekTimer,
    handlePlaybackRangeTimeUpdate,
    updateParentWaveformWidth,
    scheduleAdjacentMetadataPreload,
    isIgnorablePlayerEmptySourceError,
    isIgnorablePlayerInterruptionError,
    handleSongLoadError
  } = params
  let activePlaybackFilePath = ''
  let lastPlaybackActivityAt = 0
  type ErrorLike = {
    name?: unknown
    message?: unknown
  }

  const getErrorMessage = (error: unknown) =>
    error instanceof Error
      ? error.message
      : String((error as ErrorLike | null)?.message || error || '')

  const disposers: Array<() => void> = []

  const sendPlaybackActivity = (state: 'play' | 'pause', filePath: string) => {
    if (!filePath) return
    window.electron.ipcRenderer.send(PLAYER_FOREGROUND_ACTIVITY_CHANNEL, {
      state,
      source: 'main-player',
      filePath,
      requestId: 0
    })
  }

  const stopPlaybackActivity = () => {
    if (!activePlaybackFilePath) return
    sendPlaybackActivity('pause', activePlaybackFilePath)
    activePlaybackFilePath = ''
    lastPlaybackActivityAt = 0
  }

  const refreshPlaybackActivity = () => {
    const now = Date.now()
    if (
      !activePlaybackFilePath ||
      now - lastPlaybackActivityAt < PLAYBACK_ACTIVITY_REFRESH_INTERVAL_MS
    ) {
      return
    }
    sendPlaybackActivity('play', activePlaybackFilePath)
    lastPlaybackActivityAt = now
  }

  const onPlay = () => {
    const nextFilePath = runtime.playingData.playingSong?.filePath || ''
    if (activePlaybackFilePath && !sameRendererFilePath(activePlaybackFilePath, nextFilePath)) {
      stopPlaybackActivity()
    }
    if (nextFilePath) {
      activePlaybackFilePath = nextFilePath
      lastPlaybackActivityAt = 0
      refreshPlaybackActivity()
    }
    runtime.playerReady = true
    runtime.isSwitchingSong = false
    setPreviousTime(player.getCurrentTime())
  }
  player.on('play', onPlay)
  disposers.push(() => player.off('play', onPlay))

  const onPause = () => {
    stopPlaybackActivity()
  }
  player.on('pause', onPause)
  disposers.push(() => player.off('pause', onPause))

  const onFinish = () => {
    stopPlaybackActivity()
    if (runtime.setting.autoPlayNextSong) {
      nextSong()
    }
  }
  player.on('finish', onFinish)
  disposers.push(() => player.off('finish', onFinish))

  const onTimeUpdate = (currentTime: number) => {
    refreshPlaybackActivity()
    playerCurrentSeconds.value = Math.max(0, Number(currentTime) || 0)
    const timeEl = document.querySelector('#time')
    const durationEl = document.querySelector('#duration')
    if (!timeEl || !durationEl) return

    const formatTime = (seconds: number) => {
      const minutes = Math.floor(seconds / 60)
      const secondsRemainder = Math.round(seconds) % 60
      const paddedSeconds = `0${secondsRemainder}`.slice(-2)
      return `${minutes}:${paddedSeconds}`
    }

    ;(timeEl as HTMLElement).textContent = formatTime(currentTime)

    handlePlaybackRangeTimeUpdate(player, currentTime)
    setPreviousTime(currentTime)
  }
  player.on('timeupdate', onTimeUpdate)
  disposers.push(() => player.off('timeupdate', onTimeUpdate))

  const syncManualSeekState = ({ time, manual }: { time: number; manual: boolean }) => {
    playerCurrentSeconds.value = Math.max(0, Number(time) || 0)
    setPreviousTime(time)
    if (manual) {
      setManualSeekActive(true)
      scheduleManualSeekReset()
    } else {
      setManualSeekActive(false)
      clearManualSeekTimer()
    }
  }
  const onSeekStart = syncManualSeekState
  player.on('seekstart', onSeekStart)
  disposers.push(() => player.off('seekstart', onSeekStart))

  const onSeeked = syncManualSeekState
  player.on('seeked', onSeeked)
  disposers.push(() => player.off('seeked', onSeeked))

  const onDecode = (duration: number) => {
    playerWaveformRenderRevision.value += 1
    const durationEl = document.querySelector('#duration')
    if (durationEl) {
      const formatTime = (seconds: number) => {
        const minutes = Math.floor(seconds / 60)
        const secondsRemainder = Math.round(seconds) % 60
        const paddedSeconds = `0${secondsRemainder}`.slice(-2)
        return `${minutes}:${paddedSeconds}`
      }
      durationEl.textContent = formatTime(duration)
      updateParentWaveformWidth()
    }
  }
  player.on('decode', onDecode)
  disposers.push(() => player.off('decode', onDecode))

  const onWaveformReady = () => {
    playerWaveformRenderRevision.value += 1
  }
  player.on('waveformready', onWaveformReady)
  disposers.push(() => player.off('waveformready', onWaveformReady))

  const onReady = () => {
    ignoreNextEmptyError.value = false
    playerWaveformRenderRevision.value += 1
    updateParentWaveformWidth()
    scheduleAdjacentMetadataPreload('current-ready')
  }
  player.on('ready', onReady)
  disposers.push(() => player.off('ready', onReady))

  const onError = async (error: unknown) => {
    if (isIgnorablePlayerEmptySourceError(error)) {
      ignoreNextEmptyError.value = false
      return
    }
    if (isIgnorablePlayerInterruptionError(error)) return
    const currentPath = runtime.playingData.playingSong?.filePath ?? null
    const errorMsg = getErrorMessage(error)
    await handleSongLoadError(currentPath, false, errorMsg)
  }
  player.on('error', onError)
  disposers.push(() => player.off('error', onError))

  return () => {
    stopPlaybackActivity()
    disposers.forEach((dispose) => {
      try {
        dispose()
      } catch {}
    })
  }
}
