import type { HorizontalBrowseDeckKey } from '@shared/horizontalBrowseTransport'
import type { DeckWaveformDragState } from './horizontalBrowseDeckPlaybackState'
import type { UseHorizontalBrowseDeckPlaybackControllerParams } from './useHorizontalBrowseDeckPlaybackControllerTypes'
import { normalizeLinkedDragVisualPlaybackRate } from './horizontalBrowseLinkedDragTargets'
import { resolveOtherHorizontalBrowseLinkedDeck } from './horizontalBrowseLinkedDeckOrder'

type DeckKey = HorizontalBrowseDeckKey
type PlaybackParams = Pick<
  UseHorizontalBrowseDeckPlaybackControllerParams,
  'resolveDeckRenderCurrentSeconds' | 'holdDeckRenderCurrentSeconds' | 'commitDeckStatesToNative'
>
type LinkedPositions = { top: number; bottom: number; observedAtMs: number }

const captureLinkedPositions = (params: PlaybackParams): LinkedPositions => {
  const observedAtMs = performance.now()
  return {
    top: params.resolveDeckRenderCurrentSeconds('top', observedAtMs),
    bottom: params.resolveDeckRenderCurrentSeconds('bottom', observedAtMs),
    observedAtMs
  }
}

export const pauseHorizontalBrowseLinkedPlayback = async (
  params: PlaybackParams,
  positions = captureLinkedPositions(params)
) => {
  params.holdDeckRenderCurrentSeconds('top', positions.top)
  params.holdDeckRenderCurrentSeconds('bottom', positions.bottom)
  // Both decks stop at the same visible instant. Two setPlaying calls leave a phase gap
  // because the already-paused follower no longer participates in native phase correction.
  await params.commitDeckStatesToNative(
    {
      top: { currentSec: positions.top, lastObservedAtMs: positions.observedAtMs, playing: false },
      bottom: {
        currentSec: positions.bottom,
        lastObservedAtMs: positions.observedAtMs,
        playing: false
      }
    },
    { allowPhaseAlignment: false }
  )
}

export const createHorizontalBrowseWaveformDragStart = (
  params: PlaybackParams &
    Pick<
      UseHorizontalBrowseDeckPlaybackControllerParams,
      | 'touchDeckInteraction'
      | 'resolveTransportDeckSnapshot'
      | 'nativeTransport'
      | 'syncDeckRenderState'
    > & {
      dragStates: Record<DeckKey, DeckWaveformDragState>
      isLinked: () => boolean
      clampTimelineSeconds: (deck: DeckKey, seconds: number) => number
    }
) => {
  const startDeckDrag = (deck: DeckKey, anchorSec?: number) => {
    params.touchDeckInteraction(deck)
    const state = params.dragStates[deck]
    if (state.active) return
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const renderAnchor = Number(snapshot.renderCurrentSec)
    const rawAnchor = Number.isFinite(renderAnchor)
      ? renderAnchor
      : Number(snapshot.currentSec) || 0
    state.active = true
    state.wasPlaying = snapshot.playing
    state.startAnchorSec = params.clampTimelineSeconds(deck, anchorSec ?? rawAnchor)
    state.anchorSec = state.startAnchorSec
    state.visualPlaybackRate = normalizeLinkedDragVisualPlaybackRate(snapshot.playbackRate)
    state.cueCommittedDuringDrag = false
    state.token += 1
  }

  return (deck: DeckKey) => {
    if (params.dragStates[deck].active) return
    if (params.isLinked()) {
      const otherDeck = resolveOtherHorizontalBrowseLinkedDeck(deck)
      const positions = captureLinkedPositions(params)
      startDeckDrag(deck, positions[deck])
      startDeckDrag(otherDeck, positions[otherDeck])
      if (!params.dragStates[deck].wasPlaying && !params.dragStates[otherDeck].wasPlaying) return
      const pausePromise = pauseHorizontalBrowseLinkedPlayback(params, positions).catch((error) => {
        console.error('[horizontal-browse] linked drag pause failed', error)
      })
      params.dragStates[deck].pausePromise = pausePromise
      params.dragStates[otherDeck].pausePromise = pausePromise
      return
    }
    startDeckDrag(deck)
    const state = params.dragStates[deck]
    if (!state.wasPlaying) return
    const token = state.token
    state.pausePromise = params.nativeTransport
      .setPlaying(deck, false)
      .then(() => {
        if (!state.active || state.token !== token) return
        params.syncDeckRenderState({ force: deck })
      })
      .catch((error) => {
        console.error('[horizontal-browse] waveform drag pause failed', error)
      })
  }
}
