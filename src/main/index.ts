// 必须在导入任何原生模块之前设置 FFmpeg DLL 路径（仅 Windows 生效）
import './nativeModuleSetup'
// 必须在任何 ipcMain.handle / ipcMain.on 注册之前打补丁，卡住时才能对上通道名。
import './services/mainProcessActivityTrace'
import 'dotenv/config'
import { app, BrowserWindow, ipcMain, nativeTheme, protocol } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import {
  log,
  getLogPath,
  clearLogFileSync,
  configureLogTransports,
  openLogFile,
  type LogLevel
} from './log'
import './cloudSync'
import { stopCloudSyncScheduler } from './cloudSyncScheduler'
import { stopCuratedLibraryLiveSync } from './curatedLibrarySync/liveSync'
import { cancelCuratedLibrarySync } from './curatedLibrarySync/engine'
import errorReport from './errorReport'
import { replaceFingerprintList } from './fingerprintStore'
import mainWindow from './window/mainWindow'
import mixtapeWindow from './window/mixtapeWindow'
import startupWindow from './window/startupWindow'
import databaseSchemaMigrationWindow from './window/databaseSchemaMigrationWindow'
import libraryRelocateWindow from './window/libraryRelocateWindow'
import { is } from '@electron-toolkit/utils'
import store from './store'
import {
  rebuildMacMenusForCurrentFocus,
  setMacMainWindowBrowseMode,
  setupMacMenus
} from './menu/macMenu'
import { prepareAndOpenMainWindow } from './bootstrap/prepareDatabase'
import { setupAutoUpdate } from './bootstrap/autoUpdate'
import {
  applyThemeFromSettings,
  broadcastSystemThemeIfNeeded,
  loadInitialSettings
} from './bootstrap/settings'
import { persistSettingConfigSync } from './settingsPersistence'
import {
  clearWindowsContextMenuSignature,
  ensureWindowsContextMenuIfNeeded,
  hasWindowsContextMenu,
  removeWindowsContextMenu
} from './platform/windowsContextMenu'
import { PRODUCT_DISPLAY_NAME } from '@shared/productBrand'
import { loadLayoutConfigSync } from './layoutConfig'
import { resolveBundledFfmpegPath, ensureExecutableOnMac } from './ffmpeg'
import {
  markExternalOpenRendererNotReady,
  markExternalOpenRendererReady,
  processExternalOpenQueue,
  queueExternalAudioFiles
} from './services/externalOpenQueue'
import { registerSettingsHandlers } from './ipc/settingsHandlers'
import { registerCuratedLibrarySyncIpc } from './curatedLibrarySync/ipc'
import { registerLibraryMaintenanceHandlers } from './ipc/libraryMaintenanceHandlers'
import { registerPlaylistHandlers } from './ipc/playlistHandlers'
import { bindLibraryTreeContentChangeListener } from './libraryTreeWatcher'
import {
  invalidatePlaylistViewSnapshotsByPaths,
  startPlaylistViewSnapshotIdleVerification,
  stopPlaylistViewSnapshotIdleVerification
} from './services/playlistViewSnapshotService'
import { registerMediaMetadataHandlers } from './ipc/mediaMetadataHandlers'
import { registerSongEditHandlers } from './ipc/songEditHandlers'
import { registerCacheHandlers } from './ipc/cacheHandlers'
import { registerFilesystemHandlers } from './ipc/filesystemHandlers'
import { registerClipboardHandlers } from './ipc/clipboardHandlers'
import { registerExportHandlers } from './ipc/exportHandlers'
import { registerKeyAnalysisHandlers } from './ipc/keyAnalysisHandlers'
import { registerAnalysisRuntimeHandlers } from './ipc/analysisRuntimeHandlers'
import { registerDemucsModelHandlers } from './ipc/demucsModelHandlers'
import { registerMixtapeHandlers } from './ipc/mixtapeHandlers'
import { registerLibraryStemHandlers } from './ipc/libraryStemHandlers'
import { registerMixtapeDragSessionHandlers } from './ipc/mixtapeDragSessionHandlers'
import { registerMixtapeProjectTempoHandlers } from './ipc/mixtapeProjectTempoHandlers'
import { registerSongSearchHandlers } from './ipc/songSearchHandlers'
import { markGlobalSongSearchDirty } from './services/globalSongSearch'
import { registerPioneerDeviceLibraryHandlers } from './ipc/pioneerDeviceLibraryHandlers'
import { registerRekordboxDesktopLibraryHandlers } from './ipc/rekordboxDesktopLibraryHandlers'
import { registerRekordboxXmlExportHandlers } from './ipc/rekordboxXmlExportHandlers'
import { registerHorizontalBrowseTransportHandlers } from './ipc/horizontalBrowseTransportHandlers'
import { stopHorizontalBrowseTransportSnapshotBroadcaster } from './ipc/horizontalBrowseTransportSnapshotBroadcaster'
import { registerDevSongListTraceHandlers } from './ipc/devSongListTraceHandlers'
import { registerHotCueHandlers } from './ipc/hotCueHandlers'
import { registerMemoryCueHandlers } from './ipc/memoryCueHandlers'
import { maybeShowWhatsNew, registerWhatsNewHandlers } from './services/whatsNew'
import { registerPlaybackForegroundActivityHandlers } from './services/playbackForegroundActivity'
import { registerLibraryMergeHandlers } from './ipc/libraryMergeHandlers'
import { registerLibraryRelocateHandlers } from './ipc/libraryRelocateHandlers'
import { registerLibrarySetupHandlers } from './ipc/librarySetupHandlers'
import * as LibraryCacheDb from './libraryCacheDb'
import path from 'path'
import fs from 'fs-extra'
import {
  keyAnalysisEvents,
  isKeyAnalysisForegroundBusy,
  startKeyAnalysisBackground,
  type KeyAnalysisBackgroundStatus
} from './services/keyAnalysisQueue'
import { songGridEvents } from './services/songGridEvents'
import { songHotCueEvents } from './services/songHotCueEvents'
import { songMemoryCueEvents } from './services/songMemoryCueEvents'
import { analysisRuntimeDownloadEvents } from './services/analysisRuntimeDownload'
import { demucsUltraModelDownloadEvents } from './services/demucsUltraModelDownload'
import { startMixtapeStemBackgroundResume } from './services/mixtapeStemBackgroundResume'
import { isMixtapeStemQueueBusy } from './services/mixtapeStemQueue'
import { isMixtapeWaveformQueueBusy } from './services/mixtapeWaveformQueue'
import { isMixtapeRawWaveformQueueBusy } from './services/mixtapeRawWaveformQueue'
import {
  startBackgroundOrchestrator,
  stopBackgroundOrchestrator
} from './services/backgroundOrchestrator'
import globalSongSearchEngine from './services/globalSongSearch'
import { registerBackgroundForegroundBusyProvider } from './services/backgroundIdleGate'
import { acquireDevSingleInstanceLock, configureDevRuntime } from './devInstance'
import {
  startDevExternalOpenHandoffWatcher,
  writeDevExternalOpenHandoff
} from './services/devExternalOpenHandoff'
import { terminateRegisteredChildProcesses } from './services/childProcessRegistry'
import { closeLibraryDb } from './libraryDb'
import { isLibrarySetupActive } from './librarySetupState'
import { openSafeExternalUrl } from './window/externalNavigation'

const devRuntime = configureDevRuntime(is.dev, log)
configureLogTransports()
process.env.FRKB_APP_PACKAGED = app.isPackaged ? '1' : '0'

try {
  const resolvedUserDataDir = app.getPath('userData')
  if (resolvedUserDataDir) {
    process.env.FRKB_USER_DATA_DIR = resolvedUserDataDir
  }
} catch (error) {
  log.error('[runtime] 同步 userData 到分析 worker 环境失败', error)
}

const devDatabase = devRuntime?.databaseDir || ''

// 主题：默认按设置文件（首次为 system），不再强制日间模式

const devInstanceLock = acquireDevSingleInstanceLock(devRuntime, log)
const gotTheLock = devInstanceLock?.isPrimaryInstance ?? app.requestSingleInstanceLock()
const PREVIEW_PROTOCOL = 'frkb-preview'
const PREVIEW_MIME_MAP: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wma': 'audio/x-ms-wma',
  '.ac3': 'audio/ac3',
  '.dts': 'audio/vnd.dts',
  '.mka': 'audio/x-matroska',
  '.webm': 'audio/webm',
  '.ape': 'audio/ape',
  '.tak': 'audio/tak',
  '.tta': 'audio/tta',
  '.wv': 'audio/wavpack'
}

const getPreviewMimeType = (filePath: string) => {
  const ext = path.extname(filePath || '').toLowerCase()
  return PREVIEW_MIME_MAP[ext] || 'application/octet-stream'
}

const focusWindowIfPossible = (target: BrowserWindow | null): boolean => {
  if (!target || target.isDestroyed()) return false
  if (target.isMinimized()) {
    target.restore()
  }
  target.focus()
  return true
}

let externalOpenLifecycleWebContentsId: number | null = null
let externalOpenLifecycleWebContents: Electron.WebContents | null = null

const handleExternalOpenDidStartLoading = () => {
  markExternalOpenRendererNotReady()
}
const handleExternalOpenDestroyed = () => {
  if (externalOpenLifecycleWebContentsId !== null) {
    externalOpenLifecycleWebContentsId = null
    externalOpenLifecycleWebContents = null
  }
  markExternalOpenRendererNotReady()
}

const attachExternalOpenRendererLifecycle = (): void => {
  const target = mainWindow.instance
  if (!target || target.isDestroyed()) return
  const wc = target.webContents
  if (!wc || wc.isDestroyed()) return
  if (externalOpenLifecycleWebContentsId === wc.id) return
  // 移除旧 webContents 上的监听器
  if (externalOpenLifecycleWebContents && !externalOpenLifecycleWebContents.isDestroyed()) {
    externalOpenLifecycleWebContents.removeListener(
      'did-start-loading',
      handleExternalOpenDidStartLoading
    )
    externalOpenLifecycleWebContents.removeListener('destroyed', handleExternalOpenDestroyed)
  }
  externalOpenLifecycleWebContentsId = wc.id
  externalOpenLifecycleWebContents = wc
  markExternalOpenRendererNotReady()
  wc.on('did-start-loading', handleExternalOpenDidStartLoading)
  wc.on('destroyed', handleExternalOpenDestroyed)
}

const ensurePrimaryWindowVisible = async (): Promise<void> => {
  if (focusWindowIfPossible(databaseSchemaMigrationWindow.instance)) return
  if (focusWindowIfPossible(libraryRelocateWindow.instance)) return
  if (focusWindowIfPossible(mainWindow.instance)) return
  await prepareAndOpenMainWindow()
  attachExternalOpenRendererLifecycle()
  await processExternalOpenQueue()
}

const maybeClearLogAfterUpgrade = () => {
  try {
    if (is.dev) {
      clearLogFileSync()
      return
    }

    const currentVersion = app.getVersion()
    const setting = store.settingConfig
    const lastVersion =
      typeof setting.lastRunAppVersion === 'string' ? String(setting.lastRunAppVersion || '') : ''
    const logPath = getLogPath()
    const hasLogFile = fs.pathExistsSync(logPath)
    let logHasContent = false
    if (hasLogFile) {
      try {
        logHasContent = fs.statSync(logPath).size > 0
      } catch {
        logHasContent = false
      }
    }
    const isVersionChanged = !!lastVersion && lastVersion !== currentVersion
    const shouldClearOnUnknownVersion = !lastVersion && logHasContent
    if (isVersionChanged || shouldClearOnUnknownVersion) {
      clearLogFileSync()
      // 清理旧日志后重置上报计时，避免空日志重复触发
      setting.errorReportUsageMsSinceLastSuccess = 0
      setting.errorReportRetryMsSinceLastFailure = -1
    }
    if (lastVersion !== currentVersion) {
      setting.lastRunAppVersion = currentVersion
      store.settingConfig = setting
      persistSettingConfigSync(setting)
    }
  } catch (error) {
    log.error('[upgrade] 清理旧日志失败', error)
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: PREVIEW_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      corsEnabled: true,
      bypassCSP: true,
      allowServiceWorkers: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

if (!gotTheLock) {
  let handedOffExternalOpen = false
  if (is.dev && devInstanceLock && devRuntime?.userDataDir) {
    handedOffExternalOpen = writeDevExternalOpenHandoff(
      devRuntime.userDataDir,
      process.argv.slice(1)
    )
  }
  if (is.dev && devInstanceLock) {
    console.error(
      handedOffExternalOpen
        ? `[frkb-dev] 实例 ${devRuntime?.instanceId || 'default'} 已在运行，已把外部打开文件投递给主实例（pid=${devInstanceLock.ownerPid || 'unknown'}）。`
        : `[frkb-dev] 实例 ${devRuntime?.instanceId || 'default'} 已被占用（pid=${devInstanceLock.ownerPid || 'unknown'}，lock=${devInstanceLock.lockFilePath}）。请先关闭已有 dev 进程，或修改 .env 里的 FRKB_DEV_INSTANCE / FRKB_DEV_USER_DATA_DIR。`
    )
  }
  app.quit()
} else {
  if (!devInstanceLock) {
    app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
      queueExternalAudioFiles(_commandLine)
      void ensurePrimaryWindowVisible()
    })
  }
}
app.on('open-file', (event, openedPath) => {
  event.preventDefault()
  queueExternalAudioFiles([openedPath])
})

if (devInstanceLock) {
  const releaseDevInstanceLock = () => {
    devInstanceLock.release()
  }
  app.on('before-quit', releaseDevInstanceLock)
  process.on('exit', releaseDevInstanceLock)
}

const platform = process.platform
const ffmpegPath = resolveBundledFfmpegPath()
process.env.FRKB_FFMPEG_PATH = ffmpegPath
void ensureExecutableOnMac(ffmpegPath)
store.layoutConfig = loadLayoutConfigSync()
loadInitialSettings({ getWindowsContextMenuStatus: hasWindowsContextMenu })
if (is.dev && devInstanceLock?.isPrimaryInstance && devRuntime?.userDataDir) {
  startDevExternalOpenHandoffWatcher(devRuntime.userDataDir)
}
maybeClearLogAfterUpgrade()
errorReport.setup()
registerWhatsNewHandlers()
registerPlaybackForegroundActivityHandlers()
registerLibraryMergeHandlers()
registerLibraryRelocateHandlers()
registerLibrarySetupHandlers()
registerSettingsHandlers({
  loadFingerprintList: async (mode) => {
    const FingerprintStore = require('./fingerprintStore')
    const list = await FingerprintStore.loadList(mode)
    return Array.isArray(list) ? list : []
  }
})
registerCuratedLibrarySyncIpc()
registerLibraryMaintenanceHandlers()
registerPlaylistHandlers()
registerMediaMetadataHandlers()
registerSongEditHandlers()
registerCacheHandlers()
registerFilesystemHandlers()
registerClipboardHandlers()
registerExportHandlers()
registerKeyAnalysisHandlers()
registerAnalysisRuntimeHandlers()
registerDemucsModelHandlers()
registerMixtapeHandlers()
registerLibraryStemHandlers()
registerMixtapeDragSessionHandlers()
registerMixtapeProjectTempoHandlers()
registerSongSearchHandlers()
registerPioneerDeviceLibraryHandlers()
registerRekordboxDesktopLibraryHandlers()
registerRekordboxXmlExportHandlers()
registerHorizontalBrowseTransportHandlers()
registerHotCueHandlers()
registerMemoryCueHandlers()
registerDevSongListTraceHandlers()

// 歌单视图快照的后台核对入口。用注册钩子接 watcher，而不是让 watcher 直接 import 服务：
// 服务要 import mainWindow 推刷新事件，而 mainWindow/index 又 import 了 watcher，直连会成环。
bindLibraryTreeContentChangeListener((changedAbsPaths) => {
  invalidatePlaylistViewSnapshotsByPaths(changedAbsPaths)
})
startPlaylistViewSnapshotIdleVerification()

let appRuntimeCleanupDone = false
const cleanupAppRuntimeResources = () => {
  if (appRuntimeCleanupDone) return
  appRuntimeCleanupDone = true
  stopCloudSyncScheduler()
  stopCuratedLibraryLiveSync()
  stopPlaylistViewSnapshotIdleVerification()
  void cancelCuratedLibrarySync()
  terminateRegisteredChildProcesses()
  closeLibraryDb()
}

app.on('will-quit', cleanupAppRuntimeResources)
process.on('exit', cleanupAppRuntimeResources)

ipcMain.on('external-open:renderer-ready', (event) => {
  markExternalOpenRendererReady(event.sender)
})

keyAnalysisEvents.on('key-updated', (payload) => {
  markGlobalSongSearchDirty('key-analysis:key-updated')
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('song-key-updated', payload)
    } catch {}
  }
})

keyAnalysisEvents.on('energy-updated', (payload) => {
  markGlobalSongSearchDirty('key-analysis:energy-updated')
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('song-energy-updated', payload)
    } catch {}
  }
})

keyAnalysisEvents.on('structure-updated', (payload) => {
  markGlobalSongSearchDirty('key-analysis:structure-updated')
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('song-structure-updated', payload)
    } catch {}
  }
})

songGridEvents.on('grid-updated', (payload) => {
  markGlobalSongSearchDirty('song-grid:grid-updated')
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('song-grid-updated', payload)
    } catch {}
  }
  mixtapeWindow.broadcast?.('song-grid-updated', payload)
})

songGridEvents.on('grid-batch-updated', (payloads) => {
  markGlobalSongSearchDirty('song-grid:grid-batch-updated')
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('song-grid-batch-updated', payloads)
    } catch {}
  }
  mixtapeWindow.broadcast?.('song-grid-batch-updated', payloads)
})

songHotCueEvents.on('hot-cues-updated', (payload) => {
  markGlobalSongSearchDirty('song-hot-cues:updated')
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('song-hot-cues-updated', payload)
    } catch {}
  }
})

songMemoryCueEvents.on('memory-cues-updated', (payload) => {
  markGlobalSongSearchDirty('song-memory-cues:updated')
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('song-memory-cues-updated', payload)
    } catch {}
  }
})

keyAnalysisEvents.on('waveform-updated', (payload) => {
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('song-waveform-updated', payload)
    } catch {}
  }
})

keyAnalysisEvents.on('analysis-stage-update', (payload) => {
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('key-analysis:stage-update', payload)
    } catch {}
  }
})

keyAnalysisEvents.on('manual-batch-start', (payload) => {
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('key-analysis:manual-batch-start', payload)
    } catch {}
  }
})

keyAnalysisEvents.on('manual-batch-end', (payload) => {
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('key-analysis:manual-batch-end', payload)
    } catch {}
  }
})

keyAnalysisEvents.on('manual-batch-progress', (payload) => {
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('progressSet', payload)
    } catch {}
  }
})

analysisRuntimeDownloadEvents.on('state', (payload) => {
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('analysis-runtime-download-state', payload)
    } catch {}
  }
})

demucsUltraModelDownloadEvents.on('state', (payload) => {
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('demucs-model-download-state', payload)
    } catch {}
  }
})

const keyAnalysisBackgroundProgressId = 'key-analysis.background'
const sendKeyAnalysisBackgroundStatus = (status: KeyAnalysisBackgroundStatus) => {
  if (!mainWindow.instance) return
  if (!status.active) {
    mainWindow.instance.webContents.send('progressSet', {
      id: keyAnalysisBackgroundProgressId,
      dismiss: true
    })
    return
  }
  mainWindow.instance.webContents.send('progressSet', {
    id: keyAnalysisBackgroundProgressId,
    titleKey: 'keyAnalysis.backgroundAnalyzing',
    now: 0,
    total: 0,
    isInitial: true,
    noProgress: true,
    cancelable: true,
    cancelChannel: 'key-analysis:cancel-background'
  })
}
keyAnalysisEvents.on('background-status', sendKeyAnalysisBackgroundStatus)

registerBackgroundForegroundBusyProvider('key-analysis-foreground', () =>
  isKeyAnalysisForegroundBusy()
)
registerBackgroundForegroundBusyProvider(
  'mixtape-prewarm',
  () => isMixtapeStemQueueBusy() || isMixtapeWaveformQueueBusy() || isMixtapeRawWaveformQueueBusy()
)

// FORCE 只清内存中的库路径，不回写设置文件；看完初始化画面后关掉开关即可回到原库。
if (is.dev && String(process.env.FRKB_DEV_FORCE_LIBRARY_SETUP || '').trim() === '1') {
  store.settingConfig.databaseUrl = ''
} else if (is.dev && devDatabase) {
  store.settingConfig.databaseUrl = devDatabase
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('frkb.coderDjing')
  try {
    if (!protocol.isProtocolRegistered(PREVIEW_PROTOCOL)) {
      protocol.registerStreamProtocol(PREVIEW_PROTOCOL, async (request, callback) => {
        try {
          const safeDecode = (value: string) => {
            try {
              return decodeURIComponent(value)
            } catch {
              return value
            }
          }
          let decodedPath = ''
          try {
            const urlObj = new URL(request.url)
            const paramPath = urlObj.searchParams.get('path')
            if (paramPath) {
              decodedPath = paramPath
            } else {
              const host = urlObj.hostname || ''
              const pathname = urlObj.pathname || ''
              if (host && /^[a-zA-Z]$/.test(host) && pathname) {
                decodedPath = `${host}:${safeDecode(pathname)}`
              } else if (host && host !== 'local') {
                decodedPath = safeDecode(`${host}${pathname}`)
              } else {
                const rawPath = pathname.startsWith('/') ? pathname.slice(1) : pathname
                decodedPath = safeDecode(rawPath)
              }
            }
          } catch {
            const rawUrl = request.url || ''
            const match = rawUrl.match(/[?&]path=([^&]+)/i)
            if (match) {
              decodedPath = safeDecode(match[1])
            } else {
              const encodedPath = rawUrl.slice(`${PREVIEW_PROTOCOL}://`.length)
              const cleanedPath = (encodedPath || '').replace(/^\/+/, '')
              decodedPath = safeDecode(cleanedPath || '')
            }
          }

          if (decodedPath.startsWith('/') && /^[a-zA-Z]:\//.test(decodedPath.slice(1))) {
            decodedPath = decodedPath.slice(1)
          }
          if (!decodedPath) {
            callback({ statusCode: 400 })
            return
          }
          const stat = await fs.stat(decodedPath)
          const size = stat.size
          const rangeHeader = request.headers?.range || request.headers?.Range
          const mimeType = getPreviewMimeType(decodedPath)

          if (typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
            const range = rangeHeader.replace('bytes=', '').split('-')
            const start = Math.max(0, parseInt(range[0] || '0', 10))
            const end = range[1] ? Math.min(parseInt(range[1], 10), size - 1) : size - 1
            if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
              callback({ statusCode: 416 })
              return
            }
            const stream = fs.createReadStream(decodedPath, { start, end })
            callback({
              statusCode: 206,
              data: stream,
              mimeType,
              headers: {
                'Content-Type': mimeType,
                'Content-Range': `bytes ${start}-${end}/${size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': String(end - start + 1),
                'Access-Control-Allow-Origin': '*',
                'Cross-Origin-Resource-Policy': 'cross-origin'
              }
            })
            return
          }

          const stream = fs.createReadStream(decodedPath)
          callback({
            statusCode: 200,
            data: stream,
            mimeType,
            headers: {
              'Content-Type': mimeType,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(size),
              'Access-Control-Allow-Origin': '*',
              'Cross-Origin-Resource-Policy': 'cross-origin'
            }
          })
        } catch (error) {
          callback({ statusCode: 404 })
        }
      })
    }
  } catch (error) {
    log.error('[previewProtocol] register failed', error)
  }
  // 设置应用显示名称（影响菜单栏左上角 App 菜单标题）；不改变 appId / userData
  try {
    app.setName(PRODUCT_DISPLAY_NAME)
  } catch {}
  // 启动即按设置应用主题
  applyThemeFromSettings()
  // 处理启动时通过文件关联传入的音频文件
  queueExternalAudioFiles(process.argv.slice(1))
  if (process.platform === 'win32') {
    if (store.settingConfig.enableExplorerContextMenu !== false) {
      void ensureWindowsContextMenuIfNeeded().catch(() => {})
    } else {
      void removeWindowsContextMenu()
        .then(() => clearWindowsContextMenuSignature())
        .catch(() => {})
    }
  }
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
    void processExternalOpenQueue()
  })
  // macOS：交由模块化方法统一处理菜单
  if (process.platform === 'darwin') {
    setupMacMenus()
  }
  // 数据库准备与主窗口：统一调用幂等流程
  if (store.settingConfig.databaseUrl) {
    await startupWindow.createWindow()
  }
  await prepareAndOpenMainWindow()
  attachExternalOpenRendererLifecycle()
  startBackgroundOrchestrator()
  if (!isLibrarySetupActive()) {
    startKeyAnalysisBackground()
    void globalSongSearchEngine.warmup().catch(() => {})
  }
  startMixtapeStemBackgroundResume()
  LibraryCacheDb.scheduleCacheKeyMigration()
  await processExternalOpenQueue()
  setTimeout(() => {
    if (isLibrarySetupActive()) return
    maybeShowWhatsNew().catch((error) => {
      log.error('[whatsNew] maybeShowWhatsNew 异常', error)
    })
  }, 1500)
  // 初次创建窗口后，若为跟随系统，广播一次当前主题
  broadcastSystemThemeIfNeeded()
  setupAutoUpdate()
  // 在系统主题变化时（仅 system 模式关注）广播更新
  try {
    nativeTheme.on('updated', () => {
      broadcastSystemThemeIfNeeded()
    })
  } catch {}
  // 应用启动后，延迟对所有歌单目录做一次全量 sweep（保证重启后也能清理空歌单残留封面）
  try {
    setTimeout(async () => {
      if (!store.databaseDir) return
      const libRoot = path.join(store.databaseDir, 'library')
      const walk = async (dir: string) => {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true })
          for (const ent of entries) {
            const full = path.join(dir, ent.name)
            if (ent.isDirectory()) {
              const coversDir = path.join(full, '.frkb_covers')
              if (await fs.pathExists(coversDir)) {
                const dbEntries = await LibraryCacheDb.loadCoverIndexEntries(full)
                if (dbEntries) {
                  const liveHashes = new Set(dbEntries.map((item) => item.hash))
                  try {
                    const entries = await fs.readdir(coversDir)
                    const imgRegex = /^[a-f0-9]{40}\.(jpg|png|webp|gif|bmp)$/i
                    for (const name of entries) {
                      const fullPath = path.join(coversDir, name)
                      if (name.includes('.tmp_')) {
                        try {
                          await fs.remove(fullPath)
                        } catch {}
                        continue
                      }
                      if (!imgRegex.test(name)) continue
                      const hash = name.slice(0, 40).toLowerCase()
                      if (!liveHashes.has(hash)) {
                        try {
                          await fs.remove(fullPath)
                        } catch {}
                      }
                    }
                  } catch {}
                }
              }
              await walk(full)
            }
          }
        } catch {}
      }
      await walk(libRoot)
    }, 2000)
  } catch {}

  app.on('activate', async function () {
    await ensurePrimaryWindowVisible()
  })
})

app.on('window-all-closed', async () => {
  // removeAllListeners 在 app.quit() 前调用是安全的，因为项目中没有
  // before-quit 处理器会调用 event.preventDefault() 阻止退出。
  ipcMain.removeAllListeners()
  stopHorizontalBrowseTransportSnapshotBroadcaster()
  stopBackgroundOrchestrator()
  cleanupAppRuntimeResources()
  app.quit()
})

ipcMain.on('outputLog', (_event, logMsg) => {
  const normalizeLevelFromText = (text: string): LogLevel => {
    const normalized = String(text || '').toLowerCase()
    if (normalized.includes('[console.debug]') || normalized.includes('[debug]')) return 'debug'
    if (normalized.includes('[console.info]') || normalized.includes('[console.log]')) return 'info'
    if (normalized.includes('[console.warn]') || /\bwarn(?:ing)?\b|警告/.test(normalized)) {
      return 'warn'
    }
    if (
      normalized.includes('[console.error]') ||
      /\b(error|failed|exception|unhandled)\b|错误|异常|失败|捕获|messageerror/.test(normalized)
    ) {
      return 'error'
    }
    return 'info'
  }

  const normalizeOutputLogPayload = (
    payload: unknown
  ): { level: LogLevel; text: string } | null => {
    if (typeof payload === 'string') {
      const text = payload.trim()
      if (!text) return null
      return {
        level: normalizeLevelFromText(text),
        text
      }
    }

    if (!payload || typeof payload !== 'object') return null
    const record = payload as Record<string, unknown>
    const rawMessage = record.message
    const message =
      typeof rawMessage === 'string' ? rawMessage.trim() : String(rawMessage || '').trim()
    if (!message) return null

    const rawLevel = typeof record.level === 'string' ? record.level.trim().toLowerCase() : ''
    const level: LogLevel =
      rawLevel === 'debug' || rawLevel === 'info' || rawLevel === 'warn' || rawLevel === 'error'
        ? rawLevel
        : normalizeLevelFromText(message)
    const source = typeof record.source === 'string' ? record.source.trim() : ''
    const scope = typeof record.scope === 'string' ? record.scope.trim() : ''
    const prefix = [source, scope].filter(Boolean).join(':')
    return {
      level,
      text: prefix ? `[${prefix}] ${message}` : message
    }
  }

  const normalized = normalizeOutputLogPayload(logMsg)
  if (!normalized) return
  log[normalized.level](normalized.text)
})

ipcMain.on('openLocalBrowser', (_event, url: string) => {
  openSafeExternalUrl(url)
})

ipcMain.on('openLog', async () => {
  await openLogFile()
})

ipcMain.on('main-window-browse-mode-updated', (_e, mode: 'browser' | 'horizontal' | 'edit') => {
  if (mode !== 'browser' && mode !== 'horizontal' && mode !== 'edit') return
  setMacMainWindowBrowseMode(mode)
  rebuildMacMenusForCurrentFocus()
})

ipcMain.handle('clearTracksFingerprintLibrary', async (_e) => {
  try {
    if (!store.databaseDir) {
      return { success: false, message: 'database.notConfigured' }
    }
    await replaceFingerprintList(
      [],
      store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
    )
    return { success: true }
  } catch (error: unknown) {
    log.error('clearTracksFingerprintLibrary failed', error)
    return { success: false, message: String(error instanceof Error ? error.message : error) }
  }
})

ipcMain.handle('getSongFingerprintListLength', () => {
  return store.songFingerprintList.length
})
