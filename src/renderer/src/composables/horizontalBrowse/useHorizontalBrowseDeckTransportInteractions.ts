import { onScopeDispose, watch, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot,
  HorizontalBrowseTransportSnapshot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import { useHorizontalBrowseDeckCueController } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckCueController'
import { useHorizontalBrowseDeckLoopController } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckLoopController'
import { useHorizontalBrowseDeckPlaybackController } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckPlaybackController'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRenderSync'
import type {
  HorizontalBrowseDeckStateCommitOptions,
  HorizontalBrowseDeckTransportStateOverride
} from '@renderer/composables/horizontalBrowse/useHorizontalBrowseTransportMutations'
import type { HorizontalBrowseBeatSyncDragReleaseVisualTransactionHooks } from '@renderer/composables/horizontalBrowse/horizontalBrowseBeatSyncRawWaveformDragRelease'
import emitter from '@renderer/utils/mitt'
import {
  EXCLUSIVE_PLAYBACK_PAUSE_OTHERS_EVENT,
  isExclusivePlaybackPauseOthersPayload
} from '@renderer/utils/exclusivePlayback'

type DeckKey = HorizontalBrowseDeckKey
type HorizontalBrowsePendingPlayViewMode = 'dual' | 'edit' | 'unknown'
const PLAYHEAD_READY_NEGATIVE_EPSILON_SEC = 0.0001

type UseHorizontalBrowseDeckTransportInteractionsParams =
  HorizontalBrowseBeatSyncDragReleaseVisualTransactionHooks & {
    touchDeckInteraction: (deck: DeckKey) => void
    notifyDeckSeekIntent: (deck: DeckKey, seconds: number) => void
    holdDeckRenderCurrentSeconds: (deck: DeckKey, seconds: number) => void
    startDeckRenderPlaybackClock: (deck: DeckKey, seconds: number) => void
    prepareDeckStableFrameForAnchor?: (deck: DeckKey, seconds: number) => Promise<boolean>
    nativeTransport: {
      setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
      setLeader: (deck?: DeckKey | null) => Promise<unknown>
      preparePlayhead: (deck: DeckKey) => Promise<unknown>
      seek: (deck: DeckKey, currentSec: number) => Promise<unknown>
      setScrubPreview: (
        deck: DeckKey,
        active: boolean,
        currentSec: number,
        rate: number
      ) => Promise<unknown>
      beatsync: (deck: DeckKey) => Promise<unknown>
      alignToLeader: (deck: DeckKey, targetSec?: number, skipGridSnap?: boolean) => Promise<unknown>
      snapshot: (nowMs?: number) => Promise<HorizontalBrowseTransportSnapshot>
      setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
      toggleLoop: (deck: DeckKey) => Promise<unknown>
      stepLoopBeats: (deck: DeckKey, direction: -1 | 1) => Promise<unknown>
      setLoopFromRange: (
        deck: DeckKey,
        startSec: number,
        endSec: number,
        preserveExactRange?: boolean
      ) => Promise<unknown>
      clearLoop: (deck: DeckKey) => Promise<unknown>
    }
    syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
    commitDeckStatesToNative: (
      overrides?: Partial<Record<DeckKey, HorizontalBrowseDeckTransportStateOverride>>,
      options?: HorizontalBrowseDeckStateCommitOptions
    ) => Promise<unknown>
    resolveDeckSong: (deck: DeckKey) => ISongInfo | null
    resolveDeckGridBpm: (deck: DeckKey) => number
    resolveDeckDurationSeconds: (deck: DeckKey) => number
    resolveDeckCurrentSeconds: (deck: DeckKey) => number
    resolveDeckRenderCurrentSeconds: (deck: DeckKey) => number
    resolveDeckPlaying: (deck: DeckKey) => boolean
    resolveDeckQuantizeEnabled: (deck: DeckKey) => boolean
    resolveDeckLoaded: (deck: DeckKey) => boolean
    resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
    resolveDeckCuePointRef: (deck: DeckKey) => Ref<number>
    resolveDeckCuePlacementSec: (deck: DeckKey) => number
    resolveDualTransportSyncEnabled?: () => boolean
    ensureDualTransportSync?: (sourceDeck?: DeckKey) => Promise<boolean>
    deactivateDualTransportSync?: () => void
    resolveBrowseViewMode?: () => HorizontalBrowsePendingPlayViewMode
  }

export const useHorizontalBrowseDeckTransportInteractions = (
  params: UseHorizontalBrowseDeckTransportInteractionsParams
) => {
  const {
    resolveDeckLoopRange,
    resolveDeckLoopBeatLabel,
    resolveDeckLoopDisabled,
    isDeckLoopActive,
    deactivateDeckLoop,
    toggleDeckLoopState,
    handleDeckLoopStepDown,
    handleDeckLoopStepUp,
    handleDeckLoopPlaybackTick,
    syncDeckIntoLoopRangeBeforePlay,
    buildDeckStoredCueDefinition,
    applyDeckStoredCueDefinition
  } = useHorizontalBrowseDeckLoopController({
    touchDeckInteraction: params.touchDeckInteraction,
    nativeTransport: params.nativeTransport,
    resolveDeckSong: params.resolveDeckSong,
    resolveDeckPlaying: params.resolveDeckPlaying,
    resolveDeckQuantizeEnabled: params.resolveDeckQuantizeEnabled,
    resolveDeckRenderCurrentSeconds: params.resolveDeckRenderCurrentSeconds,
    resolveDeckDurationSeconds: params.resolveDeckDurationSeconds,
    resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot,
    resolveDeckCuePointRef: params.resolveDeckCuePointRef
  })

  const {
    deckPendingPlayOnLoad,
    deckPendingPlayVisible,
    isDeckWaveformDragging,
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
  } = useHorizontalBrowseDeckPlaybackController({
    touchDeckInteraction: params.touchDeckInteraction,
    notifyDeckSeekIntent: params.notifyDeckSeekIntent,
    holdDeckRenderCurrentSeconds: params.holdDeckRenderCurrentSeconds,
    startDeckRenderPlaybackClock: params.startDeckRenderPlaybackClock,
    prepareDeckStableFrameForAnchor: params.prepareDeckStableFrameForAnchor,
    nativeTransport: params.nativeTransport,
    syncDeckRenderState: params.syncDeckRenderState,
    commitLinkedGridVisualTransaction: params.commitLinkedGridVisualTransaction,
    beginLinkedGridVisualTransaction: params.beginLinkedGridVisualTransaction,
    cancelLinkedGridVisualTransaction: params.cancelLinkedGridVisualTransaction,
    commitDeckStatesToNative: params.commitDeckStatesToNative,
    resolveDeckSong: params.resolveDeckSong,
    resolveDeckGridBpm: params.resolveDeckGridBpm,
    resolveDeckDurationSeconds: params.resolveDeckDurationSeconds,
    resolveDeckCurrentSeconds: params.resolveDeckCurrentSeconds,
    resolveDeckRenderCurrentSeconds: params.resolveDeckRenderCurrentSeconds,
    resolveDeckPlaying: params.resolveDeckPlaying,
    resolveDeckLoaded: params.resolveDeckLoaded,
    resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot,
    isDeckLoopActive,
    syncDeckIntoLoopRangeBeforePlay,
    applyDeckStoredCueDefinition,
    resolveDualTransportSyncEnabled: params.resolveDualTransportSyncEnabled,
    ensureDualTransportSync: params.ensureDualTransportSync,
    deactivateDualTransportSync: params.deactivateDualTransportSync,
    resolveBrowseViewMode: params.resolveBrowseViewMode
  })

  const {
    deckPendingCuePreviewOnLoad,
    suppressDeckCueClick,
    resolveDeckCuePreviewRuntimeState,
    handleDeckBackCue,
    handleDeckSetCueFromCurrentPosition,
    stopAllDeckCuePreview,
    handleWindowDeckCuePointerUp,
    handleDeckCuePointerDown,
    handleDeckCueClick,
    handleDeckCueHotkeyDown,
    handleDeckCueHotkeyUp,
    maybeResumePendingCuePreview,
    resetDeckCueInteractionState
  } = useHorizontalBrowseDeckCueController({
    touchDeckInteraction: params.touchDeckInteraction,
    notifyDeckSeekIntent: params.notifyDeckSeekIntent,
    nativeTransport: params.nativeTransport,
    syncDeckRenderState: params.syncDeckRenderState,
    resolveDeckSong: params.resolveDeckSong,
    resolveDeckLoaded: params.resolveDeckLoaded,
    resolveDeckPlaying: params.resolveDeckPlaying,
    resolveDeckCurrentSeconds: params.resolveDeckCurrentSeconds,
    resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot,
    resolveDeckCuePointRef: params.resolveDeckCuePointRef,
    resolveDeckCuePlacementSec: params.resolveDeckCuePlacementSec,
    resolveDeckWaveformDragAnchorSec,
    commitDeckWaveformDragCuePlacement
  })

  const handleExclusivePlaybackPauseOthers = (payload: unknown) => {
    if (!isExclusivePlaybackPauseOthersPayload(payload)) return
    if (payload.owner === 'horizontal-browse') return
    stopAllDeckCuePreview()
    pauseAllDeckPlayback()
  }
  emitter.on(EXCLUSIVE_PLAYBACK_PAUSE_OTHERS_EVENT, handleExclusivePlaybackPauseOthers)
  onScopeDispose(() => {
    emitter.off(EXCLUSIVE_PLAYBACK_PAUSE_OTHERS_EVENT, handleExclusivePlaybackPauseOthers)
  })

  const handleDeckLoopToggle = (deck: DeckKey) => {
    void (async () => {
      const result = await toggleDeckLoopState(deck)
      if (result.shouldStartPlayback) {
        handleDeckPlayPauseToggle(deck)
      }
    })()
  }

  const resolveDeckPlayheadReady = (deck: DeckKey) => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    if (snapshot.playheadLoaded || snapshot.playingAudible) return true
    const currentSec = Number(snapshot.currentSec) || 0
    const renderCurrentSec = Number(snapshot.renderCurrentSec) || 0
    return (
      params.resolveDeckLoaded(deck) &&
      (currentSec < -PLAYHEAD_READY_NEGATIVE_EPSILON_SEC ||
        renderCurrentSec < -PLAYHEAD_READY_NEGATIVE_EPSILON_SEC)
    )
  }

  watch(
    () =>
      [
        resolveDeckPlayheadReady('top'),
        resolveDeckPlayheadReady('bottom'),
        params.resolveDeckLoaded('top'),
        params.resolveDeckLoaded('bottom')
      ] as const,
    ([topPlayheadReady, bottomPlayheadReady, topLoaded, bottomLoaded]) => {
      maybeResumePendingPlay('top', topPlayheadReady)
      maybeResumePendingPlay('bottom', bottomPlayheadReady)
      maybeResumePendingCuePreview('top', topLoaded)
      maybeResumePendingCuePreview('bottom', bottomLoaded)
    }
  )

  watch(
    () =>
      [
        params.resolveDeckSong('top')?.filePath ?? '',
        params.resolveDeckSong('bottom')?.filePath ?? ''
      ] as const,
    ([topFilePath, bottomFilePath], [previousTopFilePath, previousBottomFilePath]) => {
      if (topFilePath !== previousTopFilePath) {
        void deactivateDeckLoop('top')
        resetDeckCueInteractionState('top')
        deckPendingPlayOnLoad.top = false
      }
      if (bottomFilePath !== previousBottomFilePath) {
        void deactivateDeckLoop('bottom')
        resetDeckCueInteractionState('bottom')
        deckPendingPlayOnLoad.bottom = false
      }
    }
  )

  return {
    deckPendingPlayOnLoad,
    deckPendingPlayVisible,
    deckPendingCuePreviewOnLoad,
    suppressDeckCueClick,
    isDeckWaveformDragging,
    resolveDeckWaveformDragAnchorSec,
    resolveDeckCuePreviewRuntimeState,
    resolveDeckLoopRange,
    resolveDeckLoopBeatLabel,
    resolveDeckLoopDisabled,
    isDeckLoopActive,
    handleDeckLoopToggle,
    handleDeckLoopStepDown,
    handleDeckLoopStepUp,
    handleDeckLoopPlaybackTick,
    handleDeckRawWaveformDragStart,
    handleDeckRawWaveformScrubPreview,
    handleDeckRawWaveformDragEnd,
    handleDeckPlayheadSeek,
    handleDeckSectionSeekPlay,
    handleDeckBarJump,
    handleDeckPhraseJump,
    handleDeckBeatJump,
    handleDeckSeekPercent,
    handleDeckBackCue,
    handleDeckSetCueFromCurrentPosition,
    buildDeckStoredCueDefinition,
    handleDeckMemoryCueRecall,
    handleDeckHotCueRecall,
    stopAllDeckCuePreview,
    handleWindowDeckCuePointerUp,
    handleDeckCuePointerDown,
    handleDeckCueClick,
    handleDeckCueHotkeyDown,
    handleDeckCueHotkeyUp,
    handleDeckPlayPauseToggle
  }
}
