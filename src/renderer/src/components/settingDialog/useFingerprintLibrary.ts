import { onMounted, ref } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import type { SettingDialogRuntimeStore } from './context'

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || '')

const translateMaybeKey = (message: unknown): string => t(String(message || ''))

export const useFingerprintLibrary = (runtime: SettingDialogRuntimeStore) => {
  const songFingerprintListLength = ref(0)

  const refresh = async () => {
    try {
      songFingerprintListLength.value = (await window.electron.ipcRenderer.invoke(
        'getSongFingerprintListLength'
      )) as number
    } catch (error) {
      console.error('获取指纹库长度失败:', error)
      songFingerprintListLength.value = 0
    }
  }

  const clear = async () => {
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
      content: [t('fingerprints.confirmClear')]
    })
    if (result !== 'confirm') return

    try {
      const response = await window.electron.ipcRenderer.invoke('clearTracksFingerprintLibrary')
      if (response && response.success) {
        await refresh()
        await confirm({
          title: t('common.setting'),
          content: [t('fingerprints.clearCompleted')],
          confirmShow: false
        })
      } else {
        await confirm({
          title: t('common.setting'),
          content: [t('fingerprints.clearFailed'), translateMaybeKey(response?.message || '')],
          confirmShow: false
        })
      }
    } catch (error) {
      await confirm({
        title: t('common.setting'),
        content: [t('fingerprints.clearFailed'), translateMaybeKey(getErrorMessage(error))],
        confirmShow: false
      })
    }
  }

  onMounted(() => {
    void refresh()
  })

  return {
    songFingerprintListLength,
    refreshFingerprintLibraryLength: refresh,
    clearTracksFingerprintLibrary: clear
  }
}
