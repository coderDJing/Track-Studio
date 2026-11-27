import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import type { SettingDialogRuntimeStore } from './context'

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || '')

export const useMaintenanceActions = (runtime: SettingDialogRuntimeStore) => {
  const clearLibraryDirtyData = async () => {
    if (runtime.isProgressing) {
      await confirm({
        title: t('common.setting'),
        content: [t('import.waitForTask')],
        confirmShow: false
      })
      return
    }

    const result = await confirm({
      title: t('common.warning'),
      content: [
        t('settings.clearDirtyData.confirmLine1'),
        t('settings.clearDirtyData.confirmLine2')
      ]
    })
    if (result !== 'confirm') return

    try {
      const response = await window.electron.ipcRenderer.invoke('library:clear-dirty-data')
      const sqliteRows = Number(response?.database?.removedRows || 0)
      const libraryItems = Number(response?.libraryCache?.removedCount || 0)
      const userDataItems = Number(response?.userDataCache?.removedCount || 0)
      await confirm({
        title: t('common.success'),
        content: [
          t('settings.clearDirtyData.successLine1'),
          t('settings.clearDirtyData.successLine2', {
            sqliteRows,
            libraryItems,
            userDataItems
          })
        ],
        confirmShow: false
      })
    } catch (error) {
      await confirm({
        title: t('common.error'),
        content: [t('settings.clearDirtyData.failed'), getErrorMessage(error)],
        confirmShow: false
      })
    }
  }

  const clearAnalysisRuntime = async () => {
    if (runtime.isProgressing) {
      await confirm({
        title: t('common.setting'),
        content: [t('import.waitForTask')],
        confirmShow: false
      })
      return
    }

    const result = await confirm({
      title: t('common.warning'),
      content: [
        t('settings.clearAnalysisRuntime.confirmLine1'),
        t('settings.clearAnalysisRuntime.confirmLine2')
      ],
      textAlign: 'left',
      innerWidth: 620,
      innerHeight: 0
    })
    if (result !== 'confirm') return

    try {
      runtime.isProgressing = true
      const response = await window.electron.ipcRenderer.invoke('analysis-runtime:clear-local')
      const preferredRaw =
        response?.preferred && typeof response.preferred === 'object'
          ? (response.preferred as Record<string, unknown>)
          : {}
      const stateRaw =
        response?.state && typeof response.state === 'object'
          ? (response.state as Record<string, unknown>)
          : {}
      const clearedRaw =
        response?.cleared && typeof response.cleared === 'object'
          ? (response.cleared as Record<string, unknown>)
          : {}
      const removedInstalledRoot = clearedRaw.removedInstalledRoot === true
      const removedDownloadCache = clearedRaw.removedDownloadCache === true
      const removedBundledRuntimeDirs = Array.isArray(clearedRaw.removedBundledRuntimeDirs)
        ? clearedRaw.removedBundledRuntimeDirs.filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0
          )
        : []
      const failedBundledRuntimeDirs = Array.isArray(clearedRaw.failedBundledRuntimeDirs)
        ? clearedRaw.failedBundledRuntimeDirs.filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0
          )
        : []
      const nextPreferred = {
        supported: preferredRaw.supported === true,
        downloadable: preferredRaw.downloadable === true,
        alreadyAvailable: preferredRaw.alreadyAvailable === true,
        profile: typeof preferredRaw.profile === 'string' ? preferredRaw.profile.trim() : '',
        runtimeKey:
          typeof preferredRaw.runtimeKey === 'string' ? preferredRaw.runtimeKey.trim() : '',
        version: typeof preferredRaw.version === 'string' ? preferredRaw.version.trim() : '',
        archiveSize: Math.max(0, Number(preferredRaw.archiveSize) || 0),
        title: typeof preferredRaw.title === 'string' ? preferredRaw.title.trim() : '',
        reason: typeof preferredRaw.reason === 'string' ? preferredRaw.reason.trim() : '',
        manifestUrl:
          typeof preferredRaw.manifestUrl === 'string' ? preferredRaw.manifestUrl.trim() : '',
        releaseTag:
          typeof preferredRaw.releaseTag === 'string' ? preferredRaw.releaseTag.trim() : '',
        error: typeof preferredRaw.error === 'string' ? preferredRaw.error.trim() : ''
      }
      const nextStateStatus: typeof runtime.analysisRuntime.state.status =
        stateRaw.status === 'available' ||
        stateRaw.status === 'downloading' ||
        stateRaw.status === 'extracting' ||
        stateRaw.status === 'ready' ||
        stateRaw.status === 'failed'
          ? stateRaw.status
          : 'idle'
      const nextState = {
        status: nextStateStatus,
        profile: typeof stateRaw.profile === 'string' ? stateRaw.profile.trim() : '',
        runtimeKey: typeof stateRaw.runtimeKey === 'string' ? stateRaw.runtimeKey.trim() : '',
        version: typeof stateRaw.version === 'string' ? stateRaw.version.trim() : '',
        percent: Math.max(0, Math.min(100, Math.round(Number(stateRaw.percent) || 0))),
        downloadedBytes: Math.max(0, Number(stateRaw.downloadedBytes) || 0),
        totalBytes: Math.max(0, Number(stateRaw.totalBytes) || 0),
        archiveSize: Math.max(0, Number(stateRaw.archiveSize) || 0),
        title: typeof stateRaw.title === 'string' ? stateRaw.title.trim() : '',
        message: typeof stateRaw.message === 'string' ? stateRaw.message.trim() : '',
        error: typeof stateRaw.error === 'string' ? stateRaw.error.trim() : '',
        updatedAt: Math.max(0, Math.floor(Number(stateRaw.updatedAt) || 0))
      }
      runtime.analysisRuntime.preferred = nextPreferred
      runtime.analysisRuntime.state = nextState
      runtime.analysisRuntime.available =
        nextPreferred.alreadyAvailable || nextState.status === 'ready'

      if (response?.success !== true) {
        await confirm({
          title: t('common.warning'),
          content: [
            t('settings.clearAnalysisRuntime.partialFailed'),
            !removedInstalledRoot
              ? t('settings.clearAnalysisRuntime.partialFailedInstalledRoot')
              : '',
            !removedDownloadCache
              ? t('settings.clearAnalysisRuntime.partialFailedDownloadCache')
              : '',
            failedBundledRuntimeDirs.length > 0
              ? t('settings.clearAnalysisRuntime.partialFailedBundledRuntimes', {
                  count: failedBundledRuntimeDirs.length
                })
              : '',
            t('settings.clearAnalysisRuntime.partialFailedHint')
          ].filter(Boolean),
          confirmShow: false,
          textAlign: 'left',
          innerWidth: 620,
          innerHeight: 0
        })
        return
      }

      await confirm({
        title: t('common.success'),
        content: [
          t('settings.clearAnalysisRuntime.successLine1'),
          t('settings.clearAnalysisRuntime.successLine2', {
            count: removedBundledRuntimeDirs.length
          }),
          runtime.analysisRuntime.available
            ? t('settings.clearAnalysisRuntime.successLine3BundledAvailable')
            : t('settings.clearAnalysisRuntime.successLine3NeedsDownload')
        ],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 620,
        innerHeight: 0
      })
    } catch (error) {
      await confirm({
        title: t('common.error'),
        content: [t('settings.clearAnalysisRuntime.failed'), getErrorMessage(error)],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 620,
        innerHeight: 0
      })
    } finally {
      runtime.isProgressing = false
    }
  }

  return {
    clearLibraryDirtyData,
    clearAnalysisRuntime
  }
}
