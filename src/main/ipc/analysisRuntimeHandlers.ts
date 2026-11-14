import { normalizeAnalysisRuntimeFeature } from '../../shared/analysisRuntimeFeatures'
import { ipcMain } from 'electron'
import {
  clearInstalledAnalysisRuntimes,
  downloadPreferredAnalysisRuntime,
  getAnalysisRuntimeDownloadState,
  getPreferredAnalysisRuntimeDownloadInfo
} from '../services/analysisRuntimeDownload'
import mainWindow from '../window/mainWindow'

const ANALYSIS_RUNTIME_CLEAR_PROGRESS_ID = 'analysis-runtime.clear-local'

export function registerAnalysisRuntimeHandlers() {
  ipcMain.handle('analysis-runtime:get-status', async (_event, feature: unknown) => {
    return {
      preferred: await getPreferredAnalysisRuntimeDownloadInfo(
        normalizeAnalysisRuntimeFeature(feature)
      ),
      state: getAnalysisRuntimeDownloadState()
    }
  })

  ipcMain.handle('analysis-runtime:download-preferred', async (_event, feature: unknown) => {
    const started = await downloadPreferredAnalysisRuntime(normalizeAnalysisRuntimeFeature(feature))
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
