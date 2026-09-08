import { markRaw, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import emitter from '@renderer/utils/mitt'
import { getRekordboxCoverThumbChannel } from '@renderer/utils/rekordboxExternalSource'
import {
  createCoverDisplayWorkerClient,
  type CoverDisplayWorkerResult
} from './coverDisplayWorkerClient'
import { resolveCoverPathIdentity } from './coverPathIdentity'

interface UseCoverThumbnailsOptions {
  songs: Ref<ISongInfo[] | undefined>
  visibleSongsWithIndex: Ref<Array<{ song: ISongInfo; idx: number }>>
  startIndex: Ref<number>
  endIndex: Ref<number>
  actualStartIndex: Ref<number>
  actualEndIndex: Ref<number>
  visibleCount: Ref<number>
  songListRootDir?: Ref<string | undefined>
  sessionIdentity?: Ref<string | undefined>
  platform?: Ref<string | undefined>
  enabled?: Ref<boolean>
}

type PioneerCoverResponse = {
  format?: string
  data?: Uint8Array | { data: number[] } | number[]
  dataUrl?: string
}

type CoverThumbResponse = PioneerCoverResponse & {
  needsDisplayCache?: boolean
  imageHash?: string
  legacyExt?: string
}

type QueuePriority = 'visible' | 'prefetch'

type QueueTask = {
  filePath: string
  generation: number
  priority: QueuePriority
  run: () => void
  resolve: (value: string | null) => void
}

type InflightCover = {
  generation: number
  promise: Promise<string | null>
  task?: QueueTask
}

type RunningCoverCounts = {
  visible: number
  prefetch: number
}

export function useCoverThumbnails({
  songs,
  visibleSongsWithIndex,
  startIndex,
  endIndex,
  actualStartIndex,
  actualEndIndex,
  visibleCount,
  songListRootDir,
  sessionIdentity,
  platform,
  enabled
}: UseCoverThumbnailsOptions) {
  const coverUrlCache = markRaw(new Map<string, string | null>())
  const inflight = markRaw(new Map<string, InflightCover>())
  const pendingVisibleQueue: QueueTask[] = []
  const pendingPrefetchQueue: QueueTask[] = []
  const runningByGeneration = new Map<number, RunningCoverCounts>()
  let displayWorker = createCoverDisplayWorkerClient()
  const displayConversionCache = new Map<string, CoverDisplayWorkerResult>()
  const displayConversionInflight = new Map<string, Promise<CoverDisplayWorkerResult>>()
  const coversTick = ref(0)
  const clientKey = `song-list-covers-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  let generation = 0
  let disposed = false
  const MAX_CONCURRENCY = 6
  const MAX_PREFETCH_CONCURRENCY = 2

  const resolveCoverCacheKey = (value: string | undefined | null) => {
    return resolveCoverPathIdentity(value, platform?.value)
  }

  const revokeCoverUrl = (url: string | null | undefined) => {
    if (url && url.startsWith('blob:')) URL.revokeObjectURL(url)
  }

  const resolveSongs = () => songs.value ?? []
  const resolveRootDir = () => (songListRootDir ? songListRootDir.value : undefined)
  const isEnabled = () => (enabled ? enabled.value !== false : true)
  const resolveSessionIdentity = () =>
    String(sessionIdentity?.value || `${resolveRootDir() || ''}:${resolveSongs().length}`)
  const resolveSongByFilePath = (filePath: string) => {
    const cacheKey = resolveCoverCacheKey(filePath)
    return resolveSongs().find((song) => resolveCoverCacheKey(song?.filePath) === cacheKey) || null
  }
  const isCurrentGeneration = (taskGeneration: number) => !disposed && taskGeneration === generation

  const cacheCoverUrl = (filePath: string, url: string | null, taskGeneration: number) => {
    if (!isCurrentGeneration(taskGeneration)) {
      revokeCoverUrl(url)
      return false
    }
    coverUrlCache.set(resolveCoverCacheKey(filePath), url)
    coversTick.value++
    return true
  }

  const toUint8Array = (data: PioneerCoverResponse['data']): Uint8Array | null => {
    if (!data) return null
    if (data instanceof Uint8Array) return data
    if (Array.isArray(data)) return new Uint8Array(data)
    return new Uint8Array(data.data || [])
  }

  const persistDisplayCache = (
    filePath: string,
    response: CoverThumbResponse,
    converted: CoverDisplayWorkerResult,
    taskGeneration: number,
    priority: QueuePriority
  ) => {
    if (!isCurrentGeneration(taskGeneration)) return
    void window.electron.ipcRenderer
      .invoke('persistSongCoverDisplayCache', {
        filePath,
        listRootDir: String(resolveRootDir() || '').trim(),
        imageHash: String(response.imageHash || '').trim(),
        legacyExt: response.legacyExt,
        format: converted.format,
        data: converted.data,
        requestContext: { clientKey, generation: taskGeneration, priority }
      })
      .catch(() => {})
  }

  const scheduleDisplayCache = (
    filePath: string,
    response: CoverThumbResponse,
    taskGeneration: number,
    priority: QueuePriority
  ) => {
    const raw = toUint8Array(response.data)
    const imageHash = String(response.imageHash || '').trim()
    const listRootDir = String(resolveRootDir() || '').trim()
    if (!response.needsDisplayCache || !raw?.length || !imageHash || !listRootDir) return

    const conversionKey = `${listRootDir}:${imageHash}`
    const converted = displayConversionCache.get(conversionKey)
    if (converted) {
      persistDisplayCache(filePath, response, converted, taskGeneration, priority)
      return
    }

    let conversionTask = displayConversionInflight.get(conversionKey)
    if (!conversionTask) {
      conversionTask = displayWorker
        .resize(raw, response.format || 'image/jpeg', 256)
        .then((result) => {
          displayConversionCache.set(conversionKey, result)
          persistDisplayCache(filePath, response, result, taskGeneration, priority)
          return result
        })
        .finally(() => displayConversionInflight.delete(conversionKey))
      displayConversionInflight.set(conversionKey, conversionTask)
      void conversionTask.catch(() => {})
      return
    }
    void conversionTask
      .then((result) => persistDisplayCache(filePath, response, result, taskGeneration, priority))
      .catch(() => {})
  }

  const prepareDisplayResponse = (
    filePath: string,
    response: CoverThumbResponse,
    taskGeneration: number,
    priority: QueuePriority
  ): CoverThumbResponse => {
    if (!response.needsDisplayCache) return response
    const raw = toUint8Array(response.data)
    const imageHash = String(response.imageHash || '').trim()
    const listRootDir = String(resolveRootDir() || '').trim()
    if (!raw?.length || !imageHash || !listRootDir) return response

    const conversionKey = `${listRootDir}:${imageHash}`
    const converted = displayConversionCache.get(conversionKey)
    if (!converted) {
      scheduleDisplayCache(filePath, response, taskGeneration, priority)
      return response
    }
    persistDisplayCache(filePath, response, converted, taskGeneration, priority)
    return {
      ...response,
      format: converted.format,
      data: converted.data,
      needsDisplayCache: false
    }
  }

  const cancelMainSession = (cancelledGeneration: number) => {
    if (cancelledGeneration <= 0) return
    try {
      window.electron.ipcRenderer.send('cancelSongCoverSession', {
        clientKey,
        generation: cancelledGeneration
      })
    } catch {}
  }

  const clearQueues = () => {
    for (const queue of [pendingVisibleQueue, pendingPrefetchQueue]) {
      for (const task of queue) task.resolve(null)
      queue.length = 0
    }
  }

  const resetSession = () => {
    const previousGeneration = generation
    generation += 1
    cancelMainSession(previousGeneration)
    clearQueues()
    for (const url of coverUrlCache.values()) revokeCoverUrl(url)
    coverUrlCache.clear()
    inflight.clear()
    displayConversionCache.clear()
    displayConversionInflight.clear()
    displayWorker.dispose()
    displayWorker = createCoverDisplayWorkerClient()
    coversTick.value++
  }

  function pump() {
    if (disposed) return
    const running = runningByGeneration.get(generation) || { visible: 0, prefetch: 0 }
    while (running.visible + running.prefetch < MAX_CONCURRENCY) {
      const task =
        pendingVisibleQueue.shift() ||
        (running.prefetch < MAX_PREFETCH_CONCURRENCY ? pendingPrefetchQueue.shift() : undefined)
      if (!task) break
      if (!isCurrentGeneration(task.generation)) {
        task.resolve(null)
        continue
      }
      running[task.priority] += 1
      runningByGeneration.set(task.generation, running)
      task.run()
    }
  }

  function onImgError(filePath: string) {
    if (disposed) return
    const cacheKey = resolveCoverCacheKey(filePath)
    const failedUrl = coverUrlCache.get(cacheKey)
    revokeCoverUrl(failedUrl)
    cacheCoverUrl(filePath, null, generation)
  }

  function getCoverUrl(filePath: string): string | null | undefined {
    return coverUrlCache.get(resolveCoverCacheKey(filePath))
  }

  function fetchCoverUrl(
    filePath: string,
    priority: QueuePriority = 'visible'
  ): Promise<string | null> {
    if (disposed || !isEnabled()) return Promise.resolve(null)
    if (!filePath) return Promise.resolve(null)
    const taskGeneration = generation
    const cacheKey = resolveCoverCacheKey(filePath)
    const cached = coverUrlCache.get(cacheKey)
    if (cached !== undefined) return Promise.resolve(cached)
    const existing = inflight.get(cacheKey)
    if (existing?.generation === taskGeneration) {
      if (priority === 'visible' && existing.task?.priority === 'prefetch') {
        const pendingIndex = pendingPrefetchQueue.indexOf(existing.task)
        if (pendingIndex >= 0) {
          pendingPrefetchQueue.splice(pendingIndex, 1)
          existing.task.priority = 'visible'
          pendingVisibleQueue.push(existing.task)
          pump()
        }
      }
      return existing.promise
    }

    let queuedTask: QueueTask | undefined
    const promise = new Promise<string | null>((resolve) => {
      const run = async () => {
        const runningPriority = queuedTask?.priority || priority
        try {
          if (!isCurrentGeneration(taskGeneration)) {
            resolve(null)
            return
          }
          const song = resolveSongByFilePath(filePath)
          const requestFilePath = String(song?.filePath || filePath).trim()
          const pioneerCoverPath = String(song?.pioneerCoverPath || '').trim()
          const sourceKind =
            song?.externalSourceKind === 'desktop' || song?.externalSourceKind === 'usb'
              ? song.externalSourceKind
              : 'usb'
          const rawResp: CoverThumbResponse | null = pioneerCoverPath
            ? ((await window.electron.ipcRenderer.invoke(
                getRekordboxCoverThumbChannel(sourceKind),
                pioneerCoverPath
              )) as CoverThumbResponse | null)
            : ((await window.electron.ipcRenderer.invoke(
                'getSongCoverThumb',
                requestFilePath,
                48,
                resolveRootDir(),
                { clientKey, generation: taskGeneration, priority: runningPriority }
              )) as CoverThumbResponse | null)

          if (!isCurrentGeneration(taskGeneration)) {
            resolve(null)
            return
          }
          const resp = rawResp
            ? prepareDisplayResponse(requestFilePath, rawResp, taskGeneration, runningPriority)
            : null
          if (!isCurrentGeneration(taskGeneration)) {
            resolve(null)
            return
          }
          if (resp?.dataUrl) {
            resolve(cacheCoverUrl(filePath, resp.dataUrl, taskGeneration) ? resp.dataUrl : null)
            return
          }
          if (resp?.data) {
            const raw = toUint8Array(resp.data)
            if (!raw?.length) {
              cacheCoverUrl(filePath, null, taskGeneration)
              resolve(null)
              return
            }
            const blobBytes = new Uint8Array(raw.byteLength)
            blobBytes.set(raw)
            const blob = new Blob([blobBytes.buffer], {
              type: resp.format || 'image/jpeg'
            })
            const url = URL.createObjectURL(blob)
            resolve(cacheCoverUrl(filePath, url, taskGeneration) ? url : null)
            return
          }
          cacheCoverUrl(filePath, null, taskGeneration)
          resolve(null)
        } catch {
          cacheCoverUrl(filePath, null, taskGeneration)
          resolve(null)
        } finally {
          const activeInflight = inflight.get(cacheKey)
          if (activeInflight?.generation === taskGeneration) inflight.delete(cacheKey)
          const running = runningByGeneration.get(taskGeneration)
          if (running) {
            running[runningPriority] = Math.max(0, running[runningPriority] - 1)
            if (running.visible + running.prefetch > 0) {
              runningByGeneration.set(taskGeneration, running)
            } else {
              runningByGeneration.delete(taskGeneration)
            }
          }
          pump()
        }
      }

      queuedTask = {
        filePath,
        generation: taskGeneration,
        priority,
        run,
        resolve
      }
      if (priority === 'visible') pendingVisibleQueue.push(queuedTask)
      else pendingPrefetchQueue.push(queuedTask)
      pump()
    })

    inflight.set(cacheKey, { generation: taskGeneration, promise, task: queuedTask })
    return promise
  }

  function clearPendingByPath(filePath?: string) {
    if (!filePath) return
    for (const queue of [pendingVisibleQueue, pendingPrefetchQueue]) {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const task = queue[i]
        if (resolveCoverCacheKey(task.filePath) === resolveCoverCacheKey(filePath)) {
          queue.splice(i, 1)
          task.resolve(null)
        }
      }
    }
  }

  function handleSongMetadataUpdated(payload: { filePath?: string; oldFilePath?: string }) {
    if (disposed) return
    const newPath = payload?.filePath
    if (payload?.oldFilePath) {
      const oldCacheKey = resolveCoverCacheKey(payload.oldFilePath)
      revokeCoverUrl(coverUrlCache.get(oldCacheKey))
      coverUrlCache.delete(oldCacheKey)
      inflight.delete(oldCacheKey)
      clearPendingByPath(payload.oldFilePath)
    }
    if (!newPath) return
    const newCacheKey = resolveCoverCacheKey(newPath)
    revokeCoverUrl(coverUrlCache.get(newCacheKey))
    coverUrlCache.delete(newCacheKey)
    inflight.delete(newCacheKey)
    clearPendingByPath(newPath)
    coversTick.value++
    void fetchCoverUrl(newPath)
  }

  function primePrefetchWindow() {
    if (disposed || !isEnabled()) return
    const arr = resolveSongs()
    const actualStart = Math.max(0, actualStartIndex.value)
    const actualEnd = Math.min(arr.length, actualEndIndex.value)
    for (let i = actualStart; i < actualEnd; i += 1) {
      const fp = arr[i]?.filePath
      if (fp && !coverUrlCache.has(resolveCoverCacheKey(fp))) void fetchCoverUrl(fp, 'visible')
    }
    const start = Math.max(0, startIndex.value - visibleCount.value)
    const end = Math.min(arr.length, endIndex.value + visibleCount.value)
    for (let i = start; i < end; i += 1) {
      if (i >= actualStart && i < actualEnd) continue
      const fp = arr[i]?.filePath
      if (fp && !coverUrlCache.has(resolveCoverCacheKey(fp))) void fetchCoverUrl(fp, 'prefetch')
    }
  }

  const stopSessionWatch = watch(
    () =>
      `${resolveSessionIdentity()}|${isEnabled() ? 'enabled' : 'disabled'}|${platform?.value || ''}`,
    () => {
      resetSession()
      if (isEnabled()) primePrefetchWindow()
    },
    { immediate: true }
  )

  const stopVisibleWatch = watch(
    () =>
      visibleSongsWithIndex.value
        .map((item: { song: ISongInfo; idx: number }) => item.song?.filePath || '')
        .join('|'),
    () => {
      primePrefetchWindow()
    },
    { immediate: true }
  )

  const stopRangeWatch = watch(
    () =>
      [
        startIndex.value,
        endIndex.value,
        actualStartIndex.value,
        actualEndIndex.value,
        resolveSongs().length
      ] as const,
    () => primePrefetchWindow(),
    { deep: false }
  )

  onMounted(() => {
    if (isEnabled()) primePrefetchWindow()
    emitter.on('songMetadataUpdated', handleSongMetadataUpdated)
  })

  onUnmounted(() => {
    cancelMainSession(generation)
    disposed = true
    emitter.off('songMetadataUpdated', handleSongMetadataUpdated)
    stopVisibleWatch()
    stopRangeWatch()
    stopSessionWatch()
    for (const url of coverUrlCache.values()) revokeCoverUrl(url)
    clearQueues()
    coverUrlCache.clear()
    inflight.clear()
    displayConversionCache.clear()
    displayConversionInflight.clear()
    displayWorker.dispose()
    runningByGeneration.clear()
  })

  return {
    coversTick,
    getCoverUrl,
    fetchCoverUrl,
    onImgError
  }
}
