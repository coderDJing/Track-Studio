import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { ISettingConfig } from 'src/types/globals'
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { SettingId, SettingsPageId } from './settingsCatalog'

type SettingDialogRuntimeSetting = ISettingConfig & {
  songListBubbleAlways?: boolean
}

export type SettingDialogRuntimeStore = ReturnType<typeof useRuntimeStore> & {
  setting: SettingDialogRuntimeSetting
}

export type SettingDialogOption = {
  label: string
  value: string
}

export type AudioOutputOption = {
  deviceId: string
  label: string
}

export type SettingPersist = (settingId?: SettingId) => Promise<void>

export type SettingDialogContext = {
  dialogVisible: Ref<boolean>
  runtime: SettingDialogRuntimeStore
  cancel: () => void
  closeImmediately: () => void
  setSetting: SettingPersist
  activePage: Ref<SettingsPageId>
  searchQuery: Ref<string>
  openPage: (page: SettingsPageId) => void
  navigateToSetting: (id: SettingId) => void
  highlightedSettingId: Ref<SettingId | ''>
  recentSettingIds: Ref<SettingId[]>
  isSettingVisible: (id: SettingId) => boolean
  isWindowsPlatform: ComputedRef<boolean>
  isDevOrPrerelease: ComputedRef<boolean>
}

export const settingDialogContextKey: InjectionKey<SettingDialogContext> =
  Symbol('settingDialogContext')
