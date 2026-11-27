import { computed } from 'vue'
import { t } from '@renderer/utils/translate'
import type { SettingDialogRuntimeStore, SettingPersist } from './context'

export const useDjStorageDirs = (runtime: SettingDialogRuntimeStore, persist: SettingPersist) => {
  const rekordboxText = computed(
    () =>
      runtime.setting.rekordboxDesktopTrackStorageDir ||
      t('settings.rekordboxDesktopTrackStorageDir.notConfigured')
  )
  const seratoText = computed(
    () => runtime.setting.seratoTrackStorageDir || t('settings.seratoTrackStorageDir.notConfigured')
  )
  const traktorText = computed(
    () =>
      runtime.setting.traktorTrackStorageDir || t('settings.traktorTrackStorageDir.notConfigured')
  )

  const chooseFolder = async () => {
    const folderPath = (await window.electron.ipcRenderer.invoke('select-folder', false)) as
      string[] | null
    if (!Array.isArray(folderPath) || !folderPath[0]) return ''
    return String(folderPath[0] || '').trim()
  }

  const chooseRekordbox = async () => {
    const path = await chooseFolder()
    if (!path) return
    runtime.setting.rekordboxDesktopTrackStorageDir = path
    await persist('rekordboxDesktopTrackStorageDir')
  }

  const chooseSerato = async () => {
    const path = await chooseFolder()
    if (!path) return
    runtime.setting.seratoTrackStorageDir = path
    await persist('seratoTrackStorageDir')
  }

  const chooseTraktor = async () => {
    const path = await chooseFolder()
    if (!path) return
    runtime.setting.traktorTrackStorageDir = path
    await persist('traktorTrackStorageDir')
  }

  return {
    rekordboxDesktopTrackStorageDirText: rekordboxText,
    seratoTrackStorageDirText: seratoText,
    traktorTrackStorageDirText: traktorText,
    chooseRekordboxDesktopTrackStorageDir: chooseRekordbox,
    chooseSeratoTrackStorageDir: chooseSerato,
    chooseTraktorTrackStorageDir: chooseTraktor
  }
}
