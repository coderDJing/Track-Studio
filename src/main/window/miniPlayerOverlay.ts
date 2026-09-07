import { BrowserWindow, ipcMain, type Rectangle } from 'electron'
import { is } from '@electron-toolkit/utils'
import path = require('path')
import { log } from '../log'
import store from '../store'
import { restrictExternalNavigation } from './externalNavigation'
import {
  applyExactContentBounds,
  resolveAnchoredPopupBounds,
  resolveContentBoundsForMove,
  resolveWorkAreaNear,
  toScreenAnchor
} from './miniPlayerPopupLayout'
import {
  MINI_PLAYER_CHANNELS,
  MINI_PLAYER_OVERLAY_DIALOG_WIDTH,
  MINI_PLAYER_OVERLAY_EXPORT_HEIGHT,
  MINI_PLAYER_OVERLAY_EXPORT_WIDTH,
  MINI_PLAYER_OVERLAY_GAP,
  MINI_PLAYER_OVERLAY_MENU_HEIGHT,
  MINI_PLAYER_OVERLAY_MENU_WIDTH,
  type MiniPlayerCoverPopupAnchor,
  type MiniPlayerOverlayConfirmPayload,
  type MiniPlayerOverlayExportPayload,
  type MiniPlayerOverlayKind,
  type MiniPlayerOverlayMenuAction,
  type MiniPlayerOverlayMenuPayload,
  type MiniPlayerOverlayResult,
  type MiniPlayerOverlaySongListPayload,
  type MiniPlayerOverlayState,
  type MiniPlayerTooltipPayload
} from '../../shared/miniPlayerWindow'

let overlayWindow: BrowserWindow | null = null
let tooltipWindow: BrowserWindow | null = null
let getMiniWindow: () => BrowserWindow | null = () => null
let resolveAlwaysOnTop: () => boolean = () => true
let ipcBound = false
let requestSeq = 0
let pendingRequestId = ''
let pendingResolve: ((result: MiniPlayerOverlayResult) => void) | null = null
let latestOverlay: {
  state: MiniPlayerOverlayState
  localAnchor: MiniPlayerCoverPopupAnchor
  size: { width: number; height: number }
} | null = null
let latestTooltip: {
  payload: MiniPlayerTooltipPayload
  source: BrowserWindow
} | null = null
let tooltipMeasuredSize: { width: number; height: number } | null = null
let ignoreMenuBlurUntil = 0

const isUsableWindow = (target: BrowserWindow | null): target is BrowserWindow =>
  !!target && !target.isDestroyed()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const nextRequestId = () => `overlay-${++requestSeq}`

const themeBackground = () => (store.settingConfig?.themeMode === 'light' ? '#f3f3f3' : '#1f1f1f')

const applyAlwaysOnTop = (target: BrowserWindow) => {
  const enabled = resolveAlwaysOnTop()
  try {
    if (enabled) {
      target.setAlwaysOnTop(true, 'pop-up-menu')
    } else {
      target.setAlwaysOnTop(false)
    }
  } catch {
    target.setAlwaysOnTop(enabled)
  }
}

const showInactive = (target: BrowserWindow) => {
  try {
    target.showInactive()
  } catch {
    target.show()
  }
}

const toAnchor = (value: unknown): MiniPlayerCoverPopupAnchor | null => {
  if (!isRecord(value)) return null
  const x = Number(value.x)
  const y = Number(value.y)
  const width = Number(value.width)
  const height = Number(value.height)
  if (![x, y, width, height].every((item) => Number.isFinite(item))) return null
  return { x, y, width: Math.max(1, width), height: Math.max(1, height) }
}

const parseMenuPayload = (value: unknown): MiniPlayerOverlayMenuPayload | null => {
  if (!isRecord(value)) return null
  return {
    isReadOnly: !!value.isReadOnly,
    filePath: String(value.filePath || ''),
    canDeleteAllAbove: !!value.canDeleteAllAbove
  }
}

const parseSongListPayload = (value: unknown): MiniPlayerOverlaySongListPayload | null => {
  if (!isRecord(value)) return null
  const libraryName = String(value.libraryName || '')
  const actionMode = value.actionMode === 'copy' ? 'copy' : 'move'
  if (
    libraryName !== 'FilterLibrary' &&
    libraryName !== 'CuratedLibrary' &&
    libraryName !== 'SetLibrary' &&
    libraryName !== 'MixtapeLibrary'
  ) {
    return null
  }
  return { libraryName, actionMode }
}

const parseConfirmPayload = (value: unknown): MiniPlayerOverlayConfirmPayload | null => {
  if (!isRecord(value)) return null
  const content = Array.isArray(value.content)
    ? value.content.map((item) => String(item ?? ''))
    : []
  return {
    title: String(value.title || ''),
    content,
    confirmShow: value.confirmShow !== false,
    innerHeight: Number(value.innerHeight) || undefined,
    innerWidth: Number(value.innerWidth) || undefined
  }
}

const parseExportPayload = (value: unknown): MiniPlayerOverlayExportPayload | null => {
  if (!isRecord(value)) return null
  return {
    title: String(value.title || 'tracks.title'),
    forceCopyOnly: !!value.forceCopyOnly
  }
}

const parseOverlayKind = (value: unknown): MiniPlayerOverlayKind | null => {
  if (value === 'menu' || value === 'song-list' || value === 'confirm' || value === 'export') {
    return value
  }
  return null
}

const MENU_ACTIONS: MiniPlayerOverlayMenuAction[] = [
  'export',
  'moveToFilter',
  'moveToCurated',
  'copyToFilter',
  'copyToCurated',
  'addToSet',
  'addToMixtape',
  'delete',
  'deleteAllAbove',
  'showInExplorer'
]

const parseOverlayResult = (value: unknown): MiniPlayerOverlayResult | null => {
  if (!isRecord(value)) return null
  const type = String(value.type || '')
  if (type === 'dismiss') return { type: 'dismiss' }
  if (type === 'menu') {
    const action = String(value.action || '') as MiniPlayerOverlayMenuAction
    if (!MENU_ACTIONS.includes(action)) return null
    return { type: 'menu', action }
  }
  if (type === 'song-list') {
    const uuid = String(value.uuid || '').trim()
    if (!uuid) return null
    return { type: 'song-list', uuid }
  }
  if (type === 'confirm') return { type: 'confirm', ok: !!value.ok }
  if (type === 'export') {
    const folderPath = String(value.folderPath || '').trim()
    if (!folderPath) return null
    return { type: 'export', folderPath, deleteAfter: !!value.deleteAfter }
  }
  return null
}

const overlaySizeForKind = (state: MiniPlayerOverlayState, anchor: MiniPlayerCoverPopupAnchor) => {
  if (state.kind === 'menu') {
    return { width: MINI_PLAYER_OVERLAY_MENU_WIDTH, height: MINI_PLAYER_OVERLAY_MENU_HEIGHT }
  }
  if (state.kind === 'confirm') {
    const payload = state.payload as MiniPlayerOverlayConfirmPayload
    return {
      width: Math.ceil((payload.innerWidth || 400) + 2),
      height: Math.ceil((payload.innerHeight || 220) + 2)
    }
  }
  if (state.kind === 'export') {
    return { width: MINI_PLAYER_OVERLAY_EXPORT_WIDTH, height: MINI_PLAYER_OVERLAY_EXPORT_HEIGHT }
  }
  const workArea = resolveWorkAreaNear(anchor)
  return {
    width: MINI_PLAYER_OVERLAY_DIALOG_WIDTH,
    height: Math.max(1, Math.round(workArea.height * 0.7))
  }
}

const resolveMiniContentBounds = (windowBounds?: Rectangle | null) => {
  const mini = getMiniWindow()
  if (!isUsableWindow(mini)) return null
  const content = mini.getContentBounds()
  if (!windowBounds) return content
  return resolveContentBoundsForMove(mini.getBounds(), content, windowBounds)
}

const resolveOverlayScreenAnchor = (
  localAnchor: MiniPlayerCoverPopupAnchor,
  windowBounds?: Rectangle | null
) => {
  const content = resolveMiniContentBounds(windowBounds)
  if (!content) return null
  return toScreenAnchor(content, localAnchor)
}

const loadPopupUrl = (target: BrowserWindow, fileName: string) => {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    target.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${fileName}`)
    return
  }
  target.loadFile(path.join(__dirname, `../renderer/${fileName}`))
}

const createFramelessPopup = (size: { width: number; height: number }, fileName: string) => {
  const target = new BrowserWindow({
    width: size.width,
    height: size.height,
    useContentSize: true,
    frame: false,
    transparent: false,
    show: false,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: true,
    hasShadow: true,
    backgroundColor: themeBackground(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false,
      backgroundThrottling: false
    }
  })
  applyAlwaysOnTop(target)
  try {
    target.setSkipTaskbar(true)
  } catch {}
  restrictExternalNavigation(target.webContents)
  target.setMenu(null)
  target.webContents.on('render-process-gone', (_event, details) => {
    log.error(`[mini-player-overlay] ${fileName} render-process-gone`, details)
  })
  loadPopupUrl(target, fileName)
  return target
}

const hideOverlayWindow = () => {
  if (!isUsableWindow(overlayWindow)) return
  try {
    overlayWindow.webContents.send(MINI_PLAYER_CHANNELS.overlayState, null)
  } catch {}
  try {
    overlayWindow.hide()
  } catch {}
}

const restoreMiniPlayerFocus = () => {
  const mini = getMiniWindow()
  if (!isUsableWindow(mini) || !mini.isVisible()) return
  try {
    mini.focus()
  } catch {}
  try {
    mini.webContents.focus()
  } catch {}
}

const finishOverlay = (result: MiniPlayerOverlayResult) => {
  const kind = latestOverlay?.state.kind
  const shouldRestoreMiniFocus = kind === 'song-list' || kind === 'confirm' || kind === 'export'
  const resolve = pendingResolve
  pendingResolve = null
  pendingRequestId = ''
  latestOverlay = null
  hideOverlayWindow()
  if (shouldRestoreMiniFocus) restoreMiniPlayerFocus()
  resolve?.(result)
}

const stealPreviousOverlay = () => {
  if (!pendingResolve) return
  const resolve = pendingResolve
  pendingResolve = null
  pendingRequestId = ''
  resolve({ type: 'dismiss' })
}

const sendOverlayState = (state: MiniPlayerOverlayState) => {
  if (!isUsableWindow(overlayWindow)) return
  try {
    overlayWindow.webContents.send(MINI_PLAYER_CHANNELS.overlayState, state)
  } catch {}
}

const applyOverlayBounds = (windowBounds?: Rectangle | null, options?: { notify?: boolean }) => {
  if (!latestOverlay || !isUsableWindow(overlayWindow)) return false
  const screenAnchor = resolveOverlayScreenAnchor(latestOverlay.localAnchor, windowBounds)
  if (!screenAnchor) return false
  applyExactContentBounds(
    overlayWindow,
    resolveAnchoredPopupBounds(screenAnchor, latestOverlay.size, MINI_PLAYER_OVERLAY_GAP)
  )
  applyAlwaysOnTop(overlayWindow)
  if (options?.notify !== false) sendOverlayState(latestOverlay.state)
  return true
}

const presentOverlay = (target: BrowserWindow, kind: MiniPlayerOverlayKind) => {
  if (kind === 'menu') {
    ignoreMenuBlurUntil = Date.now() + 160
  }
  target.show()
  target.focus()
  try {
    target.webContents.focus()
  } catch {}
}

const ensureOverlayWindow = () => {
  if (isUsableWindow(overlayWindow)) return overlayWindow
  overlayWindow = createFramelessPopup(
    { width: MINI_PLAYER_OVERLAY_MENU_WIDTH, height: MINI_PLAYER_OVERLAY_MENU_HEIGHT },
    'miniPlayerOverlay.html'
  )
  overlayWindow.on('closed', () => {
    overlayWindow = null
  })
  overlayWindow.on('blur', () => {
    if (!latestOverlay || latestOverlay.state.kind !== 'menu') return
    if (Date.now() < ignoreMenuBlurUntil) return
    finishOverlay({ type: 'dismiss' })
  })
  overlayWindow.once('ready-to-show', () => {
    if (!latestOverlay || !isUsableWindow(overlayWindow)) return
    if (!applyOverlayBounds()) return
    presentOverlay(overlayWindow, latestOverlay.state.kind)
  })
  return overlayWindow
}

const showOverlayWindow = (
  state: MiniPlayerOverlayState,
  localAnchor: MiniPlayerCoverPopupAnchor
) => {
  const screenAnchor = resolveOverlayScreenAnchor(localAnchor)
  const size = overlaySizeForKind(state, screenAnchor || localAnchor)
  const nextState = state.kind === 'song-list' ? { ...state, songListHeightPx: size.height } : state
  latestOverlay = { state: nextState, localAnchor, size }
  const target = ensureOverlayWindow()
  if (target.webContents.isLoading()) return
  applyOverlayBounds()
  presentOverlay(target, nextState.kind)
}

export const hideMiniPlayerOverlay = () => {
  finishOverlay({ type: 'dismiss' })
}

export const hideMiniPlayerTooltip = () => {
  latestTooltip = null
  tooltipMeasuredSize = null
  if (!isUsableWindow(tooltipWindow)) return
  sendTooltipState(null)
  try {
    tooltipWindow.hide()
  } catch {}
}

export const destroyMiniPlayerOverlay = () => {
  stealPreviousOverlay()
  latestOverlay = null
  const overlay = overlayWindow
  overlayWindow = null
  if (isUsableWindow(overlay)) {
    try {
      overlay.destroy()
    } catch {}
  }
  hideMiniPlayerTooltip()
  const tooltip = tooltipWindow
  tooltipWindow = null
  if (isUsableWindow(tooltip)) {
    try {
      tooltip.destroy()
    } catch {}
  }
}

export const repositionMiniPlayerOverlay = (windowBounds?: Rectangle) => {
  if (!latestOverlay || !isUsableWindow(overlayWindow) || !overlayWindow.isVisible()) return
  applyOverlayBounds(windowBounds)
}

const parseTooltipPayload = (value: unknown): MiniPlayerTooltipPayload | null => {
  if (!isRecord(value)) return null
  const anchor = toAnchor(value.anchor)
  if (!anchor) return null
  return {
    id: Number(value.id) || 0,
    title: String(value.title || ''),
    shortcut: String(value.shortcut || ''),
    maxWidth: Math.max(80, Number(value.maxWidth) || 280),
    anchor
  }
}

const sendTooltipState = (payload: MiniPlayerTooltipPayload | null) => {
  if (!isUsableWindow(tooltipWindow)) return
  try {
    tooltipWindow.webContents.send(MINI_PLAYER_CHANNELS.tooltipState, payload)
  } catch {}
}

const applyTooltipBounds = (
  size?: { width: number; height: number },
  options?: { notify?: boolean }
) => {
  if (!latestTooltip || !isUsableWindow(tooltipWindow)) return false
  const source = latestTooltip.source
  if (!isUsableWindow(source)) return false
  const screenAnchor = toScreenAnchor(source.getContentBounds(), latestTooltip.payload.anchor)
  const nextSize = size ||
    tooltipMeasuredSize || {
      width: latestTooltip.payload.maxWidth,
      height: 48
    }
  applyExactContentBounds(
    tooltipWindow,
    resolveAnchoredPopupBounds(
      screenAnchor,
      { width: Math.max(40, nextSize.width), height: Math.max(20, nextSize.height) },
      8
    )
  )
  applyAlwaysOnTop(tooltipWindow)
  if (options?.notify !== false) sendTooltipState(latestTooltip.payload)
  return true
}

const ensureTooltipWindow = () => {
  if (isUsableWindow(tooltipWindow)) return tooltipWindow
  tooltipWindow = createFramelessPopup({ width: 280, height: 48 }, 'miniPlayerTooltip.html')
  tooltipWindow.setIgnoreMouseEvents(true, { forward: true })
  tooltipWindow.on('closed', () => {
    tooltipWindow = null
  })
  tooltipWindow.once('ready-to-show', () => {
    if (!latestTooltip || !isUsableWindow(tooltipWindow)) return
    if (!applyTooltipBounds()) return
    showInactive(tooltipWindow)
  })
  return tooltipWindow
}

const showTooltipWindow = (payload: MiniPlayerTooltipPayload, source: BrowserWindow) => {
  latestTooltip = { payload, source }
  tooltipMeasuredSize = null
  const target = ensureTooltipWindow()
  if (target.webContents.isLoading()) return
  applyTooltipBounds({ width: payload.maxWidth, height: 48 })
  showInactive(target)
}

export const bindMiniPlayerOverlay = (params: {
  getMiniWindow: () => BrowserWindow | null
  resolveAlwaysOnTop: () => boolean
}) => {
  getMiniWindow = params.getMiniWindow
  resolveAlwaysOnTop = params.resolveAlwaysOnTop
  if (ipcBound) return
  ipcBound = true

  ipcMain.handle(MINI_PLAYER_CHANNELS.showOverlay, async (_event, raw: unknown) => {
    if (!isRecord(raw)) return { type: 'dismiss' } satisfies MiniPlayerOverlayResult
    const kind = parseOverlayKind(raw.kind)
    const anchor = toAnchor(raw.anchor)
    if (!kind || !anchor) return { type: 'dismiss' } satisfies MiniPlayerOverlayResult
    let payload:
      | MiniPlayerOverlayMenuPayload
      | MiniPlayerOverlaySongListPayload
      | MiniPlayerOverlayConfirmPayload
      | MiniPlayerOverlayExportPayload
      | null = null
    if (kind === 'menu') payload = parseMenuPayload(raw.payload)
    else if (kind === 'song-list') payload = parseSongListPayload(raw.payload)
    else if (kind === 'confirm') payload = parseConfirmPayload(raw.payload)
    else payload = parseExportPayload(raw.payload)
    if (!payload) return { type: 'dismiss' } satisfies MiniPlayerOverlayResult
    stealPreviousOverlay()
    hideMiniPlayerTooltip()
    const requestId = nextRequestId()
    return await new Promise<MiniPlayerOverlayResult>((resolve) => {
      pendingResolve = resolve
      pendingRequestId = requestId
      showOverlayWindow({ requestId, kind, payload }, anchor)
    })
  })

  ipcMain.handle(MINI_PLAYER_CHANNELS.hideOverlay, () => {
    finishOverlay({ type: 'dismiss' })
    return true
  })

  ipcMain.on(MINI_PLAYER_CHANNELS.overlayReady, () => {
    if (!latestOverlay || !isUsableWindow(overlayWindow)) return
    if (!applyOverlayBounds()) return
    presentOverlay(overlayWindow, latestOverlay.state.kind)
  })

  ipcMain.handle(MINI_PLAYER_CHANNELS.overlayComplete, (_event, raw: unknown) => {
    if (!isRecord(raw) || String(raw.requestId || '') !== pendingRequestId) return false
    const result = parseOverlayResult(raw.result)
    if (!result) return false
    finishOverlay(result)
    return true
  })

  ipcMain.on(MINI_PLAYER_CHANNELS.overlayContentSize, (_event, raw: unknown) => {
    if (!latestOverlay || !isRecord(raw)) return
    const width = Math.ceil(Number(raw.width) || 0)
    const height = Math.ceil(Number(raw.height) || 0)
    if (width < 80 || height < 40) return
    if (
      Math.abs(latestOverlay.size.width - width) < 1 &&
      Math.abs(latestOverlay.size.height - height) < 1
    ) {
      return
    }
    latestOverlay.size = { width, height }
    applyOverlayBounds(null, { notify: false })
  })

  ipcMain.handle(MINI_PLAYER_CHANNELS.showTooltip, (event, raw: unknown) => {
    const payload = parseTooltipPayload(raw)
    const source = BrowserWindow.fromWebContents(event.sender)
    if (!payload || !source || !isUsableWindow(source)) return false
    const overlayBlocksMiniTooltip =
      !!latestOverlay && latestOverlay.state.kind !== 'menu' && source !== overlayWindow
    if (overlayBlocksMiniTooltip) return false
    showTooltipWindow(payload, source)
    return true
  })

  ipcMain.on(MINI_PLAYER_CHANNELS.hideTooltip, (_event, raw: unknown) => {
    const hideId = isRecord(raw) ? Number(raw.id) || 0 : 0
    if (hideId && latestTooltip && latestTooltip.payload.id !== hideId) return
    hideMiniPlayerTooltip()
  })

  ipcMain.on(MINI_PLAYER_CHANNELS.tooltipReady, () => {
    if (!latestTooltip || !isUsableWindow(tooltipWindow)) return
    if (!applyTooltipBounds()) return
    showInactive(tooltipWindow)
  })

  ipcMain.on(MINI_PLAYER_CHANNELS.tooltipContentSize, (_event, raw: unknown) => {
    if (!latestTooltip || !isRecord(raw)) return
    const width = Math.ceil(Number(raw.width) || 0)
    const height = Math.ceil(Number(raw.height) || 0)
    if (width < 40 || height < 20) return
    if (
      tooltipMeasuredSize &&
      Math.abs(tooltipMeasuredSize.width - width) < 1 &&
      Math.abs(tooltipMeasuredSize.height - height) < 1
    ) {
      return
    }
    tooltipMeasuredSize = { width, height }
    applyTooltipBounds(tooltipMeasuredSize, { notify: false })
  })
}
