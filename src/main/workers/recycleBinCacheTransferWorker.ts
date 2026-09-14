import { parentPort } from 'node:worker_threads'
import store from '../store'
import {
  transferTrackDerivedCaches,
  type TrackCacheTransferContext,
  type TrackCacheTransferParams
} from '../services/trackCacheTransfer'

type TransferEntry = {
  id: number
  params: TrackCacheTransferParams
  context: TrackCacheTransferContext
}

type WorkerRequest = {
  id: number
  databaseDir: string
  entries: TransferEntry[]
}

parentPort?.on('message', async (payload: WorkerRequest) => {
  const results: Array<{ id: number; success: boolean; error?: string }> = []
  try {
    store.databaseDir = payload.databaseDir
    for (const entry of payload.entries) {
      try {
        await transferTrackDerivedCaches(entry.params, entry.context)
        results.push({ id: entry.id, success: true })
      } catch (error) {
        results.push({
          id: entry.id,
          success: false,
          error: error instanceof Error ? error.message : String(error || 'cache transfer failed')
        })
      }
    }
    parentPort?.postMessage({ id: payload.id, results })
  } catch (error) {
    parentPort?.postMessage({
      id: payload.id,
      error:
        error instanceof Error ? error.message : String(error || 'cache transfer worker failed')
    })
  }
})
