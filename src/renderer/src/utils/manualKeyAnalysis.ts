import libraryUtils from '@renderer/utils/libraryUtils'
import confirm from '@renderer/components/confirmDialog'
import {
  collectMissingAnalysisFilesFromSongs,
  type MissingAnalysisOptions
} from './manualKeyAnalysisCompleteness'
import { useRuntimeStore } from '@renderer/stores/runtime'
import openAnalysisBpmRangeDialog from '@renderer/components/analysisBpmRangeDialog'
import {
  normalizeAnalysisBpmRangeId,
  type AnalysisBpmRangePresetId
} from '@shared/analysisBpmRange'
import { t } from '@renderer/utils/translate'

export {
  collectFilesNeedingSelectedAnalysis,
  collectMissingAnalysisFilesFromSongs,
  hasRequiredAnalysis,
  resolveMissingAnalysisReasons,
  type AnalysisCandidate,
  type MissingAnalysisOptions
} from './manualKeyAnalysisCompleteness'

type ScanSongListResult = {
  scanData?: Array<{
    filePath?: string
    key?: unknown
    bpm?: unknown
    firstBeatMs?: unknown
    beatGridMap?: unknown
    beatGridStatus?: unknown
    energyScore?: unknown
    energyAlgorithmVersion?: unknown
    songStructure?: unknown
  }>
  missingWaveformFilePaths?: string[]
}

type MissingAnalysisScanOptions = MissingAnalysisOptions & {
  onPlaylistScanned?: () => void
}

export const scanSongListsForMissingAnalysisFiles = async (
  uuids: string[],
  requiresRuntimeAnalysis: boolean,
  options: MissingAnalysisScanOptions = {}
): Promise<string[]> => {
  const { onPlaylistScanned, ...missingAnalysisOptions } = options
  const files: string[] = []
  const seen = new Set<string>()
  for (const uuid of uuids) {
    const dirPath = libraryUtils.findDirPathByUuid(uuid)
    try {
      const scan = (await window.electron.ipcRenderer.invoke(
        'scanSongList',
        dirPath,
        uuid
      )) as ScanSongListResult | null
      if (!Array.isArray(scan?.scanData)) continue
      files.push(
        ...collectMissingAnalysisFilesFromSongs(scan.scanData, requiresRuntimeAnalysis, seen, {
          ...missingAnalysisOptions,
          missingWaveformFilePaths: Array.isArray(scan.missingWaveformFilePaths)
            ? scan.missingWaveformFilePaths
            : undefined
        })
      )
    } finally {
      onPlaylistScanned?.()
    }
  }
  return files
}

export const queueManualKeyAnalysisBatch = async (
  filePaths: string[],
  titleKey: string,
  analysisBpmRangeId: AnalysisBpmRangePresetId,
  options?: {
    includeStructure?: boolean
    analysisTargets?: {
      key?: boolean
      bpm?: boolean
      waveform?: boolean
      energy?: boolean
      structure?: boolean
    }
  }
) =>
  await window.electron.ipcRenderer.invoke('key-analysis:queue-manual-batch', {
    analysisAuthority: 'frkb',
    filePaths,
    titleKey,
    analysisBpmRangeId,
    includeStructure: options?.includeStructure,
    analysisTargets: options?.analysisTargets
  })

export const promptAndQueueManualKeyAnalysisBatch = async (
  filePaths: string[],
  titleKey: string,
  options?: {
    songs?: Array<
      | {
          filePath?: unknown
          beatGridStatus?: unknown
          beatGridMap?: unknown
          key?: unknown
          energyScore?: unknown
          songStructure?: unknown
          fileMissing?: boolean
        }
      | null
      | undefined
    >
    missingWaveformFilePaths?: readonly string[]
    shouldContinue?: () => boolean
    filterQueueFiles?: (files: string[]) => Promise<string[]> | string[]
  }
) => {
  const { promptTrackAnalysisSelection, filterFilesForSelectedMissingAnalysis } =
    await import('@renderer/utils/trackReanalysis')
  const prompted = await promptTrackAnalysisSelection({
    filePaths,
    songs: options?.songs,
    purpose: 'missing'
  })
  if (!prompted) {
    return { batchId: '', queued: 0, canceled: true }
  }
  if (options?.shouldContinue && !options.shouldContinue()) {
    return { batchId: '', queued: 0, canceled: false, aborted: true }
  }
  const files = filterFilesForSelectedMissingAnalysis(
    prompted.files,
    prompted.selection,
    options?.songs,
    options?.missingWaveformFilePaths
  )
  if (!files.length) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('tracks.noMissingAnalysisTracks')],
      confirmShow: false
    })
    return { batchId: '', queued: 0, canceled: false, empty: true }
  }
  const queueFiles = options?.filterQueueFiles ? await options.filterQueueFiles(files) : files
  if (!queueFiles.length) {
    return { batchId: '', queued: 0, canceled: false, empty: true }
  }
  if (options?.shouldContinue && !options.shouldContinue()) {
    return { batchId: '', queued: 0, canceled: false, aborted: true }
  }
  const rangeId = prompted.selection.beatGrid
    ? normalizeAnalysisBpmRangeId(prompted.analysisBpmRangeId)
    : normalizeAnalysisBpmRangeId(useRuntimeStore().setting.analysisBpmRange)
  const queued = await queueManualKeyAnalysisBatch(queueFiles, titleKey, rangeId, {
    includeStructure: prompted.selection.structure,
    analysisTargets: {
      key: prompted.selection.key,
      bpm: prompted.selection.beatGrid,
      waveform: prompted.selection.waveform,
      energy: prompted.selection.energy,
      structure: prompted.selection.structure
    }
  })
  return {
    ...queued,
    selection: prompted.selection
  }
}

export const promptAnalysisBpmRangeForManualBatch = async (count: number) => {
  const runtime = useRuntimeStore()
  const initialRangeId = normalizeAnalysisBpmRangeId(runtime.setting.analysisBpmRange)
  const selectedRangeId = await openAnalysisBpmRangeDialog({
    count,
    initialRangeId
  })
  if (!selectedRangeId) return null

  if (runtime.setting.analysisBpmRange !== selectedRangeId) {
    runtime.setting.analysisBpmRange = selectedRangeId
    await window.electron.ipcRenderer.invoke(
      'setSetting',
      JSON.parse(JSON.stringify(runtime.setting))
    )
  }

  return selectedRangeId
}
