import { BrowserWindow, ipcMain } from 'electron'
import store from '../store'
import { applyThemeFromSettings, broadcastSystemThemeIfNeeded } from '../bootstrap/settings'
import {
  clearWindowsContextMenuSignature,
  ensureWindowsContextMenuIfNeeded,
  removeWindowsContextMenu
} from '../platform/windowsContextMenu'
import { rebuildMacMenusForCurrentFocus } from '../menu/macMenu'
import { saveLibrarySettingsFromConfig } from '../librarySettingsDb'
import { persistSettingConfig } from '../settingsPersistence'
import { syncWindowScreenshotShortcut } from '../window/mainWindow'
import mainWindow from '../window/mainWindow'
import { CURATED_ARTIST_IMPORT_PROGRESS_ID } from '../../shared/curatedArtistProgress'
import {
  clearCuratedArtistLibrary,
  getCuratedArtistLibrarySnapshot,
  importCuratedArtistsFromTracks,
  replaceCuratedArtistLibrary,
  removeCuratedArtist
} from '../curatedArtistLibrary'
import { assertLibraryMergeMutationAllowed } from '../services/libraryMerge/runtime'
import { normalizeAnalysisBpmRangeId } from '../../shared/analysisBpmRange'
import { normalizeTrackReanalysisSelection } from '../../shared/trackReanalysisSelection'
import {
  normalizeCloudSyncAutoEnabled,
  normalizeCloudSyncAutoIntervalMs
} from '../../shared/cloudSyncAuto'
import { restartCloudSyncScheduler, runCuratedLibrarySyncTick } from '../cloudSyncScheduler'
import { syncCuratedLibraryLiveSync } from '../curatedLibrarySync/liveSync'

type Dependencies = {
  loadFingerprintList: (mode: 'pcm' | 'file') => Promise<string[]>
}

export function registerSettingsHandlers(deps: Dependencies) {
  ipcMain.handle('getSetting', () => {
    return store.settingConfig
  })

  // 串行化队列，防止快速连续调用导致 prevMode/prevContextMenu 比较不准确
  let setSettingQueue: Promise<void> = Promise.resolve()

  ipcMain.handle('setSetting', async (_event, setting) => {
    assertLibraryMergeMutationAllowed()
    const task = setSettingQueue
      .catch(() => undefined)
      .then(async () => {
        assertLibraryMergeMutationAllowed()
        const prevAutoEnabled = normalizeCloudSyncAutoEnabled(
          store.settingConfig?.cloudSyncAutoEnabled
        )
        const prevAutoIntervalMs = normalizeCloudSyncAutoIntervalMs(
          store.settingConfig?.cloudSyncAutoIntervalMs
        )
        const prevContextMenu = !!store.settingConfig?.enableExplorerContextMenu
        const prevMode = store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
        const prevCuratedLibrarySyncEnabled =
          store.settingConfig?.curatedLibrarySyncEnabled === true
        const normalizedSetting = {
          ...setting,
          // userKey 只能由 cloudSync/config/save 校验后修改，不能被 renderer 的旧设置覆盖。
          cloudSyncUserKey: store.settingConfig.cloudSyncUserKey,
          analysisBpmRange: normalizeAnalysisBpmRangeId(setting?.analysisBpmRange),
          trackAnalysisSelection: normalizeTrackReanalysisSelection(
            setting?.trackAnalysisSelection
          ),
          trackReanalysisSelection: normalizeTrackReanalysisSelection(
            setting?.trackReanalysisSelection
          ),
          cloudSyncAutoEnabled: normalizeCloudSyncAutoEnabled(setting?.cloudSyncAutoEnabled),
          cloudSyncAutoIntervalMs: normalizeCloudSyncAutoIntervalMs(
            setting?.cloudSyncAutoIntervalMs
          ),
          curatedLibrarySyncEnabled: setting?.curatedLibrarySyncEnabled === true
        }
        store.settingConfig = normalizedSetting
        await persistSettingConfig(normalizedSetting)
        await saveLibrarySettingsFromConfig()

        try {
          applyThemeFromSettings()
          broadcastSystemThemeIfNeeded()
          // 向所有窗口广播设置变更，确保主题同步
          const allWindows = BrowserWindow.getAllWindows()
          for (const win of allWindows) {
            try {
              win.webContents.send('setting-changed', normalizedSetting)
            } catch {}
          }
        } catch {}

        try {
          const nextMode = store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
          if (nextMode !== prevMode) {
            const list = await deps.loadFingerprintList(nextMode)
            store.songFingerprintList = Array.isArray(list) ? list : []
          }
        } catch {}

        syncWindowScreenshotShortcut()

        if (process.platform === 'darwin') {
          rebuildMacMenusForCurrentFocus()
        }

        if (process.platform === 'win32') {
          const nextContextMenu = !!store.settingConfig?.enableExplorerContextMenu
          if (nextContextMenu) {
            await ensureWindowsContextMenuIfNeeded()
          } else if (prevContextMenu) {
            await removeWindowsContextMenu()
            await clearWindowsContextMenuSignature()
          }
        }

        const nextAutoEnabled = normalizeCloudSyncAutoEnabled(
          store.settingConfig?.cloudSyncAutoEnabled
        )
        const nextAutoIntervalMs = normalizeCloudSyncAutoIntervalMs(
          store.settingConfig?.cloudSyncAutoIntervalMs
        )
        if (nextAutoEnabled !== prevAutoEnabled || nextAutoIntervalMs !== prevAutoIntervalMs) {
          restartCloudSyncScheduler({
            immediate: nextAutoEnabled && !prevAutoEnabled
          })
        }

        if (normalizedSetting.curatedLibrarySyncEnabled !== prevCuratedLibrarySyncEnabled) {
          syncCuratedLibraryLiveSync()
          restartCloudSyncScheduler({ immediate: false })
          if (normalizedSetting.curatedLibrarySyncEnabled) {
            void runCuratedLibrarySyncTick()
          }
        }
      })
    setSettingQueue = task.catch(() => undefined)
    await task
  })

  ipcMain.handle('curatedArtists:get', () => {
    return getCuratedArtistLibrarySnapshot()
  })

  ipcMain.handle('curatedArtists:remove', (_event, artistName) => {
    assertLibraryMergeMutationAllowed()
    return removeCuratedArtist(artistName)
  })

  ipcMain.handle('curatedArtists:clear', () => {
    assertLibraryMergeMutationAllowed()
    return clearCuratedArtistLibrary()
  })

  ipcMain.handle('curatedArtists:setAll', (_event, artists) => {
    assertLibraryMergeMutationAllowed()
    return replaceCuratedArtistLibrary(artists)
  })

  ipcMain.handle(
    'curatedArtists:importFromTracks',
    async (_event, payload: { tracks?: Array<{ artistName?: unknown; filePath?: unknown }> }) => {
      assertLibraryMergeMutationAllowed()
      const progressId = CURATED_ARTIST_IMPORT_PROGRESS_ID
      try {
        return await importCuratedArtistsFromTracks(payload, {
          onProgress: (progress) => {
            mainWindow.instance?.webContents.send('progressSet', {
              id: progressId,
              titleKey:
                progress.stage === 'fingerprint'
                  ? 'settings.curatedArtistTracking.importProgressFingerprint'
                  : 'settings.curatedArtistTracking.importProgressScan',
              now: progress.processed,
              total: progress.total,
              isInitial: progress.processed === 0,
              noProgress: progress.total <= 0
            })
          }
        })
      } finally {
        mainWindow.instance?.webContents.send('progressSet', {
          id: progressId,
          dismiss: true
        })
      }
    }
  )
}
