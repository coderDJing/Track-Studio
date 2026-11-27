import { icloudOpen } from './icloudLibrary'
import { useRuntimeStore } from '@renderer/stores/runtime'

export async function setIcloudLibraryIconVisible(visible: boolean) {
  const runtime = useRuntimeStore()
  const updated = JSON.parse(JSON.stringify({ ...runtime.setting, showIcloudLibraryIcon: visible }))
  const result = await window.electron.ipcRenderer.invoke('setSetting', updated)
  if (result?.blocked) throw new Error('failed')
  runtime.setting.showIcloudLibraryIcon = visible
  if (!visible) icloudOpen.value = false
}
export async function hideIcloudLibraryIcon() {
  await setIcloudLibraryIconVisible(false)
}
