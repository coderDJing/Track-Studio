import { nextTick } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@shared/horizontalBrowseTransport'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRenderSync'
import type { HorizontalBrowseClearLinkedPresentationState } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformPresentationCoordinator'
import type {
  HorizontalBrowseLinkedGridVisualTransactionDeckState,
  HorizontalBrowseLinkedGridVisualTransactionMode
} from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedGridVisualTransaction'
import {
  resolveHorizontalBrowseBeatSyncDecks,
  resolveOtherHorizontalBrowseDeck
} from '@renderer/composables/horizontalBrowse/horizontalBrowseBeatSyncDecks'

type DeckKey = HorizontalBrowseDeckKey

export type HorizontalBrowseDeckTransportStateOverride = Partial<{
  currentSec: number
  lastObservedAtMs: number
  durationSec: number
  playing: boolean
  playbackRate: number
  masterTempoEnabled: boolean
}>

type LocalDeckState = {
  song: ISongInfo | null
  currentSec: number
  lastObservedAtMs: number
  durationSec: number
  playing: boolean
  playbackRate: number
  masterTempoEnabled: boolean
}

export type HorizontalBrowseDeckStateCommitOptions = {
  allowPhaseAlignment?: boolean
  notifySnapshotListeners?: boolean
  syncRenderState?: boolean
}

type UseHorizontalBrowseTransportMutationsParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  nativeTransport: {
    setDeckState: (deck: DeckKey, payload: LocalDeckState) => Promise<unknown>
    setState: (
      payload: {
        top: LocalDeckState
        bottom: LocalDeckState
        allowPhaseAlignment?: boolean
      },
      options?: { notifySnapshotListeners?: boolean }
    ) => Promise<unknown>
    setLeader: (deck?: DeckKey | null) => Promise<unknown>
    setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
    alignToLeader: (deck: DeckKey, targetSec?: number, skipGridSnap?: boolean) => Promise<unknown>
    snapshot: (nowMs?: number) => Promise<unknown>
  }
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
  commitLinkedGridVisualTransaction?: (
    payload: {
      leader: DeckKey
      follower: DeckKey
      mode?: HorizontalBrowseLinkedGridVisualTransactionMode
      deckStates?: Partial<Record<DeckKey, HorizontalBrowseLinkedGridVisualTransactionDeckState>>
    },
    options?: { begin?: boolean }
  ) => Promise<boolean> | boolean
  beginLinkedGridVisualTransaction?: (payload: {
    leader: DeckKey
    follower: DeckKey
    mode?: HorizontalBrowseLinkedGridVisualTransactionMode
  }) => void
  cancelLinkedGridVisualTransaction?: (payload: {
    leader: DeckKey
    follower: DeckKey
    mode?: HorizontalBrowseLinkedGridVisualTransactionMode
  }) => void
  clearLinkedPresentation?: (playbackStates?: HorizontalBrowseClearLinkedPresentationState) => void
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckPlaybackRate: (deck: DeckKey) => number
  resolveDeckMasterTempoEnabled: (deck: DeckKey) => boolean
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
}

export const useHorizontalBrowseTransportMutations = (
  params: UseHorizontalBrowseTransportMutationsParams
) => {
  const buildDeckStateForNative = (
    deck: DeckKey,
    override?: HorizontalBrowseDeckTransportStateOverride
  ): LocalDeckState => ({
    song: params.resolveDeckSong(deck),
    currentSec: override?.currentSec ?? params.resolveDeckCurrentSeconds(deck),
    lastObservedAtMs: override?.lastObservedAtMs ?? performance.now(),
    durationSec: override?.durationSec ?? params.resolveDeckDurationSeconds(deck),
    playing: override?.playing ?? params.resolveDeckPlaying(deck),
    playbackRate: override?.playbackRate ?? params.resolveDeckPlaybackRate(deck),
    masterTempoEnabled: override?.masterTempoEnabled ?? params.resolveDeckMasterTempoEnabled(deck)
  })

  const resolveActiveBeatSyncDecks = (deck: DeckKey) =>
    resolveHorizontalBrowseBeatSyncDecks({
      deck,
      hasDeckSong: (targetDeck) => Boolean(params.resolveDeckSong(targetDeck)),
      resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot
    })

  const buildClearLinkedPresentationPlaybackStates =
    (): HorizontalBrowseClearLinkedPresentationState => {
      const startedAtMs = performance.now()
      const buildDeckState = (deck: DeckKey) => {
        const snapshot = params.resolveTransportDeckSnapshot(deck)
        return {
          currentSec: Number(snapshot.renderCurrentSec ?? snapshot.currentSec) || 0,
          playbackRate: Math.max(0.25, Number(snapshot.playbackRate) || 1),
          playing: snapshot.playing === true,
          startedAtMs
        }
      }
      return {
        top: buildDeckState('top'),
        bottom: buildDeckState('bottom')
      }
    }

  const commitDeckStateToNative = async (
    deck: DeckKey,
    override?: HorizontalBrowseDeckTransportStateOverride
  ) => {
    await params.nativeTransport.setDeckState(deck, buildDeckStateForNative(deck, override))
    params.syncDeckRenderState({ force: deck })
  }

  const commitDeckStatesToNative = async (
    overrides?: Partial<Record<DeckKey, HorizontalBrowseDeckTransportStateOverride>>,
    options?: HorizontalBrowseDeckStateCommitOptions
  ) => {
    await params.nativeTransport.setState(
      {
        top: buildDeckStateForNative('top', overrides?.top),
        bottom: buildDeckStateForNative('bottom', overrides?.bottom),
        allowPhaseAlignment: options?.allowPhaseAlignment !== false
      },
      { notifySnapshotListeners: options?.notifySnapshotListeners }
    )
    if (options?.syncRenderState !== false) {
      params.syncDeckRenderState()
    }
  }

  const toggleDeckMaster = async (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    await commitDeckStatesToNative()
    await params.nativeTransport.setLeader(deck)
    params.syncDeckRenderState({ force: deck })
  }

  const triggerDeckBeatSync = async (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    await params.nativeTransport.snapshot(performance.now())
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    if (snapshot.syncEnabled) {
      await params.nativeTransport.setSyncEnabled(deck, false)
      // 关闭 BeatSync 没有“对齐”要做，必须走 playback handoff 平滑接管当前可见帧；
      // 不能复用开启时的 commitLinkedGridVisualTransaction，否则会先进入 visualPending
      // 挂起画面、并在任一 lane commit 失败时把 owner 砸成 idle 清零 viewport，造成黑一下 + 卡顿。
      params.clearLinkedPresentation?.(buildClearLinkedPresentationPlaybackStates())
      params.syncDeckRenderState({ force: 'all' })
      return
    }
    const deckPlaybackActive =
      params.resolveDeckPlaying(deck) ||
      snapshot.playing === true ||
      snapshot.playingAudible === true
    const otherDeck = resolveOtherHorizontalBrowseDeck(deck)
    const otherSnapshot = params.resolveTransportDeckSnapshot(otherDeck)
    const otherDeckPlaybackActive =
      params.resolveDeckPlaying(otherDeck) ||
      otherSnapshot.playing === true ||
      otherSnapshot.playingAudible === true
    if (!deckPlaybackActive && otherDeckPlaybackActive) {
      await params.nativeTransport.setSyncEnabled(deck, true)
      params.syncDeckRenderState()
      return
    }
    const provisionalSyncDecks = {
      leader: deck === 'top' ? 'bottom' : 'top',
      follower: deck,
      mode: 'beatsync'
    } satisfies {
      leader: DeckKey
      follower: DeckKey
      mode: HorizontalBrowseLinkedGridVisualTransactionMode
    }
    const anchorSec = Number(snapshot.currentSec)
    if (snapshot.leader) {
      await params.nativeTransport.alignToLeader(
        deck,
        Number.isFinite(anchorSec) ? anchorSec : undefined,
        false
      )
      params.syncDeckRenderState()
      return
    }
    params.beginLinkedGridVisualTransaction?.(provisionalSyncDecks)
    let visualTransactionFinished = false
    try {
      const alignRequestedAtMs = performance.now()
      await params.nativeTransport.alignToLeader(
        deck,
        Number.isFinite(anchorSec) ? anchorSec : undefined,
        false
      )
      // native 快照仍对应发起命令时的时刻；IPC 往返后需从该时刻外推从轨播放头。
      params.syncDeckRenderState({ force: deck, snapshotAtMs: alignRequestedAtMs })
      await nextTick()
      const activeSyncDecks = resolveActiveBeatSyncDecks(deck)
      if (activeSyncDecks) {
        await params.commitLinkedGridVisualTransaction?.(
          {
            ...activeSyncDecks,
            mode: 'beatsync'
          },
          { begin: false }
        )
        visualTransactionFinished = true
      }
    } finally {
      if (!visualTransactionFinished) {
        params.cancelLinkedGridVisualTransaction?.(provisionalSyncDecks)
      }
    }
  }

  return {
    buildDeckStateForNative,
    commitDeckStateToNative,
    commitDeckStatesToNative,
    toggleDeckMaster,
    triggerDeckBeatSync
  }
}
