import { onUnmounted, watch, type Ref } from 'vue'
import emitter from '@renderer/utils/mitt'
import type { ISongInfo } from '../../../../../../types/globals'

interface SetListBackgroundRefreshParams {
  getSongListUUID: () => string
  isSetListUUID: (uuid: string) => boolean
  isRequesting: Ref<boolean>
  lastAppliedSongListUUID: Ref<string>
  applyItems: (uuid: string, items: ISongInfo[], isCurrent: () => boolean) => Promise<void>
}

// set 成员变更只核对并合并已打开的列表，不进入首次打开的 loading / 渐进渲染。
export function useSetListBackgroundRefresh(params: SetListBackgroundRefreshParams) {
  let pendingUUID = ''
  let running = false
  let disposed = false
  let revision = 0
  const isReady = (uuid: string) =>
    !disposed &&
    uuid === params.getSongListUUID() &&
    params.isSetListUUID(uuid) &&
    !params.isRequesting.value &&
    params.lastAppliedSongListUUID.value === uuid

  const drain = async () => {
    if (running || !pendingUUID || !isReady(pendingUUID)) return
    running = true
    try {
      // 同一轮到达的通知合并为一次读取；读取期间的新通知只保留最新一轮。
      await Promise.resolve()
      while (pendingUUID && isReady(pendingUUID)) {
        const uuid = pendingUUID
        const requestRevision = revision
        pendingUUID = ''
        const isCurrent = () => revision === requestRevision && isReady(uuid)
        try {
          const result: { songListUUID?: string; scanData?: ISongInfo[] } =
            await window.electron.ipcRenderer.invoke('setList:load-items', uuid)
          if (!isCurrent() || result.songListUUID !== uuid) continue
          await params.applyItems(
            uuid,
            Array.isArray(result.scanData) ? result.scanData : [],
            isCurrent
          )
        } catch (error) {
          console.error('[setList] background refresh failed', error)
        }
      }
    } finally {
      running = false
    }
  }

  const onItemsChanged = (payload?: { uuids?: string[] } | null) => {
    const uuid = params.getSongListUUID()
    if (!uuid || !params.isSetListUUID(uuid) || !payload?.uuids?.includes(uuid)) return
    revision += 1
    pendingUUID = uuid
    void drain()
  }
  emitter.on('setList/itemsChanged', onItemsChanged)

  watch(
    params.getSongListUUID,
    () => {
      revision += 1
      pendingUUID = ''
    },
    { flush: 'sync' }
  )
  watch(
    [params.isRequesting, params.lastAppliedSongListUUID],
    () => {
      if (params.isRequesting.value) {
        revision += 1
        if (running) pendingUUID = params.getSongListUUID()
      }
      void drain()
    },
    { flush: 'sync' }
  )

  onUnmounted(() => {
    disposed = true
    revision += 1
    pendingUUID = ''
    emitter.off('setList/itemsChanged', onItemsChanged)
  })
}
