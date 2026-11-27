import type { ISettingConfig } from 'src/types/globals'

export type SettingsPageId =
  | 'common'
  | 'general'
  | 'player'
  | 'shortcuts'
  | 'library'
  | 'analysis'
  | 'integrations'
  | 'advanced'

export type SettingsCategoryId = Exclude<SettingsPageId, 'common'>

export type SettingId =
  | 'themeMode'
  | 'accentColor'
  | 'language'
  | 'browserPlayerRightTrackInfo'
  | 'recentDialogSelectedSongListMaxCount'
  | 'userGuideAudience'
  | 'autoPlayNextSong'
  | 'audioOutputDeviceId'
  | 'fastForwardTime'
  | 'fastBackwardTime'
  | 'waveformMode'
  | 'keyDisplayStyle'
  | 'hiddenPlayControlArea'
  | 'showTitleAudioVisualizer'
  | 'enablePlaybackRange'
  | 'playbackRangeMode'
  | 'playbackRangeSectionKinds'
  | 'playbackRangeSectionMatchMode'
  | 'globalCallShortcut'
  | 'shortcutTogglePlayPause'
  | 'shortcutFastForward'
  | 'shortcutFastBackward'
  | 'shortcutNextSong'
  | 'shortcutPreviousSong'
  | 'shortcutSeekPercent'
  | 'curatedArtistTracking'
  | 'persistSongFilters'
  | 'showPlaylistTrackCount'
  | 'songListBubbleAlways'
  | 'autoScrollToCurrentSong'
  | 'currentLibraryPath'
  | 'reselectLibrary'
  | 'analysisBpmRange'
  | 'analysisGridMode'
  | 'showIdleAnalysisStatus'
  | 'ultraStemModel'
  | 'autoFillSkipCompleted'
  | 'fingerprintMode'
  | 'scanFormats'
  | 'acoustIdClientKey'
  | 'rekordboxDesktopTrackStorageDir'
  | 'seratoTrackStorageDir'
  | 'traktorTrackStorageDir'
  | 'enableExplorerContextMenu'
  | 'neteaseLibraryIcon'
  | 'neteaseQuality'
  | 'neteaseCache'
  | 'neteaseRemovePlaylistLocalFiles'
  | 'enableErrorReport'
  | 'clearFingerprintLibrary'
  | 'clearCloudData'
  | 'clearLibraryDirtyData'
  | 'clearAnalysisRuntime'

export interface SettingsPageMeta {
  id: SettingsPageId
  labelKey: string
  descKey: string
}

export const SETTINGS_PAGES: SettingsPageMeta[] = [
  {
    id: 'common',
    labelKey: 'settings.nav.common',
    descKey: 'settings.pages.commonDesc'
  },
  {
    id: 'general',
    labelKey: 'settings.nav.general',
    descKey: 'settings.pages.generalDesc'
  },
  {
    id: 'player',
    labelKey: 'settings.nav.player',
    descKey: 'settings.pages.playerDesc'
  },
  {
    id: 'shortcuts',
    labelKey: 'settings.nav.shortcuts',
    descKey: 'settings.pages.shortcutsDesc'
  },
  {
    id: 'library',
    labelKey: 'settings.nav.library',
    descKey: 'settings.pages.libraryDesc'
  },
  {
    id: 'analysis',
    labelKey: 'settings.nav.analysis',
    descKey: 'settings.pages.analysisDesc'
  },
  {
    id: 'integrations',
    labelKey: 'settings.nav.integrations',
    descKey: 'settings.pages.integrationsDesc'
  },
  {
    id: 'advanced',
    labelKey: 'settings.nav.advanced',
    descKey: 'settings.pages.advancedDesc'
  }
]

export const SETTINGS_PAGE_BY_ID = SETTINGS_PAGES.reduce(
  (acc, page) => {
    acc[page.id] = page
    return acc
  },
  {} as Record<SettingsPageId, SettingsPageMeta>
)

export type SettingRequirement = {
  key: keyof ISettingConfig
  value: unknown
}

export interface SettingMeta {
  id: SettingId
  page: SettingsCategoryId
  labelKey: string
  aliases: string[]
  order: number
  pinned?: boolean
  platforms?: Array<ISettingConfig['platform']>
  devOnly?: boolean
  requires?: SettingRequirement[]
}

const CATALOG: Omit<SettingMeta, 'order'>[] = [
  // ── 常规 ─────────────────────────────────────────────────────────────────
  {
    id: 'themeMode',
    page: 'general',
    labelKey: 'theme.mode',
    aliases: ['主题', '外观', '深色', '浅色', '夜间', '白天', 'theme', 'dark', 'light'],
    pinned: true
  },
  {
    id: 'accentColor',
    page: 'general',
    labelKey: 'theme.accentColor',
    aliases: ['强调色', '主题色', '主色', '颜色', 'accent', 'color']
  },
  {
    id: 'language',
    page: 'general',
    labelKey: 'common.language',
    aliases: ['语言', '中文', '英文', 'language', 'english', 'chinese'],
    pinned: true
  },
  {
    id: 'browserPlayerRightTrackInfo',
    page: 'general',
    labelKey: 'player.browserPlayerRightTrackInfo',
    aliases: ['浏览器播放器', '右侧信息', 'BPM', 'Key', '调性', '曲目信息', 'browser player']
  },
  {
    id: 'recentDialogSelectedSongListMaxCount',
    page: 'general',
    labelKey: 'player.recentPlaylistCache',
    aliases: ['最近使用歌单', '缓存数量', '最近歌单', 'recent playlist', 'cache']
  },
  {
    id: 'userGuideAudience',
    page: 'general',
    labelKey: 'userGuide.settingTitle',
    aliases: ['使用指引', '引导', '新手', '老手', 'rekordbox 用户', 'user guide']
  },

  // ── 播放器 ───────────────────────────────────────────────────────────────
  {
    id: 'autoPlayNextSong',
    page: 'player',
    labelKey: 'player.autoPlayNext',
    aliases: ['自动播放', '下一首', '连播', 'auto play', 'next'],
    pinned: true
  },
  {
    id: 'audioOutputDeviceId',
    page: 'player',
    labelKey: 'player.audioOutputDevice',
    aliases: [
      '音频输出',
      '输出设备',
      '扬声器',
      '耳机',
      '声卡',
      'audio output',
      'speaker',
      'headphone'
    ],
    pinned: true
  },
  {
    id: 'fastForwardTime',
    page: 'player',
    labelKey: 'player.fastForwardTime',
    aliases: ['快进', '前进秒数', 'fast forward']
  },
  {
    id: 'fastBackwardTime',
    page: 'player',
    labelKey: 'player.fastBackwardTime',
    aliases: ['快退', '后退秒数', 'rewind', 'fast backward']
  },
  {
    id: 'waveformMode',
    page: 'player',
    labelKey: 'player.waveformMode',
    aliases: ['波形', '半波', '全波', 'waveform'],
    pinned: true
  },
  {
    id: 'keyDisplayStyle',
    page: 'player',
    labelKey: 'player.keyDisplayStyle',
    aliases: ['调性', 'Key', 'Camelot', '卡梅洛特', 'classic', '显示风格']
  },
  {
    id: 'hiddenPlayControlArea',
    page: 'player',
    labelKey: 'player.hideControlsShowWaveform',
    aliases: ['隐藏控制区', '波形显示', 'hide controls']
  },
  {
    id: 'showTitleAudioVisualizer',
    page: 'player',
    labelKey: 'player.showTitleAudioVisualizer',
    aliases: ['标题可视化', '音频可视化', 'visualizer']
  },
  {
    id: 'enablePlaybackRange',
    page: 'player',
    labelKey: 'player.enablePlaybackRange',
    aliases: ['区间播放', '播放区间', '片段播放', 'playback range']
  },
  {
    id: 'playbackRangeMode',
    page: 'player',
    labelKey: 'player.playbackRangeMode',
    aliases: ['区间模式', '自定义区间', '段落区间', 'range mode'],
    requires: [{ key: 'enablePlaybackRange', value: true }]
  },
  {
    id: 'playbackRangeSectionKinds',
    page: 'player',
    labelKey: 'player.playbackRangeSectionKinds',
    aliases: ['段落类型', 'section kinds', 'drop', 'intro', 'outro'],
    requires: [
      { key: 'enablePlaybackRange', value: true },
      { key: 'playbackRangeMode', value: 'section' }
    ]
  },
  {
    id: 'playbackRangeSectionMatchMode',
    page: 'player',
    labelKey: 'player.playbackRangeSectionMatchMode',
    aliases: ['区间匹配', '匹配方式', 'match mode'],
    requires: [
      { key: 'enablePlaybackRange', value: true },
      { key: 'playbackRangeMode', value: 'section' }
    ]
  },

  // ── 快捷键 ───────────────────────────────────────────────────────────────
  {
    id: 'globalCallShortcut',
    page: 'shortcuts',
    labelKey: 'shortcuts.globalCallShortcut',
    aliases: ['全局唤起', '唤出', '主窗口', 'global shortcut', 'call']
  },
  {
    id: 'shortcutTogglePlayPause',
    page: 'shortcuts',
    labelKey: 'shortcuts.globalPlayPauseShortcut',
    aliases: ['播放暂停快捷键', '播放快捷键', 'play pause shortcut'],
    pinned: true
  },
  {
    id: 'shortcutFastForward',
    page: 'shortcuts',
    labelKey: 'shortcuts.globalFastForwardShortcut',
    aliases: ['快进快捷键', 'fast forward shortcut']
  },
  {
    id: 'shortcutFastBackward',
    page: 'shortcuts',
    labelKey: 'shortcuts.globalFastBackwardShortcut',
    aliases: ['快退快捷键', 'fast backward shortcut']
  },
  {
    id: 'shortcutNextSong',
    page: 'shortcuts',
    labelKey: 'shortcuts.globalNextShortcut',
    aliases: ['下一首快捷键', 'next shortcut']
  },
  {
    id: 'shortcutPreviousSong',
    page: 'shortcuts',
    labelKey: 'shortcuts.globalPreviousShortcut',
    aliases: ['上一首快捷键', 'previous shortcut']
  },
  {
    id: 'shortcutSeekPercent',
    page: 'shortcuts',
    labelKey: 'shortcuts.globalSeekPercentShortcut',
    aliases: ['百分比跳转', '快速定位', 'seek percent']
  },

  // ── 音乐库 ───────────────────────────────────────────────────────────────
  {
    id: 'curatedArtistTracking',
    page: 'library',
    labelKey: 'settings.curatedArtistTracking.title',
    aliases: ['精选表演者', '精选艺人', '联动', 'curated artist']
  },
  {
    id: 'persistSongFilters',
    page: 'library',
    labelKey: 'filters.persistFiltersAfterRestart',
    aliases: ['保留筛选', '重启筛选', 'filters']
  },
  {
    id: 'showPlaylistTrackCount',
    page: 'library',
    labelKey: 'settings.showPlaylistTrackCount',
    aliases: ['歌单数量', '曲目数量', 'track count']
  },
  {
    id: 'songListBubbleAlways',
    page: 'library',
    labelKey: 'settings.songListBubble.title',
    aliases: ['气泡提示', '悬停提示', 'tooltip', 'bubble']
  },
  {
    id: 'autoScrollToCurrentSong',
    page: 'library',
    labelKey: 'player.autoCenterSong',
    aliases: ['自动居中', '跟随播放', 'scroll to current']
  },
  {
    id: 'currentLibraryPath',
    page: 'library',
    labelKey: 'settings.currentLibraryPath',
    aliases: ['音乐库路径', '库目录', '当前库', 'library path', 'folder'],
    pinned: true
  },
  {
    id: 'reselectLibrary',
    page: 'library',
    labelKey: 'database.reselectLocation',
    aliases: ['重新选择音乐库', '切换库', 'reselect library']
  },

  // ── 分析与指纹 ───────────────────────────────────────────────────────────
  {
    id: 'analysisBpmRange',
    page: 'analysis',
    labelKey: 'settings.analysisBpmRange.label',
    aliases: ['BPM 范围', 'BPM 分析', '半速', '倍速', 'bpm range']
  },
  {
    id: 'analysisGridMode',
    page: 'analysis',
    labelKey: 'settings.analysisGridMode.label',
    aliases: ['网格', '网格分析', 'Dynamic', 'Normal', 'grid']
  },
  {
    id: 'showIdleAnalysisStatus',
    page: 'analysis',
    labelKey: 'player.showIdleAnalysisStatus',
    aliases: ['闲时分析', '分析状态', 'idle analysis']
  },
  {
    id: 'ultraStemModel',
    page: 'analysis',
    labelKey: 'settings.ultraStemModel.title',
    aliases: ['Stem', '超高质量', '模型', 'demucs', 'ultra stem']
  },
  {
    id: 'autoFillSkipCompleted',
    page: 'analysis',
    labelKey: 'metadata.autoFillSkipCompleted',
    aliases: ['自动填充', '跳过已完成', 'metadata fill']
  },
  {
    id: 'fingerprintMode',
    page: 'analysis',
    labelKey: 'fingerprints.mode',
    aliases: ['指纹模式', 'PCM', '文件指纹', 'fingerprint mode']
  },
  {
    id: 'scanFormats',
    page: 'analysis',
    labelKey: 'fingerprints.scanFormats',
    aliases: ['扫描格式', '音频格式', 'flac', 'mp3', 'wav', 'formats']
  },

  // ── 集成与服务 ───────────────────────────────────────────────────────────
  {
    id: 'neteaseLibraryIcon',
    page: 'integrations',
    labelKey: 'netease.settings.showLibraryIcon',
    aliases: ['网易云', '图标', 'netease icon']
  },
  {
    id: 'neteaseQuality',
    page: 'integrations',
    labelKey: 'netease.settings.quality',
    aliases: ['网易云音质', '音质', '无损', 'lossless', 'quality'],
    pinned: true
  },
  {
    id: 'neteaseCache',
    page: 'integrations',
    labelKey: 'netease.settings.cache',
    aliases: ['网易云缓存', '试听缓存', '缓存上限', 'cache']
  },
  {
    id: 'neteaseRemovePlaylistLocalFiles',
    page: 'integrations',
    labelKey: 'netease.settings.removePlaylistLocalFiles',
    aliases: ['网易云歌单', '移除本地文件', '删除本地', 'playlist local files']
  },
  {
    id: 'acoustIdClientKey',
    page: 'integrations',
    labelKey: 'metadata.acoustidSettingTitle',
    aliases: ['AcoustID', '声学指纹', '识别密钥', 'API key', 'acoustid']
  },
  {
    id: 'rekordboxDesktopTrackStorageDir',
    page: 'integrations',
    labelKey: 'settings.rekordboxDesktopTrackStorageDir.title',
    aliases: ['Rekordbox', '歌曲目录', '存放目录', 'rekordbox folder']
  },
  {
    id: 'seratoTrackStorageDir',
    page: 'integrations',
    labelKey: 'settings.seratoTrackStorageDir.title',
    aliases: ['Serato', '歌曲目录', 'serato folder']
  },
  {
    id: 'traktorTrackStorageDir',
    page: 'integrations',
    labelKey: 'settings.traktorTrackStorageDir.title',
    aliases: ['Traktor', '歌曲目录', 'traktor folder']
  },
  {
    id: 'enableExplorerContextMenu',
    page: 'integrations',
    labelKey: 'settings.enableExplorerContextMenu',
    aliases: ['右键菜单', '资源管理器', 'explorer', 'context menu'],
    platforms: ['win32']
  },

  // ── 高级与维护 ───────────────────────────────────────────────────────────
  {
    id: 'enableErrorReport',
    page: 'advanced',
    labelKey: 'errorReport.enable',
    aliases: ['错误报告', '崩溃报告', 'error report', 'telemetry']
  },
  {
    id: 'clearFingerprintLibrary',
    page: 'advanced',
    labelKey: 'fingerprints.clear',
    aliases: ['清空指纹', '指纹库', 'clear fingerprint']
  },
  {
    id: 'clearCloudData',
    page: 'advanced',
    labelKey: 'cloudSync.reset.sectionTitle',
    aliases: ['重置云端', '云端数据', '清空云', 'cloud reset']
  },
  {
    id: 'clearLibraryDirtyData',
    page: 'advanced',
    labelKey: 'settings.clearDirtyData.title',
    aliases: ['清理脏数据', '缓存清理', 'dirty data'],
    devOnly: true
  },
  {
    id: 'clearAnalysisRuntime',
    page: 'advanced',
    labelKey: 'settings.clearAnalysisRuntime.title',
    aliases: ['清除运行时', '分析运行时', 'runtime'],
    devOnly: true
  }
]

export const SETTINGS_CATALOG: SettingMeta[] = CATALOG.map((meta, index) => ({
  ...meta,
  order: index
}))

export const SETTINGS_BY_ID = SETTINGS_CATALOG.reduce(
  (acc, meta) => {
    acc[meta.id] = meta
    return acc
  },
  {} as Record<SettingId, SettingMeta>
)

export const DEFAULT_PINNED_SETTINGS: SettingId[] = SETTINGS_CATALOG.filter(
  (meta) => meta.pinned === true
).map((meta) => meta.id)

export type SettingAvailabilityContext = {
  isDevOrPrerelease: boolean
  platform: ISettingConfig['platform']
}

export const isSettingAvailable = (
  meta: SettingMeta,
  setting: ISettingConfig,
  context: SettingAvailabilityContext
): boolean => {
  if (meta.devOnly && !context.isDevOrPrerelease) return false
  if (meta.platforms && !meta.platforms.includes(context.platform)) return false
  if (meta.requires) {
    for (const requirement of meta.requires) {
      if (setting[requirement.key] !== requirement.value) return false
    }
  }
  return true
}

export const resolveVisibleSettingId = (
  settingId: SettingId,
  setting: ISettingConfig,
  context: SettingAvailabilityContext
): SettingId => {
  let current = settingId
  const visited = new Set<SettingId>()

  while (!visited.has(current)) {
    visited.add(current)
    const meta = SETTINGS_BY_ID[current]
    if (!meta) return settingId

    const unmetRequirement = meta.requires?.find(
      (requirement) => setting[requirement.key] !== requirement.value
    )
    if (!unmetRequirement) return current

    const requiredId = unmetRequirement.key as SettingId
    if (!SETTINGS_BY_ID[requiredId]) return current
    current = requiredId
  }

  return settingId
}
