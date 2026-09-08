import { ipcMain } from 'electron'
import { performance } from 'node:perf_hooks'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportBandState,
  HorizontalBrowseTransportDeckInput,
  HorizontalBrowseTransportDeckSnapshot,
  HorizontalBrowseTransportSnapshot,
  HorizontalBrowseTransportStateInput
} from '@shared/horizontalBrowseTransport'
import { RECORDING_LIBRARY_CHANGED_EVENT } from '@shared/recordingLibrary'
import { horizontalBrowseTransportBridge } from './horizontalBrowseTransportBridge'
import {
  broadcastHorizontalBrowseTransportSnapshot,
  startHorizontalBrowseTransportSnapshotBroadcaster
} from './horizontalBrowseTransportSnapshotBroadcaster'
import mainWindow from '../window/mainWindow'
import { createRecordingOutputPath } from '../recordingLibraryService'
import { log } from '../log'
import { isPackagedRcBuild } from '../services/rcDiagnostics'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import { notifyPlaybackStateChange, notifyTransportActivity } from '../services/keyAnalysisQueue'
import { assertLibraryMergeMutationAllowed } from '../services/libraryMerge/runtime'
import {
  clearHorizontalBrowseLoadedPaths,
  rememberHorizontalBrowseLoadedPath
} from '../curatedLibrarySync/busyPaths'

const SLOW_TRANSPORT_OPERATION_LOG_THRESHOLD_MS = 500

const normalizeDiagnosticNumber = (value: unknown, fractionDigits = 3) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Number(numeric.toFixed(fractionDigits))
}

const resolveSnapshotDeck = (
  snapshot: HorizontalBrowseTransportSnapshot | null | undefined,
  deck: HorizontalBrowseDeckKey
): HorizontalBrowseTransportDeckSnapshot | null => {
  if (!snapshot) return null
  return deck === 'top' ? snapshot.top : snapshot.bottom
}

const buildDeckDiagnosticSnapshot = (
  snapshot: HorizontalBrowseTransportSnapshot | null | undefined,
  deck: HorizontalBrowseDeckKey
) => {
  const deckSnapshot = resolveSnapshotDeck(snapshot, deck)
  if (!deckSnapshot) return null
  return {
    deck,
    label: deckSnapshot.label,
    loaded: deckSnapshot.loaded,
    fullyDecoded: deckSnapshot.fullyDecoded,
    decoding: deckSnapshot.decoding,
    fullDecoding: deckSnapshot.fullDecoding,
    playRequested: deckSnapshot.playRequested,
    playingAudible: deckSnapshot.playingAudible,
    playheadLoaded: deckSnapshot.playheadLoaded,
    playing: deckSnapshot.playing,
    currentSec: normalizeDiagnosticNumber(deckSnapshot.currentSec),
    renderCurrentSec: normalizeDiagnosticNumber(deckSnapshot.renderCurrentSec),
    audioCurrentSec: normalizeDiagnosticNumber(deckSnapshot.audioCurrentSec),
    loadedSegmentStartSec: normalizeDiagnosticNumber(deckSnapshot.loadedSegmentStartSec),
    loadedSegmentEndSec: normalizeDiagnosticNumber(deckSnapshot.loadedSegmentEndSec),
    durationSec: normalizeDiagnosticNumber(deckSnapshot.durationSec),
    effectiveDurationSec: normalizeDiagnosticNumber(deckSnapshot.effectiveDurationSec),
    playbackRate: normalizeDiagnosticNumber(deckSnapshot.playbackRate, 5),
    syncEnabled: deckSnapshot.syncEnabled,
    syncLock: deckSnapshot.syncLock
  }
}

const buildDeckInputDiagnosticSnapshot = (payload: HorizontalBrowseTransportDeckInput) => ({
  filePath: String(payload.filePath || '').trim(),
  title: String(payload.title || '').trim(),
  durationSec: normalizeDiagnosticNumber(payload.durationSec),
  currentSec: normalizeDiagnosticNumber(payload.currentSec),
  lastObservedAtMs: normalizeDiagnosticNumber(payload.lastObservedAtMs),
  playing: Boolean(payload.playing),
  playbackRate: normalizeDiagnosticNumber(payload.playbackRate, 5),
  bpm: normalizeDiagnosticNumber(payload.bpm),
  timeBasisOffsetMs: normalizeDiagnosticNumber(payload.timeBasisOffsetMs)
})

const logSlowTransportOperation = (
  operation: string,
  elapsedMs: number,
  payload: Record<string, unknown>
) => {
  if (elapsedMs < SLOW_TRANSPORT_OPERATION_LOG_THRESHOLD_MS || !isPackagedRcBuild()) return
  log.warn(
    `[HB-TRANSPORT-SLOW] ${operation} ${JSON.stringify({
      operation,
      elapsedMs: normalizeDiagnosticNumber(elapsedMs, 1),
      thresholdMs: SLOW_TRANSPORT_OPERATION_LOG_THRESHOLD_MS,
      ...payload
    })}`
  )
}

const flushTransportDecodeDiagnostics = () => {
  const diagnostics = horizontalBrowseTransportBridge.drainDecodeDiagnostics()
  if (!isPackagedRcBuild()) return
  for (const diagnostic of diagnostics) {
    const message = `[HB-TRANSPORT-DECODE-SLOW] ${diagnostic.operation} ${JSON.stringify(diagnostic)}`
    log.warn(message)
  }
}

const logSlowPreparePlayhead = (
  deck: HorizontalBrowseDeckKey,
  elapsedMs: number,
  beforeSnapshot: HorizontalBrowseTransportSnapshot,
  afterSnapshot: HorizontalBrowseTransportSnapshot
) => {
  if (elapsedMs < SLOW_TRANSPORT_OPERATION_LOG_THRESHOLD_MS || !isPackagedRcBuild()) return
  log.warn(
    `[HB-TRANSPORT-DECODE] prepare-playhead-slow ${JSON.stringify({
      deck,
      elapsedMs: normalizeDiagnosticNumber(elapsedMs, 1),
      thresholdMs: SLOW_TRANSPORT_OPERATION_LOG_THRESHOLD_MS,
      before: buildDeckDiagnosticSnapshot(beforeSnapshot, deck),
      after: buildDeckDiagnosticSnapshot(afterSnapshot, deck)
    })}`
  )
}

export function registerHorizontalBrowseTransportHandlers() {
  startHorizontalBrowseTransportSnapshotBroadcaster(() => {
    const snapshot = horizontalBrowseTransportBridge.snapshot()
    flushTransportDecodeDiagnostics()
    return snapshot
  })

  ipcMain.handle('horizontal-browse-transport:reset', async () => {
    await horizontalBrowseTransportBridge.reset()
    clearHorizontalBrowseLoadedPaths()
    const snapshot = horizontalBrowseTransportBridge.snapshot()
    notifyPlaybackStateChange(false)
    broadcastHorizontalBrowseTransportSnapshot(snapshot)
    return snapshot
  })

  ipcMain.handle(
    'horizontal-browse-transport:set-deck-state',
    async (
      _event,
      deck: HorizontalBrowseDeckKey,
      nowMs: number | undefined,
      payload: HorizontalBrowseTransportDeckInput
    ) => {
      const before = horizontalBrowseTransportBridge.snapshot()
      const startedAt = performance.now()
      const snapshot = horizontalBrowseTransportBridge.setDeckState(deck, nowMs, payload)
      rememberHorizontalBrowseLoadedPath(deck, payload.filePath)
      const elapsedMs = performance.now() - startedAt
      logSlowTransportOperation('set-deck-state', elapsedMs, {
        deck,
        input: buildDeckInputDiagnosticSnapshot(payload),
        before: buildDeckDiagnosticSnapshot(before, deck),
        after: buildDeckDiagnosticSnapshot(snapshot, deck)
      })
      flushTransportDecodeDiagnostics()
      notifyTransportActivity()
      notifyPlaybackStateChange(
        [snapshot.top, snapshot.bottom].some((d) => d.playingAudible || d.playing)
      )
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-state',
    async (_event, payload: HorizontalBrowseTransportStateInput) => {
      const before = horizontalBrowseTransportBridge.snapshot()
      const startedAt = performance.now()
      const snapshot = horizontalBrowseTransportBridge.setState(payload)
      rememberHorizontalBrowseLoadedPath('top', payload.top?.filePath)
      rememberHorizontalBrowseLoadedPath('bottom', payload.bottom?.filePath)
      const elapsedMs = performance.now() - startedAt
      logSlowTransportOperation('set-state', elapsedMs, {
        input: {
          top: buildDeckInputDiagnosticSnapshot(payload.top),
          bottom: buildDeckInputDiagnosticSnapshot(payload.bottom)
        },
        before: {
          top: buildDeckDiagnosticSnapshot(before, 'top'),
          bottom: buildDeckDiagnosticSnapshot(before, 'bottom')
        },
        after: {
          top: buildDeckDiagnosticSnapshot(snapshot, 'top'),
          bottom: buildDeckDiagnosticSnapshot(snapshot, 'bottom')
        }
      })
      flushTransportDecodeDiagnostics()
      notifyTransportActivity()
      notifyPlaybackStateChange(
        [snapshot.top, snapshot.bottom].some((d) => d.playingAudible || d.playing)
      )
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-playback-rate',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number, playbackRate: number) => {
      const snapshot = horizontalBrowseTransportBridge.setPlaybackRate(deck, nowMs, playbackRate)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.on(
    'horizontal-browse-transport:set-playback-rate-live',
    (_event, deck: HorizontalBrowseDeckKey, nowMs: number, playbackRate: number) => {
      horizontalBrowseTransportBridge.setPlaybackRate(deck, nowMs, playbackRate)
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-tempo-nudge-playback-rate',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number, playbackRate: number) => {
      const snapshot = horizontalBrowseTransportBridge.setTempoNudgePlaybackRate(
        deck,
        nowMs,
        playbackRate
      )
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-master-tempo-enabled',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number, enabled: boolean) => {
      const snapshot = horizontalBrowseTransportBridge.setMasterTempoEnabled(deck, nowMs, enabled)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-beat-grid',
    async (
      _event,
      deck: HorizontalBrowseDeckKey,
      nowMs: number | undefined,
      payload: {
        filePath?: string
        bpm?: number
        firstBeatMs?: number
        downbeatBeatOffset?: number
        timeBasisOffsetMs?: number
      }
    ) => {
      const snapshot = horizontalBrowseTransportBridge.setBeatGrid(deck, nowMs, payload)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-sync-enabled',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number | undefined, enabled: boolean) => {
      const snapshot = horizontalBrowseTransportBridge.setSyncEnabled(deck, nowMs, enabled)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:beatsync',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs?: number) => {
      const snapshot = horizontalBrowseTransportBridge.beatsync(deck, nowMs)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:align-to-leader',
    async (
      _event,
      deck: HorizontalBrowseDeckKey,
      nowMs?: number,
      targetSec?: number,
      skipGridSnap?: boolean
    ) => {
      const snapshot = horizontalBrowseTransportBridge.alignToLeader(
        deck,
        nowMs,
        targetSec,
        skipGridSnap
      )
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-leader',
    async (_event, deck?: HorizontalBrowseDeckKey | null, nowMs?: number) => {
      const snapshot = horizontalBrowseTransportBridge.setLeader(deck || undefined, nowMs)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-band-state',
    async (_event, deck: HorizontalBrowseDeckKey, bands: HorizontalBrowseTransportBandState) => {
      const snapshot = horizontalBrowseTransportBridge.setBandState(deck, bands)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-cue-monitor-enabled',
    async (_event, deck: HorizontalBrowseDeckKey, enabled: boolean) => {
      const snapshot = horizontalBrowseTransportBridge.setCueMonitorEnabled(deck, enabled)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-playing',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number, playing: boolean) => {
      const snapshot = horizontalBrowseTransportBridge.setPlaying(deck, nowMs, playing)
      notifyPlaybackStateChange(
        [snapshot.top, snapshot.bottom].some((d) => d.playingAudible || d.playing)
      )
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:prepare-playhead',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number) => {
      const before = horizontalBrowseTransportBridge.snapshot(nowMs)
      const beforeDeck = resolveSnapshotDeck(before, deck)
      const startedAt = performance.now()
      const snapshot = horizontalBrowseTransportBridge.preparePlayhead(deck, nowMs)
      const elapsedMs = performance.now() - startedAt
      const afterDeck = resolveSnapshotDeck(snapshot, deck)
      logSlowPreparePlayhead(deck, elapsedMs, before, snapshot)
      logSlowTransportOperation('prepare-playhead', elapsedMs, {
        deck,
        before: buildDeckDiagnosticSnapshot(before, deck),
        after: buildDeckDiagnosticSnapshot(snapshot, deck),
        hadPendingStartupAtStart: Boolean(
          beforeDeck?.decoding && !beforeDeck.loaded && !beforeDeck.playheadLoaded
        ),
        hadLoadedButUncoveredAtStart: Boolean(beforeDeck?.loaded && !beforeDeck.playheadLoaded),
        becamePlayheadLoaded: Boolean(!beforeDeck?.playheadLoaded && afterDeck?.playheadLoaded),
        loadedSegmentExpanded: Boolean(
          Number(afterDeck?.loadedSegmentEndSec || 0) > Number(beforeDeck?.loadedSegmentEndSec || 0)
        )
      })
      flushTransportDecodeDiagnostics()
      notifyTransportActivity()
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:seek',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number, currentSec: number) => {
      const snapshot = horizontalBrowseTransportBridge.seek(deck, nowMs, currentSec)
      notifyTransportActivity()
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-scrub-preview',
    async (
      _event,
      deck: HorizontalBrowseDeckKey,
      nowMs: number,
      active: boolean,
      currentSec: number,
      rate: number
    ) => {
      const snapshot = horizontalBrowseTransportBridge.setScrubPreview(
        deck,
        nowMs,
        active,
        currentSec,
        rate
      )
      notifyTransportActivity()
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-metronome',
    async (_event, deck: HorizontalBrowseDeckKey, enabled: boolean, volumeLevel: number) => {
      const snapshot = horizontalBrowseTransportBridge.setMetronome(deck, enabled, volumeLevel)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:toggle-loop',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number) => {
      const snapshot = horizontalBrowseTransportBridge.toggleLoop(deck, nowMs)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:step-loop-beats',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number, direction: number) => {
      const snapshot = horizontalBrowseTransportBridge.stepLoopBeats(deck, nowMs, direction)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-loop-from-range',
    async (_event, deck: HorizontalBrowseDeckKey, startSec: number, endSec: number) => {
      const snapshot = horizontalBrowseTransportBridge.setLoopFromRange(deck, startSec, endSec)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:clear-loop',
    async (_event, deck: HorizontalBrowseDeckKey) => {
      const snapshot = horizontalBrowseTransportBridge.clearLoop(deck)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-gain',
    async (_event, deck: HorizontalBrowseDeckKey, gain: number) => {
      const snapshot = horizontalBrowseTransportBridge.setGain(deck, gain)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-auto-gain-enabled',
    async (_event, deck: HorizontalBrowseDeckKey, enabled: boolean) => {
      const snapshot = horizontalBrowseTransportBridge.setAutoGainEnabled(deck, enabled)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-output-state',
    async (_event, crossfaderValue: number, masterGain: number) => {
      const snapshot = horizontalBrowseTransportBridge.setOutputState(crossfaderValue, masterGain)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle('horizontal-browse-transport:snapshot', async (_event, nowMs?: number) =>
    horizontalBrowseTransportBridge.snapshot(nowMs)
  )

  ipcMain.handle('horizontal-browse-transport:visualizer-snapshot', async () =>
    horizontalBrowseTransportBridge.visualizerSnapshot()
  )

  ipcMain.handle('horizontal-browse-transport:recording-start', async () => {
    assertLibraryMergeMutationAllowed()
    const outputPath = await createRecordingOutputPath()
    return horizontalBrowseTransportBridge.startRecording(outputPath)
  })

  ipcMain.handle('horizontal-browse-transport:recording-stop', async () => {
    const status = horizontalBrowseTransportBridge.stopRecording()
    if (status.recorded) {
      markGlobalSongSearchDirty('recording-library')
      mainWindow.instance?.webContents.send(RECORDING_LIBRARY_CHANGED_EVENT, status)
    }
    return status
  })

  ipcMain.handle('horizontal-browse-transport:recording-snapshot', async () =>
    horizontalBrowseTransportBridge.recordingSnapshot()
  )
}
