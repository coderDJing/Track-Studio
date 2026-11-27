import { ref } from 'vue'
import { mapAcoustIdClientError } from '@renderer/utils/acoustid'
import type { SettingDialogRuntimeStore, SettingPersist } from './context'

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || '')

export const useAcoustIdKey = (runtime: SettingDialogRuntimeStore, persist: SettingPersist) => {
  const lastValidClientKey = ref(String(runtime.setting.acoustIdClientKey || '').trim())
  runtime.setting.acoustIdClientKey = lastValidClientKey.value
  const validating = ref(false)
  const errorText = ref('')

  const openApplicationPage = () => {
    window.electron.ipcRenderer.send('openLocalBrowser', 'https://acoustid.org/new-application')
  }

  const handleBlur = async () => {
    const rawValue = runtime.setting.acoustIdClientKey || ''
    const trimmed = rawValue.trim()
    if (rawValue !== trimmed) {
      runtime.setting.acoustIdClientKey = trimmed
    }

    if (trimmed === lastValidClientKey.value) {
      errorText.value = ''
      if (rawValue !== trimmed) {
        await persist('acoustIdClientKey')
      }
      return
    }

    if (!trimmed) {
      lastValidClientKey.value = ''
      errorText.value = ''
      runtime.setting.acoustIdClientKey = ''
      await persist('acoustIdClientKey')
      return
    }

    validating.value = true
    try {
      await window.electron.ipcRenderer.invoke('acoustid:validateClientKey', trimmed)
      lastValidClientKey.value = trimmed
      errorText.value = ''
      runtime.setting.acoustIdClientKey = trimmed
      await persist('acoustIdClientKey')
    } catch (error) {
      errorText.value = mapAcoustIdClientError(getErrorMessage(error))
      runtime.setting.acoustIdClientKey = lastValidClientKey.value
    } finally {
      validating.value = false
    }
  }

  return {
    lastValidAcoustIdClientKey: lastValidClientKey,
    acoustIdKeyValidating: validating,
    acoustIdKeyErrorText: errorText,
    openAcoustIdSite: openApplicationPage,
    handleAcoustIdKeyBlur: handleBlur
  }
}
