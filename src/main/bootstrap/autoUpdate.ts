import { app } from 'electron'
import electronUpdater = require('electron-updater')
import updateWindow from '../window/updateWindow'
import foundNewVersionWindow from '../window/foundNewVersionWindow'
import store from '../store'
import { fetchReleaseNotesRange } from '../services/releaseNotes'
import { logIfUnexpectedUpdateError } from '../services/updateError'
import { installResumableAutoUpdaterDownload } from '../services/resumableAutoUpdaterDownload'
import { updateDownloadDiagnosticLogger } from '../services/updateDownloadDiagnostic'
import { installPublishedReleaseUpdateProvider } from '../services/publishedReleaseUpdateProvider'
import appUpdateService from '../services/appUpdateService'

type AutoUpdaterWithExtras = typeof electronUpdater.autoUpdater & {
  allowPrerelease?: boolean
  channel?: string
}

export function setupAutoUpdate() {
  const autoUpdater = electronUpdater.autoUpdater as AutoUpdaterWithExtras
  autoUpdater.autoDownload = false
  autoUpdater.logger = updateDownloadDiagnosticLogger
  installResumableAutoUpdaterDownload(autoUpdater)
  installPublishedReleaseUpdateProvider(autoUpdater)
  const versionString = app.getVersion()
  const isPrerelease = versionString.includes('-')

  try {
    autoUpdater.allowPrerelease = isPrerelease
  } catch {}

  try {
    if (isPrerelease && /-rc[.-]/i.test(versionString)) {
      autoUpdater.channel = 'rc'
    }
  } catch {}

  const nextCheckTime = store.settingConfig.nextCheckUpdateTime
  const shouldCheck = !nextCheckTime || new Date() > new Date(nextCheckTime)

  // Windows 走右下角统一下载卡片：更新状态直接推给主窗口，不再打开独立更新窗口。
  if (process.platform === 'win32') {
    appUpdateService.init()
    if (shouldCheck) {
      // 启动检查保持静默：只有真的发现新版本才在卡片里提示。
      void appUpdateService.checkForUpdates({ silent: true })
    }
    return
  }

  // macOS 保留既有链路：发现新版本窗口 -> 更新窗口（手动 dmg 流程）。
  if (shouldCheck) {
    void autoUpdater.checkForUpdates().catch((error) => {
      logIfUnexpectedUpdateError('[autoUpdate] initial check failed', error)
    })
  }

  autoUpdater.on('update-available', (info) => {
    const currentIsPrerelease = app.getVersion().includes('-')
    const remoteIsPrerelease = typeof info?.version === 'string' && info.version.includes('-')

    if (currentIsPrerelease !== remoteIsPrerelease) {
      return
    }
    updateWindow.setLastUpdateInfo(info)
    if (updateWindow.instance === null) {
      foundNewVersionWindow.open(info, null, true)
      void fetchReleaseNotesRange(app.getVersion(), info.version)
        .then((releaseNotes) => {
          foundNewVersionWindow.updateReleaseNotes(releaseNotes)
          updateWindow.setLastReleaseNotesRange(releaseNotes)
        })
        .catch((error) => {
          logIfUnexpectedUpdateError('[autoUpdate] fetch release notes failed', error)
          foundNewVersionWindow.updateReleaseNotes(null)
          updateWindow.setLastReleaseNotesRange(null)
        })
    }
  })
}
