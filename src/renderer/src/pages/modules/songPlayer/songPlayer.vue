<script setup lang="ts">
import {
  ref,
  onMounted,
  onUnmounted,
  watch,
  useTemplateRef,
  computed,
  readonly,
  toRef,
  shallowRef,
  nextTick
} from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { WebAudioPlayer } from './webAudioPlayer'
import { useRuntimeStore } from '@renderer/stores/runtime'
import logoAsset from '@renderer/assets/logo.png?asset'
import playerControls from '../../../components/playerControls.vue'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import BpmTap from './BpmTap.vue'
import PlaybackRangeHandles from './PlaybackRangeHandles.vue'
import PlayerCoverSlot from './PlayerCoverSlot.vue'
import PlayerStructureRail from './PlayerStructureRail.vue'
import { usePlayerHotkeys } from './usePlayerHotkeys'
import { usePlayerControlsLogic } from './usePlayerControlsLogic'
import { useCover } from './useCover'
import { useWaveform } from './useWaveform'
import HotCueMarkersLayer from '@renderer/components/HotCueMarkersLayer.vue'
import MemoryCueMarkersLayer from '@renderer/components/MemoryCueMarkersLayer.vue'
import emitter from '@renderer/utils/mitt'
import { useSongLoader } from './useSongLoader'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { createBrowserPlayerKeyboardPercentSeek } from './browserPlayerKeyboardPercentSeek'
import {
  MAIN_WINDOW_VOLUME_CHANGED_EVENT,
  MAIN_WINDOW_VOLUME_SET_EVENT,
  MAIN_WINDOW_VOLUME_STORAGE_KEY,
  readWindowVolume,
  writeWindowVolume
} from '@renderer/utils/windowVolume'
import {
  registerTitleAudioVisualizerSource,
  unregisterTitleAudioVisualizerSource,
  type TitleAudioVisualizerSource
} from '@renderer/composables/titleAudioVisualizerBridge'
import { queueMainPlayerPlayingAnalysis } from '@renderer/utils/playlistAnalysisGate'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { sendPlayerWaveformTrace } from './playerWaveformTrace'
import { usePlaybackRangeController } from './usePlaybackRangeController'
import {
  MAIN_WINDOW_PLAYBACK_SNAPSHOT_REQUEST_EVENT,
  clonePlaybackHandoffSong,
  clonePlaybackHandoffSongList,
  isMainWindowPlaybackSnapshotRequest,
  normalizePlaybackHandoffSeconds,
  type MainWindowPlaybackSnapshot
} from '@renderer/utils/mainWindowPlaybackHandoff'
import { normalizeSongStructureAnalysis } from '@shared/songStructure'
import { projectSongBeatGridMapV2ToFixedGrid } from '@shared/songBeatGridMapV2'
import { useMainPlayerMiniPlayer } from './useMainPlayerMiniPlayer'
import { createMainPlayerGlobalShortcutHandler } from './createMainPlayerGlobalShortcutHandler'
const placeholderLogo = logoAsset
const PLAYER_FOREGROUND_ACTIVITY_CHANNEL = 'player:foreground-activity'
const PLAYBACK_ACTIVITY_REFRESH_INTERVAL_MS = 5000
type WaveformPreviewStatePayload = {
  active?: boolean
  song?: ISongInfo | null
}

const runtime = useRuntimeStore()
const waveform = useTemplateRef<HTMLDivElement>('waveform')

const handleExternalOpenPlay = (payload: { songs?: ISongInfo[]; startIndex?: number }) => {
  try {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  } catch {}
  const queue = Array.isArray(payload?.songs)
    ? payload.songs.filter((item) => item && typeof item.filePath === 'string')
    : []
  if (!queue.length) return
  const normalizedQueue = queue.map((song) => ({ ...song }))
  const startIndexRaw = typeof payload?.startIndex === 'number' ? payload.startIndex : 0
  const startIndex = Math.min(Math.max(startIndexRaw, 0), normalizedQueue.length - 1)
  runtime.activeMenuUUID = ''
  runtime.songsArea.selectedSongFilePath = []
  runtime.playingData.playingSongListUUID = EXTERNAL_PLAYLIST_UUID
  runtime.playingData.playingSongListData = normalizedQueue
  runtime.playingData.playingSong = normalizedQueue[startIndex]
}

const titleAudioVisualizerSource: TitleAudioVisualizerSource = {
  getAnalyser: () => audioPlayer.value?.getVisualizerAnalyser() ?? null
}

// 预加载
const audioPlayer = shallowRef<WebAudioPlayer | null>(null)
const AUDIO_FOLLOW_SYSTEM_ID = ''
let pendingAudioOutputDeviceId = runtime.setting.audioOutputDeviceId || AUDIO_FOLLOW_SYSTEM_ID
const waveformShow = ref(false)
const waveformContainerWidth = ref(0)
const playerCurrentSeconds = ref(0)
const playerWaveformRenderRevision = ref(0)
let lastPlayerWaveformRenderSource = ''
const updateParentWaveformWidth = () => {
  const waveformEl = waveform.value
  if (waveformEl && waveformShow.value && waveformEl.offsetParent !== null) {
    waveformContainerWidth.value = waveformEl.clientWidth
  } else {
    waveformContainerWidth.value = 0
  }
}

let previousTime = 0
const rangeStopTolerance = 0.05
let manualSeekActive = false
let manualSeekResetTimer: number | null = null
let metadataPreloadTimer: number | null = null
let teardownPlayerEvents: (() => void) | null = null
let activePlaybackFilePath = ''
let lastPlaybackActivityAt = 0
const seekSettledMetadataPreloadDelayMs = 6000
const keyboardPercentSeek = createBrowserPlayerKeyboardPercentSeek({
  getPlayer: () => audioPlayer.value,
  getFilePath: () => runtime.playingData.playingSong?.filePath,
  isAllowed: () => Boolean(audioPlayer.value && waveformShow.value && !runtime.isSwitchingSong)
})

const resolveAdjacentMetadataPreloadPaths = () => {
  const currentPath = runtime.playingData.playingSong?.filePath
  if (!currentPath) return []
  const list = runtime.playingData.playingSongListData || []
  const currentIndex = list.findIndex((song) => song.filePath === currentPath)
  if (currentIndex < 0) return []
  return [list[currentIndex - 1], list[currentIndex + 1]]
    .filter((song): song is ISongInfo => Boolean(song?.filePath && !song.fileMissing))
    .map((song) => song.filePath)
}

const clearMetadataPreloadTimer = () => {
  if (metadataPreloadTimer !== null) {
    window.clearTimeout(metadataPreloadTimer)
    metadataPreloadTimer = null
  }
}

const scheduleAdjacentMetadataPreload = (reason: string, delayMs = 180) => {
  clearMetadataPreloadTimer()
  metadataPreloadTimer = window.setTimeout(() => {
    metadataPreloadTimer = null
    const player = audioPlayer.value
    if (!player?.isReady?.()) return
    const paths = resolveAdjacentMetadataPreloadPaths()
    player.preloadHtmlMetadata(paths, { reason })
  }, delayMs)
}

const buildBrowserPlaybackSnapshot = (): MainWindowPlaybackSnapshot | null => {
  const song = runtime.playingData.playingSong
  if (!song) return null
  const player = audioPlayer.value
  const durationSec = Number(player?.getDuration?.())
  return {
    sourceMode: 'browser',
    song: clonePlaybackHandoffSong(song),
    songListUUID: String(runtime.playingData.playingSongListUUID || '').trim(),
    songListData: clonePlaybackHandoffSongList(runtime.playingData.playingSongListData),
    currentSec: normalizePlaybackHandoffSeconds(player?.getCurrentTime?.() ?? 0, durationSec),
    shouldPlay: Boolean(player?.isPlaying?.())
  }
}

const handleMainWindowPlaybackSnapshotRequest = (payload: unknown) => {
  if (!isMainWindowPlaybackSnapshotRequest(payload)) return
  if (payload.sourceMode !== 'browser') return
  if (runtime.mainWindowBrowseMode !== 'browser') return
  payload.respond(buildBrowserPlaybackSnapshot())
}

const clearManualSeekTimer = () => {
  if (manualSeekResetTimer !== null) {
    window.clearTimeout(manualSeekResetTimer)
    manualSeekResetTimer = null
  }
}

const scheduleManualSeekReset = () => {
  clearManualSeekTimer()
  clearMetadataPreloadTimer()
  manualSeekResetTimer = window.setTimeout(() => {
    manualSeekActive = false
    manualSeekResetTimer = null
    scheduleAdjacentMetadataPreload('manual-seek-settled', seekSettledMetadataPreloadDelayMs)
  }, 400)
}

const bindPlayerEvents = (player: WebAudioPlayer) => {
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
    if (activePlaybackFilePath && activePlaybackFilePath !== nextFilePath) {
      stopPlaybackActivity()
    }
    if (nextFilePath) {
      activePlaybackFilePath = nextFilePath
      lastPlaybackActivityAt = 0
      refreshPlaybackActivity()
    }
    runtime.playerReady = true
    runtime.isSwitchingSong = false
    previousTime = player.getCurrentTime()
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
      playerActions.nextSong()
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
    previousTime = currentTime
  }
  player.on('timeupdate', onTimeUpdate)
  disposers.push(() => player.off('timeupdate', onTimeUpdate))

  const syncManualSeekState = ({ time, manual }: { time: number; manual: boolean }) => {
    playerCurrentSeconds.value = Math.max(0, Number(time) || 0)
    previousTime = time
    if (manual) {
      manualSeekActive = true
      scheduleManualSeekReset()
    } else {
      manualSeekActive = false
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

const initAudioPlayer = () => {
  if (teardownPlayerEvents) {
    teardownPlayerEvents()
    teardownPlayerEvents = null
  }
  if (audioPlayer.value) {
    audioPlayer.value.destroy()
  }
  const player = new WebAudioPlayer()
  audioPlayer.value = player
  teardownPlayerEvents = bindPlayerEvents(player)
  void applyAudioOutputDevice(pendingAudioOutputDeviceId)
}

const isIgnorablePlayerInterruptionError = (error: unknown) => {
  const err = (error && typeof error === 'object' ? error : null) as {
    name?: unknown
    message?: unknown
  } | null
  const name = String(err?.name || '').trim()
  const message = String(err?.message || error || '')
    .trim()
    .toLowerCase()
  if (name === 'AbortError') return true
  return (
    message.includes('play() request was interrupted by a call to pause()') ||
    message.includes('play() request was interrupted by a new load request')
  )
}

const isIgnorablePlayerEmptySourceError = (error: unknown) =>
  String(
    ((error && typeof error === 'object' ? error : null) as { message?: unknown } | null)
      ?.message ||
      error ||
      ''
  )
    .trim()
    .toLowerCase()
    .includes('empty src attribute')

// 封面与右键保存
const {
  coverBlobUrl,
  songInfoShow,
  handleSongInfoMouseLeave,
  showCoverContextMenu,
  setCoverByIPC
} = useCover(runtime)

// 加载/播放与错误处理
const bpm = ref<number | string>('')
const { ignoreNextEmptyError, requestLoadSong, handleSongLoadError } = useSongLoader({
  runtime,
  audioPlayer,
  bpm,
  waveformShow,
  setCoverByIPC
})

watch(
  () => [
    Boolean(audioPlayer.value?.pioneerPreviewWaveformData),
    Boolean(audioPlayer.value?.compactVisualWaveformData)
  ],
  () => {
    const source = audioPlayer.value?.pioneerPreviewWaveformData
      ? 'pioneer-preview'
      : audioPlayer.value?.compactVisualWaveformData
        ? 'formal-compact'
        : 'none'
    if (source === lastPlayerWaveformRenderSource) return
    lastPlayerWaveformRenderSource = source
    sendPlayerWaveformTrace('render', source, {
      filePath: runtime.playingData.playingSong?.filePath || ''
    })
  },
  { immediate: true }
)

// 内部切歌标志
const isInternalSongChange = ref(false)

const handleReplayRequest = () => {
  const playerInstance = audioPlayer.value
  if (!playerInstance) return
  if (!runtime.playingData.playingSong) return

  const duration = playerInstance.getDuration()
  if (!duration || Number.isNaN(duration)) return

  const startTime = resolvePlaybackRangeStartSec(duration)

  const wasPlaying = playerInstance.isPlaying()
  runtime.playerReady = false
  clearMetadataPreloadTimer()

  playerInstance.seek(startTime)
  if (!wasPlaying) {
    playerInstance.play(startTime)
  }
}

// 初始化 WebAudioPlayer 和波形
onMounted(() => {
  initAudioPlayer()
  registerTitleAudioVisualizerSource('mainWindow', titleAudioVisualizerSource)
  emitter.on('player/replay-current-song', handleReplayRequest)
  emitter.on('external-open/play', handleExternalOpenPlay)
  emitter.on(MAIN_WINDOW_PLAYBACK_SNAPSHOT_REQUEST_EVENT, handleMainWindowPlaybackSnapshotRequest)
  emitter.on('waveform-preview:state', handleWaveformPreviewState)
  emitter.on('waveform-preview:pause-main', handleWaveformPreviewPauseMain)
  emitter.on('waveform-preview:resume-main', handleWaveformPreviewResumeMain)

  useWaveform({
    waveformEl: waveform,
    audioPlayer,
    runtime,
    updateParentWaveformWidth,
    onNextSong: () => playerActions.nextSong(),
    onError: async (_error: unknown) => {
      if (isIgnorablePlayerEmptySourceError(_error)) {
        ignoreNextEmptyError.value = false
        return
      }
      const currentPath = runtime.playingData.playingSong?.filePath ?? null
      await handleSongLoadError(currentPath, false)
    }
  })

  const initialVolume = readWindowVolume(MAIN_WINDOW_VOLUME_STORAGE_KEY)
  audioPlayer.value?.setVolume(initialVolume)
  syncMainWindowVolume(initialVolume)

  window.addEventListener('resize', updateParentWaveformWidth)
  window.electron.ipcRenderer.on('player/global-shortcut', handleGlobalPlayerShortcut)
  emitter.on(MAIN_WINDOW_VOLUME_SET_EVENT, handleMainWindowVolumeSet)
})

// 歌曲移动、删除、播放控制等统一动作
const selectSongListDialogLibraryName = ref('FilterLibrary')
const selectSongListDialogShow = ref(false)
const selectSongListDialogActionMode = ref<'move' | 'copy'>('move')
const playerActions = usePlayerControlsLogic({
  audioPlayer,
  runtime,
  bpm,
  waveformShow,
  selectSongListDialogShow,
  selectSongListDialogLibraryName,
  selectSongListDialogActionMode,
  isInternalSongChange,
  requestLoadSong,
  ignoreNextEmptyError
})

const handleWaveformPreviewPauseMain = (payload?: { onPaused?: (wasPlaying: boolean) => void }) => {
  const wasPlaying = audioPlayer.value?.isPlaying() ?? false
  if (wasPlaying) {
    audioPlayer.value?.pause()
  }
  payload?.onPaused?.(wasPlaying)
}

const handleWaveformPreviewResumeMain = () => {
  playerActions.play()
}

const stopWaveformPreviewForManualPlay = () => {
  try {
    emitter.emit('waveform-preview:stop', { reason: 'manual-play' })
  } catch {}
}

const handleUserPlay = () => {
  stopWaveformPreviewForManualPlay()
  playerActions.play()
}

const handleUserNextSong = () => {
  stopWaveformPreviewForManualPlay()
  playerActions.nextSong()
}

const handleUserPreviousSong = () => {
  stopWaveformPreviewForManualPlay()
  playerActions.previousSong()
}

const handleUserTogglePlayPause = () => {
  const isPlaying = audioPlayer.value?.isPlaying() ?? false
  if (!isPlaying) {
    stopWaveformPreviewForManualPlay()
  }
  playerActions.togglePlayPause()
}

const handleSeekToPercent = (percent: number) => {
  keyboardPercentSeek.request(percent)
}

const handleMainWaveformHotCueClick = (sec: number) => {
  const playerInstance = audioPlayer.value
  if (!playerInstance || !waveformShow.value || runtime.isSwitchingSong) return
  stopWaveformPreviewForManualPlay()
  playerInstance.play(Math.max(0, Number(sec) || 0))
}

// 音量控制
const VOLUME_STEP = 0.05

const syncMainWindowVolume = (value: number) => {
  emitter.emit(MAIN_WINDOW_VOLUME_CHANGED_EVENT, value)
}

const getVolume = () => readWindowVolume(MAIN_WINDOW_VOLUME_STORAGE_KEY)

const setVolume = (v: number) => {
  const nextVolume = writeWindowVolume(MAIN_WINDOW_VOLUME_STORAGE_KEY, v)
  audioPlayer.value?.setVolume?.(nextVolume)
  syncMainWindowVolume(nextVolume)
}

const handleVolumeUp = () => {
  const current = getVolume()
  setVolume(current + VOLUME_STEP)
}

const handleVolumeDown = () => {
  const current = getVolume()
  setVolume(current - VOLUME_STEP)
}

const handleMainWindowVolumeSet = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  setVolume(value)
}

const previewHotkeysActive = ref(false)
const handleWaveformPreviewState = (payload?: WaveformPreviewStatePayload) => {
  previewHotkeysActive.value = Boolean(payload?.active && payload?.song?.filePath)
}

const selectSongListDialogConfirm = async (item: string) => {
  await playerActions.handleMoveSong(item)
}

const setSetting = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

const togglePlaybackRange = async () => {
  runtime.setting.enablePlaybackRange = !runtime.setting.enablePlaybackRange
  await setSetting()
}

const applyAudioOutputDevice = async (deviceId: string) => {
  pendingAudioOutputDeviceId = deviceId
  const playerInstance = audioPlayer.value
  if (!playerInstance) {
    return
  }
  try {
    await playerInstance.setOutputDevice(deviceId)
  } catch (error) {
    if (deviceId !== AUDIO_FOLLOW_SYSTEM_ID) {
      pendingAudioOutputDeviceId = AUDIO_FOLLOW_SYSTEM_ID
      if (runtime.setting.audioOutputDeviceId !== AUDIO_FOLLOW_SYSTEM_ID) {
        runtime.setting.audioOutputDeviceId = AUDIO_FOLLOW_SYSTEM_ID
        await setSetting()
      }
      try {
        await playerInstance.setOutputDevice(AUDIO_FOLLOW_SYSTEM_ID)
      } catch (_) {
        // 回退默认输出失败时无需额外处理
      }
    }
  }
}

// 热键
const hotkeyActions = {
  play: handleUserPlay,
  pause: playerActions.pause,
  fastForward: playerActions.fastForward,
  fastBackward: playerActions.fastBackward,
  nextSong: handleUserNextSong,
  previousSong: handleUserPreviousSong,
  delSong: playerActions.delSong,
  moveToListLibrary: playerActions.moveToListLibrary,
  moveToLikeLibrary: playerActions.moveToLikeLibrary,
  togglePlayPause: handleUserTogglePlayPause,
  togglePlaybackRange,
  seekToPercent: handleSeekToPercent,
  volumeUp: handleVolumeUp,
  volumeDown: handleVolumeDown
}

const isPlaying = computed(() => audioPlayer.value?.playingState.value ?? false)
const parseDurationToSeconds = (input: unknown) => {
  const raw = String(input || '').trim()
  if (!raw) return 0
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) || 0)
  const parts = raw
    .split(':')
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part))
  if (!parts.length) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0]
}
const resolvePositiveSeconds = (input: unknown) => {
  const value = Number(input)
  return Number.isFinite(value) && value > 0 ? value : 0
}
const playerWaveformDurationSec = computed(() => {
  void playerWaveformRenderRevision.value
  const compactDuration = resolvePositiveSeconds(
    audioPlayer.value?.compactVisualWaveformData?.duration
  )
  if (compactDuration > 0) return compactDuration
  const structureDuration = resolvePositiveSeconds(
    normalizeSongStructureAnalysis(runtime.playingData.playingSong?.songStructure)?.durationSec
  )
  if (structureDuration > 0) return structureDuration
  const playerDuration = resolvePositiveSeconds(audioPlayer.value?.getDuration())
  if (playerDuration > 0) return playerDuration
  return parseDurationToSeconds(runtime.playingData.playingSong?.duration)
})

const {
  playbackRangeHandlesLocked,
  playbackRangeHandlesVisible,
  playbackRangeLockedRanges,
  playbackRangeHandleStartPercent,
  playbackRangeHandleEndPercent,
  handlePlaybackRangeTimeUpdate,
  handlePlaybackRangeDragEnd,
  resolvePlaybackRangeStartSec
} = usePlaybackRangeController({
  runtime,
  audioPlayer,
  playerCurrentSeconds,
  playerWaveformDurationSec,
  rangeStopTolerance,
  getPreviousTime: () => previousTime,
  setPreviousTime: (value) => {
    previousTime = value
  },
  isManualSeekActive: () => manualSeekActive,
  clearManualSeekActive: () => {
    manualSeekActive = false
    clearManualSeekTimer()
  },
  nextSong: () => playerActions.nextSong(),
  setSetting
})

const { toggleMiniPlayer } = useMainPlayerMiniPlayer({
  runtime,
  audioPlayer,
  isPlaying,
  playerCurrentSeconds,
  playerWaveformDurationSec,
  playerWaveformRenderRevision,
  waveformShow,
  bpm,
  isInternalSongChange,
  requestLoadSong,
  play: handleUserPlay,
  actions: {
    pause: playerActions.pause,
    togglePlayPause: handleUserTogglePlayPause,
    nextSong: handleUserNextSong,
    previousSong: handleUserPreviousSong,
    fastForward: playerActions.fastForward,
    fastBackward: playerActions.fastBackward,
    delSong: playerActions.delSong,
    delAllAbove: playerActions.delAllAbove,
    handleMoveSong: playerActions.handleMoveSong,
    setPlaybackRangeStartPercent: (value) => {
      playbackRangeHandleStartPercent.value = value
    },
    setPlaybackRangeEndPercent: (value) => {
      playbackRangeHandleEndPercent.value = value
    },
    savePlaybackRange: handlePlaybackRangeDragEnd,
    togglePlaybackRange
  },
  setVolume,
  getVolume
})

const handlePlayerStructureSectionClick = (startSec: number) => {
  const playerInstance = audioPlayer.value
  if (!playerInstance || !waveformShow.value || runtime.isSwitchingSong) return
  playerInstance.play(Math.max(0, Number(startSec) || 0))
}

watch(
  () => runtime.playingData.playingSong?.filePath,
  () => {
    playerCurrentSeconds.value = 0
  }
)
const playerState = {
  waveformShow,
  selectSongListDialogShow,
  confirmShow: readonly(toRef(runtime, 'confirmShow')),
  songsAreaSelectedCount: computed(() => runtime.songsArea.selectedSongFilePath.length),
  activeMenuUUID: toRef(runtime, 'activeMenuUUID'),
  isPlaying: readonly(isPlaying),
  hotkeysEnabled: computed(() => !runtime.miniPlayerSession.open)
}
usePlayerHotkeys(hotkeyActions, playerState, runtime)

const handleGlobalPlayerShortcut = createMainPlayerGlobalShortcutHandler({
  previewHotkeysActive,
  selectSongListDialogShow,
  waveformShow,
  isGlobalSelectSongListDialogVisible: () => runtime.selectSongListDialogShow,
  togglePlayPause: handleUserTogglePlayPause,
  fastForward: playerActions.fastForward,
  fastBackward: playerActions.fastBackward,
  nextSong: handleUserNextSong,
  previousSong: handleUserPreviousSong,
  seekPercent: (percent) => keyboardPercentSeek.request(percent, { immediate: true })
})

watch(
  () => runtime.setting.audioOutputDeviceId,
  (newValue) => {
    const nextId = newValue || AUDIO_FOLLOW_SYSTEM_ID
    void applyAudioOutputDevice(nextId)
  },
  { immediate: true }
)

// 初始化与销毁

onUnmounted(() => {
  runtime.playerReady = false
  keyboardPercentSeek.clear('unmount')
  clearManualSeekTimer()
  clearMetadataPreloadTimer()
  unregisterTitleAudioVisualizerSource('mainWindow', titleAudioVisualizerSource)
  if (teardownPlayerEvents) {
    teardownPlayerEvents()
    teardownPlayerEvents = null
  }
  if (audioPlayer.value) {
    audioPlayer.value.destroy()
    audioPlayer.value = null
  }
  window.removeEventListener('resize', updateParentWaveformWidth)
  emitter.off('player/replay-current-song', handleReplayRequest)
  emitter.off('external-open/play', handleExternalOpenPlay)
  emitter.off(MAIN_WINDOW_PLAYBACK_SNAPSHOT_REQUEST_EVENT, handleMainWindowPlaybackSnapshotRequest)
  emitter.off('waveform-preview:state', handleWaveformPreviewState)
  emitter.off('waveform-preview:pause-main', handleWaveformPreviewPauseMain)
  emitter.off('waveform-preview:resume-main', handleWaveformPreviewResumeMain)
  emitter.off(MAIN_WINDOW_VOLUME_SET_EVENT, handleMainWindowVolumeSet)
  window.electron.ipcRenderer.removeListener('player/global-shortcut', handleGlobalPlayerShortcut)
})

// 切歌响应（含预加载命中）
watch(
  () => runtime.playingData.playingSong,
  (newSong, oldSong) => {
    if (newSong?.filePath && newSong.filePath !== oldSong?.filePath) {
      keyboardPercentSeek.clear('song-change')
      if (!isRekordboxExternalPlaybackSource(runtime.playingData.playingSongListUUID, newSong)) {
        queueMainPlayerPlayingAnalysis(runtime, newSong.filePath)
      }
    }
    if (isInternalSongChange.value) {
      isInternalSongChange.value = false
      return
    }

    if (newSong === null) {
      if (audioPlayer.value) {
        ignoreNextEmptyError.value = true
        audioPlayer.value.empty()
      }
      waveformShow.value = false
      runtime.playingData.playingSongListUUID = ''
      bpm.value = ''
    } else if (newSong?.filePath !== oldSong?.filePath) {
      if (newSong?.fileMissing) return
      const newPath = newSong.filePath
      setCoverByIPC(newPath)
      requestLoadSong(newPath)
    } else if (newSong && oldSong && newSong !== oldSong && newSong.filePath === oldSong.filePath) {
      setCoverByIPC(newSong.filePath)
    }
  }
)

watch(
  () => projectSongBeatGridMapV2ToFixedGrid(runtime.playingData.playingSong?.beatGridMap)?.bpm,
  (newBpm) => {
    if (typeof newBpm === 'number' && Number.isFinite(newBpm) && newBpm > 0) {
      bpm.value = newBpm
    }
  }
)

// 控件区域展开/收起后宽度刷新
watch(
  () => runtime.setting.hiddenPlayControlArea,
  async (newValue, oldValue) => {
    if (newValue !== oldValue && waveformShow.value && audioPlayer.value) {
      await nextTick()
      updateParentWaveformWidth()
    }
  }
)
</script>
<template>
  <transition name="player-area-toggle">
    <div
      v-show="waveformShow"
      class="playerArea"
      data-user-guide-target="song-player"
      style="
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        padding: 0 5px 0 0;
        box-sizing: border-box;
      "
    >
      <PlayerCoverSlot
        :cover-blob-url="coverBlobUrl"
        :placeholder-src="placeholderLogo"
        @hover-cover="songInfoShow = true"
      />
      <transition name="fade">
        <div v-if="songInfoShow" class="songInfo" @mouseleave="handleSongInfoMouseLeave">
          <div class="cover unselectable" @contextmenu.prevent="showCoverContextMenu">
            <img
              v-if="coverBlobUrl"
              :src="coverBlobUrl"
              style="width: 280px; height: 280px"
              draggable="false"
            />
            <img
              v-else
              :src="placeholderLogo"
              style="width: 48px; height: 48px"
              draggable="false"
            />
          </div>
          <div style="font-size: 14px" class="info">
            {{ runtime.playingData.playingSong?.title }}
          </div>
          <div style="font-size: 12px" class="info">
            {{ runtime.playingData.playingSong?.artist }}
          </div>
          <div style="font-size: 10px" class="info">
            {{ runtime.playingData.playingSong?.album }}
          </div>
          <div style="font-size: 10px" class="info">
            {{ runtime.playingData.playingSong?.label }}
          </div>
        </div>
      </transition>
      <div
        class="controlsContainer"
        :style="{ width: runtime.setting.hiddenPlayControlArea ? '42px' : '280px' }"
      >
        <transition name="player-controls-toggle">
          <playerControls
            :playing="isPlaying"
            :hide-playback-controls="runtime.setting.hiddenPlayControlArea"
            @pause="playerActions.pause"
            @play="handleUserPlay"
            @fast-forward="playerActions.fastForward"
            @fast-backward="playerActions.fastBackward"
            @next-song="handleUserNextSong"
            @previous-song="handleUserPreviousSong"
            @del-song="playerActions.delSong"
            @del-all-above="playerActions.delAllAbove"
            @move-to-list-library="
              (song, actionMode) => playerActions.moveToListLibrary(song, actionMode)
            "
            @move-to-like-library="
              (song, actionMode) => playerActions.moveToLikeLibrary(song, actionMode)
            "
            @move-to-set-library="(song) => playerActions.moveToSetLibrary(song)"
            @move-to-mixtape-library="(song) => playerActions.moveToMixtapeLibrary(song)"
            @export-track="playerActions.exportTrack"
            @toggle-mini-window="toggleMiniPlayer"
          />
        </transition>
      </div>

      <div class="main-player-waveform-slot unselectable">
        <div id="waveform" ref="waveform">
          <div id="time">0:00</div>
          <div id="duration">0:00</div>
          <div id="hover"></div>
          <MemoryCueMarkersLayer
            :memory-cues="runtime.playingData.playingSong?.memoryCues || []"
            :visible-duration-sec="playerWaveformDurationSec"
            anchor="top"
            size="compact"
          />
          <HotCueMarkersLayer
            :hot-cues="runtime.playingData.playingSong?.hotCues || []"
            :visible-duration-sec="playerWaveformDurationSec"
            anchor="top"
            size="compact"
            clickable
            @marker-click="handleMainWaveformHotCueClick($event.sec)"
          />
          <PlaybackRangeHandles
            v-model:model-value-start="playbackRangeHandleStartPercent"
            v-model:model-value-end="playbackRangeHandleEndPercent"
            :container-width="waveformContainerWidth"
            :enable-playback-range="playbackRangeHandlesVisible"
            :waveform-show="waveformShow"
            :locked="playbackRangeHandlesLocked"
            :locked-ranges="playbackRangeLockedRanges"
            @drag-end="handlePlaybackRangeDragEnd"
          />
        </div>
        <PlayerStructureRail
          :song="runtime.playingData.playingSong"
          :current-seconds="playerCurrentSeconds"
          :duration-seconds="playerWaveformDurationSec"
          @seek-play="handlePlayerStructureSectionClick"
        />
      </div>
      <BpmTap :song="runtime.playingData.playingSong" :waveform-show="waveformShow" />
    </div>
  </transition>
  <Teleport to="body">
    <selectSongListDialog
      v-if="selectSongListDialogShow"
      :library-name="selectSongListDialogLibraryName"
      :action-mode="selectSongListDialogActionMode"
      @confirm="selectSongListDialogConfirm"
      @cancel="
        () => {
          selectSongListDialogShow = false
        }
      "
    />
  </Teleport>
</template>
<style lang="scss" scoped>
.songInfo {
  width: 300px;
  height: 370px;
  background-color: var(--bg-elev);
  position: absolute;
  bottom: 25px;
  left: 50px;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding-top: 10px;
  z-index: var(--z-popover);
  color: var(--text);

  .cover {
    width: 100%;
    height: 280px;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .info {
    width: 100%;
    padding: 5px 10px 0;
    box-sizing: border-box;
    white-space: nowrap;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter,
.fade-leave-to {
  opacity: 0;
}

.main-player-waveform-slot {
  flex: 1 1 auto;
  display: flex;
  min-width: 0;
  height: 52px;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  position: relative;
}

.main-player-waveform-slot :deep(.player-structure-rail--empty) {
  display: none;
}

#waveform {
  position: relative;
  flex: 0 0 40px;
  width: 100%;
  min-height: 40px;
  background: var(--waveform-bg);
  overflow: hidden;
}

#hover {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 10;
  pointer-events: none;
  height: 100%;
  width: 0;
  mix-blend-mode: overlay;
  background: rgba(255, 255, 255, 0.5);
  opacity: 0;
  transition: opacity 0.2s ease;
}

#waveform:hover #hover {
  opacity: 1;
}

#time,
#duration {
  position: absolute;
  z-index: 11;
  top: 50%;
  margin-top: -1px;
  transform: translateY(-50%);
  font-size: 11px;
  background: rgba(0, 0, 0, 0.75);
  padding: 2px;
  color: #ddd;
}

#time {
  left: 0;
}

#duration {
  right: 0;
}

.player-area-toggle-enter-active,
.player-area-toggle-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.player-area-toggle-enter-from,
.player-area-toggle-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.controlsContainer {
  transition: width 0.22s ease;
  /* 允许音量条、更多菜单浮层溢出容器 */
  overflow: visible;
}

.player-controls-toggle-enter-active,
.player-controls-toggle-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.player-controls-toggle-enter-from,
.player-controls-toggle-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

@media (prefers-reduced-motion: reduce) {
  .player-area-toggle-enter-active,
  .player-area-toggle-leave-active,
  .player-controls-toggle-enter-active,
  .player-controls-toggle-leave-active,
  .controlsContainer {
    transition: none;
  }
}
</style>
