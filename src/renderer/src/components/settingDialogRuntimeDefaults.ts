import type { IPlayerGlobalShortcuts, ISettingConfig } from 'src/types/globals'
import { sanitizePlayerGlobalShortcuts } from '@shared/playerGlobalShortcuts'
import { normalizeAnalysisBpmRangeId } from '@shared/analysisBpmRange'
import { normalizeTrackReanalysisSelection } from '@shared/trackReanalysisSelection'
import {
  DEFAULT_BROWSER_PLAYER_RIGHT_TRACK_INFO,
  normalizeBrowserPlayerRightTrackInfo
} from '@shared/browserPlayerRightTrackInfo'
import {
  normalizeCloudSyncAutoEnabled,
  normalizeCloudSyncAutoIntervalMs
} from '@shared/cloudSyncAuto'

export const AUDIO_OUTPUT_FOLLOW_SYSTEM_ID = ''

type SettingDialogRuntime = {
  setting: ISettingConfig & {
    songListBubbleAlways?: boolean
  }
}

export const ensurePlayerGlobalShortcuts = (
  runtime: SettingDialogRuntime
): IPlayerGlobalShortcuts => {
  runtime.setting.playerGlobalShortcuts = sanitizePlayerGlobalShortcuts(
    runtime.setting.playerGlobalShortcuts
  )
  return runtime.setting.playerGlobalShortcuts
}

export const ensureSettingDialogRuntimeDefaults = (runtime: SettingDialogRuntime) => {
  runtime.setting.analysisBpmRange = normalizeAnalysisBpmRangeId(runtime.setting.analysisBpmRange)
  runtime.setting.trackAnalysisSelection = normalizeTrackReanalysisSelection(
    runtime.setting.trackAnalysisSelection
  )
  runtime.setting.trackReanalysisSelection = normalizeTrackReanalysisSelection(
    runtime.setting.trackReanalysisSelection
  )
  if (runtime.setting.enablePlaybackRange === undefined) {
    runtime.setting.enablePlaybackRange = false
  }
  if (runtime.setting.startPlayPercent === undefined) {
    runtime.setting.startPlayPercent = 0
  }
  if (runtime.setting.endPlayPercent === undefined) {
    runtime.setting.endPlayPercent = 100
  }
  if (runtime.setting.playbackRangeMode === undefined) {
    runtime.setting.playbackRangeMode = 'custom'
  }
  if (runtime.setting.playbackRangeSectionKinds === undefined) {
    runtime.setting.playbackRangeSectionKinds = ['drop']
  }
  if (runtime.setting.playbackRangeSectionMatchMode === undefined) {
    runtime.setting.playbackRangeSectionMatchMode = 'all'
  }
  if (runtime.setting.showIdleAnalysisStatus === undefined) {
    runtime.setting.showIdleAnalysisStatus = false
  }
  if (runtime.setting.recentDialogSelectedSongListMaxCount === undefined) {
    runtime.setting.recentDialogSelectedSongListMaxCount = 10
  }
  if (runtime.setting.enableErrorReport === undefined) {
    runtime.setting.enableErrorReport = true
  }
  if (runtime.setting.errorReportUsageMsSinceLastSuccess === undefined) {
    runtime.setting.errorReportUsageMsSinceLastSuccess = 0
  }
  if (runtime.setting.errorReportRetryMsSinceLastFailure === undefined) {
    runtime.setting.errorReportRetryMsSinceLastFailure = -1
  }
  if (runtime.setting.persistSongFilters === undefined) {
    runtime.setting.persistSongFilters = false
  }
  if (runtime.setting.enableCuratedArtistTracking === undefined) {
    runtime.setting.enableCuratedArtistTracking = true
  }
  if (runtime.setting.enableExplorerContextMenu === undefined) {
    runtime.setting.enableExplorerContextMenu = runtime.setting.platform === 'win32'
  }
  if (runtime.setting.rekordboxDesktopTrackStorageDir === undefined) {
    runtime.setting.rekordboxDesktopTrackStorageDir = ''
  }
  if (runtime.setting.seratoTrackStorageDir === undefined) {
    runtime.setting.seratoTrackStorageDir = ''
  }
  if (runtime.setting.songListBubbleAlways === undefined) {
    runtime.setting.songListBubbleAlways = false
  }
  if (runtime.setting.acoustIdClientKey === undefined) {
    runtime.setting.acoustIdClientKey = ''
  }
  if (runtime.setting.autoFillSkipCompleted === undefined) {
    runtime.setting.autoFillSkipCompleted = true
  }
  if (runtime.setting.analysisRuntimeStartupPromptShownVersion === undefined) {
    runtime.setting.analysisRuntimeStartupPromptShownVersion = ''
  }
  if (!Array.isArray(runtime.setting.userGuideDismissedSteps)) {
    runtime.setting.userGuideDismissedSteps = []
  }
  if (runtime.setting.audioOutputDeviceId === undefined) {
    runtime.setting.audioOutputDeviceId = AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
  }
  runtime.setting.cloudSyncAutoEnabled = normalizeCloudSyncAutoEnabled(
    runtime.setting.cloudSyncAutoEnabled
  )
  runtime.setting.cloudSyncAutoIntervalMs = normalizeCloudSyncAutoIntervalMs(
    runtime.setting.cloudSyncAutoIntervalMs
  )
  runtime.setting.curatedLibrarySyncEnabled = runtime.setting.curatedLibrarySyncEnabled === true
  if (runtime.setting.waveformMode === undefined) {
    runtime.setting.waveformMode = 'half'
  }
  if (runtime.setting.keyDisplayStyle === undefined) {
    runtime.setting.keyDisplayStyle = 'Classic'
  }
  runtime.setting.browserPlayerRightTrackInfo = normalizeBrowserPlayerRightTrackInfo(
    runtime.setting.browserPlayerRightTrackInfo ?? DEFAULT_BROWSER_PLAYER_RIGHT_TRACK_INFO
  )
  ensurePlayerGlobalShortcuts(runtime)
}
