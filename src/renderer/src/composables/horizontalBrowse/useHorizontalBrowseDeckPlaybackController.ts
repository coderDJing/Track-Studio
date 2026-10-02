import { onScopeDispose, reactive, watch } from 'vue'
import type { ISongHotCue, ISongMemoryCue } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import {
  beginHorizontalBrowseDeckAction,
  resolveHorizontalBrowseDeckActionElapsedMs
} from '@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTimeline'
import { sendHorizontalBrowseInteractionTrace } from '@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTrace'
import { startHorizontalBrowseUserTiming } from '@renderer/composables/horizontalBrowse/horizontalBrowseUserTiming'
import { resolveSongCueTimelineDefinition } from '@shared/songCueTimeBasis'
import { createHorizontalBrowsePlaybackStallRecovery } from '@renderer/composables/horizontalBrowse/horizontalBrowsePlaybackStallRecovery'
import { handleHorizontalBrowseLinkedRawWaveformDragEnd } from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedRawWaveformDragEnd'
import {
  createDefaultDeckWaveformDragState,
  type DeckScrubPreviewRequest,
  type DeckSeekRequest,
  type DeckWaveformDragEndPayload,
  type DeckWaveformDragState,
  type DeckWaveformScrubPreviewPayload
} from '@renderer/composables/horizontalBrowse/horizontalBrowseDeckPlaybackState'
import { createHorizontalBrowseSyncedSeekPreparation } from '@renderer/composables/horizontalBrowse/horizontalBrowseSyncedSeekPreparation'
import { resolveHorizontalBrowseBeatSyncDecks } from '@renderer/composables/horizontalBrowse/horizontalBrowseBeatSyncDecks'
import { startHorizontalBrowseBeatSyncRawWaveformDragRelease } from '@renderer/composables/horizontalBrowse/horizontalBrowseBeatSyncRawWaveformDragRelease'
import { shouldNotifyHorizontalBrowseAlignedDragReleaseSeek } from '@renderer/composables/horizontalBrowse/horizontalBrowseDragReleaseSeekIntent'
import type { UseHorizontalBrowseDeckPlaybackControllerParams } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckPlaybackControllerTypes'
import {
  normalizeLinkedDragVisualPlaybackRate,
  resolveHorizontalBrowseLinkedDragTargets
} from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedDragTargets'
import {
  resolveHorizontalBrowseLinkedDeckPlaybackOrder,
  resolveOtherHorizontalBrowseLinkedDeck
} from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedDeckOrder'
import { createHorizontalBrowseSectionSeekPlayHandler } from '@renderer/composables/horizontalBrowse/horizontalBrowseSectionSeekPlay'
import { createHorizontalBrowseBeatJumpHandlers } from '@renderer/composables/horizontalBrowse/horizontalBrowseBeatJumpHandlers'
import { queueHorizontalBrowseDeckAnalysis } from '@renderer/composables/horizontalBrowse/horizontalBrowseExternalDjAnalysis'

type DeckKey = HorizontalBrowseDeckKey

const SYNCED_SEEK_PLAYHEAD_READY_TIMEOUT_MS = 1500
const SYNCED_SEEK_PLAYHEAD_READY_POLL_MS = 24
const SYNCED_SEEK_PREPARE_TIMEOUT_MS = 3000
const SYNCED_SEEK_PREPARE_MAX_ALIGNMENTS = 4
const DRAG_RELEASE_STABLE_FRAME_WAIT_MS = 120
const PLAYHEAD_READY_NEGATIVE_EPSILON_SEC = 0.0001

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
const resolveOtherDeck = resolveOtherHorizontalBrowseLinkedDeck

const PENDING_PLAY_VISIBLE_DELAY_MS = 250

export const useHorizontalBrowseDeckPlaybackController = (
  params: UseHorizontalBrowseDeckPlaybackControllerParams
) => {
  const deckWaveformDragState = reactive<Record<DeckKey, DeckWaveformDragState>>({
    top: createDefaultDeckWaveformDragState(),
    bottom: createDefaultDeckWaveformDragState()
  })
  const deckPendingPlayOnLoad = reactive<Record<DeckKey, boolean>>({
    top: false,
    bottom: false
  })
  const deckPendingPlayVisible = reactive<Record<DeckKey, boolean>>({
    top: false,
    bottom: false
  })
  const deckPendingPlayVisibleTimers: Record<DeckKey, number | null> = {
    top: null,
    bottom: null
  }
  const deckSeekActionToken: Record<DeckKey, number> = {
    top: 0,
    bottom: 0
  }
  const deckSeekRunning: Record<DeckKey, boolean> = {
    top: false,
    bottom: false
  }
  const deckPendingSeekRequest: Record<DeckKey, DeckSeekRequest | null> = {
    top: null,
    bottom: null
  }
  const deckSeekResumeOnComplete: Record<DeckKey, boolean> = {
    top: false,
    bottom: false
  }
  const deckScrubPreviewInFlight: Record<DeckKey, boolean> = {
    top: false,
    bottom: false
  }
  const deckPendingScrubPreview: Record<DeckKey, DeckScrubPreviewRequest | null> = {
    top: null,
    bottom: null
  }

  const isDualTransportSyncActive = () =>
    Boolean(
      params.resolveDualTransportSyncEnabled?.() &&
      params.resolveDeckSong('top') &&
      params.resolveDeckSong('bottom')
    )

  const ensureDualTransportSync = async (sourceDeck: DeckKey) => {
    if (!isDualTransportSyncActive()) return false
    return Boolean(await params.ensureDualTransportSync?.(sourceDeck))
  }

  const resolveLinkedDeckPlaybackOrder = (fallbackDeck: DeckKey) =>
    resolveHorizontalBrowseLinkedDeckPlaybackOrder(fallbackDeck, {
      resolveDeckSong: params.resolveDeckSong,
      resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot
    })

  const resolveActiveBeatSyncDecks = (deck: DeckKey) =>
    resolveHorizontalBrowseBeatSyncDecks({
      deck,
      hasDeckSong: (targetDeck) => Boolean(params.resolveDeckSong(targetDeck)),
      resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot
    })

  const resolveLinkedDragDelta = (deck: DeckKey, otherDeck: DeckKey, rawSourceTargetSec: number) =>
    resolveHorizontalBrowseLinkedDragTargets({
      deck,
      otherDeck,
      rawSourceTargetSec,
      sourceDragState: deckWaveformDragState[deck],
      otherDragState: deckWaveformDragState[otherDeck],
      resolveDeckDurationSeconds: params.resolveDeckDurationSeconds
    })

  const traceDeckAction = (deck: DeckKey, stage: string, payload?: Record<string, unknown>) => {
    const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
    sendHorizontalBrowseInteractionTrace(stage, {
      deck,
      filePath,
      ...payload
    })
  }

  const clearPendingPlayVisibleTimer = (deck: DeckKey) => {
    const timer = deckPendingPlayVisibleTimers[deck]
    if (timer !== null) {
      window.clearTimeout(timer)
      deckPendingPlayVisibleTimers[deck] = null
    }
  }

  const syncPendingPlayVisible = (deck: DeckKey, pending: boolean) => {
    clearPendingPlayVisibleTimer(deck)
    if (!pending) {
      deckPendingPlayVisible[deck] = false
      return
    }
    deckPendingPlayVisibleTimers[deck] = window.setTimeout(() => {
      deckPendingPlayVisibleTimers[deck] = null
      deckPendingPlayVisible[deck] = deckPendingPlayOnLoad[deck]
    }, PENDING_PLAY_VISIBLE_DELAY_MS)
  }

  const { resolveSyncedSeekPreparationState } = createHorizontalBrowseSyncedSeekPreparation({
    resolveDeckSong: params.resolveDeckSong,
    resolveDeckGridBpm: params.resolveDeckGridBpm,
    resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot
  })

  const canDeckExecuteImmediateTransportAction = (deck: DeckKey) =>
    Boolean(String(params.resolveDeckSong(deck)?.filePath || '').trim())

  const isDeckPlayheadReady = (deck: DeckKey) => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    if (snapshot.playheadLoaded || snapshot.playingAudible) return true
    const currentSec = Number(snapshot.currentSec) || 0
    const renderCurrentSec = Number(snapshot.renderCurrentSec) || 0
    return (
      snapshot.loaded &&
      (currentSec < -PLAYHEAD_READY_NEGATIVE_EPSILON_SEC ||
        renderCurrentSec < -PLAYHEAD_READY_NEGATIVE_EPSILON_SEC)
    )
  }

  const prepareDeckPlayheadIfNeeded = async (deck: DeckKey) => {
    if (isDeckPlayheadReady(deck) || !canDeckExecuteImmediateTransportAction(deck)) return
    await params.nativeTransport.preparePlayhead(deck).catch(() => undefined)
  }

  const prepareDeckStableFrameForAnchor = (
    deck: DeckKey,
    seconds: number,
    options?: { timeoutMs?: number }
  ) =>
    params.prepareDeckStableFrameForAnchor?.(deck, seconds, options).catch(() => false) ??
    Promise.resolve(false)

  const resumeDeckPlaybackAfterSeek = async (deck: DeckKey) => {
    await prepareDeckPlayheadIfNeeded(deck)
    params.startDeckRenderPlaybackClock(deck, params.resolveDeckRenderCurrentSeconds(deck))
    await params.nativeTransport.setPlaying(deck, true)
  }

  const playbackStallRecovery = createHorizontalBrowsePlaybackStallRecovery({
    nativeTransport: params.nativeTransport,
    syncDeckRenderState: params.syncDeckRenderState,
    resolveDeckSong: params.resolveDeckSong,
    resolveDeckPlaying: params.resolveDeckPlaying,
    resolveDeckPendingPlay: (deck) => deckPendingPlayOnLoad[deck],
    resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot
  })

  watch(
    () => [deckPendingPlayOnLoad.top, deckPendingPlayOnLoad.bottom] as const,
    ([topPending, bottomPending]) => {
      syncPendingPlayVisible('top', topPending)
      syncPendingPlayVisible('bottom', bottomPending)
    }
  )

  onScopeDispose(() => {
    clearPendingPlayVisibleTimer('top')
    clearPendingPlayVisibleTimer('bottom')
    playbackStallRecovery.dispose()
  })

  const clampDeckTimelineSeconds = (deck: DeckKey, seconds: number) => {
    const numeric = Number(seconds)
    if (!Number.isFinite(numeric)) return 0
    const duration = params.resolveDeckDurationSeconds(deck)
    return duration > 0 ? Math.min(numeric, duration) : numeric
  }

  const resolveSnapshotAnchorSec = (snapshot: HorizontalBrowseTransportDeckSnapshot) => {
    const renderCurrentSec = Number(snapshot.renderCurrentSec)
    if (Number.isFinite(renderCurrentSec)) return renderCurrentSec
    const currentSec = Number(snapshot.currentSec)
    return Number.isFinite(currentSec) ? currentSec : 0
  }

  const isSyncedSeekTokenCurrent = (deck: DeckKey, token: number, _source: string) =>
    deckSeekActionToken[deck] === token

  const waitForSyncedSeekPlayheadReady = async (
    deck: DeckKey,
    token: number,
    source: string,
    timeoutMs = SYNCED_SEEK_PLAYHEAD_READY_TIMEOUT_MS
  ) => {
    const startedAt = performance.now()
    let lastSnapshot = params.resolveTransportDeckSnapshot(deck)
    const isPlayheadReady = () => lastSnapshot.playheadLoaded
    if (isPlayheadReady()) return true
    while (performance.now() - startedAt < timeoutMs) {
      if (!isSyncedSeekTokenCurrent(deck, token, source)) {
        return false
      }
      await wait(SYNCED_SEEK_PLAYHEAD_READY_POLL_MS)
      await params.nativeTransport.snapshot(performance.now()).catch(() => undefined)
      lastSnapshot = params.resolveTransportDeckSnapshot(deck)
      if (isPlayheadReady()) {
        return true
      }
    }
    return isPlayheadReady()
  }

  const prepareSyncedSeekBeforeResume = async (
    deck: DeckKey,
    token: number,
    source: string,
    requestedSec: number
  ) => {
    const startedAt = performance.now()
    let anchorSec = Math.max(0, Number(requestedSec) || 0)

    for (
      let alignmentAttempt = 1;
      alignmentAttempt <= SYNCED_SEEK_PREPARE_MAX_ALIGNMENTS;
      alignmentAttempt += 1
    ) {
      if (!isSyncedSeekTokenCurrent(deck, token, source)) {
        return null
      }

      await params.nativeTransport.alignToLeader(deck, anchorSec)
      params.syncDeckRenderState({ force: 'all' })

      let prepareState = resolveSyncedSeekPreparationState(deck)
      let alignedSec = Math.max(0, Number(prepareState.snapshot.currentSec) || 0)
      params.notifyDeckSeekIntent(deck, alignedSec)

      if (!isSyncedSeekTokenCurrent(deck, token, source)) {
        return null
      }

      if (!prepareState.playheadReady) {
        const remainingTimeoutMs = SYNCED_SEEK_PREPARE_TIMEOUT_MS - (performance.now() - startedAt)
        if (remainingTimeoutMs <= 0) break

        const playheadReady = await waitForSyncedSeekPlayheadReady(
          deck,
          token,
          source,
          Math.max(SYNCED_SEEK_PLAYHEAD_READY_POLL_MS, remainingTimeoutMs)
        )
        if (!playheadReady) {
          return null
        }

        await params.nativeTransport.snapshot(performance.now()).catch(() => undefined)
        params.syncDeckRenderState({ force: 'all' })
        prepareState = resolveSyncedSeekPreparationState(deck)
        alignedSec = Math.max(0, Number(prepareState.snapshot.currentSec) || 0)
        params.notifyDeckSeekIntent(deck, alignedSec)
      }

      if (!isSyncedSeekTokenCurrent(deck, token, source)) {
        return null
      }

      if (prepareState.ready) {
        return alignedSec
      }

      if (performance.now() - startedAt >= SYNCED_SEEK_PREPARE_TIMEOUT_MS) {
        break
      }

      anchorSec = alignedSec
    }

    return null
  }

  const runLatestDeckSeekRequest = (deck: DeckKey) => {
    if (deckSeekRunning[deck]) return
    deckSeekRunning[deck] = true

    void (async () => {
      while (deckPendingSeekRequest[deck]) {
        const request = deckPendingSeekRequest[deck]
        deckPendingSeekRequest[deck] = null

        if (!request) continue

        const { token, seconds: targetSec, source, alignToLeader } = request

        try {
          const shouldPauseForSyncedSeek =
            deckSeekResumeOnComplete[deck] &&
            params.resolveTransportDeckSnapshot(deck).syncEnabled &&
            !params.isDeckLoopActive(deck)

          if (shouldPauseForSyncedSeek && params.resolveDeckPlaying(deck)) {
            await params.nativeTransport.setPlaying(deck, false)

            if (deckSeekActionToken[deck] !== token) {
              continue
            }
          }

          if (alignToLeader) {
            const preparedSec = await prepareSyncedSeekBeforeResume(deck, token, source, targetSec)
            if (deckSeekActionToken[deck] !== token) {
              continue
            }
            if (preparedSec === null) {
              deckSeekResumeOnComplete[deck] = false
              continue
            }
          } else {
            await params.nativeTransport.seek(deck, targetSec)
          }

          if (deckSeekActionToken[deck] !== token) {
            continue
          }

          if (
            !alignToLeader &&
            shouldPauseForSyncedSeek &&
            params.resolveTransportDeckSnapshot(deck).syncEnabled &&
            !params.isDeckLoopActive(deck)
          ) {
            await params.nativeTransport.beatsync(deck)

            if (deckSeekActionToken[deck] !== token) {
              continue
            }
          }

          if (deckSeekResumeOnComplete[deck]) {
            await resumeDeckPlaybackAfterSeek(deck)

            if (deckSeekActionToken[deck] !== token) {
              continue
            }
          }

          if (deckSeekActionToken[deck] !== token) {
            continue
          }

          params.syncDeckRenderState({ force: alignToLeader ? 'all' : deck })
          deckSeekResumeOnComplete[deck] = false
        } catch {
          if (deckSeekActionToken[deck] === token) {
            if (deckSeekResumeOnComplete[deck] && !params.resolveDeckPlaying(deck)) {
              try {
                await params.nativeTransport.setPlaying(deck, true)
              } catch {}
            }
            deckSeekResumeOnComplete[deck] = false
          }
        }
      }
    })().finally(() => {
      deckSeekRunning[deck] = false
      if (deckPendingSeekRequest[deck]) {
        runLatestDeckSeekRequest(deck)
      }
    })
  }

  const pauseDeckRawWaveformDragPlayback = (deck: DeckKey) => {
    const dragState = deckWaveformDragState[deck]
    if (!dragState.active || !dragState.wasPlaying || dragState.pausePromise) return

    const token = dragState.token
    dragState.pausePromise = params.nativeTransport
      .setPlaying(deck, false)
      .then(() => {
        const stale =
          !deckWaveformDragState[deck].active || deckWaveformDragState[deck].token !== token
        if (stale) {
          return
        }
        params.syncDeckRenderState({ force: deck })
      })
      .catch(() => {})
  }

  const startSingleDeckRawWaveformDrag = (deck: DeckKey, pausePlayback = true) => {
    params.touchDeckInteraction(deck)
    const dragState = deckWaveformDragState[deck]
    if (dragState.active) {
      return
    }

    const snapshot = params.resolveTransportDeckSnapshot(deck)
    dragState.active = true
    dragState.wasPlaying = snapshot.playing
    dragState.startAnchorSec = clampDeckTimelineSeconds(deck, resolveSnapshotAnchorSec(snapshot))
    dragState.anchorSec = dragState.startAnchorSec
    dragState.visualPlaybackRate = normalizeLinkedDragVisualPlaybackRate(snapshot.playbackRate)
    dragState.cueCommittedDuringDrag = false
    dragState.token += 1

    if (pausePlayback) {
      pauseDeckRawWaveformDragPlayback(deck)
    }
  }

  const handleDeckRawWaveformDragStart = (deck: DeckKey) => {
    if (!isDualTransportSyncActive()) {
      startSingleDeckRawWaveformDrag(deck)
      return
    }
    const otherDeck = resolveOtherDeck(deck)
    const playbackOrder = resolveLinkedDeckPlaybackOrder(deck)
    startSingleDeckRawWaveformDrag(deck, false)
    startSingleDeckRawWaveformDrag(otherDeck, false)
    pauseDeckRawWaveformDragPlayback(playbackOrder.follower)
    pauseDeckRawWaveformDragPlayback(playbackOrder.leader)
  }

  const runLatestDeckScrubPreviewRequest = (deck: DeckKey) => {
    if (deckScrubPreviewInFlight[deck]) return
    const request = deckPendingScrubPreview[deck]
    deckPendingScrubPreview[deck] = null
    if (!request) return
    if (
      request.active &&
      (!deckWaveformDragState[deck].active || deckWaveformDragState[deck].token !== request.token)
    ) {
      runLatestDeckScrubPreviewRequest(deck)
      return
    }

    deckScrubPreviewInFlight[deck] = true
    void params.nativeTransport
      .setScrubPreview(deck, request.active, request.anchorSec, request.playbackRate)
      .catch(() => {})
      .finally(() => {
        deckScrubPreviewInFlight[deck] = false
        if (deckPendingScrubPreview[deck]) {
          runLatestDeckScrubPreviewRequest(deck)
        }
      })
  }

  const queueDeckScrubPreviewRequest = (deck: DeckKey, request: DeckScrubPreviewRequest) => {
    deckPendingScrubPreview[deck] = request
    runLatestDeckScrubPreviewRequest(deck)
  }

  const finishDeckWaveformDragState = (deck: DeckKey, targetSec: number) => {
    const dragState = deckWaveformDragState[deck]
    const result = {
      wasActive: dragState.active,
      shouldResume: dragState.wasPlaying,
      pausePromise: dragState.pausePromise,
      token: dragState.token + 1
    }
    dragState.active = false
    dragState.wasPlaying = false
    dragState.pausePromise = null
    dragState.startAnchorSec = 0
    dragState.anchorSec = targetSec
    dragState.visualPlaybackRate = 1
    dragState.token = result.token
    queueDeckScrubPreviewRequest(deck, {
      token: result.token,
      active: false,
      anchorSec: targetSec,
      playbackRate: 0
    })
    return result
  }

  const handleDeckRawWaveformScrubPreview = (
    deck: DeckKey,
    payload: DeckWaveformScrubPreviewPayload
  ) => {
    const dragState = deckWaveformDragState[deck]
    if (!dragState.active) return
    const rawAnchorSec = Number(payload.anchorSec) || 0
    const otherDeck = resolveOtherDeck(deck)
    const otherDragState = deckWaveformDragState[otherDeck]
    const linkedDelta =
      isDualTransportSyncActive() && otherDragState.active
        ? resolveLinkedDragDelta(deck, otherDeck, rawAnchorSec)
        : null
    const anchorSec = linkedDelta?.sourceTargetSec ?? clampDeckTimelineSeconds(deck, rawAnchorSec)
    const sourcePlaybackRate = Number(payload.playbackRate) || 0
    dragState.anchorSec = anchorSec
    queueDeckScrubPreviewRequest(deck, {
      token: dragState.token,
      active: true,
      anchorSec,
      playbackRate: linkedDelta && linkedDelta.sourceBoundary !== 'none' ? 0 : sourcePlaybackRate
    })
    if (!linkedDelta) return
    const otherAnchorSec = linkedDelta.otherTargetSec
    otherDragState.anchorSec = otherAnchorSec
    params.holdDeckRenderCurrentSeconds(otherDeck, otherAnchorSec)
    queueDeckScrubPreviewRequest(otherDeck, {
      token: otherDragState.token,
      active: true,
      anchorSec: otherAnchorSec,
      playbackRate:
        linkedDelta.otherBoundary !== 'none' ? 0 : sourcePlaybackRate * linkedDelta.deltaScale
    })
  }

  const handleLinkedRawWaveformDragEnd = (deck: DeckKey, payload: DeckWaveformDragEndPayload) => {
    return handleHorizontalBrowseLinkedRawWaveformDragEnd({
      deck,
      payload,
      resolveOtherDeck,
      resolveDeckDragState: (targetDeck) => deckWaveformDragState[targetDeck],
      resolveDeckLeader: (targetDeck) => params.resolveTransportDeckSnapshot(targetDeck).leader,
      resolveLinkedDragDelta,
      finishDeckWaveformDragState,
      notifyDeckSeekIntent: params.notifyDeckSeekIntent,
      setLeader: params.nativeTransport.setLeader,
      alignToLeader: params.nativeTransport.alignToLeader,
      resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot,
      commitLinkedGridVisualTransaction: params.commitLinkedGridVisualTransaction,
      prepareDeckPlayheadIfNeeded,
      startDeckRenderPlaybackClock: params.startDeckRenderPlaybackClock,
      commitDeckStatesToNative: params.commitDeckStatesToNative
    })
  }

  const handleDeckRawWaveformDragEnd = (deck: DeckKey, payload: DeckWaveformDragEndPayload) => {
    params.touchDeckInteraction(deck)
    if (isDualTransportSyncActive() && handleLinkedRawWaveformDragEnd(deck, payload)) {
      return
    }
    const dragState = deckWaveformDragState[deck]
    const shouldResume = dragState.wasPlaying
    const pausePromise = dragState.pausePromise
    dragState.active = false
    dragState.wasPlaying = false
    dragState.pausePromise = null
    dragState.startAnchorSec = 0
    dragState.token += 1

    const token = dragState.token
    const targetSec = clampDeckTimelineSeconds(deck, Number(payload.anchorSec) || 0)
    queueDeckScrubPreviewRequest(deck, {
      token,
      active: false,
      anchorSec: targetSec,
      playbackRate: 0
    })
    if (!payload?.committed) return

    const initialActiveSyncDecks = resolveActiveBeatSyncDecks(deck)
    const beatSyncDragRelease = startHorizontalBrowseBeatSyncRawWaveformDragRelease({
      deck,
      targetSec,
      token,
      shouldResume,
      pausePromise,
      activeSyncDecks: initialActiveSyncDecks,
      resolveDeckWaveformDragToken: (targetDeck) => deckWaveformDragState[targetDeck].token,
      resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot,
      setLeader: params.nativeTransport.setLeader,
      setSyncEnabled: params.nativeTransport.setSyncEnabled,
      alignToLeader: params.nativeTransport.alignToLeader,
      syncDeckRenderState: params.syncDeckRenderState,
      resumeDeckPlaybackAfterSeek,
      beginLinkedGridVisualTransaction: params.beginLinkedGridVisualTransaction,
      commitLinkedGridVisualTransaction: params.commitLinkedGridVisualTransaction,
      cancelLinkedGridVisualTransaction: params.cancelLinkedGridVisualTransaction
    })
    if (beatSyncDragRelease) {
      void beatSyncDragRelease.catch(() => {})
      return
    }

    if (!initialActiveSyncDecks) {
      params.notifyDeckSeekIntent(deck, targetSec)
    }
    void (async () => {
      let activeSyncDecks = initialActiveSyncDecks
      if (pausePromise) {
        await pausePromise
        if (deckWaveformDragState[deck].token !== token) {
          return
        }
      }
      if (activeSyncDecks) {
        if (activeSyncDecks.leader === deck) {
          await params.nativeTransport.setLeader(activeSyncDecks.follower)
          activeSyncDecks = resolveActiveBeatSyncDecks(deck)
        }
        await params.nativeTransport.alignToLeader(deck, targetSec, false)
      } else {
        await params.nativeTransport.seek(deck, targetSec)
      }
      if (deckWaveformDragState[deck].token !== token) {
        return
      }
      const alignedSnapshot = params.resolveTransportDeckSnapshot(deck)
      const alignedTargetSec = Number.isFinite(Number(alignedSnapshot.currentSec))
        ? Number(alignedSnapshot.currentSec)
        : targetSec
      if (shouldNotifyHorizontalBrowseAlignedDragReleaseSeek(targetSec, alignedTargetSec)) {
        params.notifyDeckSeekIntent(deck, alignedTargetSec)
      }
      if (shouldResume) {
        await prepareDeckStableFrameForAnchor(deck, alignedTargetSec, {
          timeoutMs: DRAG_RELEASE_STABLE_FRAME_WAIT_MS
        })
        if (deckWaveformDragState[deck].token !== token) {
          return
        }
        await resumeDeckPlaybackAfterSeek(deck)
        if (deckWaveformDragState[deck].token !== token) {
          return
        }
      }
      activeSyncDecks = resolveActiveBeatSyncDecks(deck)
      params.syncDeckRenderState({ force: activeSyncDecks ? 'all' : deck })
    })().catch(() => {})
  }

  const seekLinkedDecksToSeconds = (deck: DeckKey, seconds: number, source: string) => {
    const otherDeck = resolveOtherDeck(deck)
    const durationSeconds = params.resolveDeckDurationSeconds(deck)
    const nextSeconds = clampNumber(
      Number(seconds) || 0,
      0,
      durationSeconds > 0 ? durationSeconds : Number.MAX_SAFE_INTEGER
    )
    const currentSeconds = params.resolveDeckCurrentSeconds(deck)
    const otherCurrentSeconds = params.resolveDeckCurrentSeconds(otherDeck)
    const otherDurationSeconds = params.resolveDeckDurationSeconds(otherDeck)
    const sourceVisualPlaybackRate = normalizeLinkedDragVisualPlaybackRate(
      params.resolveTransportDeckSnapshot(deck).playbackRate
    )
    const otherVisualPlaybackRate = normalizeLinkedDragVisualPlaybackRate(
      params.resolveTransportDeckSnapshot(otherDeck).playbackRate
    )
    const deltaScale = otherVisualPlaybackRate / sourceVisualPlaybackRate
    const sourceDeltaSec = nextSeconds - currentSeconds
    const expectedOtherDeltaSec = sourceDeltaSec * deltaScale
    const rawOtherSeconds = otherCurrentSeconds + expectedOtherDeltaSec
    const otherBoundaryExceeded =
      (otherDurationSeconds > 0 && rawOtherSeconds > otherDurationSeconds) || rawOtherSeconds < 0
    const sourceAtEnd = durationSeconds > 0 && nextSeconds >= Math.max(0, durationSeconds - 0.08)
    const otherSeconds = otherBoundaryExceeded
      ? clampNumber(
          rawOtherSeconds,
          0,
          otherDurationSeconds > 0 ? otherDurationSeconds : Number.MAX_SAFE_INTEGER
        )
      : clampDeckTimelineSeconds(otherDeck, rawOtherSeconds)
    const sourceToken = deckSeekActionToken[deck] + 1
    const otherToken = deckSeekActionToken[otherDeck] + 1
    deckSeekActionToken[deck] = sourceToken
    deckSeekActionToken[otherDeck] = otherToken
    const shouldResume = params.resolveDeckPlaying(deck) || params.resolveDeckPlaying(otherDeck)
    deckSeekResumeOnComplete[deck] = shouldResume
    deckSeekResumeOnComplete[otherDeck] = shouldResume

    traceDeckAction(deck, 'seek:intent', {
      source,
      seconds: nextSeconds,
      linked: true
    })
    params.notifyDeckSeekIntent(deck, nextSeconds)
    params.notifyDeckSeekIntent(otherDeck, otherSeconds)

    void (async () => {
      await Promise.all([
        params.nativeTransport.seek(deck, nextSeconds),
        params.nativeTransport.seek(otherDeck, otherSeconds)
      ])
      if (deckSeekActionToken[deck] !== sourceToken) return
      if (deckSeekActionToken[otherDeck] !== otherToken) return

      if (otherBoundaryExceeded) {
        params.deactivateDualTransportSync?.()
        if (shouldResume && !sourceAtEnd) {
          await resumeDeckPlaybackAfterSeek(deck)
        }
        await params.nativeTransport.setPlaying(otherDeck, false)
        deckSeekResumeOnComplete[deck] = false
        deckSeekResumeOnComplete[otherDeck] = false
        params.syncDeckRenderState({ force: 'all' })
        return
      }

      if (shouldResume) {
        await Promise.all([
          prepareDeckPlayheadIfNeeded(deck),
          prepareDeckPlayheadIfNeeded(otherDeck)
        ])
        params.startDeckRenderPlaybackClock(deck, params.resolveDeckRenderCurrentSeconds(deck))
        params.startDeckRenderPlaybackClock(
          otherDeck,
          params.resolveDeckRenderCurrentSeconds(otherDeck)
        )
        await Promise.all([
          params.nativeTransport.setPlaying(deck, true),
          params.nativeTransport.setPlaying(otherDeck, true)
        ])
      }
      if (
        deckSeekActionToken[deck] !== sourceToken ||
        deckSeekActionToken[otherDeck] !== otherToken
      ) {
        return
      }
      deckSeekResumeOnComplete[deck] = false
      deckSeekResumeOnComplete[otherDeck] = false
      params.syncDeckRenderState({ force: 'all' })
    })().catch(() => {
      if (shouldResume && !otherBoundaryExceeded) {
        void params.nativeTransport.setPlaying(deck, true).catch(() => undefined)
        void params.nativeTransport.setPlaying(otherDeck, true).catch(() => undefined)
      }
      deckSeekResumeOnComplete[deck] = false
      deckSeekResumeOnComplete[otherDeck] = false
    })
  }

  const seekDeckToSeconds = (deck: DeckKey, seconds: number, source: string) => {
    params.touchDeckInteraction(deck)
    if (isDualTransportSyncActive()) {
      params.touchDeckInteraction(resolveOtherDeck(deck))
      seekLinkedDecksToSeconds(deck, seconds, source)
      return
    }
    const durationSeconds = params.resolveDeckDurationSeconds(deck)
    const nextSeconds = clampNumber(
      Number(seconds) || 0,
      0,
      durationSeconds > 0 ? durationSeconds : Number.MAX_SAFE_INTEGER
    )
    const token = deckSeekActionToken[deck] + 1
    deckSeekActionToken[deck] = token
    deckSeekResumeOnComplete[deck] =
      deckSeekResumeOnComplete[deck] || params.resolveDeckPlaying(deck)
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const alignToLeader =
      source === 'overview-or-playhead' &&
      params.resolveDeckPlaying(deck) &&
      snapshot.syncEnabled &&
      !snapshot.leader &&
      !params.isDeckLoopActive(deck)

    traceDeckAction(deck, 'seek:intent', {
      source,
      seconds: nextSeconds
    })
    if (!alignToLeader) {
      params.notifyDeckSeekIntent(deck, nextSeconds)
    }
    deckPendingSeekRequest[deck] = { token, seconds: nextSeconds, source, alignToLeader }
    runLatestDeckSeekRequest(deck)
  }

  const handleDeckPlayheadSeek = (deck: DeckKey, seconds: number) =>
    seekDeckToSeconds(deck, seconds, 'overview-or-playhead')

  const handleDeckSectionSeekPlay = createHorizontalBrowseSectionSeekPlayHandler({
    params,
    deckSeekActionToken,
    deckSeekResumeOnComplete,
    clampDeckTimelineSeconds,
    prepareDeckPlayheadIfNeeded,
    traceDeckAction
  })

  const { handleDeckBarJump, handleDeckPhraseJump, handleDeckBeatJump } =
    createHorizontalBrowseBeatJumpHandlers({
      resolveDeckGridBpm: params.resolveDeckGridBpm,
      resolveDeckCurrentSeconds: params.resolveDeckCurrentSeconds,
      resolveDeckDurationSeconds: params.resolveDeckDurationSeconds,
      resolveDeckSong: params.resolveDeckSong,
      seekDeckToSeconds
    })

  const handleDeckSeekPercent = (deck: DeckKey, percent: number) => {
    const safePercent = clampNumber(Number(percent) || 0, 0, 1)
    if (safePercent === 0) {
      seekDeckToSeconds(deck, 0, 'transport')
      return
    }
    const durationSeconds = params.resolveDeckDurationSeconds(deck)
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return
    seekDeckToSeconds(deck, durationSeconds * safePercent, 'transport')
  }

  const handleDeckMemoryCueRecall = async (
    deck: DeckKey,
    cue: Pick<ISongMemoryCue, 'sec' | 'isLoop' | 'loopEndSec' | 'source'>
  ) => {
    params.touchDeckInteraction(deck)
    await params.applyDeckStoredCueDefinition(deck, cue)
    await params.nativeTransport.setPlaying(deck, false)
    const targetSec =
      resolveSongCueTimelineDefinition(cue, params.resolveDeckSong(deck)?.timeBasisOffsetMs)?.sec ??
      Math.max(0, Number(cue?.sec) || 0)
    params.notifyDeckSeekIntent(deck, targetSec)
    await params.nativeTransport.seek(deck, targetSec)
    params.syncDeckRenderState({ force: deck })
  }

  const handleDeckHotCueRecall = async (
    deck: DeckKey,
    cue: Pick<ISongHotCue, 'sec' | 'isLoop' | 'loopEndSec' | 'source'>
  ) => {
    params.touchDeckInteraction(deck)
    const loopRange = await params.applyDeckStoredCueDefinition(deck, cue)
    const targetSec =
      resolveSongCueTimelineDefinition(cue, params.resolveDeckSong(deck)?.timeBasisOffsetMs)?.sec ??
      Math.max(0, Number(cue?.sec) || 0)
    params.notifyDeckSeekIntent(deck, targetSec)
    await params.nativeTransport.seek(deck, targetSec)
    if (params.resolveTransportDeckSnapshot(deck).syncEnabled && !loopRange) {
      await params.commitDeckStatesToNative()
      await params.nativeTransport.beatsync(deck)
    }
    params.startDeckRenderPlaybackClock(deck, params.resolveDeckRenderCurrentSeconds(deck))
    await params.nativeTransport.setPlaying(deck, true)
    params.syncDeckRenderState({ force: deck })
  }

  const handleLinkedDeckPlayPauseToggle = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    const otherDeck = resolveOtherDeck(deck)
    params.touchDeckInteraction(otherDeck)
    const nextPlaying = !params.resolveDeckPlaying(deck)

    if (
      nextPlaying &&
      !params.resolveDeckPlaying(deck) &&
      (deckPendingPlayOnLoad[deck] || deckPendingPlayOnLoad[otherDeck])
    ) {
      return
    }

    void (async () => {
      const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:linked-play-toggle:${deck}`)
      try {
        if (nextPlaying) {
          for (const targetDeck of [deck, otherDeck] as DeckKey[]) {
            const filePath = String(params.resolveDeckSong(targetDeck)?.filePath || '').trim()
            beginHorizontalBrowseDeckAction(targetDeck, 'play-toggle', filePath)
            queueHorizontalBrowseDeckAnalysis(targetDeck, params.resolveDeckSong(targetDeck))
            await params.syncDeckIntoLoopRangeBeforePlay(targetDeck)
          }
          if (!isDeckPlayheadReady(deck) || !isDeckPlayheadReady(otherDeck)) {
            deckPendingPlayOnLoad[deck] = true
            deckPendingPlayOnLoad[otherDeck] = true
            await params.commitDeckStatesToNative()
            await prepareDeckPlayheadIfNeeded(deck)
            await prepareDeckPlayheadIfNeeded(otherDeck)
            await params.nativeTransport.snapshot(performance.now()).catch(() => undefined)
            params.syncDeckRenderState({ force: 'all' })
            if (!isDeckPlayheadReady(deck) || !isDeckPlayheadReady(otherDeck)) {
              return
            }
            deckPendingPlayOnLoad[deck] = false
            deckPendingPlayOnLoad[otherDeck] = false
          }
          await params.commitDeckStatesToNative()
          await ensureDualTransportSync(deck)
          const playbackOrder = resolveLinkedDeckPlaybackOrder(deck)
          params.startDeckRenderPlaybackClock(
            playbackOrder.leader,
            params.resolveDeckRenderCurrentSeconds(playbackOrder.leader)
          )
          params.startDeckRenderPlaybackClock(
            playbackOrder.follower,
            params.resolveDeckRenderCurrentSeconds(playbackOrder.follower)
          )
          await params.nativeTransport.setPlaying(playbackOrder.leader, true)
          await params.nativeTransport.setPlaying(playbackOrder.follower, true)
          params.syncDeckRenderState({ force: 'all' })
          return
        }

        const playbackOrder = resolveLinkedDeckPlaybackOrder(deck)
        params.holdDeckRenderCurrentSeconds(deck, params.resolveDeckRenderCurrentSeconds(deck))
        params.holdDeckRenderCurrentSeconds(
          otherDeck,
          params.resolveDeckRenderCurrentSeconds(otherDeck)
        )
        await params.nativeTransport.setPlaying(playbackOrder.follower, false)
        await params.nativeTransport.setPlaying(playbackOrder.leader, false)
        params.syncDeckRenderState()
      } finally {
        finishTiming()
      }
    })()
  }

  const executeDeckPlayPauseToggle = async (deck: DeckKey, nextPlaying: boolean) => {
    if (!nextPlaying) {
      params.holdDeckRenderCurrentSeconds(deck, params.resolveDeckRenderCurrentSeconds(deck))
    }
    const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
    const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:play-toggle:${deck}`)
    if (nextPlaying) {
      beginHorizontalBrowseDeckAction(deck, 'play-toggle', filePath)
      queueHorizontalBrowseDeckAnalysis(deck, params.resolveDeckSong(deck))
      traceDeckAction(deck, 'play-toggle:start')
    }
    let playStartSecondsOverride: number | null = null
    try {
      if (nextPlaying && !isDeckPlayheadReady(deck)) {
        if (!canDeckExecuteImmediateTransportAction(deck)) {
          return
        }
        deckPendingPlayOnLoad[deck] = true
        await params.commitDeckStatesToNative()
        await prepareDeckPlayheadIfNeeded(deck)
        await params.nativeTransport.snapshot(performance.now()).catch(() => undefined)
        params.syncDeckRenderState({ force: deck })
        if (!isDeckPlayheadReady(deck)) {
          return
        }
        deckPendingPlayOnLoad[deck] = false
      } else {
        deckPendingPlayOnLoad[deck] = false
      }
      if (nextPlaying) {
        await params.syncDeckIntoLoopRangeBeforePlay(deck)
        const shouldBeatSyncBeforePlay =
          params.resolveTransportDeckSnapshot(deck).syncEnabled && !params.isDeckLoopActive(deck)
        if (shouldBeatSyncBeforePlay) {
          await params.commitDeckStatesToNative()
          await params.nativeTransport.beatsync(deck)
          const alignedSnapshot = params.resolveTransportDeckSnapshot(deck)
          const alignedStartSec = Number(
            alignedSnapshot.renderCurrentSec ?? alignedSnapshot.currentSec
          )
          if (Number.isFinite(alignedStartSec)) {
            playStartSecondsOverride = alignedStartSec
          }
        }
      }
      if (nextPlaying) {
        const renderClockStartSec =
          playStartSecondsOverride ?? params.resolveDeckRenderCurrentSeconds(deck)
        params.startDeckRenderPlaybackClock(deck, renderClockStartSec)
      }
      await params.nativeTransport.setPlaying(deck, nextPlaying)
      if (nextPlaying) {
        traceDeckAction(deck, 'play-toggle:done', {
          sincePlayToggleMs: resolveHorizontalBrowseDeckActionElapsedMs(
            deck,
            'play-toggle',
            filePath
          )
        })
      }
      params.syncDeckRenderState(nextPlaying ? { force: deck } : undefined)
    } finally {
      finishTiming()
    }
  }

  const handleDeckPlayPauseToggle = (deck: DeckKey) => {
    if (isDualTransportSyncActive()) {
      handleLinkedDeckPlayPauseToggle(deck)
      return
    }
    params.touchDeckInteraction(deck)
    if (deckPendingPlayOnLoad[deck] && !params.resolveDeckPlaying(deck)) {
      return
    }
    const nextPlaying = !params.resolveDeckPlaying(deck)
    void executeDeckPlayPauseToggle(deck, nextPlaying)
  }

  const pauseAllDeckPlayback = () => {
    deckPendingPlayOnLoad.top = false
    deckPendingPlayOnLoad.bottom = false
    void executeDeckPlayPauseToggle('top', false)
    void executeDeckPlayPauseToggle('bottom', false)
  }

  const maybeResumePendingPlay = (deck: DeckKey, playheadReady: boolean) => {
    if (!deckPendingPlayOnLoad[deck] || !playheadReady) return
    if (isDualTransportSyncActive()) {
      const otherDeck = resolveOtherDeck(deck)
      if (deckPendingPlayOnLoad[otherDeck] && !isDeckPlayheadReady(otherDeck)) return
      deckPendingPlayOnLoad[deck] = false
      deckPendingPlayOnLoad[otherDeck] = false
      void handleDeckPlayPauseToggle(deck)
      return
    }
    deckPendingPlayOnLoad[deck] = false
    void handleDeckPlayPauseToggle(deck)
  }

  const resolveDeckWaveformDragAnchorSec = (deck: DeckKey): number | null => {
    const dragState = deckWaveformDragState[deck]
    return dragState.active ? dragState.anchorSec : null
  }

  const commitDeckWaveformDragCuePlacement = (deck: DeckKey, cueSec: number): boolean => {
    const dragState = deckWaveformDragState[deck]
    if (!dragState.active || dragState.cueCommittedDuringDrag) return false
    dragState.anchorSec = clampDeckTimelineSeconds(deck, cueSec)
    dragState.cueCommittedDuringDrag = true
    return true
  }

  return {
    deckPendingPlayOnLoad,
    deckPendingPlayVisible,
    isDeckWaveformDragging: (deck: DeckKey) => deckWaveformDragState[deck].active,
    resolveDeckWaveformDragAnchorSec,
    commitDeckWaveformDragCuePlacement,
    handleDeckRawWaveformDragStart,
    handleDeckRawWaveformScrubPreview,
    handleDeckRawWaveformDragEnd,
    handleDeckPlayheadSeek,
    handleDeckSectionSeekPlay,
    handleDeckBarJump,
    handleDeckPhraseJump,
    handleDeckBeatJump,
    handleDeckSeekPercent,
    handleDeckMemoryCueRecall,
    handleDeckHotCueRecall,
    handleDeckPlayPauseToggle,
    pauseAllDeckPlayback,
    maybeResumePendingPlay
  }
}
