import { computed, onMounted, onUnmounted, watch, type Ref } from 'vue'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '../../utils/mitt'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { IDir } from '../../../../types/globals'
import { libraryTreeTrackCountMap, setLibraryTreeTrackCount } from '@renderer/utils/libraryTreeSort'

interface UseLibraryTrackCountOptions {
  runtime: ReturnType<typeof useRuntimeStore>
  dirDataRef: Ref<IDir | null>
  props: { uuid: string }
}

type PlaylistContentChangedPayload = {
  uuids?: string[]
}

export function useLibraryTrackCount({ runtime, dirDataRef, props }: UseLibraryTrackCountOptions) {
  const getDirData = () => dirDataRef.value

  let fetchingCount = false

  /**
   * 数量统一读写共享缓存（含上次会话持久化的值），好处有两个：
   * 徽标首帧就有数字，且排序与徽标始终看到同一份数据，不会各自异步刷新导致重复重排。
   * 未命名的临时歌单没有真实目录，直接视为无数量。
   */
  const trackCount = computed<number | null>({
    get: () => {
      if (!dirDataRef.value?.dirName) return null
      const shared = libraryTreeTrackCountMap[props.uuid]
      return typeof shared === 'number' ? shared : null
    },
    set: (value) => {
      if (typeof value === 'number') setLibraryTreeTrackCount(props.uuid, value)
    }
  })

  const ensureTrackCount = async (options?: { force?: boolean }) => {
    const dirData = getDirData()
    if (!runtime.setting.showPlaylistTrackCount) return
    if (fetchingCount) return
    if (!dirData || (dirData.type !== 'songList' && dirData.type !== 'setList')) return
    // 未命名的临时歌单/集合没有真实目录，避免把父目录当作目标而统计成总数
    if (!dirData.dirName) return
    // 新歌单已在树上命名、但目录尚未落盘时，禁止扫描。此时路径解析可能落到父目录，
    // 会把同级歌单的曲目总数误写进新歌单徽标。
    if (runtime.creatingSongListUUID === props.uuid) return
    // 缓存已有值时不再逐项发 IPC；内容变更走 force 主动刷新
    if (!options?.force && typeof libraryTreeTrackCountMap[props.uuid] === 'number') return
    try {
      fetchingCount = true
      if (dirData.type === 'setList') {
        const count = await window.electron.ipcRenderer.invoke('setList:count', props.uuid)
        trackCount.value = typeof count === 'number' ? count : 0
        return
      }
      const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
      const count = await window.electron.ipcRenderer.invoke('getSongListTrackCount', songListPath)
      trackCount.value = typeof count === 'number' ? count : 0
    } catch {
      trackCount.value = 0
    } finally {
      fetchingCount = false
    }
  }

  onMounted(() => {
    ensureTrackCount()
  })

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const pendingSet = new Set<string>()
  const handlePlaylistContentChanged = (payload: unknown) => {
    try {
      const resolvedPayload =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as PlaylistContentChangedPayload)
          : {}
      const uuids = Array.isArray(resolvedPayload.uuids)
        ? resolvedPayload.uuids.filter((item): item is string => typeof item === 'string' && !!item)
        : []
      for (const u of uuids) pendingSet.add(u)
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }
      debounceTimer = setTimeout(() => {
        if (pendingSet.has(props.uuid)) {
          // 当前列表可能来自旧快照，也可能尚未完整解析，不能据此覆盖磁盘计数。
          // 打开和内容变更都复用精确计数入口，仍由当前去抖窗口合并请求。
          void ensureTrackCount({ force: true })
        }
        pendingSet.clear()
      }, 200)
    } catch {}
  }
  emitter.on('playlistContentChanged', handlePlaylistContentChanged)

  onUnmounted(() => {
    emitter.off('playlistContentChanged', handlePlaylistContentChanged)
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    pendingSet.clear()
  })

  watch(
    () => [
      runtime.setting.showPlaylistTrackCount,
      dirDataRef.value?.type,
      dirDataRef.value?.dirName
    ],
    () => {
      if (runtime.setting.showPlaylistTrackCount) ensureTrackCount()
    }
  )

  return {
    trackCount,
    ensureTrackCount
  }
}
