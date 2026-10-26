export type BpmFixVerification = {
  passed: boolean
  detectedBpm: number
  bpmError: number
  gridRmsMs: number
  offGridBeats: number
}

export type BpmFixSummary = {
  sourceBpm: number
  targetBpm: number
  gridOffsetSec: number
  confidence: number
  durationInSec: number
  durationOutSec: number
  noticeableSegments: number
  peakGain: number
  verification: BpmFixVerification
}

export type BpmFixAnalysis = {
  sourceBpm: number
  referenceBpm: number
  confidence: number
  agreement: number
  regularity: number
  driftMs: number
  coverage: number
  filledBeats: number
  ignoredDetections: number
  tempoAmbiguous: boolean
  durationSec: number
}

export type BpmFixTrackOptions = {
  id: string
  enabled: boolean
  tempoFactor: 0.5 | 1 | 2
  targetBpm: number | null
  allowLowConfidence: boolean
}

export type BpmFixOptions = {
  saveMode: 'copy' | 'overwrite'
  format: 'original' | 'wav'
  tracks: BpmFixTrackOptions[]
}

export type BpmFixTrack = {
  id: string
  filePath: string
  status:
    | 'pending'
    | 'analyzing'
    | 'ready'
    | 'repairing'
    | 'completed'
    | 'failed'
    | 'skipped'
    | 'cancelled'
  analysis?: BpmFixAnalysis
  summary?: BpmFixSummary
  outputPath?: string
  error?: string
}

export type BpmFixSnapshot = {
  id: string
  status: 'pending' | 'analyzing' | 'ready' | 'repairing' | 'completed' | 'cancelled' | 'failed'
  tracks: BpmFixTrack[]
  stage: string
  current: number
  currentPercent: number
  percent: number
  error?: string
}

export type BpmFixStart = { filePaths: string[]; songListUUID: string; songListPath: string }

export type BpmFixRuntime = {
  command: string
  args: string[]
  env: Record<string, string | undefined>
  device: string
}
