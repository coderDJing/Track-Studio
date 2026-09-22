import type { CompactVisualWaveformData } from './compactVisualWaveform'
import type { MiniPlayerTaskProgress } from './miniPlayerTaskProgress'
import type { PlaybackRangeHandleVisual } from './playbackRange'
import type { ISongInfo } from 'src/types/globals'

export type MiniPlayerTransferActionMode = 'move' | 'copy'
export type MiniPlayerTransferTarget =
  | 'FilterLibrary'
  | 'CuratedLibrary'
  | 'SetLibrary'
  | 'MixtapeLibrary'

export const MINI_PLAYER_WINDOW_HEIGHT = 62
export const MINI_PLAYER_WINDOW_MIN_WIDTH = 720
export const MINI_PLAYER_WINDOW_DEFAULT_WIDTH = 960
export const MINI_PLAYER_COVER_POPUP_WIDTH = 300
export const MINI_PLAYER_COVER_POPUP_HEIGHT = 370
export const MINI_PLAYER_COVER_POPUP_GAP = 2
// 主窗口 .songInfo 是 content-box：300×370 内容 + padding-top 10 + 1px 边框
export const MINI_PLAYER_COVER_POPUP_CONTENT_WIDTH = 302
export const MINI_PLAYER_COVER_POPUP_CONTENT_HEIGHT = 382

export const MINI_PLAYER_IPC_PREFIX = 'mini-player:'

export type MiniPlayerWaveformMode = 'half' | 'full'

export type MiniPlayerPioneerPreviewColumn = {
  backHeight: number
  frontHeight: number
  backColorR: number
  backColorG: number
  backColorB: number
  frontColorR: number
  frontColorG: number
  frontColorB: number
}

export type MiniPlayerPioneerPreviewWaveform = {
  style: 'blue' | 'rgb'
  analyzeFilePath: string
  previewFilePath: string
  columnCount: number
  maxHeight: number
  columns: MiniPlayerPioneerPreviewColumn[]
}

export type MiniPlayerHostState = {
  song: ISongInfo | null
  playingSongListUUID: string
  isPlaying: boolean
  currentSeconds: number
  durationSeconds: number
  volume: number
  waveformMode: MiniPlayerWaveformMode
  compactVisualWaveform: CompactVisualWaveformData | null
  pioneerPreviewWaveform: MiniPlayerPioneerPreviewWaveform | null
  playbackRange: PlaybackRangeHandleVisual
  canDeleteAllAbove: boolean
  deleteAllAboveCount: number
  taskProgress: MiniPlayerTaskProgress
}

export type MiniPlayerPlayhead = {
  currentSeconds: number
  durationSeconds: number
  isPlaying: boolean
  volume: number
  sequence?: number
  publishedAtMs?: number
}

export type MiniPlayerPlayheadGapDiagnostic = {
  delayedMs: number
  currentSeconds: number
  durationSeconds: number
  detectedAtMs?: number
  lastUpdateSource?: 'playhead' | 'host-state'
  lastUpdateSequence?: number | null
  lastUpdatePublishedAtMs?: number | null
  lastUpdateReceivedAtMs?: number | null
}

export type MiniPlayerSession = {
  open: boolean
  alwaysOnTop: boolean
}

export type MiniPlayerCoverPopupAnchor = {
  x: number
  y: number
  width: number
  height: number
}

export type MiniPlayerCoverPopupPayload = {
  filePath: string
  title: string
  artist: string
  album: string
  label: string
  songListUUID: string
  rootDir: string
  anchor: MiniPlayerCoverPopupAnchor
}

export type MiniPlayerOverlayKind = 'menu' | 'song-list' | 'confirm' | 'export'

export type MiniPlayerOverlayMenuAction =
  | 'export'
  | 'moveToFilter'
  | 'moveToCurated'
  | 'copyToFilter'
  | 'copyToCurated'
  | 'addToSet'
  | 'addToMixtape'
  | 'delete'
  | 'deleteAllAbove'
  | 'showInExplorer'

export type MiniPlayerOverlayMenuPayload = {
  isReadOnly: boolean
  filePath: string
  canDeleteAllAbove: boolean
}

export type MiniPlayerOverlaySongListPayload = {
  libraryName: MiniPlayerTransferTarget
  actionMode: MiniPlayerTransferActionMode
}

export type MiniPlayerOverlayConfirmPayload = {
  title: string
  content: string[]
  confirmShow?: boolean
  innerHeight?: number
  innerWidth?: number
}

export type MiniPlayerOverlayExportPayload = {
  title: string
  forceCopyOnly: boolean
}

export type MiniPlayerOverlayState = {
  requestId: string
  kind: MiniPlayerOverlayKind
  payload:
    | MiniPlayerOverlayMenuPayload
    | MiniPlayerOverlaySongListPayload
    | MiniPlayerOverlayConfirmPayload
    | MiniPlayerOverlayExportPayload
  songListHeightPx?: number
}

export type MiniPlayerOverlayResult =
  | { type: 'dismiss' }
  | { type: 'menu'; action: MiniPlayerOverlayMenuAction }
  | { type: 'song-list'; uuid: string }
  | { type: 'confirm'; ok: boolean }
  | { type: 'export'; folderPath: string; deleteAfter: boolean }

export type MiniPlayerTooltipPayload = {
  id: number
  title: string
  shortcut: string
  maxWidth: number
  anchor: MiniPlayerCoverPopupAnchor
}

export const MINI_PLAYER_OVERLAY_MENU_WIDTH = 280
export const MINI_PLAYER_OVERLAY_MENU_HEIGHT = 372
export const MINI_PLAYER_OVERLAY_DIALOG_WIDTH = 302
export const MINI_PLAYER_OVERLAY_CONFIRM_WIDTH = 402
export const MINI_PLAYER_OVERLAY_CONFIRM_HEIGHT = 222
export const MINI_PLAYER_OVERLAY_EXPORT_WIDTH = 452
export const MINI_PLAYER_OVERLAY_EXPORT_HEIGHT = 302
export const MINI_PLAYER_OVERLAY_GAP = 2

export type MiniPlayerCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'togglePlayPause' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'fastForward' }
  | { type: 'fastBackward' }
  | { type: 'seekSeconds'; seconds: number }
  // percent 为 0-1 比例；大于 1 时按 0-100 百分比兼容
  | { type: 'seekPercent'; percent: number }
  | { type: 'setPlaybackRangeStartPercent'; value: number }
  | { type: 'setPlaybackRangeEndPercent'; value: number }
  | { type: 'savePlaybackRange' }
  | { type: 'togglePlaybackRange' }
  | { type: 'setVolume'; value: number }
  | { type: 'delete' }
  | { type: 'deleteAllAbove'; confirmed?: boolean }
  | {
      type: 'export'
      folderPath: string
      deleteAfter: boolean
    }
  | {
      type: 'applyTransfer'
      libraryName: MiniPlayerTransferTarget
      actionMode: MiniPlayerTransferActionMode
      targetUuid: string
    }

export const normalizeMiniPlayerSeekRatio = (percent: unknown) => {
  const value = Number(percent)
  if (!Number.isFinite(value)) return 0
  if (value > 1) return Math.min(Math.max(value, 0), 100) / 100
  return Math.min(Math.max(value, 0), 1)
}

export const MINI_PLAYER_CHANNELS = {
  open: 'mini-player:open',
  close: 'mini-player:close',
  toggle: 'mini-player:toggle',
  isOpen: 'mini-player:is-open',
  setAlwaysOnTop: 'mini-player:set-always-on-top',
  setPopupHeight: 'mini-player:set-popup-height',
  hostState: 'mini-player:host-state',
  playhead: 'mini-player:playhead',
  playheadGap: 'mini-player:playhead-gap',
  taskProgress: 'mini-player:task-progress',
  command: 'mini-player:command',
  rendererReady: 'mini-player:renderer-ready',
  session: 'mini-player:session',
  windowFocus: 'mini-player:window-focus',
  showCoverPopup: 'mini-player:show-cover-popup',
  hideCoverPopup: 'mini-player:hide-cover-popup',
  coverPopupState: 'mini-player:cover-popup-state',
  coverPopupPointer: 'mini-player:cover-popup-pointer',
  coverPopupReady: 'mini-player:cover-popup-ready',
  coverPopupContentSize: 'mini-player:cover-popup-content-size',
  focusCoverPopup: 'mini-player:focus-cover-popup',
  showOverlay: 'mini-player:show-overlay',
  hideOverlay: 'mini-player:hide-overlay',
  overlayState: 'mini-player:overlay-state',
  overlayReady: 'mini-player:overlay-ready',
  overlayComplete: 'mini-player:overlay-complete',
  overlayContentSize: 'mini-player:overlay-content-size',
  showTooltip: 'mini-player:show-tooltip',
  hideTooltip: 'mini-player:hide-tooltip',
  tooltipState: 'mini-player:tooltip-state',
  tooltipReady: 'mini-player:tooltip-ready',
  tooltipContentSize: 'mini-player:tooltip-content-size',
  requestKeyboardFocus: 'mini-player:request-keyboard-focus'
} as const
