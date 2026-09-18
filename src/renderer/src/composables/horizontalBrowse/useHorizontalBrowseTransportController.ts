import { computed, reactive } from 'vue'
import { createHorizontalBrowseNativeTransport } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import { useHorizontalBrowseRenderSync } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRenderSync'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportSnapshot,
  HorizontalBrowseTransportDeckSnapshot
} from '@shared/horizontalBrowseTransport'

type DeckKey = HorizontalBrowseDeckKey
const MAX_SNAPSHOT_EVENT_AGE_MS = 10000

type UseHorizontalBrowseTransportControllerOptions = {
  linkedGridVisualPending?: () => boolean
}

const resolveSnapshotAtMs = (snapshot: HorizontalBrowseTransportSnapshot, receivedAtMs: number) => {
  const capturedAtEpochMs = Number(snapshot.capturedAtEpochMs)
  if (!Number.isFinite(capturedAtEpochMs) || capturedAtEpochMs <= 0) {
    return receivedAtMs
  }
  const ageMs = Date.now() - capturedAtEpochMs
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return receivedAtMs
  }
  return Math.max(0, receivedAtMs - Math.min(ageMs, MAX_SNAPSHOT_EVENT_AGE_MS))
}

export const useHorizontalBrowseTransportController = (
  options: UseHorizontalBrowseTransportControllerOptions = {}
) => {
  const nativeTransport = createHorizontalBrowseNativeTransport()
  const deckSyncState = nativeTransport.state
  const deckSeekIntent = reactive<Record<DeckKey, { seconds: number; revision: number }>>({
    top: { seconds: 0, revision: 0 },
    bottom: { seconds: 0, revision: 0 }
  })

  const resolveTransportDeckSnapshot = (deck: DeckKey): HorizontalBrowseTransportDeckSnapshot =>
    deck === 'top' ? nativeTransport.state.top : nativeTransport.state.bottom

  const normalizeTimelineSeconds = (seconds: number) => {
    const numeric = Number(seconds)
    return Number.isFinite(numeric) ? numeric : 0
  }

  const resolveDeckCurrentSeconds = (deck: DeckKey) =>
    Number(resolveTransportDeckSnapshot(deck).currentSec) || 0

  const resolveDeckPlaying = (deck: DeckKey) => Boolean(resolveTransportDeckSnapshot(deck).playing)
  const resolveDeckLoaded = (deck: DeckKey) => Boolean(resolveTransportDeckSnapshot(deck).loaded)
  const resolveDeckDecoding = (deck: DeckKey) =>
    Boolean(resolveTransportDeckSnapshot(deck).decoding)
  const resolveDeckPlaybackRate = (deck: DeckKey) =>
    Number(resolveTransportDeckSnapshot(deck).playbackRate) || 1

  const topDeckPlaybackRate = computed(() => resolveDeckPlaybackRate('top'))
  const bottomDeckPlaybackRate = computed(() => resolveDeckPlaybackRate('bottom'))

  const {
    topDeckRenderCurrentSeconds,
    bottomDeckRenderCurrentSeconds,
    topDeckPlaybackSyncRevision,
    bottomDeckPlaybackSyncRevision,
    auditionPresentationSuspended,
    resolveDeckRenderCurrentSeconds,
    syncDeckRenderState,
    setAuditionPresentationSuspended,
    markTransportStateFresh,
    applyDeckRenderCurrentSeconds,
    holdDeckRenderCurrentSeconds: holdRenderCurrentSeconds,
    startDeckRenderPlaybackClock: startRenderPlaybackClock,
    startRenderSyncLoop,
    stopRenderSyncLoop
  } = useHorizontalBrowseRenderSync({
    nativeTransport,
    resolveTransportDeckSnapshot,
    resolveDeckPlaying,
    linkedGridVisualPending: options.linkedGridVisualPending
  })
  let stopSnapshotSubscription: (() => void) | null = null

  const notifyDeckSeekIntent = (deck: DeckKey, seconds: number) => {
    const safeSeconds = normalizeTimelineSeconds(seconds)
    deckSeekIntent[deck] = {
      seconds: safeSeconds,
      revision: deckSeekIntent[deck].revision + 1
    }
    // seek 意图先改渲染基准，避免 nativeTransport.seek 的 IPC 往返期间
    // 大波形还沿着旧时间继续外推，造成“先飘再跳”的错位感。
    applyDeckRenderCurrentSeconds(deck, safeSeconds)
  }
  const holdDeckRenderCurrentSeconds = (deck: DeckKey, seconds: number) => {
    holdRenderCurrentSeconds(deck, normalizeTimelineSeconds(seconds))
  }
  const startDeckRenderPlaybackClock = (deck: DeckKey, seconds: number) => {
    startRenderPlaybackClock(deck, normalizeTimelineSeconds(seconds))
  }
  const primeDeckRenderCurrentSeconds = (deck: DeckKey, seconds: number) => {
    applyDeckRenderCurrentSeconds(deck, normalizeTimelineSeconds(seconds))
  }

  const startSnapshotSync = () => {
    if (stopSnapshotSubscription) return
    stopSnapshotSubscription = nativeTransport.subscribeSnapshot((snapshot) => {
      const nowMs = performance.now()
      markTransportStateFresh(nowMs)
      syncDeckRenderState({
        nowMs,
        snapshotAtMs: resolveSnapshotAtMs(snapshot, nowMs)
      })
    })
  }

  const stopSnapshotSync = () => {
    if (!stopSnapshotSubscription) return
    stopSnapshotSubscription()
    stopSnapshotSubscription = null
  }

  return {
    nativeTransport,
    deckSyncState,
    deckSeekIntent,
    topDeckPlaybackRate,
    bottomDeckPlaybackRate,
    topDeckRenderCurrentSeconds,
    bottomDeckRenderCurrentSeconds,
    topDeckPlaybackSyncRevision,
    bottomDeckPlaybackSyncRevision,
    auditionPresentationSuspended,
    resolveTransportDeckSnapshot,
    resolveDeckCurrentSeconds,
    resolveDeckPlaying,
    resolveDeckLoaded,
    resolveDeckDecoding,
    resolveDeckPlaybackRate,
    resolveDeckRenderCurrentSeconds,
    syncDeckRenderState,
    setAuditionPresentationSuspended,
    startSnapshotSync,
    stopSnapshotSync,
    startRenderSyncLoop,
    stopRenderSyncLoop,
    holdDeckRenderCurrentSeconds,
    startDeckRenderPlaybackClock,
    primeDeckRenderCurrentSeconds,
    notifyDeckSeekIntent
  }
}
