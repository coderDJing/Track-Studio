import { BrowserWindow, ipcMain, screen, type Rectangle } from 'electron'
import { is } from '@electron-toolkit/utils'
import path = require('path')
import { log } from '../log'
import store from '../store'
import { restrictExternalNavigation } from './externalNavigation'
import {
  applyExactContentBounds,
  resolveAnchoredPopupBounds,
  resolveContentBoundsForMove,
  toScreenAnchor
} from './miniPlayerPopupLayout'
import { isPointWithinCoverPopupHoverRegion } from './miniPlayerCoverPopupHover'
import {
  MINI_PLAYER_CHANNELS,
  MINI_PLAYER_COVER_POPUP_CONTENT_HEIGHT,
  MINI_PLAYER_COVER_POPUP_CONTENT_WIDTH,
  MINI_PLAYER_COVER_POPUP_GAP,
  type MiniPlayerCoverPopupAnchor,
  type MiniPlayerCoverPopupPayload
} from '../../shared/miniPlayerWindow'

let coverPopupWindow: BrowserWindow | null = null
let getMiniWindow: () => BrowserWindow | null = () => null
let resolveAlwaysOnTop: () => boolean = () => true
let ipcBound = false
let latestPayload: MiniPlayerCoverPopupPayload | null = null
let contentSize = {
  width: MINI_PLAYER_COVER_POPUP_CONTENT_WIDTH,
  height: MINI_PLAYER_COVER_POPUP_CONTENT_HEIGHT
}
const COVER_POPUP_AUTO_HIDE_POLL_MS = 100
const COVER_POPUP_AUTO_HIDE_DELAY_MS = 350
const COVER_POPUP_HOVER_MARGIN = 3
let coverPopupAutoHideTimer: ReturnType<typeof setInterval> | null = null
let pointerOutsideHoverRegionSince: number | null = null

const isUsableWindow = (target: BrowserWindow | null): target is BrowserWindow =>
  !!target && !target.isDestroyed()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const toAnchor = (value: unknown): MiniPlayerCoverPopupAnchor | null => {
  if (!isRecord(value)) return null
  const x = Number(value.x)
  const y = Number(value.y)
  const width = Number(value.width)
  const height = Number(value.height)
  if (![x, y, width, height].every((item) => Number.isFinite(item))) return null
  return {
    x,
    y,
    width: Math.max(1, width),
    height: Math.max(1, height)
  }
}

const parsePayload = (value: unknown): MiniPlayerCoverPopupPayload | null => {
  if (!isRecord(value)) return null
  const filePath = String(value.filePath || '').trim()
  const anchor = toAnchor(value.anchor)
  if (!filePath || !anchor) return null
  return {
    filePath,
    title: String(value.title || ''),
    artist: String(value.artist || ''),
    album: String(value.album || ''),
    label: String(value.label || ''),
    songListUUID: String(value.songListUUID || ''),
    rootDir: String(value.rootDir || ''),
    anchor
  }
}

const resolveContentBounds = (windowBounds?: Rectangle | null) => {
  const mini = getMiniWindow()
  if (!isUsableWindow(mini)) return null
  const content = mini.getContentBounds()
  if (!windowBounds) return content
  return resolveContentBoundsForMove(mini.getBounds(), content, windowBounds)
}

const resolveScreenAnchor = (
  localAnchor: MiniPlayerCoverPopupAnchor,
  windowBounds?: Rectangle | null
) => {
  const content = resolveContentBounds(windowBounds)
  if (!content) return null
  return toScreenAnchor(content, localAnchor)
}

const defaultContentSize = () => ({
  width: MINI_PLAYER_COVER_POPUP_CONTENT_WIDTH,
  height: MINI_PLAYER_COVER_POPUP_CONTENT_HEIGHT
})

const resolvePopupBounds = (anchor: MiniPlayerCoverPopupAnchor) =>
  resolveAnchoredPopupBounds(anchor, contentSize, MINI_PLAYER_COVER_POPUP_GAP)

const applyAlwaysOnTop = (target: BrowserWindow) => {
  const enabled = resolveAlwaysOnTop()
  try {
    if (enabled) {
      // 比小窗的 floating 更高一层，避免弹出窗被小窗盖住
      target.setAlwaysOnTop(true, 'pop-up-menu')
    } else {
      target.setAlwaysOnTop(false)
    }
  } catch {
    target.setAlwaysOnTop(enabled)
  }
}

const raisePopup = (target: BrowserWindow) => {
  try {
    target.moveTop()
  } catch {}
}

const showInactive = (target: BrowserWindow) => {
  try {
    target.showInactive()
  } catch {
    target.show()
  }
}

const sendPopupState = (payload: MiniPlayerCoverPopupPayload) => {
  if (!isUsableWindow(coverPopupWindow)) return
  try {
    coverPopupWindow.webContents.send(MINI_PLAYER_CHANNELS.coverPopupState, payload)
  } catch {}
}

const stopCoverPopupAutoHideMonitor = () => {
  if (coverPopupAutoHideTimer) {
    clearInterval(coverPopupAutoHideTimer)
    coverPopupAutoHideTimer = null
  }
  pointerOutsideHoverRegionSince = null
}

const loadCoverPopupUrl = (target: BrowserWindow) => {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    target.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/miniPlayerCover.html`)
    return
  }
  target.loadFile(path.join(__dirname, '../renderer/miniPlayerCover.html'))
}

const createCoverPopupWindow = () => {
  const backgroundColor = store.settingConfig?.themeMode === 'light' ? '#f3f3f3' : '#1f1f1f'
  const target = new BrowserWindow({
    width: MINI_PLAYER_COVER_POPUP_CONTENT_WIDTH,
    height: MINI_PLAYER_COVER_POPUP_CONTENT_HEIGHT,
    useContentSize: true,
    frame: false,
    transparent: false,
    show: false,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // 悬停仍用 showInactive，不抢小窗焦点；点击文字/右键时再聚焦，才能复制与弹出菜单
    focusable: true,
    acceptFirstMouse: true,
    hasShadow: true,
    backgroundColor,
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
    log.error('[mini-player-cover] render-process-gone', details)
  })
  target.webContents.on('did-fail-load', (_event, code, desc, url) => {
    log.error('[mini-player-cover] did-fail-load', { code, desc, url })
  })
  target.on('closed', () => {
    if (coverPopupWindow === target) {
      coverPopupWindow = null
      latestPayload = null
      stopCoverPopupAutoHideMonitor()
    }
  })
  loadCoverPopupUrl(target)
  const mini = getMiniWindow()
  if (isUsableWindow(mini)) {
    const zoom = mini.webContents.getZoomFactor()
    if (Number.isFinite(zoom) && zoom > 0) {
      target.webContents.setZoomFactor(zoom)
    }
  }
  try {
    target.webContents.setVisualZoomLevelLimits(1, 1)
  } catch {}
  return target
}

const applyPopupBounds = (
  payload: MiniPlayerCoverPopupPayload,
  windowBounds?: Rectangle | null,
  options?: { notify?: boolean; raise?: boolean }
) => {
  if (!isUsableWindow(coverPopupWindow)) return false
  const screenAnchor = resolveScreenAnchor(payload.anchor, windowBounds)
  if (!screenAnchor) return false
  const nextBounds = resolvePopupBounds(screenAnchor)
  applyExactContentBounds(coverPopupWindow, nextBounds)
  applyAlwaysOnTop(coverPopupWindow)
  if (options?.raise !== false) raisePopup(coverPopupWindow)
  if (options?.notify !== false) sendPopupState(payload)
  return true
}

export const hideCoverPopup = () => {
  latestPayload = null
  stopCoverPopupAutoHideMonitor()
  if (!isUsableWindow(coverPopupWindow)) return
  try {
    coverPopupWindow.hide()
  } catch {}
}

const checkCoverPopupPointerPosition = () => {
  if (!latestPayload || !isUsableWindow(coverPopupWindow) || !coverPopupWindow.isVisible()) {
    pointerOutsideHoverRegionSince = null
    return
  }
  const anchor = resolveScreenAnchor(latestPayload.anchor)
  if (!anchor) {
    hideCoverPopup()
    return
  }
  let pointer: { x: number; y: number }
  let popupBounds: Rectangle
  try {
    pointer = screen.getCursorScreenPoint()
    popupBounds = coverPopupWindow.getBounds()
  } catch {
    return
  }
  if (isPointWithinCoverPopupHoverRegion(pointer, anchor, popupBounds, COVER_POPUP_HOVER_MARGIN)) {
    pointerOutsideHoverRegionSince = null
    return
  }
  const now = Date.now()
  if (pointerOutsideHoverRegionSince === null) {
    pointerOutsideHoverRegionSince = now
    return
  }
  if (now - pointerOutsideHoverRegionSince >= COVER_POPUP_AUTO_HIDE_DELAY_MS) {
    hideCoverPopup()
  }
}

const startCoverPopupAutoHideMonitor = () => {
  pointerOutsideHoverRegionSince = null
  if (coverPopupAutoHideTimer) return
  coverPopupAutoHideTimer = setInterval(
    checkCoverPopupPointerPosition,
    COVER_POPUP_AUTO_HIDE_POLL_MS
  )
  coverPopupAutoHideTimer.unref()
}

export const destroyCoverPopup = () => {
  latestPayload = null
  stopCoverPopupAutoHideMonitor()
  contentSize = defaultContentSize()
  const target = coverPopupWindow
  coverPopupWindow = null
  if (isUsableWindow(target)) {
    try {
      target.destroy()
    } catch {}
  }
}

export const repositionCoverPopup = (windowBounds?: Rectangle) => {
  if (!latestPayload || !isUsableWindow(coverPopupWindow) || !coverPopupWindow.isVisible()) return
  applyPopupBounds(latestPayload, windowBounds, { notify: false, raise: false })
}

export const showCoverPopup = (rawPayload: unknown) => {
  const payload = parsePayload(rawPayload)
  if (!payload) return false
  latestPayload = payload
  if (!isUsableWindow(coverPopupWindow)) {
    coverPopupWindow = createCoverPopupWindow()
    coverPopupWindow.once('ready-to-show', () => {
      if (!latestPayload || !isUsableWindow(coverPopupWindow)) return
      if (!applyPopupBounds(latestPayload)) return
      showInactive(coverPopupWindow)
      startCoverPopupAutoHideMonitor()
    })
    return true
  }
  if (!applyPopupBounds(payload)) return false
  showInactive(coverPopupWindow)
  startCoverPopupAutoHideMonitor()
  return true
}

export const bindMiniPlayerCoverPopup = (params: {
  getMiniWindow: () => BrowserWindow | null
  resolveAlwaysOnTop: () => boolean
}) => {
  getMiniWindow = params.getMiniWindow
  resolveAlwaysOnTop = params.resolveAlwaysOnTop
  if (ipcBound) return
  ipcBound = true
  ipcMain.handle(MINI_PLAYER_CHANNELS.showCoverPopup, (_event, payload: unknown) => {
    return showCoverPopup(payload)
  })
  ipcMain.handle(MINI_PLAYER_CHANNELS.hideCoverPopup, () => {
    hideCoverPopup()
    return true
  })
  ipcMain.on(MINI_PLAYER_CHANNELS.coverPopupReady, () => {
    if (!latestPayload || !isUsableWindow(coverPopupWindow)) return
    if (!applyPopupBounds(latestPayload)) return
    showInactive(coverPopupWindow)
    startCoverPopupAutoHideMonitor()
  })
  ipcMain.on(MINI_PLAYER_CHANNELS.coverPopupContentSize, (_event, raw: unknown) => {
    if (!isRecord(raw)) return
    const width = Math.ceil(Number(raw.width) || 0)
    const height = Math.ceil(Number(raw.height) || 0)
    if (width < 280 || height < 330) return
    if (Math.abs(contentSize.width - width) < 1 && Math.abs(contentSize.height - height) < 1) {
      return
    }
    contentSize = { width, height }
    if (!latestPayload || !isUsableWindow(coverPopupWindow) || !coverPopupWindow.isVisible()) return
    applyPopupBounds(latestPayload, null, { notify: false, raise: false })
  })
  ipcMain.on(MINI_PLAYER_CHANNELS.coverPopupPointer, (_event, payload: unknown) => {
    const mini = getMiniWindow()
    if (!isUsableWindow(mini)) return
    try {
      mini.webContents.send(MINI_PLAYER_CHANNELS.coverPopupPointer, payload)
    } catch {}
  })
  ipcMain.on(MINI_PLAYER_CHANNELS.focusCoverPopup, () => {
    if (!isUsableWindow(coverPopupWindow) || !coverPopupWindow.isVisible()) return
    try {
      coverPopupWindow.focus()
    } catch {}
  })
}
