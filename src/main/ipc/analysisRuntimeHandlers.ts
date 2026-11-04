import { ipcMain } from 'electron'
import store from '../store'
import {
  clearInstalledAnalysisRuntimes,
  downloadPreferredAnalysisRuntime,
  getAnalysisRuntimeDownloadState,
  getPreferredAnalysisRuntimeDownloadInfo
} from '../services/analysisRuntimeDownload'
import { persistSettingConfig } from '../settingsPersistence'
import mainWindow from '../window/mainWindow'

const ANALYSIS_RUNTIME_CLEAR_PROGRESS_ID = 'analysis-runtime.clear-local'

export function registerAnalysisRuntimeHandlers() {
  ipcMain.handle('analysis-runtime:get-status', async (_event, requireBpmFix: unknown) => {
    return {
      preferred: await getPreferredAnalysisRuntimeDownloadInfo(requireBpmFix === true),
      state: getAnalysisRuntimeDownloadState()
    }
  })

  ipcMain.handle('analysis-runtime:download-preferred', async (_event, requireBpmFix: unknown) => {
    const started = await downloadPreferredAnalysisRuntime(requireBpmFix === true)
    return {
      started,
      state: getAnalysisRuntimeDownloadState()
    }
  })

  ipcMain.handle('analysis-runtime:clear-local', async () => {
    try {
      mainWindow.instance?.webContents.send('progressSet', {
        id: ANALYSIS_RUNTIME_CLEAR_PROGRESS_ID,
        titleKey: 'settings.clearAnalysisRuntime.progress',
        now: 0,
        total: 0,
        isInitial: true,
        noProgress: true
      })
      const cleared = await clearInstalledAnalysisRuntimes()
      const preferred = await getPreferredAnalysisRuntimeDownloadInfo()
      if (store.settingConfig.analysisRuntimeStartupPromptShownVersion) {
        store.settingConfig.analysisRuntimeStartupPromptShownVersion = ''
        await persistSettingConfig(store.settingConfig)
      }
      return {
        success:
          cleared.removedInstalledRoot &&
          cleared.removedDownloadCache &&
          cleared.failedBundledRuntimeDirs.length === 0,
        cleared,
        preferred,
        state: getAnalysisRuntimeDownloadState()
      }
    } finally {
      mainWindow.instance?.webContents.send('progressSet', {
        id: ANALYSIS_RUNTIME_CLEAR_PROGRESS_ID,
        dismiss: true
      })
    }
  })
}
