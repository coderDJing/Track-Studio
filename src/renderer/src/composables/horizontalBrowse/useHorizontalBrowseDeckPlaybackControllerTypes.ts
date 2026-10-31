import type { ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot,
  HorizontalBrowseTransportSnapshot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseLoopRange } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckLoopController'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRenderSync'
import type { CommitHorizontalBrowseDeckStatesToNative } from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedDragReleaseCommit'
import type { HorizontalBrowseBeatSyncDragReleaseVisualTransactionHooks } from '@renderer/composables/horizontalBrowse/horizontalBrowseBeatSyncRawWaveformDragRelease'

type DeckKey = HorizontalBrowseDeckKey

export type HorizontalBrowsePendingPlayViewMode = 'dual' | 'edit' | 'unknown'

export type UseHorizontalBrowseDeckPlaybackControllerParams =
  HorizontalBrowseBeatSyncDragReleaseVisualTransactionHooks & {
    touchDeckInteraction: (deck: DeckKey) => void
    notifyDeckSeekIntent: (deck: DeckKey, seconds: number) => void
    holdDeckRenderCurrentSeconds: (deck: DeckKey, seconds: number) => void
    startDeckRenderPlaybackClock: (deck: DeckKey, seconds: number) => void
    prepareDeckStableFrameForAnchor?: (
      deck: DeckKey,
      seconds: number,
      options?: { timeoutMs?: number }
    ) => Promise<boolean>
    nativeTransport: {
      setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
      setLeader: (
        deck?: DeckKey | null,
        options?: { notifySnapshotListeners?: boolean }
      ) => Promise<unknown>
      preparePlayhead: (deck: DeckKey) => Promise<unknown>
      seek: (deck: DeckKey, currentSec: number) => Promise<unknown>
      setScrubPreview: (
        deck: DeckKey,
        active: boolean,
        currentSec: number,
        rate: number
      ) => Promise<unknown>
      beatsync: (deck: DeckKey) => Promise<unknown>
      alignToLeader: (
        deck: DeckKey,
        targetSec?: number,
        skipGridSnap?: boolean,
        options?: { notifySnapshotListeners?: boolean }
      ) => Promise<unknown>
      setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
      snapshot: (nowMs?: number) => Promise<HorizontalBrowseTransportSnapshot>
    }
    syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
    commitDeckStatesToNative: CommitHorizontalBrowseDeckStatesToNative
    resolveDeckSong: (deck: DeckKey) => ISongInfo | null
    resolveDeckGridBpm: (deck: DeckKey) => number
    resolveDeckDurationSeconds: (deck: DeckKey) => number
    resolveDeckCurrentSeconds: (deck: DeckKey) => number
    resolveDeckRenderCurrentSeconds: (deck: DeckKey, nowMs?: number) => number
    resolveDeckPlaying: (deck: DeckKey) => boolean
    resolveDeckLoaded: (deck: DeckKey) => boolean
    resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
    isDeckLoopActive: (deck: DeckKey) => boolean
    syncDeckIntoLoopRangeBeforePlay: (deck: DeckKey) => Promise<void>
    applyDeckStoredCueDefinition: (
      deck: DeckKey,
      cue: Pick<ISongMemoryCue, 'sec' | 'isLoop' | 'loopEndSec' | 'source'>
    ) => Promise<HorizontalBrowseLoopRange | null>
    resolveDualTransportSyncEnabled?: () => boolean
    ensureDualTransportSync?: (sourceDeck?: DeckKey) => Promise<boolean>
    deactivateDualTransportSync?: () => void
    resolveBrowseViewMode?: () => HorizontalBrowsePendingPlayViewMode
  }
