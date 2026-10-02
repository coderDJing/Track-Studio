import { markRaw } from 'vue'
import type { SongListWaveformWorkerIncoming } from '@renderer/workers/songListWaveformPreview.types'

type CanvasRegistryParams = {
  canUseAsyncWaveformWorker: boolean
  ensureWaveformWorker: () => Worker | null
}

export const createWaveformPreviewCanvasRegistry = (params: CanvasRegistryParams) => {
  const canvasMap = markRaw(new Map<string, HTMLCanvasElement>())
  const workerCanvasMap = markRaw(new Map<string, HTMLCanvasElement>())
  const canvasFilePathMap = markRaw(new Map<string, string>())
  // 暂存到延迟解绑结束，同轮 null / 原元素重绑不应把已有位图当成新画布。
  const canvasBindings = new Map<string, { canvas: HTMLCanvasElement; filePath: string }>()
  const filePathCanvasIdsMap = markRaw(new Map<string, Set<string>>())
  const pendingCanvasDetachTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const addCanvasIdForFilePath = (filePath: string, canvasId: string) => {
    if (!filePath || !canvasId) return
    let canvasIds = filePathCanvasIdsMap.get(filePath)
    if (!canvasIds) {
      canvasIds = new Set<string>()
      filePathCanvasIdsMap.set(filePath, canvasIds)
    }
    canvasIds.add(canvasId)
  }

  const removeCanvasIdForFilePath = (filePath: string, canvasId: string) => {
    const canvasIds = filePathCanvasIdsMap.get(filePath)
    if (!canvasIds) return
    canvasIds.delete(canvasId)
    if (canvasIds.size === 0) {
      filePathCanvasIdsMap.delete(filePath)
    }
  }

  const getCanvasEntriesForFilePath = (filePath: string): Array<[string, HTMLCanvasElement]> => {
    const canvasIds = filePathCanvasIdsMap.get(filePath)
    if (!canvasIds) return []
    return Array.from(canvasIds)
      .map((canvasId): [string, HTMLCanvasElement | undefined] => [
        canvasId,
        canvasMap.get(canvasId)
      ])
      .filter((entry): entry is [string, HTMLCanvasElement] => Boolean(entry[1]))
  }

  const hasCanvasForFilePath = (filePath: string) =>
    getCanvasEntriesForFilePath(filePath).length > 0
  const getRegisteredFilePaths = () => Array.from(filePathCanvasIdsMap.keys())

  const cancelPendingCanvasDetach = (canvasId: string) => {
    const timer = pendingCanvasDetachTimers.get(canvasId)
    if (!timer) return
    clearTimeout(timer)
    pendingCanvasDetachTimers.delete(canvasId)
  }

  const detachWorkerCanvas = (canvasId: string) => {
    if (!canvasId || !workerCanvasMap.get(canvasId)) return
    params.ensureWaveformWorker()?.postMessage({
      type: 'detachCanvas',
      payload: { canvasId }
    } satisfies SongListWaveformWorkerIncoming)
    workerCanvasMap.delete(canvasId)
  }

  const scheduleWorkerCanvasDetach = (canvasId: string) => {
    if (!canvasId || pendingCanvasDetachTimers.has(canvasId)) return
    const timer = setTimeout(() => {
      pendingCanvasDetachTimers.delete(canvasId)
      if (canvasMap.has(canvasId)) return
      canvasBindings.delete(canvasId)
      detachWorkerCanvas(canvasId)
    }, 0)
    pendingCanvasDetachTimers.set(canvasId, timer)
  }

  const setCanvasRef = (canvasId: string, filePath: string, el: HTMLCanvasElement | null) => {
    const normalizedCanvasId = String(canvasId || filePath || '').trim()
    if (!normalizedCanvasId || !filePath) {
      return { attachedToWorker: false, bindingChanged: false }
    }

    if (el) {
      cancelPendingCanvasDetach(normalizedCanvasId)
      const previousBinding = canvasBindings.get(normalizedCanvasId)
      const bindingChanged =
        !previousBinding || previousBinding.canvas !== el || previousBinding.filePath !== filePath
      canvasBindings.set(normalizedCanvasId, { canvas: el, filePath })
      const previousFilePath = canvasFilePathMap.get(normalizedCanvasId)
      if (previousFilePath && previousFilePath !== filePath) {
        removeCanvasIdForFilePath(previousFilePath, normalizedCanvasId)
      }
      canvasFilePathMap.set(normalizedCanvasId, filePath)
      addCanvasIdForFilePath(filePath, normalizedCanvasId)
      canvasMap.set(normalizedCanvasId, el)

      if (!params.canUseAsyncWaveformWorker) return { attachedToWorker: false, bindingChanged }
      const currentBoundCanvas = workerCanvasMap.get(normalizedCanvasId)
      if (currentBoundCanvas === el) return { attachedToWorker: false, bindingChanged }
      if (currentBoundCanvas) {
        detachWorkerCanvas(normalizedCanvasId)
      }
      const offscreen = el.transferControlToOffscreen()
      params.ensureWaveformWorker()?.postMessage(
        {
          type: 'attachCanvas',
          payload: {
            canvasId: normalizedCanvasId,
            canvas: offscreen
          }
        } satisfies SongListWaveformWorkerIncoming,
        [offscreen]
      )
      workerCanvasMap.set(normalizedCanvasId, el)
      return { attachedToWorker: true, bindingChanged }
    }

    const previousFilePath = canvasFilePathMap.get(normalizedCanvasId) || filePath
    canvasMap.delete(normalizedCanvasId)
    canvasFilePathMap.delete(normalizedCanvasId)
    removeCanvasIdForFilePath(previousFilePath, normalizedCanvasId)
    scheduleWorkerCanvasDetach(normalizedCanvasId)
    return { attachedToWorker: false, bindingChanged: false }
  }

  const clearWorkerCanvasesForFilePath = (filePath: string) => {
    if (!params.canUseAsyncWaveformWorker) return
    for (const [canvasId] of getCanvasEntriesForFilePath(filePath)) {
      params.ensureWaveformWorker()?.postMessage({
        type: 'clearCanvas',
        payload: { canvasId }
      } satisfies SongListWaveformWorkerIncoming)
    }
  }

  const clearWorkerCanvases = () => {
    if (!params.canUseAsyncWaveformWorker) return
    for (const canvasId of workerCanvasMap.keys()) {
      params.ensureWaveformWorker()?.postMessage({
        type: 'clearCanvas',
        payload: { canvasId }
      } satisfies SongListWaveformWorkerIncoming)
    }
  }

  const clear = () => {
    for (const timer of pendingCanvasDetachTimers.values()) {
      clearTimeout(timer)
    }
    pendingCanvasDetachTimers.clear()
    canvasMap.clear()
    workerCanvasMap.clear()
    canvasFilePathMap.clear()
    canvasBindings.clear()
    filePathCanvasIdsMap.clear()
  }

  return {
    clear,
    clearWorkerCanvases,
    clearWorkerCanvasesForFilePath,
    getCanvasEntriesForFilePath,
    getRegisteredFilePaths,
    hasCanvasForFilePath,
    setCanvasRef
  }
}
