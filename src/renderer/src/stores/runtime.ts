import { defineStore } from 'pinia'
import {
  ICuratedArtistFavorite,
  IDir,
  ILayoutConfig,
  IRekordboxLibraryBrowserState,
  ISettingConfig,
  ISongInfo,
  ISongsAreaColumn
} from 'src/types/globals'
import type {
  MainWindowBrowseMode,
  MainWindowPlaybackHandoff
} from '@renderer/utils/mainWindowPlaybackHandoff'
import type {
  CloudSyncPhase,
  CloudSyncProgressDetails,
  CloudSyncSummary
} from 'src/types/cloudSync'
import { DEFAULT_BROWSER_PLAYER_RIGHT_TRACK_INFO } from '@shared/browserPlayerRightTrackInfo'
import { DEFAULT_PLAYER_GLOBAL_SHORTCUTS } from '@shared/playerGlobalShortcuts'
import type { MiniPlayerSession } from '@shared/miniPlayerWindow'
import {
  HIDDEN_MINI_PLAYER_TASK_PROGRESS,
  type MiniPlayerTaskProgress
} from '@shared/miniPlayerTaskProgress'
import type { LibrarySetupErrorHint, LibrarySetupMode } from '@shared/librarySetup'
import type { ExternalLibraryKind } from '@shared/externalLibrary'
export type LibrarySelection =
  | 'FilterLibrary'
  | 'CuratedLibrary'
  | 'SetLibrary'
  | 'RecordingLibrary'
  | 'MixtapeLibrary'
  | 'RecycleBin'
  | 'ExternalPlaylist'
  | 'PioneerDeviceLibrary'

export type SongsAreaPaneKey = 'single' | 'left' | 'right'
export type SplitSongsAreaPaneKey = 'left' | 'right'
export type SongsAreaColumnMode = 'default' | 'recycle' | 'recording' | 'mixtape'

interface ISongsAreaState {
  songListUUID: string
  songInfoArr: ISongInfo[]
  missingWaveformFilePaths: string[]
  totalSongCount: number
  selectedSongFilePath: string[]
  scrollTop: number
  scrollLeft: number
}

export interface ISongsAreaPaneRuntimeState extends ISongsAreaState {
  columnCacheByMode: Partial<Record<SongsAreaColumnMode, ISongsAreaColumn[]>>
}

const createSongsAreaState = (): ISongsAreaPaneRuntimeState => ({
  songListUUID: '',
  songInfoArr: [],
  missingWaveformFilePaths: [],
  totalSongCount: 0,
  selectedSongFilePath: [],
  scrollTop: 0,
  scrollLeft: 0,
  columnCacheByMode: {}
})

const assignSongsAreaState = (
  target: ISongsAreaPaneRuntimeState,
  source?: Partial<ISongsAreaPaneRuntimeState> | null
) => {
  target.songListUUID = String(source?.songListUUID || '')
  target.songInfoArr = Array.isArray(source?.songInfoArr) ? [...source.songInfoArr] : []
  target.missingWaveformFilePaths = Array.isArray(source?.missingWaveformFilePaths)
    ? [...source.missingWaveformFilePaths]
    : []
  target.totalSongCount = Number(source?.totalSongCount || 0)
  target.selectedSongFilePath = Array.isArray(source?.selectedSongFilePath)
    ? [...source.selectedSongFilePath]
    : []
  target.scrollTop =
    typeof source?.scrollTop === 'number' && Number.isFinite(source.scrollTop)
      ? source.scrollTop
      : 0
  target.scrollLeft =
    typeof source?.scrollLeft === 'number' && Number.isFinite(source.scrollLeft)
      ? source.scrollLeft
      : 0
  const nextCache: ISongsAreaPaneRuntimeState['columnCacheByMode'] = {}
  const sourceCache = source?.columnCacheByMode
  if (sourceCache && typeof sourceCache === 'object') {
    for (const key of ['default', 'recycle', 'recording', 'mixtape'] as const) {
      const cached = sourceCache[key]
      if (Array.isArray(cached)) {
        nextCache[key] = cached.map((item) => ({ ...item }))
      }
    }
  }
  target.columnCacheByMode = nextCache
}

const clearSongsAreaState = (target: ISongsAreaPaneRuntimeState) => {
  assignSongsAreaState(target, null)
}
type AnalysisRuntimeDownloadStatus =
  | 'idle'
  | 'available'
  | 'downloading'
  | 'extracting'
  | 'ready'
  | 'failed'

type AnalysisRuntimeDownloadState = {
  status: AnalysisRuntimeDownloadStatus
  profile: string
  runtimeKey: string
  version: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  title: string
  message: string
  error: string
  updatedAt: number
}

type AnalysisRuntimePreferredInfo = {
  supported: boolean
  downloadable: boolean
  alreadyAvailable: boolean
  profile: string
  runtimeKey: string
  version: string
  archiveSize: number
  title: string
  reason: string
  manifestUrl: string
  releaseTag: string
  error: string
}

interface Runtime {
  platform: string
  isWindowMaximized: boolean | null
  mainWindowBrowseMode: MainWindowBrowseMode
  libraryAreaSelected: LibrarySelection
  activeMenuUUID: string
  layoutConfig: ILayoutConfig
  dragItemData: null | IDir
  dragTableHeader: boolean
  songDragActive: boolean
  songDragMode: '' | 'internal' | 'external'
  draggingSongFilePaths: string[]
  dragSourceSongListUUID: string
  dragSourceMixtapeItemIds: string[]
  songDragSuppressClickUntilMs: number
  libraryTree: IDir
  oldLibraryTree: IDir
  libraryTreeLoading: boolean
  selectSongListDialogShow: boolean
  dialogSelectedSongListUUID: string
  songsArea: ISongsAreaPaneRuntimeState
  songsAreaPanels: {
    splitEnabled: boolean
    activePane: SongsAreaPaneKey
    panes: Record<SongsAreaPaneKey, ISongsAreaPaneRuntimeState>
  }
  lastSongListUUIDByLibrary: {
    FilterLibrary: string
    CuratedLibrary: string
    SetLibrary: string
    MixtapeLibrary: string
  }
  importingSongListUUID: string
  openSongListAfterImportUUID: string
  isProgressing: boolean
  analysisRuntime: {
    available: boolean
    downloadOverlayMinimized: boolean
    preferred: AnalysisRuntimePreferredInfo
    state: AnalysisRuntimeDownloadState
  }
  cloudSync: {
    minimized: boolean // 是否已最小化到底部进度区
    syncing: boolean // 是否正在同步
    phase: CloudSyncPhase // 当前阶段
    percent: number // 进度百分比
    details: CloudSyncProgressDetails // 当前阶段明细
    summary: CloudSyncSummary | null // 完成汇总数据
    summaryVisible: boolean // 控制汇总组件显隐
  }
  playingData: {
    playingSong: null | ISongInfo
    playingSongListUUID: string
    playingSongListData: ISongInfo[]
  }
  miniPlayerSession: MiniPlayerSession
  bottomInfoTaskProgress: MiniPlayerTaskProgress
  mainWindowPlaybackHandoff: MainWindowPlaybackHandoff | null
  horizontalBrowseDecks: {
    topSong: null | ISongInfo
    bottomSong: null | ISongInfo
    topSongListUUID: string
    bottomSongListUUID: string
    topSongListData: ISongInfo[]
    bottomSongListData: ISongInfo[]
    leaderDeck: null | 'top' | 'bottom'
  }
  externalPlaylist: {
    songs: ISongInfo[]
    lastLibrarySelection: Exclude<LibrarySelection, 'ExternalPlaylist'>
  }
  externalDjLibrary: {
    selectedKind: ExternalLibraryKind | null
    selectedSourceKey: string
    selectedSourcePath: string
  }
  pioneerDeviceLibrary: IRekordboxLibraryBrowserState
  pioneerSelectedRowKeys: string[]
  manualKeyAnalysisPendingFilePaths: string[]
  playlistAnalysisPromptDismissedSongListUUIDs: string[]
  confirmShow: boolean
  librarySetupActive: boolean
  librarySetupMode: LibrarySetupMode | null
  librarySetupErrorHint: LibrarySetupErrorHint | null
  hotkeysScopesHeap: string[]
  curatedArtistFavorites: ICuratedArtistFavorite[]
  setting: ISettingConfig
  // 播放器是否已加载并就绪（用于快进等操作的前置条件）
  playerReady: boolean
  // 是否处于切歌流程中（从发起切歌到新歌开始播放之前）
  isSwitchingSong: boolean
  // 正在创建中的歌单 UUID（用于 UI 微动效）
  creatingSongListUUID: string
  // 从欢迎页创建后短暂标记目标节点，用于把视线自然引向左侧输入框
  welcomeCreatedPlaylistUUID: string
  // 最后点击的区域，用于决定 Ctrl+A 的行为
  focusArea: 'none' | 'library' | 'songsArea'
  // 歌单列表多选状态
  selectedPlaylistIds: string[]
}
export const useRuntimeStore = defineStore('runtime', {
  state: (): Runtime => {
    const singleSongsArea = createSongsAreaState()
    const leftSongsArea = createSongsAreaState()
    const rightSongsArea = createSongsAreaState()
    return {
      platform: '', //使用平台
      isWindowMaximized: null,
      mainWindowBrowseMode: 'browser',
      libraryAreaSelected: 'FilterLibrary',
      activeMenuUUID: '',
      layoutConfig: {
        libraryAreaWidth: 200,
        songsAreaSplitLeftRatio: 0.5,
        isMaxMainWin: false, //上次关闭前是否最大化
        mainWindowWidth: 1260, //上次关闭前窗口化时的宽
        mainWindowHeight: 720 //上次关闭前窗口化时的高
      },
      dragItemData: null,
      dragTableHeader: false, //是否正在拖拽表头
      songDragActive: false,
      songDragMode: '',
      draggingSongFilePaths: [],
      dragSourceSongListUUID: '',
      dragSourceMixtapeItemIds: [],
      songDragSuppressClickUntilMs: 0,
      libraryTree: {
        uuid: '',
        type: 'root',
        dirName: 'library',
        order: 1
      },
      oldLibraryTree: {
        uuid: '',
        type: 'root',
        dirName: 'library',
        order: 1
      },
      libraryTreeLoading: false,
      selectSongListDialogShow: false, //全局是否有歌单选择器正在展示
      dialogSelectedSongListUUID: '', //dialog中被选中的歌单UUID
      // 注意：songsArea 和 songsAreaPanels.panes.single 共享同一个对象引用。
      // 单面板模式下修改 songsArea 会自动反映到 panes.single，反之亦然。
      // 必须使用 setSongsAreaActivePane action 切换，不要直接赋值 runtime.songsArea = { ... }。
      songsArea: singleSongsArea,
      songsAreaPanels: {
        splitEnabled: false,
        activePane: 'single',
        panes: {
          single: singleSongsArea,
          left: leftSongsArea,
          right: rightSongsArea
        }
      },
      lastSongListUUIDByLibrary: {
        FilterLibrary: '',
        CuratedLibrary: '',
        SetLibrary: '',
        MixtapeLibrary: ''
      },
      importingSongListUUID: '', //正在执行导入中的歌单
      openSongListAfterImportUUID: '', //导入完成后需要打开的歌单
      creatingSongListUUID: '', //正在创建中的歌单（用于微动效）
      welcomeCreatedPlaylistUUID: '',
      isProgressing: false, //正在执行某计算或IO任务
      bottomInfoTaskProgress: { ...HIDDEN_MINI_PLAYER_TASK_PROGRESS },
      analysisRuntime: {
        available: false,
        downloadOverlayMinimized: false,
        preferred: {
          supported: false,
          downloadable: false,
          alreadyAvailable: false,
          profile: '',
          runtimeKey: '',
          version: '',
          archiveSize: 0,
          title: '',
          reason: '',
          manifestUrl: '',
          releaseTag: '',
          error: ''
        },
        state: {
          status: 'idle',
          profile: '',
          runtimeKey: '',
          version: '',
          percent: 0,
          downloadedBytes: 0,
          totalBytes: 0,
          archiveSize: 0,
          title: '',
          message: '',
          error: '',
          updatedAt: 0
        }
      },
      cloudSync: {
        minimized: false,
        syncing: false,
        phase: 'idle',
        percent: 0,
        details: {},
        summary: null,
        summaryVisible: false
      },
      playingData: {
        //播放器相关
        playingSong: null, //正在播放的歌曲信息
        playingSongListUUID: '', //正在播放的歌单的UUID
        playingSongListData: [] //正在播放的歌单的曲目数组
      },
      miniPlayerSession: {
        open: false,
        alwaysOnTop: true
      },
      mainWindowPlaybackHandoff: null,
      horizontalBrowseDecks: {
        topSong: null,
        bottomSong: null,
        topSongListUUID: '',
        bottomSongListUUID: '',
        topSongListData: [],
        bottomSongListData: [],
        leaderDeck: null
      },
      externalPlaylist: {
        songs: [],
        lastLibrarySelection: 'FilterLibrary'
      },
      externalDjLibrary: {
        selectedKind: null,
        selectedSourceKey: '',
        selectedSourcePath: ''
      },
      pioneerDeviceLibrary: {
        selectedSourceKey: '',
        selectedSourceName: '',
        selectedSourceRootPath: '',
        selectedSourceKind: '',
        selectedLibraryType: '',
        selectedPlaylistId: 0,
        loading: false,
        visibleSongCount: 0,
        pendingAnalysisCount: 0,
        firstPendingAnalysisFilePath: '',
        visibleAnalysisProgressCount: 0,
        treeNodes: []
      },
      pioneerSelectedRowKeys: [],
      manualKeyAnalysisPendingFilePaths: [],
      playlistAnalysisPromptDismissedSongListUUIDs: [],
      confirmShow: false, //是否有确认框正在显示
      librarySetupActive: false,
      librarySetupMode: null,
      librarySetupErrorHint: null,
      hotkeysScopesHeap: [], //hotkeys-js的scope组成的堆栈，始终setScope数组的最后一项
      curatedArtistFavorites: [],
      setting: {
        platform: 'win32',
        language: '',
        mainWindowBrowseMode: 'browser',
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
        keyDisplayStyle: 'Classic',
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
        playbackRangeMode: 'custom',
        playbackRangeSectionKinds: ['drop'],
        playbackRangeSectionMatchMode: 'all',
        fastForwardTime: 10,
        fastBackwardTime: -5,
        autoScrollToCurrentSong: true,
        enablePlaybackRange: false,
        recentDialogSelectedSongListMaxCount: 10,
        audioOutputDeviceId: '',
        showTitleAudioVisualizer: true,
        mainWindowTitleAudioVisualizerMode: 'bars',
        mixtapeWindowTitleAudioVisualizerMode: 'bars',
        enableErrorReport: true,
        errorReportUsageMsSinceLastSuccess: 0,
        errorReportRetryMsSinceLastFailure: -1,
        persistSongFilters: false,
        enableCuratedArtistTracking: true,
        enableExplorerContextMenu: false,
        showPlaylistTrackCount: true,
        lastSeenWhatsNewVersion: '',
        pendingWhatsNewForVersion: ''
      }, //设置
      playerReady: false,
      isSwitchingSong: false,
      focusArea: 'none',
      selectedPlaylistIds: []
    }
  },
  actions: {
    setAnalysisRuntimeDownloadOverlayMinimized(minimized: boolean) {
      this.analysisRuntime.downloadOverlayMinimized = minimized
    },
    setCloudSyncMinimized(minimized: boolean) {
      this.cloudSync.minimized = minimized
    },
    setCloudSyncSyncing(syncing: boolean) {
      this.cloudSync.syncing = syncing
    },
    setCloudSyncProgress(
      phase: CloudSyncPhase,
      percent: number,
      details?: CloudSyncProgressDetails
    ) {
      const nextPercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
      this.cloudSync.phase = phase
      this.cloudSync.percent =
        this.cloudSync.syncing && phase !== 'idle'
          ? Math.max(this.cloudSync.percent, nextPercent)
          : nextPercent
      this.cloudSync.details = details || {}
    },
    resetCloudSync() {
      this.cloudSync.minimized = false
      this.cloudSync.syncing = false
      this.cloudSync.phase = 'idle'
      this.cloudSync.percent = 0
      this.cloudSync.details = {}
    },
    openCloudSyncSummary(summary: CloudSyncSummary) {
      this.cloudSync.summary = summary
      this.cloudSync.summaryVisible = true
    },
    closeCloudSyncSummary() {
      this.cloudSync.summaryVisible = false
      this.cloudSync.summary = null
      // 关闭报告后复位进度，避免下次打开对话框时残留上次的进度（如 100%）
      this.cloudSync.phase = 'idle'
      this.cloudSync.percent = 0
      this.cloudSync.details = {}
    },
    setSongsAreaActivePane(pane: SongsAreaPaneKey) {
      this.songsAreaPanels.activePane = pane
      this.songsArea = this.songsAreaPanels.panes[pane]
    },
    assignSongsAreaPaneState(
      pane: SongsAreaPaneKey,
      source?: Partial<ISongsAreaPaneRuntimeState> | null
    ) {
      assignSongsAreaState(this.songsAreaPanels.panes[pane], source)
      if (this.songsAreaPanels.activePane === pane) {
        this.songsArea = this.songsAreaPanels.panes[pane]
      }
    },
    clearSongsAreaPaneState(pane: SongsAreaPaneKey) {
      clearSongsAreaState(this.songsAreaPanels.panes[pane])
      if (this.songsAreaPanels.activePane === pane) {
        this.songsArea = this.songsAreaPanels.panes[pane]
      }
    }
  }
})
