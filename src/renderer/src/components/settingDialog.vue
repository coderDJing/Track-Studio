<script setup lang="ts">
import {
  onUnmounted,
  onMounted,
  provide,
  ref,
  reactive,
  computed,
  watch,
  type ComponentPublicInstance
} from 'vue'
import hintIconAsset from '@renderer/assets/hint.svg?asset'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import pkg from '../../../../package.json'
import utils from '../utils/utils'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
import globalCallShortcutDialog from './globalCallShortcutDialog'
import playerGlobalShortcutDialog from './playerGlobalShortcutDialog'
import dangerConfirmWithInput from './dangerConfirmWithInputDialog'
import curatedArtistLibraryDialog from './curatedArtistLibraryDialog'
import { SUPPORTED_AUDIO_FORMATS } from '../../../shared/audioFormats'
import type { PlayerGlobalShortcutAction } from 'src/types/globals'
import { mapAcoustIdClientError } from '@renderer/utils/acoustid'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { formatAnalysisRuntimeBytes } from '@renderer/utils/analysisRuntimeDownloadUi'
import SettingDialogBody from './settingDialog/SettingDialogBody.vue'
import {
  AUDIO_OUTPUT_FOLLOW_SYSTEM_ID,
  ensurePlayerGlobalShortcuts,
  ensureSettingDialogRuntimeDefaults
} from '@renderer/components/settingDialogRuntimeDefaults'
import {
  settingDialogContextKey,
  type SettingDialogContext,
  type AudioOutputOption,
  type SettingDialogRuntimeStore,
  type SettingDialogOption
} from '@renderer/components/settingDialog/context'
const runtime = useRuntimeStore() as SettingDialogRuntimeStore
const uuid = uuidV4()
const emits = defineEmits(['cancel'])

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const hintIcon = hintIconAsset

// 响应式的指纹库长度数据
const songFingerprintListLength = ref(0)

// 获取指纹库长度
const getSongFingerprintListLength = async () => {
  try {
    const length = await window.electron.ipcRenderer.invoke('getSongFingerprintListLength')
    songFingerprintListLength.value = length
  } catch (error) {
    console.error('获取指纹库长度失败:', error)
    songFingerprintListLength.value = 0
  }
}

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error || '')

ensureSettingDialogRuntimeDefaults(runtime)
const lastValidAcoustIdClientKey = ref(String(runtime.setting.acoustIdClientKey || '').trim())
runtime.setting.acoustIdClientKey = lastValidAcoustIdClientKey.value
const acoustIdKeyValidating = ref(false)
const acoustIdKeyErrorText = ref('')

const isWindowsPlatform = computed(() => runtime.setting.platform === 'win32')
const curatedArtistFavoritesCount = computed(() => runtime.curatedArtistFavorites.length)
const isDevOrPrerelease = computed(() => {
  if (process.env.NODE_ENV === 'development') return true
  const version = String(pkg.version || '')
  return version.includes('-')
})

type DemucsUltraModelManagerState = {
  status: 'idle' | 'available' | 'downloading' | 'extracting' | 'ready' | 'failed'
  archiveSize: number
}

type DemucsUltraModelManagerInfo = {
  archiveSize: number
  installedSize: number
  alreadyAvailable: boolean
  error: string
  state: DemucsUltraModelManagerState
}

const ultraModelInfo = ref<DemucsUltraModelManagerInfo | null>(null)
const ultraModelStatusText = computed(() => {
  if (!ultraModelInfo.value) return t('settings.ultraStemModel.statusChecking')
  if (ultraModelInfo.value.alreadyAvailable) {
    return t('settings.ultraStemModel.statusInstalled', {
      size: formatAnalysisRuntimeBytes(ultraModelInfo.value.installedSize)
    })
  }
  if (ultraModelInfo.value.error) return t('settings.ultraStemModel.statusUnavailable')
  return t('settings.ultraStemModel.statusNotInstalled')
})

const parseUltraModelInfo = (value: unknown): DemucsUltraModelManagerInfo | null => {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const stateRaw = source.state
  if (!stateRaw || typeof stateRaw !== 'object') return null
  const stateSource = stateRaw as Record<string, unknown>
  const status = stateSource.status
  if (
    status !== 'idle' &&
    status !== 'available' &&
    status !== 'downloading' &&
    status !== 'extracting' &&
    status !== 'ready' &&
    status !== 'failed'
  ) {
    return null
  }
  return {
    archiveSize: Math.max(0, Number(source.archiveSize) || 0),
    installedSize: Math.max(0, Number(source.installedSize) || 0),
    alreadyAvailable: source.alreadyAvailable === true,
    error: typeof source.error === 'string' ? source.error.trim() : '',
    state: {
      status,
      archiveSize: Math.max(0, Number(stateSource.archiveSize) || 0)
    }
  }
}

const refreshUltraModelInfo = async () => {
  try {
    const response = await window.electron.ipcRenderer.invoke('demucs-model:get-ultra-status')
    ultraModelInfo.value = parseUltraModelInfo(response)
  } catch {
    ultraModelInfo.value = null
  }
}

const handleUltraModelDownloadState = (_event: unknown, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return
  const source = payload as Record<string, unknown>
  const status = source.status
  if (
    status !== 'idle' &&
    status !== 'available' &&
    status !== 'downloading' &&
    status !== 'extracting' &&
    status !== 'ready' &&
    status !== 'failed'
  ) {
    return
  }
  const archiveSize = Math.max(0, Number(source.archiveSize) || 0)
  ultraModelInfo.value = {
    archiveSize: archiveSize || ultraModelInfo.value?.archiveSize || 0,
    installedSize: status === 'ready' ? archiveSize : ultraModelInfo.value?.installedSize || 0,
    alreadyAvailable: status === 'ready',
    error: typeof source.error === 'string' ? source.error.trim() : '',
    state: { status, archiveSize }
  }
  if (status === 'ready') void refreshUltraModelInfo()
}

// 将布尔设置映射为单选值（与指纹模式类似的布局与交互）
const songListBubbleMode = computed<'overflowOnly' | 'always'>({
  get() {
    return runtime.setting.songListBubbleAlways ? 'always' : 'overflowOnly'
  },
  set(v) {
    runtime.setting.songListBubbleAlways = v === 'always'
  }
})

const audioOutputDevices = ref<AudioOutputOption[]>([])
const isEnumeratingAudioOutputs = ref(false)
const audioOutputError = ref<string | null>(null)
const audioOutputSupported = computed(() => {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.enumerateDevices === 'function'
  )
})
let cleanupAudioDeviceListener: (() => void) | null = null

const themeModeOptions = computed<SettingDialogOption[]>(() => [
  { label: t('theme.system'), value: 'system' },
  { label: t('theme.light'), value: 'light' },
  { label: t('theme.dark'), value: 'dark' }
])

const languageOptions = computed<SettingDialogOption[]>(() => [
  { label: '简体中文', value: 'zhCN' },
  { label: 'English', value: 'enUS' }
])

const translateMaybeKey = (message: unknown) => t(String(message || ''))

const waveformModeOptions = computed<SettingDialogOption[]>(() => [
  { label: t('player.waveformModeHalf'), value: 'half' },
  { label: t('player.waveformModeFull'), value: 'full' }
])

const keyDisplayStyleOptions = computed<SettingDialogOption[]>(() => [
  { label: t('player.keyDisplayStyleClassic'), value: 'Classic' },
  { label: t('player.keyDisplayStyleCamelot'), value: 'Camelot' }
])

const audioOutputSelectOptions = computed(() => {
  const unknownText = t('player.audioOutputDeviceUnknown')
  return [
    { label: t('player.audioOutputFollowSystem'), value: AUDIO_OUTPUT_FOLLOW_SYSTEM_ID },
    ...audioOutputDevices.value.map((device, index) => ({
      label: device.label || `${unknownText} ${index + 1}`,
      value: device.deviceId
    }))
  ]
})

const cancel = () => {
  closeWithAnimation(() => {
    emits('cancel')
  })
}

onMounted(() => {
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
  // 获取指纹库长度
  getSongFingerprintListLength()
  void refreshUltraModelInfo()
  window.electron.ipcRenderer.on('demucs-model-download-state', handleUltraModelDownloadState)
  if (audioOutputSupported.value && navigator.mediaDevices) {
    const handleDeviceChange = () => {
      void refreshAudioOutputDevices()
    }
    if (typeof navigator.mediaDevices.addEventListener === 'function') {
      navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)
      cleanupAudioDeviceListener = () => {
        navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange)
      }
    } else {
      const previousHandler = navigator.mediaDevices.ondevicechange
      navigator.mediaDevices.ondevicechange = handleDeviceChange
      cleanupAudioDeviceListener = () => {
        if (navigator.mediaDevices.ondevicechange === handleDeviceChange) {
          navigator.mediaDevices.ondevicechange = previousHandler || null
        } else if (!navigator.mediaDevices.ondevicechange && previousHandler) {
          navigator.mediaDevices.ondevicechange = previousHandler
        }
      }
    }
    void refreshAudioOutputDevices()
  } else {
    audioOutputDevices.value = []
    audioOutputError.value = t('player.audioOutputNotSupported')
    if (runtime.setting.audioOutputDeviceId) {
      runtime.setting.audioOutputDeviceId = AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
      void setSetting()
    }
  }
})

onUnmounted(() => {
  if (cleanupAudioDeviceListener) {
    cleanupAudioDeviceListener()
    cleanupAudioDeviceListener = null
  }
  utils.delHotkeysScope(uuid)
  window.electron.ipcRenderer.removeListener(
    'demucs-model-download-state',
    handleUltraModelDownloadState
  )
})

const setSetting = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
  await getSongFingerprintListLength()
}

const refreshAudioOutputDevices = async () => {
  audioOutputError.value = null
  if (!audioOutputSupported.value || !navigator.mediaDevices) {
    audioOutputDevices.value = []
    audioOutputError.value = t('player.audioOutputNotSupported')
    if (runtime.setting.audioOutputDeviceId) {
      runtime.setting.audioOutputDeviceId = AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
      await setSetting()
    }
    return
  }
  isEnumeratingAudioOutputs.value = true
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const outputs = devices.filter(
      (device) => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default'
    )
    audioOutputDevices.value = outputs.map((device) => ({
      deviceId: device.deviceId,
      label: device.label
    }))
    const current = runtime.setting.audioOutputDeviceId || AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
    if (current && !audioOutputDevices.value.some((device) => device.deviceId === current)) {
      audioOutputError.value = t('player.audioOutputDeviceUnavailable')
      runtime.setting.audioOutputDeviceId = AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
      await setSetting()
    }
  } catch (error) {
    const reason = getErrorMessage(error)
    audioOutputError.value = t('player.audioOutputRefreshFailed', { reason })
  } finally {
    isEnumeratingAudioOutputs.value = false
  }
}

const openAcoustIdSite = () => {
  window.electron.ipcRenderer.send('openLocalBrowser', 'https://acoustid.org/new-application')
}

const handleAcoustIdKeyBlur = async () => {
  const rawValue = runtime.setting.acoustIdClientKey || ''
  const trimmed = rawValue.trim()
  if (rawValue !== trimmed) {
    runtime.setting.acoustIdClientKey = trimmed
  }
  if (trimmed === lastValidAcoustIdClientKey.value) {
    acoustIdKeyErrorText.value = ''
    if (rawValue !== trimmed) {
      await setSetting()
    }
    return
  }
  if (!trimmed) {
    lastValidAcoustIdClientKey.value = ''
    acoustIdKeyErrorText.value = ''
    runtime.setting.acoustIdClientKey = ''
    await setSetting()
    return
  }
  acoustIdKeyValidating.value = true
  try {
    await window.electron.ipcRenderer.invoke('acoustid:validateClientKey', trimmed)
    lastValidAcoustIdClientKey.value = trimmed
    acoustIdKeyErrorText.value = ''
    runtime.setting.acoustIdClientKey = trimmed
    await setSetting()
  } catch (error: unknown) {
    acoustIdKeyErrorText.value = mapAcoustIdClientError(getErrorMessage(error))
    runtime.setting.acoustIdClientKey = lastValidAcoustIdClientKey.value
  } finally {
    acoustIdKeyValidating.value = false
  }
}

const handleAudioOutputChange = async () => {
  audioOutputError.value = null
  runtime.setting.audioOutputDeviceId =
    runtime.setting.audioOutputDeviceId || AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
  await setSetting()
}

watch(
  () => runtime.setting.language,
  () => {
    if (audioOutputSupported.value) {
      void refreshAudioOutputDevices()
    }
  }
)

// 更新“最近使用歌单缓存数量”并按需截断本地缓存
const updateRecentDialogCacheMaxCount = async () => {
  runtime.setting.recentDialogSelectedSongListMaxCount = Math.max(
    0,
    Math.floor(Number(runtime.setting.recentDialogSelectedSongListMaxCount || 0))
  )
  const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount
  const keys = ['FilterLibrary', 'CuratedLibrary', 'MixtapeLibrary']
  for (const name of keys) {
    const key = 'recentDialogSelectedSongListUUID' + name
    const raw = localStorage.getItem(key)
    if (!raw) continue
    try {
      let arr: string[] = JSON.parse(raw)
      if (Array.isArray(arr) && arr.length > maxCount) {
        arr = arr.slice(0, maxCount)
        localStorage.setItem(key, JSON.stringify(arr))
      }
    } catch (e) {
      // ignore broken cache
    }
  }
  await setSetting()
}

// 所有支持的格式列表
const allFormats = SUPPORTED_AUDIO_FORMATS

type AudioFormatKey = (typeof allFormats)[number]
type AudioExt = Record<AudioFormatKey, boolean>

const audioExt = ref<AudioExt>(
  Object.fromEntries(
    allFormats.map((fmt) => [fmt, runtime.setting.audioExt.includes(`.${fmt}`)])
  ) as AudioExt
)

let audioExtOld = JSON.parse(JSON.stringify(audioExt.value)) as AudioExt
const extChange = async () => {
  if (runtime.isProgressing) {
    audioExt.value = { ...audioExtOld }
    await confirm({
      title: t('common.setting'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  audioExtOld = JSON.parse(JSON.stringify(audioExt.value))
  const audioExtArr = Object.entries(audioExt.value)
    .filter(([, checked]) => checked)
    .map(([fmt]) => `.${fmt}`)
  runtime.setting.audioExt = audioExtArr
  setSetting()
}
const clearTracksFingerprintLibrary = async () => {
  if (runtime.isProgressing) {
    await confirm({
      title: t('common.setting'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  let resConfirm = await confirm({
    title: t('common.warning'),
    content: [t('fingerprints.confirmClear')]
  })
  if (resConfirm === 'confirm') {
    try {
      const result = await window.electron.ipcRenderer.invoke('clearTracksFingerprintLibrary')
      if (result && result.success) {
        await getSongFingerprintListLength()
        await confirm({
          title: t('common.setting'),
          content: [t('fingerprints.clearCompleted')],
          confirmShow: false
        })
      } else {
        await confirm({
          title: t('common.setting'),
          content: [t('fingerprints.clearFailed'), translateMaybeKey(result?.message || '')],
          confirmShow: false
        })
      }
    } catch (error) {
      await confirm({
        title: t('common.setting'),
        content: [t('fingerprints.clearFailed'), translateMaybeKey(getErrorMessage(error))],
        confirmShow: false
      })
    }
  }
}

const clearCuratedArtistFavorites = async () => {
  if (curatedArtistFavoritesCount.value <= 0) {
    await confirm({
      title: t('common.setting'),
      content: [t('settings.curatedArtistTracking.emptyHint')],
      confirmShow: false
    })
    return
  }
  const resConfirm = await confirm({
    title: t('common.warning'),
    content: [
      t('settings.curatedArtistTracking.clearConfirmLine1'),
      t('settings.curatedArtistTracking.clearConfirmLine2')
    ]
  })
  if (resConfirm !== 'confirm') return
  try {
    const result = await window.electron.ipcRenderer.invoke('curatedArtists:clear')
    runtime.curatedArtistFavorites = Array.isArray(result?.items) ? result.items : []
    await confirm({
      title: t('common.success'),
      content: [t('settings.curatedArtistTracking.clearSuccess')],
      confirmShow: false
    })
  } catch (error) {
    await confirm({
      title: t('common.error'),
      content: [t('settings.curatedArtistTracking.clearFailed'), getErrorMessage(error)],
      confirmShow: false
    })
  }
}

const openCuratedArtistFavoritesDialog = async () => {
  const result = await curatedArtistLibraryDialog(
    runtime.curatedArtistFavorites.map((item) => ({ ...item }))
  )
  if (result === 'cancel') return
  try {
    const snapshot = await window.electron.ipcRenderer.invoke('curatedArtists:setAll', result)
    runtime.curatedArtistFavorites = Array.isArray(snapshot?.items) ? snapshot.items : []
  } catch (error) {
    await confirm({
      title: t('common.error'),
      content: [t('settings.curatedArtistTracking.managerSaveFailed'), getErrorMessage(error)],
      confirmShow: false
    })
  }
}

const globalCallShortcutHandle = async () => {
  await globalCallShortcutDialog()
}

const playerGlobalShortcutHandle = async (
  action: PlayerGlobalShortcutAction | 'seekPercentModifier'
) => {
  ensurePlayerGlobalShortcuts(runtime)
  await playerGlobalShortcutDialog(action)
}

const chooseRekordboxDesktopTrackStorageDir = async () => {
  const folderPath = (await window.electron.ipcRenderer.invoke('select-folder', false)) as
    | string[]
    | null
  if (!Array.isArray(folderPath) || !folderPath[0]) return
  runtime.setting.rekordboxDesktopTrackStorageDir = String(folderPath[0] || '').trim()
  await setSetting()
}

const chooseSeratoTrackStorageDir = async () => {
  const folderPath = (await window.electron.ipcRenderer.invoke('select-folder', false)) as
    | string[]
    | null
  if (!Array.isArray(folderPath) || !folderPath[0]) return
  runtime.setting.seratoTrackStorageDir = String(folderPath[0] || '').trim()
  await setSetting()
}

const reSelectLibrary = async () => {
  if (runtime.isProgressing) {
    await confirm({
      title: t('common.setting'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  let res = await confirm({
    title: t('dialog.hint'),
    content: [t('database.locationRetain'), t('database.reselectConfirm')],
    confirmShow: true
  })
  if (res === 'confirm') {
    setSetting()
    emits('cancel')
    await window.electron.ipcRenderer.invoke('reSelectLibrary')
  }
}
// 指纹模式选项的 hint 图标引用
const fpModeHintRefs = reactive<Record<string, HTMLImageElement | null>>({})
function setFpModeHintRef(value: string, el: HTMLImageElement | null) {
  if (el) fpModeHintRefs[value] = el
}

// 切换指纹模式时的提示
const onFingerprintModeChange = async () => {
  await confirm({
    title: t('fingerprints.mode'),
    content: [t('fingerprints.modeIncompatibleWarning')],
    confirmShow: false
  })
  await setSetting()
}

const openCloudSyncSettings = () => {
  cancel()
  window.dispatchEvent(new CustomEvent('openDialogFromChild', { detail: 'cloudSync.settings' }))
}

// 清除云端指纹库
const clearCloudFingerprints = async () => {
  if (runtime.isProgressing) {
    await confirm({
      title: t('common.setting'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  const cfg = await window.electron.ipcRenderer.invoke('cloudSync/config/get')
  const userKey = cfg?.userKey || ''
  if (!userKey) {
    openCloudSyncSettings()
    await confirm({
      title: t('cloudSync.settings'),
      content: [t('cloudSync.needUserKeyBeforeDanger')],
      confirmShow: false
    })
    return
  }
  const danger = await dangerConfirmWithInput({
    title: t('cloudSync.reset.title'),
    description: t('cloudSync.reset.description'),
    confirmKeyword: 'DELETE',
    placeholder: 'DELETE'
  })
  if (danger === 'cancel') return
  try {
    const res = await window.electron.ipcRenderer.invoke('cloudSync/resetUserData', {
      notes: 'reset from client'
    })
    if (res?.success) {
      await confirm({
        title: t('common.success'),
        content: [t('cloudSync.reset.success')],
        confirmShow: false
      })
    } else {
      const msgKey = res?.message || 'common.error'
      await confirm({ title: t('common.error'), content: [t(msgKey)], confirmShow: false })
    }
  } catch (_e) {
    await confirm({
      title: t('common.error'),
      content: [t('cloudSync.errors.cannotConnect')],
      confirmShow: false
    })
  }
}

const clearLibraryDirtyData = async () => {
  if (runtime.isProgressing) {
    await confirm({
      title: t('common.setting'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  const resConfirm = await confirm({
    title: t('common.warning'),
    content: [t('settings.clearDirtyData.confirmLine1'), t('settings.clearDirtyData.confirmLine2')]
  })
  if (resConfirm !== 'confirm') return
  try {
    const result = await window.electron.ipcRenderer.invoke('library:clear-dirty-data')
    const sqliteRows = Number(result?.database?.removedRows || 0)
    const libraryItems = Number(result?.libraryCache?.removedCount || 0)
    const userDataItems = Number(result?.userDataCache?.removedCount || 0)
    await confirm({
      title: t('common.success'),
      content: [
        t('settings.clearDirtyData.successLine1'),
        t('settings.clearDirtyData.successLine2', {
          sqliteRows,
          libraryItems,
          userDataItems
        })
      ],
      confirmShow: false
    })
  } catch (error) {
    await confirm({
      title: t('common.error'),
      content: [t('settings.clearDirtyData.failed'), getErrorMessage(error)],
      confirmShow: false
    })
  }
}

const clearAnalysisRuntime = async () => {
  if (runtime.isProgressing) {
    await confirm({
      title: t('common.setting'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  const resConfirm = await confirm({
    title: t('common.warning'),
    content: [
      t('settings.clearAnalysisRuntime.confirmLine1'),
      t('settings.clearAnalysisRuntime.confirmLine2')
    ],
    textAlign: 'left',
    innerWidth: 620,
    innerHeight: 0
  })
  if (resConfirm !== 'confirm') return
  try {
    runtime.isProgressing = true
    const response = await window.electron.ipcRenderer.invoke('analysis-runtime:clear-local')
    const preferredRaw =
      response?.preferred && typeof response.preferred === 'object'
        ? (response.preferred as Record<string, unknown>)
        : {}
    const stateRaw =
      response?.state && typeof response.state === 'object'
        ? (response.state as Record<string, unknown>)
        : {}
    const clearedRaw =
      response?.cleared && typeof response.cleared === 'object'
        ? (response.cleared as Record<string, unknown>)
        : {}
    const removedInstalledRoot = clearedRaw.removedInstalledRoot === true
    const removedDownloadCache = clearedRaw.removedDownloadCache === true
    const removedBundledRuntimeDirs = Array.isArray(clearedRaw.removedBundledRuntimeDirs)
      ? clearedRaw.removedBundledRuntimeDirs.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0
        )
      : []
    const failedBundledRuntimeDirs = Array.isArray(clearedRaw.failedBundledRuntimeDirs)
      ? clearedRaw.failedBundledRuntimeDirs.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0
        )
      : []
    const nextPreferred = {
      supported: preferredRaw.supported === true,
      downloadable: preferredRaw.downloadable === true,
      alreadyAvailable: preferredRaw.alreadyAvailable === true,
      profile: typeof preferredRaw.profile === 'string' ? preferredRaw.profile.trim() : '',
      runtimeKey: typeof preferredRaw.runtimeKey === 'string' ? preferredRaw.runtimeKey.trim() : '',
      version: typeof preferredRaw.version === 'string' ? preferredRaw.version.trim() : '',
      archiveSize: Math.max(0, Number(preferredRaw.archiveSize) || 0),
      title: typeof preferredRaw.title === 'string' ? preferredRaw.title.trim() : '',
      reason: typeof preferredRaw.reason === 'string' ? preferredRaw.reason.trim() : '',
      manifestUrl:
        typeof preferredRaw.manifestUrl === 'string' ? preferredRaw.manifestUrl.trim() : '',
      releaseTag: typeof preferredRaw.releaseTag === 'string' ? preferredRaw.releaseTag.trim() : '',
      error: typeof preferredRaw.error === 'string' ? preferredRaw.error.trim() : ''
    }
    const nextStateStatus: typeof runtime.analysisRuntime.state.status =
      stateRaw.status === 'available' ||
      stateRaw.status === 'downloading' ||
      stateRaw.status === 'extracting' ||
      stateRaw.status === 'ready' ||
      stateRaw.status === 'failed'
        ? stateRaw.status
        : 'idle'
    const nextState = {
      status: nextStateStatus,
      profile: typeof stateRaw.profile === 'string' ? stateRaw.profile.trim() : '',
      runtimeKey: typeof stateRaw.runtimeKey === 'string' ? stateRaw.runtimeKey.trim() : '',
      version: typeof stateRaw.version === 'string' ? stateRaw.version.trim() : '',
      percent: Math.max(0, Math.min(100, Math.round(Number(stateRaw.percent) || 0))),
      downloadedBytes: Math.max(0, Number(stateRaw.downloadedBytes) || 0),
      totalBytes: Math.max(0, Number(stateRaw.totalBytes) || 0),
      archiveSize: Math.max(0, Number(stateRaw.archiveSize) || 0),
      title: typeof stateRaw.title === 'string' ? stateRaw.title.trim() : '',
      message: typeof stateRaw.message === 'string' ? stateRaw.message.trim() : '',
      error: typeof stateRaw.error === 'string' ? stateRaw.error.trim() : '',
      updatedAt: Math.max(0, Math.floor(Number(stateRaw.updatedAt) || 0))
    }
    runtime.analysisRuntime.preferred = nextPreferred
    runtime.analysisRuntime.state = nextState
    runtime.analysisRuntime.available =
      nextPreferred.alreadyAvailable || nextState.status === 'ready'
    if (response?.success !== true) {
      await confirm({
        title: t('common.warning'),
        content: [
          t('settings.clearAnalysisRuntime.partialFailed'),
          !removedInstalledRoot
            ? t('settings.clearAnalysisRuntime.partialFailedInstalledRoot')
            : '',
          !removedDownloadCache
            ? t('settings.clearAnalysisRuntime.partialFailedDownloadCache')
            : '',
          failedBundledRuntimeDirs.length > 0
            ? t('settings.clearAnalysisRuntime.partialFailedBundledRuntimes', {
                count: failedBundledRuntimeDirs.length
              })
            : '',
          t('settings.clearAnalysisRuntime.partialFailedHint')
        ].filter(Boolean),
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 620,
        innerHeight: 0
      })
      return
    }
    runtime.setting.analysisRuntimeStartupPromptShownVersion = ''
    await setSetting().catch(() => {})
    await confirm({
      title: t('common.success'),
      content: [
        t('settings.clearAnalysisRuntime.successLine1'),
        t('settings.clearAnalysisRuntime.successLine2', {
          count: removedBundledRuntimeDirs.length
        }),
        runtime.analysisRuntime.available
          ? t('settings.clearAnalysisRuntime.successLine3BundledAvailable')
          : t('settings.clearAnalysisRuntime.successLine3NeedsDownload')
      ],
      confirmShow: false,
      textAlign: 'left',
      innerWidth: 620,
      innerHeight: 0
    })
  } catch (error) {
    await confirm({
      title: t('common.error'),
      content: [t('settings.clearAnalysisRuntime.failed'), getErrorMessage(error)],
      confirmShow: false,
      textAlign: 'left',
      innerWidth: 620,
      innerHeight: 0
    })
  } finally {
    runtime.isProgressing = false
  }
}

const removeUltraModel = async () => {
  if (!ultraModelInfo.value?.alreadyAvailable) return
  const resConfirm = await confirm({
    title: t('common.warning'),
    content: [
      t('settings.ultraStemModel.removeConfirmLine1', {
        size: formatAnalysisRuntimeBytes(ultraModelInfo.value.installedSize)
      }),
      t('settings.ultraStemModel.removeConfirmLine2')
    ],
    textAlign: 'left',
    innerWidth: 560,
    innerHeight: 0
  })
  if (resConfirm !== 'confirm') return
  try {
    const result = await window.electron.ipcRenderer.invoke('demucs-model:remove-ultra')
    if (result?.busy === true) {
      await confirm({
        title: t('common.setting'),
        content: [t('settings.ultraStemModel.removeBusy')],
        confirmShow: false
      })
      return
    }
    if (result?.removedModel !== true) {
      await confirm({
        title: t('common.error'),
        content: [t('settings.ultraStemModel.removeFailed')],
        confirmShow: false
      })
      return
    }
    await refreshUltraModelInfo()
  } catch (error) {
    await confirm({
      title: t('common.error'),
      content: [t('settings.ultraStemModel.removeFailed'), getErrorMessage(error)],
      confirmShow: false
    })
  }
}

const bindFpModeHintRef = (value: string) => (el: Element | ComponentPublicInstance | null) => {
  setFpModeHintRef(value, el instanceof HTMLImageElement ? el : null)
}

const settingDialogContext: SettingDialogContext = {
  dialogVisible,
  runtime,
  cancel,
  setSetting,
  songFingerprintListLength,
  lastValidAcoustIdClientKey,
  acoustIdKeyValidating,
  acoustIdKeyErrorText,
  isWindowsPlatform,
  curatedArtistFavoritesCount,
  isDevOrPrerelease,
  songListBubbleMode,
  audioOutputDevices,
  isEnumeratingAudioOutputs,
  audioOutputError,
  audioOutputSupported,
  themeModeOptions,
  languageOptions,
  waveformModeOptions,
  keyDisplayStyleOptions,
  audioOutputSelectOptions,
  handleAudioOutputChange,
  openAcoustIdSite,
  handleAcoustIdKeyBlur,
  updateRecentDialogCacheMaxCount,
  allFormats,
  audioExt,
  extChange,
  clearTracksFingerprintLibrary,
  clearCuratedArtistFavorites,
  openCuratedArtistFavoritesDialog,
  globalCallShortcutHandle,
  playerGlobalShortcutHandle,
  reSelectLibrary,
  chooseRekordboxDesktopTrackStorageDir,
  chooseSeratoTrackStorageDir,
  hintIcon,
  fpModeHintRefs,
  setFpModeHintRef,
  bindFpModeHintRef,
  onFingerprintModeChange,
  clearCloudFingerprints,
  clearLibraryDirtyData,
  clearAnalysisRuntime,
  ultraModelInfo,
  ultraModelStatusText,
  removeUltraModel,
  openCloudSyncSettings
}

provide(settingDialogContextKey, settingDialogContext)
</script>
<template>
  <SettingDialogBody />
</template>
