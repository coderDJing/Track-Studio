import store from '../store'
import appUpdateService from '../services/appUpdateService'

/**
 * 自动更新入口：Windows 与 macOS 共用右下角统一下载卡片。
 * 检查/下载/安装的状态机、electron-updater 的监听与 GitHub Release 更新源都在
 * appUpdateService 里，这里只负责按上次检查时间决定要不要在启动时静默查一次。
 */
export function setupAutoUpdate() {
  appUpdateService.init()

  const nextCheckTime = store.settingConfig.nextCheckUpdateTime
  const shouldCheck = !nextCheckTime || new Date() > new Date(nextCheckTime)
  if (!shouldCheck) return

  // 启动检查保持静默：只有真的发现新版本才在卡片里提示。
  void appUpdateService.checkForUpdates({ silent: true })
}
