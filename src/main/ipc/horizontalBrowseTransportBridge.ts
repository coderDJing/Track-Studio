import type {
  HorizontalBrowseTransportBeatGridInput,
  HorizontalBrowseTransportBandState,
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckInput,
  HorizontalBrowseTransportRecordingStatus,
  HorizontalBrowseTransportSnapshot,
  HorizontalBrowseTransportStateInput,
  HorizontalBrowseTransportVisualizerSnapshot
} from '@shared/horizontalBrowseTransport'
import { log } from '../log'

type HorizontalBrowseTransportDecodeDiagnostic = {
  operation: string
  status: string
  deck: string
  filePath: string
  requestId: number
  fullDecode: boolean
  startSec: number
  maxDurationSec?: number
  decoderBackend?: string
  queueWaitMs?: number
  totalMs: number
  ffmpegTotalMs?: number
  ffmpegSpawnMs?: number
  ffmpegFirstByteMs?: number
  ffmpegReadMs?: number
  ffmpegConvertMs?: number
  ffmpegWaitMs?: number
  ffmpegStderrJoinMs?: number
  ffmpegStdoutBytes?: number
  ffmpegReadIterations?: number
  prepareMs?: number
  applyMs?: number
  loudnessMs?: number
  sampleCount: number
  frameCount: number
  sampleRate: number
  channels: number
}

type RustHorizontalBrowseTransportBinding = {
  horizontalBrowseTransportReset?: () => void
  horizontalBrowseTransportSetDeckState?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number | undefined,
    payload: HorizontalBrowseTransportDeckInput
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetState?: (
    payload: HorizontalBrowseTransportStateInput
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetPlaybackRate?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number,
    playbackRate: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetTempoNudgePlaybackRate?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number,
    playbackRate: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetMasterTempoEnabled?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number,
    enabled: boolean
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetBeatGrid?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number | undefined,
    payload: HorizontalBrowseTransportBeatGridInput
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetSyncEnabled?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number | undefined,
    enabled: boolean
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportBeatsync?: (
    deck: HorizontalBrowseDeckKey,
    nowMs?: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportAlignToLeader?: (
    deck: HorizontalBrowseDeckKey,
    nowMs?: number,
    targetSec?: number,
    skipGridSnap?: boolean
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetLeader?: (
    deck?: HorizontalBrowseDeckKey,
    nowMs?: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetBandState?: (
    deck: HorizontalBrowseDeckKey,
    bands: HorizontalBrowseTransportBandState
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetCueMonitorEnabled?: (
    deck: HorizontalBrowseDeckKey,
    enabled: boolean
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetPlaying?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number,
    playing: boolean
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetAuditionSuspended?: (
    nowMs: number,
    suspended: boolean
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportPreparePlayhead?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSeek?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number,
    currentSec: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetScrubPreview?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number,
    active: boolean,
    currentSec: number,
    rate: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetMetronome?: (
    deck: HorizontalBrowseDeckKey,
    enabled: boolean,
    volumeLevel: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportToggleLoop?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportStepLoopBeats?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number,
    direction: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetLoopFromRange?: (
    deck: HorizontalBrowseDeckKey,
    startSec: number,
    endSec: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportClearLoop?: (
    deck: HorizontalBrowseDeckKey
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetGain?: (
    deck: HorizontalBrowseDeckKey,
    gain: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetAutoGainEnabled?: (
    deck: HorizontalBrowseDeckKey,
    enabled: boolean
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetOutputState?: (
    crossfaderValue: number,
    masterGain: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSnapshot?: (nowMs?: number) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportVisualizerSnapshot?: () => HorizontalBrowseTransportVisualizerSnapshot
  horizontalBrowseTransportDrainDecodeDiagnostics?: () => HorizontalBrowseTransportDecodeDiagnostic[]
  horizontalBrowseTransportStartRecording?: (
    filePath: string
  ) => HorizontalBrowseTransportRecordingStatus
  horizontalBrowseTransportStopRecording?: () => HorizontalBrowseTransportRecordingStatus
  horizontalBrowseTransportRecordingSnapshot?: () => HorizontalBrowseTransportRecordingStatus
}

let cachedBinding: RustHorizontalBrowseTransportBinding | null = null

const resolveBinding = (): RustHorizontalBrowseTransportBinding => {
  if (cachedBinding) return cachedBinding
  try {
    cachedBinding = require('rust_package') as RustHorizontalBrowseTransportBinding
    return cachedBinding
  } catch (error) {
    log.error('[horizontal-browse-transport] load rust_package failed', error)
    return {}
  }
}

const requireFn = <T extends keyof RustHorizontalBrowseTransportBinding>(
  key: T
): NonNullable<RustHorizontalBrowseTransportBinding[T]> => {
  const fn = resolveBinding()[key]
  if (typeof fn !== 'function') {
    throw new Error(`rust_package.${String(key)} unavailable`)
  }
  return fn as NonNullable<RustHorizontalBrowseTransportBinding[T]>
}

export const horizontalBrowseTransportBridge = {
  reset() {
    return requireFn('horizontalBrowseTransportReset')()
  },
  setDeckState(
    deck: HorizontalBrowseDeckKey,
    nowMs: number | undefined,
    payload: HorizontalBrowseTransportDeckInput
  ) {
    return requireFn('horizontalBrowseTransportSetDeckState')(deck, nowMs, payload)
  },
  setState(payload: HorizontalBrowseTransportStateInput) {
    return requireFn('horizontalBrowseTransportSetState')(payload)
  },
  setPlaybackRate(deck: HorizontalBrowseDeckKey, nowMs: number, playbackRate: number) {
    return requireFn('horizontalBrowseTransportSetPlaybackRate')(deck, nowMs, playbackRate)
  },
  setTempoNudgePlaybackRate(deck: HorizontalBrowseDeckKey, nowMs: number, playbackRate: number) {
    return requireFn('horizontalBrowseTransportSetTempoNudgePlaybackRate')(
      deck,
      nowMs,
      playbackRate
    )
  },
  setMasterTempoEnabled(deck: HorizontalBrowseDeckKey, nowMs: number, enabled: boolean) {
    return requireFn('horizontalBrowseTransportSetMasterTempoEnabled')(deck, nowMs, enabled)
  },
  setBeatGrid(
    deck: HorizontalBrowseDeckKey,
    nowMs: number | undefined,
    payload: HorizontalBrowseTransportBeatGridInput
  ) {
    return requireFn('horizontalBrowseTransportSetBeatGrid')(deck, nowMs, payload)
  },
  setSyncEnabled(deck: HorizontalBrowseDeckKey, nowMs: number | undefined, enabled: boolean) {
    return requireFn('horizontalBrowseTransportSetSyncEnabled')(deck, nowMs, enabled)
  },
  beatsync(deck: HorizontalBrowseDeckKey, nowMs?: number) {
    return requireFn('horizontalBrowseTransportBeatsync')(deck, nowMs)
  },
  alignToLeader(
    deck: HorizontalBrowseDeckKey,
    nowMs?: number,
    targetSec?: number,
    skipGridSnap?: boolean
  ) {
    return requireFn('horizontalBrowseTransportAlignToLeader')(deck, nowMs, targetSec, skipGridSnap)
  },
  setLeader(deck?: HorizontalBrowseDeckKey, nowMs?: number) {
    return requireFn('horizontalBrowseTransportSetLeader')(deck, nowMs)
  },
  setBandState(deck: HorizontalBrowseDeckKey, bands: HorizontalBrowseTransportBandState) {
    return requireFn('horizontalBrowseTransportSetBandState')(deck, bands)
  },
  setCueMonitorEnabled(deck: HorizontalBrowseDeckKey, enabled: boolean) {
    return requireFn('horizontalBrowseTransportSetCueMonitorEnabled')(deck, enabled)
  },
  setPlaying(deck: HorizontalBrowseDeckKey, nowMs: number, playing: boolean) {
    return requireFn('horizontalBrowseTransportSetPlaying')(deck, nowMs, playing)
  },
  setAuditionSuspended(nowMs: number, suspended: boolean) {
    return requireFn('horizontalBrowseTransportSetAuditionSuspended')(nowMs, suspended)
  },
  preparePlayhead(deck: HorizontalBrowseDeckKey, nowMs: number) {
    return requireFn('horizontalBrowseTransportPreparePlayhead')(deck, nowMs)
  },
  seek(deck: HorizontalBrowseDeckKey, nowMs: number, currentSec: number) {
    return requireFn('horizontalBrowseTransportSeek')(deck, nowMs, currentSec)
  },
  setScrubPreview(
    deck: HorizontalBrowseDeckKey,
    nowMs: number,
    active: boolean,
    currentSec: number,
    rate: number
  ) {
    return requireFn('horizontalBrowseTransportSetScrubPreview')(
      deck,
      nowMs,
      active,
      currentSec,
      rate
    )
  },
  setMetronome(deck: HorizontalBrowseDeckKey, enabled: boolean, volumeLevel: number) {
    return requireFn('horizontalBrowseTransportSetMetronome')(deck, enabled, volumeLevel)
  },
  toggleLoop(deck: HorizontalBrowseDeckKey, nowMs: number) {
    return requireFn('horizontalBrowseTransportToggleLoop')(deck, nowMs)
  },
  stepLoopBeats(deck: HorizontalBrowseDeckKey, nowMs: number, direction: number) {
    return requireFn('horizontalBrowseTransportStepLoopBeats')(deck, nowMs, direction)
  },
  setLoopFromRange(deck: HorizontalBrowseDeckKey, startSec: number, endSec: number) {
    return requireFn('horizontalBrowseTransportSetLoopFromRange')(deck, startSec, endSec)
  },
  clearLoop(deck: HorizontalBrowseDeckKey) {
    return requireFn('horizontalBrowseTransportClearLoop')(deck)
  },
  setGain(deck: HorizontalBrowseDeckKey, gain: number) {
    return requireFn('horizontalBrowseTransportSetGain')(deck, gain)
  },
  setAutoGainEnabled(deck: HorizontalBrowseDeckKey, enabled: boolean) {
    return requireFn('horizontalBrowseTransportSetAutoGainEnabled')(deck, enabled)
  },
  setOutputState(crossfaderValue: number, masterGain: number) {
    return requireFn('horizontalBrowseTransportSetOutputState')(crossfaderValue, masterGain)
  },
  snapshot(nowMs?: number) {
    return requireFn('horizontalBrowseTransportSnapshot')(nowMs)
  },
  visualizerSnapshot() {
    return requireFn('horizontalBrowseTransportVisualizerSnapshot')()
  },
  drainDecodeDiagnostics() {
    const fn = resolveBinding().horizontalBrowseTransportDrainDecodeDiagnostics
    if (typeof fn !== 'function') return []
    const diagnostics = fn()
    return Array.isArray(diagnostics) ? diagnostics : []
  },
  startRecording(filePath: string) {
    return requireFn('horizontalBrowseTransportStartRecording')(filePath)
  },
  stopRecording() {
    return requireFn('horizontalBrowseTransportStopRecording')()
  },
  recordingSnapshot() {
    return requireFn('horizontalBrowseTransportRecordingSnapshot')()
  }
}

export const isHorizontalBrowseTransportRecordingActive = (): boolean => {
  try {
    const status = horizontalBrowseTransportBridge.recordingSnapshot()
    return status.state === 'armed' || status.state === 'recording'
  } catch {
    return false
  }
}
