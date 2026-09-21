/// <reference types="electron-vite/node" />
import { ElectronAPI } from '@electron-toolkit/preload'
import { PreloadApi } from '../preload/index'
import { IPicture } from 'music-metadata'
import type { RekordboxSourceKind, RekordboxSourceLibraryType } from '../shared/rekordboxSources'
import type { SongStructureAnalysis } from '../shared/songStructure'
import type { SongBeatGridMapV2 } from '../shared/songBeatGridMapV2'
import type { PlaybackRangeMode, PlaybackRangeSectionMatchMode } from '../shared/playbackRange'
import type { AnalysisBpmRangePresetId } from '../shared/analysisBpmRange'
import type { TrackReanalysisUserSelection } from '../shared/trackReanalysisSelection'
import type { BrowserPlayerRightTrackInfoField } from '../shared/browserPlayerRightTrackInfo'

interface IDir {
  uuid: string
  type: 'root' | 'library' | 'dir' | 'songList' | 'mixtapeList' | 'setList'
  dirName: string
  mixMode?: 'eq' | 'stem'
  stemProfile?: 'quality' | 'ultra'
  order?: number
  children?: IDir[]
}

type md5 = {
  sha256_Hash: string
  file_path: string
  error?: string
}

type BeatGridStatus = 'no-bpm'

declare global {
  interface Window {
    electron: ElectronAPI
    api: PreloadApi
  }
}

interface ISongInfo {
  filePath: string
  fileName: string
  fileFormat: string
  cover: IPicture | null
  title: string | undefined
  artist: string | undefined
  album: string | undefined
  duration: string
  genre: string | undefined
  label: string | undefined
  bitrate: number | undefined
  container: string | undefined
  key?: string
  keyAnalysisAlgorithmVersion?: number
  bpm?: number
  firstBeatMs?: number
  downbeatBeatOffset?: number
  beatGridSource?: 'manual' | 'analysis' | 'rekordbox'
  beatGridStatus?: BeatGridStatus
  beatGridMap?: SongBeatGridMapV2
  rekordboxGridEntries?: IRekordboxBeatGridEntry[]
  energyScore?: number
  energyAlgorithmVersion?: number
  songStructure?: SongStructureAnalysis
  playlistTrackNumber?: number
  addedAtMs?: number
  timeBasisOffsetMs?: number
  timeBasisOffsetAlgorithmVersion?: number
  beatGridAlgorithmVersion?: number
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
  mixOrder?: number
  mixtapeItemId?: string
  setItemId?: string
  analysisOnly?: boolean
  autoFilled?: boolean
  externalAnalyzePath?: string | null
  externalWaveformRootPath?: string | null
  waveformPreviewListRoot?: string | null
  externalSourceKind?: RekordboxSourceKind | null
  pioneerCoverPath?: string | null
  pioneerAnalyzePath?: string | null
  pioneerDeviceRootPath?: string | null
  deletedAtMs?: number
  originalPlaylistPath?: string | null
  recycleBinSourceType?: string | null
  fileMissing?: boolean
}

export interface ISongHotCue {
  slot: number
  sec: number
  label?: string
  comment?: string
  colorIndex?: number
  colorName?: string
  color?: string
  isLoop?: boolean
  loopEndSec?: number
  source?: string
}

export interface ISongMemoryCue {
  sec: number
  order?: number
  comment?: string
  colorIndex?: number
  colorName?: string
  color?: string
  isLoop?: boolean
  loopEndSec?: number
  source?: string
}

interface ICuratedArtistFavorite {
  name: string
  count: number
  fingerprints?: string[]
}

interface IPioneerPreviewWaveformColumn {
  backHeight: number
  frontHeight: number
  backColorR: number
  backColorG: number
  backColorB: number
  frontColorR: number
  frontColorG: number
  frontColorB: number
}

interface IPioneerPreviewWaveformData {
  style: 'blue' | 'rgb'
  analyzeFilePath: string
  previewFilePath: string
  columnCount: number
  maxHeight: number
  columns: IPioneerPreviewWaveformColumn[]
}

// 曲目完整元数据明细，用于编辑界面展示
interface ITrackMetadataDetail {
  filePath: string
  fileName: string
  fileExtension: string
  durationSeconds?: number
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  trackNo?: number | null
  trackTotal?: number | null
  discNo?: number | null
  discTotal?: number | null
  year?: string
  genre?: string
  composer?: string
  lyricist?: string
  label?: string
  isrc?: string
  comment?: string
  lyrics?: string
  cover?: {
    dataUrl: string
    format?: string
  } | null
}

interface IPioneerPlaylistTreeNode {
  id: number
  parentId: number
  name: string
  isFolder: boolean
  isSmartPlaylist?: boolean
  order: number
  sortOrder: number
  children?: IPioneerPlaylistTreeNode[]
}

type IPioneerDeviceLibraryKind = 'deviceLibrary' | 'oneLibrary'

type IRekordboxSourceKind = RekordboxSourceKind

type IRekordboxSourceLibraryType = RekordboxSourceLibraryType

interface IRekordboxLibraryBrowserState {
  selectedSourceKey: string
  selectedSourceName: string
  selectedSourceRootPath: string
  selectedSourceKind: RekordboxSourceKind | ''
  selectedLibraryType: RekordboxSourceLibraryType | ''
  selectedPlaylistId: number
  loading: boolean
  visibleSongCount: number
  pendingAnalysisCount: number
  firstPendingAnalysisFilePath: string
  visibleAnalysisProgressCount: number
  treeNodes: IPioneerPlaylistTreeNode[]
}

interface IPioneerPlaylistTrack {
  rowKey: string
  playlistId: number
  playlistName: string
  trackId: number
  entryIndex: number
  title: string
  artist: string
  album: string
  label: string
  genre: string
  filePath: string
  fileName: string
  fileFormat: string
  container: string
  duration: string
  durationSec: number
  bpm?: number
  key?: string
  bitrate?: number
  sampleRate?: number
  sampleDepth?: number
  trackNumber?: number
  discNumber?: number
  year?: number
  analyzePath?: string
  rekordboxGridEntries?: IRekordboxBeatGridEntry[]
  beatGridMap?: SongBeatGridMapV2
  timeBasisOffsetMs?: number
  comment?: string
  dateAdded?: string
  artworkId?: number
  artworkPath?: string
  coverPath?: string
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
  fileMissing?: boolean
}

interface IRekordboxBeatGridEntry {
  timeMs: number
  bpm: number
  beatNumber: number
}

interface IMusicBrainzSearchPayload {
  filePath: string
  title?: string
  artist?: string
  album?: string
  durationSeconds?: number
}

interface IMusicBrainzAcoustIdPayload {
  filePath: string
  durationSeconds?: number
  maxLengthSeconds?: number
}

interface IMusicBrainzMatch {
  recordingId: string
  title: string
  artist: string
  releaseId?: string
  releaseTitle?: string
  releaseDate?: string
  country?: string
  disambiguation?: string
  score: number
  matchedFields: string[]
  durationSeconds?: number
  durationDiffSeconds?: number
  isrc?: string
  source?: 'search' | 'acoustid'
  acoustIdScore?: number
  isLowConfidence?: boolean
}

interface IMusicBrainzSuggestion {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  year?: string
  genre?: string
  label?: string
  isrc?: string
  trackNo?: number
  trackTotal?: number
  discNo?: number
  discTotal?: number
  coverDataUrl?: string | null
}

interface IMusicBrainzSuggestionResult {
  suggestion: IMusicBrainzSuggestion
  source: {
    recordingId: string
    releaseId?: string
  }
  releaseTitle?: string
  releaseDate?: string
  country?: string
  label?: string
  artistCredit?: string
}

interface IMusicBrainzSuggestionParams {
  recordingId: string
  releaseId?: string
  allowFallback?: boolean
  cancelToken?: { cancelled: boolean }
}

type ISimilarTrackSource = 'listenbrainz' | 'lastfm'

interface ISimilarTracksRequest {
  filePath: string
  title?: string
  artist?: string
  album?: string
  durationSeconds?: number
  limit?: number
}

interface ISimilarTracksSeed {
  title: string
  artist: string
  album?: string
  recordingMbid?: string
  releaseMbid?: string
  score?: number
  source: 'acoustid' | 'tags'
}

interface ISimilarTrackItem {
  id: string
  title: string
  artist: string
  album?: string
  recordingMbid?: string
  artistMbid?: string
  releaseMbid?: string
  coverUrl?: string
  score: number
  sources: ISimilarTrackSource[]
  sourceScores?: Partial<Record<ISimilarTrackSource, number>>
  sourceUrls?: Partial<Record<ISimilarTrackSource, string>>
}

interface ISimilarTracksProviderStatus {
  source: ISimilarTrackSource
  status: 'ok' | 'missing-key' | 'no-seed' | 'error'
  count?: number
  message?: string
}

interface ISimilarTracksResult {
  seed?: ISimilarTracksSeed
  tracks: ISimilarTrackItem[]
  providerStatus: ISimilarTracksProviderStatus[]
}

/** 批量查找相似歌曲：一首种子歌的查询请求项（在 ISimilarTracksRequest 基础上带一个稳定标识）。 */
interface ISimilarTracksBatchSeed extends ISimilarTracksRequest {
  /** 种子歌的稳定标识，用于进度展示与结果归属。 */
  seedKey: string
}

interface ISimilarTracksBatchRequest {
  seeds: ISimilarTracksBatchSeed[]
  /** 进度 id，用于底部全局进度条与取消。 */
  progressId: string
}

/** 单首种子歌的批量查询结果。 */
interface ISimilarTracksBatchSeedResult {
  seedKey: string
  /** 后端实际识别出的源曲；识别失败时为空。 */
  seed?: ISimilarTracksSeed
  /** 该种子是否成功识别出 seed（AcoustID/标签）。识别失败时 tracks 为空。 */
  seedResolved: boolean
  /** 该种子查到的外部推荐（未去重，交给前端汇总）。 */
  tracks: ISimilarTrackItem[]
  /** 每个外部来源的查询状态，用于批量聚合诊断。 */
  providerStatus: ISimilarTracksProviderStatus[]
  /** 该种子整体失败（如无种子、网络错误）时的错误码，用于顶部汇总统计。 */
  errorCode?: string
}

interface ISimilarTracksBatchResult {
  perSeed: ISimilarTracksBatchSeedResult[]
  /** 实际处理（已跑完）的种子数。 */
  processed: number
  /** 总种子数。 */
  total: number
  /** 识别失败或无推荐的种子数（顶部汇总用）。 */
  emptyCount: number
  /** 是否被用户中途取消。 */
  canceled: boolean
}

/** 前端推荐池中的一项：在 ISimilarTrackItem 基础上记录来源种子。 */
interface ISimilarTracksPoolItem extends ISimilarTrackItem {
  /** 被多少首不同的种子歌同时推荐。 */
  recommendedBy: number
  /** 被哪些种子推荐（seedKey 列表，留作可展开明细）。 */
  recommendedBySeeds: string[]
}

interface ISimilarTrackBlockTarget {
  title?: string
  artist?: string
  album?: string
  recordingMbid?: string
  sources?: ISimilarTrackSource[]
}

interface ISimilarTrackBlockResult {
  /** 本次屏蔽命中的稳定键：优先 MBID，文本键作为兜底。 */
  keys: string[]
  blockedAt: number
}

interface IMusicBrainzApplyPayload {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  year?: string
  genre?: string
  label?: string
  isrc?: string
  trackNo?: number
  trackTotal?: number
  discNo?: number
  discTotal?: number
  coverDataUrl?: string | null
}

type IBatchRenameTemplateToken =
  | 'title'
  | 'artist'
  | 'bpm'
  | 'key'
  | 'album'
  | 'genre'
  | 'label'
  | 'year'
  | 'trackNo'
  | 'fileName'
  | 'albumArtist'
  | 'discNo'
  | 'comment'
  | 'duration'

type IBatchRenameTemplateSegment =
  | {
      id: string
      type: 'text'
      value: string
    }
  | {
      id: string
      type: 'token'
      token: IBatchRenameTemplateToken
    }

interface IBatchRenameTemplatePreset {
  id: string
  name: string
  segments: IBatchRenameTemplateSegment[]
  createdAt: number
  updatedAt: number
  isDefault?: boolean
  isBuiltin?: boolean
}

interface IBatchRenameTrackInput {
  order: number
  songListUUID?: string
  songListPath?: string
  filePath: string
  fileName: string
  title?: string
  artist?: string
  album?: string
  genre?: string
  label?: string
  duration?: string
  key?: string
  bpm?: number
}

type IBatchRenamePreviewStatus =
  | 'executable'
  | 'unchanged'
  | 'invalid_chars'
  | 'too_long'
  | 'source_missing'
  | 'invalid_name'

interface IBatchRenamePreviewItem {
  id: string
  order: number
  songListUUID?: string
  filePath: string
  originalFileName: string
  targetBaseName: string
  targetFileName: string
  status: IBatchRenamePreviewStatus
  track: IBatchRenameTrackInput
}

interface IBatchRenamePreviewResult {
  items: IBatchRenamePreviewItem[]
}

type IBatchRenameExecutionStatus =
  | 'success'
  | 'hand_skipped'
  | 'unchanged'
  | 'invalid_chars'
  | 'too_long'
  | 'invalid_name'
  | 'source_missing'
  | 'file_in_use'
  | 'permission_denied'
  | 'target_exists'
  | 'cancelled'
  | 'failed'

interface IBatchRenameExecutionRequestItem extends IBatchRenamePreviewItem {
  selected: boolean
}

interface IBatchRenameExecutionResultItem {
  id: string
  order: number
  filePath: string
  originalFileName: string
  targetFileName: string
  status: IBatchRenameExecutionStatus
}

interface IBatchRenameExecutionSummary {
  total: number
  success: number
  failed: number
  skipped: number
  cancelled: number
}

interface IBatchRenameExecutionResult {
  summary: IBatchRenameExecutionSummary
  items: IBatchRenameExecutionResultItem[]
  updates: Array<{
    song: ISongInfo
    oldFilePath: string
  }>
}

// 元数据更新请求结构
interface ITrackMetadataUpdatePayload {
  filePath: string
  newBaseName?: string
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  trackNo?: number | null
  trackTotal?: number | null
  discNo?: number | null
  discTotal?: number | null
  year?: string
  genre?: string
  composer?: string
  lyricist?: string
  label?: string
  isrc?: string
  comment?: string
  lyrics?: string
  coverDataUrl?: string | null
  // 标记此次更新来自 MusicBrainz 补齐（自动或手动搜索）
  markAsAutoFilled?: boolean
}

type IMetadataAutoFillStatus = 'applied' | 'no-match' | 'skipped' | 'error' | 'cancelled'
type IMetadataAutoFillMethod = 'fingerprint' | 'search'

interface IMetadataAutoFillRequest {
  filePaths: string[]
  progressId?: string
}

interface IMetadataAutoFillItemResult {
  filePath: string
  displayName: string
  status: IMetadataAutoFillStatus
  method?: IMetadataAutoFillMethod
  messageCode?: string
  messageDetail?: string
  updatedSongInfo?: ISongInfo
  oldFilePath?: string
}

interface IMetadataAutoFillSummary {
  total: number
  applied: number
  fingerprintApplied: number
  searchApplied: number
  noMatch: number
  skipped: number
  cancelled: number
  errors: number
  durationMs: number
  progressId: string
  items: IMetadataAutoFillItemResult[]
}

interface ILayoutConfig {
  libraryAreaWidth: number
  songsAreaSplitLeftRatio: number
  isMaxMainWin: boolean
  mainWindowWidth: number
  mainWindowHeight: number
  mainWindowSizeMigrationVersion?: number
  miniPlayerWindowX?: number
  miniPlayerWindowY?: number
  miniPlayerWindowWidth?: number
  miniPlayerWindowAlwaysOnTop?: boolean
}

type PlayerGlobalShortcutAction =
  | 'togglePlayPause'
  | 'fastForward'
  | 'fastBackward'
  | 'nextSong'
  | 'previousSong'

interface IPlayerGlobalShortcuts {
  togglePlayPause: string
  fastForward: string
  fastBackward: string
  nextSong: string
  previousSong: string
  // 快速定位前缀修饰键；空串表示关闭。键位固定为 `/~、1-9、0。
  seekPercentModifier: string
}

type TitleAudioVisualizerMode = 'bars' | 'line'

interface ISettingConfig {
  platform: 'win32' | 'darwin'
  language: '' | 'enUS' | 'zhCN'
  mainWindowBrowseMode?: 'browser' | 'horizontal' | 'edit'
  // 主题模式：system（跟随系统）/ light（浅色）/ dark（深色）
  themeMode?: 'system' | 'light' | 'dark'
  // 自定义主题强调色（#rrggbb）；缺省/非法时回退默认蓝 #0078d4
  accentColor?: string
  audioExt: string[]
  databaseUrl: string
  globalCallShortcut: string
  enableWindowScreenshotShortcut?: boolean
  playerGlobalShortcuts: IPlayerGlobalShortcuts
  nextCheckUpdateTime: string
  hiddenPlayControlArea: boolean
  waveformMode?: 'half' | 'full'
  keyDisplayStyle?: 'Classic' | 'Camelot'
  browserPlayerRightTrackInfo?: BrowserPlayerRightTrackInfoField
  // 是否显示闲时分析状态（默认不显示）
  showIdleAnalysisStatus?: boolean
  // Beat This BPM 候选范围；用户选择的范围决定半速/倍速解释。
  analysisBpmRange?: AnalysisBpmRangePresetId
  // 首次/补缺分析弹窗勾选（Key、网格、波形、能量、段落）。
  trackAnalysisSelection?: TrackReanalysisUserSelection
  // 重新分析弹窗勾选（Key、网格、波形、能量、段落）。
  trackReanalysisSelection?: TrackReanalysisUserSelection
  autoPlayNextSong: boolean
  startPlayPercent: number
  endPlayPercent: number
  playbackRangeMode?: PlaybackRangeMode
  playbackRangeSectionKinds?: Array<'intro' | 'groove' | 'breakdown' | 'build' | 'drop' | 'outro'>
  playbackRangeSectionMatchMode?: PlaybackRangeSectionMatchMode
  fastForwardTime: number
  fastBackwardTime: number
  autoScrollToCurrentSong: boolean
  enablePlaybackRange: boolean
  recentDialogSelectedSongListMaxCount: number
  // 音频输出设备 ID，空字符串表示跟随系统默认设备
  audioOutputDeviceId: string
  // 是否显示标题栏右侧音频可视化
  showTitleAudioVisualizer?: boolean
  // 主窗口标题栏音频可视化样式
  mainWindowTitleAudioVisualizerMode?: TitleAudioVisualizerMode
  // Mixtape 窗口标题栏音频可视化样式
  mixtapeWindowTitleAudioVisualizerMode?: TitleAudioVisualizerMode
  // 双轨横推右侧控制竖条是否展开
  horizontalBrowseFaderControlsExpanded?: boolean
  // 错误日志上报设置
  enableErrorReport: boolean
  errorReportUsageMsSinceLastSuccess: number
  errorReportRetryMsSinceLastFailure: number // -1 表示当前无失败等待窗口
  // 是否在重启后保留“曲目筛选条件”（默认不保留）
  persistSongFilters: boolean
  // 是否启用“精选表演者联动”（记录精选曲目的表演者并在筛选库高亮）
  enableCuratedArtistTracking: boolean
  enableExplorerContextMenu?: boolean
  windowsContextMenuSignature?: string
  // 是否在歌单名称后显示曲目数量
  showPlaylistTrackCount: boolean
  // 直写 Rekordbox 时复制歌曲的固定存放目录
  rekordboxDesktopTrackStorageDir?: string
  // 迁移标记：是否已将 .aif/.aiff 默认加入 audioExt（避免重复覆盖用户选择）
  migratedAudioExtAiffAif?: boolean
  // 指纹模式：pcm（解码后内容哈希）或 file（整文件哈希）
  fingerprintMode?: 'pcm' | 'file'
  // 云同步用户 Key（跟资料库走，设置页配置）
  cloudSyncUserKey?: string
  // 是否启用云同步定时循环（默认关闭，跟资料库走）
  cloudSyncAutoEnabled?: boolean
  // 云同步定时间隔（毫秒）；勾选启用后默认 1 小时（跟资料库走）
  cloudSyncAutoIntervalMs?: number
  // 最近一次从服务器发现文件确认可用的云同步服务地址
  cloudSyncLastKnownBaseUrl?: string
  // 是否同步精选库（默认关闭，跟资料库走）
  curatedLibrarySyncEnabled?: boolean
  // 音频转换默认项（记住用户上次选择）
  convertDefaults?: {
    targetFormat:
      | 'mp3'
      | 'flac'
      | 'wav'
      | 'aif'
      | 'aiff'
      | 'ogg'
      | 'opus'
      | 'aac'
      | 'm4a'
      | 'mp4'
      | 'wma'
      | 'ac3'
      | 'dts'
      | 'mka'
      | 'webm'
      | 'wv'
      | 'tta'
    bitrateKbps?: number
    sampleRate?: 44100 | 48000
    channels?: 1 | 2
    preserveMetadata?: boolean
    normalize?: boolean
    strategy: 'new_file' | 'replace'
    overwrite?: boolean
    backupOnReplace?: boolean
    addFingerprint?: boolean
  }
  // “更新日志”窗口记录：最后看到的版本号
  lastSeenWhatsNewVersion?: string
  // 若上次拉取失败，需要下次继续尝试的版本号
  pendingWhatsNewForVersion?: string
  // 上次启动的应用版本（用于升级后清理旧日志）
  lastRunAppVersion?: string
  // AcoustID 客户端 Key（声纹匹配）
  acoustIdClientKey?: string
  // 自动补齐时跳过已补齐过的曲目
  autoFillSkipCompleted?: boolean
  // 当前版本启动阶段是否已经展示过分析运行时下载提示
  analysisRuntimeStartupPromptShownVersion?: string
  // 用户指引身份：Rekordbox / 新用户 / FRKB 老用户；未选择时为 undefined
  userGuideAudience?: 'rekordbox' | 'general' | 'veteran'
  // 已经看过并关掉的分散指引段落
  userGuideDismissedSteps?: Array<
    | 'browser'
    | 'songsSource'
    | 'rekordboxUsb'
    | 'songsList'
    | 'filterCurated'
    | 'setLibrary'
    | 'mixtapeLibrary'
    | 'recordingLibrary'
    | 'horizontal'
    | 'edit'
    | 'mixtapeWindow'
  >
}

interface IMenu {
  menuName: string
  shortcutKey?: string
  disabled?: boolean
  disabledReason?: string
  disabledReasonKey?: string
  disabledStatusKey?: string
  children?: IMenu[]
}

interface IImportSongsFormData {
  filePaths?: string[]
  folderPath?: string[]
  selectedPaths?: string[]
  songListPath: string
  isDeleteSourceFile: boolean
  isComparisonSongFingerprint: boolean
  isPushSongFingerprintLibrary: boolean
  deduplicateMode?: 'library' | 'batch' | 'none'
  songListUUID: string
}

interface ISongsAreaColumn {
  columnName: string
  key: string
  show: boolean
  width: number
  order?: 'asc' | 'desc'
  // 可选：列筛选能力与状态（仅在实现列筛选功能时使用）
  // filterType：'text' 适用于标题/艺人/专辑/流派/厂牌/格式等；'duration' 适用于时长列；'bpm' 适用于 BPM 列；'number' 适用于能量等普通数值列；'date' 适用于加入时间
  filterType?: 'text' | 'duration' | 'bpm' | 'number' | 'date'
  // 是否存在生效的筛选（用于列头图标高亮与关键字展示）
  filterActive?: boolean
  // 文本筛选：关键字（包含匹配，不区分大小写）
  filterValue?: string
  // 文本筛选：排除关键字（包含则剔除，不区分大小写）
  filterExcludeValue?: string
  // 时长筛选：操作符与目标时长（固定 MM:SS 字符串）
  filterOp?: 'eq' | 'gte' | 'lte' | 'between'
  filterDuration?: string
  // 时长范围终点：仅 filterOp === 'between' 时使用
  filterDurationTo?: string
  // 数值筛选：目标数值（支持小数）
  filterNumber?: string
  // 数值范围终点：仅 filterOp === 'between' 时使用
  filterNumberTo?: string
  // 日期筛选：本地时间，优先 YYYY-MM-DD HH:mm:ss；兼容旧的 YYYY-MM-DD（按整天匹配）
  filterDate?: string
  // 日期范围终点：仅 filterOp === 'between' 时使用
  filterDateTo?: string
  // 仅查看精选过的表演者（仅 artist 列使用）
  filterCuratedOnly?: boolean
}

type Icon = {
  name:
    | 'FilterLibrary'
    | 'CuratedLibrary'
    | 'SetLibrary'
    | 'RecordingLibrary'
    | 'MixtapeLibrary'
    | 'RecycleBin'
    | 'ExternalPlaylist'
  grey: string
  white: string
  src: string
  showAlt: boolean
  i18nKey?: string
}
export {
  BeatGridStatus,
  md5,
  IDir,
  ISongInfo,
  ISongHotCue,
  ISongMemoryCue,
  ICuratedArtistFavorite,
  IPioneerPreviewWaveformColumn,
  IPioneerPreviewWaveformData,
  ITrackMetadataDetail,
  IBatchRenameTemplateToken,
  IBatchRenameTemplateSegment,
  IBatchRenameTemplatePreset,
  IBatchRenameTrackInput,
  IBatchRenamePreviewStatus,
  IBatchRenamePreviewItem,
  IBatchRenamePreviewResult,
  IBatchRenameExecutionStatus,
  IBatchRenameExecutionRequestItem,
  IBatchRenameExecutionResultItem,
  IBatchRenameExecutionSummary,
  IBatchRenameExecutionResult,
  IRekordboxSourceKind,
  IRekordboxSourceLibraryType,
  IRekordboxLibraryBrowserState,
  IPioneerDeviceLibraryKind,
  IPioneerPlaylistTreeNode,
  IPioneerPlaylistTrack,
  IRekordboxBeatGridEntry,
  SongStructureAnalysis,
  SongBeatGridMap,
  ITrackMetadataUpdatePayload,
  IMetadataAutoFillRequest,
  IMetadataAutoFillItemResult,
  IMetadataAutoFillSummary,
  ILayoutConfig,
  ISettingConfig,
  IPlayerGlobalShortcuts,
  TitleAudioVisualizerMode,
  PlayerGlobalShortcutAction,
  IMenu,
  IImportSongsFormData,
  ISongsAreaColumn,
  Icon,
  IMusicBrainzSearchPayload,
  IMusicBrainzMatch,
  IMusicBrainzAcoustIdPayload,
  IMusicBrainzSuggestion,
  IMusicBrainzSuggestionResult,
  IMusicBrainzSuggestionParams,
  IMusicBrainzApplyPayload,
  ISimilarTrackSource,
  ISimilarTracksRequest,
  ISimilarTracksSeed,
  ISimilarTrackItem,
  ISimilarTracksProviderStatus,
  ISimilarTracksResult,
  ISimilarTracksBatchSeed,
  ISimilarTracksBatchRequest,
  ISimilarTracksBatchSeedResult,
  ISimilarTracksBatchResult,
  ISimilarTracksPoolItem,
  ISimilarTrackBlockTarget,
  ISimilarTrackBlockResult
}
