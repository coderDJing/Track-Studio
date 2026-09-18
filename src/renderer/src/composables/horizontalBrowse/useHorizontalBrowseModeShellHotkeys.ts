import type { ISongInfo } from 'src/types/globals'
import type { Ref } from 'vue'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseDeckMoveTargetLibrary } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckMove'
import { useHorizontalBrowseDeckDelete } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckDelete'
import { useHorizontalBrowseHotkeys } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseHotkeys'
import { useRuntimeStore } from '@renderer/stores/runtime'

type DeckKey = HorizontalBrowseDeckKey
type CrossfaderKeyboardTarget = {
  nudgeCrossfaderByKeyboard: (direction: -1 | 1) => void
  resetCrossfaderByKeyboard: () => void
}

type UseHorizontalBrowseModeShellHotkeysParams = {
  runtime: ReturnType<typeof useRuntimeStore>
  onPlayerInteraction?: () => void
  touchDeckInteraction: (deck: DeckKey) => void
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  ejectDeckSong: (deck: DeckKey) => Promise<unknown>
  openDeckMoveDialog: (deck: DeckKey, target: HorizontalBrowseDeckMoveTargetLibrary) => void
  onTogglePlayPause: (deck: DeckKey) => void
  onCueKeyDown: (deck: DeckKey) => boolean
  onCueKeyUp: (deck: DeckKey) => void
  onJumpBar: (deck: DeckKey, direction: -1 | 1) => void
  onJumpPhrase: (deck: DeckKey, direction: -1 | 1) => void
  onJumpEditBeats: (direction: -1 | 1) => void
  onSeekPercent: (deck: DeckKey, percent: number) => void
  faderPanel: Ref<CrossfaderKeyboardTarget | null>
  onNavigateEditSong: (direction: -1 | 1) => void
  guardSongContextChange: (action: () => unknown | Promise<unknown>) => boolean
}

export const useHorizontalBrowseModeShellHotkeys = (
  params: UseHorizontalBrowseModeShellHotkeysParams
) => {
  const { deleteDeckSong } = useHorizontalBrowseDeckDelete({
    runtime: params.runtime,
    getDeckSong: params.resolveDeckSong,
    ejectDeckSong: params.ejectDeckSong
  })

  const openMoveDialog = (deck: DeckKey, target: HorizontalBrowseDeckMoveTargetLibrary) => {
    params.guardSongContextChange(() => {
      params.touchDeckInteraction(deck)
      params.openDeckMoveDialog(deck, target)
    })
  }

  const deleteSong = (deck: DeckKey) => {
    params.guardSongContextChange(async () => {
      params.touchDeckInteraction(deck)
      await deleteDeckSong(deck)
    })
  }

  useHorizontalBrowseHotkeys({
    runtime: params.runtime,
    onPlayerInteraction: params.onPlayerInteraction,
    onTogglePlayPause: params.onTogglePlayPause,
    onCueKeyDown: params.onCueKeyDown,
    onCueKeyUp: params.onCueKeyUp,
    onJumpBar: params.onJumpBar,
    onJumpPhrase: params.onJumpPhrase,
    onJumpEditBeats: params.onJumpEditBeats,
    onMoveToFilter: (deck) => openMoveDialog(deck, 'FilterLibrary'),
    onMoveToCurated: (deck) => openMoveDialog(deck, 'CuratedLibrary'),
    onDelete: deleteSong,
    onSeekPercent: params.onSeekPercent,
    onNudgeCrossfader: (direction) => params.faderPanel.value?.nudgeCrossfaderByKeyboard(direction),
    onResetCrossfader: () => params.faderPanel.value?.resetCrossfaderByKeyboard(),
    onNavigateEditSong: params.onNavigateEditSong,
    onTogglePlaybackRange: () => {
      params.runtime.setting.enablePlaybackRange =
        params.runtime.setting.enablePlaybackRange !== true
    }
  })
}
