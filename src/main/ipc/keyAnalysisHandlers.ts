import { ipcMain } from 'electron'
import {
  cancelKeyAnalysisBackground,
  cancelManualKeyAnalysisBatch,
  enqueueKeyAnalysis,
  enqueueKeyAnalysisList,
  enqueueManualKeyAnalysisBatch,
  getManualKeyAnalysisPendingFilePaths,
  isKeyAnalysisPathQueued,
  getKeyAnalysisBackgroundStatus
} from '../services/keyAnalysisQueue'
import { isInRecordingLibraryAbsPath } from '../recordingLibraryService'
import { isLibraryMergeMutationLocked } from '../services/libraryMerge/runtime'
import { shouldEnqueuePlayingAnalysis } from '../services/keyAnalysis/playingQueuePolicy'
import { normalizeAnalysisBpmRangeId } from '../../shared/analysisBpmRange'

type VisibleQueuePayload = {
  analysisAuthority?: 'frkb'
  filePaths?: string[]
  waveformOnly?: boolean
  scope?: 'waveform-preview'
}

type ManualBatchPayload = {
  analysisAuthority?: 'frkb'
  filePaths?: string[]
  titleKey?: string
  analysisBpmRangeId?: string
  includeStructure?: boolean
  analysisTargets?: {
    key?: boolean
    bpm?: boolean
    waveform?: boolean
    energy?: boolean
    structure?: boolean
  }
}

type PlaybackQueuePayload = {
  analysisAuthority?: 'frkb'
  filePath?: string
  focusSlot?: string
  onlyIfQueued?: boolean
  analysisTargets?: {
    bpm?: boolean
    waveform?: boolean
  }
}

const hasFrkbAnalysisAuthority = (payload: { analysisAuthority?: unknown } | null | undefined) =>
  payload?.analysisAuthority === 'frkb'

export function registerKeyAnalysisHandlers() {
  ipcMain.on('key-analysis:queue-visible', (_e, payload: VisibleQueuePayload) => {
    if (isLibraryMergeMutationLocked()) return
    if (!hasFrkbAnalysisAuthority(payload)) return
    const paths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
    const normalized = paths
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter((p) => p.length > 0)
    if (payload?.scope !== 'waveform-preview') return
    const waveformOnly = payload?.waveformOnly === true
    const normalPaths = normalized.filter((filePath) => !isInRecordingLibraryAbsPath(filePath))
    const recordingPaths = normalized.filter((filePath) => isInRecordingLibraryAbsPath(filePath))
    if (normalPaths.length > 0) {
      enqueueKeyAnalysisList(normalPaths, 'low', {
        source: 'foreground',
        preemptible: true,
        category: 'waveform-preview',
        waveformOnly,
        includeStructure: false
      })
    }
    if (recordingPaths.length > 0) {
      enqueueKeyAnalysisList(recordingPaths, 'low', {
        source: 'foreground',
        preemptible: true,
        category: 'waveform-preview',
        waveformOnly: true,
        includeStructure: false
      })
    }
  })

  ipcMain.on('key-analysis:queue-playing', (_e, payload: PlaybackQueuePayload) => {
    if (isLibraryMergeMutationLocked()) return
    if (!hasFrkbAnalysisAuthority(payload)) return
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return
    if (isInRecordingLibraryAbsPath(filePath)) return
    if (!shouldEnqueuePlayingAnalysis(payload?.onlyIfQueued, isKeyAnalysisPathQueued(filePath))) {
      return
    }
    enqueueKeyAnalysis(filePath, 'high', {
      urgent: true,
      source: 'foreground',
      focusSlot: payload?.focusSlot,
      includeStructure: payload?.onlyIfQueued !== true && !payload?.analysisTargets,
      analysisTargets: payload?.analysisTargets
    })
  })

  ipcMain.on('key-analysis:queue-deck-idle', (_e, payload: PlaybackQueuePayload) => {
    if (isLibraryMergeMutationLocked()) return
    if (!hasFrkbAnalysisAuthority(payload)) return
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return
    if (isInRecordingLibraryAbsPath(filePath)) return
    enqueueKeyAnalysis(filePath, 'low', {
      source: 'foreground',
      preemptible: true,
      includeStructure: !payload?.analysisTargets,
      analysisTargets: payload?.analysisTargets
    })
  })

  ipcMain.handle('key-analysis:cancel-background', (_e, payload?: { mode?: string }) => {
    const mode = String(payload?.mode || '')
    const pauseMs = mode === '1h' ? 60 * 60 * 1000 : mode === '3h' ? 3 * 60 * 60 * 1000 : 0
    cancelKeyAnalysisBackground(pauseMs || undefined)
  })

  ipcMain.handle('key-analysis:queue-manual-batch', (_e, payload?: ManualBatchPayload) => {
    if (isLibraryMergeMutationLocked()) {
      return { batchId: '', queued: 0, blocked: true }
    }
    if (!hasFrkbAnalysisAuthority(payload)) return { batchId: '', queued: 0, blocked: true }
    const paths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
    const normalized = paths
      .filter((p) => typeof p === 'string' && p.trim().length > 0)
      .filter((filePath) => !isInRecordingLibraryAbsPath(filePath))
    return enqueueManualKeyAnalysisBatch(normalized, {
      titleKey: typeof payload?.titleKey === 'string' ? payload.titleKey : undefined,
      analysisBpmRangeId: normalizeAnalysisBpmRangeId(payload?.analysisBpmRangeId),
      includeStructure: payload?.includeStructure,
      analysisTargets: payload?.analysisTargets
    })
  })

  ipcMain.handle('key-analysis:manual-batch-pending', (_e, payload?: { filePaths?: string[] }) => {
    const paths = Array.isArray(payload?.filePaths) ? payload.filePaths : undefined
    return { filePaths: getManualKeyAnalysisPendingFilePaths(paths) }
  })

  ipcMain.handle(
    'key-analysis:cancel-manual-batch',
    async (_e, payload?: { batchId?: string } | string) => {
      const batchId =
        typeof payload === 'string'
          ? payload
          : typeof payload?.batchId === 'string'
            ? payload.batchId
            : ''
      return await cancelManualKeyAnalysisBatch(batchId)
    }
  )

  ipcMain.handle('key-analysis:background-status', () => {
    return getKeyAnalysisBackgroundStatus()
  })
}
