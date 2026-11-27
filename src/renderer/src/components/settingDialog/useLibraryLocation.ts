import { computed } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import type { SettingDialogRuntimeStore, SettingPersist } from './context'

export const useLibraryLocation = (
  runtime: SettingDialogRuntimeStore,
  persist: SettingPersist,
  closeImmediately: () => void
) => {
  const currentLibraryPathText = computed(
    () => runtime.setting.databaseUrl || t('database.notConfigured')
  )

  const openInExplorer = () => {
    window.electron.ipcRenderer.send('open-current-library-root-in-explorer')
  }

  const reselect = async () => {
    if (runtime.isProgressing) {
      await confirm({
        title: t('common.setting'),
        content: [t('import.waitForTask')],
        confirmShow: false
      })
      return
    }

    const result = await confirm({
      title: t('dialog.hint'),
      content: [t('database.locationRetain'), t('database.reselectConfirm')],
      confirmShow: true
    })
    if (result !== 'confirm') return

    void persist()
    closeImmediately()
    await window.electron.ipcRenderer.invoke('reSelectLibrary')
  }

  return {
    currentLibraryPathText,
    openCurrentLibraryInExplorer: openInExplorer,
    reSelectLibrary: reselect
  }
}
