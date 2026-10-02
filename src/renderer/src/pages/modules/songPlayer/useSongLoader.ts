import { ref, onBeforeUnmount, shallowRef } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import emitter from '@renderer/utils/mitt'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  getRekordboxPreviewWaveformRequestChannel,
  isRekordboxExternalPlaybackSource,
  resolveSongExternalWaveformSource
} from '@renderer/utils/rekordboxExternalSource'
import { WebAudioPlayer, canPlayHtmlAudio } from './webAudioPlayer'
import libraryUtils from '@renderer/utils/libraryUtils'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import type { IPioneerPreviewWaveformData } from 'src/types/globals'
import type { WaveformGlobalOverviewData } from '@shared/waveformSurfaceCache'
import { resolvePlayerWaveformTraceElapsedMs, sendPlayerWaveformTrace } from './playerWaveformTrace'
import { normalizePlaybackHandoffSeconds } from '@renderer/utils/mainWindowPlaybackHandoff'
import {
  queueMainPlayerPlayingAnalysis,
  resolveBrowserMainPlayerAnalysisIntent
} from '@renderer/utils/playlistAnalysisGate'
import { resolveInitialPlaybackRangeStartSec } from '@shared/playbackRange'
import { projectSongBeatGridMapV2ToFixedGrid } from '@shared/songBeatGridMapV2'
import { loadRekordboxPlaybackRuntime } from '@renderer/utils/loadRekordboxPlaybackRuntime'

type WaveformCacheResponse = {
  items?: Array<{
    filePath: string
    data: WaveformGlobalOverviewData | null
  }>
}

type PioneerPreviewWaveformResponse = {
  items?: Array<{ analyzePath: string; data: IPioneerPreviewWaveformData | null }>
}

type DecodePayload = {
  pcmData: Float32Array
  sampleRate: number
  channels: number
  totalFrames: number
  compactVisualWaveformData?: WaveformGlobalOverviewData | null
}

type DeleteSongsSummary = {
  removedPaths?: unknown
}

const PLAYER_FOREGROUND_ACTIVITY_CHANNEL = 'player:foreground-activity'

const resolveRemovedPaths = (summary: DeleteSongsSummary | null | undefined) =>
  Array.isArray(summary?.removedPaths)
    ? summary.removedPaths.filter((item): item is string => typeof item === 'string')
    : []

export function useSongLoader(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  audioPlayer: ReturnType<typeof shallowRef<WebAudioPlayer | null>>
  bpm: { value: number | string }
  waveformShow: { value: boolean }
  setCoverByIPC: (filePath: string) => void
}) {
  const { runtime, audioPlayer, bpm, waveformShow, setCoverByIPC } = params
  const isAbortError = (error: unknown) =>
    error instanceof Error ? error.name === 'AbortError' : false

  const currentLoadRequestId = ref(0)
  const isLoadingBlob = ref(false)
  const ignoreNextEmptyError = ref(false)
  let waveformTraceStartedAt = 0
  let htmlPlaybackForegroundCleanup: (() => void) | null = null

  const sendPlaybackForegroundActivity = (
    state: 'start' | 'end',
    source: string,
    filePath: string,
    requestId: number,
    reason?: string
  ) => {
    window.electron.ipcRenderer.send(PLAYER_FOREGROUND_ACTIVITY_CHANNEL, {
      state,
      source,
      filePath,
      requestId,
      reason
    })
  }

  const clearHtmlPlaybackForegroundActivity = () => {
    htmlPlaybackForegroundCleanup?.()
    htmlPlaybackForegroundCleanup = null
  }

  const startHtmlPlaybackForegroundActivity = (
    playerInstance: WebAudioPlayer,
    filePath: string,
    requestId: number
  ) => {
    clearHtmlPlaybackForegroundActivity()
    let foregroundActive = true
    sendPlaybackForegroundActivity('start', 'html-load', filePath, requestId)

    const endForegroundActivity = (reason: string) => {
      if (!foregroundActive) return
      foregroundActive = false
      sendPlaybackForegroundActivity('end', 'html-load', filePath, requestId, reason)
    }
    const cleanup = () => {
      playerInstance.off('ready', handleReady)
      playerInstance.off('error', handleError)
      endForegroundActivity('cleanup')
    }
    const handleReady = () => {
      clearHtmlPlaybackForegroundActivity()
    }
    const handleError = () => {
      clearHtmlPlaybackForegroundActivity()
    }
    playerInstance.on('ready', handleReady)
    playerInstance.on('error', handleError)
    htmlPlaybackForegroundCleanup = cleanup
  }

  const resolveBrowserPlaybackHandoff = (filePath: string, durationSec: number) => {
    const handoff = runtime.mainWindowPlaybackHandoff
    if (!handoff || handoff.targetMode !== 'browser') return null
    if (String(handoff.song?.filePath || '').trim() !== filePath) return null
    return {
      id: handoff.id,
      currentSec: normalizePlaybackHandoffSeconds(handoff.currentSec, durationSec),
      shouldPlay: handoff.shouldPlay
    }
  }

  const clearBrowserPlaybackHandoff = (handoffId: number) => {
    if (runtime.mainWindowPlaybackHandoff?.id !== handoffId) return
    runtime.mainWindowPlaybackHandoff = null
  }

  let errorDialogShowing = false
  const handleSongLoadError = async (
    filePath: string | null,
    _isPreload: boolean,
    errorMessage?: string
  ) => {
    void _isPreload
    if (!filePath || errorDialogShowing) return

    errorDialogShowing = true
    const localFilePath = filePath

    try {
      // 只有路径明确不存在时，才标记文件缺失并自动跳下一首
      const songIndex = runtime.playingData.playingSongListData.findIndex(
        (item) => item.filePath === localFilePath
      )
      if (songIndex !== -1) {
        const fileExists = await window.electron.ipcRenderer
          .invoke('check-path-exists', localFilePath)
          .catch(() => true)
        if (fileExists === false) {
          runtime.playingData.playingSongListData[songIndex] = {
            ...runtime.playingData.playingSongListData[songIndex],
            fileMissing: true
          }
          // 通知 UI 更新原始数据中的 fileMissing 状态
          emitter.emit('songFileMissing', {
            listUUID: runtime.playingData.playingSongListUUID,
            filePath: localFilePath
          })
          // 尝试找到下一首非缺失的曲目（先向后，再向前）
          const songList = runtime.playingData.playingSongListData
          let nextSongData: (typeof songList)[number] | null = null
          for (let i = songIndex + 1; i < songList.length; i++) {
            if (!songList[i].fileMissing) {
              nextSongData = songList[i]
              break
            }
          }
          if (!nextSongData) {
            for (let i = songIndex - 1; i >= 0; i--) {
              if (!songList[i].fileMissing) {
                nextSongData = songList[i]
                break
              }
            }
          }
          if (nextSongData) {
            runtime.playingData.playingSong = nextSongData
            errorDialogShowing = false
            requestLoadSong(nextSongData.filePath)
          } else {
            runtime.playingData.playingSong = null
            runtime.isSwitchingSong = false
            if (audioPlayer.value) {
              ignoreNextEmptyError.value = true
              audioPlayer.value.empty()
            }
          }
          return
        }
      }

      if (audioPlayer.value && audioPlayer.value.isPlaying()) {
        audioPlayer.value.pause()
      }
      waveformShow.value = false
      bpm.value = 'N/A'

      // 记录错误到控制台
      console.error('[播放失败]', filePath, errorMessage || '未知错误')

      const content = errorMessage
        ? [t('tracks.cannotPlay'), errorMessage, t('tracks.cannotPlayHint')]
        : [t('tracks.cannotPlay'), t('tracks.cannotPlayHint')]

      const res = await confirm({
        title: t('common.error'),
        content
      })

      if (res === 'confirm') {
        const currentListUUID = runtime.playingData.playingSongListUUID
        const isRecycleBinView = currentListUUID === RECYCLE_BIN_UUID
        const isExternalView = currentListUUID === EXTERNAL_PLAYLIST_UUID
        let removedPathsForEvent: string[] = []
        if (isRecycleBinView) {
          const summary = (await window.electron.ipcRenderer.invoke('permanentlyDelSongs', [
            localFilePath
          ])) as DeleteSongsSummary | null
          removedPathsForEvent = resolveRemovedPaths(summary)
        } else {
          const payload = isExternalView
            ? { filePaths: [localFilePath], sourceType: 'external' }
            : (() => {
                const songListPath = libraryUtils.findDirPathByUuid(currentListUUID)
                return songListPath ? { filePaths: [localFilePath], songListPath } : [localFilePath]
              })()
          const summary = (await window.electron.ipcRenderer.invoke(
            'delSongsAwaitable',
            payload
          )) as DeleteSongsSummary | null
          removedPathsForEvent = resolveRemovedPaths(summary)
        }
        if (removedPathsForEvent.length === 0) return

        const errorIndex = runtime.playingData.playingSongListData.findIndex(
          (item) => item.filePath === localFilePath
        )
        if (errorIndex !== -1) runtime.playingData.playingSongListData.splice(errorIndex, 1)

        if (runtime.playingData.playingSong?.filePath === localFilePath) {
          runtime.playingData.playingSong = null
          runtime.playingData.playingSongListUUID = ''
          if (audioPlayer.value) {
            ignoreNextEmptyError.value = true
            audioPlayer.value.empty()
          }
        }

        if (removedPathsForEvent.length > 0) {
          emitter.emit('songsRemoved', {
            listUUID: currentListUUID,
            paths: removedPathsForEvent
          })
          const changedPlaylistUuids = new Set<string>([RECYCLE_BIN_UUID])
          if (currentListUUID) changedPlaylistUuids.add(currentListUUID)
          emitter.emit('playlistContentChanged', { uuids: Array.from(changedPlaylistUuids) })
        }
      } else {
        if (runtime.playingData.playingSong?.filePath === localFilePath) {
          runtime.playingData.playingSong = null
          runtime.playingData.playingSongListUUID = ''
          if (audioPlayer.value) {
            ignoreNextEmptyError.value = true
            audioPlayer.value.empty()
          }
          waveformShow.value = false
        }
      }
    } catch (e) {
      // 忽略
    } finally {
      errorDialogShowing = false
    }
  }

  const resolveBpmValue = () => {
    const cachedBpm = projectSongBeatGridMapV2ToFixedGrid(
      runtime.playingData.playingSong?.beatGridMap
    )?.bpm
    if (typeof cachedBpm === 'number' && Number.isFinite(cachedBpm) && cachedBpm > 0) {
      bpm.value = cachedBpm
      return true
    }
    bpm.value = ''
    return false
  }

  const tracePlayerWaveform = (
    scope: string,
    stage: string,
    filePath?: string | null,
    payload?: Record<string, unknown>
  ) => {
    sendPlayerWaveformTrace(scope, stage, {
      requestId: currentLoadRequestId.value,
      filePath: typeof filePath === 'string' ? filePath : runtime.playingData.playingSong?.filePath,
      elapsedMs: resolvePlayerWaveformTraceElapsedMs(waveformTraceStartedAt),
      ...payload
    })
  }

  const fetchWaveformCache = async (filePath: string, requestId: number) => {
    if (
      isRekordboxExternalPlaybackSource(
        runtime.playingData.playingSongListUUID,
        runtime.playingData.playingSong
      )
    ) {
      return false
    }
    let response: WaveformCacheResponse | null = null
    tracePlayerWaveform('loader', 'formal-cache:query-start', filePath)
    try {
      response = await window.electron.ipcRenderer.invoke('waveform-global-overview-cache:batch', {
        filePaths: [filePath],
        queueIfMissing: false
      })
    } catch {
      response = null
    }

    if (requestId !== currentLoadRequestId.value) return false
    if (runtime.playingData.playingSong?.filePath !== filePath) return false

    const item = response?.items?.find((entry) => entry.filePath === filePath)
    const compactVisualWaveformData = item?.data ?? null
    const playerInstance = audioPlayer.value
    if (!playerInstance) return false
    if (!compactVisualWaveformData) {
      tracePlayerWaveform('loader', 'formal-cache:miss', filePath)
      return false
    }
    playerInstance.setCompactVisualWaveformData(compactVisualWaveformData)
    tracePlayerWaveform('loader', 'formal-cache:hit', filePath, {
      duration: Number(compactVisualWaveformData.duration || 0),
      sampleRate: Number(compactVisualWaveformData.sampleRate || 0),
      detailRate: Number(compactVisualWaveformData.detailRate || 0)
    })
    return true
  }

  const fetchPioneerPreviewWaveform = async (
    filePath: string,
    sourceKind: 'usb' | 'desktop',
    rootPath: string,
    analyzePath: string,
    requestId: number
  ) => {
    let response: PioneerPreviewWaveformResponse | null = null
    try {
      response = await window.electron.ipcRenderer.invoke(
        getRekordboxPreviewWaveformRequestChannel(sourceKind),
        rootPath,
        [analyzePath]
      )
    } catch {
      response = null
    }

    if (requestId !== currentLoadRequestId.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return

    const item = response?.items?.find((entry) => entry.analyzePath === analyzePath)
    const data = item?.data ?? null
    const playerInstance = audioPlayer.value
    if (!playerInstance) return
    playerInstance.setPioneerPreviewWaveformData(data)
    tracePlayerWaveform(
      'loader',
      data ? 'pioneer-preview:ready' : 'pioneer-preview:miss',
      filePath,
      {
        sourceKind,
        analyzePath
      }
    )
  }

  const startPlaybackWhenReady = (
    playerInstance: WebAudioPlayer,
    filePath: string,
    requestId: number
  ) => {
    const startPlay = () => {
      if (requestId !== currentLoadRequestId.value) return
      if (runtime.playingData.playingSong?.filePath !== filePath) return
      const duration = playerInstance.getDuration()
      const handoff = resolveBrowserPlaybackHandoff(filePath, duration)
      let startTime = handoff?.currentSec ?? 0
      if (!handoff && runtime.setting.enablePlaybackRange && duration > 0) {
        startTime = resolveInitialPlaybackRangeStartSec(
          runtime.setting,
          runtime.playingData.playingSong?.songStructure,
          duration
        )
      }
      try {
        if (handoff && !handoff.shouldPlay) {
          playerInstance.seek(startTime)
          runtime.playerReady = true
          runtime.isSwitchingSong = false
          return
        }
        playerInstance.play(startTime)
      } catch (playError: unknown) {
        if (!isAbortError(playError)) {
          void handleSongLoadError(filePath, false)
        }
      } finally {
        if (handoff) clearBrowserPlaybackHandoff(handoff.id)
        isLoadingBlob.value = false
      }
    }

    if (playerInstance.isReady()) {
      startPlay()
      return
    }

    playerInstance.once('ready', startPlay)
  }

  const handleLoadSong = async (filePath: string, requestId: number) => {
    if (requestId !== currentLoadRequestId.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return

    const playerInstance = audioPlayer.value
    if (!playerInstance) return

    setCoverByIPC(filePath)
    waveformShow.value = true
    resolveBpmValue()
    playerInstance.setPioneerPreviewWaveformData(null)

    isLoadingBlob.value = true

    const useHtmlPlayback = canPlayHtmlAudio(filePath)
    const currentSong = runtime.playingData.playingSong
    if (currentSong && isRekordboxExternalPlaybackSource('', currentSong)) {
      void loadRekordboxPlaybackRuntime(currentSong)
        .then((resolved) => {
          if (requestId !== currentLoadRequestId.value) return
          if (runtime.playingData.playingSong?.filePath !== filePath) return
          runtime.playingData.playingSong = resolved
          resolveBpmValue()
          emitter.emit('horizontalBrowse/shared-grid-batch-updated', [resolved])
        })
        .catch((error) => console.error('[rekordbox] load playback runtime failed', error))
    }
    const externalWaveformSource = resolveSongExternalWaveformSource(currentSong, {
      rootPath: runtime.pioneerDeviceLibrary.selectedSourceRootPath,
      sourceKind: runtime.pioneerDeviceLibrary.selectedSourceKind || undefined
    })
    tracePlayerWaveform('loader', 'load:start', filePath, {
      useHtmlPlayback,
      hasExternalWaveformSource: Boolean(externalWaveformSource)
    })
    try {
      playerInstance.setCompactVisualWaveformData(null)
      if (useHtmlPlayback) {
        startHtmlPlaybackForegroundActivity(playerInstance, filePath, requestId)
        playerInstance.loadFile(filePath)

        startPlaybackWhenReady(playerInstance, filePath, requestId)

        if (externalWaveformSource) {
          void fetchPioneerPreviewWaveform(
            filePath,
            externalWaveformSource.sourceKind,
            externalWaveformSource.rootPath,
            externalWaveformSource.analyzePath,
            requestId
          )
        } else {
          void (async () => {
            const hasCachedWaveform = await fetchWaveformCache(filePath, requestId)
            if (hasCachedWaveform) return
            if (requestId !== currentLoadRequestId.value) return
            if (runtime.playingData.playingSong?.filePath !== filePath) return
            tracePlayerWaveform('loader', 'formal-cache:queue-generation', filePath)
            queueMainPlayerPlayingAnalysis(runtime, filePath)
          })()
        }
      } else {
        clearHtmlPlaybackForegroundActivity()
        tracePlayerWaveform('loader', 'pcm-decode:request', filePath)
        const isRekordboxReadOnly = isRekordboxExternalPlaybackSource(
          runtime.playingData.playingSongListUUID,
          currentSong
        )
        const analysisIntent = resolveBrowserMainPlayerAnalysisIntent(runtime)
        window.electron.ipcRenderer.send('readSongFile', filePath, String(requestId), {
          analysisAuthority: !isRekordboxReadOnly ? 'frkb' : undefined,
          skipPlaybackGridAnalysis: isRekordboxReadOnly,
          onlyIfQueued: analysisIntent === 'promote-if-queued',
          suppressFrkbWaveformData: isRekordboxReadOnly
        })
      }
    } catch (loadError: unknown) {
      isLoadingBlob.value = false
      clearHtmlPlaybackForegroundActivity()
      if (!isAbortError(loadError)) {
        await handleSongLoadError(filePath, false)
      }
    }
  }

  const requestLoadSong = (filePath: string) => {
    const normalized = typeof filePath === 'string' ? filePath.trim() : ''
    if (!normalized) return

    isLoadingBlob.value = false
    if (audioPlayer.value) {
      if (audioPlayer.value.isPlaying()) audioPlayer.value.pause()
      ignoreNextEmptyError.value = true
    }

    runtime.playerReady = false

    const newRequestId = currentLoadRequestId.value + 1
    currentLoadRequestId.value = newRequestId
    waveformTraceStartedAt = performance.now()
    tracePlayerWaveform('loader', 'request-load', normalized)
    void handleLoadSong(normalized, newRequestId)
  }

  const handleWaveformUpdated = (_event: unknown, payload: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return
    tracePlayerWaveform('loader', 'formal-cache:updated-event', filePath)
    void fetchWaveformCache(filePath, currentLoadRequestId.value)
  }

  const handleReadedSongFile = (
    _event: unknown,
    payload: DecodePayload,
    filePath: string,
    requestId: string
  ) => {
    const requestNumber = Number(requestId)
    if (!Number.isFinite(requestNumber)) return
    if (requestNumber !== currentLoadRequestId.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return

    const playerInstance = audioPlayer.value
    if (!playerInstance) return

    try {
      playerInstance.loadPCM({
        pcmData: payload?.pcmData ?? new Float32Array(0),
        sampleRate: payload?.sampleRate ?? 0,
        channels: payload?.channels ?? 1,
        totalFrames: payload?.totalFrames ?? 0,
        compactVisualWaveformData: payload?.compactVisualWaveformData ?? null,
        filePath
      })
      tracePlayerWaveform('loader', 'pcm-decode:ready', filePath, {
        sampleRate: Number(payload?.sampleRate || 0),
        channels: Number(payload?.channels || 0),
        totalFrames: Number(payload?.totalFrames || 0),
        hasFormalWaveform: Boolean(payload?.compactVisualWaveformData)
      })
      startPlaybackWhenReady(playerInstance, filePath, requestNumber)
    } catch (error: unknown) {
      isLoadingBlob.value = false
      if (!isAbortError(error)) {
        void handleSongLoadError(filePath, false)
      }
    }
  }

  const handleReadSongFileError = (
    _event: unknown,
    filePath: string,
    message: string,
    requestId: string
  ) => {
    const requestNumber = Number(requestId)
    if (!Number.isFinite(requestNumber)) return
    if (requestNumber !== currentLoadRequestId.value) return
    if (runtime.playingData.playingSong?.filePath !== filePath) return
    isLoadingBlob.value = false
    void handleSongLoadError(filePath, false, message)
  }

  window.electron.ipcRenderer.on('song-waveform-updated', handleWaveformUpdated)
  window.electron.ipcRenderer.on('readedSongFile', handleReadedSongFile)
  window.electron.ipcRenderer.on('readSongFileError', handleReadSongFileError)

  onBeforeUnmount(() => {
    clearHtmlPlaybackForegroundActivity()
    window.electron.ipcRenderer.removeListener('song-waveform-updated', handleWaveformUpdated)
    window.electron.ipcRenderer.removeListener('readedSongFile', handleReadedSongFile)
    window.electron.ipcRenderer.removeListener('readSongFileError', handleReadSongFileError)
  })

  return {
    currentLoadRequestId,
    isLoadingBlob,
    ignoreNextEmptyError,
    requestLoadSong,
    handleSongLoadError
  }
}
