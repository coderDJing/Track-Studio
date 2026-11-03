export type MixtapeArrangementSnapshot = {
  entries: Array<{ itemId: string; startSec: number }>
  bpmEnvelope: Array<{ sec: number; bpm: number }>
  bpmEnvelopeDurationSec: number
  gridPhaseOffsetSec: number
}

export type MixtapeArrangementRequest = MixtapeArrangementSnapshot & {
  playlistId: string
}

export type MixtapeArrangementResult = {
  updated: number
  snapshot: MixtapeArrangementSnapshot
}
