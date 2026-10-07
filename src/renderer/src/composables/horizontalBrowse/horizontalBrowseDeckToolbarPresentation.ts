import type { ISongInfo } from 'src/types/globals'
import { buildHorizontalBrowseDeckToolbarState } from '@renderer/composables/horizontalBrowse/horizontalBrowseShellState'
import {
  DUAL_MODE_BPM_INPUT_TITLE,
  EDIT_MODE_BPM_INPUT_TITLE,
  EDIT_MODE_TAP_BPM_TITLE,
  createDefaultDeckToolbarState
} from '@renderer/composables/horizontalBrowse/horizontalBrowseModeShellTypes'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { t } from '@renderer/utils/translate'
import { isEditablePioneerUsbSong } from '@renderer/utils/pioneerUsbEditing'

export const resolveHorizontalBrowseDeckToolbarPresentation = (input: {
  toolbarState: ReturnType<typeof createDefaultDeckToolbarState>
  bpmInputValue: string
  loopBeatLabel: string
  loopActive: boolean
  loopDisabled: boolean
  editMode: boolean
  editSaving: boolean
  editSubMode: string
  song: ISongInfo | null
}) => {
  const toolbarState = buildHorizontalBrowseDeckToolbarState(
    input.toolbarState,
    input.bpmInputValue,
    {
      loopBeatLabel: input.loopBeatLabel,
      loopActive: input.loopActive,
      loopDisabled: input.loopDisabled,
      bpmInputTitle: t(input.editMode ? EDIT_MODE_BPM_INPUT_TITLE : DUAL_MODE_BPM_INPUT_TITLE),
      bpmInputFirst: input.editMode,
      showTapButton: input.editMode,
      tapBpmTitle: input.editMode ? t(EDIT_MODE_TAP_BPM_TITLE) : ''
    }
  )
  const externalSong = isRekordboxExternalPlaybackSource('', input.song)
  const usbSong = isEditablePioneerUsbSong(input.song)
  return {
    ...toolbarState,
    disabled: toolbarState.disabled || input.editSaving,
    bpmInputDisabled:
      usbSong || input.editSaving
        ? true
        : input.editMode
          ? toolbarState.bpmInputDisabled
          : !input.song?.filePath,
    gridControlsDisabled: toolbarState.gridControlsDisabled || input.editSaving,
    showGridControls: input.editMode ? input.editSubMode === 'grid' : !externalSong || usbSong,
    gridShiftOnly: usbSong,
    showMetronome: input.editMode || !externalSong || usbSong
  }
}
