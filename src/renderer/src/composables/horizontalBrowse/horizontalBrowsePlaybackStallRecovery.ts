import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot,
  HorizontalBrowseTransportSnapshot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRenderSync'

type DeckKey = HorizontalBrowseDeckKey

type PlaybackStallState = {
  lastCurrentSec: number | null
  lastAudioCurrentSec: number | null
  lastRenderCurrentSec: number | null
  stalledSinceMs: number
  recoveryInFlight: boolean
  lastRecoveryAtMs: number
}

type HorizontalBrowsePlaybackStallRecoveryParams = {
  nativeTransport: {
    preparePlayhead: (deck: DeckKey) => Promise<unknown>
    setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
    snapshot: (nowMs?: number) => Promise<HorizontalBrowseTransportSnapshot>
  }
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckPendingPlay: (deck: DeckKey) => boolean
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
}

const WATCH_INTERVAL_MS = 250
const STALL_THRESHOLD_MS = 500
const RECOVERY_COOLDOWN_MS = 3000
const PROGRESS_EPSILON_SEC = 0.03

const isDeckAtTrackEnd = (snapshot: HorizontalBrowseTransportDeckSnapshot) => {
  const endSec =
    snapshot.effectiveDurationSec > 0 ? snapshot.effectiveDurationSec : snapshot.durationSec
  return Number.isFinite(endSec) && endSec > 0 && snapshot.currentSec >= endSec
}

const createDefaultPlaybackStallState = (): PlaybackStallState => ({
  lastCurrentSec: null,
  lastAudioCurrentSec: null,
  lastRenderCurrentSec: null,
  stalledSinceMs: 0,
  recoveryInFlight: false,
  lastRecoveryAtMs: 0
})

export const createHorizontalBrowsePlaybackStallRecovery = (
  params: HorizontalBrowsePlaybackStallRecoveryParams
) => {
  const deckState: Record<DeckKey, PlaybackStallState> = {
    top: createDefaultPlaybackStallState(),
    bottom: createDefaultPlaybackStallState()
  }
  let watchTimer: number | null = null

  const resetDeckWatch = (deck: DeckKey, snapshot: HorizontalBrowseTransportDeckSnapshot) => {
    const state = deckState[deck]
    state.lastCurrentSec = Number(snapshot.currentSec) || 0
    state.lastAudioCurrentSec = Number(snapshot.audioCurrentSec) || 0
    state.lastRenderCurrentSec = Number(snapshot.renderCurrentSec) || 0
    state.stalledSinceMs = 0
  }

  const hasSnapshotProgressed = (
    state: PlaybackStallState,
    snapshot: HorizontalBrowseTransportDeckSnapshot
  ) => {
    const currentSec = Number(snapshot.currentSec) || 0
    const audioCurrentSec = Number(snapshot.audioCurrentSec) || 0
    const renderCurrentSec = Number(snapshot.renderCurrentSec) || 0
    const progressed =
      state.lastCurrentSec === null ||
      state.lastAudioCurrentSec === null ||
      state.lastRenderCurrentSec === null ||
      Math.abs(currentSec - state.lastCurrentSec) >= PROGRESS_EPSILON_SEC ||
      Math.abs(audioCurrentSec - state.lastAudioCurrentSec) >= PROGRESS_EPSILON_SEC ||
      Math.abs(renderCurrentSec - state.lastRenderCurrentSec) >= PROGRESS_EPSILON_SEC
    state.lastCurrentSec = currentSec
    state.lastAudioCurrentSec = audioCurrentSec
    state.lastRenderCurrentSec = renderCurrentSec
    return progressed
  }

  const recoverDeck = (deck: DeckKey) => {
    const state = deckState[deck]
    if (state.recoveryInFlight) return
    const nowMs = performance.now()
    if (nowMs - state.lastRecoveryAtMs < RECOVERY_COOLDOWN_MS) return
    state.recoveryInFlight = true
    state.lastRecoveryAtMs = nowMs
    void (async () => {
      try {
        const freshTransportSnapshot = await params.nativeTransport.snapshot(performance.now())
        const freshDeckSnapshot =
          deck === 'top' ? freshTransportSnapshot.top : freshTransportSnapshot.bottom
        if (
          !freshDeckSnapshot.playing ||
          isDeckAtTrackEnd(freshDeckSnapshot) ||
          hasSnapshotProgressed(state, freshDeckSnapshot)
        ) {
          return
        }
        await params.nativeTransport.preparePlayhead(deck)
        if (params.resolveTransportDeckSnapshot(deck).playing) {
          await params.nativeTransport.setPlaying(deck, true)
        }
        await params.nativeTransport.snapshot(performance.now()).catch(() => undefined)
        params.syncDeckRenderState({ force: deck, forceRevision: true })
      } catch {
      } finally {
        state.recoveryInFlight = false
        resetDeckWatch(deck, params.resolveTransportDeckSnapshot(deck))
      }
    })()
  }

  const inspectDeck = (deck: DeckKey) => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const song = params.resolveDeckSong(deck)
    const state = deckState[deck]
    const playRequested = snapshot.playing || params.resolveDeckPlaying(deck)
    const canInspect =
      playRequested &&
      !isDeckAtTrackEnd(snapshot) &&
      !!String(song?.filePath || '').trim() &&
      !params.resolveDeckPendingPlay(deck)
    if (!canInspect) {
      resetDeckWatch(deck, snapshot)
      return
    }
    if (hasSnapshotProgressed(state, snapshot)) {
      state.stalledSinceMs = 0
      return
    }
    const nowMs = performance.now()
    if (!state.stalledSinceMs) {
      state.stalledSinceMs = nowMs
      return
    }
    if (nowMs - state.stalledSinceMs < STALL_THRESHOLD_MS) return
    recoverDeck(deck)
  }

  const start = () => {
    if (watchTimer !== null) return
    watchTimer = window.setInterval(() => {
      inspectDeck('top')
      inspectDeck('bottom')
    }, WATCH_INTERVAL_MS)
  }

  const dispose = () => {
    if (watchTimer !== null) {
      window.clearInterval(watchTimer)
      watchTimer = null
    }
  }

  start()

  return {
    dispose
  }
}
