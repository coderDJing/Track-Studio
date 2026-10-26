import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import { computed, onMounted, onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import type { ISongInfo } from 'src/types/globals'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  buildAudioEditVersionLabel,
  parseAudioEditVersionBaseTitle,
  resolveNextAudioEditVersionNumber,
  normalizeAudioEditRange,
  type AudioEditRange
} from '@shared/audioEditTimeline'
import {
  isWritableFrkbAudioEditContext,
  resolveAudioEditListRoot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseAudioEditEligibility'
import { useHorizontalBrowseAudioEditSession } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseAudioEditSession'
import { useHorizontalBrowseAudioEditPlayback } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseAudioEditPlayback'
import { resolveAudioEditDisplayBeatGridMap } from '@shared/audioEditBeatGrid'
import { resolveSongBeatGridV2BeatJumpSec } from '@shared/songBeatGridMapV2'
import type { SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import { clampPlaybackRangePercent, isPlaybackSectionRangeMode } from '@shared/playbackRange'
import type { AudioEditLoopRange } from '@shared/audioEditMarkers'
import { buildAudioEditCommitIpcPayload } from '@renderer/composables/horizontalBrowse/audioEditCommitIpcPayload'
import { applyAudioEditSongListSnapshot } from '@renderer/composables/horizontalBrowse/audioEditSongListRefresh'
import emitter from '@renderer/utils/mitt'

type UseHorizontalBrowseAudioEditControllerParams = {
  isEditMode: ComputedRef<boolean>
  song: Ref<ISongInfo | null>
  sourceDurationSec: ComputedRef<number>
  nativePlaying: ComputedRef<boolean>
  nativeSeconds: Ref<number> | ComputedRef<number>
  quantizeEnabled: { readonly value: boolean }
  nativeSeek: (seconds: number) => void
  nativePause: () => void | Promise<void>
  nativeReleaseFile: () => void | Promise<void>
  nativePlayToggle: () => void
  reloadCurrentSong: () => void | Promise<void>
  onPlayheadSeek?: (seconds: number) => void
  resolveCuePointSec?: () => number | null
  resolveLoopRange?: () => AudioEditLoopRange | null
}

type PendingLeaveAction = () => unknown | Promise<unknown>

type AudioEditGridHost = {
  persistToFile: (filePath: string) => Promise<void>
  restoreFromSong: () => void
  clearHistory: () => void
}

const LOSSLESS_EXT = new Set(['wav', 'wave', 'aif', 'aiff', 'flac'])

const writeAudioEditSaveErrorLog = (stage: string, error: unknown) => {
  try {
    window.electron.ipcRenderer.send('outputLog', {
      level: 'error',
      source: 'renderer',
      scope: 'audio-edit-save',
      message: `${stage} ${error instanceof Error ? error.stack || error.message : String(error)}`
    })
  } catch {}
}

export const useHorizontalBrowseAudioEditController = (
  params: UseHorizontalBrowseAudioEditControllerParams
) => {
  const runtime = useRuntimeStore()
  const subMode = ref<'audio' | 'grid'>('audio')
  const saveOpen = ref(false)
  const leaveOpen = ref(false)
  const saving = ref(false)
  const saveError = ref('')
  const noticeMessage = ref('')
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let pendingLeaveAction: PendingLeaveAction | null = null
  let playbackHandoffToken = 0
  let sourceSessionId = uuidV4()
  let sourceSessionFilePath = ''
  let ignoreModeWatch = false
  const ownedPlayheadSec = ref(0)
  const editPlaying = ref(false)
  const liveDisplayBeatGridMap = ref<SongBeatGridMapV2 | null>(null)
  const gridDirty = ref(false)
  let gridHost: AudioEditGridHost | null = null
  let checkpointRangePercents = { start: 0, end: 100 }

  const songListUUID = computed(() => runtime.horizontalBrowseDecks.topSongListUUID)
  const writable = computed(() =>
    isWritableFrkbAudioEditContext({
      song: params.song.value,
      songListUUID: songListUUID.value
    })
  )
  const audioToolsVisible = computed(
    () => params.isEditMode.value && subMode.value === 'audio' && writable.value
  )
  const enabled = computed(() => params.isEditMode.value && writable.value)
  const filePath = computed(() => String(params.song.value?.filePath || ''))

  const releaseSourceSession = (sessionId: string) => {
    if (!sessionId) return
    void window.electron.ipcRenderer
      .invoke('song-edit:release-session', sessionId)
      .catch(() => undefined)
  }

  watch(
    filePath,
    (nextFilePath) => {
      if (sourceSessionFilePath && !sameRendererFilePath(sourceSessionFilePath, nextFilePath)) {
        releaseSourceSession(sourceSessionId)
        sourceSessionId = uuidV4()
      }
      sourceSessionFilePath = nextFilePath
    },
    { immediate: true }
  )
  const originalFormat = computed(() => {
    const ext = String(params.song.value?.fileFormat || '').toLowerCase()
    if (ext) return ext
    const name = String(params.song.value?.fileName || params.song.value?.filePath || '')
    return name.split('.').pop()?.toLowerCase() || 'mp3'
  })
  const losslessSource = computed(() => LOSSLESS_EXT.has(originalFormat.value))
  const versionPreviewName = computed(() => {
    const base = parseAudioEditVersionBaseTitle(
      String(params.song.value?.title || params.song.value?.fileName || 'Track')
    )
    const names = runtime.horizontalBrowseDecks.topSongListData.map((song) =>
      String(song.title || song.fileName || '')
    )
    return buildAudioEditVersionLabel(base, resolveNextAudioEditVersionNumber(base, names))
  })

  const resolveInitialPlaybackRangeSec = (): AudioEditRange | null => {
    const duration = Math.max(0, Number(params.sourceDurationSec.value) || 0)
    if (!(duration > 0) || runtime.setting.enablePlaybackRange !== true) return null
    if (isPlaybackSectionRangeMode(runtime.setting)) return null
    return normalizeAudioEditRange(
      (duration * clampPlaybackRangePercent(runtime.setting.startPlayPercent, 0)) / 100,
      (duration * clampPlaybackRangePercent(runtime.setting.endPlayPercent, 100)) / 100
    )
  }

  const displayBeatGridSignature = ref('')
  const session = useHorizontalBrowseAudioEditSession({
    song: params.song,
    sourceDurationSec: params.sourceDurationSec,
    playheadSec: ownedPlayheadSec,
    isPlaying: editPlaying,
    quantizeEnabled: params.quantizeEnabled,
    displayBeatGridSignature,
    resolveDisplayBeatGridMap: () =>
      liveDisplayBeatGridMap.value ??
      resolveAudioEditDisplayBeatGridMap({
        sourceMap: params.song.value?.beatGridMap,
        clips: session.clips.value,
        sourceDurationSec: params.sourceDurationSec.value,
        fallback: {
          bpm: params.song.value?.bpm,
          firstBeatMs: params.song.value?.firstBeatMs,
          downbeatBeatOffset: params.song.value?.downbeatBeatOffset
        }
      }),
    resolveCuePointSec: () => params.resolveCuePointSec?.() ?? null,
    resolveLoopRange: () => params.resolveLoopRange?.() ?? null,
    resolvePlaybackRangeSec: resolveInitialPlaybackRangeSec,
    onTimelineStructureChanged: () => gridHost?.clearHistory()
  })

  const displaySong = computed(() => {
    const song = params.song.value
    if (!song) return null
    if (!params.isEditMode.value) return song
    return {
      ...song,
      songStructure: session.songStructure.value ?? song.songStructure
    }
  })
  const isDirty = computed(() => session.isDirty.value || gridDirty.value)
  const canSave = computed(() => session.hasEdits.value || session.isDirty.value || gridDirty.value)

  const playback = useHorizontalBrowseAudioEditPlayback({
    filePath,
    clips: session.clips,
    enabled
  })

  watch(
    () => playback.playing.value,
    (value) => {
      editPlaying.value = value
    }
  )

  watch(
    () => playback.playheadSec.value,
    (sec) => {
      if (playback.playing.value) ownedPlayheadSec.value = sec
    }
  )

  watch(
    () => [params.isEditMode.value, playback.ready.value, params.nativeSeconds.value] as const,
    () => {
      if (playback.playing.value) return
      if (!playback.ready.value) ownedPlayheadSec.value = params.nativeSeconds.value
    }
  )

  watch(
    () => playback.ready.value,
    (ready) => {
      const token = (playbackHandoffToken += 1)
      if (!ready || playback.playing.value) return
      const durationSec = session.planDurationSec.value || params.sourceDurationSec.value
      const next = Math.max(0, Math.min(durationSec, Number(params.nativeSeconds.value) || 0))
      const shouldResume = params.nativePlaying.value
      ownedPlayheadSec.value = next
      void (async () => {
        if (shouldResume) await params.nativePause()
        if (token !== playbackHandoffToken || !playback.ready.value || !enabled.value) return
        const currentNativeSec = Number(params.nativeSeconds.value)
        const handoffSec =
          shouldResume && Number.isFinite(currentNativeSec)
            ? Math.max(0, Math.min(durationSec, currentNativeSec))
            : next
        ownedPlayheadSec.value = handoffSec
        await playback.seek(handoffSec)
        if (shouldResume && token === playbackHandoffToken && !playback.playing.value) {
          await playback.play()
        }
      })()
    }
  )

  const displaySeconds = computed(() =>
    enabled.value && playback.ready.value ? ownedPlayheadSec.value : params.nativeSeconds.value
  )

  const syncOwnedPlayheadFromDisplay = () => {
    ownedPlayheadSec.value = displaySeconds.value
  }

  const displayDuration = computed(() =>
    enabled.value
      ? session.planDurationSec.value || params.sourceDurationSec.value
      : params.sourceDurationSec.value
  )
  const displayPlaying = computed(() =>
    enabled.value && playback.ready.value ? playback.playing.value : params.nativePlaying.value
  )

  const showNotice = (message: string, durationMs = 2200) => {
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeMessage.value = message
    if (!message) return
    noticeTimer = setTimeout(() => {
      noticeTimer = null
      noticeMessage.value = ''
    }, durationMs)
  }

  const resolveErrorText = (code: string) => {
    if (code === 'playing') return t('audioEdit.playingLocked')
    if (code === 'empty') return t('audioEdit.emptyBlocked')
    if (code === 'duration') return t('audioEdit.durationBlocked')
    if (code === 'same-bound') return t('audioEdit.sameBound')
    return ''
  }

  const syncTimelinePresentation = () => {
    const durationSec = session.planDurationSec.value || params.sourceDurationSec.value
    const next = Math.max(0, Math.min(durationSec, Number(ownedPlayheadSec.value) || 0))
    ownedPlayheadSec.value = next
    params.onPlayheadSeek?.(next)
    if (playback.ready.value) void playback.seek(next)
  }

  const runMutation = (action: () => boolean, successMessage = '') => {
    const ok = action()
    if (!ok) {
      if (session.errorMessage.value) {
        saveError.value = resolveErrorText(session.errorMessage.value)
      }
      return false
    }
    saveError.value = ''
    syncTimelinePresentation()
    if (successMessage) showNotice(successMessage)
    return ok
  }

  const handleSeek = async (seconds: number) => {
    const durationSec = session.planDurationSec.value || params.sourceDurationSec.value
    const next = Math.max(0, Math.min(durationSec, Number(seconds) || 0))
    ownedPlayheadSec.value = next
    if (enabled.value && playback.ready.value) {
      params.onPlayheadSeek?.(next)
      await playback.seek(next)
      return
    }
    params.nativeSeek(next)
  }

  const handleSeekAndPlay = async (seconds: number) => {
    await handleSeek(seconds)
    if (enabled.value && playback.ready.value) {
      if (!playback.playing.value) await playback.play()
      return
    }
    if (!params.nativePlaying.value) params.nativePlayToggle()
  }

  const handleJumpBeats = async (direction: -1 | 1, beatCount: number) => {
    const song = params.song.value
    const projectedGrid =
      liveDisplayBeatGridMap.value ??
      resolveAudioEditDisplayBeatGridMap({
        sourceMap: song?.beatGridMap,
        clips: session.clips.value,
        sourceDurationSec: params.sourceDurationSec.value,
        fallback: {
          bpm: song?.bpm,
          firstBeatMs: song?.firstBeatMs,
          downbeatBeatOffset: song?.downbeatBeatOffset
        }
      })
    const beatDelta = direction * Math.max(1, beatCount)
    const dynamicTargetSec = resolveSongBeatGridV2BeatJumpSec(
      projectedGrid,
      displayDuration.value,
      ownedPlayheadSec.value,
      beatDelta
    )
    if (dynamicTargetSec !== null) {
      await handleSeek(dynamicTargetSec)
      return
    }
    const bpm = Number(song?.bpm) || 0
    const beatSec = bpm > 0 ? 60 / bpm : 1
    await handleSeek(ownedPlayheadSec.value + direction * beatSec * Math.max(1, beatCount))
  }

  const handlePlayPause = async () => {
    if (!enabled.value || !playback.ready.value) {
      params.nativePlayToggle()
      return
    }
    await params.nativePause()
    await playback.toggle()
  }

  const runPendingLeaveAction = async () => {
    const action = pendingLeaveAction
    pendingLeaveAction = null
    if (action) await action()
  }

  const requestLeaveForAction = (action: PendingLeaveAction) => {
    if (leaveOpen.value || saveOpen.value || saving.value) return
    pendingLeaveAction = action
    leaveOpen.value = true
  }

  const persistDisplayGridToFile = async (filePath: string) => {
    await gridHost?.persistToFile(filePath)
  }

  const captureRangePercents = () => {
    checkpointRangePercents = {
      start: clampPlaybackRangePercent(runtime.setting.startPlayPercent, 0),
      end: clampPlaybackRangePercent(runtime.setting.endPlayPercent, 100)
    }
  }

  const restoreRangePercents = () => {
    runtime.setting.startPlayPercent = checkpointRangePercents.start
    runtime.setting.endPlayPercent = checkpointRangePercents.end
  }

  const writePlaybackRangePercentsFromSession = () => {
    const range = session.playbackRange.value
    const duration = session.planDurationSec.value
    if (!range || !(duration > 0)) return
    runtime.setting.startPlayPercent = clampPlaybackRangePercent(
      (range.startSec / duration) * 100,
      0
    )
    runtime.setting.endPlayPercent = clampPlaybackRangePercent((range.endSec / duration) * 100, 100)
  }

  const persistGridOnly = async () => {
    const filePath = params.song.value?.filePath
    if (!filePath) return false
    saving.value = true
    saveError.value = ''
    try {
      await persistDisplayGridToFile(filePath)
      gridDirty.value = false
      showNotice(t('audioEdit.saved'))
      await runPendingLeaveAction()
      return true
    } catch (error) {
      writeAudioEditSaveErrorLog('音频编辑保存失败（仅网格）', error)
      saveError.value = t('audioEdit.saveFailed')
      pendingLeaveAction = null
      return false
    } finally {
      saving.value = false
    }
  }

  const finishLeave = (value: 'save' | 'discard' | 'cancel') => {
    leaveOpen.value = false
    if (value === 'cancel') {
      pendingLeaveAction = null
      return
    }
    if (value === 'save') {
      if (session.isDirty.value) {
        saveOpen.value = true
        return
      }
      void persistGridOnly()
      return
    }
    session.discardToCheckpoint()
    restoreRangePercents()
    gridHost?.restoreFromSong()
    gridDirty.value = false
    syncTimelinePresentation()
    void runPendingLeaveAction()
  }

  const commitSave = async (payload: {
    target: 'overwrite' | 'new-version'
    format: 'original' | 'wav'
  }) => {
    const song = params.song.value
    if (!song?.filePath || !session.clips.value.length) {
      saveOpen.value = false
      saveError.value = t('audioEdit.notReadyToSave')
      return false
    }
    saveOpen.value = false
    saving.value = true
    saveError.value = ''
    await playback.pause()
    await params.nativePause()
    const shouldReleaseNative = payload.target === 'overwrite'
    let releasedNative = false
    let succeeded = false
    let scanRefreshFailed = false
    let destPath = song.filePath
    try {
      if (shouldReleaseNative) {
        await params.nativeReleaseFile()
        releasedNative = true
      }
      const listRoot = resolveAudioEditListRoot(songListUUID.value)
      const result = (await window.electron.ipcRenderer.invoke(
        'song-edit:commit',
        buildAudioEditCommitIpcPayload({
          sessionId: sourceSessionId,
          sourceFilePath: song.filePath,
          listRoot,
          songListUUID: songListUUID.value,
          target: payload.target,
          outputFormat: payload.format,
          clips: session.clips.value,
          hotCues: session.hotCues.value,
          memoryCues: session.memoryCues.value,
          title: String(song.title || song.fileName || ''),
          insertAfterFilePath: song.filePath,
          existingNames: runtime.horizontalBrowseDecks.topSongListData.map((item) =>
            String(item.title || item.fileName || '')
          ),
          orderedFilePaths: runtime.horizontalBrowseDecks.topSongListData.map((item) =>
            String(item.filePath || '')
          )
        })
      )) as { outputFilePath?: string } | null
      destPath = String(result?.outputFilePath || song.filePath)
      await persistDisplayGridToFile(destPath)
      writePlaybackRangePercentsFromSession()
      if (listRoot && songListUUID.value) {
        try {
          const scanResult = (await window.electron.ipcRenderer.invoke(
            'scanSongList',
            listRoot,
            songListUUID.value,
            { source: 'audio-edit-save' }
          )) as { scanData?: ISongInfo[]; songListUUID?: string } | null
          const scanData = Array.isArray(scanResult?.scanData) ? scanResult.scanData : []
          if (String(scanResult?.songListUUID || '') !== songListUUID.value || !scanData.length) {
            scanRefreshFailed = true
          } else {
            applyAudioEditSongListSnapshot(runtime, songListUUID.value, scanData)
            emitter.emit('songsArea/reload-if-current', {
              uuid: songListUUID.value,
              scanData
            })
            emitter.emit('playlistContentChanged', { uuids: [songListUUID.value] })
          }
        } catch {
          scanRefreshFailed = true
        }
      }
      session.markCheckpoint()
      gridDirty.value = false
      if (releasedNative) {
        await params.reloadCurrentSong()
      }
      succeeded = true
    } catch (error) {
      writeAudioEditSaveErrorLog('音频编辑保存失败', error)
      if (releasedNative) {
        try {
          await params.reloadCurrentSong()
        } catch (reloadError) {
          writeAudioEditSaveErrorLog('音频编辑保存失败后恢复原曲目失败', reloadError)
        }
      }
      saveError.value = t('audioEdit.saveFailed')
      pendingLeaveAction = null
    } finally {
      saving.value = false
    }
    if (!succeeded) return false
    showNotice(
      scanRefreshFailed ? t('audioEdit.savedScanRefreshFailed') : t('audioEdit.saved'),
      scanRefreshFailed ? 5000 : 2200
    )
    await runPendingLeaveAction()
    return true
  }

  const requestSave = () => {
    if (!writable.value || saving.value || playback.playing.value || !canSave.value) return
    if (session.hasEdits.value || session.isDirty.value) {
      if (playback.preparing.value || !playback.ready.value) return
      saveOpen.value = true
      return
    }
    void persistGridOnly()
  }

  const retryPreparation = () => {
    if (!enabled.value || saving.value || playback.preparing.value) return
    saveError.value = ''
    void playback.reloadSource()
  }

  const cancelSave = () => {
    saveOpen.value = false
    pendingLeaveAction = null
  }

  const endEditSession = () => {
    void playback.pause()
    session.resetForSong()
    ownedPlayheadSec.value = Math.max(0, Number(params.nativeSeconds.value) || 0)
    saveError.value = ''
    showNotice('')
    gridDirty.value = false
    liveDisplayBeatGridMap.value = null
    displayBeatGridSignature.value = ''
    if (sourceSessionFilePath) {
      releaseSourceSession(sourceSessionId)
      sourceSessionId = uuidV4()
    }
  }

  watch(
    () => runtime.mainWindowBrowseMode,
    (mode, previous) => {
      if (ignoreModeWatch) return
      if (previous !== 'edit' || mode === 'edit') return
      if (saving.value) {
        ignoreModeWatch = true
        runtime.mainWindowBrowseMode = 'edit'
        ignoreModeWatch = false
        return
      }
      if (!isDirty.value) {
        endEditSession()
        return
      }
      ignoreModeWatch = true
      runtime.mainWindowBrowseMode = 'edit'
      ignoreModeWatch = false
      requestLeaveForAction(() => {
        endEditSession()
        ignoreModeWatch = true
        runtime.mainWindowBrowseMode = mode
        ignoreModeWatch = false
      })
    }
  )

  const handleNavigate = (direction: -1 | 1, nativeNavigate: (direction: -1 | 1) => boolean) => {
    if (isDirty.value) {
      requestLeaveForAction(() => nativeNavigate(direction))
      return false
    }
    return nativeNavigate(direction)
  }

  const handleContextChange = (action: PendingLeaveAction) => {
    if (saving.value) return false
    if (isDirty.value) {
      requestLeaveForAction(action)
      return false
    }
    void action()
    return true
  }

  const canMutateTimeline = () =>
    writable.value &&
    !saving.value &&
    !playback.playing.value &&
    !playback.preparing.value &&
    playback.ready.value &&
    !playback.prepareError.value

  const isTypingTarget = (event: KeyboardEvent) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return false
    if (target.isContentEditable) return true
    const tag = target.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
  }

  const setSelectionBound = (kind: 'start' | 'end') => {
    syncOwnedPlayheadFromDisplay()
    session.setPendingBound(kind)
    saveError.value = resolveErrorText(session.errorMessage.value)
  }

  const copySelection = () => {
    const ok = session.copySelection()
    if (!ok) return false
    saveError.value = ''
    showNotice(t('audioEdit.copied'))
    return true
  }

  const clearSelection = () => {
    session.clearSelection()
    saveError.value = ''
    showNotice(t('audioEdit.selectionCleared'))
  }

  const runMarkerMutation = (action: () => boolean) => {
    const ok = action()
    if (!ok) {
      if (session.errorMessage.value) saveError.value = resolveErrorText(session.errorMessage.value)
      return false
    }
    saveError.value = ''
    syncTimelinePresentation()
    return true
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!audioToolsVisible.value) return
    if (saveOpen.value || leaveOpen.value) return
    if (isTypingTarget(event)) return
    const ctrl = event.ctrlKey || event.metaKey
    if (ctrl && event.code === 'KeyS') {
      event.preventDefault()
      event.stopPropagation()
      requestSave()
      return
    }
    if (ctrl && event.code === 'KeyZ') {
      if (!canMutateTimeline()) return
      event.preventDefault()
      event.stopPropagation()
      runMutation(
        () => (event.shiftKey ? session.redo() : session.undo()),
        event.shiftKey ? t('audioEdit.redone') : t('audioEdit.undone')
      )
      return
    }
    if (ctrl && event.code === 'KeyY') {
      if (!canMutateTimeline()) return
      event.preventDefault()
      event.stopPropagation()
      runMutation(() => session.redo(), t('audioEdit.redone'))
      return
    }
    if (ctrl && event.code === 'KeyC') {
      if (!session.completeSelection.value) return
      event.preventDefault()
      event.stopPropagation()
      copySelection()
      return
    }
    if (ctrl && event.code === 'KeyX') {
      if (!canMutateTimeline() || !session.completeSelection.value) return
      event.preventDefault()
      event.stopPropagation()
      runMutation(() => session.cutSelection(true), t('audioEdit.cutDone'))
      return
    }
    if (ctrl && event.code === 'KeyV') {
      if (!canMutateTimeline() || !session.clipboard.value.length) return
      event.preventDefault()
      event.stopPropagation()
      runMutation(() => session.pasteClipboard(), t('audioEdit.pasted'))
      return
    }
    if (event.code === 'Delete' || event.code === 'Backspace') {
      if (ctrl) return
      if (!canMutateTimeline() || !session.completeSelection.value) return
      event.preventDefault()
      event.stopPropagation()
      runMutation(() => session.cutSelection(false), t('audioEdit.deleted'))
    }
  }

  watch(
    () => params.isEditMode.value,
    (editMode) => {
      if (!editMode) return
      captureRangePercents()
      gridDirty.value = false
    },
    { immediate: true }
  )

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown, true)
  })
  onUnmounted(() => {
    playbackHandoffToken += 1
    pendingLeaveAction = null
    if (noticeTimer) clearTimeout(noticeTimer)
    releaseSourceSession(sourceSessionId)
    window.removeEventListener('keydown', onKeyDown, true)
  })

  return {
    subMode,
    writable,
    audioToolsVisible,
    enabled,
    saveOpen,
    leaveOpen,
    saving,
    saveError,
    noticeMessage,
    session,
    playback,
    displaySeconds,
    displayDuration,
    displayPlaying,
    originalFormat,
    losslessSource,
    versionPreviewName,
    handleSeek,
    handleSeekAndPlay,
    handleJumpBeats,
    handlePlayPause,
    handleNavigate,
    handleContextChange,
    requestSave,
    retryPreparation,
    cancelSave,
    commitSave,
    finishLeave,
    setStart: () => setSelectionBound('start'),
    setEnd: () => setSelectionBound('end'),
    undo: () => runMutation(() => session.undo(), t('audioEdit.undone')),
    redo: () => runMutation(() => session.redo(), t('audioEdit.redone')),
    copy: copySelection,
    cut: () => runMutation(() => session.cutSelection(true), t('audioEdit.cutDone')),
    paste: () => runMutation(() => session.pasteClipboard(), t('audioEdit.pasted')),
    applyLoop: () => runMutation(() => session.applyLoop(), t('audioEdit.loopInserted')),
    loopMinus: () => runMutation(() => session.adjustLoopCount(-1), t('audioEdit.loopAdjusted')),
    loopPlus: () => runMutation(() => session.adjustLoopCount(1), t('audioEdit.loopAdjusted')),
    clearSelection,
    setHotCue: (slot: number) => runMarkerMutation(() => session.setHotCue(slot)),
    deleteHotCue: (slot: number) => runMarkerMutation(() => session.deleteHotCue(slot)),
    setMemoryCue: () => runMarkerMutation(() => session.setMemoryCue()),
    deleteMemoryCue: (sec: number) => runMarkerMutation(() => session.deleteMemoryCue(sec)),
    isDirty,
    canSave,
    displaySong,
    attachGridHost: (host: AudioEditGridHost | null) => {
      gridHost = host
    },
    handleDisplayBeatGridChange: (map: SongBeatGridMapV2 | null) => {
      liveDisplayBeatGridMap.value = map
      displayBeatGridSignature.value = map?.signature || ''
    },
    handleGridDirtyChange: (dirty: boolean) => {
      gridDirty.value = dirty
    }
  }
}
