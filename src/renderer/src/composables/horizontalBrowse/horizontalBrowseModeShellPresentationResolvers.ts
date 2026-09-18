import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseGridToolbarState } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseGridToolbar'
import { formatPreviewBpm } from '@renderer/components/MixtapeBeatAlignDialog.constants'

type DeckKey = HorizontalBrowseDeckKey

export const resolveHorizontalBrowseLightThemeActive = (themeMode: unknown) => {
  if (themeMode === 'light') return true
  if (themeMode === 'dark') return false
  if (typeof document === 'undefined') return false
  return (
    document.documentElement.classList.contains('theme-light') ||
    document.body.classList.contains('theme-light')
  )
}

type ResolveDeckWaveformPlaybackActiveParams = {
  deck: DeckKey
  snapshot: HorizontalBrowseTransportDeckSnapshot
  auditionSuspended?: boolean
  topRenderCurrentSeconds: Ref<number>
  bottomRenderCurrentSeconds: Ref<number>
  negativePlaybackEpsilonSec: number
}

export const resolveHorizontalBrowseDeckWaveformPlaybackActive = ({
  deck,
  snapshot,
  auditionSuspended,
  topRenderCurrentSeconds,
  bottomRenderCurrentSeconds,
  negativePlaybackEpsilonSec
}: ResolveDeckWaveformPlaybackActiveParams) => {
  if (auditionSuspended === true) return false
  if (!snapshot.playing) return false
  if (snapshot.playingAudible || snapshot.playheadLoaded) return true
  const renderCurrentSec =
    deck === 'top' ? topRenderCurrentSeconds.value : bottomRenderCurrentSeconds.value
  return (
    Number(snapshot.renderCurrentSec) < -negativePlaybackEpsilonSec ||
    renderCurrentSec < -negativePlaybackEpsilonSec
  )
}

type ResolveDeckToolbarBpmInputValueParams = {
  deck: DeckKey
  toolbarState: HorizontalBrowseGridToolbarState
  deckTempoInputDirty: Record<DeckKey, boolean>
  editMode: boolean
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckGridBpm: (deck: DeckKey) => number
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
}

export const resolveHorizontalBrowseDeckToolbarBpmInputValue = ({
  deck,
  toolbarState,
  deckTempoInputDirty,
  editMode,
  resolveDeckSong,
  resolveDeckGridBpm,
  resolveTransportDeckSnapshot
}: ResolveDeckToolbarBpmInputValueParams) => {
  if (deckTempoInputDirty[deck]) {
    return toolbarState.bpmInputValue
  }
  if (editMode) {
    if (toolbarState.bpmInputValue) {
      return toolbarState.bpmInputValue
    }
    const songBpm = Number(resolveDeckSong(deck)?.bpm)
    if (Number.isFinite(songBpm) && songBpm > 0) {
      return formatPreviewBpm(songBpm)
    }
    const baseGridBpm = Number(resolveDeckGridBpm(deck))
    if (Number.isFinite(baseGridBpm) && baseGridBpm > 0) {
      return formatPreviewBpm(baseGridBpm)
    }
    return toolbarState.bpmInputValue
  }
  const effectiveBpm = Number(resolveTransportDeckSnapshot(deck).effectiveBpm)
  if (Number.isFinite(effectiveBpm) && effectiveBpm > 0) {
    return formatPreviewBpm(effectiveBpm)
  }
  const baseGridBpm = Number(resolveDeckGridBpm(deck))
  if (Number.isFinite(baseGridBpm) && baseGridBpm > 0) {
    return formatPreviewBpm(baseGridBpm)
  }
  return toolbarState.bpmInputValue
}
