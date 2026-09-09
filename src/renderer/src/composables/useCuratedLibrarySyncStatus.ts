import { onBeforeUnmount, onMounted, readonly, ref } from 'vue'
import type { CuratedLibrarySyncStatus } from '../../../shared/curatedLibrarySync'

const emptyStatus = (): CuratedLibrarySyncStatus => ({
  running: false,
  phase: 'idle',
  now: 0,
  total: 0,
  trigger: null,
  terminalStatus: 'idle',
  updatedAtMs: 0
})

const status = ref<CuratedLibrarySyncStatus>(emptyStatus())
let subscriberCount = 0

const handleStatus = (_event: unknown, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return
  const next = payload as CuratedLibrarySyncStatus
  if (typeof next.running !== 'boolean' || typeof next.phase !== 'string') return
  status.value = next
}

const refreshStatus = async (): Promise<void> => {
  try {
    status.value = (await window.electron.ipcRenderer.invoke(
      'curatedLibrarySync/getStatus'
    )) as CuratedLibrarySyncStatus
  } catch {}
}

const subscribe = () => {
  subscriberCount += 1
  if (subscriberCount !== 1) return
  window.electron.ipcRenderer.on('curatedLibrarySync/status', handleStatus)
  void refreshStatus()
}

const unsubscribe = () => {
  subscriberCount -= 1
  if (subscriberCount > 0) return
  subscriberCount = 0
  window.electron.ipcRenderer.removeListener('curatedLibrarySync/status', handleStatus)
}

/** 全局唯一的精选库同步会话状态；任一入口打开时都显示同一条任务进度。 */
export const useCuratedLibrarySyncStatus = () => {
  onMounted(subscribe)
  onBeforeUnmount(unsubscribe)
  return {
    status: readonly(status),
    refreshStatus
  }
}
