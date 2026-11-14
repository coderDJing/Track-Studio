import { ILayoutConfig, ISettingConfig } from 'src/types/globals'
import { defaultLayoutConfig } from './layoutConfigDefaults'
import { DEFAULT_BROWSER_PLAYER_RIGHT_TRACK_INFO } from '../shared/browserPlayerRightTrackInfo'
import { DEFAULT_PLAYER_GLOBAL_SHORTCUTS } from '../shared/playerGlobalShortcuts'

let songFingerprintList: string[] = [] //声音指纹列表（基于音频内容哈希）
let databaseDir: string = '' //数据库目录

let layoutConfig: ILayoutConfig = { ...defaultLayoutConfig } //界面布局config

let settingConfig: ISettingConfig = {
  platform: 'win32',
  language: '',
  themeMode: 'system',
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
  globalCallShortcut: '',
  enableWindowScreenshotShortcut: true,
  playerGlobalShortcuts: { ...DEFAULT_PLAYER_GLOBAL_SHORTCUTS },
  nextCheckUpdateTime: '',
  hiddenPlayControlArea: false,
  waveformMode: 'half',
  keyDisplayStyle: 'Classic' as 'Classic' | 'Camelot',
  browserPlayerRightTrackInfo: DEFAULT_BROWSER_PLAYER_RIGHT_TRACK_INFO,
  analysisBpmRange: '70-180',
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
  mainWindowTitleAudioVisualizerMode: 'bars',
  mixtapeWindowTitleAudioVisualizerMode: 'bars',
  horizontalBrowseFaderControlsExpanded: false,
  // 错误日志上报默认配置
  enableErrorReport: true,
  errorReportUsageMsSinceLastSuccess: 0,
  errorReportRetryMsSinceLastFailure: -1,
  persistSongFilters: false,
  enableCuratedArtistTracking: true,
  enableExplorerContextMenu: false,
  showPlaylistTrackCount: true,
  lastSeenWhatsNewVersion: '',
  pendingWhatsNewForVersion: '',
  lastRunAppVersion: '',
  userGuideDismissedSteps: []
} //设置config
export default {
  songFingerprintList,
  databaseDir,
  layoutConfig,
  settingConfig
}
