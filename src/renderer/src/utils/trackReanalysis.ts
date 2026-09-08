import openTrackReanalysisDialog, {
  type TrackAnalysisDialogPurpose
} from '@renderer/components/trackReanalysisDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { collectFilesNeedingSelectedAnalysis } from '@renderer/utils/manualKeyAnalysisCompleteness'
import {
  canSelectStructureAloneFromSongs,
  normalizeTrackReanalysisSelection,
  type TrackReanalysisSongHint,
  type TrackReanalysisUserSelection
} from '@shared/trackReanalysisSelection'
import { normalizeAnalysisBpmRangeId } from '@shared/analysisBpmRange'
import {
  isCurrentRendererWindowsPathPlatform,
  normalizeFilePathForComparison
} from '@shared/filePathComparison'

const normalizeFilePathKey = (filePath: string) =>
  normalizeFilePathForComparison(filePath, isCurrentRendererWindowsPathPlatform())

const persistTrackAnalysisDialogSettings = async (
  purpose: TrackAnalysisDialogPurpose,
  selection: TrackReanalysisUserSelection,
  analysisBpmRangeId?: string
) => {
  const runtime = useRuntimeStore()
  if (purpose === 'missing') {
    runtime.setting.trackAnalysisSelection = selection
  } else {
    runtime.setting.trackReanalysisSelection = selection
  }
  if (analysisBpmRangeId) {
    runtime.setting.analysisBpmRange = normalizeAnalysisBpmRangeId(analysisBpmRangeId)
  }
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

export const promptTrackAnalysisSelection = async (options: {
  filePaths: string[]
  songs?: Array<TrackReanalysisSongHint | null | undefined>
  purpose: TrackAnalysisDialogPurpose
}) => {
  const files = Array.from(
    new Set(
      (Array.isArray(options.filePaths) ? options.filePaths : [])
        .filter((filePath): filePath is string => {
          return typeof filePath === 'string' && filePath.trim().length > 0
        })
        .map((filePath) => filePath.trim())
    )
  )
  if (!files.length) return null

  const runtime = useRuntimeStore()
  const songs = Array.isArray(options.songs) ? options.songs : []
  const initialSelection = normalizeTrackReanalysisSelection(
    options.purpose === 'missing'
      ? runtime.setting.trackAnalysisSelection
      : runtime.setting.trackReanalysisSelection
  )
  const result = await openTrackReanalysisDialog({
    count: files.length,
    purpose: options.purpose,
    initialSelection,
    canSelectStructureAlone: canSelectStructureAloneFromSongs(songs, files),
    initialBpmRangeId: normalizeAnalysisBpmRangeId(runtime.setting.analysisBpmRange)
  })
  if (!result) return null

  await persistTrackAnalysisDialogSettings(
    options.purpose,
    result.selection,
    result.analysisBpmRangeId
  )
  return {
    files,
    selection: result.selection,
    analysisBpmRangeId: result.analysisBpmRangeId
  }
}

export const promptAndStartTrackReanalysis = async (
  filePaths: string[],
  songs: Array<TrackReanalysisSongHint | null | undefined> = []
) => {
  const prompted = await promptTrackAnalysisSelection({
    filePaths,
    songs,
    purpose: 'reanalysis'
  })
  if (!prompted) return { canceled: true, queued: 0, cleared: 0 }

  const runtime = useRuntimeStore()
  const shouldHoldProgress = !runtime.isProgressing
  if (shouldHoldProgress) runtime.isProgressing = true
  try {
    return await window.electron.ipcRenderer.invoke('track:cache:clear:batch', {
      filePaths: prompted.files,
      selection: prompted.selection,
      analysisBpmRangeId: prompted.analysisBpmRangeId
    })
  } finally {
    if (shouldHoldProgress) runtime.isProgressing = false
  }
}

export const filterFilesForSelectedMissingAnalysis = (
  filePaths: string[],
  selection: TrackReanalysisUserSelection,
  songs: Array<TrackReanalysisSongHint | null | undefined> = [],
  missingWaveformFilePaths?: readonly string[]
) => {
  const files = Array.from(
    new Set(
      filePaths.filter((filePath) => typeof filePath === 'string' && filePath.trim().length > 0)
    )
  )
  if (!songs.length) return files
  const songList = songs.filter((song): song is TrackReanalysisSongHint => Boolean(song))
  const needed = new Set(
    collectFilesNeedingSelectedAnalysis(songList, selection, true, {
      missingWaveformFilePaths
    }).map((filePath) => normalizeFilePathKey(filePath))
  )
  return files.filter((filePath) => needed.has(normalizeFilePathKey(filePath)))
}
