import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { PlayerGlobalShortcutAction, ISettingConfig } from 'src/types/globals'
import type {
  ComponentPublicInstance,
  ComputedRef,
  InjectionKey,
  Ref,
  WritableComputedRef
} from 'vue'

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

export type SongListBubbleMode = 'overflowOnly' | 'always'

export type SettingDialogContext = {
  dialogVisible: Ref<boolean>
  runtime: SettingDialogRuntimeStore
  cancel: () => void
  setSetting: () => Promise<void>
  songFingerprintListLength: Ref<number>
  lastValidAcoustIdClientKey: Ref<string>
  acoustIdKeyValidating: Ref<boolean>
  acoustIdKeyErrorText: Ref<string>
  isWindowsPlatform: ComputedRef<boolean>
  curatedArtistFavoritesCount: ComputedRef<number>
  isDevOrPrerelease: ComputedRef<boolean>
  songListBubbleMode: WritableComputedRef<SongListBubbleMode>
  audioOutputDevices: Ref<AudioOutputOption[]>
  isEnumeratingAudioOutputs: Ref<boolean>
  audioOutputError: Ref<string | null>
  audioOutputSupported: ComputedRef<boolean>
  themeModeOptions: ComputedRef<SettingDialogOption[]>
  languageOptions: ComputedRef<SettingDialogOption[]>
  waveformModeOptions: ComputedRef<SettingDialogOption[]>
  keyDisplayStyleOptions: ComputedRef<SettingDialogOption[]>
  audioOutputSelectOptions: ComputedRef<SettingDialogOption[]>
  handleAudioOutputChange: () => Promise<void>
  openAcoustIdSite: () => void
  handleAcoustIdKeyBlur: () => Promise<void>
  updateRecentDialogCacheMaxCount: () => Promise<void>
  allFormats: readonly string[]
  audioExt: Ref<Record<string, boolean>>
  extChange: () => Promise<void>
  clearTracksFingerprintLibrary: () => Promise<void>
  clearCuratedArtistFavorites: () => Promise<void>
  openCuratedArtistFavoritesDialog: () => Promise<void>
  globalCallShortcutHandle: () => Promise<void>
  playerGlobalShortcutHandle: (
    action: PlayerGlobalShortcutAction | 'seekPercentModifier'
  ) => Promise<void>
  reSelectLibrary: () => Promise<void>
  chooseRekordboxDesktopTrackStorageDir: () => Promise<void>
  chooseSeratoTrackStorageDir: () => Promise<void>
  hintIcon: string
  fpModeHintRefs: Record<string, HTMLImageElement | null>
  setFpModeHintRef: (value: string, el: HTMLImageElement | null) => void
  bindFpModeHintRef: (value: string) => (el: Element | ComponentPublicInstance | null) => void
  onFingerprintModeChange: () => Promise<void>
  clearCloudFingerprints: () => Promise<void>
  clearLibraryDirtyData: () => Promise<void>
  clearAnalysisRuntime: () => Promise<void>
  ultraModelInfo: Ref<{
    archiveSize: number
    installedSize: number
    alreadyAvailable: boolean
    error: string
    state: {
      status: 'idle' | 'available' | 'downloading' | 'extracting' | 'ready' | 'failed'
      archiveSize: number
    }
  } | null>
  ultraModelStatusText: ComputedRef<string>
  removeUltraModel: () => Promise<void>
  openCloudSyncSettings: () => void
}

export const settingDialogContextKey: InjectionKey<SettingDialogContext> =
  Symbol('settingDialogContext')
