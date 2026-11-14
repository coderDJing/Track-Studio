import { app, ipcMain } from 'electron'
import electronUpdater = require('electron-updater')
import type { UpdateInfo } from 'electron-updater'
import {
  EMPTY_APP_UPDATE_STATE,
  type AppUpdateState,
  type AppUpdateChannel
} from '@shared/appUpdate'
import { GITHUB_RELEASES_URL } from '@shared/productBrand'
import { log } from '../log'
import { fetchReleaseNotesRange } from './releaseNotes'
import { classifyUpdateError, logIfUnexpectedUpdateError } from './updateError'
import { isLibraryMergeActive } from './libraryMerge'
import { installResumableAutoUpdaterDownload } from './resumableAutoUpdaterDownload'
import { installPublishedReleaseUpdateProvider } from './publishedReleaseUpdateProvider'
import { updateDownloadDiagnosticLogger } from './updateDownloadDiagnostic'
import { openSafeExternalUrl } from '../window/externalNavigation'

const autoUpdater = electronUpdater.autoUpdater
const RELEASES_BASE_URL = GITHUB_RELEASES_URL
const DEFAULT_MANUAL_URL = `${RELEASES_BASE_URL}/latest`

type AutoUpdaterWithExtras = typeof autoUpdater & {
  allowPrerelease?: boolean
  channel?: string
}

let state: AppUpdateState = { ...EMPTY_APP_UPDATE_STATE }
let sendEvent: ((channel: string, payload: unknown) => void) | null = null
let listenersRegistered = false
let handlersRegistered = false
let downloadInProgress = false
let downloadStarting = false
let checkInProgress = false
/** 静默检查期间（启动自动检查）失败不打扰用户，也不留错误行。 */
let silentPhase = false
/** 静默检查进行中用户又手动点了检查：等静默那次结束后补一次真实反馈。 */
let pendingManualCheck = false
let manualUrl = DEFAULT_MANUAL_URL

const publish = (patch: Partial<AppUpdateState>, options?: { silent?: boolean }) => {
  state = { ...state, ...patch, updatedAt: Date.now() }
  if (options?.silent === true) return
  sendEvent?.('app-update:state', state)
}

const resolveChannel = (version: string): AppUpdateChannel =>
  String(version || '').includes('-') ? 'rc' : 'stable'

/**
 * 主窗口创建 / 关闭时挂载或摘除事件接收器。
 * 通过回调注入，避免主进程窗口模块与本服务互相 import 形成环。
 */
export const setUpdateEventSender = (
  sender: ((channel: string, payload: unknown) => void) | null
) => {
  sendEvent = sender
  if (sender) sender('app-update:state', state)
}

const normalizeProgress = (progressObj: {
  percent?: unknown
  transferred?: unknown
  transferredBytes?: unknown
  total?: unknown
  totalBytes?: unknown
}) => ({
  percent: Math.max(0, Math.min(100, Number(progressObj?.percent) || 0)),
  transferredBytes: Math.max(
    0,
    Number(progressObj?.transferredBytes ?? progressObj?.transferred) || 0
  ),
  totalBytes: Math.max(0, Number(progressObj?.totalBytes ?? progressObj?.total) || 0)
})

const publishError = (tag: string, error: unknown) => {
  const classified = classifyUpdateError(error)
  manualUrl = `${RELEASES_BASE_URL}/latest`
  downloadInProgress = false
  downloadStarting = false
  logIfUnexpectedUpdateError(tag, error, { kind: classified.kind, message: classified.message })
  if (silentPhase) {
    // 只清掉本次静默检查留下的中间态，不能把已有的“发现新版本/已下载”抹掉。
    if (state.status === 'checking') state = { ...EMPTY_APP_UPDATE_STATE, updatedAt: Date.now() }
    return
  }
  publish({
    status: 'error',
    errorKind: classified.kind,
    error: classified.message || String(error || ''),
    manualUrl,
    silent: false
  })
}

const rememberAvailable = (info: UpdateInfo) => {
  manualUrl = info?.version
    ? `${RELEASES_BASE_URL}/tag/${encodeURIComponent(String(info.version).trim())}`
    : DEFAULT_MANUAL_URL
  publish({
    status: 'available',
    version: typeof info?.version === 'string' ? info.version : '',
    releaseDate: typeof info?.releaseDate === 'string' ? info.releaseDate : '',
    channel: resolveChannel(info?.version || ''),
    percent: 0,
    transferredBytes: 0,
    totalBytes: 0,
    errorKind: '',
    error: '',
    manualUrl,
    releaseNotes: null,
    releaseNotesLoading: true,
    silent: false
  })
  void fetchReleaseNotesRange(app.getVersion(), String(info?.version || ''))
    .then((notes) => publish({ releaseNotes: notes, releaseNotesLoading: false }))
    .catch((error) => {
      publish({ releaseNotes: null, releaseNotesLoading: false })
      logIfUnexpectedUpdateError('[appUpdate] fetch release notes failed', error)
    })
}

const publishLatest = (version: string) => {
  publish(
    { status: 'latest', version, silent: silentPhase },
    silentPhase ? { silent: true } : undefined
  )
}

const registerListeners = () => {
  if (listenersRegistered) return
  listenersRegistered = true
  autoUpdater.logger = updateDownloadDiagnosticLogger
  installResumableAutoUpdaterDownload(autoUpdater)
  installPublishedReleaseUpdateProvider(autoUpdater)

  autoUpdater.on('update-available', (info) => {
    const currentIsPrerelease = app.getVersion().includes('-')
    const remoteIsPrerelease = typeof info?.version === 'string' && info.version.includes('-')
    if (currentIsPrerelease !== remoteIsPrerelease) return
    rememberAvailable(info)
  })

  autoUpdater.on('update-not-available', (info) => {
    const currentIsPrerelease = app.getVersion().includes('-')
    const remoteVersion = info?.version
    const remoteIsPrerelease = !!(remoteVersion && remoteVersion.includes('-'))
    if (remoteVersion && currentIsPrerelease === remoteIsPrerelease) {
      publishLatest(String(remoteVersion))
      return
    }
    if (!remoteVersion) publishLatest(app.getVersion())
  })

  autoUpdater.on('download-progress', (progressObj) => {
    publish({ status: 'downloading', ...normalizeProgress(progressObj), silent: false })
  })

  autoUpdater.on('update-downloaded', () => {
    downloadInProgress = false
    publish({ status: 'downloaded', percent: 100, silent: false })
  })

  autoUpdater.on('error', (error) => {
    publishError('[appUpdate] autoUpdater error', error)
  })
}

const applyChannelConfig = () => {
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
}

export const checkForUpdates = async (options?: { silent?: boolean }) => {
  init()
  const silent = options?.silent === true
  if (checkInProgress) {
    if (!silent) pendingManualCheck = true
    return state
  }
  checkInProgress = true
  silentPhase = silent
  autoUpdater.autoDownload = false
  applyChannelConfig()
  publish(
    { status: 'checking', errorKind: '', error: '', silent: silentPhase },
    silentPhase ? { silent: true } : undefined
  )
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    publishError('[appUpdate] checkForUpdates failed', error)
  } finally {
    checkInProgress = false
    silentPhase = false
    if (pendingManualCheck) {
      pendingManualCheck = false
      void checkForUpdates()
    }
  }
  return state
}

export const startDownload = async () => {
  init()
  // downloadStarting 覆盖“重试时先重新检查”的那几秒，避免连点触发重复下载。
  if (downloadInProgress || downloadStarting) return state
  downloadStarting = true
  try {
    // 上一次失败后重试：先重新确认版本可用，再进入下载。
    if (state.status === 'error') {
      await checkForUpdates()
    }
    if (state.status !== 'available') return state
    downloadInProgress = true
    publish({
      status: 'downloading',
      percent: 0,
      transferredBytes: 0,
      totalBytes: 0,
      error: '',
      silent: false
    })
    // 下载耗时很长，不能 await：否则 IPC 会一直挂到下载结束才返回。
    void autoUpdater
      .downloadUpdate()
      .catch((error) => publishError('[appUpdate] downloadUpdate failed', error))
    return state
  } finally {
    downloadStarting = false
  }
}

export const installAndRestart = () => {
  if (state.status !== 'downloaded') return state
  // 合并进行中不能退出，避免中断写库。
  if (isLibraryMergeActive()) {
    log.error('[appUpdate] 资料库合并进行中，已跳过重启安装')
    return state
  }
  autoUpdater.quitAndInstall()
  return state
}

export const openManualDownload = () => {
  openSafeExternalUrl(manualUrl || DEFAULT_MANUAL_URL)
}

export const getState = () => state

export const registerHandlers = () => {
  if (handlersRegistered) return
  handlersRegistered = true
  ipcMain.handle('app-update:get-state', () => state)
  ipcMain.handle('app-update:check', () => {
    void checkForUpdates()
    return state
  })
  ipcMain.handle('app-update:download', () => startDownload())
  ipcMain.handle('app-update:install', () => installAndRestart())
  ipcMain.handle('app-update:open-manual-download', () => {
    openManualDownload()
    return true
  })
}

export const init = () => {
  registerHandlers()
  registerListeners()
  applyChannelConfig()
}

export default {
  init,
  setUpdateEventSender,
  checkForUpdates,
  startDownload,
  installAndRestart,
  openManualDownload,
  getState,
  registerHandlers
}
