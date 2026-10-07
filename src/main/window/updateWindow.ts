import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { log } from '../log'
import type { ResolvedUpdateFileInfo, UpdateInfo } from 'electron-updater'
import electronUpdater = require('electron-updater')
import path = require('path')
import {
  type ManualMacUpdateAsset,
  type ManualMacUpdateAssetKind,
  type ManualMacUpdateResult,
  downloadManualMacUpdate,
  pickManualMacUpdateAsset
} from '../services/manualMacUpdate'
import { fetchReleaseNotesRange } from '../services/releaseNotes'
import {
  classifyUpdateError,
  logIfUnexpectedUpdateError,
  type UpdateErrorKind
} from '../services/updateError'
import { GITHUB_RELEASES_URL } from '@shared/productBrand'
import { isLibraryMergeActive } from '../services/libraryMerge'
import { installResumableAutoUpdaterDownload } from '../services/resumableAutoUpdaterDownload'
import { updateDownloadDiagnosticLogger } from '../services/updateDownloadDiagnostic'
import { installPublishedReleaseUpdateProvider } from '../services/publishedReleaseUpdateProvider'
import { openSafeExternalUrl, restrictExternalNavigation } from './externalNavigation'
import type { ReleaseNotesRangePayload } from '../../shared/releaseNotes'
const autoUpdater = electronUpdater.autoUpdater
let updateWindow: BrowserWindow | null = null
const RELEASES_BASE_URL = GITHUB_RELEASES_URL
const DEFAULT_MANUAL_UPDATE_URL = `${RELEASES_BASE_URL}/latest`
let autoUpdaterListenersRegistered = false
let latestMacManualUpdateAsset: ManualMacUpdateAsset | null = null
let latestMacManualUpdateResult: ManualMacUpdateResult | null = null
let manualMacDownloadPromise: Promise<ManualMacUpdateResult> | null = null
let latestManualUpdateUrl = DEFAULT_MANUAL_UPDATE_URL
let lastReleaseNotesRange: ReleaseNotesRangePayload | null = null
let lastReleaseNotesRangeSettled = false
let lastUpdateInfo: UpdateInfo | null = null
let autoDownloadInProgress = false

type AutoUpdaterProvider = {
  resolveFiles?: (updateInfo: UpdateInfo) => ResolvedUpdateFileInfo[]
}

type AutoUpdaterWithExtras = typeof autoUpdater & {
  updateInfoAndProvider?: {
    provider?: AutoUpdaterProvider
  }
  allowPrerelease?: boolean
  channel?: string
}

type BrowserWindowWithVisualEffect = BrowserWindow & {
  setVisualEffectMaterial?: (material: string) => void
}

type UpdateErrorPayload = {
  kind: UpdateErrorKind
  message: string
  manualUrl?: string
}

type UpdateDownloadedPayload = {
  mode: 'auto' | 'manual'
  kind?: ManualMacUpdateAssetKind
  fileName?: string
  filePath?: string
  downloadDir?: string
}

type CreateUpdateWindowOptions =
  | boolean
  | {
      skipCheck?: boolean
      startDownload?: boolean
    }

const normalizeCreateOptions = (
  options: CreateUpdateWindowOptions
): { skipCheck: boolean; startDownload: boolean } => {
  if (typeof options === 'boolean') {
    return {
      skipCheck: options,
      startDownload: false
    }
  }
  return {
    skipCheck: options.skipCheck === true,
    startDownload: options.startDownload === true
  }
}

const sendToUpdateWindow = (channel: string, payload?: unknown) => {
  if (!updateWindow || updateWindow.isDestroyed()) return
  updateWindow.webContents.send(channel, payload)
}

const sendLastReleaseNotesRange = () => {
  if (!lastReleaseNotesRangeSettled) return
  sendToUpdateWindow('releaseNotesRange', lastReleaseNotesRange)
}

const setLastReleaseNotesRange = (releaseNotes: ReleaseNotesRangePayload | null) => {
  lastReleaseNotesRange = releaseNotes
  lastReleaseNotesRangeSettled = true
  sendLastReleaseNotesRange()
}

const setLatestManualUpdateVersion = (version: string) => {
  const safeVersion = typeof version === 'string' ? version.trim() : ''
  latestManualUpdateUrl = safeVersion
    ? `${RELEASES_BASE_URL}/tag/${encodeURIComponent(safeVersion)}`
    : DEFAULT_MANUAL_UPDATE_URL
}

const resolveUpdateFiles = (updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] => {
  const provider = (autoUpdater as AutoUpdaterWithExtras).updateInfoAndProvider?.provider
  if (provider?.resolveFiles instanceof Function) {
    try {
      return provider.resolveFiles(updateInfo) as ResolvedUpdateFileInfo[]
    } catch (error) {
      log.error('[updateWindow] resolveFiles failed', error)
    }
  }

  return (Array.isArray(updateInfo?.files) ? updateInfo.files : [])
    .map((file) => {
      if (!file?.url || !/^https?:\/\//i.test(file.url)) return null
      try {
        return {
          url: new URL(file.url),
          info: file
        } satisfies ResolvedUpdateFileInfo
      } catch {
        return null
      }
    })
    .filter((entry): entry is ResolvedUpdateFileInfo => !!entry)
}

const rememberMacManualUpdateAsset = (updateInfo: UpdateInfo) => {
  if (process.platform !== 'darwin') return
  latestMacManualUpdateResult = null
  latestMacManualUpdateAsset = pickManualMacUpdateAsset(updateInfo, resolveUpdateFiles(updateInfo))
  if (!latestMacManualUpdateAsset) {
    log.error('[updateWindow] no mac manual update asset resolved', {
      version: updateInfo?.version,
      files: updateInfo?.files
    })
  }
}

const setCachedUpdateInfo = (info: UpdateInfo) => {
  setLatestManualUpdateVersion(info.version)
  lastReleaseNotesRange = null
  lastReleaseNotesRangeSettled = false
  lastUpdateInfo = info
  rememberMacManualUpdateAsset(info)
}

const buildUpdateErrorPayload = (error: unknown): UpdateErrorPayload => {
  const classified = classifyUpdateError(error)
  if (classified.kind === 'signature') {
    return {
      kind: classified.kind,
      message: classified.message,
      manualUrl: latestManualUpdateUrl
    }
  }
  if (classified.kind === 'gone') {
    return {
      kind: classified.kind,
      message: classified.message,
      manualUrl: DEFAULT_MANUAL_UPDATE_URL
    }
  }
  if (classified.kind === 'network') {
    return {
      kind: classified.kind,
      message: classified.message
    }
  }
  return {
    kind: classified.kind,
    message: classified.message,
    manualUrl: process.platform === 'darwin' ? latestManualUpdateUrl : undefined
  }
}

const reportUpdateErrorToWindow = (tag: string, error: unknown) => {
  const payload = buildUpdateErrorPayload(error)
  sendToUpdateWindow('isError', payload)
  logIfUnexpectedUpdateError(tag, error, payload)
  return payload
}

const normalizeDownloadProgress = (progressObj: {
  percent?: unknown
  bytesPerSecond?: unknown
  transferred?: unknown
  transferredBytes?: unknown
  total?: unknown
  totalBytes?: unknown
  fileName?: unknown
}) => ({
  percent: Number(progressObj?.percent) || 0,
  bytesPerSecond: Number(progressObj?.bytesPerSecond) || 0,
  transferredBytes: Math.max(
    0,
    Number(progressObj?.transferredBytes ?? progressObj?.transferred) || 0
  ),
  totalBytes: Math.max(0, Number(progressObj?.totalBytes ?? progressObj?.total) || 0),
  fileName: typeof progressObj?.fileName === 'string' ? progressObj.fileName : ''
})

const registerAutoUpdaterListeners = () => {
  if (autoUpdaterListenersRegistered) return
  autoUpdaterListenersRegistered = true
  autoUpdater.logger = updateDownloadDiagnosticLogger
  installResumableAutoUpdaterDownload(autoUpdater)
  installPublishedReleaseUpdateProvider(autoUpdater)

  autoUpdater.on('update-available', (info) => {
    const currentIsPrerelease = app.getVersion().includes('-')
    const remoteIsPrerelease = typeof info?.version === 'string' && info.version.includes('-')
    if (currentIsPrerelease !== remoteIsPrerelease) return
    setCachedUpdateInfo(info)
    sendToUpdateWindow('newVersion', info)
    void fetchReleaseNotesRange(app.getVersion(), info.version)
      .then((releaseNotes) => {
        setLastReleaseNotesRange(releaseNotes)
      })
      .catch((error) => {
        setLastReleaseNotesRange(null)
        logIfUnexpectedUpdateError('[updateWindow] fetch release notes failed', error)
      })
  })

  autoUpdater.on('update-not-available', (info) => {
    // 当同轨道无更新，才提示“已是最新版本”
    const currentIsPrerelease = app.getVersion().includes('-')
    const remoteVersion = info?.version
    const remoteIsPrerelease = !!(remoteVersion && remoteVersion.includes('-'))
    if (remoteVersion && currentIsPrerelease === remoteIsPrerelease) {
      sendToUpdateWindow('isLatestVersion', info.version)
    } else if (!remoteVersion) {
      sendToUpdateWindow('isLatestVersion', app.getVersion())
    }
  })

  autoUpdater.on('error', (err) => {
    autoDownloadInProgress = false
    reportUpdateErrorToWindow('autoUpdater error', err)
  })

  autoUpdater.on('download-progress', (progressObj) => {
    sendToUpdateWindow('updateProgress', normalizeDownloadProgress(progressObj))
  })

  autoUpdater.on('update-downloaded', () => {
    autoDownloadInProgress = false
    sendToUpdateWindow('updateDownloaded', {
      mode: 'auto'
    } satisfies UpdateDownloadedPayload)
  })
}

const handleStartDownload = () => {
  if (process.platform === 'darwin') {
    if (!latestMacManualUpdateAsset) {
      const payload: UpdateErrorPayload = {
        kind: 'unknown',
        message: '没有找到可下载的新版本文件，请稍后重试。',
        manualUrl: latestManualUpdateUrl
      }
      sendToUpdateWindow('isError', payload)
      log.error('[updateWindow] missing mac manual update asset')
      return
    }

    if (manualMacDownloadPromise) return

    // 立刻切到进度条，避免真正开始下载前仍停在「发现新版本」页
    sendToUpdateWindow(
      'updateProgress',
      normalizeDownloadProgress({
        percent: 0,
        bytesPerSecond: 0,
        transferredBytes: 0,
        totalBytes: latestMacManualUpdateAsset.totalBytes,
        fileName: latestMacManualUpdateAsset.fileName
      })
    )

    manualMacDownloadPromise = downloadManualMacUpdate(latestMacManualUpdateAsset, (progress) => {
      sendToUpdateWindow('updateProgress', progress)
    })

    void manualMacDownloadPromise
      .then((result) => {
        latestMacManualUpdateResult = result
        openDownloadedFilePath(result.filePath)
        sendToUpdateWindow('updateDownloaded', {
          mode: 'manual',
          kind: result.kind,
          fileName: result.fileName,
          filePath: result.filePath,
          downloadDir: result.downloadDir
        } satisfies UpdateDownloadedPayload)
      })
      .catch((error) => {
        const payload = buildUpdateErrorPayload(error)
        payload.manualUrl = latestManualUpdateUrl
        sendToUpdateWindow('isError', payload)
        logIfUnexpectedUpdateError(
          '[updateWindow] manual mac update download failed',
          error,
          payload
        )
      })
      .finally(() => {
        manualMacDownloadPromise = null
      })
    return
  }

  if (autoDownloadInProgress) return
  autoDownloadInProgress = true
  // 立刻切到进度条，避免真正开始下载前仍停在「发现新版本」页
  sendToUpdateWindow(
    'updateProgress',
    normalizeDownloadProgress({
      percent: 0,
      bytesPerSecond: 0,
      transferredBytes: 0,
      totalBytes: 0,
      fileName: ''
    })
  )
  void autoUpdater.downloadUpdate().catch((error) => {
    autoDownloadInProgress = false
    reportUpdateErrorToWindow('[updateWindow] downloadUpdate failed', error)
  })
}

const isDownloadInProgress = () => autoDownloadInProgress || !!manualMacDownloadPromise

const handleRecheck = () => {
  if (isDownloadInProgress()) return
  lastUpdateInfo = null
  latestMacManualUpdateAsset = null
  latestMacManualUpdateResult = null
  lastReleaseNotesRange = null
  lastReleaseNotesRangeSettled = false
  latestManualUpdateUrl = DEFAULT_MANUAL_UPDATE_URL
  sendToUpdateWindow('isRequesting')
  void autoUpdater.checkForUpdates().catch((error) => {
    reportUpdateErrorToWindow('[updateWindow] recheck failed', error)
  })
}

const handleToggleClose = () => {
  updateWindow?.close()
}

const handleToggleMinimize = () => {
  updateWindow?.minimize()
}

const handleOpenManualDownload = () => {
  openSafeExternalUrl(latestManualUpdateUrl)
}

const openDownloadedFilePath = (filePath: string) => {
  void shell.openPath(filePath).then((result) => {
    if (!result) return
    log.error('[updateWindow] open downloaded file failed', { filePath, result })
    try {
      shell.showItemInFolder(filePath)
    } catch (error) {
      log.error('[updateWindow] fallback showItemInFolder failed', { filePath, error })
    }
  })
}

const handleOpenDownloadedFile = () => {
  const filePath = latestMacManualUpdateResult?.filePath
  if (!filePath) return
  openDownloadedFilePath(filePath)
}

const handleOpenDownloadFolder = () => {
  const filePath = latestMacManualUpdateResult?.filePath
  if (!filePath) return
  try {
    shell.showItemInFolder(filePath)
  } catch (error) {
    log.error('[updateWindow] showItemInFolder failed', { filePath, error })
  }
}

const handleOpenApplicationsFolder = () => {
  if (process.platform !== 'darwin') return
  void shell.openPath('/Applications').then((result) => {
    if (result) {
      log.error('[updateWindow] open applications folder failed', result)
    }
  })
}

let quittingForManualMacUpdate = false
const handleQuitApp = () => {
  if (process.platform !== 'darwin') return
  if (quittingForManualMacUpdate) return
  // 合并进行中不能退出，避免中断写库。
  if (isLibraryMergeActive()) return
  quittingForManualMacUpdate = true
  app.quit()
}

const handleRestartAppForUpdate = () => {
  if (process.platform !== 'win32') return
  // 合并进行中不能退出，避免中断写库。
  if (isLibraryMergeActive()) return
  autoUpdater.quitAndInstall()
}

const startCachedDownload = () => {
  handleStartDownload()
}

const createWindow = (options: CreateUpdateWindowOptions = false) => {
  const { skipCheck, startDownload } = normalizeCreateOptions(options)
  registerAutoUpdaterListeners()
  updateWindow = new BrowserWindow({
    resizable: true,
    width: 700,
    height: 560,
    minWidth: 560,
    minHeight: 420,
    frame: process.platform === 'darwin' ? true : false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    transparent: false,
    show: false,
    backgroundColor: '#000000',
    maximizable: false,

    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false,
      backgroundThrottling: false
    }
  })

  if (process.platform === 'darwin') {
    try {
      updateWindow.setVibrancy('under-window')
    } catch {}
    try {
      ;(updateWindow as BrowserWindowWithVisualEffect).setVisualEffectMaterial?.('under-window')
    } catch {}
  }

  restrictExternalNavigation(updateWindow.webContents)

  updateWindow.webContents.on('did-finish-load', () => {
    sendLastReleaseNotesRange()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const updatePageUrl = new URL(`${process.env['ELECTRON_RENDERER_URL']}/update.html`)
    if (startDownload) {
      updatePageUrl.searchParams.set('startDownload', '1')
    }
    updateWindow.loadURL(updatePageUrl.toString())
  } else {
    updateWindow.loadFile(path.join(__dirname, '../renderer/update.html'), {
      query: startDownload ? { startDownload: '1' } : undefined
    })
  }

  updateWindow.on('ready-to-show', () => {
    updateWindow?.show()
    autoUpdater.autoDownload = false
    const versionString = app.getVersion()
    const isPrerelease = versionString.includes('-')
    try {
      ;(autoUpdater as AutoUpdaterWithExtras).allowPrerelease = isPrerelease
    } catch {}
    try {
      if (isPrerelease && /-rc[.-]/i.test(versionString)) {
        ;(autoUpdater as AutoUpdaterWithExtras).channel = 'rc'
      }
    } catch {}
    if (skipCheck) {
      if (lastUpdateInfo) {
        if (startDownload) {
          // 用户已在「发现新版本」确认过，不要再发 newVersion 把同一页弹出来
          handleStartDownload()
        } else {
          sendToUpdateWindow('newVersion', lastUpdateInfo)
          sendLastReleaseNotesRange()
        }
      } else {
        log.error('[updateWindow] skipCheck without cached update info')
        sendToUpdateWindow('isError', {
          kind: 'unknown',
          message: '没有可用的新版本信息，请重新检查更新。'
        } satisfies UpdateErrorPayload)
      }
      // skipCheck 模式下无论如何都不重新检查，避免跳回检查更新界面
      return
    }
    void autoUpdater.checkForUpdates().catch((error) => {
      reportUpdateErrorToWindow('[updateWindow] checkForUpdates failed', error)
    })
  })
  ipcMain.on('updateWindow-startDownload', handleStartDownload)
  ipcMain.on('updateWindow-recheck', handleRecheck)
  ipcMain.on('updateWindow-toggle-close', handleToggleClose)
  ipcMain.on('updateWindow-toggle-minimize', handleToggleMinimize)
  ipcMain.on('updateWindow-open-manual-download', handleOpenManualDownload)
  ipcMain.on('updateWindow-open-downloaded-file', handleOpenDownloadedFile)
  ipcMain.on('updateWindow-open-download-folder', handleOpenDownloadFolder)
  ipcMain.on('updateWindow-open-applications-folder', handleOpenApplicationsFolder)
  ipcMain.on('updateWindow-quit-app', handleQuitApp)
  ipcMain.on('updateWindow-restart-app-for-update', handleRestartAppForUpdate)

  updateWindow.on('closed', () => {
    ipcMain.removeListener('updateWindow-startDownload', handleStartDownload)
    ipcMain.removeListener('updateWindow-recheck', handleRecheck)
    ipcMain.removeListener('updateWindow-toggle-close', handleToggleClose)
    ipcMain.removeListener('updateWindow-toggle-minimize', handleToggleMinimize)
    ipcMain.removeListener('updateWindow-open-manual-download', handleOpenManualDownload)
    ipcMain.removeListener('updateWindow-open-downloaded-file', handleOpenDownloadedFile)
    ipcMain.removeListener('updateWindow-open-download-folder', handleOpenDownloadFolder)
    ipcMain.removeListener('updateWindow-open-applications-folder', handleOpenApplicationsFolder)
    ipcMain.removeListener('updateWindow-quit-app', handleQuitApp)
    ipcMain.removeListener('updateWindow-restart-app-for-update', handleRestartAppForUpdate)
    updateWindow = null
  })
}

export default {
  get instance() {
    return updateWindow
  },
  createWindow,
  setLastUpdateInfo: (info: UpdateInfo) => {
    setCachedUpdateInfo(info)
  },
  setLastReleaseNotesRange,
  startCachedDownload
}
