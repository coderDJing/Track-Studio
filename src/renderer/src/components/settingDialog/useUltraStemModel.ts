import { computed, onMounted, onUnmounted, ref } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { formatAnalysisRuntimeBytes } from '@renderer/utils/analysisRuntimeDownloadUi'

type DemucsUltraModelManagerState = {
  status: 'idle' | 'available' | 'downloading' | 'extracting' | 'ready' | 'failed'
  archiveSize: number
}

export type DemucsUltraModelManagerInfo = {
  archiveSize: number
  installedSize: number
  alreadyAvailable: boolean
  error: string
  state: DemucsUltraModelManagerState
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || '')

const parseUltraModelInfo = (value: unknown): DemucsUltraModelManagerInfo | null => {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const stateRaw = source.state
  if (!stateRaw || typeof stateRaw !== 'object') return null
  const stateSource = stateRaw as Record<string, unknown>
  const status = stateSource.status
  if (
    status !== 'idle' &&
    status !== 'available' &&
    status !== 'downloading' &&
    status !== 'extracting' &&
    status !== 'ready' &&
    status !== 'failed'
  ) {
    return null
  }
  return {
    archiveSize: Math.max(0, Number(source.archiveSize) || 0),
    installedSize: Math.max(0, Number(source.installedSize) || 0),
    alreadyAvailable: source.alreadyAvailable === true,
    error: typeof source.error === 'string' ? source.error.trim() : '',
    state: {
      status,
      archiveSize: Math.max(0, Number(stateSource.archiveSize) || 0)
    }
  }
}

export const useUltraStemModel = () => {
  const info = ref<DemucsUltraModelManagerInfo | null>(null)

  const statusText = computed(() => {
    if (!info.value) return t('settings.ultraStemModel.statusChecking')
    if (info.value.alreadyAvailable) {
      return t('settings.ultraStemModel.statusInstalled', {
        size: formatAnalysisRuntimeBytes(info.value.installedSize)
      })
    }
    if (info.value.error) return t('settings.ultraStemModel.statusUnavailable')
    return t('settings.ultraStemModel.statusNotInstalled')
  })

  const refresh = async () => {
    try {
      const response = await window.electron.ipcRenderer.invoke('demucs-model:get-ultra-status')
      info.value = parseUltraModelInfo(response)
    } catch {
      info.value = null
    }
  }

  const handleDownloadState = (_event: unknown, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const source = payload as Record<string, unknown>
    const status = source.status
    if (
      status !== 'idle' &&
      status !== 'available' &&
      status !== 'downloading' &&
      status !== 'extracting' &&
      status !== 'ready' &&
      status !== 'failed'
    ) {
      return
    }
    const archiveSize = Math.max(0, Number(source.archiveSize) || 0)
    info.value = {
      archiveSize: archiveSize || info.value?.archiveSize || 0,
      installedSize: status === 'ready' ? archiveSize : info.value?.installedSize || 0,
      alreadyAvailable: status === 'ready',
      error: typeof source.error === 'string' ? source.error.trim() : '',
      state: { status, archiveSize }
    }
    if (status === 'ready') void refresh()
  }

  const remove = async () => {
    if (!info.value?.alreadyAvailable) return
    const confirmed = await confirm({
      title: t('common.warning'),
      content: [
        t('settings.ultraStemModel.removeConfirmLine1', {
          size: formatAnalysisRuntimeBytes(info.value.installedSize)
        }),
        t('settings.ultraStemModel.removeConfirmLine2')
      ],
      textAlign: 'left',
      innerWidth: 560,
      innerHeight: 0
    })
    if (confirmed !== 'confirm') return

    try {
      const result = await window.electron.ipcRenderer.invoke('demucs-model:remove-ultra')
      if (result?.busy === true) {
        await confirm({
          title: t('common.setting'),
          content: [t('settings.ultraStemModel.removeBusy')],
          confirmShow: false
        })
        return
      }
      if (result?.removedModel !== true) {
        await confirm({
          title: t('common.error'),
          content: [t('settings.ultraStemModel.removeFailed')],
          confirmShow: false
        })
        return
      }
      await refresh()
    } catch (error) {
      await confirm({
        title: t('common.error'),
        content: [t('settings.ultraStemModel.removeFailed'), getErrorMessage(error)],
        confirmShow: false
      })
    }
  }

  onMounted(() => {
    void refresh()
    window.electron.ipcRenderer.on('demucs-model-download-state', handleDownloadState)
  })

  onUnmounted(() => {
    window.electron.ipcRenderer.removeListener('demucs-model-download-state', handleDownloadState)
  })

  return {
    ultraModelInfo: info,
    ultraModelStatusText: statusText,
    refreshUltraModelInfo: refresh,
    removeUltraModel: remove
  }
}
