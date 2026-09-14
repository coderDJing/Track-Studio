import { parentPort } from 'node:worker_threads'
import store from '../store'
import { scanSongList } from '../services/scanSongs'

type WorkerRequest = {
  requestId?: number
  mode?: 'scan' | 'verify'
  deferCacheWrite?: boolean
  scanPath: string | string[]
  audioExt: string[]
  songListUUID: string
  databaseDir: string
}

parentPort?.on('message', async (payload: WorkerRequest) => {
  const requestId = Number(payload?.requestId)
  try {
    store.databaseDir = String(payload?.databaseDir || '').trim()
    const verifiedOnly = payload?.mode === 'verify'
    const deferredCacheWrite = { task: null as (() => Promise<void>) | null }
    const result = await scanSongList(
      payload?.scanPath || '',
      Array.isArray(payload?.audioExt) ? payload.audioExt : [],
      String(payload?.songListUUID || '').trim(),
      {
        enablePostScanTasks: false,
        verifiedOnly,
        enqueueDeferredSongCacheWrite: payload?.deferCacheWrite
          ? (write) => {
              deferredCacheWrite.task = write
            }
          : undefined
      }
    )
    const pendingCacheWrite = deferredCacheWrite.task
    parentPort?.postMessage({
      type: 'scan-result',
      requestId,
      result,
      cacheWritePending: pendingCacheWrite !== null
    })
    if (pendingCacheWrite) {
      await pendingCacheWrite()
      parentPort?.postMessage({ type: 'cache-write-complete', requestId })
    }
  } catch (error) {
    parentPort?.postMessage({
      type: 'scan-result',
      requestId,
      error: error instanceof Error ? error.message : String(error || 'scanSongList worker failed')
    })
  }
})
