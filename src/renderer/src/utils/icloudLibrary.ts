import { reactive, ref, shallowRef, watch } from 'vue'
import type {
  IcloudResult,
  IcloudState,
  IcloudCopyItem,
  IcloudProgress,
  IcloudDragPayload
} from '@shared/icloudLibrary'

export const icloudState = shallowRef<IcloudState | null>(null)
export const icloudOpen = ref(false)
export const icloudDirectory = ref('')
export const icloudDirectorySelected = ref(false)
export function selectIcloudDirectory(relative: string) {
  icloudDirectory.value = relative
  icloudDirectorySelected.value = true
}
export const icloudSongDragging = ref(false)
watch(
  () => icloudState.value?.rootToken,
  (next, previous) => {
    if (previous && next !== previous) {
      icloudDirectory.value = ''
      icloudDirectorySelected.value = false
    }
  },
  { flush: 'sync' }
)
export const icloudPendingExport = shallowRef<{
  localPlaylistUuid: string
  paths: string[]
} | null>(null)
export async function icloudInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: IcloudResult<T> = await window.electron.ipcRenderer.invoke(channel, ...args)
  if (!result.ok) throw new Error(result.error)
  return result.value
}
export async function refreshIcloudState() {
  icloudState.value = await icloudInvoke<IcloudState>('icloud:state')
  return icloudState.value
}
export const icloudTransfer = reactive({
  busy: false,
  requestId: '',
  error: '',
  results: [] as IcloudCopyItem[],
  progress: null as IcloudProgress | null
})
let eventsBound = false,
  transferCancelled = false,
  progressOffset = 0,
  progressTotal = 0
function bindTransferEvents() {
  if (eventsBound) return
  eventsBound = true
  window.electron.ipcRenderer.on('icloud:copy-progress', (_event, progress: IcloudProgress) => {
    if (icloudTransfer.busy)
      icloudTransfer.progress = {
        ...progress,
        done: progressOffset + progress.done,
        total: progressTotal
      }
  })
}
export function cancelIcloudTransfer() {
  transferCancelled = true
  if (icloudTransfer.requestId)
    void icloudInvoke('icloud:cancel', icloudTransfer.requestId).catch(() => {})
}
export async function copyIcloudSongs(
  direction: 'to-cloud' | 'to-local',
  localPlaylistUuid: string,
  paths: string[],
  rootToken?: string,
  cloudDirectory = '',
  destinationToken?: string
) {
  if (icloudTransfer.busy) return []
  bindTransferEvents()
  icloudTransfer.busy = true
  icloudTransfer.error = ''
  icloudTransfer.results = []
  icloudTransfer.progress = null
  transferCancelled = false
  const unique = [...new Set(paths)]
  progressOffset = 0
  progressTotal = unique.length
  const results: IcloudCopyItem[] = []
  try {
    for (let start = 0; start < unique.length; start += 500) {
      if (transferCancelled) throw new Error('cancelled')
      const requestId = crypto.randomUUID()
      icloudTransfer.requestId = requestId
      progressOffset = start
      if (direction === 'to-cloud' && start > 0) {
        const chosen = await icloudInvoke<{ token: string; rootToken: string; directory: string }>(
          'icloud:authorize-destination',
          cloudDirectory,
          rootToken
        )
        if (chosen.directory !== cloudDirectory || chosen.rootToken !== rootToken)
          throw new Error('boundary')
        destinationToken = chosen.token
      }
      if (transferCancelled) throw new Error('cancelled')
      const batch = await icloudInvoke<IcloudCopyItem[]>('icloud:copy', {
        direction,
        localPlaylistUuid,
        paths: unique.slice(start, start + 500),
        cloudDirectory,
        destinationToken,
        rootToken,
        requestId
      })
      results.push(...batch)
      icloudTransfer.results = [...results]
      icloudTransfer.progress = {
        done: start + batch.length,
        total: unique.length,
        current: batch.at(-1)?.source || ''
      }
    }
    return results
  } catch (error) {
    icloudTransfer.error = error instanceof Error ? error.message : 'failed'
    return results
  } finally {
    icloudTransfer.busy = false
  }
}
export function openIcloudExport(
  localPlaylistUuid: string,
  paths: string[],
  directory?: string,
  token?: string
) {
  const explicit = directory !== undefined || (icloudOpen.value && icloudDirectorySelected.value)
  const target = directory ?? icloudDirectory.value
  const rootToken = token ?? icloudState.value?.rootToken
  icloudOpen.value = true
  if (!icloudTransfer.busy) {
    icloudTransfer.error = ''
    icloudTransfer.results = []
    icloudTransfer.progress = null
  }
  void (async () => {
    try {
      const chosen = explicit
        ? await icloudInvoke<{ directory: string; token: string; rootToken: string }>(
            'icloud:authorize-destination',
            target,
            rootToken
          )
        : await icloudInvoke<{ directory: string; token: string; rootToken: string } | null>(
            'icloud:choose-destination',
            ''
          )
      if (!chosen) return
      selectIcloudDirectory(chosen.directory)
      await copyIcloudSongs(
        'to-cloud',
        localPlaylistUuid,
        paths,
        chosen.rootToken,
        chosen.directory,
        chosen.token
      )
    } catch (reason) {
      icloudTransfer.error = reason instanceof Error ? reason.message : 'failed'
    }
  })()
}
export function copyIcloudDropToLocal(localPlaylistUuid: string, payload: IcloudDragPayload) {
  return copyIcloudSongs('to-local', localPlaylistUuid, payload.paths, payload.rootToken)
}
