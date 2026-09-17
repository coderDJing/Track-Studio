import { nativeTheme } from 'electron'
import { is } from '@electron-toolkit/utils'
import { log } from '../log'
import store from '../store'
import url from '../url'
import mainWindow from '../window/mainWindow'
import type { ISettingConfig } from '../../types/globals'
import {
  DEFAULT_PLAYER_GLOBAL_SHORTCUTS,
  sanitizePlayerGlobalShortcuts
} from '../../shared/playerGlobalShortcuts'
import { persistSettingConfigSync } from '../settingsPersistence'
import { normalizeTrackReanalysisSelection } from '../../shared/trackReanalysisSelection'
import {
  DEFAULT_ANALYSIS_BPM_RANGE_ID,
  LEGACY_ANALYSIS_BPM_RANGE,
  normalizeAnalysisBpmRangeId
} from '../../shared/analysisBpmRange'
import {
  DEFAULT_BROWSER_PLAYER_RIGHT_TRACK_INFO,
  normalizeBrowserPlayerRightTrackInfo
} from '../../shared/browserPlayerRightTrackInfo'
import {
  DEV_USER_GUIDE_AS_NEW_USER_ENV,
  isEnabledEnvFlag,
  sanitizeUserGuideAudience,
  sanitizeUserGuideDismissedSteps
} from '../../shared/userGuide'
import {
  DEFAULT_CLOUD_SYNC_AUTO_ENABLED,
  DEFAULT_CLOUD_SYNC_AUTO_INTERVAL_MS,
  normalizeCloudSyncAutoEnabled,
  normalizeCloudSyncAutoIntervalMs
} from '../../shared/cloudSyncAuto'
import {
  DEV_DEFAULT_CLOUD_SYNC_USER_KEY,
  resolveDevCloudSyncUserKey
} from '../../shared/cloudSyncDevUserKey'
import fs = require('fs-extra')

const platform = process.platform

type StoredSettings = Partial<ISettingConfig> & {
  migratedAudioExtAll?: boolean
  isRekordboxUser?: boolean
}

type ExtendedSettingConfig = ISettingConfig & {
  migratedAudioExtAll?: boolean
}

const defaultConvertDefaults: NonNullable<ISettingConfig['convertDefaults']> = {
  targetFormat: 'mp3',
  bitrateKbps: 320,
  sampleRate: 44100,
  channels: 2,
  preserveMetadata: true,
  normalize: false,
  strategy: 'new_file',
  overwrite: false,
  backupOnReplace: true,
  addFingerprint: false
}

const defaultSettings = {
  platform: (platform === 'darwin' ? 'darwin' : 'win32') as 'darwin' | 'win32',
  language: (is.dev ? 'zhCN' : '') as '' | 'enUS' | 'zhCN',
  themeMode: 'system' as 'system' | 'light' | 'dark',
  audioExt: [
    '.mp3',
    '.wav',
    '.flac',
    '.aif',
    '.aiff',
    '.ogg',
    '.opus',
    '.aac',
    '.m4a',
    '.mp4',
    '.wma',
    '.ac3',
    '.dts',
    '.mka',
    '.webm',
    '.ape',
    '.tak',
    '.tta',
    '.wv'
  ],
  databaseUrl: '',
  globalCallShortcut:
    platform === 'win32' ? 'Ctrl+Alt+F' : platform === 'darwin' ? 'Command+Option+F' : '',
  enableWindowScreenshotShortcut: true,
  playerGlobalShortcuts: { ...DEFAULT_PLAYER_GLOBAL_SHORTCUTS },
  hiddenPlayControlArea: false,
  waveformMode: 'half',
  keyDisplayStyle: 'Classic' as 'Classic' | 'Camelot',
  browserPlayerRightTrackInfo: DEFAULT_BROWSER_PLAYER_RIGHT_TRACK_INFO,
  showIdleAnalysisStatus: false,
  analysisBpmRange: DEFAULT_ANALYSIS_BPM_RANGE_ID,
  trackAnalysisSelection: {
    key: true,
    beatGrid: true,
    waveform: true,
    energy: true,
    structure: true
  },
  trackReanalysisSelection: {
    key: true,
    beatGrid: true,
    waveform: true,
    energy: true,
    structure: true
  },
  autoPlayNextSong: false,
  startPlayPercent: 0,
  endPlayPercent: 100,
  playbackRangeMode: 'custom' as const,
  playbackRangeSectionKinds: ['drop'],
  playbackRangeSectionMatchMode: 'all' as const,
  fastForwardTime: 10,
  fastBackwardTime: -5,
  autoScrollToCurrentSong: true,
  enablePlaybackRange: false,
  recentDialogSelectedSongListMaxCount: 10,
  audioOutputDeviceId: '',
  showTitleAudioVisualizer: true,
  mainWindowTitleAudioVisualizerMode: 'bars' as const,
  mixtapeWindowTitleAudioVisualizerMode: 'bars' as const,
  horizontalBrowseFaderControlsExpanded: false,
  persistSongFilters: false,
  enableCuratedArtistTracking: true,
  enableExplorerContextMenu: platform === 'win32',
  showPlaylistTrackCount: true,
  rekordboxDesktopTrackStorageDir: '',
  nextCheckUpdateTime: '',
  enableErrorReport: true,
  errorReportUsageMsSinceLastSuccess: 0,
  errorReportRetryMsSinceLastFailure: -1,
  fingerprintMode: 'pcm' as 'pcm',
  cloudSyncUserKey: is.dev ? DEV_DEFAULT_CLOUD_SYNC_USER_KEY : '',
  cloudSyncAutoEnabled: DEFAULT_CLOUD_SYNC_AUTO_ENABLED,
  cloudSyncAutoIntervalMs: DEFAULT_CLOUD_SYNC_AUTO_INTERVAL_MS,
  cloudSyncLastKnownBaseUrl: '',
  curatedLibrarySyncEnabled: false,
  convertDefaults: defaultConvertDefaults,
  lastSeenWhatsNewVersion: '',
  pendingWhatsNewForVersion: '',
  lastRunAppVersion: '',
  acoustIdClientKey: '',
  autoFillSkipCompleted: true,
  analysisRuntimeStartupPromptShownVersion: '',
  userGuideDismissedSteps: []
} as ISettingConfig

type LoadSettingsOptions = {
  getWindowsContextMenuStatus: () => boolean
}

export function loadInitialSettings(options: LoadSettingsOptions): ISettingConfig {
  const { getWindowsContextMenuStatus } = options
  const settingFileExisted = fs.pathExistsSync(url.settingConfigFileUrl)

  let loadedSettings: StoredSettings = {}
  if (settingFileExisted) {
    try {
      loadedSettings = fs.readJSONSync(url.settingConfigFileUrl)
    } catch (error) {
      log.error('读取设置文件错误，将使用默认设置:', error)
      loadedSettings = {}
    }
  } else {
    loadedSettings = defaultSettings
  }

  const mergedSettings = {
    ...defaultSettings,
    ...(Object.fromEntries(
      Object.entries(loadedSettings as Record<string, unknown>).filter(
        ([key]) => key !== 'lastFmApiKey'
      )
    ) as StoredSettings)
  }
  mergedSettings.playerGlobalShortcuts = sanitizePlayerGlobalShortcuts(
    mergedSettings.playerGlobalShortcuts
  )

  delete (mergedSettings as Record<string, unknown>).waveformStyle

  const finalSettings: ExtendedSettingConfig = {
    ...mergedSettings,
    waveformMode: mergedSettings.waveformMode === 'full' ? 'full' : 'half',
    keyDisplayStyle: mergedSettings.keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic',
    browserPlayerRightTrackInfo: normalizeBrowserPlayerRightTrackInfo(
      mergedSettings.browserPlayerRightTrackInfo
    )
  }

  finalSettings.analysisBpmRange = normalizeAnalysisBpmRangeId(
    loadedSettings.analysisBpmRange,
    settingFileExisted ? LEGACY_ANALYSIS_BPM_RANGE.id : DEFAULT_ANALYSIS_BPM_RANGE_ID
  )
  finalSettings.trackAnalysisSelection = normalizeTrackReanalysisSelection(
    loadedSettings.trackAnalysisSelection
  )
  finalSettings.trackReanalysisSelection = normalizeTrackReanalysisSelection(
    loadedSettings.trackReanalysisSelection
  )

  if (process.platform === 'win32') {
    if (typeof finalSettings.enableExplorerContextMenu !== 'boolean') {
      finalSettings.enableExplorerContextMenu = settingFileExisted
        ? getWindowsContextMenuStatus()
        : true
    }
  } else {
    finalSettings.enableExplorerContextMenu = false
  }

  if (typeof finalSettings.acoustIdClientKey !== 'string') {
    finalSettings.acoustIdClientKey = ''
  }

  if (typeof finalSettings.analysisRuntimeStartupPromptShownVersion !== 'string') {
    finalSettings.analysisRuntimeStartupPromptShownVersion = ''
  }

  const audience = sanitizeUserGuideAudience(
    finalSettings.userGuideAudience,
    loadedSettings.isRekordboxUser
  )
  if (audience === undefined) {
    delete finalSettings.userGuideAudience
  } else {
    finalSettings.userGuideAudience = audience
  }
  delete (finalSettings as StoredSettings).isRekordboxUser
  finalSettings.userGuideDismissedSteps = sanitizeUserGuideDismissedSteps(
    finalSettings.userGuideDismissedSteps
  )
  finalSettings.cloudSyncAutoEnabled = normalizeCloudSyncAutoEnabled(
    finalSettings.cloudSyncAutoEnabled
  )
  finalSettings.cloudSyncAutoIntervalMs = normalizeCloudSyncAutoIntervalMs(
    finalSettings.cloudSyncAutoIntervalMs
  )
  if (typeof finalSettings.cloudSyncLastKnownBaseUrl !== 'string') {
    finalSettings.cloudSyncLastKnownBaseUrl = ''
  }
  finalSettings.curatedLibrarySyncEnabled = finalSettings.curatedLibrarySyncEnabled === true
  if (is.dev) {
    finalSettings.cloudSyncUserKey = resolveDevCloudSyncUserKey(
      String(finalSettings.cloudSyncUserKey || '').trim(),
      true
    )
  }

  try {
    const migrated = loadedSettings.migratedAudioExtAll === true
    if (!migrated) {
      const arr = Array.isArray(finalSettings.audioExt) ? finalSettings.audioExt : []
      const set = new Set(arr.map((e) => String(e || '').toLowerCase()))
      const allFormats = defaultSettings.audioExt
      let changed = false
      for (const fmt of allFormats) {
        if (!set.has(fmt.toLowerCase())) {
          arr.push(fmt)
          changed = true
        }
      }
      if (changed) {
        finalSettings.audioExt = arr
        finalSettings.migratedAudioExtAll = true
      }
    }
  } catch {
    // ignore migration failure
  }

  store.settingConfig = finalSettings
  persistSettingConfigSync(finalSettings)

  if (is.dev && isEnabledEnvFlag(process.env[DEV_USER_GUIDE_AS_NEW_USER_ENV])) {
    delete finalSettings.userGuideAudience
    finalSettings.userGuideDismissedSteps = []
  }

  return finalSettings
}

export function applyThemeFromSettings() {
  try {
    const mode = store.settingConfig?.themeMode || 'system'
    nativeTheme.themeSource = mode
  } catch {}
}

export function broadcastSystemThemeIfNeeded() {
  try {
    const mode = store.settingConfig?.themeMode || 'system'
    if (mode === 'system' && mainWindow.instance) {
      mainWindow.instance.webContents.send('theme/system-updated', {
        isDark: nativeTheme.shouldUseDarkColors
      })
    }
  } catch {}
}
