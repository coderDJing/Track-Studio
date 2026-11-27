import globalCallShortcutDialog from '@renderer/components/globalCallShortcutDialog'
import playerGlobalShortcutDialog from '@renderer/components/playerGlobalShortcutDialog'
import { ensurePlayerGlobalShortcuts } from '@renderer/components/settingDialogRuntimeDefaults'
import type { PlayerGlobalShortcutAction } from 'src/types/globals'
import type { SettingDialogRuntimeStore, SettingPersist } from './context'
import type { SettingId } from './settingsCatalog'

const settingIdByShortcutAction: Record<
  PlayerGlobalShortcutAction | 'seekPercentModifier',
  SettingId
> = {
  togglePlayPause: 'shortcutTogglePlayPause',
  fastForward: 'shortcutFastForward',
  fastBackward: 'shortcutFastBackward',
  nextSong: 'shortcutNextSong',
  previousSong: 'shortcutPreviousSong',
  seekPercentModifier: 'shortcutSeekPercent'
}

export const useShortcutDialogs = (runtime: SettingDialogRuntimeStore, persist: SettingPersist) => {
  const openGlobalCallShortcut = async () => {
    const result = await globalCallShortcutDialog()
    if (result === 'success') await persist('globalCallShortcut')
  }

  const openPlayerShortcut = async (action: PlayerGlobalShortcutAction | 'seekPercentModifier') => {
    ensurePlayerGlobalShortcuts(runtime)
    const result = await playerGlobalShortcutDialog(action)
    if (result === 'success') await persist(settingIdByShortcutAction[action])
  }

  return {
    globalCallShortcutHandle: openGlobalCallShortcut,
    playerGlobalShortcutHandle: openPlayerShortcut
  }
}
