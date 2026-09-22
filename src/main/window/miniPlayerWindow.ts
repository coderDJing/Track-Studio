import { BrowserWindow, ipcMain, screen, app } from 'electron'
import { is } from '@electron-toolkit/utils'
import path = require('path')
import icon from '../../../resources/icon.png?asset'
import { log } from '../log'
import { isPackagedRcBuild } from '../services/rcDiagnostics'
import store from '../store'
import { mergeLayoutConfig, persistLayoutConfig } from '../layoutConfig'
import { restrictExternalNavigation } from './externalNavigation'
import { PRODUCT_DISPLAY_NAME } from '@shared/productBrand'
import {
  bindMiniPlayerCoverPopup,
  destroyCoverPopup,
  repositionCoverPopup
} from './miniPlayerCoverPopup'
import {
  bindMiniPlayerOverlay,
  destroyMiniPlayerOverlay,
  hideMiniPlayerTooltip,
  repositionMiniPlayerOverlay
} from './miniPlayerOverlay'
import { applyExactContentBounds } from './miniPlayerPopupLayout'
import {
  MINI_PLAYER_CHANNELS,
  MINI_PLAYER_WINDOW_DEFAULT_WIDTH,
  MINI_PLAYER_WINDOW_HEIGHT,
  MINI_PLAYER_WINDOW_MIN_WIDTH,
  type MiniPlayerCommand,
  type MiniPlayerHostState,
  type MiniPlayerPlayhead,
  type MiniPlayerPlayheadGapDiagnostic,
  type MiniPlayerSession
} from '../../shared/miniPlayerWindow'
import type { MiniPlayerTaskProgress } from '../../shared/miniPlayerTaskProgress'

let miniPlayerWindow: BrowserWindow | null = null
let getMainWindow: () => BrowserWindow | null = () => null
let lastHostPlayheadReceivedAtMs: number | null = null
let lastHostPlayheadSenderId: number | null = null
let lastHostPlayheadSequence: number | null = null
let lastHostPlayheadPublishedAtMs: number | null = null
let ipcBound = false
let mainListenersAttached = false
let restoringMain = false
let allowDestroy = false
let persistTimer: ReturnType<typeof setTimeout> | null = null

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const toNullableFiniteNumber = (value: unknown): number | null => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const isUsableWindow = (target: BrowserWindow | null): target is BrowserWindow =>
  !!target && !target.isDestroyed()

const resolveAlwaysOnTop = () => store.layoutConfig.miniPlayerWindowAlwaysOnTop !== false

const notifySession = (target?: BrowserWindow | null) => {
  const payload: MiniPlayerSession = {
    open: isOpen(),
    alwaysOnTop: resolveAlwaysOnTop()
  }
  const main = getMainWindow()
  if (isUsableWindow(main)) {
    try {
      main.webContents.send(MINI_PLAYER_CHANNELS.session, payload)
    } catch {}
  }
  const mini = target || miniPlayerWindow
  if (isUsableWindow(mini)) {
    try {
      mini.webContents.send(MINI_PLAYER_CHANNELS.session, payload)
    } catch {}
  }
}

const persistBounds = () => {
  if (!isUsableWindow(miniPlayerWindow)) return
  const bounds = miniPlayerWindow.getBounds()
  const next = mergeLayoutConfig(store.layoutConfig, {
    miniPlayerWindowX: bounds.x,
    miniPlayerWindowY: bounds.y,
    miniPlayerWindowWidth: bounds.width,
    miniPlayerWindowAlwaysOnTop: resolveAlwaysOnTop()
  })
  store.layoutConfig = next
  void persistLayoutConfig(next)
}

const schedulePersistBounds = () => {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistBounds()
  }, 280)
}

const resolveWorkArea = (point?: { x: number; y: number }) => {
  const cursor = point || screen.getCursorScreenPoint()
  return screen.getDisplayNearestPoint(cursor).workArea
}

const resolveOpenBounds = () => {
  const savedWidth = Number(store.layoutConfig.miniPlayerWindowWidth)
  const width = Math.max(
    MINI_PLAYER_WINDOW_MIN_WIDTH,
    Number.isFinite(savedWidth) && savedWidth > 0
      ? Math.round(savedWidth)
      : MINI_PLAYER_WINDOW_DEFAULT_WIDTH
  )
  const savedX = Number(store.layoutConfig.miniPlayerWindowX)
  const savedY = Number(store.layoutConfig.miniPlayerWindowY)
  const hasSavedPosition = Number.isFinite(savedX) && Number.isFinite(savedY)
  const workArea = resolveWorkArea(
    hasSavedPosition ? { x: savedX, y: savedY } : screen.getCursorScreenPoint()
  )
  const nextWidth = Math.min(width, Math.max(MINI_PLAYER_WINDOW_MIN_WIDTH, workArea.width))
  const nextX = hasSavedPosition
    ? clampNumber(Math.round(savedX), workArea.x, workArea.x + workArea.width - nextWidth)
    : Math.round(workArea.x + (workArea.width - nextWidth) / 2)
  const nextY = hasSavedPosition
    ? clampNumber(
        Math.round(savedY),
        workArea.y,
        workArea.y + workArea.height - MINI_PLAYER_WINDOW_HEIGHT
      )
    : Math.round(workArea.y + workArea.height - MINI_PLAYER_WINDOW_HEIGHT - 24)
  return {
    width: nextWidth,
    height: MINI_PLAYER_WINDOW_HEIGHT,
    x: nextX,
    y: nextY
  }
}

const lockNormalHeight = (target: BrowserWindow, width: number) => {
  const content = target.getContentBounds()
  applyExactContentBounds(target, {
    x: content.x,
    y: content.y,
    width: Math.max(MINI_PLAYER_WINDOW_MIN_WIDTH, width || content.width),
    height: MINI_PLAYER_WINDOW_HEIGHT
  })
  const outer = target.getBounds()
  target.setMinimumSize(MINI_PLAYER_WINDOW_MIN_WIDTH, outer.height)
  target.setMaximumSize(16384, outer.height)
}

const hideMainWindow = () => {
  hideMiniPlayerTooltip()
  const main = getMainWindow()
  if (!isUsableWindow(main) || !main.isVisible()) return
  try {
    if (process.platform === 'win32') {
      main.setSkipTaskbar(true)
    }
    main.hide()
  } catch (error) {
    log.error('[mini-player] hide main window failed', error)
  }
}

const restoreMainTaskbar = () => {
  const main = getMainWindow()
  if (!isUsableWindow(main) || process.platform !== 'win32') return
  try {
    main.setSkipTaskbar(false)
  } catch {}
}

const showMainWindow = () => {
  const main = getMainWindow()
  if (!isUsableWindow(main)) return
  restoringMain = true
  try {
    restoreMainTaskbar()
    if (main.isMinimized()) {
      main.restore()
    }
    main.show()
    main.focus()
  } catch (error) {
    log.error('[mini-player] show main window failed', error)
  } finally {
    setTimeout(() => {
      restoringMain = false
    }, 0)
  }
}

const destroyMiniWindow = (restoreMainWindow: boolean) => {
  destroyCoverPopup()
  destroyMiniPlayerOverlay()
  const target = miniPlayerWindow
  miniPlayerWindow = null
  lastHostPlayheadReceivedAtMs = null
  lastHostPlayheadSenderId = null
  lastHostPlayheadSequence = null
  lastHostPlayheadPublishedAtMs = null
  // 在主窗口恢复可见前先解除其快捷键禁用状态，避免首个按键被忽略。
  notifySession()
  if (restoreMainWindow) {
    showMainWindow()
  } else {
    restoreMainTaskbar()
  }
  if (isUsableWindow(target)) {
    allowDestroy = true
    try {
      if (!target.isDestroyed()) target.destroy()
    } catch {}
  }
  allowDestroy = false
}

const restorePinnedAlwaysOnTop = (target: BrowserWindow) => {
  if (!resolveAlwaysOnTop()) return
  try {
    target.setAlwaysOnTop(true, 'floating')
  } catch {
    target.setAlwaysOnTop(true)
  }
}

const applyKeyboardFocus = (target: BrowserWindow) => {
  try {
    if (target.isMinimized()) target.restore()
    target.show()
    target.moveTop()
    const pinned = resolveAlwaysOnTop()
    if (process.platform === 'win32' && pinned) {
      try {
        target.setAlwaysOnTop(false)
      } catch {}
    }
    if (process.platform === 'darwin') {
      try {
        app.focus({ steal: true })
      } catch {}
    }
    target.focus()
    target.webContents.focus()
    if (process.platform === 'win32' && pinned) {
      restorePinnedAlwaysOnTop(target)
    }
    target.webContents.send(MINI_PLAYER_CHANNELS.requestKeyboardFocus)
    setTimeout(() => {
      if (!isUsableWindow(target)) return
      try {
        target.webContents.send(MINI_PLAYER_CHANNELS.requestKeyboardFocus)
      } catch {}
    }, 80)
  } catch (error) {
    log.error('[mini-player] focus failed', error)
  }
}

export const isOpen = () => isUsableWindow(miniPlayerWindow)

export const isVisible = () => isUsableWindow(miniPlayerWindow) && miniPlayerWindow.isVisible()

export const focusExisting = () => {
  if (!isUsableWindow(miniPlayerWindow)) return false
  applyKeyboardFocus(miniPlayerWindow)
  return true
}

export const isPinnedOpen = () => isOpen() && resolveAlwaysOnTop()

export const restoreMain = () => {
  if (!isOpen()) {
    showMainWindow()
    return
  }
  persistBounds()
  destroyMiniWindow(true)
}

const attachMainWindowListeners = () => {
  const main = getMainWindow()
  if (!isUsableWindow(main) || mainListenersAttached) return
  mainListenersAttached = true
  main.on('show', () => {
    if (restoringMain || !isOpen()) return
    persistBounds()
    destroyMiniWindow(false)
  })
  main.on('closed', () => {
    mainListenersAttached = false
    destroyMiniWindow(false)
  })
}

const loadMiniPlayerUrl = (target: BrowserWindow) => {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    target.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/miniPlayer.html`)
    return
  }
  target.loadFile(path.join(__dirname, '../renderer/miniPlayer.html'))
}

const createMiniPlayerWindow = () => {
  const bounds = resolveOpenBounds()
  const target = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: MINI_PLAYER_WINDOW_MIN_WIDTH,
    minHeight: MINI_PLAYER_WINDOW_HEIGHT,
    x: bounds.x,
    y: bounds.y,
    useContentSize: true,
    frame: false,
    transparent: false,
    show: false,
    alwaysOnTop: resolveAlwaysOnTop(),
    skipTaskbar: false,
    title: PRODUCT_DISPLAY_NAME,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    backgroundColor: '#0c0c0c',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false,
      backgroundThrottling: false
    }
  })
  lockNormalHeight(target, bounds.width)
  const rcDiagnosticsEnabled = isPackagedRcBuild()
  let rendererUnresponsiveAt: number | null = null
  const pushWindowFocus = (focused: boolean) => {
    if (!isUsableWindow(target)) return
    try {
      target.webContents.send(MINI_PLAYER_CHANNELS.windowFocus, focused)
    } catch {}
  }
  if (resolveAlwaysOnTop()) {
    try {
      target.setAlwaysOnTop(true, 'floating')
    } catch {
      target.setAlwaysOnTop(true)
    }
  }
  if (is.dev && process.env.FRKB_OPEN_DEVTOOLS === '1') {
    target.webContents.openDevTools()
  }
  restrictExternalNavigation(target.webContents)
  target.webContents.on('unresponsive', () => {
    if (!rcDiagnosticsEnabled || rendererUnresponsiveAt !== null) return
    rendererUnresponsiveAt = Date.now()
    log.error('[mini-player] renderer unresponsive', {
      windowId: target.id,
      webContentsId: target.webContents.id,
      visible: target.isVisible(),
      focused: target.isFocused()
    })
  })
  target.webContents.on('responsive', () => {
    if (!rcDiagnosticsEnabled || rendererUnresponsiveAt === null) return
    const durationMs = Math.max(0, Date.now() - rendererUnresponsiveAt)
    rendererUnresponsiveAt = null
    log.error('[mini-player] renderer recovered', {
      windowId: target.id,
      webContentsId: target.webContents.id,
      durationMs,
      visible: target.isVisible(),
      focused: target.isFocused()
    })
  })
  target.webContents.on('render-process-gone', (_event, details) => {
    const unresponsiveDurationMs =
      rendererUnresponsiveAt === null ? null : Math.max(0, Date.now() - rendererUnresponsiveAt)
    rendererUnresponsiveAt = null
    log.error('[mini-player] render-process-gone', { details, unresponsiveDurationMs })
  })
  target.webContents.on('did-fail-load', (_event, code, desc, url) => {
    log.error('[mini-player] did-fail-load', { code, desc, url })
  })
  target.on('moved', () => {
    schedulePersistBounds()
    hideMiniPlayerTooltip()
    repositionCoverPopup()
    repositionMiniPlayerOverlay()
  })
  target.on('will-move', (_event, newBounds) => {
    hideMiniPlayerTooltip()
    repositionCoverPopup(newBounds)
    repositionMiniPlayerOverlay(newBounds)
  })
  target.on('resized', () => {
    schedulePersistBounds()
    hideMiniPlayerTooltip()
    repositionCoverPopup()
    repositionMiniPlayerOverlay()
  })
  target.on('will-resize', (_event, newBounds) => {
    hideMiniPlayerTooltip()
    repositionCoverPopup(newBounds)
    repositionMiniPlayerOverlay(newBounds)
  })
  target.on('focus', () => {
    pushWindowFocus(true)
  })
  target.on('blur', () => {
    // 小窗失焦时锚点可能不会收到 mouseleave（例如切到主窗口或其他应用），
    // 不能让独立 tooltip 窗口继续悬挂在屏幕上。
    hideMiniPlayerTooltip()
    pushWindowFocus(false)
  })
  target.on('ready-to-show', () => {
    if (!isUsableWindow(target)) return
    hideMainWindow()
    applyKeyboardFocus(target)
    notifySession(target)
    pushWindowFocus(target.isFocused())
  })
  target.on('close', (event) => {
    if (allowDestroy) return
    event.preventDefault()
    restoreMain()
  })
  target.on('closed', () => {
    if (miniPlayerWindow === target) {
      miniPlayerWindow = null
      notifySession()
    }
  })
  loadMiniPlayerUrl(target)
  return target
}

const open = () => {
  attachMainWindowListeners()
  if (isUsableWindow(miniPlayerWindow)) {
    hideMainWindow()
    applyKeyboardFocus(miniPlayerWindow)
    notifySession(miniPlayerWindow)
    return miniPlayerWindow
  }
  miniPlayerWindow = createMiniPlayerWindow()
  notifySession(miniPlayerWindow)
  return miniPlayerWindow
}

const setAlwaysOnTop = (next: boolean) => {
  const enabled = !!next
  store.layoutConfig = mergeLayoutConfig(store.layoutConfig, {
    miniPlayerWindowAlwaysOnTop: enabled
  })
  void persistLayoutConfig(store.layoutConfig)
  if (!isUsableWindow(miniPlayerWindow)) {
    notifySession()
    return enabled
  }
  try {
    if (enabled) {
      miniPlayerWindow.setAlwaysOnTop(true, 'floating')
    } else {
      miniPlayerWindow.setAlwaysOnTop(false)
    }
  } catch {
    miniPlayerWindow.setAlwaysOnTop(enabled)
  }
  notifySession(miniPlayerWindow)
  repositionCoverPopup()
  repositionMiniPlayerOverlay()
  return enabled
}

const forwardToMini = (channel: string, payload: unknown) => {
  if (!isUsableWindow(miniPlayerWindow)) return
  try {
    miniPlayerWindow.webContents.send(channel, payload)
  } catch {}
}

const forwardToMain = (channel: string, payload: unknown) => {
  const main = getMainWindow()
  if (!isUsableWindow(main)) return
  try {
    main.webContents.send(channel, payload)
  } catch {}
}

const ensureIpcHandlers = () => {
  if (ipcBound) return
  ipcBound = true
  ipcMain.handle(MINI_PLAYER_CHANNELS.open, () => {
    open()
    return { open: true, alwaysOnTop: resolveAlwaysOnTop() } satisfies MiniPlayerSession
  })
  ipcMain.handle(MINI_PLAYER_CHANNELS.close, () => {
    restoreMain()
    return { open: false, alwaysOnTop: resolveAlwaysOnTop() } satisfies MiniPlayerSession
  })
  ipcMain.handle(MINI_PLAYER_CHANNELS.toggle, () => {
    if (isOpen()) {
      restoreMain()
    } else {
      open()
    }
    return { open: isOpen(), alwaysOnTop: resolveAlwaysOnTop() } satisfies MiniPlayerSession
  })
  ipcMain.handle(MINI_PLAYER_CHANNELS.isOpen, () => isOpen())
  ipcMain.handle(MINI_PLAYER_CHANNELS.setAlwaysOnTop, (_event, next: unknown) => {
    return setAlwaysOnTop(!!next)
  })
  ipcMain.handle(MINI_PLAYER_CHANNELS.setPopupHeight, () => {
    return 0
  })
  ipcMain.on(MINI_PLAYER_CHANNELS.hostState, (_event, payload: MiniPlayerHostState) => {
    forwardToMini(MINI_PLAYER_CHANNELS.hostState, payload)
  })
  ipcMain.on(MINI_PLAYER_CHANNELS.playhead, (_event, payload: MiniPlayerPlayhead) => {
    const receivedAtMs = Date.now()
    lastHostPlayheadReceivedAtMs = receivedAtMs
    lastHostPlayheadSenderId = _event.sender.id
    lastHostPlayheadSequence = toNullableFiniteNumber(payload?.sequence)
    lastHostPlayheadPublishedAtMs = toNullableFiniteNumber(payload?.publishedAtMs)
    forwardToMini(MINI_PLAYER_CHANNELS.playhead, payload)
  })
  ipcMain.on(
    MINI_PLAYER_CHANNELS.playheadGap,
    (_event, payload: MiniPlayerPlayheadGapDiagnostic) => {
      if (!isPackagedRcBuild() || !isVisible()) return
      const delayedMs = Number(payload?.delayedMs)
      if (!Number.isFinite(delayedMs) || delayedMs < 1500) return
      const now = Date.now()
      const lastUpdateReceivedAtMs = toNullableFiniteNumber(payload?.lastUpdateReceivedAtMs)
      log.error('[mini-player] playback progress delayed', {
        delayedMs: Math.round(delayedMs),
        currentSeconds: Math.max(0, Number(payload?.currentSeconds) || 0),
        durationSeconds: Math.max(0, Number(payload?.durationSeconds) || 0),
        detectedAtMs: toNullableFiniteNumber(payload?.detectedAtMs) ?? now,
        lastUpdateSource: payload?.lastUpdateSource || null,
        lastUpdateSequence: toNullableFiniteNumber(payload?.lastUpdateSequence),
        lastUpdatePublishedAtMs: toNullableFiniteNumber(payload?.lastUpdatePublishedAtMs),
        lastUpdateReceivedAtMs,
        lastUpdateAgeMs:
          lastUpdateReceivedAtMs === null ? null : Math.max(0, now - lastUpdateReceivedAtMs),
        mainProcessReceivedGapMs:
          lastHostPlayheadReceivedAtMs === null
            ? null
            : Math.max(0, now - lastHostPlayheadReceivedAtMs),
        mainLastPlayheadReceivedAtMs: lastHostPlayheadReceivedAtMs,
        mainLastPlayheadSequence: lastHostPlayheadSequence,
        mainLastPlayheadPublishedAtMs: lastHostPlayheadPublishedAtMs,
        hostWebContentsId: lastHostPlayheadSenderId,
        focused: miniPlayerWindow?.isFocused() === true,
        visible: true
      })
    }
  )
  ipcMain.on(MINI_PLAYER_CHANNELS.taskProgress, (_event, payload: MiniPlayerTaskProgress) => {
    forwardToMini(MINI_PLAYER_CHANNELS.taskProgress, payload)
  })
  ipcMain.on(MINI_PLAYER_CHANNELS.command, (_event, payload: MiniPlayerCommand) => {
    forwardToMain(MINI_PLAYER_CHANNELS.command, payload)
  })
  ipcMain.on(MINI_PLAYER_CHANNELS.rendererReady, () => {
    forwardToMain(MINI_PLAYER_CHANNELS.rendererReady, null)
    notifySession(miniPlayerWindow)
    forwardToMini(MINI_PLAYER_CHANNELS.windowFocus, miniPlayerWindow?.isFocused() === true)
    if (isUsableWindow(miniPlayerWindow)) {
      applyKeyboardFocus(miniPlayerWindow)
    }
  })
}

export const bindMiniPlayerWindow = (params: { getMainWindow: () => BrowserWindow | null }) => {
  getMainWindow = params.getMainWindow
  bindMiniPlayerCoverPopup({
    getMiniWindow: () => miniPlayerWindow,
    resolveAlwaysOnTop
  })
  bindMiniPlayerOverlay({
    getMiniWindow: () => miniPlayerWindow,
    resolveAlwaysOnTop
  })
  ensureIpcHandlers()
}

export default {
  bind: bindMiniPlayerWindow,
  open,
  restoreMain,
  isOpen,
  isVisible,
  isPinnedOpen,
  focusExisting,
  notifySession
}
