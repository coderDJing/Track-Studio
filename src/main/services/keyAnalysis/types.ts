import fs from 'node:fs/promises'
import path from 'node:path'
import type { MixxxWaveformData } from '../../waveformCodec'
import type { UnifiedDisplayWaveformDetailData } from '../../../shared/unifiedDisplayWaveform'
import type { BeatGridStatus } from '../../../types/globals'
import type { SongStructureAnalysis } from '../../../shared/songStructure'
import type { SongBeatGridMapV2 } from '../../../shared/songBeatGridMapV2'
import type { AnalysisBpmRange } from '../../../shared/analysisBpmRange'

export type KeyAnalysisPriority = 'high' | 'medium' | 'low' | 'background'
export type KeyAnalysisSource = 'foreground' | 'background'
export type KeyAnalysisQueueCategory = 'visible' | 'waveform-preview' | 'manual-batch'
export type KeyAnalysisTargets = {
  key?: boolean
  bpm?: boolean
  waveform?: boolean
  energy?: boolean
  structure?: boolean
}

export type KeyAnalysisRequestFlags = {
  forceAnalysis?: boolean
  analysisTargets?: KeyAnalysisTargets
}
type KeyAnalysisProgressStage =
  | 'job-received'
  | 'decode-start'
  | 'decode-done'
  | 'analyze-start'
  | 'analyze-done'
  | 'waveform-start'
  | 'waveform-done'
  | 'job-done'
  | 'job-error'

export type KeyAnalysisProgress = {
  stage: KeyAnalysisProgressStage
  elapsedMs: number
  decodeMs?: number
  analyzeMs?: number
  waveformMs?: number
  decodeBackend?: string
  sampleRate?: number
  channels?: number
  totalFrames?: number
  framesToProcess?: number
  needsKey?: boolean
  needsBpm?: boolean
  needsWaveform?: boolean
  needsEnergy?: boolean
  needsStructure?: boolean
  detail?: string
  partialResult?: KeyAnalysisWorkerPartialResult
}

type KeyAnalysisJobTrace = {
  lastStage?: KeyAnalysisProgressStage
  lastUpdateAt?: number
  elapsedMs?: number
  decodeMs?: number
  analyzeMs?: number
  waveformMs?: number
  decodeBackend?: string
  sampleRate?: number
  channels?: number
  totalFrames?: number
  framesToProcess?: number
  detail?: string
  timedOutAt?: number
  partialKeyPersisted?: boolean
  partialBpmPersisted?: boolean
}

type KeyAnalysisPrepareDetails = {
  listRootResolved: boolean
  externalCacheResolved?: boolean
  doneEntryHit: boolean
  songCacheHit: boolean
  waveformCacheHit: boolean
  energyCacheHit: boolean
  needsKey: boolean
  needsBpm: boolean
  needsWaveform: boolean
  needsEnergy: boolean
  needsStructure: boolean
}

export type KeyAnalysisAudioProbe = {
  durationSec?: number
  bitRate?: number
  sampleRate?: number
  channels?: number
  codec?: string
  error?: string
}

export type KeyAnalysisJob = {
  jobId: number
  filePath: string
  normalizedPath: string
  priority: KeyAnalysisPriority
  fastAnalysis: boolean
  source: KeyAnalysisSource
  preemptible?: boolean
  category?: KeyAnalysisQueueCategory
  waveformOnly?: boolean
  includeStructure?: boolean
  analysisBpmRange?: AnalysisBpmRange
  forceAnalysis?: boolean
  analysisTargets?: KeyAnalysisTargets
  focusSlots?: string[]
  manualBatchIds?: string[]
  needsKey?: boolean
  needsBpm?: boolean
  needsWaveform?: boolean
  needsEnergy?: boolean
  needsStructure?: boolean
  cachedBpm?: number
  cachedBeatGridMap?: SongBeatGridMapV2
  cachedUnifiedDisplayWaveformData?: UnifiedDisplayWaveformDetailData
  startTime?: number
  trace?: KeyAnalysisJobTrace
  fileSize?: number
  fileMtimeMs?: number
  probe?: KeyAnalysisAudioProbe
  enqueuedAt?: number
  prepareReason?: string
  prepareDetails?: KeyAnalysisPrepareDetails
}

export type KeyAnalysisFailureReason = 'timeout' | 'worker-exit' | 'worker-error' | 'analysis-error'

export type KeyAnalysisPreemptionKind =
  | 'background-resume'
  | 'focus-superseded'
  | 'lower-priority-resume'
  | 'visible-superseded'

export type KeyAnalysisFailureRecord = {
  size: number
  mtimeMs: number
  failCount: number
  firstFailedAt: number
  lastFailedAt: number
  nextRetryAt: number
  lastReason: KeyAnalysisFailureReason
  lastStage?: KeyAnalysisProgressStage
  lastDetail?: string
  inferredCause?: string
  lastProbe?: KeyAnalysisAudioProbe
}

export type KeyAnalysisResult = {
  filePath: string
  keyText: string
}

export const isNoBpmBeatGridResultError = (value: unknown) =>
  typeof value === 'string' && /no valid beat-this result/i.test(value)

export type BpmAnalysisResult = {
  filePath: string
  bpm?: number
  firstBeatMs?: number
  downbeatBeatOffset?: number
  timeBasisOffsetMs?: number
  beatGridAlgorithmVersion?: number | null
  beatGridStatus?: BeatGridStatus
  beatGridMap?: SongBeatGridMapV2
}

export type DoneEntry = {
  size: number
  mtimeMs: number
  keyText?: string
  keyAnalysisAlgorithmVersion?: number
  beatGridAlgorithmVersion?: number
  beatGridStatus?: BeatGridStatus
  beatGridMap?: SongBeatGridMapV2
  energyScore?: number
  energyAlgorithmVersion?: number
  songStructure?: SongStructureAnalysis
  hasWaveform?: boolean
}

export type WorkerPayload = {
  jobId: number
  filePath: string
  progress?: KeyAnalysisProgress
  result?: KeyAnalysisWorkerResult
  error?: string
}

type KeyAnalysisWorkerPartialResult = {
  keyText?: string
  keyError?: string
  bpm?: number
  firstBeatMs?: number
  downbeatBeatOffset?: number
  timeBasisOffsetMs?: number
  bpmError?: string
  songStructureError?: string
  energyScore?: number
  energyAlgorithmVersion?: number
  songStructure?: SongStructureAnalysis
}

type KeyAnalysisWorkerResult = KeyAnalysisWorkerPartialResult & {
  mixxxWaveformData?: MixxxWaveformData | null
  unifiedDisplayWaveformData?: UnifiedDisplayWaveformDetailData | null
  structureBeatGridMap?: SongBeatGridMapV2
}

export type KeyAnalysisBackgroundStatus = {
  active: boolean
  pending: number
  inFlight: number
  processing: number
  scanInProgress: boolean
  enabled: boolean
}

export type BackgroundDirItem = {
  dir: string
  listRoot: string
}

export type DirHandle = Awaited<ReturnType<typeof fs.opendir>>

export const normalizePath = (value: string): string => {
  let normalized = path.normalize(value || '')
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }
  return normalized
}

export const isValidKeyText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

export const isValidBpm = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

export const isValidFirstBeatMs = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export const BACKGROUND_IDLE_DELAY_MS = 3000
export const BACKGROUND_SCAN_COOLDOWN_MS = 5000
export const BACKGROUND_SCAN_ROW_LIMIT = 200
export const BACKGROUND_BATCH_SIZE = 3
export const BACKGROUND_MAX_INFLIGHT = 1
export const BACKGROUND_FS_REFRESH_MS = 60000
export const BACKGROUND_FS_DIR_LIMIT = 3
export const BACKGROUND_FS_ENTRY_LIMIT = 200
export const BACKGROUND_CLEAN_ROW_LIMIT = 200
export const BACKGROUND_CLEAN_BATCH_SIZE = 20
export const BACKGROUND_LIBRARY_TREE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000
export const BACKGROUND_COVER_CLEANUP_INTERVAL_MS = 10 * 60 * 1000
export const BACKGROUND_COVER_CLEANUP_BATCH_SIZE = 3
export const KEY_ANALYSIS_JOB_TIMEOUT_MS = 3 * 60 * 1000
export const KEY_ANALYSIS_DECODE_STAGE_TIMEOUT_MS = 4 * 60 * 1000
export const KEY_ANALYSIS_ANALYZE_STAGE_TIMEOUT_MS = 60 * 1000
export const KEY_ANALYSIS_WAVEFORM_STAGE_TIMEOUT_MS = 90 * 1000
export const KEY_ANALYSIS_STAGE_TIMEOUT_MAX_MS = 30 * 60 * 1000
export const KEY_ANALYSIS_TIMEOUT_PROBE_MIN_FILE_SIZE_BYTES = 10 * 1024 * 1024
export const KEY_ANALYSIS_TIMEOUT_PROBE_TIMEOUT_MS = 8000
export const KEY_ANALYSIS_TIMEOUT_PROBE_TTL_MS = 24 * 60 * 60 * 1000
export const KEY_ANALYSIS_FAILURE_SKIP_THRESHOLD = 2
export const KEY_ANALYSIS_FAILURE_BASE_COOLDOWN_MS = 10 * 60 * 1000
export const KEY_ANALYSIS_FAILURE_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000
export const KEY_ANALYSIS_FAILURE_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const KEY_ANALYSIS_WORKER_MAX = 2
