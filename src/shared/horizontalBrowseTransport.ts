export const HORIZONTAL_BROWSE_TRANSPORT_SNAPSHOT_EVENT =
  'horizontal-browse-transport:snapshot-updated'

export type HorizontalBrowseDeckKey = 'top' | 'bottom'
type HorizontalBrowseAudioBandKey = 'high' | 'mid' | 'low'
export type HorizontalBrowseTransportBandState = Record<HorizontalBrowseAudioBandKey, boolean>

export type HorizontalBrowseTransportBeatGridClipInput = {
  startSec: number
  anchorSec: number
  bpm: number
  downbeatBeatOffset: number
}

export type HorizontalBrowseTransportRekordboxBeatGridEntryInput = {
  timeMs: number
  bpm: number
  beatNumber: number
}

export type HorizontalBrowseTransportDeckInput = {
  filePath?: string
  title?: string
  bpm?: number
  firstBeatMs?: number
  downbeatBeatOffset?: number
  beatGridClips?: HorizontalBrowseTransportBeatGridClipInput[]
  rekordboxBeatGridEntries?: HorizontalBrowseTransportRekordboxBeatGridEntryInput[]
  timeBasisOffsetMs?: number
  durationSec: number
  currentSec: number
  lastObservedAtMs: number
  playing: boolean
  playbackRate: number
  masterTempoEnabled: boolean
}

export type HorizontalBrowseTransportBeatGridInput = {
  filePath?: string
  bpm?: number
  firstBeatMs?: number
  downbeatBeatOffset?: number
  beatGridClips?: HorizontalBrowseTransportBeatGridClipInput[]
  rekordboxBeatGridEntries?: HorizontalBrowseTransportRekordboxBeatGridEntryInput[]
  timeBasisOffsetMs?: number
}

export type HorizontalBrowseTransportStateInput = {
  nowMs?: number
  allowPhaseAlignment?: boolean
  top: HorizontalBrowseTransportDeckInput
  bottom: HorizontalBrowseTransportDeckInput
}

export type HorizontalBrowseTransportDeckSnapshot = {
  deck: string
  label: string
  loaded: boolean
  fullyDecoded: boolean
  decoding: boolean
  fullDecoding: boolean
  playRequested: boolean
  playingAudible: boolean
  playheadLoaded: boolean
  playing: boolean
  currentSec: number
  audioCurrentSec: number
  loadedSegmentStartSec: number
  loadedSegmentEndSec: number
  durationSec: number
  effectiveDurationSec: number
  playbackRate: number
  masterTempoEnabled: boolean
  bpm: number
  effectiveBpm: number
  renderCurrentSec: number
  syncEnabled: boolean
  syncLock: string
  leader: boolean
  loopActive: boolean
  loopBeatValue: number
  loopStartBeatIndex?: number
  loopStartSec: number
  loopEndSec: number
  bands: HorizontalBrowseTransportBandState
  cueMonitorEnabled: boolean
  autoGainEnabled: boolean
  autoGainStatus: 'off' | 'active' | 'master' | 'pending' | 'unavailable'
  autoGainValue: number
}

type HorizontalBrowseTransportOutputSnapshot = {
  crossfaderValue: number
  masterGain: number
  topDeckGain: number
  bottomDeckGain: number
  limiterOverload: boolean
  limiterGainReductionDb: number
  sampleRate: number
  channels: number
}

export type HorizontalBrowseTransportSnapshot = {
  capturedAtEpochMs?: number
  snapshotSequence?: number
  stateRevision?: number
  auditionSuspended: boolean
  leaderDeck?: string
  top: HorizontalBrowseTransportDeckSnapshot
  bottom: HorizontalBrowseTransportDeckSnapshot
  output: HorizontalBrowseTransportOutputSnapshot
}

export type HorizontalBrowseTransportVisualizerSnapshot = {
  timeDomainData: number[]
  limiterOverload: boolean
  limiterGainReductionDb: number
  preLimiterPeakLeftDb: number
  preLimiterPeakRightDb: number
}

type HorizontalBrowseRecordingState = 'idle' | 'armed' | 'recording' | 'error'

export type HorizontalBrowseTransportRecordingStatus = {
  state: HorizontalBrowseRecordingState
  filePath?: string
  sampleRate: number
  channels: number
  recordedFrames: number
  recorded: boolean
  error?: string
}

const createEmptyHorizontalBrowseTransportDeckSnapshot = (
  deck: HorizontalBrowseDeckKey
): HorizontalBrowseTransportDeckSnapshot => ({
  deck,
  label: '',
  playing: false,
  playRequested: false,
  playingAudible: false,
  playheadLoaded: false,
  currentSec: 0,
  audioCurrentSec: 0,
  loadedSegmentStartSec: 0,
  loadedSegmentEndSec: 0,
  durationSec: 0,
  effectiveDurationSec: 0,
  loaded: false,
  fullyDecoded: false,
  decoding: false,
  fullDecoding: false,
  playbackRate: 1,
  masterTempoEnabled: true,
  bpm: 0,
  effectiveBpm: 0,
  renderCurrentSec: 0,
  syncEnabled: false,
  syncLock: 'off',
  leader: false,
  loopActive: false,
  loopBeatValue: 8,
  loopStartBeatIndex: undefined,
  loopStartSec: 0,
  loopEndSec: 0,
  bands: {
    high: true,
    mid: true,
    low: true
  },
  cueMonitorEnabled: false,
  autoGainEnabled: true,
  autoGainStatus: 'pending',
  autoGainValue: 1
})

export const createEmptyHorizontalBrowseTransportSnapshot =
  (): HorizontalBrowseTransportSnapshot => ({
    capturedAtEpochMs: undefined,
    snapshotSequence: 0,
    stateRevision: 0,
    auditionSuspended: false,
    leaderDeck: undefined,
    top: createEmptyHorizontalBrowseTransportDeckSnapshot('top'),
    bottom: createEmptyHorizontalBrowseTransportDeckSnapshot('bottom'),
    output: {
      crossfaderValue: 0,
      masterGain: 1,
      topDeckGain: 1,
      bottomDeckGain: 1,
      limiterOverload: false,
      limiterGainReductionDb: 0,
      sampleRate: 44100,
      channels: 2
    }
  })
