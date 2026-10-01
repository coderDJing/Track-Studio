import { reactive } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { startHorizontalBrowseUserTiming } from '@renderer/composables/horizontalBrowse/horizontalBrowseUserTiming'
import {
  createEmptyHorizontalBrowseTransportSnapshot,
  HORIZONTAL_BROWSE_TRANSPORT_SNAPSHOT_EVENT,
  type HorizontalBrowseTransportBeatGridInput,
  type HorizontalBrowseTransportBandState,
  type HorizontalBrowseDeckKey,
  type HorizontalBrowseTransportSnapshot,
  type HorizontalBrowseTransportVisualizerSnapshot
} from '@shared/horizontalBrowseTransport'
import { resolveHorizontalBrowseTransportGrid } from '@shared/horizontalBrowseTransportGrid'
export type {
  HorizontalBrowseTransportBeatGridInput,
  HorizontalBrowseTransportBandState,
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot,
  HorizontalBrowseTransportSnapshot,
  HorizontalBrowseTransportVisualizerSnapshot
} from '@shared/horizontalBrowseTransport'

type LocalDeckState = {
  song: ISongInfo | null
  currentSec: number
  lastObservedAtMs: number
  durationSec: number
  playing: boolean
  playbackRate: number
  masterTempoEnabled: boolean
}

type SnapshotListener = (snapshot: HorizontalBrowseTransportSnapshot) => void
type SnapshotApplyOptions = {
  notifySnapshotListeners?: boolean
}

export const createHorizontalBrowseNativeTransport = () => {
  const state = reactive<HorizontalBrowseTransportSnapshot>(
    createEmptyHorizontalBrowseTransportSnapshot()
  )
  const snapshotListeners = new Set<SnapshotListener>()
  const liveClockPlaybackRate: Record<HorizontalBrowseDeckKey, number | null> = {
    top: null,
    bottom: null
  }
  let snapshotEventBound = false
  let lastAppliedSnapshotSequence = 0

  const resolveLiveClockPlaybackRate = (deck: HorizontalBrowseDeckKey) =>
    liveClockPlaybackRate[deck]

  const setLiveClockPlaybackRate = (deck: HorizontalBrowseDeckKey, playbackRate: number | null) => {
    if (playbackRate == null) {
      liveClockPlaybackRate[deck] = null
      return
    }
    liveClockPlaybackRate[deck] = Number(playbackRate) || 1
  }

  const preserveLiveClockDeckSnapshot = (
    deck: HorizontalBrowseDeckKey,
    incoming: HorizontalBrowseTransportSnapshot['top']
  ) => {
    if (liveClockPlaybackRate[deck] == null) return incoming
    return {
      ...incoming,
      playbackRate: Number(state[deck].playbackRate) || 1,
      effectiveBpm: Number(state[deck].effectiveBpm) || incoming.effectiveBpm
    }
  }

  const invoke = async (channel: string, ...args: unknown[]) =>
    (await window.electron.ipcRenderer.invoke(
      channel,
      ...args
    )) as HorizontalBrowseTransportSnapshot

  const notifySnapshotListeners = (snapshot: HorizontalBrowseTransportSnapshot) => {
    snapshotListeners.forEach((listener) => {
      try {
        listener(snapshot)
      } catch {}
    })
  }

  const applySnapshot = (
    snapshot: HorizontalBrowseTransportSnapshot | null | undefined,
    notifyListeners = true
  ) => {
    if (!snapshot) return
    const snapshotSequence = Number(snapshot.snapshotSequence)
    if (
      Number.isFinite(snapshotSequence) &&
      snapshotSequence > 0 &&
      lastAppliedSnapshotSequence > 0 &&
      snapshotSequence < lastAppliedSnapshotSequence
    ) {
      return
    }
    if (Number.isFinite(snapshotSequence) && snapshotSequence > lastAppliedSnapshotSequence) {
      lastAppliedSnapshotSequence = snapshotSequence
    }
    state.capturedAtEpochMs = snapshot.capturedAtEpochMs
    state.snapshotSequence = snapshot.snapshotSequence
    state.stateRevision = snapshot.stateRevision
    state.auditionSuspended = snapshot.auditionSuspended === true
    state.leaderDeck = snapshot.leaderDeck
    state.top = { ...preserveLiveClockDeckSnapshot('top', snapshot.top) }
    state.bottom = { ...preserveLiveClockDeckSnapshot('bottom', snapshot.bottom) }
    state.output = { ...snapshot.output }
    if (notifyListeners) {
      notifySnapshotListeners(snapshot)
    }
  }

  const handleSnapshotUpdated = (_event: unknown, snapshot: HorizontalBrowseTransportSnapshot) => {
    applySnapshot(snapshot)
  }

  const ensureSnapshotEventBound = () => {
    if (snapshotEventBound) return
    window.electron.ipcRenderer.on(
      HORIZONTAL_BROWSE_TRANSPORT_SNAPSHOT_EVENT,
      handleSnapshotUpdated
    )
    snapshotEventBound = true
  }

  const maybeUnbindSnapshotEvent = () => {
    if (!snapshotEventBound || snapshotListeners.size > 0) return
    window.electron.ipcRenderer.removeListener(
      HORIZONTAL_BROWSE_TRANSPORT_SNAPSHOT_EVENT,
      handleSnapshotUpdated
    )
    snapshotEventBound = false
  }

  const reset = async () => {
    const snapshot = (await window.electron.ipcRenderer.invoke(
      'horizontal-browse-transport:reset'
    )) as HorizontalBrowseTransportSnapshot
    applySnapshot(snapshot || createEmptyHorizontalBrowseTransportSnapshot())
  }

  const setDeckState = async (deck: HorizontalBrowseDeckKey, payload: LocalDeckState) => {
    const nowMs = performance.now()
    const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:native:set-deck-state:${deck}`)
    const beatGrid = resolveHorizontalBrowseTransportGrid(payload.song || {})
    const snapshot = await invoke('horizontal-browse-transport:set-deck-state', deck, nowMs, {
      filePath: payload.song?.filePath || '',
      title: payload.song?.title || payload.song?.fileName || '',
      ...beatGrid,
      timeBasisOffsetMs: Number(payload.song?.timeBasisOffsetMs) || 0,
      durationSec: Number(payload.durationSec) || 0,
      currentSec: Number(payload.currentSec) || 0,
      lastObservedAtMs: Number(payload.lastObservedAtMs) || 0,
      playing: Boolean(payload.playing),
      playbackRate: Number(payload.playbackRate) || 1,
      masterTempoEnabled: payload.masterTempoEnabled !== false
    })
    finishTiming()
    applySnapshot(snapshot)
    return snapshot
  }

  const setState = async (
    payload: {
      top: LocalDeckState
      bottom: LocalDeckState
      allowPhaseAlignment?: boolean
    },
    options: SnapshotApplyOptions = {}
  ) => {
    const nowMs = performance.now()
    const topBeatGrid = resolveHorizontalBrowseTransportGrid(payload.top.song || {})
    const bottomBeatGrid = resolveHorizontalBrowseTransportGrid(payload.bottom.song || {})
    const snapshot = await invoke('horizontal-browse-transport:set-state', {
      nowMs,
      top: {
        filePath: payload.top.song?.filePath || '',
        title: payload.top.song?.title || payload.top.song?.fileName || '',
        ...topBeatGrid,
        timeBasisOffsetMs: Number(payload.top.song?.timeBasisOffsetMs) || 0,
        durationSec: Number(payload.top.durationSec) || 0,
        currentSec: Number(payload.top.currentSec) || 0,
        lastObservedAtMs: Number(payload.top.lastObservedAtMs) || 0,
        playing: Boolean(payload.top.playing),
        playbackRate: Number(payload.top.playbackRate) || 1,
        masterTempoEnabled: payload.top.masterTempoEnabled !== false
      },
      bottom: {
        filePath: payload.bottom.song?.filePath || '',
        title: payload.bottom.song?.title || payload.bottom.song?.fileName || '',
        ...bottomBeatGrid,
        timeBasisOffsetMs: Number(payload.bottom.song?.timeBasisOffsetMs) || 0,
        durationSec: Number(payload.bottom.durationSec) || 0,
        currentSec: Number(payload.bottom.currentSec) || 0,
        lastObservedAtMs: Number(payload.bottom.lastObservedAtMs) || 0,
        playing: Boolean(payload.bottom.playing),
        playbackRate: Number(payload.bottom.playbackRate) || 1,
        masterTempoEnabled: payload.bottom.masterTempoEnabled !== false
      },
      allowPhaseAlignment: payload.allowPhaseAlignment !== false
    })
    applySnapshot(snapshot, options.notifySnapshotListeners !== false)
    return snapshot
  }

  const setPlaybackRate = async (deck: HorizontalBrowseDeckKey, playbackRate: number) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-playback-rate',
      deck,
      performance.now(),
      Number(playbackRate) || 1
    )
    liveClockPlaybackRate[deck] = null
    applySnapshot(snapshot)
    return snapshot
  }

  const setPlaybackRateLive = (deck: HorizontalBrowseDeckKey, playbackRate: number) => {
    const nextRate = Number(playbackRate) || 1
    liveClockPlaybackRate[deck] = nextRate
    window.electron.ipcRenderer.send(
      'horizontal-browse-transport:set-playback-rate-live',
      deck,
      performance.now(),
      nextRate
    )
  }

  const setTempoNudgePlaybackRate = async (deck: HorizontalBrowseDeckKey, playbackRate: number) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-tempo-nudge-playback-rate',
      deck,
      performance.now(),
      Number(playbackRate) || 1
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const setMasterTempoEnabled = async (deck: HorizontalBrowseDeckKey, enabled: boolean) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-master-tempo-enabled',
      deck,
      performance.now(),
      Boolean(enabled)
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const setBeatGrid = async (
    deck: HorizontalBrowseDeckKey,
    payload: HorizontalBrowseTransportBeatGridInput
  ) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-beat-grid',
      deck,
      performance.now(),
      payload
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const beatsync = async (deck: HorizontalBrowseDeckKey) => {
    const snapshot = await invoke('horizontal-browse-transport:beatsync', deck, performance.now())
    applySnapshot(snapshot)
    return snapshot
  }

  const alignToLeader = async (
    deck: HorizontalBrowseDeckKey,
    targetSec?: number,
    skipGridSnap?: boolean,
    options: SnapshotApplyOptions = {}
  ) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:align-to-leader',
      deck,
      performance.now(),
      Number.isFinite(Number(targetSec)) ? Number(targetSec) : undefined,
      skipGridSnap
    )
    applySnapshot(snapshot, options.notifySnapshotListeners !== false)
    return snapshot
  }

  const setSyncEnabled = async (deck: HorizontalBrowseDeckKey, enabled: boolean) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-sync-enabled',
      deck,
      performance.now(),
      enabled
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const setLeader = async (
    deck?: HorizontalBrowseDeckKey | null,
    options: SnapshotApplyOptions = {}
  ) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-leader',
      deck || null,
      performance.now()
    )
    applySnapshot(snapshot, options.notifySnapshotListeners !== false)
    return snapshot
  }

  const setBandState = async (
    deck: HorizontalBrowseDeckKey,
    bands: HorizontalBrowseTransportBandState
  ) => {
    const snapshot = await invoke('horizontal-browse-transport:set-band-state', deck, {
      high: bands.high !== false,
      mid: bands.mid !== false,
      low: bands.low !== false
    })
    applySnapshot(snapshot)
    return snapshot
  }

  const setCueMonitorEnabled = async (deck: HorizontalBrowseDeckKey, enabled: boolean) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-cue-monitor-enabled',
      deck,
      enabled
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const setPlaying = async (deck: HorizontalBrowseDeckKey, playing: boolean) => {
    const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:native:set-playing:${deck}`)
    const snapshot = await invoke(
      'horizontal-browse-transport:set-playing',
      deck,
      performance.now(),
      playing
    )
    finishTiming()
    applySnapshot(snapshot)
    return snapshot
  }

  const setAuditionSuspended = async (suspended: boolean) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-audition-suspended',
      performance.now(),
      Boolean(suspended)
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const preparePlayhead = async (deck: HorizontalBrowseDeckKey) => {
    const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:native:prepare-playhead:${deck}`)
    const snapshot = await invoke(
      'horizontal-browse-transport:prepare-playhead',
      deck,
      performance.now()
    )
    finishTiming()
    applySnapshot(snapshot)
    return snapshot
  }

  const seek = async (deck: HorizontalBrowseDeckKey, currentSec: number) => {
    const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:native:seek:${deck}`)
    const snapshot = await invoke(
      'horizontal-browse-transport:seek',
      deck,
      performance.now(),
      currentSec
    )
    finishTiming()
    applySnapshot(snapshot)
    return snapshot
  }

  const setScrubPreview = async (
    deck: HorizontalBrowseDeckKey,
    active: boolean,
    currentSec: number,
    rate: number
  ) => {
    return await invoke(
      'horizontal-browse-transport:set-scrub-preview',
      deck,
      performance.now(),
      Boolean(active),
      Number(currentSec) || 0,
      Number(rate) || 0
    )
  }

  const setMetronome = async (
    deck: HorizontalBrowseDeckKey,
    enabled: boolean,
    volumeLevel: number
  ) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-metronome',
      deck,
      enabled,
      volumeLevel
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const setGain = async (deck: HorizontalBrowseDeckKey, gain: number) => {
    const snapshot = await invoke('horizontal-browse-transport:set-gain', deck, gain)
    applySnapshot(snapshot)
    return snapshot
  }

  const setAutoGainEnabled = async (deck: HorizontalBrowseDeckKey, enabled: boolean) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-auto-gain-enabled',
      deck,
      enabled
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const toggleLoop = async (deck: HorizontalBrowseDeckKey) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:toggle-loop',
      deck,
      performance.now()
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const stepLoopBeats = async (deck: HorizontalBrowseDeckKey, direction: -1 | 1) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:step-loop-beats',
      deck,
      performance.now(),
      direction
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const setLoopFromRange = async (
    deck: HorizontalBrowseDeckKey,
    startSec: number,
    endSec: number
  ) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-loop-from-range',
      deck,
      startSec,
      endSec
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const clearLoop = async (deck: HorizontalBrowseDeckKey) => {
    const snapshot = await invoke('horizontal-browse-transport:clear-loop', deck)
    applySnapshot(snapshot)
    return snapshot
  }

  const setOutputState = async (crossfaderValue: number, masterGain: number) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-output-state',
      crossfaderValue,
      masterGain
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const snapshot = async (nowMs?: number) => {
    const finishTiming = startHorizontalBrowseUserTiming('frkb:hb:native:snapshot')
    const next = await invoke('horizontal-browse-transport:snapshot', nowMs)
    finishTiming()
    applySnapshot(next, false)
    return next
  }

  const visualizerSnapshot = async () =>
    (await window.electron.ipcRenderer.invoke(
      'horizontal-browse-transport:visualizer-snapshot'
    )) as HorizontalBrowseTransportVisualizerSnapshot

  const subscribeSnapshot = (listener: SnapshotListener) => {
    snapshotListeners.add(listener)
    ensureSnapshotEventBound()
    return () => {
      snapshotListeners.delete(listener)
      maybeUnbindSnapshotEvent()
    }
  }

  return {
    state,
    reset,
    setDeckState,
    setState,
    setPlaybackRate,
    setPlaybackRateLive,
    setLiveClockPlaybackRate,
    resolveLiveClockPlaybackRate,
    setTempoNudgePlaybackRate,
    setMasterTempoEnabled,
    setBeatGrid,
    beatsync,
    alignToLeader,
    setSyncEnabled,
    setLeader,
    setBandState,
    setCueMonitorEnabled,
    setPlaying,
    setAuditionSuspended,
    preparePlayhead,
    seek,
    setScrubPreview,
    setMetronome,
    toggleLoop,
    stepLoopBeats,
    setLoopFromRange,
    clearLoop,
    setGain,
    setAutoGainEnabled,
    setOutputState,
    snapshot,
    visualizerSnapshot,
    subscribeSnapshot
  }
}
