<script setup lang="ts">
import homePage from './pages/homePage.vue'
import titleComponent from './components/titleComponent.vue'
import TitleBarAudioVisualizer from '@renderer/components/TitleBarAudioVisualizer.vue'
import { openNewSongsImport } from '@renderer/utils/newSongsImport'
import { useRuntimeStore } from '@renderer/stores/runtime'
import bottomInfoArea from './pages/modules/bottomInfoArea.vue'
import manualAddSongFingerprintDialog from './components/manualAddSongFingerprintDialog.vue'
import globalSongSearchDialog from './components/globalSongSearchDialog.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import hotkeys from 'hotkeys-js'
import utils from './utils/utils'
import exportSongFingerprintDialog from './components/exportSongFingerprintDialog.vue'
import importSongFingerprintDialog from './components/importSongFingerprintDialog.vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import pkg from '../../../package.json'
import cloudSyncSettingsDialog from './components/cloudSyncSettingsDialog.vue'
import cloudSyncSyncDialog from './components/cloudSyncSyncDialog.vue'
import cloudSyncSummaryDialog from './components/cloudSyncSummaryDialog.vue'
import curatedLibrarySyncDialog from './components/curatedLibrarySyncDialog.vue'
import FileOpInterruptedDialog from './components/fileOpInterruptedDialog.vue'
import emitter from './utils/mitt'
import { replaceExternalPlaylistFromPaths } from '@renderer/utils/externalPlaylist'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import {
  PRODUCT_DISPLAY_NAME,
  GITHUB_REPO_URL,
  GITHUB_PAGES_URL,
  GITHUB_THIRD_PARTY_NOTICES_URL
} from '@shared/productBrand'
import { createClickThroughGuard } from '@renderer/utils/clickThroughGuard'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import HorizontalBrowseModeShell from '@renderer/components/HorizontalBrowseModeShell.vue'
import AnalysisRuntimeDownloadOverlay from '@renderer/components/AnalysisRuntimeDownloadOverlay.vue'
import LibraryMergeDialog from '@renderer/components/LibraryMergeDialog.vue'
import { startLibraryRelocateFromMenu } from '@renderer/utils/libraryRelocateActions'
import { useAnalysisRuntimeDownload } from '@renderer/composables/useAnalysisRuntimeDownload'
import settingDialog from '@renderer/components/settingDialog.vue'
import settingIconAsset from '@renderer/assets/setting.svg?asset'
import WindowVolumeDial from '@renderer/components/WindowVolumeDial.vue'
import HorizontalBrowseMasterMeter from '@renderer/components/HorizontalBrowseMasterMeter.vue'
import { horizontalBrowseMasterMeter } from '@renderer/composables/horizontalBrowse/horizontalBrowseMasterMeterBridge'
import TopToolbarRecordingButton from '@renderer/components/TopToolbarRecordingButton.vue'
import {
  MAIN_WINDOW_VOLUME_CHANGED_EVENT,
  MAIN_WINDOW_VOLUME_SET_EVENT,
  MAIN_WINDOW_VOLUME_STORAGE_KEY,
  clampVolumeValue,
  readWindowVolume,
  writeWindowVolume
} from '@renderer/utils/windowVolume'
import { formatWindowTitle } from '@renderer/utils/windowTitle'
import { useMainWindowPlaybackHandoff } from '@renderer/composables/useMainWindowPlaybackHandoff'
import { useMainWindowBrowseModeState } from '@renderer/composables/useMainWindowBrowseModeState'
import { useDevSongListTrace } from '@renderer/composables/useDevSongListTrace'
import { useCloudSyncEvents } from '@renderer/composables/useCloudSyncEvents'
import { useCuratedLibrarySyncEvents } from '@renderer/composables/useCuratedLibrarySyncEvents'
import { useUserGuide } from '@renderer/composables/useUserGuide'
import UserGuideIdentityOverlay from '@renderer/components/userGuide/UserGuideIdentityOverlay.vue'
import UserGuideCard from '@renderer/components/userGuide/UserGuideCard.vue'
import LibrarySetupOverlay from '@renderer/components/librarySetup/LibrarySetupOverlay.vue'
import type { MainWindowBrowseMode } from '@renderer/utils/mainWindowPlaybackHandoff'
import {
  handleSongsRemovedForGlobalSearchUpdate,
  markGlobalSongSearchDirty,
  type SongsRemovedPayload
} from '@renderer/utils/globalSongSearchEvents'
import {
  createLayoutConfigReadHandler,
  isRuntimeLibraryTree
} from '@renderer/utils/appRuntimeStateGuards'
import { stopWindowAudio } from '@renderer/utils/windowAudioCleanup'
import { pruneLibraryTreeTrackCounts } from '@renderer/utils/libraryTreeSort'

const LIBRARY_SETUP_ALLOWED_DIALOGS = new Set([
  'menu.about',
  'menu.thirdPartyNotices',
  'menu.visitGithub',
  'menu.visitWebsite',
  'menu.checkUpdate',
  'menu.whatsNew'
])
const runtime = useRuntimeStore()
const contextMenuClickThroughGuard = createClickThroughGuard()
const CONTEXT_MENU_SELECTOR = '[data-frkb-context-menu="true"]'
const { stageMainWindowPlaybackHandoff } = useMainWindowPlaybackHandoff(runtime)
const handleLayoutConfigReaded = createLayoutConfigReadHandler(runtime)
useMainWindowBrowseModeState(runtime)
const mainWindowTitleText = computed(() =>
  formatWindowTitle(`${PRODUCT_DISPLAY_NAME} - ${t('app.name')}`)
)
watch(
  mainWindowTitleText,
  (title) => {
    document.title = title
  },
  { immediate: true }
)
window.electron.ipcRenderer.on('layoutConfigReaded', handleLayoutConfigReaded)
const activeDialog = ref('')
const libraryMergeDialogVisible = ref(false)
const curatedLibraryMergeDialogVisible = ref(false)
const openLibraryMergeDialog = () => {
  libraryMergeDialogVisible.value = true
}
const openCuratedLibraryMergeDialog = () => {
  curatedLibraryMergeDialogVisible.value = true
}
const openLibraryRelocateDialog = () => {
  void startLibraryRelocateFromMenu()
}
const fileOpDialogVisible = ref(false)
const fileOpContext = ref('')
const fileOpDone = ref(0)
const fileOpRunning = ref(0)
const fileOpPending = ref(0)
const fileOpBatchId = ref('')
const fileOpSuccessSoFar = ref(0)
const fileOpFailedSoFar = ref(0)
let songSearchWarmupTimer: ReturnType<typeof setTimeout> | null = null
const CTRL_DOUBLE_TAP_MS = 260
const mainWindowTopGapHeight = 41
const horizontalModeShellHeight = 372
const editModeShellHeight = (horizontalModeShellHeight * 3) / 5
const horizontalModeSidePanelWidth = (horizontalModeShellHeight - 1) / 2
const mainWindowBrowseModeMenuOpen = ref(false)
const mainWindowBrowseModeMenuRef = ref<HTMLElement | null>(null)
const mainWindowBrowseModeOptions = [
  { value: 'browser', labelKey: 'modeSwitcher.browser' },
  { value: 'horizontal', labelKey: 'modeSwitcher.horizontal' },
  { value: 'edit', labelKey: 'modeSwitcher.edit' }
] as const
const showHorizontalModeShell = computed(() => runtime.mainWindowBrowseMode !== 'browser')
const horizontalModeShellViewMode = computed(() =>
  runtime.mainWindowBrowseMode === 'edit' ? 'edit' : 'dual'
)
const currentHorizontalModeShellHeight = computed(() =>
  runtime.mainWindowBrowseMode === 'edit' ? editModeShellHeight : horizontalModeShellHeight
)
const mainWindowTopGapStyle = computed(() => ({
  height: `${mainWindowTopGapHeight}px`,
  flex: `0 0 ${mainWindowTopGapHeight}px`,
  backgroundColor: 'var(--bg)',
  borderBottom: '1px solid var(--border)',
  boxSizing: 'border-box' as const,
  position: 'relative' as const,
  overflow: 'visible' as const,
  zIndex: 'var(--z-app-toolbar)'
}))
const horizontalModeShellStyle = computed(() => ({
  '--horizontal-browse-shell-height': `${currentHorizontalModeShellHeight.value}px`,
  '--horizontal-browse-side-panel-width': `${horizontalModeSidePanelWidth}px`,
  height: `${currentHorizontalModeShellHeight.value}px`,
  flex: `0 0 ${currentHorizontalModeShellHeight.value}px`,
  backgroundColor: 'var(--bg)',
  borderBottom: '1px solid var(--border)',
  boxSizing: 'border-box' as const,
  position: 'relative' as const,
  overflow: 'visible' as const,
  zIndex: 10
}))
const topToolbarSettingIconStyle = computed(() => ({
  '--top-toolbar-setting-icon-mask': `url("${settingIconAsset}")`
}))
const mainWindowVolume = ref(readWindowVolume(MAIN_WINDOW_VOLUME_STORAGE_KEY))
const formatCurrentTime = () => {
  const now = new Date()
  const hours = now.getHours().toString().padStart(2, '0')
  const minutes = now.getMinutes().toString().padStart(2, '0')
  return `${hours}:${minutes}`
}
const currentTime = ref(formatCurrentTime())
let currentTimeTimer: ReturnType<typeof setInterval> | null = null
const currentMainWindowBrowseModeLabel = computed(() => {
  const currentMode =
    mainWindowBrowseModeOptions.find((item) => item.value === runtime.mainWindowBrowseMode) ||
    mainWindowBrowseModeOptions[0]
  return t(currentMode.labelKey)
})
const {
  analysisRuntimeDownloadVisible,
  analysisRuntimeDownloadPercent,
  analysisRuntimeDownloadTitle,
  analysisRuntimeDownloadText,
  refreshAnalysisRuntimeStatus,
  promptAnalysisRuntimeDownload,
  ensureAnalysisRuntimeForHorizontalMode,
  handleAnalysisRuntimeDownloadState
} = useAnalysisRuntimeDownload({
  runtime,
  t,
  confirmDialog: confirm,
  appVersion: String(pkg.version || '')
})
const {
  identityVisible: userGuideIdentityVisible,
  activeStep: userGuideActiveStep,
  activeBeat: userGuideActiveBeat,
  beatNumber: userGuideBeatNumber,
  beatCount: userGuideBeatCount,
  hasNextBeat: userGuideHasNextBeat,
  isRekordboxUser: userGuideIsRekordboxUser,
  chooseIdentity: chooseUserGuideIdentity,
  dismissActiveStep: dismissUserGuideStep,
  goNextBeat: goNextUserGuideBeat,
  beginUserGuide,
  waitForIdentity: waitForUserGuideIdentity,
  waitForIdleGuide: waitForUserGuideIdle,
  replayCurrentModeGuide
} = useUserGuide()

type CoreLibraryName = 'FilterLibrary' | 'CuratedLibrary' | 'MixtapeLibrary' | 'RecycleBin'
type MixtapeItemsRemovedPayload = {
  playlistId?: string
  itemIds?: string[]
  removedPaths?: string[]
}
type GlobalSongSearchItem = {
  id: string
  filePath: string
  fileName: string
  title: string
  artist: string
  album: string
  genre: string
  label: string
  duration: string
  keyText: string
  bpm?: number
  container: string
  songListUUID: string
  songListName: string
  songListPath: string
  libraryName: CoreLibraryName
  score: number
}

let ctrlTapAt = 0
let ctrlDown = false
let ctrlComboDirty = false

const focusSongFromGlobalSearch = async (
  payload: GlobalSongSearchItem,
  autoPlay: boolean,
  flashLocate = false
) => {
  if (
    payload.libraryName === 'FilterLibrary' ||
    payload.libraryName === 'CuratedLibrary' ||
    payload.libraryName === 'MixtapeLibrary'
  ) {
    runtime.lastSongListUUIDByLibrary[payload.libraryName] = payload.songListUUID
  }
  runtime.libraryAreaSelected = payload.libraryName
  if (runtime.songsArea.songListUUID !== payload.songListUUID) {
    runtime.songsArea.songListUUID = payload.songListUUID
  }
  emitter.emit('songsArea/focus-song', {
    songListUUID: payload.songListUUID,
    filePath: payload.filePath,
    autoPlay,
    flash: flashLocate
  })
}

const isEditableElement = (target: EventTarget | null) => {
  const element = target as HTMLElement | null
  if (!element) return false
  const tagName = element.tagName?.toLowerCase() || ''
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true
  return Boolean(element.closest('[contenteditable="true"]'))
}

const handleCtrlDoubleTapKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Control') {
    if (event.repeat) return
    ctrlDown = true
    ctrlComboDirty = false
    return
  }
  if (ctrlDown) {
    ctrlComboDirty = true
  }
}

const handleCtrlDoubleTapKeyUp = (event: KeyboardEvent) => {
  if (event.key !== 'Control') return
  if (!ctrlDown) return
  ctrlDown = false
  if (ctrlComboDirty) {
    ctrlTapAt = 0
    ctrlComboDirty = false
    return
  }
  if (runtime.librarySetupActive) {
    ctrlTapAt = 0
    return
  }
  if (isEditableElement(event.target) || runtime.confirmShow) {
    ctrlTapAt = 0
    ctrlComboDirty = false
    return
  }
  const now = Date.now()
  if (now - ctrlTapAt <= CTRL_DOUBLE_TAP_MS) {
    ctrlTapAt = 0
    void openDialog('menu.globalSongSearch')
  } else {
    ctrlTapAt = now
  }
  ctrlComboDirty = false
}

const handleSongsRemovedForGlobalSearch = (payload: SongsRemovedPayload | null) => {
  handleSongsRemovedForGlobalSearchUpdate(runtime, payload)
}
const handleMixtapeItemsRemoved = (_e: unknown, payload: MixtapeItemsRemovedPayload | null) => {
  const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId.trim() : ''
  const itemIds = Array.isArray(payload?.itemIds) ? payload.itemIds : []
  const removedPaths = Array.isArray(payload?.removedPaths) ? payload.removedPaths : []
  if (!playlistId || (!itemIds.length && !removedPaths.length)) return
  emitter.emit('playlistContentChanged', { uuids: [playlistId] })
  emitter.emit('songsRemoved', {
    listUUID: playlistId,
    itemIds,
    paths: removedPaths
  })
}

const handleMetadataBatchUpdatedForGlobalSearch = () => {
  markGlobalSongSearchDirty('metadata-batch-updated')
}

const handleSongMetadataUpdatedForGlobalSearch = () => {
  markGlobalSongSearchDirty('song-metadata-updated')
}

const sendFileOpControl = (action: 'resume' | 'cancel') => {
  fileOpDialogVisible.value = false
  window.electron.ipcRenderer.send('file-op-control', {
    batchId: fileOpBatchId.value,
    action
  })
}

const {
  startDevSongListTrace,
  stopDevSongListTrace,
  handleDevSongListTraceState,
  handleDevSongListTraceExported,
  handleDevSongListTraceError
} = useDevSongListTrace()

let isExitCloudSyncConfirmOpen = false
let isExitProgressingConfirmOpen = false
const requestMainWindowClose = async () => {
  if (runtime.isProgressing === true) {
    if (isExitProgressingConfirmOpen) return
    isExitProgressingConfirmOpen = true
    try {
      const result = await confirm({
        title: t('common.exit'),
        content: [t('import.exitWhileTask'), t('import.exitWhileTaskDetail')],
        confirmText: t('import.exitAndAbandonTask'),
        cancelText: t('common.cancel'),
        innerHeight: 240
      })
      if (result !== 'confirm') return
    } finally {
      isExitProgressingConfirmOpen = false
    }
  }

  if (runtime.cloudSync.syncing) {
    if (isExitCloudSyncConfirmOpen) return
    isExitCloudSyncConfirmOpen = true
    try {
      const result = await confirm({
        title: t('common.exit'),
        content: [t('cloudSync.exitWhileSyncing'), t('cloudSync.exitWhileSyncingDetail')],
        confirmText: t('cloudSync.exitAndCancelSync'),
        cancelText: t('common.cancel'),
        innerHeight: 240
      })
      if (result !== 'confirm') return
    } finally {
      isExitCloudSyncConfirmOpen = false
    }

    window.electron.ipcRenderer.send('cloudSync/cancel')
    runtime.setCloudSyncSyncing(false)
    runtime.setCloudSyncMinimized(false)
    runtime.setCloudSyncProgress('idle', 0, {})
  }

  try {
    const curatedRunning = await window.electron.ipcRenderer.invoke('curatedLibrarySync/isRunning')
    if (curatedRunning) {
      const result = await confirm({
        title: t('common.exit'),
        content: [t('cloudSync.exitWhileSyncing'), t('cloudSync.exitWhileSyncingDetail')],
        confirmText: t('cloudSync.exitAndCancelSync'),
        cancelText: t('common.cancel'),
        innerHeight: 240
      })
      if (result !== 'confirm') return
      await window.electron.ipcRenderer.invoke('curatedLibrarySync/cancel')
    }
  } catch {}

  window.electron.ipcRenderer.send('toggle-close')
}

const openDialog = async (item: string) => {
  if (item === '关于') item = 'menu.about'
  if (item === '第三方许可') item = 'menu.thirdPartyNotices'
  if (runtime.librarySetupActive && !LIBRARY_SETUP_ALLOWED_DIALOGS.has(item)) return
  if (item === '访问 GitHub') item = 'menu.visitGithub'
  if (item === '访问官网') item = 'menu.visitWebsite'
  if (item === '检查更新') item = 'menu.checkUpdate'
  if (item === '更新日志') item = 'menu.whatsNew'
  if (item === '退出') item = 'menu.exit'
  if (item === '云同步设置') item = 'cloudSync.settings'
  if (item === '同步曲目指纹库') item = 'cloudSync.syncFingerprints'
  if (item === '同步指纹库与精选表演者') item = 'cloudSync.syncFingerprints'
  if (item === '同步精选库') item = 'cloudSync.syncCuratedLibrary'
  if (item === '手动添加曲目指纹') item = 'fingerprints.manualAdd'
  if (item === '导出曲目指纹库文件') item = 'fingerprints.exportDatabase'
  if (item === '导出指纹库文件') item = 'fingerprints.exportDatabase'
  if (item === '导入曲目指纹库文件') item = 'fingerprints.importDatabase'
  if (item === '导入指纹库文件') item = 'fingerprints.importDatabase'
  if (item === '全局搜歌') item = 'menu.globalSongSearch'

  if (item === 'menu.fullBrowseMode') {
    await stageMainWindowPlaybackHandoff('browser')
    runtime.mainWindowBrowseMode = 'browser'
    return
  }
  if (item === 'menu.horizontalBrowseMode') {
    const canEnterHorizontalMode = await ensureAnalysisRuntimeForHorizontalMode()
    if (!canEnterHorizontalMode) return
    await stageMainWindowPlaybackHandoff('horizontal')
    syncPlayingDataToTopDeck()
    runtime.mainWindowBrowseMode = 'horizontal'
    return
  }
  if (item === 'menu.editBrowseMode') {
    const canEnterHorizontalMode = await ensureAnalysisRuntimeForHorizontalMode()
    if (!canEnterHorizontalMode) return
    await stageMainWindowPlaybackHandoff('edit')
    syncPlayingDataToTopDeck()
    runtime.mainWindowBrowseMode = 'edit'
    return
  }
  if (item === 'menu.downloadAnalysisRuntime') {
    await promptAnalysisRuntimeDownload('help')
    return
  }
  if (item === 'menu.about') {
    const version = String(pkg.version || '')
    const isPrerelease = version.includes('-')
    const content: string[] = []
    content.push(t('update.currentVersion') + ' ' + version)
    if (isPrerelease) content.push(t('about.prereleaseHint'))
    content.push(t('about.author'))
    content.push(t('about.contact', { email: 'jinlingwuyanzu@qq.com' }))
    content.push(t('about.thirdPartyNoticesHint'))
    await confirm({
      title: t('menu.about'),
      content,
      confirmShow: false,
      canCopyText: true,
      innerHeight: 320
    })
  }
  if (item === 'menu.thirdPartyNotices') {
    window.electron.ipcRenderer.send('openLocalBrowser', GITHUB_THIRD_PARTY_NOTICES_URL)
    return
  }
  if (item === 'menu.visitGithub') {
    window.electron.ipcRenderer.send('openLocalBrowser', GITHUB_REPO_URL)
  }
  if (item === 'menu.visitWebsite') {
    window.electron.ipcRenderer.send('openLocalBrowser', GITHUB_PAGES_URL)
  }
  if (item === 'menu.checkUpdate') {
    window.electron.ipcRenderer.send('checkForUpdates')
    return
  }
  if (item === 'menu.whatsNew') {
    window.electron.ipcRenderer.send('showWhatsNew')
    return
  }
  if (item === 'menu.userGuide') {
    replayCurrentModeGuide()
    return
  }
  if (item === 'menu.globalSongSearch') {
    activeDialog.value = 'search.globalSong'
    await nextTick()
    return
  }
  if (item === 'menu.formatConversionTool') {
    const { default: openConvertDialog } = await import('@renderer/components/audioConvertDialog')
    const dialogResult = await openConvertDialog({ standaloneMode: true })
    if (
      dialogResult &&
      dialogResult !== 'cancel' &&
      'files' in dialogResult &&
      'options' in dialogResult
    ) {
      try {
        await window.electron.ipcRenderer.invoke('audio:convert:start', {
          files: dialogResult.files,
          options: dialogResult.options
        })
      } catch {}
    }
    return
  }
  if (item === 'menu.startSongListTrace') {
    await startDevSongListTrace()
    return
  }
  if (item === 'menu.stopSongListTrace') {
    await stopDevSongListTrace()
    return
  }
  if (item === 'menu.exit') {
    await requestMainWindowClose()
    return
  }
  if (item === 'cloudSync.settings') {
    activeDialog.value = item
    return
  }
  if (item === 'cloudSync.syncFingerprints') {
    activeDialog.value = item
    return
  }
  if (item === 'cloudSync.syncCuratedLibrary') {
    activeDialog.value = item
    return
  }
  activeDialog.value = item
}

const handleGlobalSongSearchLocate = async (item: GlobalSongSearchItem) => {
  activeDialog.value = ''
  await focusSongFromGlobalSearch(item, false, true)
}

const handleGlobalSongSearchPlay = async (item: GlobalSongSearchItem) => {
  activeDialog.value = ''
  await focusSongFromGlobalSearch(item, true)
}

const syncPlayingDataToTopDeck = () => {
  const { playingSong, playingSongListUUID, playingSongListData } = runtime.playingData
  if (playingSong) {
    runtime.horizontalBrowseDecks.topSong = { ...playingSong }
  }
  if (playingSongListUUID) {
    runtime.horizontalBrowseDecks.topSongListUUID = playingSongListUUID
  }
  if (playingSongListData.length > 0) {
    runtime.horizontalBrowseDecks.topSongListData = playingSongListData.map((song) => ({ ...song }))
  }
}

const closeMainWindowBrowseModeMenu = () => {
  mainWindowBrowseModeMenuOpen.value = false
}

const toggleMainWindowBrowseModeMenu = () => {
  if (runtime.librarySetupActive) return
  mainWindowBrowseModeMenuOpen.value = !mainWindowBrowseModeMenuOpen.value
}

const resolveMainWindowBrowseModeMenuKey = (mode: MainWindowBrowseMode) => {
  if (mode === 'browser') return 'menu.fullBrowseMode'
  if (mode === 'edit') return 'menu.editBrowseMode'
  return 'menu.horizontalBrowseMode'
}

const selectMainWindowBrowseMode = async (mode: MainWindowBrowseMode) => {
  closeMainWindowBrowseModeMenu()
  if (runtime.mainWindowBrowseMode === mode) return
  await openDialog(resolveMainWindowBrowseModeMenuKey(mode))
}

const openSettingsDialog = () => {
  if (runtime.librarySetupActive) return
  activeDialog.value = 'settings'
}

const handleMainWindowVolumeChange = (value: number) => {
  const nextVolume = writeWindowVolume(MAIN_WINDOW_VOLUME_STORAGE_KEY, value)
  mainWindowVolume.value = nextVolume
  emitter.emit(MAIN_WINDOW_VOLUME_SET_EVENT, nextVolume)
}

const handleMainWindowVolumeSync = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  mainWindowVolume.value = clampVolumeValue(value)
}

const documentHandleClick = () => {
  runtime.activeMenuUUID = ''
}
document.addEventListener('click', documentHandleClick)
document.addEventListener('contextmenu', documentHandleClick)

const handleMainWindowBrowseModeMenuPointerDown = (event: PointerEvent) => {
  if (!mainWindowBrowseModeMenuOpen.value) return
  const target = event.target as Node | null
  if (
    !mainWindowBrowseModeMenuRef.value ||
    (target && mainWindowBrowseModeMenuRef.value.contains(target))
  )
    return
  closeMainWindowBrowseModeMenu()
}

const hasOpenContextMenu = () => {
  return !!document.querySelector(CONTEXT_MENU_SELECTOR)
}

const isInsideContextMenu = (target: EventTarget | null) => {
  const element = target as Element | null
  if (!element) return false
  return !!element.closest(CONTEXT_MENU_SELECTOR)
}

const handleContextMenuPointerDownCapture = (event: PointerEvent) => {
  if (event.button !== 0) return
  if (!hasOpenContextMenu()) return
  if (isInsideContextMenu(event.target)) return
  contextMenuClickThroughGuard.markFromPointer(event)
  event.preventDefault()
  event.stopPropagation()
}

const handleContextMenuClickCapture = (event: MouseEvent) => {
  contextMenuClickThroughGuard.suppressClickIfNeeded(event)
}

const handleBeforeUnload = () => {
  stopWindowAudio()
}

const getLibrary = async () => {
  if (runtime.librarySetupActive) return
  runtime.libraryTreeLoading = true
  try {
    runtime.libraryTree = await window.electron.ipcRenderer.invoke('getLibrary')
    runtime.oldLibraryTree = JSON.parse(JSON.stringify(runtime.libraryTree))
    pruneLibraryTreeTrackCounts(runtime.libraryTree)
  } finally {
    runtime.libraryTreeLoading = false
  }
}
getLibrary()

// IPC 监听器处理函数
const handleOpenDialogFromTray = async (_e: unknown, key: string) => {
  await openDialog(key)
}
const handleOpenGlobalSongSearch = async () => {
  if (runtime.librarySetupActive) return
  await openDialog('menu.globalSongSearch')
}
const handleTrayAction = async (_e: unknown, action: string) => {
  if (runtime.librarySetupActive && action !== 'exit') return
  if (action === 'import-new-filter') {
    await openNewSongsImport('FilterLibrary')
    return
  }
  if (action === 'import-new-curated') {
    await openNewSongsImport('CuratedLibrary')
    return
  }
  if (action === 'exit') {
    await requestMainWindowClose()
    return
  }
}
const handleExternalOpenImported = async (_e: unknown, payload: { paths?: string[] }) => {
  if (runtime.librarySetupActive) return
  try {
    const rawPaths = Array.isArray(payload?.paths) ? payload.paths : []
    const songs = await replaceExternalPlaylistFromPaths(rawPaths)
    if (songs.length) {
      if (
        runtime.mainWindowBrowseMode === 'horizontal' ||
        runtime.mainWindowBrowseMode === 'edit'
      ) {
        runtime.playingData.playingSongListUUID = EXTERNAL_PLAYLIST_UUID
        runtime.playingData.playingSongListData = songs
        emitter.emit('horizontalBrowse/load-song', { deck: 'top', song: songs[0] })
      } else {
        emitter.emit('external-open/play', { songs, startIndex: 0 })
      }
    }
    markGlobalSongSearchDirty('external-open-imported')
  } catch (error) {
    console.error('[external-open] failed to prepare playlist', error)
  }
}
const handleFileOpInterrupted = async (
  _e: unknown,
  payload: {
    context?: string
    successSoFar?: number
    failedSoFar?: number
    running?: number
    pending?: number
    batchId?: string
  }
) => {
  try {
    fileOpDialogVisible.value = true
    fileOpContext.value = payload?.context || ''
    fileOpSuccessSoFar.value = payload?.successSoFar || 0
    fileOpFailedSoFar.value = payload?.failedSoFar || 0
    fileOpDone.value = fileOpSuccessSoFar.value + fileOpFailedSoFar.value
    fileOpRunning.value = payload?.running || 0
    fileOpPending.value = payload?.pending || 0
    fileOpBatchId.value = payload?.batchId || ''
  } catch (_err) {}
}
const handleLibraryTreeUpdated = async (_e: unknown, tree: unknown) => {
  try {
    if (isRuntimeLibraryTree(tree)) {
      runtime.libraryTree = tree
      runtime.oldLibraryTree = JSON.parse(JSON.stringify(tree))
      pruneLibraryTreeTrackCounts(tree)
      markGlobalSongSearchDirty('library-tree-updated')
      return
    }
    await getLibrary()
    markGlobalSongSearchDirty('library-tree-reloaded')
  } catch (_err) {}
}
const handleOpenDialogFromChild = (e: Event) => {
  const detail = (e as CustomEvent<string>).detail
  if (typeof detail === 'string') {
    openDialog(detail)
  }
}
const {
  handleCloudSyncState,
  handleCloudSyncProgress,
  handleCloudSyncSummary,
  handleCloudSyncNotice,
  handleCloudSyncError
} = useCloudSyncEvents({ runtime, activeDialog })
const {
  handleCuratedLibrarySyncNotice,
  handleCuratedLibrarySyncNeedsJoin,
  handleCuratedLibraryPlaylistsChanged,
  consumePendingCuratedLibraryJoin
} = useCuratedLibrarySyncEvents()

const handleMainWindowBlur = async () => {
  runtime.activeMenuUUID = ''
  closeMainWindowBrowseModeMenu()
}
const handleAnalysisRuntimeDownloadStateWrapper = (_e: unknown, payload: unknown) => {
  void handleAnalysisRuntimeDownloadState(payload)
}

onMounted(() => {
  currentTimeTimer = setInterval(() => {
    currentTime.value = formatCurrentTime()
  }, 1000)
  songSearchWarmupTimer = setTimeout(() => {
    songSearchWarmupTimer = null
    if (runtime.librarySetupActive) return
    void window.electron.ipcRenderer.invoke('song-search:warmup').catch(() => {})
  }, 5000)
  emitter.on(MAIN_WINDOW_VOLUME_CHANGED_EVENT, handleMainWindowVolumeSync)
  hotkeys('F1', 'windowGlobal', () => {
    openDialog('menu.visitGithub')
  })

  const handleAltF4 = async () => {
    await requestMainWindowClose()
  }
  hotkeys('command+q', () => {
    handleAltF4()
    return false
  })
  hotkeys('alt+F4', () => {
    handleAltF4()
    return false
  })
  hotkeys('esc', () => {
    runtime.activeMenuUUID = ''
    closeMainWindowBrowseModeMenu()
  })
  const triggerRename = () => {
    try {
      if (runtime.selectSongListDialogShow) {
        const uuid = runtime.dialogSelectedSongListUUID
        if (uuid) emitter.emit('dialog/trigger-rename', uuid)
        return
      }
      const uuid = runtime.selectedPlaylistIds[0]
      if (uuid) emitter.emit('libraryArea/trigger-rename', uuid)
    } catch {}
  }
  if (runtime.platform === 'Mac') {
    hotkeys('enter', 'windowGlobal', (e) => {
      e.preventDefault()
      triggerRename()
      return false
    })
  } else {
    hotkeys('f2', 'windowGlobal', (e) => {
      e.preventDefault()
      triggerRename()
      return false
    })
  }
  utils.setHotkeysScpoe('windowGlobal')
  window.electron.ipcRenderer.on('openDialogFromTray', handleOpenDialogFromTray)
  window.electron.ipcRenderer.on(
    'analysis-runtime-download-state',
    handleAnalysisRuntimeDownloadStateWrapper
  )
  window.electron.ipcRenderer.on('open-global-song-search', handleOpenGlobalSongSearch)
  window.electron.ipcRenderer.on('tray-action', handleTrayAction)
  window.electron.ipcRenderer.on('external-open/imported', handleExternalOpenImported)
  if (!runtime.librarySetupActive) {
    window.electron.ipcRenderer.send('external-open:renderer-ready')
  }
  window.electron.ipcRenderer.on('file-op-interrupted', handleFileOpInterrupted)
  window.electron.ipcRenderer.on('library-tree-updated', handleLibraryTreeUpdated)
  window.electron.ipcRenderer.on('library-merge:open-dialog', openLibraryMergeDialog)
  window.electron.ipcRenderer.on('curated-library-merge:open-dialog', openCuratedLibraryMergeDialog)
  window.electron.ipcRenderer.on('library-relocate:open-dialog', openLibraryRelocateDialog)

  window.addEventListener('pointerdown', handleContextMenuPointerDownCapture, true)
  window.addEventListener('pointerdown', handleMainWindowBrowseModeMenuPointerDown, true)
  window.addEventListener('click', handleContextMenuClickCapture, true)
  window.addEventListener('keydown', handleCtrlDoubleTapKeyDown, true)
  window.addEventListener('keyup', handleCtrlDoubleTapKeyUp, true)
  window.addEventListener('beforeunload', handleBeforeUnload)

  window.electron.ipcRenderer.on('mixtape-items-removed', handleMixtapeItemsRemoved)
  window.electron.ipcRenderer.on('dev-songlist-trace:state', handleDevSongListTraceState)
  window.electron.ipcRenderer.on('dev-songlist-trace:exported', handleDevSongListTraceExported)
  window.electron.ipcRenderer.on('dev-songlist-trace:error', handleDevSongListTraceError)
  emitter.on('songsRemoved', handleSongsRemovedForGlobalSearch)
  emitter.on('metadataBatchUpdated', handleMetadataBatchUpdatedForGlobalSearch)
  emitter.on('songMetadataUpdated', handleSongMetadataUpdatedForGlobalSearch)
  window.addEventListener('openDialogFromChild', handleOpenDialogFromChild)
  window.electron.ipcRenderer.on('cloudSync/state', handleCloudSyncState)
  window.electron.ipcRenderer.on('cloudSync/progress', handleCloudSyncProgress)
  window.electron.ipcRenderer.on('cloudSync/summary', handleCloudSyncSummary)
  window.electron.ipcRenderer.on('cloudSync/notice', handleCloudSyncNotice)
  window.electron.ipcRenderer.on('cloudSync/error', handleCloudSyncError)
  window.electron.ipcRenderer.on('curatedLibrarySync/notice', handleCuratedLibrarySyncNotice)
  window.electron.ipcRenderer.on('curatedLibrarySync/needsJoin', handleCuratedLibrarySyncNeedsJoin)
  window.electron.ipcRenderer.on(
    'curatedLibrarySync/playlistsChanged',
    handleCuratedLibraryPlaylistsChanged
  )
  void consumePendingCuratedLibraryJoin()
  window.electron.ipcRenderer.on('mainWindowBlur', handleMainWindowBlur)
  void (async () => {
    if (runtime.librarySetupActive) return
    await waitForUserGuideIdentity()
    beginUserGuide()
    await waitForUserGuideIdle()
    await refreshAnalysisRuntimeStatus()
    await promptAnalysisRuntimeDownload('startup')
  })()
})

onBeforeUnmount(() => {
  if (currentTimeTimer) {
    clearInterval(currentTimeTimer)
    currentTimeTimer = null
  }
  if (songSearchWarmupTimer) {
    clearTimeout(songSearchWarmupTimer)
    songSearchWarmupTimer = null
  }
  emitter.off(MAIN_WINDOW_VOLUME_CHANGED_EVENT, handleMainWindowVolumeSync)
  window.removeEventListener('pointerdown', handleContextMenuPointerDownCapture, true)
  window.removeEventListener('pointerdown', handleMainWindowBrowseModeMenuPointerDown, true)
  window.removeEventListener('click', handleContextMenuClickCapture, true)
  window.removeEventListener('keydown', handleCtrlDoubleTapKeyDown, true)
  window.removeEventListener('keyup', handleCtrlDoubleTapKeyUp, true)
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.electron.ipcRenderer.removeListener('openDialogFromTray', handleOpenDialogFromTray)
  window.electron.ipcRenderer.removeListener('open-global-song-search', handleOpenGlobalSongSearch)
  window.electron.ipcRenderer.removeListener('tray-action', handleTrayAction)
  window.electron.ipcRenderer.removeListener('external-open/imported', handleExternalOpenImported)
  window.electron.ipcRenderer.removeListener('file-op-interrupted', handleFileOpInterrupted)
  window.electron.ipcRenderer.removeListener('library-tree-updated', handleLibraryTreeUpdated)
  window.electron.ipcRenderer.removeListener('library-merge:open-dialog', openLibraryMergeDialog)
  window.electron.ipcRenderer.removeListener(
    'curated-library-merge:open-dialog',
    openCuratedLibraryMergeDialog
  )
  window.electron.ipcRenderer.removeListener(
    'library-relocate:open-dialog',
    openLibraryRelocateDialog
  )
  window.removeEventListener('openDialogFromChild', handleOpenDialogFromChild)
  window.electron.ipcRenderer.removeListener('cloudSync/state', handleCloudSyncState)
  window.electron.ipcRenderer.removeListener('cloudSync/progress', handleCloudSyncProgress)
  window.electron.ipcRenderer.removeListener('cloudSync/summary', handleCloudSyncSummary)
  window.electron.ipcRenderer.removeListener('cloudSync/notice', handleCloudSyncNotice)
  window.electron.ipcRenderer.removeListener('cloudSync/error', handleCloudSyncError)
  window.electron.ipcRenderer.removeListener(
    'curatedLibrarySync/notice',
    handleCuratedLibrarySyncNotice
  )
  window.electron.ipcRenderer.removeListener(
    'curatedLibrarySync/needsJoin',
    handleCuratedLibrarySyncNeedsJoin
  )
  window.electron.ipcRenderer.removeListener(
    'curatedLibrarySync/playlistsChanged',
    handleCuratedLibraryPlaylistsChanged
  )
  window.electron.ipcRenderer.removeListener('mainWindowBlur', handleMainWindowBlur)
  window.electron.ipcRenderer.removeListener('layoutConfigReaded', handleLayoutConfigReaded)
  window.electron.ipcRenderer.removeListener('mixtape-items-removed', handleMixtapeItemsRemoved)
  window.electron.ipcRenderer.removeListener(
    'dev-songlist-trace:state',
    handleDevSongListTraceState
  )
  window.electron.ipcRenderer.removeListener(
    'dev-songlist-trace:exported',
    handleDevSongListTraceExported
  )
  window.electron.ipcRenderer.removeListener(
    'dev-songlist-trace:error',
    handleDevSongListTraceError
  )
  window.electron.ipcRenderer.removeListener(
    'analysis-runtime-download-state',
    handleAnalysisRuntimeDownloadStateWrapper
  )
  emitter.off('songsRemoved', handleSongsRemovedForGlobalSearch)
  emitter.off('metadataBatchUpdated', handleMetadataBatchUpdatedForGlobalSearch)
  emitter.off('songMetadataUpdated', handleSongMetadataUpdatedForGlobalSearch)
  contextMenuClickThroughGuard.clear()
}) // 清理全局事件监听与跨组件订阅
</script>
<template>
  <div style="height: 100%; max-height: 100%; width: 100%; display: flex; flex-direction: column">
    <div style="height: 35px; position: relative; z-index: var(--z-title-bar); overflow: visible">
      <titleComponent :title-text="mainWindowTitleText" @open-dialog="openDialog">
        <template #rightExtra>
          <TitleBarAudioVisualizer target="mainWindow" />
        </template>
      </titleComponent>
    </div>
    <div :style="mainWindowTopGapStyle" class="mainWindowTopGap">
      <div class="topToolbarLeftActions">
        <div
          ref="mainWindowBrowseModeMenuRef"
          class="topToolbarModeDropdown"
          data-user-guide-target="browse-mode"
        >
          <bubbleBoxTrigger
            tag="button"
            class="topToolbarModeButton"
            :class="{ 'is-open': mainWindowBrowseModeMenuOpen }"
            :title="currentMainWindowBrowseModeLabel"
            :aria-expanded="mainWindowBrowseModeMenuOpen ? 'true' : 'false'"
            aria-haspopup="menu"
            type="button"
            @click.stop="toggleMainWindowBrowseModeMenu"
          >
            <span class="topToolbarModeButtonLabel">{{ currentMainWindowBrowseModeLabel }}</span>
            <svg
              class="topToolbarModeButtonCaret"
              viewBox="0 0 10 10"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M2 3.25 5 6.25 8 3.25"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </bubbleBoxTrigger>
          <div
            v-if="mainWindowBrowseModeMenuOpen"
            class="topToolbarModeMenu"
            role="menu"
            @click.stop="() => {}"
          >
            <button
              v-for="item in mainWindowBrowseModeOptions"
              :key="item.value"
              class="topToolbarModeOption"
              :class="{ 'is-active': runtime.mainWindowBrowseMode === item.value }"
              type="button"
              role="menuitemradio"
              :aria-checked="runtime.mainWindowBrowseMode === item.value ? 'true' : 'false'"
              @click="void selectMainWindowBrowseMode(item.value)"
            >
              <span class="topToolbarModeOptionCheck">{{
                runtime.mainWindowBrowseMode === item.value ? '✓' : ''
              }}</span>
              <span class="topToolbarModeOptionLabel">{{ t(item.labelKey) }}</span>
            </button>
          </div>
        </div>
        <TopToolbarRecordingButton />
      </div>
      <div class="topToolbarActions">
        <HorizontalBrowseMasterMeter
          v-if="showHorizontalModeShell && horizontalBrowseMasterMeter.active"
          :pre-limiter-peak-left-db="horizontalBrowseMasterMeter.preLimiterPeakLeftDb"
          :pre-limiter-peak-right-db="horizontalBrowseMasterMeter.preLimiterPeakRightDb"
          :limiter-gain-reduction-db="horizontalBrowseMasterMeter.limiterGainReductionDb"
          :limiter-overload="horizontalBrowseMasterMeter.limiterOverload"
        />
        <WindowVolumeDial
          :model-value="mainWindowVolume"
          :label="t('player.volumeControl')"
          :size="28"
          @update:model-value="handleMainWindowVolumeChange"
        />
        <bubbleBoxTrigger
          tag="button"
          class="topToolbarSettingButton"
          :style="topToolbarSettingIconStyle"
          :title="t('common.setting')"
          :aria-label="t('common.setting')"
          type="button"
          @click="openSettingsDialog"
        >
          <span class="topToolbarSettingIcon"></span>
        </bubbleBoxTrigger>
        <span class="topToolbarTime">{{ currentTime }}</span>
      </div>
    </div>
    <div
      v-if="showHorizontalModeShell"
      data-user-guide-target="horizontal-decks"
      :style="horizontalModeShellStyle"
    >
      <HorizontalBrowseModeShell :view-mode="horizontalModeShellViewMode" />
    </div>
    <div style="flex: 1 1 auto; min-height: 0">
      <homePage />
    </div>
    <div
      style="
        width: 100%;
        background-color: var(--bg);
        border-top: 1px solid var(--border);
        box-sizing: border-box;
      "
    >
      <bottomInfoArea />
    </div>
  </div>
  <manualAddSongFingerprintDialog
    v-if="activeDialog == 'fingerprints.manualAdd'"
    @cancel="activeDialog = ''"
  />
  <exportSongFingerprintDialog
    v-if="activeDialog == 'fingerprints.exportDatabase'"
    @cancel="activeDialog = ''"
  />
  <importSongFingerprintDialog
    v-if="activeDialog == 'fingerprints.importDatabase'"
    @cancel="activeDialog = ''"
  />
  <cloudSyncSettingsDialog
    v-if="activeDialog == 'cloudSync.settings'"
    @cancel="activeDialog = ''"
  />
  <settingDialog v-if="activeDialog == 'settings'" @cancel="activeDialog = ''" />
  <cloudSyncSyncDialog
    v-if="activeDialog == 'cloudSync.syncFingerprints'"
    @cancel="activeDialog = ''"
  />
  <curatedLibrarySyncDialog
    v-if="activeDialog == 'cloudSync.syncCuratedLibrary'"
    @cancel="activeDialog = ''"
  />
  <globalSongSearchDialog
    v-if="activeDialog == 'search.globalSong'"
    @cancel="activeDialog = ''"
    @locate="handleGlobalSongSearchLocate"
    @play="handleGlobalSongSearchPlay"
  />
  <FileOpInterruptedDialog
    :visible="fileOpDialogVisible"
    :context="fileOpContext"
    :done="fileOpDone"
    :running="fileOpRunning"
    :pending="fileOpPending"
    :success-so-far="fileOpSuccessSoFar"
    :failed-so-far="fileOpFailedSoFar"
    @resume="sendFileOpControl('resume')"
    @cancel="sendFileOpControl('cancel')"
  />
  <UserGuideIdentityOverlay v-if="userGuideIdentityVisible" @select="chooseUserGuideIdentity" />
  <UserGuideCard
    v-if="userGuideActiveStep && !runtime.confirmShow"
    :key="userGuideActiveStep"
    :step="userGuideActiveStep"
    :beat="userGuideActiveBeat"
    :rekordbox-user="userGuideIsRekordboxUser"
    :beat-number="userGuideBeatNumber"
    :beat-count="userGuideBeatCount"
    :has-next="userGuideHasNextBeat"
    @next="goNextUserGuideBeat"
    @skip="dismissUserGuideStep"
  />
  <AnalysisRuntimeDownloadOverlay
    :visible="analysisRuntimeDownloadVisible"
    :title="analysisRuntimeDownloadTitle"
    :text="analysisRuntimeDownloadText"
    :percent="analysisRuntimeDownloadPercent"
    :hint="t('analysisRuntime.downloadBlockingHint')"
  />
  <LibraryMergeDialog v-if="libraryMergeDialogVisible" @close="libraryMergeDialogVisible = false" />
  <LibraryMergeDialog
    v-if="curatedLibraryMergeDialogVisible"
    scope="curated"
    @close="curatedLibraryMergeDialogVisible = false"
  />
  <LibrarySetupOverlay v-if="runtime.librarySetupActive" />
  <cloudSyncSummaryDialog
    v-if="runtime.cloudSync.summaryVisible"
    :summary="runtime.cloudSync.summary"
    @close="runtime.closeCloudSyncSummary()"
  />
</template>
<style lang="scss" src="./App.scss"></style>
