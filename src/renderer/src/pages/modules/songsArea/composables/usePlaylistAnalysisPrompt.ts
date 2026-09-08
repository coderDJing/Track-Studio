import { computed, onMounted, onUnmounted, ref, type Ref } from 'vue'
import {
  collectMissingAnalysisFilesFromSongs,
  promptAndQueueManualKeyAnalysisBatch
} from '@renderer/utils/manualKeyAnalysis'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import type { ISongInfo } from '../../../../../../types/globals'
import {
  isCurrentRendererWindowsPathPlatform,
  normalizeFilePathForComparison
} from '@shared/filePathComparison'

type PlaylistAnalysisRuntime = {
  libraryAreaSelected: string
  manualKeyAnalysisPendingFilePaths: string[]
  analysisRuntime: {
    available: boolean
  }
  playlistAnalysisPromptDismissedSongListUUIDs: string[]
}

type SongsAreaAnalysisState = {
  songListUUID: string
  songInfoArr: ISongInfo[]
  missingWaveformFilePaths: string[]
}

type QueueManualBatchResult = {
  batchId?: string
  queued?: number
  canceled?: boolean
  empty?: boolean
  aborted?: boolean
}

type PromptOwnedManualBatch = {
  songListUUID: string
}

type ManualBatchEndPayload = {
  batchId?: string
  filePaths?: string[]
  canceled?: boolean
}

type OpenSongListAnalysisPromptOptions = {
  forceAnalysisPrompt?: boolean
  source?: string
}

const normalizeFilePathKey = (filePath: string) =>
  normalizeFilePathForComparison(filePath, isCurrentRendererWindowsPathPlatform())

export function usePlaylistAnalysisPrompt({
  runtime,
  songsAreaState,
  isMixtapeListView
}: {
  runtime: PlaylistAnalysisRuntime
  songsAreaState: SongsAreaAnalysisState
  isMixtapeListView: Ref<boolean>
}) {
  const manualAnalyzePending = ref(false)
  const promptOwnedManualBatches = new Map<string, PromptOwnedManualBatch>()
  const missingAnalysisFiles = computed(() =>
    collectMissingAnalysisFilesFromSongs(
      songsAreaState.songInfoArr,
      runtime.analysisRuntime.available === true,
      undefined,
      {
        includeSongStructure: true,
        missingWaveformFilePaths: songsAreaState.missingWaveformFilePaths
      }
    )
  )

  const resolveManualBatchPendingFiles = async (filePaths: readonly string[]) => {
    const fallbackPendingFiles = Array.isArray(runtime.manualKeyAnalysisPendingFilePaths)
      ? runtime.manualKeyAnalysisPendingFilePaths
      : []
    if (!filePaths.length) return [] as string[]
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'key-analysis:manual-batch-pending',
        {
          filePaths: [...filePaths]
        }
      )) as { filePaths?: string[] } | null
      return Array.isArray(result?.filePaths) ? result.filePaths : fallbackPendingFiles
    } catch {
      return fallbackPendingFiles
    }
  }

  const filterManualBatchPendingFiles = async (filePaths: readonly string[]) => {
    const pendingFiles = await resolveManualBatchPendingFiles(filePaths)
    const pendingPathSet = new Set(
      pendingFiles.map((filePath) => normalizeFilePathKey(filePath)).filter(Boolean)
    )
    return {
      files: filePaths.filter((filePath) => !pendingPathSet.has(normalizeFilePathKey(filePath))),
      pendingFiles
    }
  }

  const shouldSkipAnalysisPrompt = (songListUUID: string) =>
    !songListUUID ||
    songListUUID === EXTERNAL_PLAYLIST_UUID ||
    songListUUID === RECYCLE_BIN_UUID ||
    songListUUID === RECORDING_LIBRARY_UUID ||
    runtime.libraryAreaSelected === 'RecordingLibrary' ||
    isMixtapeListView.value

  const clearDismissedSongList = (songListUUID: string) => {
    runtime.playlistAnalysisPromptDismissedSongListUUIDs =
      runtime.playlistAnalysisPromptDismissedSongListUUIDs.filter((uuid) => uuid !== songListUUID)
  }

  const isDismissedSongList = (songListUUID: string) =>
    runtime.playlistAnalysisPromptDismissedSongListUUIDs.includes(songListUUID)

  const markDismissedSongList = (songListUUID: string) => {
    if (isDismissedSongList(songListUUID)) return
    runtime.playlistAnalysisPromptDismissedSongListUUIDs = [
      ...runtime.playlistAnalysisPromptDismissedSongListUUIDs,
      songListUUID
    ]
  }

  const rememberManualBatch = (result: QueueManualBatchResult, songListUUID: string) => {
    const batchId = String(result?.batchId || '').trim()
    if (!batchId || !songListUUID) return
    promptOwnedManualBatches.set(batchId, { songListUUID })
  }

  const handleManualBatchEnd = (_event: unknown, payload?: ManualBatchEndPayload) => {
    const batchId = String(payload?.batchId || '').trim()
    if (!batchId) return
    const owned = promptOwnedManualBatches.get(batchId)
    if (!owned) return
    promptOwnedManualBatches.delete(batchId)
    if (songsAreaState.songListUUID !== owned.songListUUID) return
    if (missingAnalysisFiles.value.length) markDismissedSongList(owned.songListUUID)
    else clearDismissedSongList(owned.songListUUID)
  }

  const handleSongWaveformUpdated = (_event: unknown, payload?: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    const pathKey = normalizeFilePathKey(filePath)
    if (!pathKey || songsAreaState.missingWaveformFilePaths.length === 0) return
    songsAreaState.missingWaveformFilePaths = songsAreaState.missingWaveformFilePaths.filter(
      (item) => normalizeFilePathKey(item) !== pathKey
    )
  }

  onMounted(() => {
    window.electron.ipcRenderer.on('key-analysis:manual-batch-end', handleManualBatchEnd)
    window.electron.ipcRenderer.on('song-waveform-updated', handleSongWaveformUpdated)
  })

  onUnmounted(() => {
    promptOwnedManualBatches.clear()
    window.electron.ipcRenderer.removeListener(
      'key-analysis:manual-batch-end',
      handleManualBatchEnd
    )
    window.electron.ipcRenderer.removeListener('song-waveform-updated', handleSongWaveformUpdated)
  })

  const analysisPromptPending = ref(false)

  const handleUserOpenedSongList = async (
    songListUUID: string,
    options?: OpenSongListAnalysisPromptOptions
  ) => {
    analysisPromptPending.value = true
    try {
      if (shouldSkipAnalysisPrompt(songListUUID)) return

      const missingFilesForEvaluation = missingAnalysisFiles.value
      if (!missingFilesForEvaluation.length) {
        clearDismissedSongList(songListUUID)
        return
      }
      const promptMissingResult = await filterManualBatchPendingFiles(missingFilesForEvaluation)
      const missingFilesToPrompt = promptMissingResult.files
      if (!missingFilesToPrompt.length) {
        return
      }
      if (options?.forceAnalysisPrompt) {
        clearDismissedSongList(songListUUID)
      } else if (isDismissedSongList(songListUUID)) {
        return
      }

      const result = (await promptAndQueueManualKeyAnalysisBatch(
        missingFilesToPrompt,
        'tracks.analyzingPlaylist',
        {
          songs: songsAreaState.songInfoArr,
          missingWaveformFilePaths: songsAreaState.missingWaveformFilePaths,
          shouldContinue: () => songsAreaState.songListUUID === songListUUID,
          filterQueueFiles: async (files) => (await filterManualBatchPendingFiles(files)).files
        }
      )) as QueueManualBatchResult

      if (result?.canceled) {
        const stillMissingFiles = missingAnalysisFiles.value
        if (stillMissingFiles.length) markDismissedSongList(songListUUID)
        return
      }
      if (result?.aborted || result?.empty || !result?.batchId) {
        return
      }

      clearDismissedSongList(songListUUID)
      rememberManualBatch(result, songListUUID)
    } finally {
      analysisPromptPending.value = false
    }
  }

  const playlistAnalysisActionVisible = computed(
    () =>
      !manualAnalyzePending.value &&
      !shouldSkipAnalysisPrompt(songsAreaState.songListUUID) &&
      isDismissedSongList(songsAreaState.songListUUID) &&
      missingAnalysisFiles.value.length > 0
  )

  const analyzeDismissedPlaylist = async () => {
    const songListUUID = songsAreaState.songListUUID
    const missingFiles = missingAnalysisFiles.value
    if (
      manualAnalyzePending.value ||
      shouldSkipAnalysisPrompt(songListUUID) ||
      !isDismissedSongList(songListUUID) ||
      !missingFiles.length
    ) {
      return
    }

    manualAnalyzePending.value = true
    clearDismissedSongList(songListUUID)
    try {
      const pendingResult = await filterManualBatchPendingFiles(missingFiles)
      if (!pendingResult.files.length) return
      const result = (await promptAndQueueManualKeyAnalysisBatch(
        pendingResult.files,
        'tracks.analyzingPlaylist',
        {
          songs: songsAreaState.songInfoArr,
          missingWaveformFilePaths: songsAreaState.missingWaveformFilePaths,
          shouldContinue: () => songsAreaState.songListUUID === songListUUID,
          filterQueueFiles: async (files) => (await filterManualBatchPendingFiles(files)).files
        }
      )) as QueueManualBatchResult
      if (result.canceled || result.empty || result.aborted || !result.batchId) {
        markDismissedSongList(songListUUID)
        return
      }
      rememberManualBatch(result, songListUUID)
    } catch (error) {
      markDismissedSongList(songListUUID)
      console.error('queue playlist analysis failed', error)
    } finally {
      manualAnalyzePending.value = false
    }
  }

  return {
    playlistAnalysisActionVisible,
    playlistAnalysisActionPending: manualAnalyzePending,
    analysisPromptPending,
    handleUserOpenedSongList,
    analyzeDismissedPlaylist
  }
}
